# Wave-2 evaluation and contamination ruling — 2026-08-01

Independent evaluation of the interrupted wave-2 task-success run (251 episodes,
$37.34, killed before the verdict printed) and adjudication of the six
wedged-browser episodes. Method: every number below was recomputed from
`bench/task/results/episodes.jsonl` per episode, verdicts recomputed through
`bench/lib/stats.mjs` (the suite's own interval code), sources read at
`f4cd2e2` (HEAD moved to `e4a7d4b` mid-evaluation — a docs-only commit; the
watched set is byte-identical: current codeVersion `32e345badf143aec` and
buildVersion `afc408d7b0895342` both match the cohort sidecar exactly). One
live probe was run against the existing build (minimize/restore input test;
processes torn down, ports verified free afterwards). No source file was
edited, nothing was rebuilt, no scored episode was run.

Every number in the coordinator's clean-only standings table was verified and
is **correct to the digit** (120/123 vs 119/122; wrong-el 8 vs 4; $0.1476 vs
$0.1395/ep; 3,652 vs 5,475 obs chars/ep; vol-obs 0.58 vs 0.07; the per-task
success and wrong-el splits all match). The coordinator's *reading* of what the
suite did and what the store licenses is wrong in two load-bearing places, so
those come first.

---

## 0. Two corrections to the framing, before the rulings

### 0.1 The suite did not "score six wedged episodes as legitimate arm failures" — it refuses to score this store at all

`report()` over the 251-episode store does not print a verdict. Two of the
wedged re-dump episodes carry `kinds.other > 0` (the `walk timed out`
responses in `vault-code redump run17`, and `error: unsupported key: s` in
`catalog-revive redump run17`), and G3 (`bench/task.mjs:1502-1510`) treats any
non-FULL observation in the re-dump arm as arms-mislabelled → **exit 3 INFRA,
no verdict**, with the message "The arms are not what they claim to be" — a
misdiagnosis pointing at the harness when the truth is a wedged app.

It follows that **there is no path on which the shipped suite ever prints a
wave-2 verdict**:

- `--report` on the store as-is → INFRA (G3).
- Any edit to `bench/task.mjs` or `bench/lib/proxy.mjs` to fix that → moves
  `codeVersion` → `checkIntegrity` refuses the whole store (exit 6). The
  integrity design is working exactly as built: the suite cannot be repaired
  and then aimed at episodes recorded before the repair.

The wave-2 verdict must therefore be produced **out of band** — a scoring
script over the archived store, its rule stated, its numbers recorded in
`bench/RESULTS.md` — whichever option in §7 is taken. This evaluation is that
scoring.

### 0.2 The clean 245-episode set is PARITY under the preregistered primary rule — the exclusion decision decides the verdict class

Recomputed through the suite's own `propDiffCI`/`meanDiffCI`/`wilson`:

| analysis | success delta (Newcombe 95%) | wrong-el delta (bootstrap 95%) | primary (−5pp) | secondary (−10pp) | G10 ceiling |
|---|---|---|---|---|---|
| clean 245 (`pageActions > 0`) | +0.0pp, CI **[−4.8pp, +4.8pp]** | +0.03, CI [−0.04, +0.12] | **PARITY** | holds | no (97.6/97.5 vs 98) |
| full 251, G3 waived | +0.0pp, CI [−5.8pp, +5.9pp] | +0.03, CI [−0.05, +0.13] | fails | **holds** | no |
| full 251, as shipped | — | — | **INFRA, no verdict** | — | — |

The exclusion is not a cosmetic cleanup: it moves the CI lower bound from
−5.8pp to −4.75pp, across the −5pp margin. PARITY on the clean set clears the
margin by **0.25pp** and escapes the G10 ceiling by **0.44pp** (97.56%/97.54%
vs the 98% trigger). Both fragilities are stated wherever the parity result is
cited (§3).

---

## 1. The guard gap — decision and specification

**Decision.** "Zero page actions" is the wrong predicate on both sides: it
misses the partial wedge (three real actions, then the input path dies) and it
would not even have been consulted here (G6 conditions on *success*). The
right signal is **per-act**: an action the browser acknowledged `ok` that
produced no witness event. The wave's own data gives perfect separation:

- Across all 245 clean episodes, the number of `click`/`type`/`clear` acts
  attributed `no_page_effect` is **zero**. (The single clean `no_page_effect`
  is a `scroll` in `queue-positional redump run13` — scroll/hover/key
  legitimately produce no witness event, which is why the raw
  `no_page_effect` *rate* is the wrong predicate too.)
- In the six wedged episodes it is 5–11 per episode.

`walk timed out` is a sufficient but not necessary companion signal: the first
wedged episode (`queue-positional redump run17`) contains **no** walk timeout —
the walker stayed healthy and served 15 full snapshots of an untouched page
while every click died. A timeout-only predicate misses the wedge's onset
episode; a dead-click predicate catches all six.

**Specification (exact).** Three parts: a per-episode quarantine predicate, a
runtime liveness canary, and report-time handling. Numbered **G6b** (G6 —
success with zero page actions — stays as-is and is renamed G6a in prose only).

1. Episode stamp — in `runEpisode`'s return, alongside `attributions`:

```js
apparatus: {
  // ok-acknowledged element actions the witness never saw. Scroll, hover and
  // key are excluded: they legitimately produce no witness event, and the one
  // clean-episode no_page_effect in wave 2 was exactly such a scroll.
  deadActs: ep.acts.filter((a) =>
    ['click', 'type', 'clear'].includes(a.action) && a.attribution === 'no_page_effect').length,
  walkTimeouts: ep.observations.filter((o) =>
    /could not read the page \(walk timed out\)/.test(o.text)).length,
},
```

2. Quarantine predicate (report side, recomputable from `acts` for stores
   that predate the stamp — it identifies exactly the six here):

```js
// G6b — apparatus-wedge quarantine. An episode whose acknowledged clicks or
// types produced no witness event TWICE or more, or that contains a
// walk-timeout observation, measured a wedged browser, not an arm. One dead
// act is tolerated and counted: the known ~1-in-450 ok-click flake (wave-1
// limitations) must not quarantine a real episode.
const isWedged = (r) =>
  (r.apparatus?.deadActs ?? deadActsFrom(r.acts)) >= 2 ||
  (r.apparatus?.walkTimeouts ?? 0) > 0;
```

3. Handling — **quarantine the episode AND abort the run**, in that order:
   - The episode is stored with `quarantined: 'apparatus_wedge'`, excluded
     from every guard (G3–G7, G10) and from the verdict arithmetic, and
     reported in its own table with per-arm counts. It is not deleted and its
     resume key stays occupied — a quarantined slot is re-run only under
     `--new-cohort`.
   - Immediately after any episode with `deadActs >= 1` or `walkTimeouts >= 1`
     — and unconditionally **before every episode** — the runner performs a
     no-API-budget **liveness canary**: navigate to a canary fixture, one
     scripted click through `proxy.direct`, witness event required within 2s.
     Canary failure → **abort the run, exit 3 INFRA**, store preserved, with
     the message naming the wedge rather than the arms. Cost of the canary at
     280 episodes: ~2–3s each, ~12 minutes per full run; the wedge burned
     $2.16 and 46 minutes producing garbage, and the canary bounds any
     recurrence to one episode.
   - Report-time symmetry guard: if per-arm quarantine counts differ by 3 or
     more, the whole run is INFRA (`the wedge fell on one arm; the comparison
     is confounded`). Wave 2 is 3/3 — symmetric.
   - G3's guard text gains one sentence so the misdiagnosis cannot recur:
     `If these episodes also satisfy G6b, the fault is the apparatus, not the
     arm forcing — see the quarantine table.`

These edits touch `bench/task.mjs` and `bench/lib/proxy.mjs` — both watched.
They are part of the single cohort-closing bundle of §7, not a standalone
change.

---

## 2. Is post-hoc exclusion legitimate here? — YES, with a mandatory disclosure package

**Ruling: the exclusion is legitimate.** Three independent grounds, each
verified against the store:

1. **These are absent measurements, not unfavorable ones.** In all six
   episodes `loaded: true` — the fixture's own JavaScript ran and its load
   ping reached the collector — while zero action events arrived over
   464–839-second episodes, and Aperture's *own* observations agree (the diff
   arm reported `(unchanged`, the re-dump arm returned byte-stable full
   snapshots of an untouched page). Two independent witnesses concur that no
   action ever reached the page. An episode in which no action can land
   contains zero bits about the variable under test; scoring it as an arm
   failure is not conservatism, it is noise injection.

