import { app, nativeTheme, type WebContents } from 'electron';
import { originOf } from '@shared/origin.js';
// Type-only: the policy loop needs to know what a TabManager is, and nothing
// else about it. An erased import keeps `privacy/` free of a runtime edge back
// into `main/` — `main/tabs.ts` already imports `privacy/containers`.
import type { TabManager } from '@main/tabs.js';

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
/**
 * Tabs currently carrying the contrast-repair filter.
 *
 * Tracked so the style is removed when the decision changes — a per-site `off`
 * or a switch to theme `light` must restore authored rendering, and
 * `setTabDark(false)` alone only lifts the CDP override, not an injected
 * `<style>`. Weak, so a closed tab drops out with its WebContents.
 */
const repaired = new WeakSet<WebContents>();
/** Set once by `installDarkModePolicy`; the sweep's only view of open tabs. */
let policyTabs: TabManager | null = null;

/**
 * Filter-inversion tuning. `contrast` is 110, not 100, and the value is
 * MEASURED rather than chosen (2026-08-06).
 *
 * WHAT IT REPAIRS. Uniform inversion is not contrast-preserving, and the loss
 * is worst in the mid-greys: at the `#909090`/`#333333` rung the inverted pair
 * comes out at 0.79× the authored ratio where §6.1's bound assumes 0.8× — a
 * shortfall of one part in eighty, checked one rung up (`#a0a0a0`) but not at
 * this one. `bench/darkmode.mjs` R1 measured 3.13 against a REQ of 3.17. That
 * is a real deficiency of the mechanism, not a bound that was set too high, so
 * it is repaired in the mechanism.
 *
 * WHY 110 AND NOT LESS. Raising contrast pushes the mid-grey BACKGROUND rungs
 * apart and pulls the near-white FOREGROUND rungs together, so the two move in
 * opposite directions and the honest value is where they balance. Measured
 * across all 37 R1/R2 rows, margin = painted − REQ on the two binding rows:
 *
 *     contrast   bg-909090/333 (REQ 3.17)   fg-aaa/fff (REQ 2.32)   bench
 *        100          3.13  (−0.04)              2.82  (+0.50)       RED
 *        102          3.16  (−0.01)              2.77  (+0.45)       RED
 *        105          3.31  (+0.14)              2.73  (+0.41)      GREEN
 *        110          3.49  (+0.32)              2.65  (+0.33)      GREEN
 *
 * 110 is the max-min point: it maximizes the WORST margin over every row
 * (+0.32, versus +0.14 at 105), and past it `fg-aaa` becomes the binding
 * constraint instead. Only three rows move down at all (`fg-888` −0.07,
 * `fg-999` −0.16, `fg-aaa` −0.17) and all stay clear of their bounds; no row
 * anywhere falls below one.
 *
 * IT TOUCHES ONLY PAGES THAT ARE ACTUALLY FILTERED. All seven dark-native
 * (R2) rows measured byte-identical at every value above — the auto-skip means
 * no filter is injected there — and R3/R4/R5 are equality legs for the same
 * reason. This knob cannot reach a page Aperture decided not to darken.
 */
export const tuning = { brightness: 100, contrast: 110 };

/**
 * Called before app-ready: force-dark is a Blink setting.
 *
 * ONE KEY, because one key is all that does anything. This used to pass four
 * more — `forceDarkModeInversionAlgorithm`, `forceDarkModeImagePolicy`,
 * `forceDarkModeTextLightnessThreshold`, `forceDarkModeBackgroundLightness-
 * Threshold` — and every one of them is DEAD CONFIG on Electron 43.2.0.
 * Measured on 2026-08-06 across four channels, byte-identical painted output
 * each time: the spellings as shipped; current Chromium's
 * `…ForegroundBrightnessThreshold`/`…BackgroundBrightnessThreshold`;
 * `--enable-features=WebContentsForceDark:background_lightness_threshold/150`
 * as feature params and as the sole enabler with this switch stripped; and
 * `--dark-mode-settings=BackgroundBrightnessThreshold=150`
 * (docs/design/darkmode-contrast.md §3-F1).
 *
 * The comment that used to sit above them — "Selective inversion: preserves
 * images and skips already-dark elements" — described Chromium's BUILT-IN
 * DEFAULTS, not anything those keys accomplished. The selective classifier is
 * take-it-or-leave-it, thresholds included, and its seam (text flipped light
 * below brightness 150, background darkened only above 205) is the reported
 * defect. `applyToTab` is where that gets handled, per page.
 *
 * The global switch is kept rather than moving to a pure per-tab CDP enable —
 * which was measured to work standalone — deliberately: it gives a default-dark
 * posture with no white flash on every navigation. The CDP override in
 * `setTabDark` remains the per-tab veto.
 */
