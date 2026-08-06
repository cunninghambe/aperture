# Dark-mode contrast: diagnosis and fix spec

**Report, verbatim:** "Dark mode - some text is unreadable."

**Verdict, up front.** The unreadable text is on **web pages, not in Aperture's
own UI**. Chromium's force-dark classifier — which Aperture enables
process-wide and unconditionally — has a measured hole: any background whose
brightness falls in a mid band (~98–205, i.e. `#909090`-to-`#cccccc` grays
*and* chromatic equivalents like a `#6aa9ff` button) is left **light**, while
the dark text sitting on it is flipped **light** as well. Painted contrast on
those surfaces measures **1.21:1 to 2.40:1** against a 4.5:1 requirement —
unreadable, exactly as reported. Three further defects compound it: the
per-site policy engine (`applyToTab`) is **not wired to navigation at all**, so
the shipped auto-skip logic that would protect dark-native sites never runs;
theme `light` **does not stop page darkening**; and the classifier thresholds
Aperture passes to Blink are **dead config** — measured no-ops on Electron
43.2.0. Aperture's own chrome and vault windows pass everywhere except one
token-level omission: neither document declares `color-scheme: dark`, so
placeholder text renders at Chromium's light-scheme default and measures
**4.00–4.09:1**, just under the bar.

Everything below was measured on the running app, from painted pixels, not
from stylesheets. Environment: Electron 43.2.0 (win32, one machine), build
from source at `abca603` (out/ rebuilt from a pristine `src/` before
measurement), CDP screenshots at DPR 1, WCAG 2.x relative-luminance ratios.

---

## 1. Method — how these numbers were produced

Contrast is computed from **rendered pixels**, because force-dark rewrites
colors at paint time: `getComputedStyle` still reports the authored values and
is blind to the entire defect class. The instrument:

- Three local fixtures served over `127.0.0.1` (sources in §6.3): a **light**
  page with no dark support (30 patches: a background-brightness sweep, a
  text-brightness sweep, and 12 real-world patterns — Bootstrap alerts/badges,
  Wikipedia infobox, zebra rows, buttons, links); a **dark-native** page (dark
  styling, *no* `color-scheme` declared — extremely common); and a **proper
  dark-scheme** page (`color-scheme: light dark` + `prefers-color-scheme`
  media query).
- Each patch renders its text color as a run of `████` (U+2588 FULL BLOCK) at
  26px: a solid rectangle of pure painted text color, immune to antialiasing.
  A median-of-9 pixel sample at the glyph center gives painted-fg; a sample in
  the patch's text-free corner gives painted-bg.
- Screenshots via CDP `Page.captureScreenshot` on the tab target
  (`--remote-debugging-port`), coordinates from `getBoundingClientRect`
  scaled by `devicePixelRatio`.
- Aperture's own windows audited the same way plus a computed-style walk
  (valid there because measurement confirmed force-dark does not repaint the
  already-dark chrome; a screenshot cross-check agreed).

WCAG 2.x bars: **4.5:1** body text, **3:1** large text (≥24px, or ≥18.66px
bold) and UI components. Disabled controls are exempt.

---

## 2. The diagnosis table — every failing surface

Painted values from the running app, theme dark (the startup default —
`applyDarkMode('dark')` in `src/main/index.ts`).

### Category 2 — Chromium force-dark on pages (the reported defect)

| surface (fixture patch) | authored fg/bg | authored ratio | painted fg/bg | painted ratio | why |
|---|---|---|---|---|---|
| `#333` text on `#cccccc` (badge/button/table-header gray) | `#333333`/`#cccccc` | 7.87 | `#dfdfdf`/`#cccccc` | **1.21** | text flipped (51 < 150), bg kept (204 ≤ 205) |
| `#333` on `#c0c0c0` | `#333333`/`#c0c0c0` | 6.94 | `#dfdfdf`/`#c0c0c0` | **1.37** | same seam |
| `#333` on `#b0b0b0` | `#333333`/`#b0b0b0` | 5.83 | `#dfdfdf`/`#b0b0b0` | **1.63** | same seam |
| `#333` on `#a0a0a0` | `#333333`/`#a0a0a0` | 4.83 | `#dfdfdf`/`#a0a0a0` | **1.96** | same seam |
| `#333` on `#909090` | `#333333`/`#909090` | 3.96 | `#dfdfdf`/`#909090` | **2.40** | same seam |
| mid-gray badge on a **dark-native** site | `#333333`/`#cccccc` | 7.87 | `#dfdfdf`/`#cccccc` | **1.21** | same seam — and the auto-skip that would prevent it never runs (F2) |
| light-blue button on a dark-native site | `#0b1220`/`#6aa9ff` | 7.79 | `#f8ffff`/`#6aa9ff` | **2.38** | the chromatic case: `#6aa9ff` luma ≈ 160 is in the band |
| **whole light page under theme `light`** | `#333333`/`#ffffff` | 12.63 | `#dfdfdf`/`#121212` | n/a — transformed when it must not be | F3: light mode does not stop darkening |

