# Post-tier5 head-to-head adjudication — the cohort tier5-ruling §7 owed — 2026-08-06

Status: RULING, final. This is the adjudication of the fresh head-to-head
cohort preregistered by `docs/design/tier5-ruling.md` §7 (which inherits
`docs/design/tier5.md` §9 and replaces its economics expectation), measured
against the preregistration EXACTLY as written there, before these numbers
existed. Store: `bench/headtohead/results/episodes.jsonl` — 385 episodes,
$97.17, 0 harness faults, 0 contaminated. Cohort identity: codeVersion
`dfa962c3f89b4d53` (the harness, **byte-identical** to the adjudicated
pre-tier5 cohort), buildVersion `0916e30fb90b1c02` (`out/main/index.js`
sha256 `5b00990a…`), git `3828b64`, tree clean, `@playwright/mcp@0.0.78`,
`claude-sonnet-5`, `pwObservationMode: inline`, `maxMcpOutputTokens: 50000`,
`pwBrowserOverride: chrome`. The pre-tier5 store it answers is archived at
`episodes.20260805T231456Z.jsonl` and is read here for comparison only —
never re-scored, never pooled.

Method: every number below was recomputed per episode from the store through
the suite's own code (`bench/lib/stats.mjs` `propDiffCI`/`meanDiffCI`, seed
20260802; `h2h.mjs`'s `meanRatioCI` and `decompose` re-derived verbatim with
the same seeds). The printed report (`verdict-post-tier5.txt`, exit 7)
reproduces **to the digit on every line checked**: the full per-arm/per-class
table, all three primary CIs, the H10 terms and all ten per-task shares, the
three-way decomposition, the affordance split, the wall-clock medians,
$97.17, 385, 0/0/0. No commit was made, no `src/` file edited, no scored
episode run; the only live activity was reading stores and the repo.

`report()` exits 7 on this store because the SHIM-SUSPECT tripwire flags
catalog-order again and the `--ruling` acknowledgement path was never built
(the harness was deliberately frozen — §0.1). The verdict is computed out of
band in this document, the wave-2/wave-3/h2h precedent. §6 is the ruling the
tripwire demands.

---

## 0. Corrections to the brief — the framing is wrong in four places

The coordinator's numbers are correct to the digit everywhere I checked.
Four *readings* need correction before the rulings, two of them load-bearing.

### 0.1 This is not "the post-tier5 build" — it is tier5 plus four security commits

§9.1.2 / §7 pinned the cohort to "the shipped post-tier5 build". The cohort
ran build `0916e30f` at `3828b64`: tier5 **plus** the four security commits
(`43440a1`…`3828b64` — sink closures, the alphabet rule, URL-surface
unification), which touched `src/core/snapshot/engine.ts`, `walker.ts`,
`text.ts`, `redact.ts` and `src/mcp/tools.ts` (~1,700 insertions). The
tier5-ruling's preamble ("every commit since is docs-only") was true when
written and falsified by landings afterward. So strictly, this cohort
measures {tier5 + security hardening} against {neither}.

**Ruled: the deviation is disclosed and does not vitiate attribution**, on
three measured grounds. (i) tier5's own mechanism files — `diff.ts`,
`registry.ts` — are **byte-unchanged** since the tier5 landing (`git diff
1d13e0b..3828b64` on both: empty); the security work in `walker.ts` is text
normalization (`stripFormat` on names/values), not identity or retirement.
(ii) The result carries tier5's exact designed signature — the landed-wrong →
refused-stale currency conversion of §2, which no security commit implements.
(iii) The cost movement is localized to precisely the cells tier5's mechanism
lives in (§4): aperture output tokens collapsed on the three queue tasks and
moved nowhere else; every neutral aperture cell is flat to within 4%.
Everything else in the apparatus is pinned byte-identical to the adjudicated
cohort — prompts, fixtures, tool schemas, seal, caps, observation mode,
browser override — so the engine build is the *only* treatment. But every
claim below describes the measured build `0916e30f`, and RESULTS must print
that hash, not "the tier5 build". (Housekeeping: the working tree has since
moved on — uncommitted WBA work, a rebuilt local bundle `4115dd9f…` — none of
it in the measured build; `src` at `3828b64` is identical to `src` at HEAD
`9798260`, a docs-only commit.)

### 0.2 H10 "MECHANISM CONFIRMED (was 46.7%, not confirmed)" is the same task wearing the same costume, inside out

The pooled share crossed the 50% bar (62.7%) **because of catalog-order, the
identical task that dragged it under the bar last time — in the opposite
direction**. pw-sealed's ten catalog failure loops re-dump ~503K chars/ep;
that one cell contributes most of the pooled +19,153-token obs term. Remove
it and the pooled share is **33.3%**; within neutral-large it is 43.4% with
the cell, **49.1%** without. The honest cross-cohort constant: where both
arms solve the page, observation bytes are about *half* the delta and the
turn term now runs *against* Aperture (−0.7 to −1.2 turns/ep — the loud
currency and the warm-revisit expand buy extra round-trips). "The fix
confirmed the mechanism" is not a licensed reading; §5 writes the one that is.