export function enableForceDark(): void {
  app.commandLine.appendSwitch('blink-settings', 'forceDarkModeEnabled=true');
}

export function applyDarkMode(next: ThemeMode = mode): void {
  mode = next;
  nativeTheme.themeSource = next;
  // AND SWEEP. Setting `themeSource` changes what `prefers-color-scheme`
  // reports to pages that ask, and nothing else: a tab already darkened by the
  // force-dark switch stays darkened, which is why `browser_theme{mode:'light'}`
  // used to report "not darkened (theme is light)" over a page that was still
  // painting dark (§3-F3). Every open tab re-runs the decision here.
  sweepOpenTabs();
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

/** Does the current theme resolve to dark right now? */
function themeResolvesDark(): boolean {
  if (mode === 'light') return false;
  if (mode === 'dark') return true;
  return nativeTheme.shouldUseDarkColors;
}

/**
 * The decision, without touching the tab. Measures; does not act.
 *
 * `knownDark` is deliberately NOT consulted here, and that is the fix to F4's
 * ratchet. The cache exists to stop a revisit flashing inverted, which is the
 * PRESEED's job (`preseedDecision`, applied synchronously at commit). Letting it
 * short-circuit the measurement as well made it a one-way latch: one dark page
 * on an origin classified the whole origin dark for the session, and a later
 * light page on the same origin was never darkened and never corrected the
 * cache. Measuring every time and writing the answer back in both directions
 * costs one `executeJavaScript` per navigation and closes it.
 */
async function decide(
  wc: WebContents,
  origin: string,
): Promise<{ darkened: boolean; reason: string }> {
  if (mode === 'light') return { darkened: false, reason: 'theme is light' };
  if (!themeResolvesDark()) return { darkened: false, reason: 'system theme is light' };

  const policy = getSitePolicy(origin);
  if (policy === 'off') return { darkened: false, reason: 'site set to off' };

  if (policy === 'auto') {
    // Measuring beats guessing: a site that already ships a dark theme looks
    // worse inverted, and the flash of wrongly-inverted content on every visit
    // is the single most annoying failure mode of every dark-mode extension.
    if (await pageIsAlreadyDark(wc)) {
      knownDark.add(origin);
      return { darkened: false, reason: 'site already ships a dark theme' };
    }
    knownDark.delete(origin);
  }

  return { darkened: true, reason: policy === 'on' ? 'site set to on' : 'auto' };
}

/**
 * Decide whether this page should be darkened, and do it.
 *
 * Called after each navigation — for real, now. Until 2026-08-06 this function
 * had exactly ONE call site, the `browser_theme` MCP tool, and no navigation
 * event reached it: the per-site policy, the already-dark auto-skip and the
 * `knownDark` cache were correct, shipped, and had never executed for a human
 * browsing (§3-F2). `installDarkModePolicy` is what runs it now.
 *
 * EVERY PATH ENDS DECISIVE. The old `mode === 'light'` arm returned without
 * touching the tab, so the tool reported "not darkened (theme is light)" while
 * the page went on painting force-darkened — a false statement in shipped code
 * (§3-F3). Every return below is now preceded by exactly one `setTabDark`.
 */
export async function applyToTab(
  wc: WebContents,
  origin: string,
): Promise<{ darkened: boolean; reason: string }> {
  const d = await decide(wc, origin);

  if (!d.darkened) {
    await setTabDark(wc, false);
    await clearRepair(wc);
    return d;
  }

  await setTabDark(wc, true);

  // THE SEAM, AND THE ONLY MECHANISM THAT DOES NOT HAVE IT.
  //
  // Blink classifies text and backgrounds independently — text flipped light
  // below brightness 150, background darkened only above 205 — so a background
  // in the mid band keeps its light fill under now-light text. Measured
  // 1.21:1 to 2.40:1 on ordinary furniture: `#cccccc` badges, silver table
  // headers, a `#6aa9ff` button with a dark label. The thresholds are not
  // tunable (§3-F1), so where the seam provably bites, this page is darkened by
  // uniform filter inversion instead, which has no per-element classifier and
  // therefore no seam.
  if (await pageHasContrastSeam(wc)) {
    await setTabDark(wc, false);
    await applyFilterFallback(wc, true);
    repaired.add(wc);
    return { darkened: true, reason: `${d.reason} — filter-inversion (contrast repair)` };
  }

  await clearRepair(wc);
  return d;
}

/**
 * The posture to apply the INSTANT a document commits, before anything can be
 * measured. Cheap, synchronous, and wrong only on a first-ever visit.
 *
 * Dark is the default, because dark is the theme. `knownDark` earns its keep
 * here and nowhere else: a revisit to a site that ships its own dark theme is
 * preseeded un-darkened, so it does not flash inverted for the
 * commit→dom-ready interval.
 */
function preseedDecision(origin: string): boolean {
  if (!themeResolvesDark()) return false;
  const policy = getSitePolicy(origin);
  if (policy === 'off') return false;
  if (policy === 'on') return true;
  return !knownDark.has(origin);
}

/** Per-document state for the late passes. Keyed weakly by WebContents. */
interface NavPass {
  origin: string;
  /** Has the dom-ready decision run for the document currently committed? */
  decided: boolean;
  /** Did that decision end in "darken"? */
  darkened: boolean;
  /** Serialises the passes so two events cannot interleave on one tab. */
  running: Promise<unknown>;
}
const navPass = new WeakMap<WebContents, NavPass>();
/** WebContents whose lifetime listeners are already attached. */
const wiredTabs = new WeakSet<WebContents>();

/**
 * Run the shipped dark-mode policy on every navigation.
 *
 * THE MISSING WIRE. `applyToTab` documented itself as "called after each
 * navigation" and was called after none: its only caller was the `browser_theme`
 * MCP tool, so the auto-skip that protects dark-native sites, the per-site
 * policy and the `knownDark` cache never ran for a human browsing (§3-F2). What
 * darkened pages in ordinary use was the unconditional process-wide blink
 * switch, alone, with no policy in front of it.
 *
 * Two passes per navigation, and the split is load-bearing:
 *
 *   - **Preseed, synchronously at `document-navigated`.** No measurement, no
 *     await before the posture lands.
 *   - **Decide, at `dom-ready`.** `pageIsAlreadyDark` reads the painted-ish
 *     truth from computed styles, and at commit the document is still blank —
 *     measuring there classifies EVERY dark site as light, and that
 *     mis-decision would then persist in `knownDark`. So: preseed early,
 *     measure late.
 *
 * A first-ever visit to a `color-scheme`-less dark site can therefore flash
 * inverted for the commit→dom-ready interval, once per origin per session. That
 * is an accepted residual, recorded here and in §5-Fix 2: the preseed removes it
 * on every revisit, and sites that declare `color-scheme: dark` never flash at
 * all because Blink skips them natively.
 *
 * The tool surface does not change. This adds no parameter, no capability, and
 * nothing the agent can reach — it makes an existing decision actually run.
 */
export function installDarkModePolicy(tabs: TabManager): void {
  policyTabs = tabs;

  tabs.on('document-navigated', (tabId: string) => {
    let wc: WebContents;
    try {
      wc = tabs.webContents(tabId);
    } catch {
      return; // the tab went away between the event and this line
    }
    if (wc.isDestroyed()) return;

    const origin = originOf(wc.getURL());
    // No meaningful origin (about:blank, a data: document) has no site policy
    // and nothing to cache. The global switch's default-dark posture stands.
    if (!origin) return;

    // The new document cannot be carrying the old one's injected style.
    repaired.delete(wc);
    navPass.set(wc, { origin, decided: false, darkened: false, running: Promise.resolve() });

    void setTabDark(wc, preseedDecision(origin));

    if (!wiredTabs.has(wc)) {
      wiredTabs.add(wc);
      // Attached once per WebContents rather than once per navigation: a
      // listener added on every commit would accumulate for the life of the tab.
      wc.on('dom-ready', () => latePass(wc, 'dom-ready'));
      wc.on('did-stop-loading', () => latePass(wc, 'did-stop-loading'));
    }
  });
}

/**
 * The late passes.
 *
 * `dom-ready` runs the whole decision. `did-stop-loading` re-runs only the band
 * scan, and only if the repair has not already triggered — a late-hydrating SPA
 * can paint its first seam after dom-ready. Two bounded passes and no
 * MutationObserver: content mutated in after both is an accepted residual
 * (§5-Fix 3), and a bounded cost is worth more here than perfect coverage.
 */
function latePass(wc: WebContents, when: 'dom-ready' | 'did-stop-loading'): void {
  const st = navPass.get(wc);
  if (!st || wc.isDestroyed()) return;

  st.running = st.running.then(async () => {
    if (wc.isDestroyed()) return;
    if (when === 'dom-ready' || !st.decided) {
      const r = await applyToTab(wc, st.origin);
      st.decided = true;
      st.darkened = r.darkened;
      return;
    }
    // did-stop-loading, and the page was already decided.
    if (!st.darkened || repaired.has(wc)) return;
    if (await pageHasContrastSeam(wc)) {
      await setTabDark(wc, false);
      await applyFilterFallback(wc, true);
      repaired.add(wc);
    }
  }).catch(() => {
    // A tab that navigated or closed mid-pass is not an error worth surfacing;
    // the next navigation runs the whole thing again.
  });
}

/**
 * Re-run the decision on every open tab.
 *
 * What makes `browser_theme{mode:'light'}` mean something for tabs that are
 * already open, rather than only for the next navigation.
 */
function sweepOpenTabs(): void {
  const tabs = policyTabs;
  if (!tabs) return;
  for (const info of tabs.list()) {
    let wc: WebContents;
    try {
      wc = tabs.webContents(info.id);
    } catch {
      continue;
    }
    if (wc.isDestroyed()) continue;
    const origin = originOf(wc.getURL());
    if (!origin) continue;
    void applyToTab(wc, origin).catch(() => {});
  }
}

/** Take the contrast-repair filter back off, if this tab is carrying one. */
async function clearRepair(wc: WebContents): Promise<void> {
  // When the CDP override is unavailable, `setTabDark` IS the filter, and
  // clearing here would undo the decision that was just made.
  if (cdpOverrideWorks === false) return;
  if (!repaired.has(wc)) return;
  repaired.delete(wc);
  await applyFilterFallback(wc, false);
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

/**
 * Does this page provably contain the force-dark seam?
 *
 * The predicate is the measured hole, not a theory of it: Blink flips text
 * light below brightness 150 and darkens a background only above 205, so an
 * element whose text is under 150 and whose background sits in [98, 205) comes
 * out light-on-light. 98 is where the flip mapping (`#333` → `#dfdfdf`) crosses
 * under 4.5:1 and 205 is the measured background boundary — `#d0d0d0` (208)
 * flipped, `#cccccc` (204) did not.
 *
 * Read from COMPUTED styles, which is correct here and only here: force-dark
 * rewrites at paint time and leaves computed values alone, so these are the
 * authored colours — exactly the inputs the classifier is about to be handed.
 *
 * Bounded on purpose: 4000 elements, early exit on the first match. Triggering
 * at one match is deliberate. Under-triggering leaves unreadable text, which is
 * the whole reported defect; over-triggering costs aesthetics.
 */
async function pageHasContrastSeam(wc: WebContents): Promise<boolean> {
  try {
    return (await wc.executeJavaScript(
      `(() => {
        const parse = (c) => {
          const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(c || '');
          if (!m) return null;
          const a = m[4] === undefined ? 1 : parseFloat(m[4]);
          return { rgb: [+m[1], +m[2], +m[3]], a };
        };
        // Rec. 601 luma, which is the family the classifier works in.
        const luma = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
        const bgOf = (el) => {
          let n = el;
          while (n) {
            const p = parse(getComputedStyle(n).backgroundColor);
            if (p && p.a >= 0.5) return p.rgb;
            n = n.parentElement;
          }
          // Nothing paints a background: the canvas is the browser default,
          // which is white in a light context.
          return [255, 255, 255];
        };

        const els = document.querySelectorAll('*');
        const cap = Math.min(els.length, 4000);
        for (let i = 0; i < cap; i++) {
          const el = els[i];
          let hasText = false;
          for (const n of el.childNodes) {
            if (n.nodeType === 3 && n.textContent.trim()) { hasText = true; break; }
          }
          if (!hasText) continue;
          const r = el.getBoundingClientRect();
          if (r.width * r.height < 24) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const fg = parse(cs.color);
          if (!fg) continue;
          const bl = luma(bgOf(el));
          if (luma(fg.rgb) < 150 && bl >= 98 && bl < 205) return true;
        }
        return false;
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
