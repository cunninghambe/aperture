# Tier 2 designs — the deferred backlog, partitioned around the live wave

Architected 2026-08-01 against HEAD `f4cd2e2`, with the wave-2 task-success
cohort **running right now** (`bench/task.mjs --new-cohort --n 5`, to be
followed by `--n 20` pooling into the same cohort). Decision-complete: every
load-bearing call is made here with its reasoning; an implementer should not
need to choose anything, and a reviewer should be able to tell a deviation
from a decision. Everything below was written after reading the code at
`f4cd2e2`, not a paraphrase of it, and two corrections to the briefs this file
answers are load-bearing enough to lead with.

---

## 0. The partition, and two facts the brief had slightly wrong

### 0.1 What "watched" actually means (verified in `bench/lib/store.mjs`)

The cohort identity is TWO hashes, not one:

- **`codeVersion`** — `WATCH_DIRS`: `src/core/snapshot/*.ts`, `src/mcp/*.ts`,
  `src/preload/*.ts`, `bench/fixtures/*` (everything); plus `WATCH_FILES`:
  `bench/task.mjs`, `bench/tasks.mjs`, `bench/lib/proxy.mjs`,
  `bench/lib/collector.mjs`, `bench/lib/streamModel.mjs`, `bench/lib/stats.mjs`.
  The brief's "`bench/lib/*.mjs`" is an over-approximation: `store.mjs` is
  deliberately unwatched (it is the bookkeeping, and self-protecting — editing
  its watched-set definition moves every codeVersion it computes).
- **`buildVersion`** — `out/preload/*.cjs` and `out/main/index.js`.

The second hash is the sharper constraint, and the brief did not mention it:
`out/main/index.js` bundles the **entire main process**, so an edit to ANY
main-process source — `src/privacy`, `src/main`, a new `src/net` — followed by
a rebuild moves `buildVersion` and kills the cohort just as dead as editing the
walker. **The effective rule while the wave runs is therefore: no watched-file
edits AND no rebuild of `out/` at all.** Editing an unwatched source file
without rebuilding would not trip the guard, but it would also not be running,
and it leaves a mine in the tree; it is banned here for that reason.

Also live while the wave runs: ports **8817** (Aperture's MCP port, hardcoded
in `src/mcp/server.ts`), **8899** (fixtures), **8898** (collector), **8896**
(proxy). A second Aperture instance cannot even start (8817 bind fails), so
any probe that needs the real browser is port-gated behind the wave, even when
it edits nothing.

### 0.2 The three stages

The brief asks for two buckets. They are here, but LANDS AFTER splits into
run-only work (safe the moment `--n 20` exits, on the frozen tree) and edits
(which end the frozen tree). The ordering between those two halves is
load-bearing: **everything in stage B runs on the exact `codeVersion` +
`buildVersion` that wave 2 scored, so its numbers and wave 2's verdict describe
the same build.** Land one stage-C edit first and that property is
unrecoverable.

**Stage A — LANDS NOW** (no watched files, no rebuild, no ports
8817/8896/8898/8899):

| item | work |
|---|---|
| 6 (part) | Write both probe apps; **run** the content-protection probe and the standalone WebAuthn probe (self-contained Electron apps, no Aperture, no shared ports) |
| 7 (part) | Web Bot Auth: the strategy decision below, `docs/design/webbotauth.md`, and the external enrollment investigation |
| 4 (part) | `node bench/size.mjs --dry` (reads files, binds nothing, spends nothing) |
| — | Doc edits (`docs/**`, `bench/RESULTS.md` prose) are unwatched and safe, but batch them; the running phase appends only to `bench/task/results/` |

Courtesy rule, not a correctness rule: run the stage-A probes between scoring
phases if convenient — they cost a minute of CPU and the only episode field
they could perturb is `durationMs`, which is not a verdict input.

**Stage B — LANDS AFTER WAVE 2, run-only** (after `--n 20` exits; tree
untouched; ports free; serialize on 8817):

1. The Haiku sensitivity cohort **if** the tier1b §3 interim rule fired — it
   must run on the wave-2 tree, so it goes first.
2. Item 4: the size-sweep refusal-path exercise, then `--selftest`, then
   `--sweep` (§4).
3. Item 6: the in-Aperture WebAuthn confirmation (§6), if the standalone probe
   said yes.
4. Doc results: RESULTS.md size section, security.md queue updates.

**Stage C — LANDS AFTER WAVE 2, edits** (only after stage B is complete):
items 1, 2, 3, 5, 8, and 7's implementation half. These need NOT be one atomic
mega-commit — tier1b's one-bundle rule existed to minimize cohort-archive
events with a wave imminent, and after `--n 20` there is no live cohort to
protect. They are ordered commits (§9), with one hard constraint: **no scored
run starts until all of stage C has landed and the full verification battery
is green**, and the next scored run is `--new-cohort` with a `SUITE_VERSION`
bump to the landing date (e.g. `2026-08-08.1`).

An implementer acting on stage A needs nothing below except §6 and §7.

---

## 1. Expand `add`/`replace` op subtrees in diffs — DO IT (stage C)

### The call

`renderOp` in `src/core/snapshot/render.ts` flips `expand: false` to
`expand: true` at both subtree render sites — the `add` case (line 385) and
the `replace` case (line 406). Unconditional; no flag, no per-op heuristic.

### WHY, and why tier1b's dismissal was wrong