### Category 1 — Aperture's own UI (ours to restyle)

| surface | painted fg/bg | ratio | why |
|---|---|---|---|
| omnibox placeholder, chrome window | `#757575` / `#17171b` | **4.00** | no `color-scheme: dark` on the document → Chromium's *light-scheme* UA placeholder color on Aperture's near-black input |
| vault gate passphrase placeholders (`#pass`, `#pass2`) | `#757575` / `#111114` | **4.09** | same omission in `vault.css` |

**Everything else in Aperture's own UI passes.** Chrome window measured
5.97–13.32 on all visible text (tab titles 13.32, dim toolbar glyphs 5.97,
shield 9.59, agent pill 6.44). Vault gate measured 6.50–14.50. The two
sub-4.5 rows besides placeholders are exempt: disabled toolbar buttons
(`opacity: .3`, WCAG-exempt) and the tab-close `×` at `opacity: 0` until
hover (hover state computes ≈ 7:1). A static audit of every fg/bg pair in
`vault.css` (inner panels included) finds no non-exempt pair below 4.5 —
lowest is `.pill` at ≈ 5.5. The dark palettes themselves are sound.

### What was measured and passes (scope of the defect)

- All 12 real-world light-site patterns pass under force-dark (4.51–14.06):
  pastel backgrounds (brightness > 205) are correctly darkened, dark-saturated
  buttons (`#1a73e8`, luma ≈ 102) correctly keep their white text.
- A page shipping its own dark theme via `color-scheme` renders it untouched
  (painted == authored `#d5d5da`/`#232329`, 10.68). Layer 1 works.
- Dark-native pages' dark regions are untouched (no double-inversion).
- The chrome window is not repainted by the process-wide force-dark (its
  colors sit outside both classifier thresholds).
- Per-site `off` via `browser_theme` fully restores authored rendering.
- CDP `Emulation.setAutoDarkModeOverride` works **both directions** on
  Electron 43.2.0 — including as a *standalone* enable with the global blink
  switch removed (measured; this matters for the fix).

---

## 3. Findings — mechanism, with the evidence

### F1 — the classifier seam (Chromium's, but we switch it on)

Blink's force-dark classifies **text and backgrounds independently**: text is
flipped light iff its brightness < 150; a background is flipped dark iff its
brightness > 205. The measured boundaries agree exactly: `#d0d0d0` (208)
flipped, `#cccccc` (204) kept; `#888` (136) flipped, `#999` (153) kept.
Any element whose background sits **≤ 205** while carrying text **< 150** gets
light-on-light. Derived from the measured flip mapping (`#333`→`#dfdfdf`),
painted contrast crosses under 4.5:1 at bg brightness ≈ 98 and under 3:1 at
≈ 125, so the broken band is **bg brightness ∈ (98, 205] with dark text** —
`#a0a0a0` chips, `#c0c0c0` legacy UIs, silver table headers, and light-chroma
buttons (`#6aa9ff` luma 160) with dark labels. Grays anchor the measurement;
for chromatic colors the exact classifier metric (luma vs HSL-L) was not
distinguishable from this data — the bench (§6) therefore asserts on measured
pixels, not on a formula.

**The thresholds are not tunable on this build — measured, three channels:**

| channel | tried | effect |
|---|---|---|
| `blink-settings` keys as shipped (`forceDarkModeTextLightnessThreshold=150, …BackgroundLightnessThreshold=205→150`) | yes | none — byte-identical table |
| `blink-settings` current-Chromium spellings (`…ForegroundBrightnessThreshold`, `…BackgroundBrightnessThreshold` at 150) | yes | none |
| `--enable-features=WebContentsForceDark:background_lightness_threshold/150` (feature params; also as sole enabler with the blink switch stripped) | yes | none — and the feature alone enables nothing |
| `--dark-mode-settings=BackgroundBrightnessThreshold=150` | yes | none |