2. **The blind counterfactual is exact.** The six are the *terminal
   contiguous block* (store lines 246–251); there is no wedged episode
   anywhere in lines 1–245 (the quarantine predicate of §1 fires on exactly
   the last six and on nothing else). Had G6b existed before the run, the
   canary would have aborted at episode 246 and the store would contain
   **exactly the 245 episodes the exclusion keeps**. The exclusion is a
   truncation at an apparatus failure, not a selection among failures. And the
   stopping point was forced by the wedge, which cannot see the arm delta —
   so the early stop introduces no optional-stopping bias into the
   comparison.

3. **Every available analysis of this store is post hoc.** Including the six
   requires *waiving G3*, a preregistered guard — also a post-hoc analysis
   choice, and one that knowingly averages a dead browser into the arms.
   There is no preregistration-clean reading of this store. Quarantine with
   disclosure is the least-distorting of the available post-hoc choices.

**The general predicate that would have been written blind** is §1's G6b,
verbatim: *an episode is an apparatus failure, excluded from the verdict and
counted per arm, when two or more acknowledged element actions produced no
witness event or any observation reports a walk timeout; asymmetric exclusion
across arms voids the run.* Nothing in it references success, the arm, or the
delta.

**The prosecution's point is nevertheless conceded where it bites**, and it
becomes the disclosure package that must travel with any wave-2 citation:

1. The exclusion rule was written after the episodes it excludes were seen,
   and **it decides the verdict class** (INFRA/secondary-only → PARITY). Any
   statement of the parity result must carry this sentence: *"PARITY holds on
   the quarantined set under a quarantine rule written post hoc; with the six
   wedged episodes included the success CI is [−5.8pp, +5.9pp] and only the
   −10pp secondary bound holds."*
2. The parity margin is cleared by 0.25pp and the ceiling guard avoided by
   0.44pp (§0.2). The verdict class is not robust to ±1 episode flipping in
   either arm.
3. Wave 3 runs G6b as a preregistered guard, which retires this entire class
   of adjudication.

Because of disclosure 1, the **headline** of wave 2 is the secondary sentence
(it holds under *every* analysis of this store — quarantined, included, or
waived); the parity sentence is reported beneath it, conditionality stated.
That is the ruling, not a menu.

---

## 3. The verdict over the 245 clean episodes, as `report()` would compute it

Recomputed with the suite's own stats code; guard sweep over the clean set
passes everything `report()` checks: G3 0 offenders · G4 diff share 82.3%
(floor 60%) · G5 0 unloaded · G6 0 ghosts · G7 3,652 < 5,475 chars/ep ·
G8 n≥5 · G9 sonnet-5 served · G11 0 truncated · G10 not triggered
(97.56%/97.54%, trigger 98/98).

```
success  diff    : 120/123 = 97.6%
success  re-dump : 119/122 = 97.5%
success  delta   : +0.0pp   95% CI [-4.8pp, +4.8pp]   (Newcombe)
wrong-el diff    : 0.065/run      re-dump : 0.033/run
wrong-el delta   : +0.03/run  95% CI [-0.04, +0.12]   (bootstrap, seeded)
MDE vs the -5pp margin at this n: ~12.0pp
```

Primary rule: CI lower −4.75pp ≥ −5pp AND wrong-el upper +0.12 ≤ +0.2 →
**PARITY (exit 0)**. What that licenses, in `report()`'s exact template with
the numbers filled in:

> "On this 7-task fixture suite, with claude-sonnet-5, agents observing via
> diffs completed tasks +0.0pp as often as agents observing via full re-dumps
> (95% CI [−4.8pp, +4.8pp]), with +0.03 wrong-element actions per run
> (95% CI [−0.04, 0.12]), at 0.67x the observation cost."
> It says nothing about other models, real websites, longer tasks, larger
> pages, the budget-truncation regime, browser_read workflows, or iframes.