### 0.3 "+10.0pp (was +7.3pp)" is not an improvement claim — the genuinely new fact is robustness

The +10.0pp is still carried by catalog-order (+9.1pp of it; sealed 0/10,
aperture arms 20/20), and the CI touches zero (−0.3pp): **non-inferiority
only, no superiority claim, same as before.** What actually changed: the
mandatory minus-catalog sensitivity, which last cohort *straddled* the −10pp
bound (−2.0pp [−13.1, +9.1]), now **holds it**: +1.0pp [−9.2, +11.2]. The
bound no longer depends on the ruled cell. That — not the point estimate — is
the reliability news.

### 0.4 Home economics did not simply "move in a direction nobody predicted" — three-quarters of it is a measured mechanism, one quarter is the incumbent's noise

home 1.295× DEARER → 0.823× CHEAPER decomposes as: aperture-diff home
$0.2826 → $0.1935 (−31.5%) and pw-sealed home $0.2182 → $0.2352 (+7.8%).
Our side is attributable (§4: the output-token tax collapsed, engine-wide,
queue-tasks-only); their side is cross-cohort sampling drift and attributable
to nothing. The 0.823× CI upper is 0.975 — the licensed word is CHEAPER, said
thinly. Also: the §7 economics clause's letter ("diff ≥ redump on any neutral
fixture") brushes account-prefs, and pretending otherwise would be the kind
of quiet skip this programme exists to catch — §1.3 rules it, on the archived
store's own evidence.

(Minor, for the record: the "13-task set" of the older docs is and was 11
prompts — 5 home + 6 neutral; the harness header documents the drift and
`promptHashes` proves the set unchanged, hash-for-hash, from the adjudicated
cohort. And the precision delta's negative *sign* is partly pw-sealed's own
wrong clicks rising 8 → 12 by sampling; the licensed centerpiece is
Aperture's zero, not Playwright's 0.24.)

---

## 1. Ruling 1 — tier5 PASSES its preregistration; tier5.1 is NOT triggered

§7's terms, applied clause by clause, exactly as written:

| clause (tier5-ruling §7) | preregistered | measured | verdict |
|---|---|---|---|
| Precision bound (§9.2 verbatim) | pooled wrong-el CI upper ≤ +0.2 | −0.109 [−0.200, −0.036] | **HOLDS** |
| diff-arm home `wrong_choice` (was 27) at least halves | ≤ 13 | **0** | **CONFIRMED** |
| aperture refused-stale acts rise from 8 toward ~75 | ↑ | **90** (home diff arm) | **CONFIRMED** |
| redump improves in step; redump − sealed (was +0.27 [0.08, 0.49]) includes 0 | ~0 | −0.109 [−0.200, −0.036] | **overshot, favorably** (redump also 0 wrong-el; does not include 0 — see §2.4) |
| Reliability bound (§9.2) | pooled CI lower ≥ −10pp | +10.0pp [−0.3, +20.2] | **HOLDS** (by 9.7pp) |
| §9.3.1 revert (primary fails AND wrong_choice not halved) | — | neither obtains | **not fired** |
| §9.3.2 revert (bound fails via refusal loops) | — | bound holds | **not fired** |
| Economics: neutral-large worsens into ~0.31–0.46× | in band | 0.390× [0.338, 0.455] | **as predicted** |
| Economics failure (a): fresh neutral-large CI upper ≥ 0.5 | < 0.5 | 0.455 | **not fired** |
| Economics failure (b): diff mean cost ≥ redump on any neutral fixture | — | fires on **no cost-claimable** neutral fixture; brushes account-prefs — ruled §1.3 | **not fired** |

**Verdict: tier5 passed every operative clause of its own preregistration.
The economics-failure clause does not fire, so the tier5.1 (b′) cycle is NOT
mandatory. §9.4's claims freeze lifts: the failing precision sentence is
retired and replaced (§7–§8 below), and economics claims are restated from
this store only, with the shared-tab/warm-revisit disclosure and the home
number beside the neutral one, as §7 requires.**

### 1.1 The precision mechanism predictions, in full

Home-set act attributions, both stores, all four arms:

| arm | old: ok / wrong_choice / refused-stale | new: ok / wrong_choice / refused-stale |
|---|---|---|
| aperture-diff | 431 / **27** / 8 | 433 / **0** / **90** |
| aperture-redump | 421 / **38** / 14 | 433 / **0** / 86 |
| pw-sealed | 423 / 8 / 75 | 448 / 12 / 24 |
| pw-stock | 254 / 2 / 8 | 246 / 8 / 18 |