Tier1b §1 called this "surrendering the token saving that is the product's
reason to exist." That conflates two savings. The product's saving is **not
restating the unchanged remainder** of the page; collapsing inside an op's own
subtree saves nothing of the kind, because everything in an `add`/`replace`
subtree is content the model has by definition never seen. What collapse
buys there is deferral — and the deferred read costs strictly more: a full
extra turn, plus an `expand:true` full snapshot of the **whole page**, to
recover lines the diff could have carried for their own byte cost. Wave 1
showed the deferral being paid in practice (`finder-cheapest`: every voluntary
snapshot in the re-dump arm and most in the diff arm were this, per the
RESULTS.md correction), and tier1b's `catalog-revive` had to be *designed
around* the collapse (filtered sets kept ≤ 4 items) to avoid importing the
confound — a fixture bending around a product bug is the tell.

Three additional grounds, each verified in the code:

1. **The size governor already prices the worst case.** Diffs have no budget
   cut, but `observe()` (engine.ts) dry-renders the candidate and falls back
   to a full resync when it exceeds `max(60, 0.3 × lastFullLines)` lines — and
   the fallback full render is itself collapsed and budgeted. A 500-item
   `replace` cannot produce an unbounded diff; it produces a resync, exactly
   as today, only triggered slightly earlier.
2. **It closes the top-ranked open fidelity hole for free.** HANDOFF names
   "replace-op elision can hide a changed survivor" as the most plausible
   remaining fidelity gap: a surviving ref in the elided tail of a `replace`
   whose content changed in the same re-render goes stale with no
   re-announcement (`runOwesReannounce` covers revived refs, not changed
   ones). With `expand: true` there is no elided tail; the hole ceases to
   exist structurally.
3. **The `wasEmitted` bookkeeping needs no new mechanism.** `renderNode`
   already records emission marks per line; `renderDiff`'s commit/dry split
   already routes them (dry → throwaway array, commit → `markEmitted`).
   Expanded lines carry refs, so a commit render marks them emitted — which is
   **required**, not incidental: without it, later `~ eN` updates to those
   elements would be gated forever. The dry render must keep marking nothing;
   the existing `marks` indirection already guarantees that. No edit outside
   the two `expand` literals is needed for correctness.

Considered and rejected: an `expandOps` option (a knob nobody would ever set
to false — the collapsed form is strictly worse for novel content, and a
second rendering mode is a second thing every future audit must reason about);
expanding `add` but not `replace` (the fidelity hole lives in `replace`).

### How we know whether it paid

The size sweep does **not** measure this — its padding is static and appears
in zero diffs by design (P5 asserts it), so state that in the report rather
than pretending otherwise. The honest instruments are:

- **By construction:** whenever the agent would have needed the elided
  content, the expanded diff is cheaper than the collapsed diff plus the
  `expand:true` full-page snapshot plus a turn. The acceptance test below
  makes the arithmetic concrete on a real stream.
- **Wave-3 advisory metric (preregistered wording, not a verdict input):**
  diff-arm voluntary `expand:true` snapshots per episode — recorded per
  snapshot since tier1b (`{mode, expand}` as forwarded) — should fall to ~0 on
  filter/list tasks. If wave 3 reinstates `finder-cheapest` from the `RETIRED`
  export as an expansion probe, its wave-1 diff-arm baseline was 14 voluntary
  observations over 5 episodes.

### Files and functions

| file | change |
|---|---|
| `src/core/snapshot/render.ts` | The two `expand: false` → `expand: true` literals in `renderOp` (`add` ~385, `replace` ~406), with a comment stating the novel-content argument in one sentence. |
| `test/snapshot.test.ts` | (a) `renderDiff` of an `add` whose subtree holds 8 same-shape children renders 8 lines, no `… N more` marker; (b) same for `replace`; (c) commit render marks all subtree refs emitted, dry render marks none; (d) the changed-survivor case: a `replace` whose subtree tail contains a previously-emitted ref with changed text — the new text must appear in the rendered diff bytes (this is the regression test for the closed fidelity hole). |
| `bench/fidelity.mjs` + `test/fixtures/` | Extend the `rerender` scenario (or add a `filterlist` scenario) so a rebuild delivers a >5-item same-shape list via a `replace`: the mechanical reader must hold every item's ref and label with **zero** expand snapshots. Also assert the arithmetic: rendered-diff chars < (collapsed-diff chars + the `expand:true` full-snapshot chars for the same page), printed in the scenario output. |

The `… N more … — read eN` affordance disappears from diffs only; full
snapshots keep it and the tool-description legend stays accurate as written.

### Acceptance

1. `npx tsc --noEmit` · `npx vitest run` · `npx electron-vite build` clean.
2. All fidelity scenarios GREEN including the extended one; the
   changed-survivor unit test passes and fails on a revert of the two
   literals.
3. `npm run bench:task -- --selftest` on the wave-2 task set still passes —
   in particular `catalog-revive` (its ≤4-item design means expansion changes
   nothing there) and `vault-code`'s forced mid-run resync still fires.
4. `node bench/size.mjs --selftest` still green: P5's cross-tier diff-stream
   invariance must hold (padding never enters a diff, so expansion cannot
   touch it — if P5 breaks, the padding leaked and the sweep fixtures are
   wrong, not this change).

**Partition: LANDS AFTER WAVE 2 (stage C).** `render.ts` is in `codeVersion`
and `out/` in `buildVersion`.

---

## 2. `streamAssert` — sharpen it to the proof it claims to be (stage C)

### The call

Change the signature from `streamAssert(diffStream)` to
`streamAssert(diffStream, acts)`, where `acts` is the episode's recorded act
list (`r.acts` in G2 — each entry already carries `.ref`, the ref the solver
actually clicked, recorded by the proxy). Rewrite `queue-positional`'s
assertion to discriminate positional from content-based keying.

### WHY