— reported **with** the §2 disclosure package and the margin-provenance block
(which prints with every wave-2 verdict by design).

The **secondary** sentence, which holds on every analysis of the store and is
therefore the recommended headline:

> "On this 7-task bookkeeping-hard suite with claude-sonnet-5, no
> diff-bookkeeping penalty larger than 10pp was found."

**The n shortfall (123/122 vs the designed 140/arm) does not change what is
claimable.** At the observed rates, 140/arm projects a CI of [−4.2pp, +4.2pp]
— same verdict class, ~0.6pp narrower. The stop was apparatus-forced, not
data-driven, so it biases nothing; its only cost is CI width. The honest power
statement is unchanged in kind: a true diff penalty smaller than ~12pp is
invisible to this sample (design-N would have made that ~11pp — the primary
was underpowered by construction either way, exactly as the preregistration
block predicted).

Two further disclosures that belong in the RESULTS.md section:

- **Cost:** the wave-1 inversion narrowed but did not close: $0.1476 vs
  $0.1395/ep (+5.8% for diffs) at 0.67x the observation bytes. The tier1b
  teaching fix measurably moved behavior — diff-arm voluntary observations
  0.80 → 0.58/ep, nochange 0.36 → 0.28/ep, diff share 73.7% → 82.3% — so the
  trust hypothesis was directionally right and incomplete. The crossover
  remains the size sweep's question.
- **G9 blind spot:** every episode's `modelUsage` contains
  `claude-haiku-4-5-20251001` alongside `claude-sonnet-5` (251/251, arms
  symmetric 126/125) — the SDK's auxiliary model. Cost figures include it; G9
  passes because it only checks the requested model *appears*. No arm bias,
  but G9 cannot catch a partial wrong-model serve; note it.

---

## 4. The wrong-element gap and the one-task suite — ruling

Verified: all 12 wrong-element acts (8 diff, 4 re-dump) are `wrong_choice` in
`queue-positional`; the six queue failures are exactly the six episodes with a
wrong-element act; the other six tasks are 210/210 across both arms.

```
queue-positional only:  success 15/18 vs 14/17   delta +1.0pp  CI [-24.3pp, +26.7pp]
                        wrong-el 0.444 vs 0.235  delta +0.209  CI [-0.301, +0.824]
everything else:        105/105 vs 105/105 in both arms
```

**Ruling: for the success metric, wave 2 is functionally a 1-task experiment
wearing a 7-task CI.** Three specific consequences, all verified:

1. **The pooled escape from G10 is entirely queue's doing.** Six of seven
   tasks re-ceilinged; the pool sits at 97.6/97.5 only because queue drags
   both arms down symmetrically. The 210 ceiling episodes contribute no
   discrimination; what they contribute is *variance shrinkage* — they are
   why the pooled CI ([−4.8, +4.8]) fits inside a margin the queue-only CI
   ([−24, +27]) misses by a mile. The PARITY of §3 is, mechanically, "six
   tasks that cannot fail, plus one task where the arms differ
   insignificantly." That is not invalid — it is what the preregistered
   pooled rule computes — but it must be said in those words.
2. **The pooled margins are ~7x looser per informative episode.** A true
   queue-only success drop of X pp pools to X/7; the +0.2/run wrong-element
   margin would require queue alone to hit +1.4 wrong-el per episode. Wave 1's
   lesson was pooling hiding a sign change; this is the mirror: pooling
   diluting the only live signal. The margins were preregistered against a
   suite assumed hard across the board, and the assumption failed 6/7.
3. **The `identity_mismatch` category is structurally unreachable in the one
   fixture built for it.** `labelsAgree` (proxy.mjs:168-173) compares labels,
   and queue's labels are identical by construction — a stale ordinal landing
   on the wrong row agrees on "Approve"/"Reject" every time and falls through
   to `wrong_choice`. tier1b's acceptance note ("the first fixture where
   identity_mismatch can actually occur") is wrong as built: on this fixture
   it can never occur. The taxonomy still works — `wrong_choice` via the
   witness bench-id is the correct catch — but the design doc's claim should
   be corrected, and any future fixture that wants `identity_mismatch` live
   needs *distinct* labels over positional keys.

