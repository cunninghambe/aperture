# Tier 6 — the open engine and fidelity defects: triage first, then specs

Status: SPEC, decision-complete. Written 2026-08-06 against HEAD `a9e39d8`,
tree clean. Scope: `docs/HANDOFF.md` "Open defects" items **1–5** (engine and
fidelity). Explicitly NOT here: item 6 (benchmark/harness defects), item 8
(security classes C and D), Web Bot Auth — other workstreams own those, and
§8.3 below names the seams so nobody lands the same edit twice.

Every mechanism claim below was verified by **reading the code at `a9e39d8`**,
except three wire-level facts verified by **unit probe** (vitest against
`src/`, no Aperture launched, port 8817 never touched; the probe file was
temporary and the tree is clean). Probe-derived facts are marked `[PROBED]`;
everything else is read. No live browser probe was run and none was needed.

---

## 0. Triage — the decision for each defect, before any spec

The house standard applied here: **a documented residual with its arithmetic
beats a fix that trades a measured property for an unmeasured one.** Ranked by
what a user actually hits:

| # | HANDOFF defect | decision | why, in one line |
|---|---|---|---|
| 4 | `inert` / `pointer-events: none` / small modal dialogs | **FIX** (Bundle B, §4) | The agent acts where a human demonstrably cannot — a correctness hazard with a real-web surface, ruled DO IT once already (tier2 §5) and never landed |
| 2 | Replace-op elision hides a changed survivor | **FIX** (Bundle A, §2) | The top-ranked fidelity hole; ruled DO IT (tier2 §1); RED already demonstrated at unit level `[PROBED]` — the changed survivor's new text is absent from the wire |
| 3 | `~ eN "A"` ambiguous by format | **FIX** (Bundle A, §3) — upgraded from tier2 §10's deferral | The probe showed it is not merely unreadable but **corrupting**: the shared reader misapplies a text-only delta as a label change `[PROBED]`. The deferral's justification (mid-backlog wire freeze) is discharged; it rides defect 2's severance event, so the marginal cost is the smallest it will ever be |
| 1 | `identity_mismatch` cannot fire on identical-label rows | **DOCUMENT-AND-CLOSE** (§5) — retire the *detector claim*, keep the bucket | Repair is structurally impossible without leaking fixture ground truth into a stream the product deliberately withholds; the precision primary never consulted it anyway (verified, §5.1); the bucket still catches the cross-family class (tasks.mjs T2) so deletion would discard a real advisory signal |
| 5 | Input-witness (W1) residuals | **DOCUMENT-AND-CLOSE** (§6) | Both residuals are design decisions with recorded rationale and an existing advisory instrument; every considered strengthening re-creates the exact failure W1's contract exists to prevent (§6.2) |

Nothing here is a "retire the thing that reports it" case except item 1's
*claim* — the metric survives as an advisory bucket with its domain stated,
because the alternative (deleting or renaming it) severs stores and breaks
attribution-test pins for zero measurement gain, while the thing that was
actually dangerous — citing its zero as evidence — is already banned by
HANDOFF rule and becomes structurally documented by §5's note.

### 0.1 The crown-jewel rule, applied once here and binding on every section

The post-tier5 precision result (zero landed wrong-element actions in 220
episodes, −0.109 [−0.200, −0.036]) is pinned to build `0916e30f…`
(h2h-post-tier5-evaluation §0.1). The rule for everything in this file:

- **No change below touches ref identity or retirement.** `diff.ts` and
  `registry.ts` are edited by NOTHING in this spec — `identityKey`,
  `disambiguate`, `retirePositionalRebinds`, `retireKey`, `ensureRef`,
  `markDead`, `buryUnder` all stay byte-identical. Acceptance for both bundles
  includes `git diff` **empty** on `src/core/snapshot/diff.ts` and
  `src/core/snapshot/registry.ts`. The tier5 loud-refusal path (dead-ref act →
  refuse + observe, tools.ts ~1443) is also untouched.
- **Bundles A and B do change the rendered wire** (expanded subtrees, the
  `text` token, two new state words). A changed wire changes what agents read,
  so the measured zero **cannot be restated as a property of any post-tier6
  build**. Every existing claim stays exactly as it is — hash-pinned to
  `0916e30f…`, which §0.1 of the adjudication already requires. If anyone
  wants the precision sentence *for a tier6 build*, that is a fresh
  preregistered cohort (`--new-cohort`); nothing in any existing store is
  re-scored or pooled, per the standing rules.
- Mechanism-level statement, so the above is not mistaken for hedging: neither
  bundle can *create* a landed-wrong route. Bundle A only widens what the
  model is shown (expansion) and sharpens what an update line means; Bundle B
  only converts would-be-landed acts on human-unreachable elements into
  refusals — the same silent→loud direction tier5 bought. The risk being
  managed is claim hygiene, not a suspected regression.

---

## 1. Bundle and ordering overview

- **Bundle A** (§2 + §3, one severance event): render.ts expansion + update-line
  disambiguator + shared reader + legend + tests + the `filterlist` fidelity
  scenario. §2 and §3 land as **separate commits inside one bundle** (each is
  independently revertable) but no scored run may start between them.
- **Bundle B** (§4): inert/no-pointer/modal gating — walker, preload, tools,
  guards G34–G36, fixture `unreachable.html`, red-record doc.
- **Closures** (§5, §6): doc edits, plus one harness-docstring ride-along that
  waits for the sibling harness bundle.

A before B, because B's guards assert against rendered lines and should be
written against the final wire. Nothing blocks the closures; land them any
time. Full order, atomicity and ownership: §8.

---

## 2. Defect 2 — expand `add`/`replace` op subtrees (Bundle A, commit 1)

### 2.1 What is broken, re-verified at `a9e39d8`

