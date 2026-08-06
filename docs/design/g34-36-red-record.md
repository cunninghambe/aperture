# G34–G36 RED record — acting where a human demonstrably cannot, observed live on the pre-fix build

What this file is: the evidence that G34, G35 and G36 discriminate. An
instrument that has never seen the defect it guards is the false green all over
again (`docs/design/tier4.md` §0; the F4 lesson, after
`blindfields-red-record.md`, `g14-red-record.md`, `g15-red-record.md` and
`g29-red-record.md`). `test/fixtures/unreachable.html` and the G34–G36 blocks in
`bench/guards.mjs` were authored and run BEFORE any `src/` edit for Bundle B,
against a build in which `statesOf` consults `:disabled` and nothing else, the
`select` handler refuses on `isDisabled` and nothing else, and `resolveRef`'s
point hit-test is the only reachability gate anywhere.

**Eight of the eleven legs FAILED.** Post-fix all eleven pass against the
byte-identical fixture, guard and command line.

## The build under test — provenance

| fact | value |
|---|---|
| repo | `C:\Users\cunni\dev\aperture` |
| HEAD | `514b507` ("security: close a redaction bypass found by verifying the fix for its sibling"), tree dirty with Bundle A only |
| the RED bundle | HEAD + **Bundle A** (tier6 §2 and §3): `render.ts`, `bench/lib/streamModel.mjs`, the two legend lines in `tools.ts`. No Bundle B code whatever. |
| `out/main/index.js` | sha256 `f24c37e646941e3da4c6190bb7d445e09429ec93a9d4fe2983bb6a14e84d2b1f` (built 2026-08-06T18:01:27Z) |
| the GREEN bundle | the same tree plus Bundle B |
| `out/main/index.js` | sha256 `c7d4c2f0476c073a51c0c52b14cf73680a65ebd1f1b626cb51a3c8e4a843d8c1` |
| `out/preload/page.cjs` | sha256 `d7f6fe51e8470d31947a61f49041e86bf8b403349ada040d00dbffbf844641d1` |
| fixture | `test/fixtures/unreachable.html` sha256 `8ff2110d472a0fcc8e54ad73159227b1bc774ea035826e60b591eda19179d403` |
| Electron | 43.2.0 · Node v22.14.0 (harness) |
| command | `node bench/guards.mjs <tok> --phase=allow`, fixtures on `0.0.0.0:8899`, launch `--seed-vault --seed-profile --seed-botauth=bench/fixtures/botauth-dev-key.json --e2e-consent=allow --e2e-consent-delay-ms=1500` |

**Why the RED bundle is provably pre-fix.** `guards.mjs` refuses to run when
`out/main/index.js` is older than any file under `src/`, and it prints the
artifact's SHA-256 in its header and in its RESULT line — both runs below carry
theirs. The RED bundle's hash is the one Bundle A's own acceptance battery was
measured against, and the two hashes differ.

**One caveat on the hash, worth recording because it is a gap in the
instrument.** `guards.mjs` hashes `out/main/index.js` only. Every reachability
FACT in this bundle is computed in the preload, which builds to
`out/preload/page.cjs` — so a preload-only change leaves the recorded artifact
hash unmoved. Measured during the sabotage matrix below: three separate preload
sabotages all reported `sha256 c7d4c2f0476c073a…`, identical to the clean build.
The mtime staleness check still fires (it compares against all of `src/`), but
the recorded hash does not identify the bytes that were actually under test.
Both preload hashes are recorded above for that reason.

## The fixture

`test/fixtures/unreachable.html`, in `guards.html`'s conventions: a `#witness`
paragraph reading `events: …`, appended to by the page's own listeners, because
Aperture reporting "refused" is not evidence that nothing happened — the page's
record is. (The tier6 spec says "`data-bench` witness wiring"; `data-bench` is
the `bench/fixtures` task-collector convention. The guard fixtures use the
`events:` line, and `guards.mjs`'s own `witness()` helper reads exactly that, so
this fixture follows the guard convention it is actually run by.)

Six sections, and every constraint in them is load-bearing:

1. **`#inert-panel`** — a `<select>` and a `<button>` under one `inert`
   attribute.
2. **`#live-panel`** — the byte-identical twin with no `inert`. Without it a
   build that refused everything would pass G34a and G34d while measuring
   nothing.
3. **`#shadow-inert-host`** — `inert` on the HOST, the button in its open shadow
   root. Added after a sabotage; see the matrix.