Also for the record: $26.73 of the $35.17 clean spend went to the six ceiling
tasks; $8.44 to the task carrying all of the signal. And the directional
2x wrong-element ratio (0.44 vs 0.24/run) is exactly the failure tier2b P1's
positional-replace escalation targets — but its CI spans zero; it is a hint,
not a finding.

**What wave 3 looks like (decisions, carried into §7):**

- **Suite = 3–4 discriminative L1-class tasks** (queue variants: two
  positional families on one page; interleaved insert+remove — which also
  forces the `nth`-solver constraint to be revisited; a 12-row queue with a
  mid-task resync), each at **N≈40–60/arm**, plus **two retained ceiling
  tasks at N=5/arm as apparatus canaries** — their 100% is a per-run health
  check, not evidence, and is labelled so in the prereg.
- **Preregistered per-task gates:** any task at 100% in both arms after
  N=10/arm is declared ceilinged; its remaining budget reallocates to the
  discriminative stratum by a rule written in the prereg, not by judgement at
  peek time.
- **The primary is stratified:** success and wrong-element margins are
  preregistered **on the discriminative stratum**, with the ceiling canaries
  excluded from the pooled CI by design rather than by dilution. Wrong-element
  becomes a co-primary with a per-task margin (the pooled +0.2/run margin is
  retired with the arithmetic above cited as the reason).
- Wave 3 runs **after** tier2b Set B/C: P1 deliberately changes
  queue-class diff bytes, so running the redesigned suite before it would
  measure a build already scheduled for replacement.

---

## 5. The propDelta bug and `engine_ref_loss` — re-confirmed clean, with one attribution bug found

**Fixture exposure, final store:** `grep -i '<table\|href=' bench/fixtures/*`
matches nothing (all 13 fixtures + bench.js). No wave-2 mutation lands in a
field `propDelta` is blind to. Confirmed against the full final store: of the
251 episodes' observations, `a:nochange` (the bug's signature — an action
reported "unchanged") occurs **24 times, all 24 inside the three wedged
diff-arm episodes, zero in the 245 clean episodes** — extending the review
doc's 204-episode check to the whole store. And the wedge-time `a:nochange`
are *true* reports: the input never reached the page, so "the action caused
no visible change" is exactly what happened. The propDelta blind-field bug
touched none of wave 2. The tier2b P0 fix remains required for the product
and untangled from this cohort.

**`engine_ref_loss` decomposes into two artifacts, neither tier2b-related:**

- 3 of 6 are **misattributed invalid-argument errors**: `error: unsupported
  key: s` (wedged catalog episodes, both arms) and `error: text required for
  type` (clean `catalog-revive diff run15` — first act, agent retried,
  episode PASSED). The attribution rule `errored ? (shadowHad ?
  'engine_ref_loss' : 'model_bookkeeping')` routes every `^error:` through
  the ref test, and `shadowHad` defaults to `true` for ref-less acts
  (proxy.mjs:257). Exact fix, for the §7 bundle:

  ```js
  // proxy.mjs, doAct: a validation error is the agent's, not the engine's.
  if (errored) {
    attribution = !REF_ERROR.test(text) ? 'invalid_action'
      : shadowHad ? 'engine_ref_loss' : 'model_bookkeeping';
  }
  ```

- The remaining 3 are wedge-time refusals of refs the shadow legitimately
  held (`e128`/`e129` in both vault episodes) — the act path erroring while
  the walker still served snapshots, a wedged-renderer artifact. Nothing in
  tier2b's fix list produces errors: P0's blindness is silent, P1 concerns
  removals (none landed — zero page actions), P2 concerns label morphs
  (none exist in these fixtures). **After quarantine, the clean 245 contain
  zero genuine engine ref losses.**

---

## 6. Root cause of the wedge — partially resolved; the remainder is unverifiable from these artifacts, and here is what would settle it

**Established from the store (all verified):**

- The wedged Aperture instance was the *phase-2* instance, up from ~16:43Z
  (the only >60s idle gap in the store is the phase-1→2 restart at
  16:42–16:44). It ran 175 episodes healthy for ~110 minutes.