The current check (`bench/tasks.mjs` ~242: first post-removal diff names ≥ 2
destructive refs) is a liveness check wearing a proof's clothing. A row
carries two buttons, so removing it retires two refs **whichever way it is
keyed**: under positional keying the *last* row's keys die; under content
keying the *clicked* row's keys die. Both satisfy `refs.size >= 2`, so the
check cannot detect the one failure it exists for — the fixture silently
acquiring content-based identity and no longer testing L1. The code's own
comment ("under ordinal keying the row that dies is the LAST one, never the
row that was clicked") states the discriminator and then doesn't check it.
The discriminator needs the clicked ref, hence the signature change. Keep it
rather than kill it: the sharp version is ~10 lines and G2 runs it for free,
and `queue-positional` is the only fixture in the suite whose entire value
depends on a walker behavior nobody can verify by reading the walker.

### Exact contract

In `bench/task.mjs` `guardG2`, the call becomes
`task.streamAssert(r.diffStream, r.acts)`. In `bench/tasks.mjs`,
`queue-positional`'s assertion becomes:

```
for k of [0, 1]:                          // the two Reject removals
  block  = observationBlocks(stream)[k]   // missing block → fail, say which
  refs   = destructiveRefs(block)
  clicked = acts[k]?.ref                  // missing/null → fail, say which
  if refs.size < 2   → fail: "removal k retired {n} ref(s); a row is two
                       buttons, so <2 means no whole-row retirement happened"
  if refs.has(clicked) → fail: "removal k retired the ref the solver CLICKED
                       ({clicked}). Under positional keying the clicked row's
                       key survives (rebound to the row that slid up) and the
                       LAST row's keys die; retiring the clicked ref means the
                       rows are content-keyed and this fixture is not testing
                       the stale-ref trap"
```

Why this is sound (walked through, not assumed): the solver's first two acts
are `Reject nth:5` then `Reject nth:2`. Under ordinal keying, removing a row
re-keys every identical row below it onto the vacated ordinals — same content
⇒ same identity key ⇒ the ref survives, bound to a **different** element —
and the key that ceases to exist is the last row's, so the retired refs are
the last row's two buttons, never the clicked one. Under content keying the
clicked row's own key dies. `destructiveRefs` includes `~` update ops; the
only update in these diffs is the pending-count text node, which has its own
ref, so no false positive from that. The scripted solver never snapshots
voluntarily, so block *k* pairs with act *k* (the opening full is excluded
from `diffStream` by construction).

Update the `streamAssert` field doc-comment in `bench/tasks.mjs` and the
companion comment in `task.mjs` to describe the two-argument form.

### Acceptance

1. `npm run bench:task -- --selftest`: `queue-positional` G2 passes with the
   sharpened assertion.
2. Sabotage check, run once and recorded in the commit message: give the
   queue rows distinguishing content (e.g. append the row index to the row
   text in a scratch copy of `queue.html`) and confirm the assertion now
   FAILS on the `refs.has(clicked)` branch — the proof must be able to say
   no.

**Partition: LANDS AFTER WAVE 2 (stage C).** Both files are in `codeVersion`.
(The assertion only runs in unscored G2, but the hash does not care.)

---

## 3. Preload reason strings — narrow to a fixed vocabulary (stage C)

### The correction first

`security.md` records four `err.message` interpolation sites in
`src/preload/page.ts`. There are **five** — the `select` handler landed after
that audit. Verified at `f4cd2e2`: walk (line 48), fill (100), resolve (168),
read (208), select (388). The doc's residual paragraph must be corrected when
this lands, and the count is why this item is worth doing at all: the
"guaranteed by isolated-world builtins" argument has to be re-made every time
a handler is added, which is exactly what the doc means by calling it the
weaker of the two guarantees. A construction does not need re-making.

### The call

Every `catch` site in `page.ts` replies with the fixed token
`reason: 'exception'` plus `detail: <err.message, sliced to 200 chars>`. The
`detail` field is **logged and dropped in the main process** — it never enters
any tool-result text. All rendered error prose is built exclusively from the
closed vocabulary.

- The vocabulary, in full (all existing tokens plus one):
  `gone · not-visible · not-a-select · select-disabled · blank-query · empty ·
  ambiguous · no-match · disabled · no-setter · exception`, plus the
  main-process timeout literals (`walk timed out`, `read timed out`,
  `select timed out`, `fill timed out`) and item 5's additions
  (`inert · modal · no-pointer`, §5). One new token, not five
  (`walk-exception`, `fill-exception`, …), because the tool layer already
  knows which operation it called — the operation name in the token would be
  redundant bytes on the wire.
- WHY detail is kept at all: a vocabulary-only reply turns every preload bug
  into an undiagnosable shrug. WHY it is quarantined in the main process:
  the boundary belongs at the IPC edge, enforced once, rather than at N
  render sites in `tools.ts` that multiply over time — the select handler is
  the proof that render sites multiply.
- Uniformity beats the one "harmless" exception: the walk-failure reason lands
  inside the envelope and could keep interpolating, but a conditional rule is
  a special case every future audit must reason about (the same argument that
  kept the unchanged-response inside the envelope in tier1b §1). All five
  sites get the same treatment. The walk failure renders as
  `could not read the page (exception)`; the human debugging it reads the
  detail in the main-process log.

### Files and functions

| file | change |
|---|---|
| `src/preload/page.ts` | A single helper `failure(err): { reason: 'exception'; detail: string }` (message extraction + 200-char slice + control-char strip via the existing `quote` machinery from `@core/snapshot/text.js`); all five catch sites call it. Grep-level invariant: `reason: err` appears nowhere in the file. |
| `src/core/snapshot/engine.ts` | `WalkPayload` (and the read/select/fill result types) gain optional `detail`; every `pending`-resolution consumer logs `detail` via `console.error('[aperture:preload]', op, detail)` and strips it from what it returns upward. The strip is the enforcement — `tools.ts` never sees the field. |
| `src/mcp/tools.ts` | No prose changes needed (it already interpolates `r.reason`, which is now vocabulary by construction). Add one comment at the `browser_act` error site naming the invariant. |
| `test/` | Unit test on `failure()` (adversarial messages: envelope-delimiter fragments, bidi, 10 KB strings → capped, neutralized, reason always `'exception'`). A test that drives a handler to a thrown error (the existing `test/act.test.ts` pattern) and asserts the reply's `reason` is in the closed set and the rendered tool text contains no byte of the thrown message. |
| `docs/design/security.md` | Residual paragraph rewritten: five sites → zero interpolating sites; the guarantee upgraded from "Chromium world isolation" to "construction"; the select-handler omission noted. |

### Acceptance

1. `grep -n "err.message\|String(err)" src/preload/page.ts` shows hits only
   inside `failure()`.
2. The new tests pass; `npx vitest run` clean; battery per §9.
3. `bench:guards` unchanged (no guard exercises a thrown preload error — a
   live exception cannot be forced without sabotaging the build, which is
   what the unit tests are for; stated as a limit, not papered over).

**Partition: LANDS AFTER WAVE 2 (stage C).** `page.ts` is in `codeVersion`
AND `out/preload` in `buildVersion`; `engine.ts`/`tools.ts` likewise.

---

## 4. Size sweep Tier B — run it; here is what "properly" means (stage B)

The harness is built and its logic is unit-exercised (`--dry` covers the OLS
recovery, the singular-matrix refusal, all four band outcomes, the confounding
exclusion, seeded-bootstrap reproducibility, the stream normalizer, and all
five `p0Verdict` combinations — verified by reading `dryRun()`, not the
claim). What has never happened is contact with real data. This item is an
operating procedure, not code; the only thing it may edit is documentation.

### 4.1 Order of operations (all of stage B, ports free, tree frozen)

1. **`node bench/size.mjs --dry`** — may run in stage A. Must be green before
   anything else.
2. **The refusal-path exercise, once, before money.** `p0Verdict` is
   unit-tested but the `--sweep` fatal branch through `main()` (exit 7,
   nothing spent, no Aperture left running) has never executed end to end,
   and it is the only thing standing between a broken enabler and a $60
   measurement of truncation. Exercise it against a build that genuinely
   lacks the enabler:
   ```
   git worktree add ../aperture-p0 f9a91df      # pre-enabler commit
   cd ../aperture-p0 && npm ci && npx electron-vite build
   cp <repo>/bench/size.mjs bench/size.mjs      # current harness, old product
   cp -r <repo>/bench/size/fixtures bench/size/fixtures
   node bench/size.mjs --sweep --tiers s1       # EXPECT: exit 7, $0 spent,
                                                #   P0 names browser_act
   git worktree remove --force ../aperture-p0
   ```
   Record the observed exit code and output in the RESULTS.md section. If it
   does not exit 7, the sweep does not run until it does.
3. **`node bench/size.mjs --selftest`** — P0–P5 live at all five tiers plus
   Tier A. Green means: every tier within ±10% of target chars, untruncated,
   no collapse in padding; ref parity exact across tiers; predicate false
   untouched; scripted solve passes both arms with `mustObserve` matched; and
   P5 — the diff stream byte-identical across tiers modulo ids. Any red
   aborts; do not "just rerun the one tier."
4. **`node bench/size.mjs --sweep --n 6`**, `claude-sonnet-5`. The budget
   rule is already automated (s1 pilot at N=2/arm, projection, the one
   permitted adjustment s4→5, s5→4, refusal above $60). `--force-budget` is
   not to be used without the human saying so in the session, in words.
5. Append a dated section to `bench/RESULTS.md` (format below) and note the
   run in `docs/HANDOFF.md`.

### 4.2 What the report must contain to be publishable

- The `codeVersion` + `buildVersion` stamp, **with an explicit statement that
  they equal the wave-2 cohort's** (this is why stage B precedes stage C). If
  they differ, say which files — the sweep is still reportable but the
  cross-citation with wave 2's verdict is not, and the report must say so.
- The Tier A table: per-tier, per-arm observation chars and equal-turn
  conversation-input chars; the mechanism ratio. Diff-arm observation chars
  flat within ±10% across tiers; re-dump scaling ≥ 0.9× linear with snapshot
  size (the acceptance already in tier1b §2).
- Per-tier Δ$ with the seeded bootstrap 90% CIs, N actually run per cell, raw
  mean dollars per arm, and the band statement **verbatim from
  `crossoverBand`** — including the two no-crossover wordings and the
  product-threatening one if it fires.
- Success rates per tier per arm and any CONFOUNDED exclusions.
- The cost-model line: coefficients and R² — **cited only if R² ≥ 0.9**,
  otherwise printed with "the model failed; raw dollars only" (the gate is in
  the design; the report must honor it in prose too).
- Voluntary observations/episode per arm per tier — the behavioral secondary
  that says whether defensive snapshotting returns at scale after tier1b's
  teaching fix. This is the input the next design round needs either way.
- Zero `truncatedObs` across all Tier B episodes, stated. One truncated
  observation anywhere is a G11-class fault: the run is not comparable and
  the affected tier reruns after diagnosis.

### 4.3 What would make the output worthless

Named in advance so nobody argues afterwards:

- Any preflight red or skipped, and the run continued anyway.
- Rows from two different `codeVersion`s pooled into one report (the harness
  stamps but deliberately does not guard; the human is the guard here).
- Citing the fitted model below the R² gate, or citing Tier A dollar figures
  (Tier A has no dollars; it is the mechanism bound only).
- **Both arms failing at the big tiers.** If success collapses in both arms
  at s4/s5, the sweep has discovered that the agent cannot do the task on a
  20k-char page — a capability finding, and the cost curve above the collapse
  prices nothing. The report then says "the crossover is unmeasurable above
  tier sX with this model" and stops. CONFOUNDED handles a one-arm gap; this
  rule handles the two-arm one, which the harness cannot flag by delta.
- Treating the sweep as a cohort: no pooling with any future sweep run under
  a different stamp; each report stands alone.

**Partition: LANDS AFTER WAVE 2 (stage B, run-only).** Nothing it touches is
watched, but it needs 8817/8898/8899/8896 and its numbers want the wave-2
stamp. The `--dry` step alone is stage A.

---

## 5. `inert`, `pointer-events: none`, and the modal-dialog gap (stage C)

### What is broken, precisely (verified)

`statesOf` (walker.ts 561) consults `:disabled` only. The `select` handler
refuses on `isDisabled` only. `resolveRef`'s hit-test catches a *covering*
overlay but: a `<select>` inside an `[inert]` subtree is writable by
`action:"select"` (no coordinates, so no hit-test protects it); a control in
the inert background of a small `dialog.showModal()` is clickable whenever
the dialog does not cover its point (`findModal` only reports a `modalKey`
for large overlays — it prunes and blocks nothing); and a
`pointer-events: none` target hit-tests to whatever is beneath it, producing
an obstruction error that names an innocent bystander instead of the real
reason. Every one of these is the agent acting where a human demonstrably
cannot, which is the exact class the 2026-08-01 review said always turns out
to matter.

### The calls

Three facts, three treatments — because they have different scopes and
different costs:

1. **`[inert]` subtrees: rendered per element AND enforced.** New state bit
   `State.Inert`, word `inert`, set for every rendered element whose self or
   ancestor carries the `inert` attribute. Computed by threading an inherited
   boolean down `visit()`'s recursion (O(1) per node — not `closest()` per
   node). WHY rendered: HANDOFF's own deferral note says the agent should see
   it on every element; inert regions are typically small, deliberately
   marked panels, so the token cost is local. Diff transitions
   (`+inert`/`-inert` via `statesOn`/`statesOff`) come free from the existing
   STATE_NAMES machinery; a page flipping `inert` on a large region produces
   a large diff and the size governor resyncs, which is the correct outcome.