(refused-stale = `model_bookkeeping` + `engine_ref_loss` for aperture,
`stale_ref_error` + `model_bookkeeping` for pw; new-store aperture refusals
are 100% `model_bookkeeping` — the observation stream had already told the
agent the ref was retired, exactly tier5 §3.4's restatement discipline.)

This is the designed currency conversion, measured: the aperture arms went
from **65 landed wrong-row clicks** (27 + 38) and 22 refusals across 100 home
episodes to **0 landed and 176 refusals**. The redump arm moved in lockstep
with the diff arm, as an engine-level fix and only an engine-level fix would
move it.

### 1.2 What "passed" is licensed to mean

The preregistered bound and all mechanism predictions were stated before the
cohort and every one came out as predicted or better. Attribution to tier5
carries §0.1's build disclosure. The precision claim that replaces the failed
one is scoped to this store: fixtures purpose-built to stress re-rendering
identical-row lists, one model, sealed MCP frame.

### 1.3 The account-prefs sub-ruling — the one clause an adversarial reader could fire

Measured: account-prefs diff $0.1502 vs redump $0.1357 — diff dearer, on a
neutral fixture. Read literally, §7's clause (b) fires and tier5.1 becomes
mandatory. **Ruled: it does not fire**, for three reasons that are evidence,
not argument:

1. **The condition predates the treatment.** In the archived pre-tier5 store:
   diff $0.1468 vs redump $0.1350 — the same inequality, the same ~$0.012
   margin, identical turn structure (11.5 vs 9.0 turns, both cohorts). A
   clause written to detect damage *caused by tier5* cannot be fired by a
   relation tier5 measurably did not change (Δ of the gap: +$0.003).
2. **tier5's cost on account-prefs is ±12 chars** (the ruling's own scripted
   table; the firing family there is a costless same-set radio reappearance).
   The diff>redump gap on this fixture is failure-loop composition — agents
   burning turns against a broken predicate on a tiny page where the diff
   arm's byte advantage cannot cover its turn overhead.
3. **The cell is outside cost claims by the same preregistration.** §7
   incorporates §9.1.2 "verbatim — unchanged bounds (headtohead.md as amended
   by tier4 §7)", and headtohead.md's H11 floor — stamped into the cohort's
   `verdictRule` — excludes any cell where both headline arms are <50% from
   *every cost claim*. account-prefs is 0/10 vs 0/10 (the known predicate
   defect, §9 item 3). A cost comparison on that cell is not a claim the
   suite's own rules permit anyone to make, in either direction.

On the five cost-claimable neutral fixtures, diff < redump everywhere
(booking-form $0.1053<$0.1253; inventory-pick $0.1107<$0.1238;
journal-comment $0.2424<$0.5493; console-quota $0.2425<$0.5390;
catalog-order $0.1811<$0.3470) — the `H3\G7` invariant, intact in the wild.
Recorded so nobody can say it was skipped: under the strict-letter reading
the consequence would be the tier5.1 cycle, NOT a revert, and tier5.1 (same-
set reappearance revives) does not touch the account-prefs mechanism at all —
a remedy firing off this cell would be aimed at a cause it demonstrably does
not have. Either reading, the precision verdict stands and nothing reverts.

---

## 2. Ruling 2 — the precision reversal is real: same hazard, opposite currency

The headline claim, stressed as demanded. A defect that produced 27 landed
wrong-row clicks now produces zero across 110 aperture-diff episodes (and the
0.540 wrong-el/run home rate is 0.000). Fix, task mix, cohort, or scoring
artifact?

### 2.1 Not the task mix, and not the cohort

Fixtures, prompts and harness are hash-identical to the pre-tier5 store
(`promptHashes` and all `bench/` file hashes match; codeVersion identical).
Same n (110/arm, 50 home). Under the old home rate (0.54/run), the
probability of observing zero wrong-element actions in 50 fresh home episodes
by luck is e^(−27) — and the redump arm independently replicates it
(38 → 0). This is not sampling.

### 2.2 Not a hazard made unreachable — the queue tasks still exercise the mechanism, at full strength

Checked in the diff-arm home streams of THIS store, per task:

| task | gone-marks | restatements | rejections landed | stale acts refused | success |
|---|---|---|---|---|---|
| queue-positional | 68 | 59 | 20 | 21 | 90% |
| twin-queues | 109 | 90 | 30 | 12 | 90% |
| queue-resync | 99 | 99 | 40 | 57 | 70% |

Positional families still form, rows still get removed, retirement still
fires (the `replaced`/`gone` restatements are on the wire), and — decisive —
**agents still act on stale refs, 90 times in 50 episodes (1.8/ep, 5.7/ep on
queue-resync, the fixture built for it)**. The staleness attempt rate did not
fall; it rose (old: 27 landed + 8 refused = 35 stale acts; new: 90, all
refused — refusal invites a retry, and each retry is another refusal, never
another wrong click). The hazard is reached constantly and lands never. This
is the difference between a guard against a hazard that no longer occurs and
a fix for one that still does: the store shows the second, at wire level:

```
error: e1450 could not be acted on (gone).
The page as it stands now:
<untrusted-page-content id=e3e8fd11 origin=http://127.0.0.1:8899>
page #22.0 (unchanged — you already hold the current page)
...
```

