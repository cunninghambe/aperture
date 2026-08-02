# Wave-3 evaluation and the G3 ruling — 2026-08-02

Independent adjudication of the wave-3 task-success run (230 episodes, $76.91,
`report()` exited 3 INFRA via G3 without printing a verdict). Method: every
number below was recomputed per episode from
`bench/task/results/episodes.jsonl`, intervals through `bench/lib/stats.mjs`
(the suite's own code), sources read at `6708162` (tree clean; the store's
`codeVersion 05315affc1963c77` / `buildVersion 469784c4c2c2d98e` match the
run log and every episode — 1 distinct value of each across all 230). The
extracted verdict unit was validated by reproducing the pilot's printed block
to the digit (success −6.7pp [−35.1, +23.0]; wrong-el +0.067 [−1.467, +1.600];
all three per-task tripwire CIs). No source file was edited, nothing was
rebuilt, no scored episode was run; probes were read-only.

The coordinator's aggregate numbers are correct to the digit everywhere I
checked (73/105 vs 67/105; 0.933 vs 1.143 wrong-el/run; $0.3622 vs
$0.3470/ep; 11,075 vs 15,240 obs chars; 0.73×; the per-task splits; 20/20
canaries; $76.9085 total; zero wedged). Three of the coordinator's *readings*
are wrong, and two of them are load-bearing, so they come first.

---

## 0. Corrections to the framing, before the rulings

### 0.1 The GPU pid change is the pilot→full-run app restart, not a live crash

The wave-2 wedge hypothesis was NOT "observed live for the first time."
Nothing crashed and nothing relaunched. Evidence, all four independent:

- The store's single pid transition (54540 → 50876) sits at store line 50/51:
  between `ledger-balance redump run4` recorded 23:35:10.267Z — the **last
  pilot episode** — and `queue-positional diff run5` recorded 23:37:18.533Z —
  the **first full-run episode**.
- The two runs were two Aperture launches. Pilot child log
  (`aperture.20260801T223029Z.log`): exited 23:35:10.582Z. Full-run child log
  (`aperture.20260801T233541Z.log`): started 23:35:41.406Z. A new process
  tree has new pids by construction.
- Within each instance the GPU process **never** restarted:
  `apparatus.20260801T223029Z.jsonl` (50 samples) shows GPU pid 54540 with
  `creationTime` 22:30:31.530Z constant first-to-last;
  `apparatus.20260801T233541Z.jsonl` (180 samples) shows 50876 with
  creationTime 23:35:43.022Z constant first-to-last. A relaunched GPU process
  would carry a new creationTime even if the OS recycled the pid.
- Both child logs are 9 lines: startup banner + orderly exit. No GPU, crash,
  or relaunch lines anywhere in 11 hours of child stderr.

Consequence for the wedge investigation: **wave 3 contributes nothing to the
hypothesis ranking, in either direction.** No wedge occurred (G6b quiet, zero
dead clicks/types in 230 episodes — all six `no_page_effect` acts in the store
are scrolls, which are witness-silent by design), and no mid-run GPU crash
occurred, so "GPU crash without a wedge" was not observed. The ranking from
wave2-evaluation §6 stands untouched. What wave 3 does prove is that the §2.2
instrumentation *works* — it caught a pid change and timestamped it to the
episode — and that its report has a misreading trap: `printApparatusNote`
(task.mjs:2193) compares consecutive episodes **across runner invocations**.
Spec fix, next cohort-severing bundle: stamp instance identity onto the
episode (`apparatus.browserPid` + browser `creationTime`, both already in the
sidecar sample) and print cross-instance transitions as `app restart —
expected`, reserving the crash wording for same-instance transitions.

### 0.2 "Post-resync failures 65 vs 236" is a vacuous comparison — do not cite it

