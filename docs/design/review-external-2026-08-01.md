# External review — claim-by-claim verification, 2026-08-01

Verified against `master` at `f4cd2e2` (working tree, no rebuild). Method: code
reading with line cites, the pre-image at `f4cd2e2^`, the full test suite
(`npx vitest run` — 289 passed), a throwaway probe test executed under `test/`
and deleted afterward, and the live wave's `bench/task/results/episodes.jsonl`
(204 episodes at time of reading; the wave was still appending). No source
file, port, or benchmark was touched; `out/` untouched.

---

## 1. THE CENTRAL CLAIM — CONFIRMED, with two scope corrections

The reviewer is right, and the chain holds link by link. This was verified by
execution, not just reading.

**Step 1 — walker flattens data tables.** `src/core/snapshot/walker.ts:277-284`:
an `HTMLTableElement` with no interactive descendant gets `node.rows`,
`node.dims`, and `node.children = []`.

**Step 2 — propDelta is blind to it.** `src/core/snapshot/diff.ts:346-377`
compares exactly five things: `name`, `value`, `text`, `statesOn`, `statesOff`.
`href`, `rows`, `dims`, `scroll`, `optionCount`* are never read.
(*`optionCount` alone has a bespoke guard, `optionSetTurnedOver`, diff.ts:324 —
which proves the pattern was understood for selects and not generalized.)

**Step 3 — the childless early return.** `diff.ts:153`:
`if (oldKids.length === 0 && newKids.length === 0) return;` — a flattened
table has no children on either side, so the walk ends with zero ops.

**Step 4/5 — zero ops routes to `unchanged` and clobbers the baseline.**
`src/core/snapshot/engine.ts:261-276`: the zero-op path returns
`renderUnchanged(...)` — the agent is affirmatively told
"unchanged — the action caused no visible change" (`render.ts:317-319`) — and
executes `st.last = { ...st.last, root: r.root, title: r.title }`, so the next
diff compares the already-updated tree against itself. It consumes neither a
state id nor an epoch slot (no `nextDiffSeq()` call).

**Probe (executed, passed, deleted).** `test/probe-review-external.test.ts`,
run under vitest 3.2.7, 6/6 passed:

- A flattened table whose every data cell changed (`Pending` → `SHIPPED` /
  `CANCELLED`) → `diffSnapshots` returned `ops: []`, `unreadChanges: 0`,
  `suppressed: 0`. Zero signal on any channel, including the caveat channels.
- A link with stable key and label whose `href` changed `/checkout` →
  `/phish-target` → `ops: []`.
- Baseline replacement simulated: first diff `[]`, second diff (new baseline
  vs identical successor) `[]` — the change is unreportable afterward, exactly
  as claimed.
- Control: the same change carried in `text` instead of `rows` IS reported —
  the blindness is field-specific, not a harness artifact.

The href half is fully as claimed: `ensureRef` updates the registry's stored
href (`registry.ts:29`) and the page-side index resolves by key to the live
element, so the ref stays live and clicks land on the element's **current**
target while the agent's belief is the href from the last full snapshot.
Nothing in the diff stream ever contradicts it.

**Two scope corrections, neither of which saves us:**

1. *"Every row of an inbox, orders table or dashboard"* overstates the table
   half. Only tables with **no** interactive descendant are flattened
   (walker.ts:277, `hasInteractiveDescendant` walker.ts:742). An inbox or
   orders table with a single link, button, or input anywhere inside keeps its
   children and diffs normally. The exposed class is purely-static data tables
   — read-only dashboards, reports, price/status tables. That class still
   decides real agent actions, so severity stays high; blast radius is
   narrower than the reviewer's rhetoric.
2. *"Nothing heals it short of a navigation"* overstates the permanence. The
   change is permanently unreportable **as a diff**, and a `mode:auto`
   snapshot returns "unchanged — you already hold the current page" — but an
   explicit `mode:"full"` snapshot, a `tooBig` resync, or `tooMany` after 12
   genuine diffs elsewhere on the page all restate the current table/href and
   heal the belief. What makes this worse in practice is that tier1b item 3
   shipped the sentence "A diff is complete: anything it does not mention is
   unchanged" into the tool descriptions (`tier1b.md` §1, wired in
   `src/mcp/tools.ts`) — we are now actively teaching the model to trust a
   guarantee `propDelta` does not honor.