2. **Open modal `<dialog>`: enforced, NOT rendered per element.** One
   `document.querySelector('dialog:modal')` per walk/resolve; an element
   outside an open modal dialog is refused with reason `modal`. WHY not a
   per-element state word: a modal open/close would restate `+inert` on every
   element of the page — a diff explosion twice per dialog for information
   the agent gets from the dialog's own appearance (and `modalKey` /
   `State.Modal` already signal it). Enforce the global fact; render the
   local one. Note `aria-modal="true"` div overlays are deliberately NOT
   enforced this way: aria-modal is advisory — the platform does not make the
   background inert — so the hit-test remains the only honest gate there,
   covered-point case only, as today.
3. **`pointer-events: none`: rendered on addressable elements, enforced on
   pointer paths.** New state bit `State.NoPointer`, word `no-pointer`, set
   only when the computed `pointer-events` is `none` AND the element's role
   is in `ADDRESSABLE`. WHY the role gate: decorative overlays carry
   `pointer-events:none` constantly; emitting the word on every such line
   buys nothing and costs tokens — the agent only needs it on things it might
   act on. WHY zero extra style cost: `isRendered` already calls
   `getComputedStyle` for every element (walker.ts 639); refactor to compute
   once and pass the `CSSStyleDeclaration` through, and read `.pointerEvents`
   from it (it inherits, so the computed value handles ancestors).