4. **`#ghost-panel`** — a `pointer-events: none` button and select, each sitting
   over a DECOY sibling so the pre-fix hit-test resolves to the decoy and the
   error blames it; plus a child that re-enables `pointer-events: auto` inside a
   `none` container. `pointer-events` arrives from a style-sheet class, never an
   inline style — closer to the real web, and inline is the one form the walker
   could have cheated by reading off the attribute.
5. **`#nonmodal-dialog`** — a `<dialog open>` that is NOT modal, open from load.
6. **`#small-dialog`** — 140×92px, `showModal()`, pinned bottom-right, with the
   way out INSIDE it and "Background action" beside it at the top-left.

`left: auto; top: auto` on `#small-dialog` is not tidiness and was found the
hard way: Chromium's UA sheet gives `dialog:modal` `inset: 0`, and with left,
right and width all resolved it is the RIGHT offset that gets dropped — so
`right/bottom` alone pinned the dialog at the TOP-LEFT, directly over the
background button, and the first RED run refused with `covered by
"BUTTON#in-dialog"`, which is only possible if the dialog is on top of it. The
guard's own "beside it, not under it" claim was false until this was fixed.

**Churn**, checked once as §4.6 item 5 requires and stated in the fixture
comment: nothing on this page toggles a class at runtime. Inert and NoPointer
transitions ARE diffed — only Offscreen is masked in `propDelta`, and volatility
suppression does not apply to state changes — so an oscillating class would emit
a state flip per walk with the size governor as the only backstop.

## The RED run, verbatim

`76/84 guards hold` · `RESULT: RED — G34c, G35c, G34a, G34d, G35a, G35b, G36a,
G36d` · `[out/main/index.js sha256 f24c37e646941e3d…]`

```
FAIL  G34c  the inert select's snapshot line says `inert`, so the agent can see why
        line: combobox e62 "Inert field" ="Alpha" [3 options]
FAIL  G35c  the no-pointer button's snapshot line says `no-pointer`
        line: button e68 "Ghost action"
FAIL  G34a  action:"select" on a <select> inside an [inert] panel is refused, and writes nothing
        reply: ok select e62 → "Beta"
        witness: inert-select=b
PASS  G34b  the identical select OUTSIDE the inert panel still succeeds, and the page records it
        reply: ok select e65 → "Beta"
        witness: inert-select=b live-select=b
FAIL  G34d  a click on a button inside an [inert] panel is refused, and the page records nothing
        reply: ok click e63
        witness: inert-select=b live-select=b
FAIL  G35a  a click on a pointer-events:none button is refused for the RIGHT reason, not as an obstruction
        reply: error: e68 is covered by "DIV#decoy-button" — likely a modal or cookie banner. Dismiss it first; acting here would reach the overlay, not the element you named.
        names pointer-events: false; blames a bystander: true
FAIL  G35b  action:"select" on a pointer-events:none select SUCCEEDS — a human reaches it by keyboard
        reply: error: e69 is covered by "DIV#decoy-select" — likely a modal or cookie banner. Dismiss it first; …
PASS  G36c  with the dialog CLOSED, the background button is an ordinary button
        reply: ok click e72
FAIL  G36a  with a SMALL modal dialog open, a click on a background button beside it is refused as modal
        reply: error: e72 is covered by "DIALOG#small-dialog" — likely a modal or cookie banner. Dismiss it first; …
        names the modal: false; blames a bystander: true
FAIL  G36d  an addressable ANCESTOR of the open dialog is refused too
        reply: ok click e70
PASS  G36b  the button INSIDE the open dialog still works
        reply: ok click e75
```

### The hazard the green guard can never show again

`G34a` is the one worth reading twice. `ok select e62 → "Beta"`, and the page's
own witness line says `inert-select=b`: **a form value written into an inert
panel, acknowledged as a success.** `action:"select"` takes no coordinates, so
the hit-test — the only reachability gate that existed — was never consulted, and
nothing else looked at `inert` at all.

`G36d` is the second: `ok click e70`, a background act on an element with an
open modal dialog over the page. `resolveRef` excuses obstruction when the target
CONTAINS the element at the point, and every addressable ancestor of the dialog
does.

### One correction to the spec's mechanism claim (§4.1), measured

tier6 §4.1 says a control beside a small `showModal()` dialog "is clickable
whenever the dialog does not cover its point". That was read from the code, and
it is not what Chromium does: a modal dialog's `::backdrop` covers the WHOLE
viewport and `document.elementFromPoint` returns the `<dialog>` for every point
over it. So the pre-fix build DOES refuse an ordinary background click — as
`covered by "DIALOG#small-dialog" … Dismiss it first; acting here would reach the
overlay`, which names the right element and gives the wrong remedy, sending an
agent looking for a cookie banner to dismiss.