`renderOp` (src/core/snapshot/render.ts) renders both op subtrees collapsed:
`expand: false` at **line 412** (`add`) and **line 433** (`replace`) — tier2
§1's ruled fix, never landed (tier2 cited ~385/~406; the file has since moved).
When any of the three replace escalations fires, `walk()` in diff.ts returns
immediately (lines 226, 274, 324) — **no `propDelta` update is ever emitted
for a survivor inside the subtree**. The survivor's changed content exists
only in the rendered subtree; if it sits beyond `COLLAPSE_SHOW` (3) in a
same-shape run of ≥ `COLLAPSE_RUN` (5), it is elided. `runOwesReannounce`
(render.ts 195) asks only `reg.needsReannounce(ref)`, which `markDead` sets
for *revived* refs — a survivor never died, so the gate passes and the run
collapses.

`[PROBED]` — reproduced at unit level: an 8-row list rebuilt with 6 new rows
and 2 survivors, one survivor's link text changed from `Item 7` to
`Item 7 CHANGED`, positioned in the elided tail. The wire:

```
! e1 replaced (gone: e2 e3 … e13):
  list e1
    listitem
      link e18 "Item 11"
      …
    … 5 more listitems (link/button "Add") — read e1
```

The string `CHANGED` appears **nowhere**. The survivor's ref stays live and
resolvable, the model holds the stale text indefinitely (the next diff
compares new-vs-newer, so the change is absorbed into the baseline), and no
re-announcement ever comes. This is the RED; the fixture in 2.4 makes it
reproducible by anyone.

### 2.2 The call

Both literals flip to `expand: true`, unconditionally. Replace the comment at
render.ts 410–411 (its rationale is the one tier1b got wrong) with:

```
// Op subtrees render IN FULL. Everything in an add/replace subtree is content
// the model has by definition never seen; collapsing it only defers the read
// to a strictly dearer channel (a turn + an expand:true FULL page snapshot),
// and the elided tail of a replace could hide a survivor whose content
// changed in the same re-render — a silent fidelity hole, since walk()
// emits no update op inside a replaced subtree (tier6 §2).
```

All three grounds from tier2 §1 re-verified at HEAD:

1. **The size governor already prices the worst case.** engine.ts dry-renders
   the candidate (`renderDiff(…, false)`, line 370) and falls back to a full
   resync above `max(60, lastFullLines × 0.3)` (line 375, `DIFF_SIZE_RATIO`).
   A 500-item replace produces a resync, as today, only slightly earlier.
2. **It closes this defect structurally** — no elided tail, no place for the
   changed survivor to hide.
3. **The `wasEmitted` plumbing needs nothing.** `renderOp` already routes
   marks: commit render applies immediately (`marks = undefined`), dry render
   discards (`marks = []`) — render.ts 379. Expanded subtree lines carry refs
   and get marked emitted on commit, which is required (later `~ eN` updates
   to them must not be gated into `unreadChanges` forever).

Considered and re-rejected, same grounds as tier2: an `expandOps` knob;
expanding `add` only. New consideration, rejected: emitting update ops for
changed survivors *instead* of expanding — it would put a second escalation
path inside `walk()`'s replace branches (code in the one region this spec
forbids touching) to buy a worse wire (an update for a ref whose full line
the model may be about to receive anyway).

One economics note, stated as expectation and not claim: the tier5
warm-revisit cost (+$0.066/ep on `journal-comment`, exactly one extra full
snapshot in 10/10 episodes) is the consumer paying a collapse-expand after a
same-set reappearance retirement. With op subtrees expanded, that restatement
arrives complete in the diff, so the follow-up expand turn should mostly
disappear. Un-measured until a next cohort; do not put it in RESULTS.md.

### 2.3 Files and functions

| file | change |
|---|---|
| `src/core/snapshot/render.ts` | The two literals (412, 433) + the comment above. Nothing else. |
| `test/snapshot.test.ts` | Four rows: (a) `renderDiff` of an `add` whose subtree holds 8 same-shape children renders 8 element lines, zero `… N more` markers; (b) same for `replace`; (c) commit render marks all subtree refs emitted, dry render marks none; (d) **the changed-survivor row**: the §2.1 probe shape verbatim — a replace whose elided-tail survivor has changed text — asserting the new text appears in the rendered diff bytes. (d) must be run against the unfixed build first and observed RED; record the run in the commit message. |
| `test/fixtures/filterlist.html` + `bench/fidelity.mjs` | New scenario, §2.4. |
| `bench/RESULTS.md` | Fidelity section gains the scenario row and the arithmetic line from §2.4. |

Full snapshots keep the `… N more … — read eN` affordance and the collapse
machinery; `runOwesReannounce` stays (it still protects full snapshots). The
tool-description legend's "K more" line stays accurate as written. The bench
reader needs **no change**: expansion only adds element lines, which
`applyObservation`'s fallthrough already restates (streamModel.mjs 260–263).

### 2.4 The `filterlist` fidelity scenario — the fixture this defect never had

`test/fixtures/filterlist.html`: a list of **8** same-shape rows (link +
button, like the probe), a **Refilter** button whose click rebuilds the list
in one re-render: ≥ 6 rows with fresh identity, 2 survivors keeping their
keys, one survivor's link text changed, and the changed survivor placed at
position ≥ 4 of the new children (inside what the unfixed renderer elides).
Same-shape discipline: identical child structure so `shapeHash` matches and
the run really collapses on the unfixed build — copy the probe's shape.
Deterministic, no timers, no randomness, `data-bench` ids per fixture rules.

Scenario entry in `bench/fidelity.mjs` `SCENARIOS`:

- steps: full snapshot → click Refilter (by label, house rule) → final truth.
- `expect: { minRefs: 10, minDiffs: 1 }`.
- The standard comparison does the work: the mechanical reader must hold every
  item's label from the stream alone; on the unfixed build it holds the stale
  survivor text, truth disagrees → **RED**. Run it against the unfixed build
  once and record the red (this is the scenario's discrimination evidence, the
  `blindfields-red-record.md` pattern — one paragraph in the §2.5 red-record
  is enough; no separate doc).
- Print (not assert) the arithmetic line tier2 asked for: rendered expanded
  diff chars vs (collapsed diff chars + the `expand:true` full-snapshot chars
  for the same page), so the "expansion is cheaper than the deferred read"
  claim carries its numbers in every green run.
- Wire it into `bench/fidelity-all.sh` (making it 7 scenarios).

### 2.5 Sabotage and acceptance

Two sabotage rows for the scenario (house standard, one non-author):

1. Author's row: revert the `replace`-site literal only — scenario and unit
   row (d) must go RED.
2. **Picked by someone other than the implementer**, from the class "the
   elision comes back under a condition the guard's author did not exercise".
   Candidate space, deliberately not chosen here: revert only the `add`-site
   literal; sabotage `runOwesReannounce` to return true always (masks the
   fix's necessity — the scenario must still discriminate); move the changed
   survivor to position 2 (inside `COLLAPSE_SHOW` — the scenario should then
   be GREEN even unfixed, proving it tests the tail, not the change).

Acceptance:

1. `npx tsc --noEmit` · `npx vitest run` · `npx electron-vite build` clean.
2. All **seven** fidelity scenarios GREEN (port 8817 required — serialize per
   HANDOFF). If any pre-existing scenario's diff/resync counts move, the
   movement must be explained by the expansion mechanism (a bigger diff
   tripping the size governor earlier) line-by-line before any `expect` block
   is re-pinned; an unexplained movement is a stop.
3. `npm run bench:task -- --selftest` (owns 8817): `catalog-revive` still
   passes (its ≤ 4-item filtered sets mean expansion changes nothing);
   `vault-code`'s forced mid-run resync still fires. G15a/b still pass (the
   prepend restatement is now fuller; `restated >= 6` still holds).
4. `node bench/size.mjs --dry` then `--selftest` (8817): P5's cross-tier
   diff-stream invariance must hold — padding never enters a diff, so
   expansion cannot touch it; a P5 red means the padding leaked and the sweep
   fixtures are wrong, not this change.
5. `git diff` empty on `diff.ts` and `registry.ts` (§0.1).

---

## 3. Defect 3 — the update line grows its disambiguator (Bundle A, commit 2)

### 3.1 What is broken, sharpened beyond the HANDOFF's statement

`renderOp`'s `update` case (render.ts 383/385) pushes both a name delta and a
text delta as **bare quoted strings**. The shared mechanical reader resolves
the ambiguity by convention — "first remaining quoted string is the new name"
(streamModel.mjs 234–236) — and any model reading the legend faces the same
guess. Two probed consequences `[PROBED]`:

- **Corruption, not just ambiguity.** A text-only delta on an element whose
  accessible name did not change (`<button aria-label="Close">×</button>`,
  page swaps `×` → `✕`) emits `~ e1 "✕"`. The reader — and by the same
  convention, the model — overwrites the *label* with `✕`. The element's name
  is still `Close`; the belief is now wrong, and nothing downstream ever
  contradicts it. HANDOFF's "harmless today because name and text co-change
  for the nodes that emit it" is the common case, not the contract: walker.ts
  sets `node.text` from `directText` (line 229) on ANY element with direct
  text, and `propDelta` compares `text` for every node — name and text
  diverge whenever the accessible name comes from aria-* or from descendant
  elements.
- **Duplication on the commonest update.** A plain button label change
  (`<button>Save</button>` → `Saved`) changes name AND text and emits
  `~ e1 "Saved" "Saved"` — two identical strings, the second of which the
  reader discards.

### 3.2 The call — one token, role logic in the reader, dedupe in the renderer

**Wire rule after this commit:** on a `~` line, a bare quoted string is
always and only **the new accessible name**; the element's inner text change
is spelled **`text "…"`**. Value keeps `=`, href keeps `href=`, rows keep
`RxC:` — the update line's grammar becomes fully prefix-disambiguated.

Renderer (`renderOp`, update case):

- If `delta.text` is present and `delta.name` is present and
  `delta.text[1] === delta.name[1]`: **emit the name only** (the dedupe —
  the model holds one displayed string per line; identical bytes twice buy
  nothing).
- Otherwise, when `delta.text` is present, push `` `text ${quote(delta.text[1])}` ``.
- Emission order stays name · value · text · href · states — order is no
  longer load-bearing, but stable order keeps every archived transcript
  diffable against the grammar.
- No registry lookup, no role logic in the renderer — the token is uniform.

Reader (`applyObservation`, streamModel.mjs): replace the current sequence of
regex excisions over `rest` with **one left-to-right escape-aware scan** that
tokenizes the tail into: `href=<nonspace>`, `RxC:` tail, quoted strings each
tagged with their immediate prefix (`=`, the bare word `text`, or none), and
state words. Application rules:

- prefix `=` → `entry.value`.
- no prefix → `entry.label` (name change).
- prefix `text` → `entry.label` **iff `entry.role === 'text'`** (the displayed
  string of a text line IS its text); otherwise recorded on `entry.text` and
  not compared (a full snapshot cannot verify it — same posture as today,
  now without the misapply).
- State-word loop unchanged, still after all quoted content is consumed, so
  quoted page text can still never inject state flags.

WHY a scanner and not another regex pass: the excision approach is exactly
what made the current misparse possible, and a name whose *content* ends in
`text ` (e.g. label `"x text "` followed by a real `text "T"` token) defeats
any single-pass regex — the scanner reads quoted strings as units and looks
at the token before each, which is unambiguous by construction. That
adversarial row goes in the tests below.