**Enforcement matrix** (the policy lives in `tools.ts`; the facts come from
the preload):

`aperture:resolve` reply gains `blocked: 'inert' | 'modal' | 'no-pointer' |
null` (first match in that order; all three checks run in the preload where
the live element is). Then, per action:

| action | inert | modal | no-pointer |
|---|---|---|---|
| click / hover / clear / type / element-scroll | refuse | refuse | refuse |
| select | refuse | refuse | **allow** |

WHY the one asymmetry: `pointer-events` blocks pointer input only — a human
can Tab to such a select and change it with the keyboard, and `select` is
already the no-coordinates state-mutation path, so refusing it would make the
agent *weaker* than a human, the inverse failure. `type` refuses because the
product's type path acquires focus by CDP click (verified: `tools.ts` 824
clicks before `typeText`), so a no-pointer textbox mechanically cannot be
focused; the error must name the real reason instead of a phantom
obstruction. Error prose, fixed vocabulary (dovetails §3): `inert` → "it is
inside an inert subtree — a human cannot interact with it either"; `modal` →
"a modal dialog is open; interact with the dialog first"; `no-pointer` → "it
does not receive pointer input (pointer-events: none)". The select handler in
`page.ts` additionally refuses `inert`/`modal` itself (same tokens), because
it must hold even if a future caller skips the resolve gate — the
belt-and-braces shape the disabled fix already uses.

### Files

`src/core/snapshot/types.ts` (two bits + STATE_NAMES), `walker.ts` (inherited
inert flag; one-getComputedStyle refactor; role-gated NoPointer; the
`dialog:modal` lookup exported for the preload), `src/preload/page.ts`
(resolve `blocked` field; select-handler refusals), `src/mcp/tools.ts`
(per-action policy + prose), `test/fixtures/guards.html` +
`bench/guards.mjs`:

- **G13a** `select` on a select inside `[inert]` → refused, witness silent;
  **G13b** control: inert attribute removed → succeeds; **G13c** the
  snapshot line for it carries `inert`.