**Severity: high. This is a real engine defect, the reviewer's mechanism is
exactly right, and our own completeness doctrine amplifies it.**

---

## 2. Did commit `f4cd2e2` make it worse? — YES, MARGINALLY; it did NOT create it

Pre-image evidence (`git show f4cd2e2^:src/core/snapshot/engine.ts`): the old
zero-op path read

```js
if (result.ops.length === 0) {
  const seq = st.nextDiffSeq();
  st.last = { ...st.last, seq, root: r.root, url: r.url, title: r.title };
  ...
```

Two facts follow:

- **The bug predates today's commit.** The old path also replaced
  `st.last.root`, so the change was already unreported and already
  unreportable-by-diff before `f4cd2e2`. `git diff f4cd2e2^ f4cd2e2` touches
  neither `diff.ts` nor `walker.ts`; `propDelta`'s blindness is old. The
  reviewer's framing that our change "made a latent bug permanent" is wrong in
  mechanism — it was already permanent at the diff level.
- **But yes, we made it worse.** In those words. Two ways:
  1. Old code burned an epoch slot per unchanged observation, so in a mixed
     stream the 12-slot cap tripped sooner and the next op-producing
     observation delivered a healing full restatement. New code requires 12
     genuine diffs before that heal. (Note the reviewer slightly overstates
     the old heal too: the old zero-op branch returned *before* the `tooMany`
     check, so an unbroken run of unchanged observations never healed in
     either version — the tier1b "Behavior change owned out loud" section says
     as much.)
  2. Item 3 of the same commit taught the model diff-completeness — reasoning
     ("applying zero ops accumulates zero model-side error") that is true for
     correct zero-op diffs and false when zero ops is itself the bug.

**The right response is not reverting `f4cd2e2`.** Its reasoning is sound
conditional on `propDelta` being field-complete. Fix the precondition (fix
list, item 1) and today's change becomes correct retroactively.

---

## 3. Is the running wave contaminated by this bug? — NO. Do not kill it.

Checked all seven task fixtures and all 204 recorded episodes:

- **No fixture can hit the blind fields.** `grep '<table'` over
  `bench/fixtures/` → zero matches; `grep 'href'` → zero matches. Every
  mutation in inbox/wizard/leaderboard/queue/vault/catalog/ledger lands in
  `text`, `name`, `value`, or `checked` on spans, buttons, inputs, and
  paragraphs — all `propDelta`-visible (fixtures read in full).
- **No zero-op observation ever masked a change.** Across all 204 episodes:
  `a:nochange` (post-action unchanged) count is **0**; all 30 nochange
  observations are `s:nochange` — voluntary verification snapshots on
  genuinely unchanged pages (e.g. inbox run 0 `obsSeq`:
  `["s:full","a:diff","a:diff","a:diff","s:nochange"]`). If the central bug
  had fired in this wave, it would appear as `a:nochange` after a
  state-changing act. It never does.
- **The wrong-element gap is the intended measurement, not the bug.** All 6
  diff-arm `wrong_choice` acts sit in `queue-positional` (runs 3 and 5) — the
  fixture whose header comment says it is built so every Approve/Reject falls
  to the S-tier ordinal key and removals renumber the rows below
  (`bench/fixtures/queue.html:16-59`). That is the acknowledged positional-ref
  limitation being deliberately priced, and it bites the re-dump arm too.
- **The cited standings are stale.** episodes.jsonl currently shows diff 6
  wrong vs re-dump **3** (not 1), 13/15 vs 13/15 task success in queue. The
  gap is 2x and concentrated in the one task designed to produce it.

The wave is measuring diff bookkeeping under positional identity, which is
what it preregistered. Let it finish.

---

## 4. `isPositionalKey` exported and tested but called from nowhere — CONFIRMED. Unwired guard.

- Defined `walker.ts:362`; sole `src/` occurrence is the definition. Called
  only from `test/security.test.ts:204-206, 298-299`.
- It is not "logic living elsewhere under another name": no `positional` field
  exists on `SnapshotNode` (`types.ts:50-111`), and nothing in `diff.ts` or
  `render.ts` treats positional keys differently — despite walker.ts:320-321
  promising "`positional` is set on the node so the diff engine and the
  renderer can treat these as fragile," and despite the test at
  security.test.ts:203 being *named* "marks positional keys so the diff engine
  knows they are fragile." The test asserts a regex; the wiring it names does
  not exist.