The defect is therefore narrower than stated and still real, in three parts:
the REASON is wrong; the remediation is wrong; and the containment escape hatch
(G36d) lets a whole class of background acts through. G36d was added for exactly
this reason — without it, G36 would be a prose fix wearing a guard's clothes.

## The GREEN run

`87/87 guards hold` · `RESULT: GREEN` ·
`[out/main/index.js sha256 c7d4c2f0476c073a…]` — every pre-existing guard
(73 legs) plus the eleven above plus the three added by the sabotage matrix.

```
PASS  G34a  reply: error: e62 is inside an inert region — the page has disabled it; a human cannot interact with it either.   witness: none
PASS  G34c  line: combobox e62 "Inert field" ="Alpha" [3 options] inert
PASS  G35a  reply: error: e68 does not receive pointer input (pointer-events: none) — a pointer action cannot reach it.
PASS  G35b  reply: ok select e69 → "Gamma"   witness: … ghost-select=c
PASS  G35c  line: button e68 "Ghost action" no-pointer
PASS  G36a  reply: error: e72 is behind an open modal dialog — interact with the dialog first.
PASS  G36d  reply: error: e70 is behind an open modal dialog — interact with the dialog first.
```

## The sabotage matrix

Two rows per guard, one of them chosen from the class rather than from the
implementation — `security.md`'s third clause, now house standard. **All three
author-independent rows survived the guards as written**, and all three forced a
change to them. Honesty about provenance: this bundle had one implementer, so
the "non-author" rows are self-selected from the class and not independently
picked; each is recorded with what it revealed so a reviewer can judge whether
it was a real blind spot or a convenient one.

| guard | row | sabotage | result |
|---|---|---|---|
| G34 | author | remove the inert ascent from the resolve reply | RED — G34d, G34e. **G34a survived**, and that is the belt-and-braces working: the `aperture:select` handler refuses `inert` itself, so the invariant held with the resolve gate gone. |
| G34 | class | `closest('[inert]')` instead of the composed-tree ascent | **survived all of G34a–d** — every section of the fixture was light DOM, so the two implementations were indistinguishable. Forced `#shadow-inert-host` and leg **G34e**; then RED — G34e. |
| G35 | author | move the `blocked` refusal after `r.obstructed`, dropping the no-pointer exemption | RED — G35a, G35b, G36a |
| G35 | class | walk the ancestors for `pointer-events: none` instead of reading the COMPUTED value on the element | **survived G35a, G35b, G35c** — every no-pointer control on the page was styled directly, so nothing distinguished "computed on the element" from "any ancestor says none". Forced the re-enabled child and leg **G35d**; then RED — G35d. |
| G36 | author | gate the dialog check on `findModal`'s >15%-of-viewport rule | RED — G36a, G36d. (The small dialog is precisely what that rule skips.) |
| G36 | class | `dialog[open]` instead of `dialog:modal` | **survived every leg** — nothing on the page carried a non-modal open dialog, so a build that took the whole page away from the agent whenever any `<dialog open>` existed looked healthy. Forced `#nonmodal-dialog` and leg **G36e**; then RED — G36e plus seven collateral legs. |

Three for three: every author-independent row changed its guard. The criterion
is now five-for-five across this bundle, counting the two in
`docs/design/tier6.md` §2/§3's unit rows (a size-capped `expand` that both
original row sizes straddled, and a reader role gate widened to `'?'`).

## What this record does not cover

- **jsdom.** The walker's `inert` and `pointer-events` bits, and `dialog:modal`,
  are not trusted under jsdom and are not asserted there — house rule, stated in
  tier6 §4.3. `test/snapshot.test.ts` pins the two words' RENDERING and their
  diffing; the guards above are the verification of record for everything else.
- **`aria-modal="true"` overlays.** Deliberately un-enforced by the modal rule:
  aria-modal is advisory, the platform makes no background inert for it, and the
  hit-test remains the only honest gate — covered-point case only, exactly as
  before. G7a still pins that path and is green in both runs.
- **The fill ride-along.** `checkTarget`'s new inert ascent is asserted at the
  source in `test/fillpaths.test.ts` (the preload cannot be imported into
  vitest — module-scope `ipcRenderer.on`), and its behaviour of record is the
  live G25/G25b legs. tier6 §4.2 asks for "a unit row beside the existing
  `fillReady` rows"; there are no such rows in this tree, and there is no
  `fillReady` — the function is `checkTarget`.
