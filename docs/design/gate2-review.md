# Gate-2 review — tier2b + wave2 hardening bundle (`1ac7fc2`)

Independent gate review of the landed bundle at `master` / `1ac7fc2`. The
reviewer did not write the specs and did not build the code. Method: read the
commit and its full diff against the specs (`tier2b.md`,
`wave2-evaluation.md §1/§5/§6`, `review-external-2026-08-01.md`,
`blindfields-red-record.md`); ran the vitest suite (349 pass), `tsc` (clean),
the live `blindfields` fidelity scenario, the live guard probe (15/15), the
task-bench `--selftest` (G1/G2 + canary), a canary sabotage, seven mutation
and adversarial probes, and a G6b-predicate recomputation over the archived
wave-2 store. All throwaway probes deleted; working tree clean at `1ac7fc2`;
no commit made. **Scored benchmarks (`--n`) were not run.**

**Verdict: APPROVE — wave 3 may launch.** Everything wave 3's validity depends
on is verified sound. One HIGH-severity product defect (W1 false-alarm) and
several coherence nuances are recorded below; none of them corrupt wave 3, so
none block the launch, but the W1 item must be fixed before W1's guarantee is
relied on in production and the builder's report on it is overstated.

---

## 1. P0 — propDelta field completeness — VERIFIED

**Checked.** `propDelta` (diff.ts:463) now compares `href` and `rows` in
addition to name/value/text/states; `dims` rides with `rows`; the asymmetric
"table emptied" case (`o.rows && !n.rows && n.children.length === 0`) is
handled; the built bundle (`out/preload/page.cjs` walker; `out/main/index.js`
`propDelta`) is byte-consistent with source, so the fidelity/guard runs measured
the shipped engine.

**The three P0 probe outcomes on the real engine.** `test/diff-blindfields.test.ts`
drives the actual `diffSnapshots` and asserts CONTENT, not op counts:
(a) flattened-table-all-cells-changed → one `update` whose `delta.rows` equals
the new rows; (b) href-under-stable-label → one `update` whose `delta.href`
equals `['/checkout','/phish-target']`, asserted even with byte-identical label;
(c) baseline-replacement now unreachable (first diff non-empty) plus the
complementary "two identical trees → zero ops". The control (d) confirms the
same change in `text` was reported all along. Tests assert the delta payload
and the rendered bytes, not merely `ops.length`.

**Mutation checks (run and reverted).** Commenting out the href comparison →
4 tests RED across completeness + blindfields. Disabling the rows comparison →
5 tests RED. So both new comparisons are load-bearing, not decorative.