The `post_resync` tag fires when an act is within 2 observations of a FULL
SNAPSHOT (proxy.mjs:352-355). In the re-dump arm **every** observation is a
full snapshot, so every act is tagged, and `postResyncFailures` degenerates to
"all non-ok acts": re-dump non-ok = 120 wrong_choice + 110 model_bookkeeping +
5 no_page_effect + 1 invalid_action = **236 exactly**, which is the printed
number. The diff arm's 65 (of 163 non-ok) is a real measurement of
resync-window fragility; the re-dump arm's 236 is an arm-invariant identity.
The 65-vs-236 line must not appear in any claim as evidence of re-dump resync
fragility. (The inversion itself survives without it — §3 — on statistics
that are actually comparable.) Report fix for the next wave: print the
post-resync line for the diff arm only, or compute the re-dump analogue over
a window defined by *engine epochs*, not observation kinds.

### 0.3 There is no size-sweep Tier A curve to reconcile with

`bench/size/results.jsonl` does not exist, `bench/RESULTS.md` has no sweep
section, and `git log --all -- bench/size*` shows only the harness landing at
`f4cd2e2`. Tier A runs inside `size.mjs --selftest` and has never been run to
a recorded artifact. §4 therefore states what the sweep must answer, not a
reconciliation with a curve nobody has produced.

Minor: the store's `promptHash` has 5 distinct values. That is correct, not
an alarm — it is the hash of each **task** prompt, per-task and verified
identical across arms for all five tasks; the run-log header's
`e4ddb5e1b6f1df2d` is the SYSTEM_PROMPT hash, which is arm-blind by code read
(task.mjs:356-371, 809-846: same string, same `maxTurns = maxSteps + 6`, no
arm-conditional anywhere in the driver).

---

## 1. The G3 trip — ruling: classification artifact, not contamination

### 1.1 The episode, verified in the store