— followed, in the successful episodes, by a re-observation and a landed act
on the correct row (queue-resync success 40% → 70%; twin-queues 50% → 90%).

### 2.3 Not a scoring artifact

The witness is unchanged (fixture `bench.js` hash identical) and *alive in
this cohort*: it caught 12 landed wrong clicks in pw-sealed and 8 in pw-stock
— including the exact one-row-off signature (`reject:q6` + `approve:q5`
pairs) the old store showed in our arms. `wrongElement` counts landed page
actions only, by design — a refused act moves no state and there is nothing
to score; that is the currency conversion itself, not a blind spot. And the
tasks still *complete* (home diff 90% success), so the right rows are being
acted on, witnessed by the same predicates as before.

### 2.4 What is licensed, and the two honest caveats

Licensed: **on this store, the silent-wrong currency is gone.** Zero landed
wrong-element actions in all 220 aperture episodes (both arms, all three
classes); pooled delta −0.109 [−0.200, −0.036] against a +0.2 bound — the CI
is entirely below zero, so on these fixtures the sign favors Aperture.
Caveats, both mandatory beside any citation: (i) the negative sign is partly
the incumbent's own sampled wrong clicks (8 → 12 across cohorts; pw-sealed's
refused-stale count moved 75 → 24 in the same breath — cross-cohort agent
variance under an undated model alias, unattributable); the durable claim is
Aperture's zero, not the incumbent's 0.24. (ii) Wrong-current-ref choices
remain possible in principle in our dialect — this store measured none in 220
episodes while agents on pw's dialect landed 20; that is a measured result on
disclosed-adversarial fixtures, not a structural guarantee. The prereg's one
overshot prediction (redump − sealed was expected to *include* 0, and instead
crossed it) is exactly caveat (i) in interval form.

---

## 3. Ruling 3 — reliability: what +10.0pp with a CI touching zero licenses

**Non-inferiority, nothing more.** The −10pp bound holds with 9.7pp of
margin; the CI [−0.3, +20.2] includes zero, so no superiority sentence is
licensed. Sensitivities, mandatory beside any citation:

- minus catalog-order (the ruled cell): **+1.0pp [−9.2, +11.2]** — parity,
  and the bound HOLDS without the cell (the archived cohort straddled it
  there: −2.0pp [−13.1, +9.1]). Non-inferiority is no longer hostage to one
  task. This is the strongest reliability fact in the store.
- minus account-prefs (the symmetric predicate defect, kept in the pool
  intention-to-treat): +11.0pp [+2.5, +19.9] — reported as color only; the
  preregistered pool includes it and the headline stays +10.0pp.
- Home set alone: diff 90% vs sealed 88% (old: 76% vs 82%) — the "incumbent
  led on our own adversarial set" sentence from the last adjudication is
  retired by measurement; §9.2's "flat-to-improved" prediction confirmed
  (+14pp).