**Live round-trip / atomicity seam (deviation ruling #4).** `blindfields` ran
GREEN against the live post-fix build: WRONG HREF 0, WRONG TABLE CONTENT 0,
FAILED INDEPENDENT CHECKS 0/4 — the reader in `streamModel.mjs` parsed the real
Aperture `~ eN RxC:` + rows and `~ eN href=` stream and agreed with the truth
snapshot. `test/benchStream.test.ts`'s "renderer → reader round trip" drives the
real renderer + real reader and round-trips both fields, and asserts a
full-snapshot table row and an update-restated row parse identically (one
`renderRows`). Renderer and reader agree at unit level and live. Seam holds.

**Volatility / economics (rows update, not replace).** Confirmed the design
that keeps the wave-3 cost story alive: rows ride an `update` op, which is the
only op the volatility tracker sees; a rows-only delta has no state bits, so it
is `contentOnly` and takes the clock-suppression path. engine.ts feeds
`firstDifferingCell(old.rows, new.rows)` to `noteChange` for rows updates (old
tree indexed lazily, only when a rows update is present). `diff-blindfields`
proves both halves: a rows update on a volatile key → `ops:[]`, `suppressed:1`;
a heading change elsewhere on a page-with-a-table → exactly one op, on the
heading, table NOT restated. Tables do not re-emit on unrelated ticks.

---

## 2. The congruence contract (`test/completeness.test.ts`) — REAL, but the anti-recurrence guarantee lives in `tsc`, not vitest

**Checked by execution, both directions.**

- Added a hypothetical `hypotheticalField?: string` to `SnapshotNode` and ran
  `tsc`: **2 errors** — `Record<keyof SnapshotNode, Ruling>` (NODE_RULINGS) and
  `Required<SnapshotNode>` (SAMPLE) both reject the unruled field. The typecheck
  tether is real and mechanical.
- Ran **vitest alone** with the same field added to `SnapshotNode` only: **17
  pass, green.** The runtime `Object.keys(SAMPLE)` check does not see the field,
  because vitest transpiles types away and `SAMPLE` (an object literal) simply
  doesn't carry the key at runtime.
- Added the field to `SnapshotNode` AND to the `SAMPLE` literal but not to
  `NODE_RULINGS`: vitest then **does** go RED ("rules on every own key" fails).

**Finding (MEDIUM — claim accuracy, not a blocker).** The test file's header
states: "ADDING A FIELD FAILS THE TYPECHECK, and the sample node below fails the
test at runtime for the same reason." The runtime half is only true when someone
has already kept `SAMPLE` complete — which is itself forced by `tsc`, not by the
test runner. The anti-recurrence guarantee therefore lives entirely in
`npm run typecheck`. A contributor who adds a field to `SnapshotNode`, skips
typecheck, and does not touch `SAMPLE` gets a **green `npm test`** while
`propDelta` silently ignores the field — which is precisely the original bug's
recurrence path (rows/href were added to the type and propDelta was never
updated). The guard is sound in this project's practice (the commit ships "tsc
clean" and HANDOFF documents `npm run typecheck`), but if any future CI runs
only `npm test` the recurrence guard dies silently. Recommend: state in the test
header that the guarantee is a typecheck guarantee, and/or ensure the gate runs
`tsc`. There is no `.github/workflows` in the repo, so "CI" is whatever is run
by hand — worth pinning.

---

## 3. G6b + liveness canary — VERIFIED against the archived store and by sabotage

**Predicate recomputed over the wave-2 store** (`episodes.jsonl`, 251 rows,
using task.mjs's `isWedged`/`deadActsFrom` verbatim):

- **Exactly 6 quarantined**, lines 246–251 — the terminal contiguous block, as
  wave2-evaluation §2 claims.
- **3 per arm** (redump 3, diff 3): queue-positional/redump, vault-code/diff,
  vault-code/redump, catalog-revive/diff, catalog-revive/redump,
  ledger-balance/diff. Symmetric — the report-time symmetry guard (`|Δ|≥3` →
  INFRA) is not tripped.
- **0 false positives on the 245 clean**: zero clean episodes have ≥2 dead acts,
  and zero clean episodes have exactly 1 (so the tolerated-flake allowance is
  unexercised here but correctly present). deadActs on the six range 5–8.
- Cross-check: `a:nochange` total = 24, **all 24 inside the three wedged
  diff-arm episodes, 0 in the clean 245** — matches wave2-evaluation §5 exactly.

**Canary proven by sabotage.** `--selftest` PASSes G1, G2 (both arms, all 7
tasks) and the canary. Renaming the canary fixture's `data-bench` so the click
is no longer attributed → `--selftest` returns **INFRA (exit 3)** with the exact
wedge message ("the browser stopped delivering input to the page while its act
path kept answering ok"), the last reply shown (`ok click e170`). Reverted.

**Coherence note (LOW — forward coverage moved to the canary).** Post-W1, a
genuine wedge produces `error: ... never reached the page` (errored), which the
proxy attributes as `invalid_action`, NOT `no_page_effect`. So the `deadActs`
half of `isWedged` will read ~0 on any W1-era store — W1 converts the exact
signal (`ok` ack + no witness) into an error before it can be recorded as a dead
act. The `deadActs` predicate is thus effectively a wave-2-retrospective tool;
forward wedge coverage rests on the liveness canary (which I verified fires) and
on `walkTimeouts`. This is defensible defense-in-depth, but the framing that
G6b-quarantine is a live forward guard is optimistic — the canary is. Worth one
sentence in the G6b comment.

---

## 4. W1 input witness — verdicts correct, but FALSE-ALARMS on a class of real pages (HIGH)

**The parts that hold (deviation ruling #2), verified in code as written.**

- `unknown` can never fail an act: tools.ts only errors on `settle() === 'lost'`;
  `unknown` and `landed` both fall through to `observe`. act.ts returns
  `{ settle: async () => 'unknown' }` whenever arming fails. Confirmed.
- A real dead-path returns an error: the `'lost'` branch returns the "input was
  dispatched but never reached the page" error; act.test.ts drives `lost` →
  error, `unknown`/`landed` → ok, and refusals (non-editable type, obstruction)
  settle **before** arming so no false alarm is possible on a dispatch that
  never happened. `armInputWitness` is not called on those paths (asserted).
- 500ms is measured post-dispatch: `settle(ms = 500)` starts its timer when
  called, which is after the click/type switch runs; the timer is unconditional,
  so `'lost'` is guaranteed if the preload never replies. Sound by construction.
- Window-capture, not element-level: preload listens capture-phase on the
  resolved element's `window`, so it can witness a mis-hit. Correct.

**Finding (HIGH — shipped regression, overstated builder claim; NOT a wave-3
blocker).** The preload comment (page.ts) asserts: *"The listener is
capture-phase on the resolved target's WINDOW, which is the first node in the
capture path — so no page handler can `stopPropagation` its way out of being
observed."* The commit message generalises this to "the mechanism cannot invent
failures." **Both are false on Electron 43.** I built a throwaway fixture whose
page-world script runs
`window.addEventListener('mousedown', e => e.stopImmediatePropagation(), true)`,
navigated Aperture to it live, and clicked a normal button through
`browser_act`:

```
error: input was dispatched but never reached the page. The click on e2 was
sent and no matching event arrived in the page, so Aperture's input path to
this tab is not working ... needs the browser restarted.
```

A follow-up snapshot showed the page's own counter at **`clicks: 1`** — the
click **landed**; `stopImmediatePropagation` on `mousedown` does not suppress
the synthesized `click`, so the button's handler ran. The main-world capture
handler **does** suppress the isolated-world W1 witness (they are not isolated
from each other for `stopImmediatePropagation` here), so W1 returned `'lost'`
and produced a **false** terminal error instructing the agent to abandon the
tab and restart the browser.

Why this is not a wave-3 blocker: wave-3 fixtures are Aperture's own controlled
pages; none install capture-phase `mousedown` swallowers, so W1 returns
`landed`/`unknown` throughout and the canary (which also clicks a plain fixture)
will not false-INFRA. The false-alarm cannot corrupt wave-3 scoring.

Why it must be fixed anyway: W1 is a NEW failure mode on real pages — before
this bundle those clicks returned `ok`; now they hard-error with a
"restart the browser" instruction. Real sites that intercept `mousedown` at
window/document capture (some drag/overlay/editor libraries do) would brick the
agent on that tab. And the code's own justification for choosing window-capture
is empirically wrong, so the reasoning should be corrected, not just the
behavior. Minimum fix directions to consider: witness a broader/earlier signal
that a page cannot pre-empt (e.g. confirm via CDP hit-test / dispatch ack
against the resolved node), require corroboration before declaring `'lost'`
(e.g. also observe zero DOM effect), or downgrade a single unseen witness to
`unknown` unless a second signal agrees. The current single-listener design is
a page-suppressible tripwire.

---

## 5. Security — `sanitizeHref` — ROBUST for the wire; one cosmetic note

The href now flows into agent context on the `~ eN href=...` line (unquoted),
inside the untrusted-content envelope. I replicated `hrefOf` + `sanitizeHref`
from the exact bundle regex (`out/preload/page.cjs:413`) and ran 13 adversarial
inputs:

- **javascript: / data: URLs** → `nullalert(document.cookie)` /
  `nulltext/html,<script>fetch("//evil")</script>`. Harmless as agent-facing
  text: the agent acts by ref/click, navigation has a scheme allowlist
  (security.test.ts), and the value cannot break the wire. Cosmetic note:
  `sanitizeHref` strips whitespace/control/bidi but NOT `< > " ( )`, so a
  `<script>`-shaped payload renders visibly in the token. It stays inside the
  envelope and cannot forge a close (needs the per-call nonce; capped at 60), so
  this is defense-consistent, not a hole.
- **2000-char href** → capped at 60. ✓
- **newline / CRLF / U+2028 / U+0085 forging a `FULL SNAPSHOT`/`page #` header**
  → the WHATWG URL parser percent-encodes them in the pathname, and
  `sanitizeHref` strips any that survive; every output is single-line and
  whitespace-free. No header injection. ✓
- **envelope close delimiter** in a long query → the >40-char search is replaced
  with `?…` before it ever reaches the wire; a short one is capped at 60 and
  lacks the live nonce. ✓
- **bidi RLO, tab, space** → stripped or percent-encoded; token stays a single
  `\S+` the reader parses whole. The reader strips `href=(\S+)` before the state
  loop, so an href cannot smuggle a `+focused` state (benchStream.test.ts pins
  this). ✓

Every case: single line, whitespace-free, ≤60 chars. The wire is safe.

---

## 6. The `(unchanged` wording — reachable only for genuinely-unchanged pages, with one documented residual

With propDelta now covering name/value/text/href/rows/states, the zero-op path
is reached only when none of those differ, no structural change occurred, and
no navigation happened. The excluded fields (completeness table): scroll, rect,
headingLevel, title, dims-alone, Offscreen. The completeness test asserts scroll
and rect are excluded and that the six rendered fields
(name/value/text/states/href/rows) are diffed.

**One residual blind field (LOW).** `headingLevel` is **rendered** — renderLine
emits `h2 "X"` / `h3 "X"` — but is **excluded** from diffing. A heading whose
level changes with identical text emits zero ops and reports "unchanged", while
the full-snapshot bytes for that line differ (`h2 "X"` vs `h3 "X"`). It is a
ruled, documented exclusion ("presentation weight; the heading's text is the
operative fact and IS diffed; no failure class observed"), and the tool sentence
enumerates fields without claiming heading level and says "pixel layout" is
untracked, so the sentence is defensible. But it is the one RENDERED field that
is excluded, and the completeness test's "rendered fields must be diffed" list
quietly omits it, so the "everything rendered … is tracked" spirit is not
literally true for pure heading-level changes. Rare; acceptable as documented;
flagged because the task asked whether any excluded field can make "unchanged"
lie, and this is the only one that can at the rendered-byte level. `title` and
`scroll` are honestly excluded and disclosed.

---

## 7. Deviation rulings — all four sound

1. **Builder B beyond ownership.** The commit's src set is exactly
   act/diff/engine/registry/render/types/walker/tools/page. Beyond tier2b's
   named types.ts/engine.ts, Builder B's reach was act.ts + tools.ts +
   preload/page.ts + test/act.test.ts — all W1 main-side glue, legitimate.
   `walker.ts` is comment-only (the stale positional comment rewrite, no code).
   Nothing unexpected leaked. Ruling sound.
2. **W1 window-capture / 500ms / tri-state.** Reasoning holds in code for
   `unknown`-never-fails, 500ms-post-dispatch, and lost→error (§4). The one
   place the *stated* reasoning does NOT hold is the page-suppressibility claim
   (§4, HIGH). The ruling's design choices are right; its confidence about
   robustness is overstated.
3. **F4 step-order swap.** Both orders are recorded RED in
   blindfields-red-record §3/§4: the spec's order is RED on F2 + independent
   checks but F3 never fires (step 1 carries a focus delta), so the swap
   (two Advance clicks adjacent) is required to exercise F3. Documented in the
   record and in fidelity.mjs's scenario comment. Sound.
4. **Set-B reader half agrees with the renderer.** Verified live and by
   round-trip unit test (§1). Sound.

---

## 8. Known-open items — correctly deferred, not silently dropped

- `bench/churn.mjs` + affinity vectors (tier2b P2): absent from the repo, as
  intended — P2 is measurement-gated and unbuilt. `nameSimilarity` retained with
  the dated tenure comment tying its life to the P2 decision. Correctly open.
- wave2-evaluation §6 instrumentation (child-log persistence, `getAppMetrics`
  sampling): NOT built. `startAperture()` still captures stdout/stderr in memory
  and prints only on startup failure (task.mjs:403-413); no `aperture.<ts>.log`,
  no app-metrics endpoint. This is a genuine gap vs §6's ruling — the wedge root
  cause stays undecidable for a future occurrence beyond ±one episode. W1 +
  canary convert the wedge from lie to loud INFRA, which is the shipped part;
  the diagnostic instrumentation is deferred. Confirm this is intended: the
  commit message says "instrumentation are specced" (RESULTS.md) — specced, not
  built. Correctly open, but ensure it is tracked, since it is the only thing
  that would root-cause the next wedge.
- W1 does not cover scroll/key (no target to arm): confirmed — tools.ts arms the
  witness only on the element-targeted branch; scroll/key dispatch and observe
  with no witness. A wedge would still ack `ok` on those. Flagged in the commit
  as follow-up. Correctly open.
- Wave 3 must be `--new-cohort`: confirmed by construction — the store's
  `codeVersion` (`32e345badf143aec`) is pinned in the cohort sidecar and the
  task store pools nothing across codeVersions; the landed src changes move it.
  `wave2-scored` tag exists; the archived `episodes.20260801T160431Z.*` pair is
  present. Correctly handled.
- `invalid_action` attribution (§5): the proxy split is correct
  (`!REF_ERROR.test(text) ? 'invalid_action' : shadowHad ? 'engine_ref_loss' :
  'model_bookkeeping'`), routing `unsupported key`/`text required` out of
  engine_ref_loss. **No test covers it** (only referenced in proxy.mjs). LOW —
  bench-side classification, but an untested attribution change is exactly the
  class this project keeps getting bitten by; a one-case unit test is cheap.

---

## 9. Battery re-run (this review)

| check | result |
|---|---|
| `npx vitest run` | 349 pass (14 files) |
| `npx tsc --noEmit` | clean |
| fidelity `blindfields` (live) | GREEN, EXIT 0 |
| guards (live, all) | 15/15, GREEN |
| task `--selftest` (G1/G2/canary) | PASS |
| canary sabotage | INFRA exit 3 (correct) |
| G6b predicate over wave-2 store | 6 quarantined, 3/arm, 0 FP/245 |
| propDelta href mutation | 4 tests RED (load-bearing) |
| propDelta rows mutation | 5 tests RED (load-bearing) |
| completeness tether (tsc) | fails on unruled field (real) |
| completeness tether (vitest-only) | passes on unruled field (gap) |
| sanitizeHref, 13 adversarial hrefs | all single-line, ≤60, ws-free |
| W1 vs hostile window-capture | FALSE ALARM (click landed, error returned) |

---

## Verdict

**APPROVE — wave 3 may launch.**

The P0 fix is complete and probe-verified on the real engine; the congruence
tether is real (under `tsc`); G6b quarantines exactly the six wedged episodes
with zero false positives; the liveness canary fires on a real wedge; the
economics/suppression path keeps tables from re-emitting on ticks; the fidelity,
guard, and selftest batteries are GREEN live; `sanitizeHref` closes the wire.
Nothing wave 3 depends on is broken.

**Required before relying on W1 in production (does NOT block wave 3):**

1. **W1 false-alarm (§4, HIGH).** A page-world capture-phase `mousedown`
   handler that calls `stopImmediatePropagation` suppresses the isolated-world
   witness and makes `browser_act` return a terminal "input never reached the
   page / restart the browser" error on clicks that actually land. Fix the
   witness (corroborate before declaring `lost`, or use a signal a page cannot
   pre-empt) and correct the page.ts comment / commit claim that "no page
   handler can `stopPropagation` its way out" and "the mechanism cannot invent
   failures" — both are empirically false here.

**Recommended (tracked, non-blocking):**

2. Congruence tether (§2): document that the anti-recurrence guarantee is a
   `tsc` guarantee, and ensure the gate runs typecheck — `npm test` alone does
   not catch a new unruled field.
3. wave2-evaluation §6 diagnostic instrumentation (§8): specced, not built —
   the only thing that root-causes the next wedge. Keep it on the board.
4. `invalid_action` (§8): add a one-case unit test.
5. G6b `deadActs` is now a retrospective predicate (§3); the canary is the
   forward guard — note it in the comment.
6. headingLevel residual (§6): the one rendered-but-excluded field; leave as
   documented, but be aware "everything rendered is tracked" is not literally
   true for a pure heading-level change.