Only `forceDarkModeEnabled=true` does anything. The four tuning keys in
`enableForceDark()` (`src/privacy/darkmode.ts:47-59`) are **dead config**, and
the comment above them ("Selective inversion: preserves images and skips
already-dark elements") describes Chromium's *built-in defaults*, not anything
those keys accomplish. The observed selective behavior is the default
classifier, take it or leave it — per tab, via the CDP override.

### F2 — the policy engine is not wired to navigation

`applyToTab` — per-site Auto/On/Off, the already-dark measurement, the
`knownDark` cache; its own doc comment says "Called after each navigation" —
has **exactly one call site**: the `browser_theme` MCP tool
(`src/mcp/tools.ts:2134`). No navigation event calls it. What darkens pages in
ordinary browsing is the unconditional process-wide blink switch alone.
Measured consequence: a dark-native site freshly navigated has its light
widgets broken (1.21 / 2.38 above); one `browser_theme{}` call later, auto
detects "site already ships a dark theme", un-darkens, and the same widgets
measure 7.87 / 7.79. The protection exists, is correct, and never runs for a
human browsing. (The human, note, has **no** dark-mode control surface at all
— the only client of the policy engine is the agent.)

### F3 — theme `light` does not stop page darkening

Clean measurement (fresh app, tab never touched by any override):
`browser_theme{mode:'light'}` then fresh navigation → the page still paints
force-darkened, while the tool reports `not darkened (theme is light)`. Two
causes stack: the blink switch is unconditional (independent of
`prefers-color-scheme`), and `applyToTab`'s light path returns early
**without** calling `setTabDark(wc, false)` (`darkmode.ts:91`). The tool
reports the *decision*; nothing enforces it.

### F4 — `knownDark` is an origin-keyed ratchet (minor)

One dark page on an origin permanently classifies the whole origin as dark for
the session — measured: after the dark-native fixture, the *light* fixture on
the same origin reported "site already ships a dark theme" and went undarkened.
The cache is never corrected by a later light measurement. (All of this state —
mode, site policies, `knownDark`, `tuning` — is also in-memory only;
persistence is explicitly out of scope here, §8.)

### F5 — missing `color-scheme` in Aperture's own documents (category 1)

Both `style.css` and `vault.css` build dark UIs but never declare
`color-scheme: dark` (`getComputedStyle(document.documentElement).colorScheme`
→ `"normal"`, measured). Chromium therefore renders UA-styled internals —
placeholders, native scrollbars, `<select>` popups, autofill tints — with
light-scheme defaults. The measured casualties are the placeholder rows in §2;
the same omission is why scrollbars render light. This is a **token-level**
omission, not a scatter of bad values.

---

## 4. Rulings (the four questions)

1. **Which surfaces fail:** web pages under force-dark (category 2) — the mid
   band on light sites, light widgets on dark-native sites, and everything
   under theme `light`; plus one token-level miss in category 1 (placeholders
   via missing `color-scheme`).
2. **Systemic or scatter:** systemic, in both categories — one classifier seam
   plus one unwired policy loop on the page side; one missing declaration on
   the UI side. Aperture's dark palette values are sound; no token is misused.
3. **Chromium implicated — what are the options:** the classifier is
   non-configurable on this build (measured, §3-F1), so the options are
   (a) wire the policy loop so the shipped protections actually run,
   (b) per-page fallback to the filter-inversion mechanism — which has **no
   classification seam** — where the seam provably bites, (c) nothing.
   Doing nothing fails the report: the band includes common UI furniture.
   Threshold tuning is not an option; it was measured dead. The fix below is
   (a) + (b).
4. **Token-level or per-surface:** token-level everywhere. Own UI: one
   `color-scheme` declaration + one `::placeholder` rule per stylesheet — no
   per-surface overrides. Page side: mechanism-level (policy wiring + per-page
   mechanism selection), never per-site CSS patching.

---

## 5. The fix — three parts, in landing order

Parts 1 and 2 are small and zero-risk; land them first and independently of
part 3. **Concurrent-work note, superseded 2026-08-06:** when this was written
the tree carried in-flight note-channel work (`#note-btn`, `#note-input`). The
owner dropped that feature the same day and it was removed, so those selectors
no longer exist. Every edit below was additive and anchored to
selectors/functions rather than line numbers, which is why none collided.
**The `input::placeholder` rule stays and is not note-channel debris** — its
real job is the omnibox placeholder (§3-F5, measured 3.88 → 6.44). It was
nearly deleted during the voice removal on the mistaken belief that it existed
for `#note-input`; that would have silently reverted this document's own fix.

### Fix 1 — declare the scheme, pin the placeholders (category 1)

In `src/renderer/style.css`, inside the existing `:root` block, add:

```css
  color-scheme: dark;
```

and append (element-level, so future inputs inherit the treatment):

```css
input::placeholder {
  color: var(--fg-dim);
}
```

In `src/renderer/vault.css`, same two edits (`color-scheme: dark;` in `:root`;
`input::placeholder { color: var(--dim); }`). Both variables are `#9a9aa8`;
over the input backgrounds this measures ≈ 6.7:1 (computed: 6.69 chrome,
6.84 vault). Declaring `color-scheme: dark` also fixes scrollbars, `<select>`
popups and autofill tints in one move. No markup changes, no behavioral
change, vault window properties untouched (CSS only — the window remains
TabManager-invisible, content-protected, sender-checked).

### Fix 2 — wire the policy engine to navigation (category 2, architecture)

All in `src/privacy/darkmode.ts` plus one wiring line, keeping the
`browser_theme` tool surface **byte-identical** (no new parameters, no new
agent capability).

1. **`applyToTab` must always end decisive.** The `mode === 'light'` path
   currently returns without touching the tab; it must `await setTabDark(wc,
   false)` first. Same for a `'system'` mode resolving light
   (`nativeTheme.shouldUseDarkColors === false`). Every path through
   `applyToTab` ends in exactly one `setTabDark(wc, true|false)`.
2. **New export `installDarkModePolicy(tabs: TabManager): void`**, called once
   from `src/main/index.ts` right after `createWindow()` (the module already
   imports from `@privacy/darkmode`). It subscribes:
   - `tabs.on('document-navigated', id)` → run the decision for that tab.
     Synchronously at this event, apply the **preseed**: if mode is
     light-resolving → `setTabDark(false)`; else if site policy is `off` →
     `false`; `on` → `true`; `auto` → `knownDark.has(origin) ? false : true`.
     (Dark is the default posture; the preseed exists so revisits to known-dark
     sites do not flash inverted.)
   - then, for `auto` only, re-measure at the tab's next `dom-ready` (styles
     are applied by then; measuring at commit reads a blank document and
     mis-classifies every dark site as light — that mis-decision would
     *persist*, so measure late, preseed early). Apply the measured decision
     and **correct the cache both ways**: dark → `knownDark.add(origin)`;
     light → `knownDark.delete(origin)` (closes F4's ratchet).
   - a first-ever visit to a color-scheme-less dark site may flash inverted
     for the commit→dom-ready interval, once per origin per session. Accepted
     residual; the `knownDark` preseed removes it on every revisit. Sites
     declaring `color-scheme: dark` never flash (Blink skips them natively —
     measured).
3. **`applyDarkMode(next)` sweeps.** After setting `nativeTheme.themeSource`,
   iterate every tab TabManager knows and re-run the decision (light →
   everything un-darkens immediately; back to dark → policy re-applies). This
   makes the F3 measurement pass: theme `light` + fresh navigation must paint
   authored colors, and the sweep handles already-open tabs.
4. **Delete the four dead blink-settings keys** in `enableForceDark()`, keep
   only `forceDarkModeEnabled=true`, and replace the "Selective inversion"
   comment with the truth: the selective behavior is Chromium's built-in
   default; the threshold/algorithm/image keys were measured as no-ops on
   Electron 43 (three channels, 2026-08-06, this document). Keeping the
   global switch (rather than moving to pure per-tab CDP enable, which was
   measured to work) is deliberate: default-dark posture without a white
   flash on every navigation. The CDP override remains the per-tab veto/apply.

### Fix 3 — per-page fallback where the seam bites (category 2, the band)

When the decision is "darken" and the page provably contains the F1 seam,
darken that page with the **filter-inversion mechanism instead** — the
already-shipped Nightfall-derived `applyFilterFallback` (counter-inversion
set, nesting guard, filter on `<html>`). A uniform inversion has no
per-element classifier and therefore no seam; its output for every fixture
patch computes ≥ authored × 0.8 (see the bench bound below — pure inversion
is not contrast-preserving in WCAG terms, e.g. authored 4.83 → 3.94, which is
why the acceptance bound is relative, not flat).

Mechanics, all in `darkmode.ts`:

- After the `auto`/`on` darken decision lands at `dom-ready`, run a **band
  scan** in the same `executeJavaScript` channel `pageIsAlreadyDark` already
  uses: walk at most the first 4000 elements; for each element with a
  non-empty visible text node and rendered area ≥ 24px², resolve its
  effective background (first ancestor with alpha ≥ 0.5, else white) and take
  luma = 0.299r + 0.587g + 0.114b of text and background. **Predicate:**
  text luma < 150 AND background luma ∈ [98, 205). Early-exit on first match.
- ≥ 1 match → `setTabDark(wc, false)` then `applyFilterFallback(wc, true)`.
  Trigger at one because under-triggering leaves unreadable text (the
  reported defect) while over-triggering costs only aesthetics; the
  brightness/contrast `tuning` values — dead code today — become live here.
- Re-run the scan once at `did-stop-loading` if it has not already triggered
  (late-hydrating SPAs). No MutationObserver — bounded cost is worth more
  than perfect coverage; content mutated in after both passes is an accepted
  residual, recorded here.
- The scan and the filter style run in the page's main world, as
  `pageIsAlreadyDark` already does. A page can observe or fight this
  (remove the `<style>`, lie in computed styles). That is a cosmetic channel:
  no secret crosses it, no agent surface grows, nothing the page could not
  already do to its own styling. Recorded, not defended against.
- `mechanism()`/the `browser_theme` report line may say
  `filter-inversion (contrast repair)` for such a tab. Output text only; the
  tool schema does not change.

**Rejected alternatives, so nobody re-litigates them:** threshold tuning
(measured impossible, §3-F1); per-element CSS repair of band elements
(fights page styles, breaks hover states, needs a MutationObserver to be
correct — fragile in exactly the way the filter path is not); pure per-tab
CDP enable with no global switch (works, measured, but flashes white on
every navigation); doing nothing (fails the report).

---

## 6. Acceptance — a regression bench, not a screenshot

### 6.1 `bench/darkmode.mjs` (add npm script `bench:darkmode`)

Reuses `bench/lib/aperture.mjs` `startAperture` (add a pass-through for
`--remote-debugging-port=9333` if its signature lacks one), serves the three
fixtures from §6.3 on `127.0.0.1:8991`, drives theme/site state via the MCP
`browser_theme` tool (bearer token exactly as `bench/live.mjs` reads it), and
measures painted pixels via CDP screenshots using the §1 sampling method
(block-glyph center, median-of-9, DPR-scaled). CDP screenshot calls on this
build are flaky (~50% first-call hangs, measured): wrap in an 8s timeout with
up to 3 attempts — a retry, not a tolerance change.

Let `authored` be the fixture-declared pair's ratio and `painted` the measured
one. Define `REQ = min(4.5, max(0.8 × authored, min(3.0, authored)))` — never
holds a surface to a bar its author didn't clear, while forbidding darkening
from destroying usable contrast.

> **Corrected 2026-08-06 (coordinator ruling).** As first written this bound
> was `min(4.5, max(3.0, 0.8 × authored))`, and its `max(3.0, …)` leg
> contradicted the sentence above it: it demanded 3.0 from *every* surface,
> including surfaces whose author never reached 3.0. `fg-aaa/fff` is the row
> that exposed it — authored 2.32, inversion IMPROVED it to 2.82, and the old
> bound failed it anyway for having been low-contrast in the source. That is a
> defect the page shipped, not damage the darkening did, and this bench
> measures the darkening. Replacing the flat floor with `min(3.0, authored)`
> changes exactly two rows' bounds (`fg-999/fff` 3.00 → 2.85, `fg-aaa/fff`
> 3.00 → 2.32) and flips exactly one verdict, the intended one; every row
> authored at 3.0 or above is untouched, so `bg-909090/333` stayed red on its
> own merits and was fixed in the mechanism instead (§6.4).