- **G14a** click on a `pointer-events:none` button → refused with the
  no-pointer wording (not an obstruction naming the element beneath);
  **G14b** `select` on a `pointer-events:none` select → **succeeds** and the
  witness records the change (the asymmetry is load-bearing; test it).
- **G15a** click on a button beside (not under) a small open
  `dialog.showModal()` → refused with the modal wording, witness silent;
  **G15b** control: dialog closed → succeeds.

Unit tests cover the walker bits where jsdom allows; jsdom's computed-style
and `dialog:modal` support is not trusted — the guards are the verification
of record, per house rule (could not verify jsdom's behavior from here;
stated so the implementer expects to lean on G13–G15, not vitest).

**Partition: LANDS AFTER WAVE 2 (stage C).** Walker, preload, tools, types
are all watched; rebuild moves `buildVersion`.

---

## 6. The security verification queue — rank, two probes, one closure

### The ranking, from the code as it is (not from the doc's ordering)

Two items collapse the most if unfavorable, and two turn out to have already
collapsed to nothing. Ranked:

1. **#2 — WebAuthn platform authenticator in Electron. VERIFY NOW.** If no,
   passkeys — which security.md calls "the actual fix," the thing that makes
   agent-blindness trivially true — become a Chromium-patch project, and the
   vault roadmap stays password-primary indefinitely. That changes what gets
   built next (the fill path's priority and ambition), so the answer is
   needed before the fill path is designed, and the calibration from item 1
   (UA client hints: resolved NO, cost the Chrome claim) says to expect the
   ugly answer and plan for it.
2. **#5 — `setContentProtection` vs. capture. VERIFY NOW.**
   `src/main/vaultWindow.ts` already **asserts the favorable answer in a
   comment** (line ~27: "It is excluded from capture") and calls
   `setContentProtection(true)` at line 79. This project's method section
   exists because of claims exactly like that one. Same-user screen readers
   are out-of-envelope, but benign capture — a screen share during a consent
   prompt — is squarely in scope, and the probe costs an hour on this exact
   OS (Windows 11, the deployment target).
3. **#3 — debugger-attach detectability.** Stays queued. Its consequence is
   detection-sensitivity of the fill path — an anti-detect concern, and the
   project formally rejected the anti-detect premise in favor of Web Bot Auth
   (§7). It gets verified if and when a detection-sensitive origin actually
   breaks the fill path.
4. **#7 — header order/casing via `onBeforeSendHeaders`.** Stays queued,
   folded into §7's implementation acceptance: the signing code is the first
   thing that will actually register such a listener, and the residual is
   measurable then, on real traffic, for free.
5. **#4 — single `webRequest` listener eviction. Moot today, live the moment
   §7 lands.** Verified: `grep webRequest src/` returns nothing — there is no
   listener to evict yet. Do not verify a hazard that cannot yet occur;
   instead, §7's implementation is REQUIRED to route through one multiplexed
   listener module from day one (`src/net/webRequestMux.ts`), which makes the
   unfavorable answer harmless without ever needing the experiment. Closing a
   verification item by construction beats resolving it.
6. **#6 — `Input.insertText` fidelity. CLOSED BY INSPECTION.** Verified:
   nothing calls `Input.insertText` — `act.ts` types via per-keystroke
   `Input.dispatchKeyEvent` (act.ts 128–139; insertText appears only in a
   comment explaining why not), and the vault fill path already IS the
   "fallback" the queue item names (isolated-world native setter + synthetic
   events, page.ts `aperture:fill`). The unfavorable outcome was absorbed
   before the question was asked. Strike it from the queue with this note.

### Probe specs (the only two that are actual work)

**#2 WebAuthn, two steps.** *Step 1, standalone (stage A — no Aperture, no
shared ports):* `bench/probes/webauthn/` — a ~40-line Electron main that opens
a `BrowserWindow` on a local fixture (localhost is a secure context; serve on
**8901**, never 8899) whose button runs
`navigator.credentials.create({ publicKey: { …,
authenticatorSelection: { authenticatorAttachment: 'platform',
userVerification: 'required' }, … } })` and reports the outcome into the DOM.
Human clicks; Windows Hello appearing and `create()` resolving = YES;
immediate `NotAllowedError`/`NotSupportedError` with no OS UI = NO. Then
`get()` with the created credential must also succeed, or the answer is
still NO (create-only is useless). *Step 2, in-Aperture (stage B):* only if
step 1 said YES — repeat inside Aperture itself (its `webPreferences` /
session could differ), same fixture, port 8901. Record the verdict, Electron
version, and Windows build in security.md's queue table; if NO, the recorded
consequence ("Chromium-patch project; passwords stay primary") becomes the
roadmap sentence for the fill path.

**#5 content protection (stage A, fully standalone):**
`bench/probes/content-protection/` — an Electron main that opens two windows,
one with `setContentProtection(true)`, one without, each filled with a large
label, plus a PowerShell capture script using
`System.Drawing.Graphics.CopyFromScreen` (the BitBlt path) saving a PNG.
Pass = the protected window's region is black/absent while the control is
visible. Additionally attempt `PrintWindow` via a small P/Invoke in the same
script, and one manual check with a Windows.Graphics.Capture consumer (OBS
display capture) for the DXGI-duplication half; record all three results
separately — the API maps to `WDA_EXCLUDEFROMCAPTURE`, which is documented to
cover modern capture but the doc's word is exactly what we do not accept. If
any path captures the protected window, the vaultWindow.ts comment is
rewritten to claim only what was measured, and "consent windows are
screenshot-readable via X" enters security.md as a named residual.