- Onset is **abrupt and mid-episode**: `queue-positional diff run17` PASSED
  normally at 18:32:27Z; `queue-positional redump run17`, started seconds
  later, recorded zero witness events over 464s. Per-wave mean durations are
  flat (30–56s across runs 0–16) — no creeping latency, which argues against
  gradual memory growth or timer accumulation.
- The failure is **input-path-only**, on three independent signals present in
  all six episodes: (1) `loaded: true` — the renderer navigated, page JS ran,
  and its load ping crossed the network to the collector; (2) the walker kept
  serving full snapshots (15 of them in the onset episode — no walk timeout
  there at all; the 5 timeouts, engine.ts:147's 5s cap, cluster on scroll
  observes in later episodes); (3) both the fixture's event log and
  Aperture's own diff/full observations agree that no click ever changed the
  DOM, while `browser_act` kept answering `ok`.
- The OS did not sleep: the System event log for 16:00–19:30Z contains no
  power, display, or session events — only unrelated UPnP/svchost and
  Windows Update noise.
- **The occlusion/minimize hypothesis was tested live on this exact build and
  is falsified**: with Aperture's window minimized, CDP clicks on
  `queue.html` still landed (four clicks → four diffs, pending 7→3,
  epoch resync on restore). Simple window occlusion does not reproduce the
  wedge.

**Not candidates, on this evidence:** the fixture server and collector (load
pings arrived throughout), machine sleep, gradual resource exhaustion, and
plain window occlusion. **The long queue episodes immediately preceding** are
position-correlated, not causally implicated: run15's slow queue pair
(196s/235s, ~20 min earlier) was slow-but-functional with full witness
streams, and one transient ref refusal in `catalog run15` is a possible
precursor but a single event supports no trend.

**Remaining candidates, undecidable from the artifacts:** a hung GPU/viz
compositor process (Chromium routes input hit-testing through viz; JS and IPC
walking are unaffected — this fits the signature best), a degraded CDP
debugger session (`sendCommand` resolving while dispatched events go
nowhere), or a renderer-side input-routing wedge. The artifact that would
have decided this — Aperture's stdout/stderr, where Chromium logs GPU process
death/relaunch — was captured in memory by `startAperture()` and **discarded**
(it prints only on startup failure).

**Instrumentation ruling (product reliability, not just bench):**

1. **Persist the child's log**: `startAperture()` writes stdout/stderr to
   `bench/task/results/aperture.<timestamp>.log`. One grep would have
   answered the GPU question.
2. **The G6b liveness canary (§1)** — bounds any recurrence to one episode
   and timestamps onset to ±one episode.
3. **Per-episode process metrics**: `app.getAppMetrics()` exposed on a debug
   endpoint, sampled by the runner per episode — catches GPU process PID
   changes (restart = crash), memory trends, and renderer churn.
4. **W1 — dispatch confirmation in the product** (the shipping fix): before
   CDP dispatch, the preload installs a one-shot capture-phase listener on
   the resolved target; if no corresponding event arrives within 500ms the
   act returns `error: input was dispatched but never reached the page`
   instead of `ok`. This converts the silent wedge into a loud first-act
   engine error, closes wave-1's "an `ok click` that did not land"
   limitation, and gives the bench a true `engine_input_loss` category. An
   agent product whose act path can say `ok` for 40 minutes against a dead
   page has a trust defect independent of any benchmark.

---

## 7. Next steps — the call, ordered, with costs

**The call is (c): stop at 245, report with the six disclosed and
quarantined.** Not (a), not (b).

- **Against (a) (fix guard, `--new-cohort`, re-run 280 now, ~$40/2h):** it
  re-runs a suite this evaluation just found to be 86% ceiling — $27 of every
  $35 goes to tasks that cannot discriminate — on a build tier2b Set B/C is
  about to invalidate, and pre-P1, so its only informative task measures
  diff behavior already scheduled for replacement. The re-run would be
  archived as obsolete within days. Pure waste.