| case | setup | assertion |
|---|---|---|
| R1 | theme dark, `light.html`, plain navigation | every patch `painted ≥ REQ` |
| R2 | theme dark, `darknative.html`, plain navigation — **no `browser_theme` call first** | every patch `painted ≥ REQ`, and the three `dk-*` dark patches painted **equal to authored** (auto-skip ran from navigation, not from the tool) |
| R3 | theme dark, `darkscheme.html` | painted equals the page's own dark palette (`#d5d5da`/`#232329`) |
| R4 | `browser_theme{mode:'light'}`, then fresh navigation of `light.html` | every patch painted **equals authored** (no transformation) |
| R5 | theme dark, `browser_theme{site:'off'}` on the fixture origin | every patch painted equals authored |
| R6 | chrome window + vault gate (open via the toolbar button), computed-style walk incl. `::placeholder` resolution, cross-checked against a window screenshot | every non-exempt text node ≥ 4.5 (exempt: `:disabled`, `opacity: 0` hover-reveal controls) |

Vacuity guards, house rule: exact expected patch counts per fixture (30 / 7 /
1), screenshot must not be monochrome, R6 must see ≥ 6 audit rows per window,
and the bench refuses to run if `out/` is older than any file in `src/` (same
staleness rule the guards bench enforces). A run that measured nothing prints
no verdict.