Legend (`FORMAT_LEGEND`, tools.ts ~88 — the once-per-session teaching):

```
  ~ eN "..."        the element's accessible name changed
  ~ eN text "..."   its inner text changed; the name did NOT — do not update
                    the label you hold for it
```

### 3.3 Files, tests, RED-first

| file | change |
|---|---|
| `src/core/snapshot/render.ts` | Update case: dedupe + `text` token. |
| `bench/lib/streamModel.mjs` | The tokenizing scanner + application rules. **Watched file** — severance noted in §8. |
| `src/mcp/tools.ts` | Two legend lines. |
| `test/snapshot.test.ts` | Renderer rows: text-only delta on a button emits `~ eN text "✕"` and no bare string; co-change dedupe emits exactly one bare string; name+text both changed and different emits `~ eN "N" text "T"`; text-role node's text change emits `text "…"` (uniform token, no special case). |
| `test/benchStream.test.ts` | Reader rows: bare string still updates label; `text "…"` on a non-text entry does NOT touch label; `text "…"` on a `role: 'text'` entry DOES; the adversarial `"x text " text "T"` line parses as label=`x text `, text=`T`; quoted content containing ` +checked` still injects no state. |
| `docs/HANDOFF.md` | Defect 3 entry replaced (§7). |

RED-first is already half-done: the reader row "text-only delta must not
touch the label" **fails against HEAD** (the probe measured the misapply);
write it first, watch it fail, then land renderer+reader together. Renderer
and reader are **one commit** — they are two ends of one wire and a split
landing leaves the suite red or, worse, green with a stale reader.

Sabotage rows (scenario-level guard is the existing fidelity battery plus the
new unit rows): (1) author's — drop the `text` prefix from the renderer only:
the reader rows go RED. (2) non-author's, from the class "the reader
re-acquires a default that misapplies" — candidate space: make the scanner
fall back to bare-string semantics on an unknown prefix; reorder scanning so
`=` strings are consumed after bare ones.

Consumers audited for this wire change, so nobody re-discovers them mid-land:
`bench/lib/streamModel.mjs` (this spec), `test/benchStream.test.ts` (this
spec), `bench/headtohead/lib/ariaModel.mjs` — **no change**: it parses
Playwright ARIA snapshots, not this wire; the h2h aperture arms consume the
stream through the same shared streamModel. `bench/tokens.mjs` emits
synthetic `~` lines for the cost model — unchanged lines still parse (bare
string = name), fine as-is. Archived transcripts in RESULTS.md/docs are
history and are not edited.

Acceptance: battery as §2.5 items 1–2 and 5 (this commit rides Bundle A's
runs); `npm run bench` (the synthetic diff model) still runs.

---

## 4. Defect 4 — `inert`, `pointer-events: none`, small modal dialogs (Bundle B)

### 4.1 What is broken, re-verified at `a9e39d8`

- `statesOf` (walker.ts 602) consults `:disabled` (+`aria-disabled`) only —
  no inert, no pointer-events.
- The `select` handler (page.ts 890) refuses on `isDisabled` only; it writes
  through the DOM and dispatches `change` itself, so nothing else stops it —
  a `<select>` inside `[inert]` is writable by `action:"select"` (no
  coordinates, so the hit-test cannot protect it).