- **Worse, the pattern repeats:** `fuzzyRescue` (`registry.ts:149`) is also
  exported, tested (`snapshot.test.ts:184-204`), doc-commented as the
  stale-ref rescue path — and called from nowhere in `src/`. The reviewer
  found one of two.
- Severity: medium, and the live wave shows the cost of the missing wiring —
  queue-positional's wrong_choice clicks are exactly the fragile-ref case this
  guard was supposed to let the engine flag.

---

## 5. S-tier ref churn (name inside the key) — CONFIRMED; proposed fix REJECTED AS STATED

- Mechanism confirmed by probe: `S|frame|role|norm(name)|anchor|path`
  (`walker.ts:388`) puts the accessible name in the key, so
  `Follow` → `Following` changed the key and `diffSnapshots` emitted
  `['add','remove']`, not one `update` (probe executed, passed).
- Narrowness confirmed, and slightly *wider* than claimed: T-tier needs a
  testid, N-tier applies only to `isFormControl` roles (`walker.ts:404-409`)
  — which **excludes `button`** — so even a `<button name="follow">` churns.
  `siblingDiscriminator` cannot rescue it because `|~sibling` is appended to
  the S-tier base key (`walker.ts:200-203`); the base still changed.
- **The proposed fix fails its own headline case.** `nameSimilarity` is
  token-set Jaccard (`registry.ts:176-186`); probe-verified:
  `nameSimilarity('Follow','Following') === 0` — "follow" and "following" are
  different tokens. A second-pass reconciliation reusing it as-is would pair
  nothing in the toggle-label case that motivates the fix. It does work for
  multi-word labels (`'Add to cart'` vs `'Added to cart'` → 0.5). The
  *mechanism* (second pass over unmatched old/new pairs sharing
  role + anchor + path) is sound and the pairs are already available in
  `reconcileChildren`'s `remaining` map; the *metric* needs a character-level
  component (prefix/edit-distance) before it is worth wiring.
- **Measure before deciding:** instrument the diff to count remove+add pairs
  sharing role+anchor+path per episode on real pages, and the false-merge rate
  a char-level metric would produce on genuinely different siblings
  (`Save`/`Delete` share role+anchor+path in many toolbars). No fix without
  those two numbers.

---

## 6. `keysOf` Set-then-spread — CONFIRMED; cosmetic

`diff.ts:384-388` builds a `Set` via `collectKeys` then spreads to an array;
both call sites (`buryUnder` diff.ts:90, removal loop diff.ts:279) only
iterate. The spread is a pure duplicate O(n) allocation per removal/replace.
Still O(n) asymptotically — the reviewer's "more than the O(n) claim implies"
is a constant factor, not a complexity class. Ruling: cosmetic. Iterate the
Set directly; batch with other work.

---

## 7. Test count — PARTIALLY CONFIRMED, and the reviewer's own number is wrong where it matters

- True count: **289 passed** (`npx vitest run`, 11 files, this session).
  The reviewer's 289 is exact.