`queue-resync [redump] run11` (store line 92; the run log's [42/180]):
19 observations — 18 classified `full`, 1 classified `other`; `obsSeq`:

```
s:full a:full a:full a:full a:full s:full a:other a:full ... a:full   (12 more a:full)
```

The `other` is act 4, a `key` action with `ref: null`, attribution
`invalid_action`, reply recorded in `unclassified` as
`{"tool":"browser_act","head":"error: unsupported key: F5"}` — and the head
IS the whole text: `unclassified.head` keeps up to 240 chars and this one is
26. The agent, three wrong rejects into the episode, pressed F5 — it tried to
refresh the page. The episode continued normally (13 more acts, all replied
with full snapshots), failed on the merits (wrong=3, all `wrong_choice`), and
its dollars are in the pot.

### 1.2 Why this reply carries zero page bytes, in both arms, by construction

The code path is dispatch-free and arm-blind:

- `src/core/snapshot/act.ts:491` — `pressKey` throws
  `unsupported key: ${key}` from a fixed key map, **before any CDP
  dispatch**.
- `src/mcp/tools.ts:660-667` — the `key` branch catches it and returns
  `error: <message>` bare. The `wantFull` flag (the arm forcing) is consulted
  only at `observe()` call sites (tools.ts:672, 720, 761, 837, 915); this
  return precedes every one of them. No observation was produced; the harness
  records the reply text as an "observation" anyway (proxy.mjs:329-330,
  unconditional `recordObservation`) and the shape predicates
  (streamModel.mjs:301-313) correctly match nothing → kind `other`.
- The identical act in the diff arm produces the identical 26 bytes. G3
  (task.mjs:1900-1910) only inspects the re-dump arm, so a symmetric event
  trips an asymmetric guard.

Contrast with the errors that *look* similar but never trip G3: a stale-ref
act gets `error: eN could not be acted on (gone).` **plus a fresh
observation** (tools.ts:720-727, 761-763) — under the re-dump forcing that
attached observation is a FULL SNAPSHOT, so all 110 re-dump
`model_bookkeeping` error replies in this store classify `full` and are
G3-clean. Only the dispatch-free validation vocabulary (`unsupported key`,
`key required`, `text required`, `option required`, `not a known element`,
the obstruction refusal) returns bare single-line text. That is why one
episode tripped in 230 rather than ninety.

### 1.3 Ruling and disposition

**An engine validation error with zero page bytes is not an observation of
the page, and arm purity is a property of page observations.** G3's trip here
is a taxonomy gap: the guard's whitelist stance ("anything unclassified is
where a diff would hide") is correct, and this text is not unclassifiable —
it is a third, fully-understood kind that the taxonomy lacks.

- **The episode stays in the pool, as a failure, with its wrong-el count** —
  intention-to-treat, and consistent with wave 2's handling of
  `catalog-revive diff run15` (`error: text required for type`, agent error,
  episode kept). A lost turn from the agent's own invalid input is arm
  behavior, not apparatus.
- The headline verdict is computed **out of band** (§2), per the wave-2
  precedent (wave2-evaluation §0.1): the shipped suite cannot print a verdict
  on this store, and repairing G3 moves `codeVersion` and severs the store —
  the integrity design working as built.
- §2 computes every defensible disposition; none changes the verdict class.

**Distinguished from the wave-2 ruling, deliberately.** Wave 2's G3 trip rode
on *wedged* episodes (walk timeouts, plus an `unsupported key: s` inside a
dead-browser episode): apparatus fault, absent measurements, resolved by
quarantine — and G6b now guards that class preregistered. Wave 3's trip is a
*healthy* episode and an *agent* fault: a present measurement, resolved by
classification. The unifying principle: G3 protects "the re-dump arm observed
only full restatements of the page"; the apparatus-fault route out is G6b
quarantine, the agent-fault route out is the `error` kind below. Neither
route ever excuses a reply that contains page-shaped bytes.

### 1.4 The spec-ready G3 fix (next cohort-severing bundle — no code now)

1. **New observation kind `error`** in `recordObservation`
   (bench/lib/proxy.mjs): after the three shape predicates fail, classify
   `error` iff the text starts with `error: ` **and contains no newline**.
   Rationale for the single-line constraint: every dispatch-free validation
   reply in tools.ts is one line (page-authored interpolations pass through
   `quote()`, which strips newlines — tools.ts:730-737), while every reply
   that embeds page content is multi-line with an `untrusted(...)` envelope
   whose observation matches a shape predicate. A multi-line or shape-bearing
   oddity still lands in `other` and still trips G3 — the whitelist property
   is preserved exactly where it matters.
2. **G3 predicate unchanged** over `{diff, nochange, other}`; kind `error` is
   excluded. G3's message gains: *"A single-line `error:` reply carries no
   page representation and both arms can receive it identically; it is
   recorded as kind `error` and does not bear on arm purity."*
3. **Align the G2 pre-flight arm-purity check** (task.mjs:997) with report-G3:
   it currently tests only `diff|nochange` and would miss an `other` that the
   scored-run G3 catches. Same predicate, one definition, both call sites.
4. **G4's denominator** (task.mjs:1952) drops `error` (and should drop
   `other`): an error reply is not an observation, and counting it dilutes
   the diff-share floor. Numerically irrelevant this wave; wrong on
   principle.
5. **Tests** (test/benchAttribution or a new streamModel unit):
   `"error: unsupported key: F5"` → `error`;
   `"error: e3 could not be acted on (gone).\nThe page as it stands now:\n…FULL SNAPSHOT #4…"`
   → `full`; wave-2's `"could not read the page (walk timed out)"` → `other`
   (unchanged — and such an episode is G6b-quarantined anyway, preserving the
   wave-2 semantics end to end).

Note `ep.done` / step-budget refusals never reach `recordObservation` (early
returns, proxy.mjs:311-315) — the fix concerns upstream replies only.

---

## 2. The preregistered verdict over the discriminative stratum