- **Against (b) (resume the 29 missing, ~$5):** resume and repair are
  mutually exclusive — any guard fix moves `codeVersion` and severs the
  cohort — so the resume must run on the unfixed harness with the wedge risk
  live and unguarded. Its yield is ~0.5pp of CI width (CI [−4.2, +4.2]
  projected at design N) on a verdict whose claimability is capped by the
  exclusion disclosure and the one-task structure, not by n. And the store
  would still trip G3 at report time (the six wedged keys stay occupied), so
  the same out-of-band quarantine scoring is needed anyway. $5 for nothing
  the claim can use.

**Sequence for the remaining programme** (tier2b §5's ordering, amended by
this evaluation; one rebuild, one cohort bump for everything):

1. **Wave-2 preservation — now, $0.** Archive
   `episodes.jsonl`/`episodes.cohort.json` under a timestamp beside the
   wave-1 pair; tag `wave2-scored` at `f4cd2e2`; append the wave-2 section to
   `bench/RESULTS.md` — content: the §3 numbers, secondary sentence as
   headline, parity sentence with the §2 disclosure package, the quarantine
   table (six episodes, 3/3 by arm, predicate stated), the §0.1 note that
   the shipped suite exits INFRA on this store and why the scoring is
   out-of-band, the cost/teaching-fix movement, and the §4 concentration
   analysis. This triple is citable regardless of everything below.
2. **Set A (tier2b instrument work; bench+tests, no rebuild, ~$0)** —
   F1–F7, P3, churn.mjs — **plus this evaluation's harness items authored in
   the same set**: G6b + liveness canary + G3 message sentence (§1),
   `invalid_action` attribution (§5), Aperture log persistence and
   app-metrics sampling (§6), the G9/haiku disclosure note, and the tier1b
   correction from §4.3 (identity_mismatch unreachable on queue). Record the
   blindfields RED against the current build per tier2b F4.
3. **Set B+C (engine; ONE rebuild)** — P0 propDelta field-completeness + P4,
   P1 positional-replace escalation + fuzzyRescue deletion, **plus W1
   dispatch confirmation (§6)**. Full battery: tsc, vitest, build, fidelity
   ×6, guards G1–G13, `--selftest`. Everything after this is a new cohort by
   construction.
4. **Wave 3 (~$30–40, ~2h)** — the §4 redesign: discriminative L1 stratum at
   N≈40–60/arm, two ceiling canaries at N=5, per-task gates, stratified
   primary + per-task wrong-element margins, G6b preregistered. Prereg
   written and frozen before the pilot; `--new-cohort --n 5`, interim rule,
   then full.
5. **Size sweep** (`bench/size.mjs`, outside the watched set) — any time
   after step 3; it inherits the fixed product and answers the surviving
   cost-inversion question.
6. **P2 churn measurement → decision addendum; head-to-head after wave 3.**

---

## What wave 2 will never be able to settle, regardless of what happens next

1. **Whether a diff-bookkeeping penalty smaller than ~12pp exists on this
   suite.** The MDE floor is a property of n and the observed rates; no
   reanalysis moves it.
2. **Parity at −5pp without an asterisk.** The primary PARITY is forever
   conditional on a post-hoc quarantine that decides the verdict class by
   0.25pp, and sits 0.44pp from the ceiling guard on the other side. No
   amount of disclosure converts it into the clean preregistered PARITY the
   design wanted; only wave 3, with G6b preregistered, can produce that.
3. **Anything about the six wedged episodes' arms.** They are absent
   measurements; their $2.16 bought the guard specification and nothing else.
4. **The wedge's root cause.** Uninstrumented, log discarded, minimize
   falsified live; GPU/viz-hang vs CDP-session-degradation vs input-routing
   stays undecidable forever for this occurrence. The §6 instrumentation
   decides it for the *next* occurrence, which is the best available outcome.
5. **Whether the 2x queue wrong-element ratio (0.44 vs 0.24/run) is real.**
   Its CI spans zero, and the question as posed dies with this cohort: wave 3
   runs post-P1, where the mechanism it would measure has been deliberately
   changed. The pre-P1 ratio is permanently a hint recorded here.
6. **Where diffs stop costing more in dollars.** Wave 2 narrowed the
   inversion (+5.8%, from wave 1's +5.2% on easier tasks, with voluntary
   snapshots measurably reduced by the teaching fix) but the crossover's
   location belongs to the size sweep by design.