**The decomposition says the diff mechanism contributes nothing to the
product gap — and the README must say so.** diff − redump: **+0.0pp
[−9.2, +9.2]** (both arms 95/110). redump − sealed: +10.0pp [−0.3, +20.2] —
the entire gap, unchanged when the diff mechanism is added on top. The
product headline (diff − sealed +10.0pp) is therefore an **engine/dialect**
result — compact snapshot rendering plus the catalog-order conversion (a
~6k-token dialect for a page pw's dialect renders at ~22k) — and any README
sentence attributing task success to *diffs* is unlicensed. The diff
mechanism's measured wins are economics (§4) and nothing else; its measured
cost to reliability is also zero, which after tier4/tier5's surgery is itself
a result (the loud currency did not cost success — §9.3.2's refusal-loop
revert had a real chance to fire and did not).

---

## 4. Ruling 4 — economics: the home reversal is the bookkeeping tax dying, and it is measured, not guessed

Preregistered beside each other, as required — **home 0.823× [0.693, 0.975]
CHEAPER · neutral-small 0.977× [0.937, 1.019] null · neutral-large 0.390×
[0.338, 0.455] CHEAPER** — all seeded-bootstrap 90%, H11 excluding
account-prefs from cost cells (n=20/20 on neutral-small).

### 4.1 Home: attribution, with the pooling discipline this programme owes twice over

The per-task obs shares in H10 swing 0.6%–99.7% (tiny denominators — ledger's
Δ$ is −$0.0002), so nothing here is claimed from a pooled share. The
attribution is from the token splits, per cell, cross-checked against the
archived store:

- **Output tokens, home, aperture arms: diff 6,285 → 2,131/ep; redump
  6,020 → 2,284/ep.** The collapse is engine-wide (both arms), which is what
  an engine-level fix predicts.
- **It is confined to the three queue tasks**: queue-positional 3,805 → 1,951;
  twin-queues 12,351 → 2,540; queue-resync 13,209 → 4,175. wizard-submit
  946 → 953 and ledger-balance 1,114 → 1,038 — flat, ratios ~0.98–1.00×.
- **Every neutral aperture cell is flat** (ns diff 1,070 → 1,074; nl diff
  924 → 934; redump likewise), so this is not model-verbosity drift under the
  undated alias — the incumbent's cells moved noisily in both directions
  while ours moved only where the mechanism lives.
- Turns went *against* us (home diff 14.6 vs 13.8 old; sealed 14.0) and obs
  chars rose 3% (7,861 vs 7,638 — the gone-list tax, at the low end of §9.2's
  predicted +5–20%). The saving is generation-side, full stop.

Reading: the old cohort's home premium was already adjudicated as
generation-side tokens at equal turns — agents re-deriving ordinal plans,
re-counting rows, and repairing after silent wrong landings. tier5 removed
the thing they were compensating for. A stale act now fails in one loud line
and the recovery is a cheap re-observation, not a paragraph of re-derivation.
Per-task: the queue tasks flipped 1.22×/1.37×/1.47× → 0.86×/0.73×/0.77×;
wizard/ledger sat still at ~1.0×. Honesty clause: pw-sealed home also drifted
+7.8% dearer for no attributable reason, contributing roughly a quarter of
the ratio movement; and the CI upper is 0.975 — CHEAPER, thinly. The
wave-1/2/3 "small-page premium" line is retired for the home set by this
store and stays live for neutral-small (0.977× null — unchanged).

### 4.2 Neutral-large: the warm-revisit cost arrived exactly as priced

0.313× → 0.390×, inside the preregistered ~0.31–0.46× band; CI upper 0.455
< 0.5, so the economics clause holds with room. Per task, the entire
worsening is journal-comment, as predicted: $0.1763 → $0.2424/ep (+37%), obs
27,806 → 45,755 chars (agent mean within 0.3% of the scripted 45,607
prediction), and **exactly one extra full snapshot in 10 of 10 episodes**
(kinds.full 2/2/2/2/2/2/2/2/2/2) — the solver re-paying warm what it always
paid cold, once per episode, deterministically. Its per-task ratio is still
0.660× [0.646, 0.674]. The two other large fixtures moved ≤ +$0.013 and
≤ +28 obs chars (console-quota 0.282×, catalog-order 0.376×). The channel
isolation the H10 arithmetic cannot give: diff/redump on neutral-large =
$0.2220/$0.4784 = **0.46×** (same engine, same dialect, only the observation
strategy differs); dialect redump/sealed = 0.84×.

**Mandatory disclosure (tier5-ruling §7 pinned it; the frozen report cannot
print it, so this document is where it lives): the cohort keeps the archived
shared-tab-per-run protocol. Aperture's engine carries warm state (persistent
refs) across the episodes of a run; the pw arms have no warm state to reuse.
That asymmetry is real, favors neither side uniformly (it is exactly what
journal-comment's +$0.066/ep expand cost prices against Aperture), and is in
the numbers rather than hidden from them.**

---

## 5. Ruling 5 — H10: printed CONFIRMED, adjudicated "task-mix arithmetic, same as last time"

The rule printed MECHANISM CONFIRMED at 62.7% ≥ 50%. The adjudicated reading
the report must carry: **the pooled share crosses the bar only with
catalog-order in the pool** (33.3% without it; neutral-large 43.4%, 49.1%
minus the cell) — the same single-task hostage-taking the last adjudication
documented in the opposite direction (46.7% pooled / 80.6% without). Both
cohorts, one sentence: *H10's pooled share is an artifact of whether the one
collapsed cell's failure-mode bytes (or turns) land in the pool; where both
arms solve the page, observation bytes are roughly half the cost delta, the
turn term runs modestly against Aperture (the loud currency and the
warm-revisit expand buy real round-trips), and the clean isolation of the
observation channel is the diff/redump ratio: 0.46× on neutral-large.* The
guard did its actual job twice — forcing this paragraph to exist instead of
letting "diffs are cheaper because diffs are small" pass unexamined. Its
known blind spots (pooling flagged cells into a mechanism share; pricing
turns at the aperture arm's context) are already on the obligations list and
remain unfixed because the harness was frozen for comparability; note that
this cohort they flattered us, which is precisely why the caveat prints.

---

## 6. Ruling 6 — SHIM-SUSPECT / catalog-order: the same ruled situation, to the decimal

The tripwire's investigation, re-done on the fresh store, finds the identical
phenotype as the ruled cell (`h2h-evaluation.md` §1): pw-sealed **0/10, all
`gave_up`, all 10 at the step cap, 0 witness-visible page actions in 120
steps** (old: same), **every episode ≥1 `budgetTokens` request refused**
(12 total vs 14), ~503K obs chars/ep of whole-page re-dumps (old 621K);
pw-stock **5/5** with the same engine and bigger dumps; aperture arms 20/20
at ~4.4 steps. Nothing about the shim changed (the harness is byte-identical;
0 tool faults; 0 contaminated; the delivered-bytes witness never fired).
**Ruled: same fair product difference, same dual reading, the §1 ruling
carries over unmodified** — the cell measures claude-sonnet-5 failing to
convert a ~22k-token re-dump into a targeted action through a 3-tool surface
with no scoping affordance, ten of ten, while asking for exactly the
affordance (`budgetTokens`) only Aperture's channel can honour. The
deployment-relevant incumbent number on this task remains pw-stock's 100%,
said in the same breath. Exit 7 remains the shipped suite's honest posture
until the `--ruling` acknowledgement path is built; this document is the
ruling it would reference.

---

## 7. RESULTS.md-ready text

Replaces the head-to-head block and the "Pending re-measurement" section
(whose restatement ban this adjudication discharges).

> **Head-to-head vs Playwright MCP 0.0.78, post-tier5 — scored 2026-08-05/06,
> adjudicated in docs/design/h2h-post-tier5-evaluation.md (385 episodes,
> $97.17, harness `dfa962c3f89b4d53` byte-identical to the archived cohort,
> build `0916e30fb90b1c02` = tier5 + the 2026-08-05 security hardening, git
> `3828b64`, claude-sonnet-5).** This is the fresh cohort preregistered by
> tier5-ruling §7 (inheriting tier5.md §9), measured on the unchanged task
> set with the unchanged harness; the only treatment between the two cohorts
> is the engine build. The shipped report exits 7 (SHIM-SUSPECT:
> catalog-order — re-investigated, same fair-product-difference ruling as
> h2h-evaluation §1); the verdict is computed out of band with the suite's
> own stats code, the established precedent. **tier5 passed every clause of
> its preregistration; the tier5.1 remediation is not triggered; the §9.4
> claims freeze is lifted.**
>
> **Precision (the primary we lost, re-measured): the +0.2/run bound HOLDS
> and the sign reversed.** Pooled wrong-element delta −0.109 [−0.200,
> −0.036] (was +0.173 [0.018, 0.345] FAIL). **Zero landed wrong-element
> actions in all 220 Aperture episodes** — home wrong-el/run 0.540 → 0.000
> (diff), 0.760 → 0.000 (redump) — vs 0.240/run for sealed Playwright and
> 0.320 for stock on the same home set (12 and 8 landed wrong clicks, the
> one-row-off signature formerly ours). The hazard did not disappear; its
> currency changed, as tier5 designed: agents still acted on stale refs 90
> times in 50 diff-arm home episodes (was 27 landed + 8 refused) and every
> one was refused loudly with a restatement, followed by recovery
> (queue-resync success 40% → 70%, twin-queues 50% → 90%). Mechanism
> predictions preregistered in tier5-ruling §7: wrong_choice at least halves
> — measured 27 → 0; refused-stale rises from 8 toward ~75 — measured 90;
> redump improves in step — measured. Caveats that travel with the number:
> the negative sign is partly the incumbent's own sampled wrong clicks
> (8 → 12 across cohorts); and zero landed-wrong is a measured result on
> fixtures purpose-built to stress re-rendering identical-row lists, not a
> structural guarantee.
>
> **Reliability (primary): the −10pp non-inferiority bound HOLDS — and now
> holds without the ruled cell.** +10.0pp [−0.3, +20.2] pooled; the CI
> touches zero, so non-inferiority only, no superiority claim. Sensitivity,
> mandatory beside any citation: the delta is carried by catalog-order
> (sealed 0/10, both aperture arms 10/10, +9.1pp of the +10.0); excluding it,
> +1.0pp [−9.2, +11.2] — parity, with the bound still holding (the archived
> cohort straddled it there). Home set: 90% vs 88% (the incumbent's prior
> 82-vs-76 lead on our own adversarial set is retired by measurement).
> Attribution, mandatory: diff − redump +0.0pp [−9.2, +9.2]; redump − sealed
> +10.0pp [−0.3, +20.2] — **the product gap is engine/dialect (compact
> rendering; the catalog-order conversion), and no share of it may be
> attributed to the diff mechanism.** account-prefs remains at 0% in three
> arms and 1/10 in the fourth (case-sensitive predicate defect, deliberately
> unfixed to keep the task set byte-identical per §9.1.2; in the reliability
> pool intention-to-treat, excluded from cost claims by H11).
>
> **Economics (primary): the realistic-page claim stays licensed at its new,
> honestly worse number — and the small-page premium is gone.** Neutral-large
> **0.390× sealed Playwright's cost [0.338, 0.455]** (was 0.313× on the
> pre-tier5 engine) — worsened exactly as preregistered (predicted band
> ~0.31–0.46×; failure was CI upper ≥ 0.5, measured 0.455). The entire
> worsening is journal-comment's warm-revisit expand, priced at exactly one
> extra full snapshot in 10/10 episodes (+$0.066/ep, +64% obs chars; per-task
> ratio still 0.660× [0.646, 0.674]). Home, reported beside it as always:
> **0.823× [0.693, 0.975] CHEAPER** (was 1.295× [1.043, 1.594] DEARER). The
> reversal is the death of the bookkeeping tax: aperture output tokens
> collapsed 6,285 → 2,131/ep (redump in step, 6,020 → 2,284), confined to the
> three queue tasks (all flipped to 0.73–0.86×; wizard/ledger flat at ~1.0×),
> with turns slightly up and obs bytes +3% — the generation-side re-derivation
> that silent wrong landings used to force is no longer generated; about a
> quarter of the ratio movement is the incumbent drifting +7.8% dearer,
> unattributed. Neutral-small null (0.977× [0.937, 1.019]), unchanged.
> Diff-vs-redump held diff-cheaper on every cost-claimable neutral fixture
> (H3\G7 in the wild). Disclosure pinned by the preregistration: both cohorts
> run a shared-tab-per-run protocol — Aperture's engine carries warm ref
> state across a run's episodes, the pw arms have none; journal-comment's
> expand cost is that asymmetry being paid for rather than hidden.
>
> **H10 (mechanism): printed CONFIRMED at 62.7% observation-byte share; the
> reading the rule cannot give: the pooled share crosses 50% only because of
> catalog-order** — the same cell that held it under 50% last cohort, from
> the other side (minus the cell: 33.3% pooled; neutral-large 43.4%, 49.1%
> without it). Where both arms solve the page, observation bytes are ~half
> the delta, the turn term runs modestly against Aperture (refusal recoveries
> and the warm-revisit expand buy real round-trips), and the clean isolation
> of the observation channel is diff/redump: 0.46× on neutral-large.
>
> **Affordance:** pw-stock 81.8% vs pw-sealed 76.4% pooled (Δ +5.5pp — under
> this cohort's CI half-width, so §7.4's demotion sentence is not triggered
> on this store; the archived cohort's +15.5pp finding stands on its own
> store and the direction is consistent). The catalog-order dividend repeats:
> stock 5/5 where sealed is 0/10 — the deployment-relevant incumbent number
> on that task is stock's 100%. Non-ref targeting in pw-stock: 0.04/episode.
> Any pw-stock claim carries "with code-execution, network-inspection and
> screenshot tools disabled" (§3.4, preregistered).
>
> **Scope, all mandatory:** one model (claude-sonnet-5, undated alias, with
> the SDK's haiku-4-5 auxiliary present identically in all four arms;
> cross-cohort behavioral drift in the pw cells — refused-stale 75 → 24,
> wrong clicks 8 → 12 — is visible and unattributable, which is why every
> primary is a within-cohort contrast); our fixtures (5 disclosed-adversarial
> home + 6 preregistered-neutral, synthetic, not live web; the older "13-task"
> label is 11 prompts, hash-unchanged across both cohorts); MCP mode only;
> `--pw-observation inline`; pw arms on branded Chrome 150 under
> `--pw-browser chrome` (pinned chromium-1232 cannot spawn on this machine;
> stamped in the cohort, still not printed by report() — obligation open);
> sealed pw arms `--codegen none` (C5-disclosed); `budgetTokens: 20000`
> injected on neutral-large for aperture arms (H6) while sealed pw
> advertises-and-refuses it (C3 — and the catalog cell again shows the model
> reaching for it, 10/10 episodes); `MAX_MCP_OUTPUT_TOKENS=50000` in all arms
> (C1), delivered-bytes witness fired zero times (C2b); shared-tab-per-run
> warm-state protocol, disclosed above; the measured build is tier5 plus the
> 2026-08-05 security hardening — tier5's mechanism files are byte-unchanged
> since its landing and the result carries tier5's exact designed signature,
> but the build hash on every claim is `0916e30f…`, not the tier5 landing's.
> Wall-clock reported, never verdicted: sealed pw's browser-side time on home
> is 42.4s/ep median vs Aperture's 1.1s (upstreamMs), a real felt-latency gap
> the §2 boilerplate understates. Programme lineage: five archived cohorts
> precede this one; this is the second consecutive clean cohort (0 harness
> faults, 0 contaminated) on the byte-identical harness.

## 8. README-ready paragraph

Replaces the head-to-head paragraphs and the "primary we lost" bullet
(README §"Correctness, and the primary we lost").

> On an 11-task benchmark against Playwright MCP 0.0.78 (both products sealed
> to an identical 3-tool surface; claude-sonnet-5; design preregistered in
> docs/design/headtohead.md, fix and re-measurement preregistered in
> docs/design/tier5.md §9 and docs/design/tier5-ruling.md §7, adjudicated in
> docs/design/h2h-post-tier5-evaluation.md; 385 episodes): **the precision
> primary we lost in August is reversed.** After tier5 (positional refs
> retire on family membership change), agents driving Aperture landed **zero
> wrong-element actions in 220 episodes** — down from 0.54/run on the
> re-rendering identical-row queue fixtures built to break it — versus
> 0.24/run for sealed Playwright there (pooled delta −0.11 [−0.20, −0.04]
> against a preregistered +0.2 bound). The hazard still fires; it now fails
> loudly and recovers instead of landing one row off: 90 stale acts refused
> (was 27 landed wrong + 8 refused), and hard-queue success rose (40→70%,
> 50→90%). On realistic-weight pages Aperture's diff observation costs
> **0.39× sealed Playwright MCP's [0.34, 0.46]** end-to-end — worse than the
> pre-fix 0.31× by exactly the priced warm-revisit expand the fix makes
> honest — and the small-page penalty is gone: **0.82× [0.69, 0.98]** on the
> adversarial home set (was 1.30× dearer), because the silent-wrong
> bookkeeping tax (6.3k output tokens/ep of re-derivation, now 2.1k) died
> with the defect; small neutral pages are cost-neutral (0.98×). Task success
> holds the preregistered −10pp non-inferiority bound (+10.0pp [−0.3,
> +20.2]) and now holds it even excluding the one task the sealed incumbent
> fails outright (catalog-order, 0/10 vs our 10/10: a ~22k-token page its
> re-dump dialect cannot keep inside the model's operating range — Aperture
> renders it at ~6k); success attribution is the engine and dialect, not the
> diff mechanism (diff − redump +0.0pp). Unsealed, Playwright MCP with its
> full default surface (code-execution, network-inspection and screenshot
> tools disabled) scored 81.8% vs its sealed 76.4% — within this cohort's
> noise, but the direction repeats the archived cohort's significant finding,
> and on catalog-order the stock surface converts what the sealed one cannot
> (100% vs 0%), so the sealed comparison still understates the incumbent and
> stock Playwright remains the stronger choice where its full surface is
> acceptable. One model (undated alias), our synthetic fixtures, MCP mode
> only, inline observation accounting, branded Chrome under a recorded
> override for the pw arms, shared-tab warm-state protocol disclosed;
> Playwright's CLI mode and live websites are unmeasured.

---

## 9. Record-keeping — obligations, and the one deliberately-open defect

1. **account-prefs stays broken by choice, and may now be fixed.** The
   h2h-evaluation §8.3 case-normalization was deliberately deferred because
   §9.1.2 demanded a byte-unchanged task set for THIS cohort. That constraint
   is now discharged; the predicate fix (with its cohort-severance) is
   unblocked for whenever a next cohort exists.
2. **Open harness obligations, carried forward verbatim** (h2h-evaluation §8;
   the harness was frozen for comparability and stayed frozen): report()
   prints `pwBrowserOverride`; the `--ruling <doc>` acknowledgement path so
   an adjudicated store does not exit 7 forever; H10 prints minus-flagged-cell
   shares and prices turns per-arm; §2 wall-clock boilerplate cites the
   upstreamMs split; the §5.2 vocabulary note on `identity_mismatch`.
   Additionally from this cohort: the report must print the tab-policy /
   warm-revisit disclosure that tier5-ruling §7 pinned (this document carries
   it meanwhile).
3. **tier5.1 (b′, same-set reappearance revives): recorded, prototyped, NOT
   owed.** Its preregistered trigger did not fire. Its entire value at
   current prices is journal-comment's +$0.066/ep on warm revisits while the
   per-task ratio is already licensed at 0.660×; landing it would spend a
   RED-first cycle plus a fresh cohort to improve a claim that is not at
   risk. Available if the identity-tier work (radio `name`-attr keying, also
   recorded in tier5-ruling §6) ever gets its own tier.
4. **The freeze is lifted exactly as §9.4 specifies**: the RESULTS.md
   precision sentence and README precision paragraph are retired and replaced
   by §7/§8 above; the "Pending re-measurement" section's restatement ban is
   discharged; economics claims restate from this store only. RESULTS.md's
   archived pre-tier5 block should remain in place as history, marked
   superseded by this document, per the programme's practice.
5. **This closes the head-to-head programme as specified.** Both primaries
   measured twice on a byte-identical apparatus with one engine treatment
   between them; the one failed primary was fixed under preregistration and
   re-measured passing; every economics claim carries its class, its CI, and
   its disclosures. What remains unsettleable is unchanged from
   h2h-evaluation §7 (live web, other models, the sealed frame itself,
   familiarity asymmetry, CLI mode, long horizons) plus one addition: the
   undated model alias means cross-cohort agent-behavior comparisons —
   including "the incumbent got slightly worse/dearer" — are observations,
   never claims.

---

*Recomputation note: every interval above reproduces from
`bench/headtohead/results/episodes.jsonl` with `bench/lib/stats.mjs`
(Newcombe for proportions; seeded bootstrap, seed 20260802, for means and
ratios) and h2h.mjs's `decompose`/`meanRatioCI` re-derived verbatim,
filtering nothing except where stated (H11: account-prefs excluded from cost
cells only). The archived store `episodes.20260805T231456Z.jsonl` was read
for the old-store columns and never pooled. The printed
`verdict-post-tier5.txt` reproduces to the digit on every recomputed line.
Adjudication scripts lived in the session scratchpad and are not part of the
repo; this file is the sole deliverable.*