Computed with `propDiffCI` / `meanDiffCI` / `wilson` /
`smallestDetectableDrop` (seed 20260731, the suite's own). n = 105/arm
(35/task/arm across the three discriminative tasks — the interim TRIM,
§2-disclosure 6). Guards first, over the post-quarantine rows: G6b quarantine
**empty** (0 episodes; symmetry trivially holds); G5 0 unloaded; G6 0 ghosts;
G9 sonnet-5 served; G11 **0 truncated observations in 230 episodes**; G4
diff share 81.3% (floor 60%); G7 11,075 < 15,240 chars/ep; G8 105 ≥ 30; G10
69.5%/63.8% vs the 98% trigger — clear. G3 is the §1 ruling. Canary gate
20/20, in no interval.

```
ANALYSIS A — the store as recorded, F5 episode included (the headline)
success  diff    : 73/105 = 69.5%  [60.2%, 77.5%]   (Wilson)
success  re-dump : 67/105 = 63.8%  [54.3%, 72.4%]
success  delta   : +5.7pp   95% CI [-7.0pp, +18.1pp]   (Newcombe)
wrong-el diff    : 0.933/run      re-dump : 1.143/run
wrong-el delta   : -0.210/run  95% CI [-0.705, +0.286]   (bootstrap, seeded)
MDE vs the -10pp bound at this n: ~23.5pp
per-task tripwire (blocks PASS at CI lower > +1.0/run):
  queue-positional  -0.143  [-0.429, +0.143]
  twin-queues       -0.114  [-0.486, +0.257]
  queue-resync      -0.371  [-1.543, +0.771]        — none tripped
```

Rule application, verbatim from the preregistration: success CI lower −7.0pp
≥ −10pp → primary holds. Wrong-el CI upper +0.286 ≤ +0.40 → co-primary
holds. No per-task tripwire. **PASS (exit 0).** Margin clearance: success
+3.0pp, wrong-element 0.114/run — above the printed 2pp thin-PASS threshold,
but near it; reported as close, on purpose.

Sensitivity (preregistered): no discriminative task was 10/10 in both arms
over its first ten runs (queue-positional went 32/35 / 30/35 with early
failures in both arms), so the ceiling checkpoint retired nothing and the
sensitivity line is identical to the headline.

**The F5 disposition cannot change the verdict class — computed, not
assumed.** Every defensible reading:

| disposition | success delta (Newcombe 95%) | wrong-el delta (bootstrap 95%) | verdict |
|---|---|---|---|
| A: as recorded (fail, wrong=3), n=105/105 | +5.7pp [−7.0, +18.1] | −0.210 [−0.705, +0.286] | **PASS**, clearance +3.0pp / 0.114 |
| B: episode excluded, n=105/104 | +5.1pp [−7.6, +17.6] | −0.192 [−0.689, +0.305] | **PASS**, clearance +2.4pp / 0.095 |
| C: scored as re-dump success, wrong=0 (maximally adversarial) | +4.8pp [−7.9, +17.2] | −0.181 [−0.676, +0.314] | **PASS**, clearance +2.1pp / 0.086 |
| G3 enforced as written | — | — | INFRA, no verdict printed; scoring goes out of band exactly as wave 2's did |

### RESULTS.md-ready text (headline, then mandatory disclosures)

> **Wave 3 — PASS.** "On this 3-task positional-identity suite (post-P1
> engine) with claude-sonnet-5, no diff-bookkeeping penalty larger than 10pp
> in task success or +0.4 wrong-element actions per run was found."
> At n=105/arm the smallest true drop this run could distinguish from the
> −10pp bound is about 23.5pp. Margin clearance: success CI lower −7.0pp
> clears the bound by +3.0pp; wrong-element CI upper +0.286 clears +0.40 by
> 0.114/run.

> MARGIN PROVENANCE. The −10pp bound is wave 3's preregistered PRIMARY and is
> the same number wave 2 carried as a secondary; it was frozen before any
> wave-3 episode ran (run-log preregistration block, printed before the
> pilot). The wave-2 −5pp/"parity" vocabulary is retired — unreachable at
> any affordable n off the ceiling, and wave 2 cleared it by 0.25pp only via
> a post-hoc quarantine. The +0.4/run wrong-element bound replaced the pooled
> +0.2/run with the arithmetic in wave2-evaluation §4.2. The realized n is
> 105/arm, not the designed 135: the preregistered interim rule fired TRIM at
> the pilot ($0.374/ep > $0.35, a cost condition, blind to the arm delta) and
> capped later phases at −−n 35. At the observed rates that widened the CI
> half-width to ~12.6pp against the ~9.8pp projected at full quotas; the PASS
> stands on the realized interval, not the projection.