### 6.2 RED baseline — what this bench must say **today**

Recorded so the first green means something. Against `abca603` as measured:

- R1 **red**: 5 rows (`bg-ccc/333` 1.21, `bg-c0c0c0/333` 1.37, `bg-b0b0b0/333`
  1.63 — all vs REQ 4.5; `bg-a0a0a0/333` 1.96 vs 3.86; `bg-909090/333` 2.40
  vs 3.17).
- R2 **red**: `dk-mid-badge` 1.21, `dk-accent-btn` 2.38, and the equality leg
  fails wholesale because auto-skip never runs on navigation.
- R4 **red**: page paints `#dfdfdf`/`#121212` where authored is
  `#333333`/`#ffffff`.
- R6 **red**: two placeholder rows (4.00, 4.09).
- R3, R5 **green** today (layer 1 and the CDP off-path already work).

The builder must run the bench before the fix and confirm this exact red set,
then after, and attach both outputs. A bench that cannot reproduce the red
rows above is measuring something else — stop and find out what.

### 6.3 Fixtures

Commit the three files under `bench/darkmode-fixtures/`. They are the
measurement instrument; do not restyle them. Sources (verbatim, including the
patch tables — the `__patches()` helper returns per-patch probe/background
sample points):

`light.html` — 30 patches: bg sweep `#ffffff #f6f8fa #eeeeee #e0e0e0 #d0d0d0
#cccccc #c0c0c0 #b0b0b0 #a0a0a0 #909090` × `#333333` text (last two rungs
`#808080 #707070` × `#ffffff`); fg sweep `#000 #555 #777 #888 #999 #aaa` on
white; patterns `link #0645ad/#fff`, `btn-primary #fff/#1a73e8`,
`alert-warning #856404/#fff3cd`, `alert-secondary #41464b/#e2e3e5`,
`badge-gray #616161/#e0e0e0`, `code-inline #d63384/#f5f5f5`, `wiki-infobox
#202122/#eaecf0`, `zebra-row #212529/#f2f2f2`, `nav-pill #495057/#e9ecef`,
`btn-light #212529/#f8f9fa`, `muted-on-white #6c757d/#fff`, `selected-item
#0b57d0/#d3e3fd`. Plain light page: **no** `color-scheme`, no dark media
query. Each patch: 152×64px div, `data-name/bg/fg`, a 26px `████` span in the
text color, a 9px label, `window.__patches()` exposing glyph-center and
patch-corner points.