**Partition:** probe authoring + #5 run + #2 step 1 = **LANDS NOW** (new
files under `bench/probes/**` — unwatched; no rebuild of `out/`; no shared
ports). #2 step 2 = **AFTER WAVE 2 (stage B)**. security.md edits: batch with
stage B's doc pass.

---

## 7. Web Bot Auth — implement signing, kill the deadline framing (split)

### What the deadline actually is (README 401–405, corroborated externally)

Cloudflare splits AI traffic into Search/Agent/Training and, **from
2026-09-15, blocks Agent-class traffic by default on ad-monetized pages for
newly onboarded domains**; bot operators submit *signed agent* applications
(Web Bot Auth: RFC 9421 HTTP message signatures + a hosted key directory)
through the Cloudflare dashboard. External corroboration: Cloudflare's
signed-agents and AI-options announcements and third-party coverage
(sources in `docs/design/webbotauth.md` when written; links at the end of
this section's source note). What I could NOT verify from here: the
dashboard application's exact requirements and review latency — it sits
behind a Cloudflare account and is the first thing the stage-A investigation
must pin down.

### The call, in three parts

1. **Kill: "registered signed agent before 2026-09-15" as an Aperture goal.**
   The deadline is Cloudflare's rollout date, not a registration cutoff —
   nothing is forfeited by enrolling later. More decisively: **registration
   as deployed assumes a hosted agent whose requests egress from operator
   infrastructure holding the operator's private key.** Aperture is a local
   personal browser; a project-level private key would have to ship inside
   every install, i.e. be public, i.e. be worthless-to-hostile (anyone could
   sign as "Aperture", and the first abuser burns the key's reputation for
   everyone). There is no sound custody story for a registered project key in
   a client-distributed browser today. That makes the 09-15 date **someone
   else's deadline** — the hosted-agent operators'. Writing this down is the
   deliverable; chasing the date is not.
2. **Spec: RFC 9421 signing as a per-agent-session capability (stage C).**
   Small, self-contained, and what makes Aperture *able* to participate the
   day the ecosystem grows a user-scale enrollment story (and immediately
   useful against any origin the user controls or any verifier accepting
   self-hosted directories):
   - `src/net/botAuth.ts`: Ed25519 keypair generated per install, stored
     beside the vault material; sign with components
     `@authority`, `@method`, `@path` + `created`/`expires` (300 s)/`keyid`
     (JWK thumbprint)/`tag="web-bot-auth"`; emit `Signature`,
     `Signature-Input`, and `Signature-Agent: <directory URL>` headers per
     the Web Bot Auth architecture draft.
   - `src/net/webRequestMux.ts`: THE one `onBeforeSendHeaders` registration
     (see §6 item #4 — multiplexing is a design requirement, not an option),
     which botAuth registers into.
   - **Scope rule, the real design decision:** sign only requests attributable
     to the agent — navigations and subresource loads in a tab while an
     MCP-driven session is acting on it — and never human-initiated browsing.
     WHY: signing marks traffic as agent traffic; stamping the human's own
     browsing with a bot signature inverts the product's privacy premise. The
     attribution boundary is "tabs currently driven through the MCP surface,"
     which the tab manager already knows.
   - `Signature-Agent` URL is user-configurable, default empty = feature off.
     A power user who hosts their own JWKS directory can enroll themselves
     with Cloudflare as their own operator; Aperture does not pretend to do
     it for them.
   - Acceptance: unit tests vectoring the signature base against RFC 9421
     test vectors; a live check against an origin the implementer controls
     with a verifier (Cloudflare Workers has a WBA verification example) —
     recorded in RESULTS.md as "verified against X", or explicitly "verified
     against test vectors only" if no live verifier is exercised. Plus §6#7's
     header-order observation, measured while the listener is registered.
3. **Stage A (LANDS NOW): `docs/design/webbotauth.md`** recording parts 1–2,
   plus the enrollment investigation (a Cloudflare account, the dashboard
   form, its stated requirements and SLAs — pure research, no repo impact)
   so part 1's custody claim is checked against the actual form rather than
   inferred. If the investigation finds a per-user enrollment path with sane
   requirements, part 1 is revisited in that doc, not silently here.

**Partition:** part 3 = **LANDS NOW**. Part 2 = **AFTER WAVE 2 (stage C)** —
new main-process code, rebuild moves `buildVersion`. Six weeks remain after a
wave that finishes in days; the schedule is real but not tight, and the thing
the date was pressuring (registration) is killed above.

---

## 8. The two hygiene comments (stage C, ride-along)

Both are one-line comment edits that nonetheless move `codeVersion` — the
canonical example of "trivially safe-looking, still forces the partition."
They land as ride-alongs on the first stage-C commit touching each file
(item 1's commit for render/engine, item 2's for the bench), never as their
own cohort-invalidating commits.

1. **`src/core/snapshot/engine.ts`** — at the `const seq = st.nextDiffSeq()`
   call (~line 279): note that on the `navigated` path this burns a diff-seq
   whose increments (`step`, `diffsThisEpoch`) are unconditionally reset by
   `nextFullSeq()` in the full-snapshot branch below, so the burn is inert —
   verified by reading both counters' every consumer — and the call is left
   where it is because hoisting it below the branch would re-order seq
   assignment against the dry render for zero behavioral gain.
2. **`bench/lib/proxy.mjs`** — the comment at ~93–94 ends "Identical bytes to
   both arms can move the absolute level of voluntary snapshotting; it cannot
   move the between-arm comparison," which is the byte-symmetry argument
   tier1b §1's contamination flags explicitly corrected: the
   `browser_snapshot` sentence's antecedent is vacuous in the re-dump arm, so
   identical bytes CAN move the comparison. Replace those two lines with the
   estimand argument (the teaching is a component of the shipped diff
   product; contamination is asymmetric *handling*, and handling is
   symmetric) and the pointer "see tier1b.md §1, contamination flags — the
   re-dump-side hazard is monitored via per-task voluntary-observation
   rates."

**Partition: LANDS AFTER WAVE 2 (stage C).** Yes, for comments. That is the
point of the partition.

---

## 9. Implementation order

**Stage A — now, while episodes score** (any order; all safe):
1. §6: write both probes; run content-protection; run WebAuthn step 1.
2. §7: `docs/design/webbotauth.md` + the Cloudflare enrollment investigation.
3. §4: `node bench/size.mjs --dry`.

**Stage B — the moment `--n 20` exits, tree frozen, serialized on 8817:**
4. Haiku sensitivity cohort, if the tier1b interim rule fired.
5. §4 steps 2–5: refusal exercise → `--selftest` → `--sweep` → RESULTS.md.
6. §6: WebAuthn step 2 (if step 1 was YES); security.md doc pass
   (queue re-rank, #6 struck, probe results, §3's residual pre-announced).

**Stage C — edits, ordered commits, battery at the end:**
7. Item 1 (expand) + hygiene comment 8.1 in the same commit.
8. Item 3 (reason vocabulary).
9. Item 5 (inert/modal/no-pointer) — after item 3, because its refusal
   tokens extend §3's vocabulary.
10. Item 2 (streamAssert) + hygiene comment 8.2 in the same commit.
11. Item 7 part 2 (botAuth + webRequestMux).
12. Battery: `npx tsc --noEmit` · `npx vitest run` · `npx electron-vite
    build` · `bench:fidelity` × all scenarios (including item 1's new one) ·
    `bench/guards.mjs` (11 + G12a/b + G13–G15) · `npm run bench` ·
    `npm run bench:task -- --selftest` · `node bench/size.mjs --dry &&
    --selftest`. Bump `SUITE_VERSION` to the landing date.
13. Wave 3, if and when the human orders it, is `--new-cohort` and gets its
    own preregistration block first — including the finder-cheapest
    reinstatement question from §1 — none of which is decided here.

**Dependency note:** nothing in stage C blocks stage B; nothing in stage A
blocks anything. The single ordering that must not be violated is stage B
before the first stage-C commit (the shared-stamp property, §0.2).

---

## 10. What this backlog does NOT address

Stated so the absence reads as a decision, not an oversight:

- **Structure/position fidelity** — a scrambled-containment stream still
  passes every bench (HANDOFF gap). Designed, not built, not here.
- **The truncation regime** — an agent living on a 2000-token budget of a
  9k-token page is the production case; the sweep deliberately excludes it
  and nothing here measures it.
- **`~ eN "A"` format ambiguity** (name change vs text change) — still owed a
  disambiguator; touching the wire format mid-backlog would have forced
  every bench regex through another atomic-change dance for a hazard with no
  observed instance.
- **iframes** — still claimed by the design, still exercised by nothing.
- **The vault fill path** (HANDOFF next-item 4) — unblocked and unbuilt; §6's
  WebAuthn answer is deliberately sequenced to inform its design, but the
  design itself is not here.
- **The once-in-~450-acts `ok click e6` ghost acknowledgement** from wave 1 —
  unreproduced in three cold starts; nothing here hunts it, and it stays on
  the books as the suite's known loose thread.
- **Wave-3 preregistration** — explicitly out of scope (§9.13); this file
  hands wave 3 a fixed product, not a protocol.
- **Optgroup-qualified select queries, additive multi-select** — deferred in
  tier1/1b, still deferred, no new evidence moved them.
- **Security queue #3** (debugger detectability) — queued with its trigger
  condition named in §6; not scheduled.

## Verified vs. not verifiable from here

**Verified against code or store at `f4cd2e2`** (cited inline above): the
watched-set contents including `buildVersion`'s reach and `store.mjs`'s
exclusion; port 8817 hardcoded; `renderOp`'s two `expand: false` sites and
the marks/commit/dry plumbing; the size governor's dry-render fallback;
`streamAssert`'s current ≥2-refs check, `destructiveRefs`' inclusion of `~`
ops, and `r.acts[].ref` availability in G2; **five** (not four) `err.message`
sites in `page.ts`; `statesOf` consulting `:disabled` only; `findModal`
reporting without pruning or blocking; `isRendered` already paying one
`getComputedStyle` per element; `tools.ts` type-focuses via CDP click (line
824); no `webRequest` listener anywhere in `src/`; no `Input.insertText` call
site (comment only); `vaultWindow.ts` asserting content-protection in a
comment and calling it at line 79; `size.mjs --dry` covering the OLS/band/
bootstrap/p0 logic; the size fixtures generated and checked in.

**Could not verify, treated as checks not facts:** (1) the brief's "15 of 20
finder-cheapest voluntary observations were expand-driven" — wave 1 did not
record `{mode, expand}` per snapshot (that instrumentation landed in tier1b),
so the exact count is unverifiable from the archived store; item 1's case
rests on the verified structural mechanism and the corrected RESULTS.md
provenance, not on that number. (2) Whether Chromium hit-testing skips inert
elements — §5 deliberately enforces via explicit checks so nothing depends on
the answer. (3) jsdom's fidelity for `inert`/computed `pointer-events`/
`dialog:modal` — guards G13–G15 are the verification of record. (4) Electron's
WebAuthn and content-protection behavior — that is what the §6 probes exist
to measure; neither answer is assumed anywhere. (5) Cloudflare's enrollment
requirements and review latency — stage-A investigation, named in §7. (6)
That the wave currently running is healthy — nothing here reads its store,
by design.