> Disclosures, all mandatory beside any citation:
> 1. `report()` exits 3 INFRA on this store: G3 reads one re-dump observation
>    as arm contamination. The observation is a 26-byte engine validation
>    error (`error: unsupported key: F5`) carrying zero page bytes, produced
>    on a dispatch-free code path the arm forcing never touches; the ruling
>    and spec fix are in wave3-evaluation §1. This verdict is computed out of
>    band with the suite's own stats code; the verdict class is PASS under
>    every disposition of that episode (included / excluded / flipped to
>    success).
> 2. Direction: the point estimates favor diffs (+5.7pp success, −0.21
>    wrong-el/run, fewer wrong-element on all three tasks), but every CI
>    includes zero. Directional colour, not a finding; the licensed claim is
>    the bound above and nothing stronger.
> 3. Cost: the diff arm cost MORE in dollars — $0.3622 vs $0.3470/episode
>    (+4.4%) at 0.73× the observation bytes (11,075 vs 15,240 chars/ep). The
>    wave-1/-2 inversion persists at ~3× wave-2's observation volume; the
>    crossover remains the size sweep's question (§4).
> 4. Canaries 20/20 in both arms. They license exactly one sentence: the
>    apparatus and easy-task floor held. Their numbers appear in no claim.
> 5. Apparatus: zero wedged episodes; G6b quiet; zero truncated observations;
>    zero dead clicks/types (six no-page-effect scrolls, witness-silent by
>    design). The single GPU-pid transition in the report is the pilot→full
>    app restart between two Aperture instances, not a crash (wave3-evaluation
>    §0.1); within each instance the GPU process creationTime is constant
>    across all 230 samples.
> 6. Comparisons with wave 2 are directional narrative only — different
>    engine (post-P1), different tasks, never pooled, never CI'd.

---

## 3. The inversion, interrogated — it survives; here is the mechanism

The fear was diffs losing; the data shows re-dump behind on every surface.
Before blessing it, every non-strategy explanation was checked against the
store:

