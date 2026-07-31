import { app, nativeTheme, type WebContents } from 'electron';

/**
 * Dark mode.
 *
 * Three layers, in order of preference, because no single one covers every case:
 *
 *   1. **Tell the site the truth.** `nativeTheme.themeSource` drives what
 *      `prefers-color-scheme` reports. A site shipping its own dark theme will
 *      use it, and that always beats anything we could synthesize.
 *
 *   2. **Chromium force-dark** for sites with no dark theme. It works on the
 *      rendered layout tree — inverting backgrounds and text while leaving
 *      images, video and already-dark regions alone — and runs in the
 *      compositor, so it costs nothing per frame. An extension cannot reach
 *      this; owning the browser is the only way to get it.
 *
 *   3. **Filter inversion** as the per-site fallback and for the brightness and
 *      contrast controls, which force-dark does not expose at runtime.
 *
 * The approach in layer 3 is adapted from Nightfall
 * (github.com/cunninghambe/nightfall) — specifically its counter-inversion set
 * with the nesting guard, which is what stops a photo inside an already-
 * counter-inverted container coming out net-inverted. That detail is easy to
 * get wrong and very visible when you do.
 *
 * The control model — Auto / On / Off per site, with already-dark sites skipped
 * — is Nightfall's too. It is the part that actually matters day to day, and
 * force-dark on its own cannot express it.
 */

export type ThemeMode = 'system' | 'light' | 'dark';
/** Per-site decision. `auto` means "darken unless the site is already dark". */
export type SitePolicy = 'auto' | 'on' | 'off';

let mode: ThemeMode = 'system';
const sitePolicy = new Map<string, SitePolicy>();
/** Origins measured as already shipping a dark theme. Cached to avoid a flash
 *  of inverted content on a return visit. */
const knownDark = new Set<string>();
/** Whether CDP's per-tab override is actually available on this build. */
let cdpOverrideWorks: boolean | null = null;

export const tuning = { brightness: 100, contrast: 100 };

/** Called before app-ready: force-dark is a Blink setting. */
export function enableForceDark(): void {
  app.commandLine.appendSwitch(
    'blink-settings',
    [
      'forceDarkModeEnabled=true',
      // Selective inversion: preserves images and skips already-dark elements.
      'forceDarkModeInversionAlgorithm=4',
      'forceDarkModeImagePolicy=2',
      'forceDarkModeTextLightnessThreshold=150',
      'forceDarkModeBackgroundLightnessThreshold=205',
    ].join(','),
  );
}

export function applyDarkMode(next: ThemeMode = mode): void {
  mode = next;
  nativeTheme.themeSource = next;
}

export function currentMode(): ThemeMode {
  return mode;
}

export function isDark(): boolean {
  return nativeTheme.shouldUseDarkColors;
}

export function setSitePolicy(origin: string, policy: SitePolicy): void {
  sitePolicy.set(origin, policy);
}

export function getSitePolicy(origin: string): SitePolicy {
  return sitePolicy.get(origin) ?? 'auto';
}

/**
 * Decide whether this page should be darkened, and do it.
 *
 * Called after each navigation. Returns what it decided so the UI can show it.
 */
export async function applyToTab(
  wc: WebContents,
  origin: string,
): Promise<{ darkened: boolean; reason: string }> {
  if (mode === 'light') return { darkened: false, reason: 'theme is light' };

  const policy = getSitePolicy(origin);
  if (policy === 'off') {
    await setTabDark(wc, false);
    return { darkened: false, reason: 'site set to off' };
  }

  if (policy === 'auto') {
    // Measuring beats guessing: a site that already ships a dark theme looks
    // worse inverted, and the flash of wrongly-inverted content on every visit
    // is the single most annoying failure mode of every dark-mode extension.
    if (knownDark.has(origin) || (await pageIsAlreadyDark(wc))) {
      knownDark.add(origin);
      await setTabDark(wc, false);
      return { darkened: false, reason: 'site already ships a dark theme' };
    }
  }

  await setTabDark(wc, true);
  return { darkened: true, reason: policy === 'on' ? 'site set to on' : 'auto' };
}