- **"152" appears nowhere in the repo.** Searched all files: the only `152`s
  are lorem-ipsum note numbers in `bench/size/fixtures/cart-s{4,5}.html`. The
  stale claims that do exist are `README.md:478` ("187 tests, 49 of them on
  the snapshot engine") and `docs/HANDOFF.md:5` ("283 tests pass").
- **"Stale in your favour" is backwards.** Both stale numbers *undercount*.
  Stale, yes; flattering, no. Fix the docs to 289 (or better, remove the
  hardcoded counts).

---

## 8. The reviewer's concessions — spot-checked five; all five are correct

1. **TIMER_SHAPE refuses bare integers** — CORRECT. `volatility.ts:40-41`:
   regex requires clock/relative-timestamp shapes; the doc comment records the
   cart-badge regression that motivated it; `security.test.ts:211-217` pins it.
2. **`onAgentTouch` clears `shapeVolatile`** — CORRECT. `volatility.ts:99-104`
   resets both `streak` and `shapeVolatile`.
3. **`siblingDiscriminator` beats the ordinal fallback** — CORRECT, and live:
   inbox-archive's six identical "Archive" buttons (keyed by row siblings)
   produced **0** wrong-element acts across 15 diff-arm episodes in the
   current wave, while queue-positional (no discriminating siblings, by
   construction) produced all 6.
4. **`buryUnder`** — CORRECT as described: bookkeeping death for every
   destroyed ref, report only for emitted ones (`diff.ts:88-99`), used by both
   `replace` sites.
5. **Dry-render/commit split** — CORRECT: `renderDiff(…, commit=false)` sizes
   the candidate without emission marks (`engine.ts:290`, `render.ts:334-339`),
   the commit render at `engine.ts:332` is byte-identical and marks.

A reviewer right on all five concessions and right on the central mechanism
has earned the credibility they claimed. The errors are in scope rhetoric
(§1), attribution of origin (§2), the contamination hypothesis (§3), the fix
metric (§5), and the test-count provenance (§7).

---

## Answers

### 1. Does the running wave need to be killed? — NO.

No fixture contains a mutation `propDelta` is blind to; zero post-action
`nochange` observations exist in 204 episodes; every wrong-element act is in
the fixture purpose-built to measure positional-ordinal fragility, and the
re-dump arm suffers there too (6 vs 3, not 6 vs 1). The wave is measuring what
it preregistered. Killing it would discard clean data to no purpose.

### 2. Did commit `f4cd2e2` make the central bug worse? — YES, marginally — and it did not create it.

The bug (blind `propDelta` + baseline clobbering on the zero-op path) is fully
present at `f4cd2e2^`; the change was already silent and already unreportable
before today. What `f4cd2e2` did was (a) slow the incidental heal — unchanged
observations no longer hasten the epoch cap, so a mixed stream now needs 12
genuine diffs before a forced full restates the stale region — and (b) ship
tool-description text telling the model to trust diff completeness, which is
exactly the guarantee this bug falsifies. So: worse, yes; the origin, no. Do
not revert it — make its premise true instead (fix 1).

### 3. Prioritised fix list (for Opus implementers, after the wave)

1. **P0 — Make `propDelta` field-complete.** Compare `href` (emit as an
   `update` delta field, rendered as the changed target) and `rows`/`dims`
   (on change, emit a `replace` of the table node so the renderer restates the
   rows — an update-delta diff of 50 rows is worse than a restatement, same
   judgement as `REPLACE_MATCH_RATIO`). Leave `scroll` and `Offscreen` out
   deliberately and say so in the comment — they churn on every scroll and are
   the one genuinely-noise field family. Add regression tests mirroring the
   probe in this review (table-rows change, href-under-stable-label change,
   and the new-vs-new unreportability case). This single fix retroactively
   validates both the `f4cd2e2` zero-op semantics and the "a diff is complete"
   tool description.
2. **P1 — Decide `isPositionalKey` and `fuzzyRescue`: wire or delete, no third
   option.** For `isPositionalKey`: either set `positional` on the node in
   `disambiguate` and have the renderer/diff mark those refs fragile (the
   queue-positional wave data will say whether the marking earns its tokens),
   or delete the function and rename the test so it stops claiming wiring that
   does not exist. For `fuzzyRescue`: wire it into the stale-ref act path its
   doc comment describes, or delete it and its tests. Exported-and-tested dead
   code is how the next reviewer catches us again.
3. **P2 — S-tier second-pass reconciliation, gated on measurement.** Mechanism
   per the reviewer (unmatched old/new pairs sharing role + anchor + path),
   but replace bare `nameSimilarity` with a metric that scores
   `Follow`/`Following` above threshold (add a normalized-prefix or
   edit-distance term). Before implementing, instrument: (a) incidence of
   churned pairs on real pages, (b) false-merge rate on label-swapped
   siblings. If (a) is rare, the fix is not worth its false-merge risk.
4. **P3 — Docs truth.** README.md:478 `187` → current count; HANDOFF.md:5
   `283` → current count (or drop hardcoded counts). Fix the walker.ts:320
   comment and the security.test.ts:203 test name if item 2 resolves to
   "delete".
5. **P4 — `keysOf`:** return/iterate the `Set` directly; fold into whichever
   of the above touches `diff.ts` first. Not worth its own commit.