| check | result |
|---|---|
| step budgets | identical by construction (same task defs; `maxTurns = maxSteps + 6` arm-blind). Observed: cap-hit episodes 7 diff / 8 re-dump; steps 18.9 vs 19.6 on queue-resync; max 24 both. Symmetric. |
| prompts | SYSTEM_PROMPT arm-blind (code read); per-task promptHash identical across arms, all 5 tasks; toolsHash 1 distinct; armDefinition stamps are exactly the two expected strings. |
| budget truncation (wave-2's fairness-bug class) | `truncatedObs` = 0 over all 230 episodes; G11 quiet; `inject`/`budgetTokens` never used by task.mjs (proxy.mjs:257 — size-sweep only). Re-dump full snapshots run ~1.2–1.3k chars against the ~8k default budget; the largest re-dump episode totals 31,171 chars over 24 observations. **No re-dump observation approached a truncation ceiling; failure-clustering-under-truncation is moot because the truncation count is zero.** |
| wedges / dead input | 0 quarantined; all six `no_page_effect` acts are scrolls (1 diff / 5 re-dump), ≤1 per episode, the known witness-silent action class. |
| SDK health | driverError 0; sdkSubtype `success` 210/210 stratum; declaredDone 105/105 both arms; G9 model served. |
| scoring symmetry | success judged from the fixture witness alone; wrongElement from witness bench-ids; both arm-blind. |

Nothing outside the observation strategy differs. The inversion is real, and
the failure anatomy says exactly where it comes from:

- **Stale-ref acts (`model_bookkeeping`): re-dump 110 vs diff 64** — 85 vs 50
  of them on queue-resync, all clicks. On these fixtures every act re-renders
  the list (`replaceChildren`), so every row is a new node with a new ref *in
  both arms*, every act. The arms differ only in how ref death is reported.
  The diff arm gets the P1 container-replace: `! eN replaced (gone: e8 e9 …)`
  — dead refs **named**, survivors and newcomers restated in a ~hundred-char
  scoped block (parser: streamModel.mjs:165-193). The re-dump arm gets a
  1.2k-char restatement in which nothing marks which refs died; its shadow
  model is cleared and rebuilt each turn (`FULL SNAPSHOT #` → `model.clear()`,
  streamModel.mjs:160-162), and the agent demonstrably re-uses last-turn refs
  it should have dropped — 110 times.
- **Wrong-ordinal clicks (`wrong_choice`): re-dump 120 vs diff 98** (per
  task: 10/5, 18/14, 92/79). The re-dump agent re-derives "currently 5th from
  the top" from a fresh dump every turn; the diff agent updates a running map
  it was explicitly told the deltas of.

That is the `gone:`-list hypothesis, confirmed at the wire level: **under
re-keying, explicit retirement beats restatement.** The honest boundary on
the claim: this is a statement about *Aperture's* re-dump semantics — full
restatement with re-keyed refs on re-rendered DOM — on removals-only
fixtures. A hypothetical full-dump mode with stable keys is a third arm
nobody ran; and the success CIs include zero, so the inversion licenses no
"diffs are better" sentence — it retires the specific fear that the diff
arm's bookkeeping burden was being subsidized by an apparatus bias, because
every apparatus channel checked came back symmetric.

(What does NOT support the inversion: the 65-vs-236 post-resync line — §0.2.
Strike it from the narrative.)

---

## 4. Costs — the inversion in dollars, and what the sweep must now answer

Diff arm $0.3622/ep vs re-dump $0.3470/ep: **+4.4% for diffs at 0.73× the
observation bytes.** Trend: wave 1 +5.2%, wave 2 +5.8% at 0.67×, wave 3
+4.4% at 0.73× and ~3× wave 2's observation volume. New this wave, from the
store: **turns are equal** (11.3/11.3, 16.2/15.9, 22.1/22.9 — diff *lower*
on queue-resync), so wave-1's "turn overhead" story no longer carries it.
The diff arm's premium at equal turns and fewer input bytes must sit in
voluntary observations (measured: 1.14–1.71/ep vs 1.11–1.51 — a residue of
defensive snapshotting survives tier1b's teaching fix) and/or generation-side
tokens — the diff arm's wall time is consistently longer (queue-resync 184s
vs 169s mean) at equal turns, which smells like longer reasoning per turn:
the bookkeeping tax paid in output tokens instead of errors. **The store
cannot decompose this** — it keeps `total_cost_usd` and `modelKeys` only.

The size sweep has not run (§0.3). What it must now answer, in order:

1. **The crossover band** (tier2 §4's operational definition, unchanged):
   at what full-snapshot weight does Δ$ cross zero, on this engine, where
   the wave-3 point (queue-class ~2k-char snapshots → +4.4%) now anchors the
   small end of the curve.
2. **The decomposition**: Tier B must persist per-episode `modelUsage`
   token splits (input / output / cache-read, per model), not just
   `total_cost_usd` — one field on the episode record, outside the watched
   set. Without it the input-weight vs generation-side question survives
   another cohort unanswered, exactly as it just did.
3. **Defensive snapshotting at scale**: does the diff arm's 0.2–0.4
   voluntary-snapshot residue grow with page size (each one costs a full dump
   plus a turn — at s4/s5 sizes that could dominate the diff arm's premium).

One stale obligation to amend when the sweep report is written: tier2 §4.2
requires stating the sweep's stamp "equals the wave-2 cohort's" — impossible
since tier3 moved the engine. The sweep runs at THIS stamp
(`05315affc1963c77`) and cross-cites wave 3; the tier2 sentence is a
documentation edit in the sweep's own PR (tier2 §4 licenses doc edits).

---

## 5. The GPU pid change — one paragraph, as asked

The pid transition 54540 → 50876 timestamped 2026-08-01T23:37:18.533Z is the
first scored episode of the full run reporting the *new* Aperture instance's
GPU process: the pilot's child exited 23:35:10.582Z
(`aperture.20260801T223029Z.log`, orderly), the full run's child started
23:35:41.406Z (`aperture.20260801T233541Z.log`) and its GPU process was
created 23:35:43.022Z (apparatus sidecar, `type:"GPU"` sample), with G1/G2
pre-flights and one 49-second episode filling the gap to 23:37:18. Nothing
died; what "relaunched" was the whole app, on purpose, between phases. Within
each instance the GPU pid and creationTime are constant across every sample
(50 + 180). No episode's behavior changes in the window — the last pilot
episode and the first full-run episode both PASSed at normal durations — and
no wedge followed because no crash preceded. Effect on the wedge
investigation: **none**; the hypothesis ranking of wave2-evaluation §6 is
unchanged, the instrumentation is proven live, and the §0.1 instance-stamp
fix stops this apparatus note from ever again presenting a restart as a
crash candidate.

---

## 6. Sequence — confirmed, with amendments

The coordinator's order (size sweep Tier B on this engine → prepend fix →
head-to-head) is right in outline. Amended and made concrete:

1. **Wave-3 preservation — now, $0.** Archive
   `episodes.jsonl` + `episodes.cohort.json` under a timestamp beside the
   wave-1/-2 pairs; tag `wave3-scored` at `6708162`; append the §2 RESULTS.md
   section (headline + margin provenance + all six disclosures, plus the §3
   mechanism paragraph and §0.2's strike-note). This document is the scoring
   record it cites.
2. **Size sweep at THIS stamp — before any watched-file edit.** Order from
   tier2 §4.1 unchanged: `--dry`, the exit-7 refusal-path exercise, then
   `--selftest` (which produces the first real Tier A table), then `--sweep
   --n 6`. `bench/size/**` is outside the watched set (tier1b acceptance 4:
   `--plan` shows codeVersion unchanged) so the sweep and wave 3 share
   `05315affc1963c77` and cross-cite cleanly. Add the §4.2 token-split field
   to the Tier B episode record (unwatched) and the tier2 §4.2 stamp-sentence
   doc edit. This step must precede step 3 because step 3 severs everything.
3. **One cohort-severing bundle, one rebuild** (house practice —
   wave2-evaluation §7 step 3 precedent): the prepend/rebinding engine work
   (tier3 §3.1's open hole: walker-side rebinding detection so an inserted
   identical row cannot silently retarget every ordinal ref), PLUS this
   evaluation's harness items authored in the same set: the §1.4 `error`
   kind + G3/G2-precheck/G4 alignment + tests; the §0.1 apparatus instance
   stamp; the §0.2 post-resync fix. Full battery per tier3 §6.
4. **Head-to-head** on the post-bundle build. headtohead.md §10 confirms it
   has no stamp-sharing requirement and pins whatever build it measures — so
   it runs *after* the prepend fix by choice, not necessity: the fix is
   coming regardless, real-shaped pages insert rows, and measuring a build
   already scheduled for replacement is the exact waste wave2-evaluation §7
   declined once already.

Not in the sequence, recorded so its absence is a decision: no wave-3.5 on
these fixtures. The suite did its job — off-ceiling, discriminative, verdict
delivered under the preregistered rule. The next task-success evidence
should come from the head-to-head's realistic-weight fixtures, not a fourth
pass over queue variants. (Flag for that design: queue-resync's absolute
level — 15/35 and 12/35 — is low in both arms; a harder-still suite risks
the interim rule's <60% stop. The margin arithmetic above already absorbed
this wave's 63.8%; the next one should not bet on absorbing 50%.)

---

## What wave 3 settles, and what it cannot

Settled: the −10pp bound holds on an off-ceiling, preregistered,
quarantine-free store, under every disposition of its one disputed episode —
the claim wave 2 could only make with an asterisk. The G6b design is
vindicated by silence (zero quarantines, canaries clean). The wrong-element
co-primary holds with the sign pointing the other way.

Not settled, permanently for this store: whether diffs *help* (every CI
includes zero; MDE ~23.5pp — a true penalty smaller than that is invisible
here); the dollar decomposition (no token splits recorded); the wedge's root
cause (nothing wedged, so nothing new to learn); anything about
insert-mutation pages (excluded by construction, tier3 §3.1); anything about
other models or real websites (claude-sonnet-5 on fixtures, stated every
time).