/**
 * Per-tab force-dark toggle.
 *
 * Tries CDP `Emulation.setAutoDarkModeOverride` first, which is per-target and
 * therefore the clean answer. Falls back to filter inversion if this build does
 * not support it — determined once, empirically, rather than assumed.
 */
async function setTabDark(wc: WebContents, dark: boolean): Promise<void> {
  if (cdpOverrideWorks !== false) {
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setAutoDarkModeOverride', {
        enabled: dark,
      });
      cdpOverrideWorks = true;
      return;
    } catch {
      cdpOverrideWorks = false;
    }
  }
  await applyFilterFallback(wc, dark);
}

/** Measure the page's background luminance. */
async function pageIsAlreadyDark(wc: WebContents): Promise<boolean> {
  try {
    return (await wc.executeJavaScript(
      `(() => {
        // A transparent background parses as rgba(0,0,0,0), and reading that
        // as "black" makes every plain page look like a dark theme. Walk out
        // to the first element that actually paints something.
        const opaque = (el) => {
          if (!el) return null;
          const c = getComputedStyle(el).backgroundColor || '';
          const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(c);
          if (!m) return null;
          const a = m[4] === undefined ? 1 : parseFloat(m[4]);
          if (a < 0.5) return null;
          return [+m[1], +m[2], +m[3]];
        };

        const rgb =
          opaque(document.documentElement) ??
          opaque(document.body) ??
          // Nothing paints a background: the canvas is the browser default,
          // which is white in a light context.
          [255, 255, 255];

        // Rec. 709 luma. Below ~40% is a deliberately dark theme.
        return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.4;
      })()`,
      true,
    )) as boolean;
  } catch {
    return false;
  }
}

const STYLE_ID = 'aperture-dark';
const MEDIA =
  'img, video, canvas, embed, object, [style*="background-image"]';

/**
 * Filter-inversion fallback.
 *
 * The nesting guard in the counter-inversion rule is the load-bearing part: a
 * media element inside another matched media element must NOT be
 * counter-inverted twice, or it ends up net-inverted. `picture` and `svg` are
 * deliberately excluded — `picture` would double-filter its child `img`, and
 * svg is usually UI iconography that should invert along with the page.
 *
 * The filter goes on `<html>`, never `<body>`: a filter on body breaks
 * `position: fixed` for every descendant.
 */
async function applyFilterFallback(wc: WebContents, dark: boolean): Promise<void> {
  const css = dark
    ? `html {
         filter: invert(1) hue-rotate(180deg)
                 brightness(${tuning.brightness}%) contrast(${tuning.contrast}%) !important;
         background-color: #fff !important;
       }
       html :is(${MEDIA}):not(html :is(${MEDIA}) *) {
         filter: invert(1) hue-rotate(180deg) !important;
       }`
    : '';

  try {
    await wc.executeJavaScript(
      `(() => {
        let s = document.getElementById(${JSON.stringify(STYLE_ID)});
        const css = ${JSON.stringify(css)};
        if (!css) { s && s.remove(); return; }
        if (!s) {
          s = document.createElement('style');
          s.id = ${JSON.stringify(STYLE_ID)};
          (document.head || document.documentElement).appendChild(s);
        }
        s.textContent = css;
      })()`,
      true,
    );
  } catch {
    // A page that navigated mid-call is not an error worth surfacing.
  }
}

/** Which mechanism ended up in use, for the UI and for honest reporting. */
export function mechanism(): 'chromium-force-dark' | 'filter-inversion' | 'undetermined' {
  if (cdpOverrideWorks === true) return 'chromium-force-dark';
  if (cdpOverrideWorks === false) return 'filter-inversion';
  return 'undetermined';
}