`darknative.html` — body `#1b1b1f`/`#dddddd`, **no** `color-scheme`; patches
`dk-body-text #dddddd/#1b1b1f`, `dk-dim-text #9a9aa8/#1b1b1f`, `dk-card
#e6e6ea/#26262e`, `dk-light-btn #333/#e0e0e0`, `dk-white-card #333/#fff`,
`dk-mid-badge #333/#cccccc`, `dk-accent-btn #0b1220/#6aa9ff`.

`darkscheme.html` — `:root { color-scheme: light dark }`, light styles plus a
`prefers-color-scheme: dark` block (`#17171a`/`#d5d5da`, card
`#232329`/`#d5d5da`), one `scheme-card` patch.

(The diagnosis run's copies of these files, plus the CDP/PNG sampling helper
they ran under, exist in the diagnosis session's scratchpad; the sources above
are normative if the copies are gone.)

### 6.4 `tuning.contrast = 110` — the mid-grey rung, measured not waived

Added 2026-08-06 (coordinator ruling). With §6.1's bound corrected, one R1 row
was still red on its own merits: `bg-909090/333`, painted **3.13** against
REQ **3.17**.

The cause is arithmetic, not tolerance. Uniform inversion is not
contrast-preserving, and at this rung it returns **0.79×** the authored ratio
where the bound assumes 0.8× — a shortfall of about one part in eighty. §6.1's
0.8× was checked one rung up (`#a0a0a0`, which clears) and not at this one. So
the deficiency is in the mechanism and was repaired there; the 0.8 factor was
not touched.