- `resolveRef`'s hit-test (page.ts 599) catches a covering overlay only. A
  `pointer-events: none` target hit-tests to whatever is beneath it and the
  error names the innocent bystander (tools.ts 1495's obstruction prose). A
  control in the inert background of a **small** `dialog.showModal()` is
  clickable whenever the dialog does not cover its point — `findModal`
  (walker.ts 823) only *reports* a `modalKey`, only for overlays > 15% of the
  viewport, and blocks nothing.
- The `type` path acquires focus by CDP click (tools.ts 1711: `click` →
  `clearField` → `typeText`), so a no-pointer textbox mechanically cannot be
  focused, and today the failure is misreported as an obstruction.

Every case is the agent acting where a human demonstrably cannot. tier2 §5 is
the ruled design; this section is that design updated to HEAD, with the guard
IDs renumbered (tier2's G13–G15 are long since taken — guards.mjs is at G33)
and one addition (the vault fill preflight).

### 4.2 The calls — three facts, three treatments (tier2 §5, reaffirmed)

1. **`[inert]`: rendered per element AND enforced.** New state bit
   `State.Inert = 2048`, word `inert`, set for every rendered element whose
   self or ancestor (through shadow boundaries — the walker already recurses
   the composed tree via `childSource`) carries the `inert` attribute.
   Computed by threading an inherited boolean down `visit()`'s recursion —
   O(1) per node, never `closest()` per node. Rendered because inert regions
   are typically small deliberately-marked panels, so the token cost is
   local; a page flipping inert on a large region produces a large diff and
   the size governor resyncs, which is the correct outcome.
2. **Open modal `<dialog>`: enforced, NOT rendered per element.** One
   `document.querySelector('dialog:modal')` at resolve time; an element
   outside the open dialog's composed subtree is refused with reason
   `modal`. Not a per-element state word — a dialog open/close would restate
   `+inert` across the page twice per dialog for information the dialog's own
   subtree add/remove already carries. `aria-modal="true"` div overlays stay
   deliberately un-enforced this way: aria-modal is advisory, the platform
   does not make the background inert, so the hit-test remains the only
   honest gate there — covered-point case only, as today.
3. **`pointer-events: none`: rendered on addressable elements, enforced on
   pointer paths.** New state bit `State.NoPointer = 4096`, word
   `no-pointer`, set when computed `pointer-events` is `none` AND the role is
   in `ADDRESSABLE` (walker.ts 90). The role gate exists because decorative
   overlays carry `pointer-events:none` constantly; the agent needs the word
   only on things it might act on. Zero extra style cost: `isRendered`
   (walker.ts 668) already pays one `getComputedStyle` per element — refactor
   `visit()` to compute the `CSSStyleDeclaration` once and pass it to both
   `isRendered` and `statesOf`; read `.pointerEvents` from it (it inherits,
   so the computed value handles ancestors). (`isScrollable`'s separate call
   is out of scope.)

**Preload:** the `aperture:resolve` reply gains
`blocked: 'inert' | 'modal' | 'no-pointer' | null` — first match in that
order, all three computed in the preload where the live element is:
inert = walk the `parentNode`/`host` chain checking `hasAttribute('inert')`
(the same composed-tree ascent as `composedContains`, page.ts 745 — `closest`
does not cross shadow boundaries); modal = `document.querySelector('dialog:modal')`
exists and does not composed-contain the element (wrap the selector in
try/catch; a throwing selector engine means "no modal", the same
page-cannot-break-the-walk posture as `isDisabled`); no-pointer =
`getComputedStyle(el).pointerEvents === 'none'`.

**tools.ts policy** — the `blocked` branch goes **before** the `r.obstructed`
branch (order is the point: a no-pointer target also hit-tests obstructed,
and the error must name the real reason, not the bystander):

| action | inert | modal | no-pointer |
|---|---|---|---|
| click / hover / clear / type / element-scroll | refuse | refuse | refuse |
| select | refuse | refuse | **allow** |

The one asymmetry, verbatim from tier2 §5 because it is load-bearing:
`pointer-events` blocks pointer input only — a human Tabs to such a select
and changes it with the keyboard, and `select` is already the no-coordinates
state-mutation path; refusing it would make the agent *weaker* than a human,
the inverse failure. `type` refuses because the focus-by-click above cannot
reach it, and the error must say so.

Error prose — fixed strings, no page bytes, outside the envelope, no
redaction needed:

- `error: ${ref} is inside an inert region — the page has disabled it; a human cannot interact with it either.`
- `error: ${ref} is behind an open modal dialog — interact with the dialog first.`
- `error: ${ref} does not receive pointer input (pointer-events: none) — a pointer action cannot reach it.`

**Belt and braces**, the shape the disabled fix already uses (page.ts 902):
the `aperture:select` handler itself also refuses inert and modal (fixed
tokens `inert` / `modal`), so the invariant holds even if a future caller
skips the resolve gate. tools.ts's select failure `switch` gains the two
cases with the same prose.

**Fill-path ride-along:** `fillReady` (page.ts ~547) already refuses on
`isDisabled(input) || input.readOnly` under the rule "a human could not do it
either" — an inert ancestor is the same rule and today slips through. Add the
composed-tree inert ascent to that predicate, returning the existing
`'not-editable'` token (no new deny vocabulary). Unit row beside the existing
`fillReady` rows (jsdom handles attribute ascent fine). This is two lines and
one test row; if the vault/security sibling objects on ownership, it splits
out cleanly — flag it in the PR rather than dropping it silently.

**Stale-preload tolerance:** `Resolved` in act.ts gains optional
`blocked?: …`. Absence (an old preload artifact) means **no gating** — the
same fail-open-with-named-precedent as the `rect` fields (act.ts 52–63), and
guards.mjs's stale-build refusal is what actually protects a guard run.

### 4.3 Files

| file | change |
|---|---|
| `src/core/snapshot/types.ts` | `Inert: 2048`, `NoPointer: 4096`; STATE_NAMES gains `['inert']`, `['no-pointer']` (appended — existing word order is pinned by tests). |
| `src/core/snapshot/walker.ts` | Inherited-inert threading through `visit`; one-`getComputedStyle` refactor; role-gated NoPointer in `statesOf` (signature grows: role + cs + inheritedInert — `statesOf` has exactly one caller, visit line 222). |
| `src/preload/page.ts` | `blocked` in the resolve reply; select-handler inert/modal refusals; `fillReady` inert ascent; the shared composed-tree inert helper. |
| `src/mcp/tools.ts` | The policy branch before `r.obstructed`; two select-switch cases; three prose strings; legend state-word line gains `inert no-pointer`. |
| `src/core/snapshot/act.ts` | `blocked?` on `Resolved`. |
| `bench/lib/streamModel.mjs` | `STATE_WORDS` gains `inert`, `no-pointer` — **without this the reader cannot see the new words and both sides drop them equally**, the exact "benchmark that cannot see a field" failure the method section exists for. One `benchStream.test.ts` row proving a `+inert` op lands in the entry's state set. |
| `test/fixtures/unreachable.html` | New fixture (NOT `inert.html` — that name is taken by the G19k security fixture and must not grow script). Sections: an `[inert]` panel holding a select + button, a twin non-inert control section, a `pointer-events:none` button + select (style-sheet class, not inline — closer to the real web), a small `<dialog>` with an open/close button and an in-dialog button, background buttons beside where the dialog renders. Deterministic, `data-bench` witness wiring like the other guard fixtures. |
| `bench/guards.mjs` | G34–G36 below. guards.mjs is outside the watched set, so guard-only edits sever nothing. |
| `test/` unit rows | Walker bit-setting where jsdom allows; jsdom's computed `pointer-events` and `dialog:modal` are NOT trusted — the guards are the verification of record (house rule, stated so the implementer leans on G34–G36, not vitest). |
| `docs/design/g34-36-red-record.md` | The RED record, §4.5. |

### 4.4 Guards (default/allow phase; no seed flags needed)

- **G34 inert** — a: `select` on the inert-panel select → refused with the
  inert wording, collector silent; b: control — the twin non-inert select →
  succeeds, collector records the change; c: the inert select's snapshot line
  carries `inert`; d: `click` on the inert-panel button → refused, collector
  silent.
- **G35 no-pointer** — a: `click` on the no-pointer button → refused with the
  no-pointer wording AND the reply does **not** match `/is covered by/` (the
  misnamed-bystander regression is the thing this guard pins); b: `select` on
  the no-pointer select → **succeeds** and the collector records the change
  (the asymmetry is load-bearing; test it); c: the button's line carries
  `no-pointer`.
- **G36 small modal** — a: dialog open, `click` a background button beside
  (not under) it → refused with the modal wording, collector silent; b:
  `click` the button **inside** the dialog → succeeds (over-blocking guard);
  c: control — dialog closed → the background click succeeds.

### 4.5 RED-first and sabotage

Run G34–G36 against the **unfixed** HEAD build before landing anything:
expected reds are G34a (select commits today), G34d (click lands), G35a
(obstruction prose naming the bystander), G36a (click lands). G35b is green
before and after — it pins kept behavior, and that is fine; not every leg red.
Record the run in `docs/design/g34-36-red-record.md` in the
`g14-red-record.md` shape: HEAD, `out/` artifact SHA-256s and timestamps, the
verbatim failing output per leg. A guard that has only ever passed is a guard
of unknown value.

Two sabotage rows per guard, one picked by someone other than the guard's
author (security.md third clause, now house standard). The author's rows:
remove the inert ascent from the resolve reply (G34a/d red); reorder the
`blocked` branch after `r.obstructed` (G35a red); gate the dialog check on
`findModal`'s >15%-area rule (G36a red — the small dialog is precisely what
that rule skips). The non-author rows come from the class, not this list;
candidate space to hand them: inert set dynamically after first walk; inert
crossing a shadow boundary; `pointer-events:none` via a class toggled at
runtime; a second stacked modal; the dialog moved so it DOES cover the
background button (G36a's refusal must then still name modal, not
obstruction).

### 4.6 Acceptance

1. Battery: `npx tsc --noEmit` · `npx vitest run` · `npx electron-vite build`.
2. `bench/guards.mjs --phase=allow` fully green **including G30/G33 blocks**
   (seed flags per HANDOFF), on a fresh build — the stale-build refusal must
   see `out/` newer than `src/`.
3. All seven fidelity scenarios green (no scenario raises a modal today; the
   obstruction gate's only exerciser remains `bench:guards` — G36 narrows
   that standing gap but a fidelity modal scenario stays not-built, listed in
   §7's residuals).
4. `git diff` empty on `diff.ts` / `registry.ts`.
5. Churn note, checked once: `unreachable.html`'s no-pointer class toggle must
   not oscillate — Inert/NoPointer transitions are diffed (only Offscreen is
   masked in `propDelta`), volatility suppression does not apply to state
   changes, and the backstop is the size governor. State this in the fixture
   comment.

---

## 5. Defect 1 — `identity_mismatch`: the claim retires, the bucket stays

### 5.1 The triage, with the two facts that decide it

**The precision primary never consulted this detector.** Verified:
`h2h.mjs:352` computes `wrongElement` directly from witness-landed actions
against the task's allowed set —
`actions.filter((a) => !task.allowed.includes(a.detail?.bench))` — page
ground truth, not labels. That is the instrument that caught the 27 landed
wrong-row clicks pre-tier5 and the 0 post-tier5. Nothing about the crown
jewel changes whatever happens to `identity_mismatch`.

**The bucket has a real, smaller domain.** `bench/tasks.mjs` ~331 records T2
as the first fixture where it is *reachable* — a stale ref crossing families
lands on a differently-labelled button and `labelsAgree` fails. Within an
identical-label family it cannot fire by construction (`labelsAgree`,
bench/lib/proxy.mjs 166: containment either way — "Archive" vs "Archive"
agrees). And the residual engine-fault route that still exists — P2
equal-size same-walk churn — is undetectable **in principle** at the key
level (tier4 §1.4), so no repaired label detector could see it either; a
"repaired" `identity_mismatch` would still carry a zero that means nothing on
the fixtures that matter.

Repair would require the stream (or the shadow model) to carry page-side
ground-truth identity for what each ref pointed at when read — exactly the
information the product deliberately withholds from the wire and the shim
rules keep out of the arms. There is no honest repair. There is also no case
for deletion: it would sever stores (proxy.mjs is watched), break the
`benchAttribution.test.ts` pins, and remove the one bucket that separates
"engine resolved to a differently-labelled element" from `wrong_choice` on
the fixtures where labels differ.

**Decision: keep the bucket, retire the detector claim, document the domain.**
The ban on citing the zero (already HANDOFF rule) becomes a documented
property instead of tribal knowledge.

### 5.2 The edits

1. **`docs/design/headtohead.md`, attribution-vocabulary block (§5, the
   `wrong_choice`/`identity_mismatch` list at ~line 561–564)** — this is the
   "§5.2 vocabulary note" owed since h2h-evaluation §8.6 and carried in
   HANDOFF Still-owed #9. Insert:

   > `identity_mismatch` is a **label-divergence tripwire, not a rebind
   > detector**. It compares page-reported label to shadow-model label
   > (`labelsAgree`), so it is unreachable by construction wherever the rows
   > are identical by design — which is every fixture built to stress
   > positional rebinding. On those fixtures a rebound ref that LANDS is
   > counted in `wrong_choice`, and a zero in this column is a statement about
   > label diversity, never about the hazard. Do not cite the zero, in either
   > direction. The rebind hazard's detectors of record are `wrong_choice`
   > (page ground truth, `allowed`-set) and the refused-stale counts;
   > post-tier5 the engine retires positional families on membership change,
   > so the landing route is closed and measured closed
   > (h2h-post-tier5-evaluation §2). The residual P2 same-size churn route is
   > undetectable in principle at the key level (tier4 §1.4) and is not
   > claimed to be covered by anything.

2. **`bench/lib/proxy.mjs`** — fold the same statement (three sentences) into
   the `attributeAct`/`labelsAgree` doc comments. **Watched file: this edit
   rides the sibling harness bundle** (Still-owed #4–#7), never its own
   severance event; tier2 §8.2's proxy.mjs hygiene comment rides the same
   commit. If the harness sibling's spec already carries obligation #9's
   note, theirs wins and this item collapses to a cross-reference.

3. **`docs/HANDOFF.md`** — defect 1's entry moves to closed (§7 text below).

No code changes. No renames. `benchAttribution.test.ts` untouched.

---

## 6. Defect 5 — W1 residuals: closed as designed, with the honest arithmetic

### 6.1 What stands, verified at HEAD

Both residuals are contract lines, not oversights, and both are already
instrumented:

- **`unknown` never fails an act** (act.ts 98–103, 267: `UNKNOWN_WITNESS`
  falls through to `observe`). Rationale recorded where it is enforced: "a
  mechanism that turns its own unavailability into an error would invent
  failures" — the Gate-2 lesson (a suppressing-but-alive page must not read
  as a dead browser) made structural.
- **A page that self-navigates on a timer during settle yields `unknown` per
  act** (act.ts 345–358: a `docToken` mismatch resolves `unknown`
  immediately, because the token proves the document changed, not that this
  act's input arrived). A wedge on that page class is therefore invisible to
  W1 — and, verified in the same function, a wedge on a *non*-navigating page
  cannot escape through this door: a wedged tab delivers no input, nothing
  navigates, the token still matches and the counters stay frozen through the
  2500ms re-poll → `lost`.

The instrument that watches the watcher exists: `witnessTally()` served on
`/metrics` (server.ts 95–105, event tallies only), summed per instance in the
task report with the >10% advisory (tier4 §6.3; task.mjs
`printWitnessSummary`).

### 6.2 Strengthenings considered, each rejected on the record

- *Escalate N consecutive `unknown`s to an error*: converts a dead poll
  channel or a navigating fixture — apparatus states — into invented act
  failures; precisely the false-alarm class W1's redesign paid to remove.
- *Distinguish timer-navigation from input-navigation*: not derivable from
  the recorder's counters; the input either arrived in a document that no
  longer exists or never arrived, and no post-hoc poll can tell.
- *A self-navigating liveness canary*: a canary on such a fixture receives
  `unknown` whether the input path is healthy or wedged — it cannot
  discriminate, which is the in-principle blindness restated, not covered.

What actually covers the navigating-page class is fixture-side ground truth —
the bench collector's witness events, which is why the scored suites can see
a wedge there and production cannot. That asymmetry is the residual.

### 6.3 The arithmetic, stated honestly

No scored store carries the tallies: verified by reading both stores — 0 of
385 h2h episodes and 0 of 230 task episodes have a witness field (both
cohorts predate the tier4 §6.3 stamp). So the >10% advisory has **never seen
production data**, and the first post-tier6 cohort will be its first live
reading. The closure must say this rather than imply the advisory has been
exercised: the advisory's own discrimination is currently backed by its
`benchReport.test.ts` console-capture row only.

### 6.4 The edits

`docs/HANDOFF.md` defect 5 → closed (§7 text). The loose thread stays: the
once-in-~450-acts `ok click e6` ghost remains on the books, W1 remains the
mechanism that would catch a recurrence, nothing has re-observed it. No code
changes.

---

## 7. HANDOFF replacement text

Implementers replace "Open defects" items 1–5 with the following (item
numbering in HANDOFF may be re-flowed; keep the evidence pointers):

1. **`identity_mismatch` — CLOSED (documented domain, claim retired,
   tier6 §5).** A label-divergence tripwire, unreachable on identical-label
   rows by construction; the rebind hazard's detectors of record are
   `wrong_choice` and refused-stale counts; the zero is never citable. The
   vocabulary note lives in headtohead.md §5 (obligation #9 discharged); the
   proxy.mjs docstring rides the next harness bundle.
2. **Replace-op elision — FIXED (tier6 §2).** `add`/`replace` subtrees render
   expanded; the changed-survivor case is pinned by a unit row and the
   `filterlist` fidelity scenario, both shown RED against the pre-fix build.
3. **`~ eN "A"` ambiguity — FIXED (tier6 §3).** Bare quoted string = name
   change, `text "…"` = inner-text change, duplicates deduped; the reader
   parses by prefix, and the misapply (a text delta corrupting the held
   label) is pinned RED-first in benchStream tests.
4. **`inert` / `pointer-events` / small modals — FIXED (tier6 §4).** Rendered
   `inert`/`no-pointer` state words; per-action refusal matrix (select allows
   no-pointer, the keyboard asymmetry); small-modal background refusals;
   guards G34–G36 with red records in g34-36-red-record.md.
5. **W1 residuals — CLOSED AS DESIGNED (tier6 §6).** `unknown` falls through
   by contract; self-navigating pages are invisible to W1 in principle and
   covered only bench-side by the collector; the /metrics tallies + >10%
   advisory are the production surface and have never yet seen a scored
   cohort. Strengthenings considered and rejected on the record.

Also: RESULTS.md gains the `filterlist` row (§2.4) and nothing else — no
economics or precision sentence changes anywhere (§0.1).

---

## 8. Implementation order, atomicity, ownership, severance

### 8.1 Order

1. **Bundle A, commit 1** — §2 expand + unit rows + `filterlist` fixture +
   scenario (+ RESULTS.md row). RED runs recorded before the flip.
2. **Bundle A, commit 2** — §3 renderer + reader + legend + tests. One
   commit; RED reader row first.
3. **Bundle A battery** — §2.5 items 1–5 (needs 8817 for fidelity/selftest;
   serialize with siblings).
4. **Bundle B** — §4, ordered inside: types/walker → preload → tools →
   guards+fixture. RED guard run against the pre-B build first (it needs
   Bundle A's build only for final green, not for the reds — run reds against
   HEAD+A). Then §4.6 battery.
5. **Closures** — §5 doc edits and §6/§7 HANDOFF edits, any time; the
   proxy.mjs docstring **waits for the sibling harness bundle**.
6. `SUITE_VERSION` bump to the landing date with the last code bundle (house
   rule, tier2 §9.12).

### 8.2 What lands atomically with what

- §3 renderer + streamModel reader + benchStream tests: **one commit** (two
  ends of one wire).
- §2 literals + unit row (d) + `filterlist` scenario: one commit, so the tree
  never holds a fixture that fails CI.
- §4 types+walker+preload+tools: may be one commit or ordered commits, but
  **no scored run and no guard-green claim between them** — a build with the
  state words but not the refusals would pass G34c while G34a is red, and a
  half-landed B is the only state in this spec that can look healthier than
  HEAD while being worse.
- Guards + fixture + red-record: land with (or immediately after) the code
  they guard, never before.

### 8.3 Ownership partition (files this spec's implementers may touch)

`src/core/snapshot/{render,walker,types}.ts` · `src/preload/page.ts` ·
`src/core/snapshot/act.ts` (one optional field) · `src/mcp/tools.ts` (act
path + legend only) · `bench/lib/streamModel.mjs` · `bench/fidelity.mjs` +
`bench/fidelity-all.sh` · `bench/guards.mjs` (new blocks only) ·
`test/fixtures/{filterlist,unreachable}.html` ·
`test/{snapshot,benchStream,act,fillpaths}.test.ts` (additive rows) ·
`docs/design/{tier6.md,g34-36-red-record.md}` · `docs/HANDOFF.md` (items 1–5
only) · `docs/design/headtohead.md` (the §5 vocabulary note only) ·
`bench/RESULTS.md` (fidelity row only).

**Seams with sibling workstreams, do not cross:** `bench/lib/proxy.mjs` and
everything in Still-owed #4–#8/#10 (harness workstream — hand them §5.2's
docstring text and tier2 §8.2); security classes C/D, vault/consent flows and
`security.md` (security workstream — the `fillReady` ride-along in §4.2 is
the one brush against their surface and is flagged as severable);
`src/core/snapshot/{diff,registry,engine}.ts` (nobody's — §0.1 forbids it
here, and engine.ts's tier2 §8.1 hygiene comment explicitly does NOT ride
these bundles since none touches engine.ts).

### 8.4 Severance, stated so nobody is surprised

Both bundles rebuild `out/` and touch watched sources, so each severs the
task store's cohort identity; the next scored run of anything is
`--new-cohort` regardless (the tree has moved since wave 3 anyway, and the
unblocked account-prefs fix is queued for the same event). `bench/guards.mjs`
and `bench/size/**` are outside the watched set; doc edits are unwatched.
Neither h2h store is affected — both are closed, archived, never re-scored.

---

## 9. Verification battery (the union, run at the end of each bundle)

`npx tsc --noEmit` · `npx vitest run` · `npx electron-vite build` ·
`bash bench/fidelity-all.sh` (7/7) · `node bench/guards.mjs <tok>
--phase=allow` with the §4.6 seed flags (all blocks incl. G30/G33, plus
G34–G36 after Bundle B) · `npm run bench` · `npm run bench:task -- --selftest`
· `node bench/size.mjs --dry && node bench/size.mjs --selftest` ·
`git diff --stat` shows no `diff.ts`/`registry.ts`/`engine.ts` change.
Port 8817 is contended while sibling workstreams run — check before every
live step and serialize; guards refuse a stale build on their own.

---

## 10. Verified vs. not verifiable from here

**Verified by reading at `a9e39d8`** (cited inline): the two `expand: false`
sites and the marks/commit/dry plumbing; `walk()`'s early return on every
replace escalation; `runOwesReannounce`/`needsReannounce` covering revived
refs only; the size governor (`DIFF_SIZE_RATIO` 0.3, dry render at engine.ts
370–375); `statesOf` consulting `:disabled` only; the select handler's
`isDisabled`-only refusal; the resolve hit-test's shadow-descent and
obstruction reporting; the type path's focus-by-click (tools.ts 1711);
`findModal`'s report-only 15% rule; `isRendered`'s existing
`getComputedStyle`; free State bits 2048/4096; guard numbering through G33
(tier2's G13–G15 are taken; `inert.html` is a security fixture, name
unavailable); `wrongElement` computed from the allowed-set at h2h.mjs 352;
`labelsAgree` containment semantics; T2's cross-family reachability note;
W1's three modes, docToken rule, tallies, /metrics serving, and the >10%
advisory's existence; zero witness fields in either archived store (385 + 230
episodes checked by script); streamModel's first-bare-string-is-the-name rule
and its quoted-content state-injection strip.

**Verified by unit probe** `[PROBED]` (vitest against `src/`, no port): the
co-change duplication `~ e1 "Saved" "Saved"`; the text-only bare string
`~ e1 "✕"` and its misapplication risk; the changed-survivor-in-elided-tail
wire with `CHANGED` absent and the survivor's ref alive.

**Not verified, and the spec is built not to depend on it:** whether Chromium
hit-testing skips inert elements (enforcement is by explicit checks either
way); jsdom fidelity for computed `pointer-events` / `dialog:modal` /
inert-in-shadow (G34–G36 are the verification of record); `dialog:modal`
selector support in this Electron (assumed — Chromium has had `:modal` since
105 — and the preload wraps the query in try/catch so an unsupported selector
degrades to "no modal" rather than a broken resolve; G36 would then go red,
which is the correct discovery path); the economics expectation in §2.2
(expectation only, unmeasured until a cohort); whether the sibling harness
workstream has already claimed obligation #9's note (§5.2 defers if so); live
behavior of anything — no Aperture was launched for this spec.