`tuning.contrast` (the now-live filter-inversion knob) was swept and every
R1/R2/R3/R5 row measured at each value. Raising contrast pushes the mid-grey
BACKGROUND rungs apart and pulls the near-white FOREGROUND rungs together, so
the binding constraints move in opposite directions:

| contrast | `bg-909090/333` (REQ 3.17) | `fg-aaa/fff` (REQ 2.32) | bench |
|---|---|---|---|
| 100 | 3.13 (−0.04) | 2.82 (+0.50) | RED |
| 102 | 3.16 (−0.01) | 2.77 (+0.45) | RED |
| 105 | 3.31 (+0.14) | 2.73 (+0.41) | GREEN |
| **110** | **3.49 (+0.32)** | **2.65 (+0.33)** | **GREEN** |

**110 is the max-min point** — it maximizes the worst margin over all 37 rows
(+0.32, against +0.14 at 105), and above it `fg-aaa/fff` becomes the binding
row instead. Only three rows move down at all (`fg-888` −0.07, `fg-999` −0.16,
`fg-aaa` −0.17) and none approaches its bound. All seven dark-native (R2) rows
measured **byte-identical at every value**, as do R3/R4/R5: the auto-skip means
no filter is injected on those pages, so this knob cannot reach a page Aperture
decided not to darken.

---

## 7. Constraints honored

- **No security work.** No changes to redaction, envelopes, guards, the seven
  mechanism classes, or any agent-reachable surface. `browser_theme`'s schema
  is unchanged; the consent dialog is untouched (it is a native OS dialog —
  not CSS-stylable, OS-themed, and its native/agent-unreachable/page-bytes-free
  properties are binding). The vault window changes are two CSS declarations;
  its structural properties do not move.
- The band scan and filter injection run in the page main world exactly like
  the existing `pageIsAlreadyDark` probe — no new capability, cosmetic channel
  only, recorded in §5-Fix 3.
- Proportionality: the acceptance instrument is a contrast re-measurement of
  the diagnosis table. No sabotage battery.

## 8. Not verified / deliberately not included

**Could not verify:**

- Vault **inner panels** live (no vault was created — the profile had none and
  creating one would have left owner-visible state). Static analysis of every
  `vault.css` pair stands in; lowest non-exempt pair ≈ 5.5:1. R6 audits the
  gate; extending it behind a bench-created throwaway vault is left out.
- The consent dialog's rendering under Windows dark mode (native, not
  reachable without a real fill flow).
- The filter-inversion fallback path on a build where the CDP override
  *fails* (`cdpOverrideWorks === false` was never observed on Electron 43).
- Liveness of the `forceDarkModeInversionAlgorithm`/`ImagePolicy` keys —
  the threshold keys are proven no-ops; these two are plausibly dead too but
  produce no measurable difference from defaults either way.
- Real-web behavior: every measured page is a local fixture; one machine,
  Windows 11, Electron 43.2.0. The classifier constants could move on a
  future Electron — the bench, not this document, is the durable claim.

**Deliberately not included:** persistence of theme/site-policy/`knownDark`
across launches (all in-memory today; separate product decision); any
human-facing dark-mode UI (the human currently has no control surface — real
gap, different spec); per-site mechanism overrides beyond Auto/On/Off;
Chromium patches or upstream work; brightness/contrast tuning UI; the
in-flight note-channel work this tree carries; and any change to what the
agent can reach.
