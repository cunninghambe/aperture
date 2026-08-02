# Size-sweep Tier B evaluation — 2026-08-02

Independent adjudication of the page-size sweep (54 Tier B episodes, $9.88,
run `2026-08-02T05:39:27.192Z`, stamp `codeVersion 05315affc1963c77` /
`buildVersion 469784c4c2c2d98e` — the wave-3 stamp, so cross-citation with
wave 3 is licensed per wave3-evaluation §4's amendment; wave-2 cross-citation
is not, as already ruled there). Method: every number below was recomputed
per episode from `bench/size/results.jsonl` through `bench/lib/stats.mjs`
(the suite's own `meanDiffCI`, seed 20260801, α = 0.1), sources read at
`f37a5db`. The printed per-tier table reproduces to the digit. No source
file was edited, no scored episode was run; probes were read-only.

The run's aggregate numbers are correct everywhere I checked: all five
Δ$/ep and their CIs, N = 6/6/6/5/4 per arm, 100% success both arms all
tiers, `truncatedObs` 0 across all 54 episodes, voluntary-obs means, turns
means, the R² = 0.921 fit and its −13,273-char fitted prefix. Two of the
run's *sentences* are wrong, and one premise of the adjudication brief is
wrong; those come first.

---

## 0. Corrections before the rulings

### 0.1 The harness's band sentence is factually false for this data

`NO CLOSED BAND — every tier's CI straddles zero, or the sign never
settles` was printed above a table in which **three of five CIs sit
entirely below zero** (s3 [−0.0469, −0.0204], s4 [−0.1275, −0.0903], s5
[−0.2377, −0.1420]). The sign *did* settle — negative, from s3 up,
monotonically widening. What actually happened in `crossoverBand`
(bench/size.mjs:1464–1495): `above` (CIs entirely > 0) is empty, `below`
is {s3,s4,s5}, so neither "all below" nor "all above" nor the two-sided
band matched, and control fell through to the terminal `open` case, whose
text was written for the all-straddle outcome. The one band shape reality
produced is the one shape `--dry`'s four test cases (win / lose / band /
all-straddle, size.mjs:1576–1581) do not enumerate. The band message must
not be quoted anywhere; §2 specs the fix.

### 0.2 Wave 3 was not mid-ladder — the brief's reconciliation puzzle dissolves

The brief's premise "wave 3's +4.4% at ~11–15K chars/ep — wave 3's pages
were mid-ladder" conflates two axes. 11,075 vs 15,240 chars/ep is
**per-episode observation volume** across 11–23 turns. Wave 3's *pages*
were queue-class: "Re-dump full snapshots run ~1.2–1.3k chars"
(wave3-evaluation §3, truncation row), and wave3-evaluation §4 itself calls
the wave-3 point "queue-class ~2k-char snapshots → +4.4% … the small end
of the curve." On the sweep's independent variable — per-snapshot page
weight — wave 3 sits at s1, not s3. There is no mid-ladder anomaly to
explain; see §4.

### 0.3 Two smaller corrections

- The sweep's design spec is **tier2.md §4** ("Size sweep Tier B — run
  it"), not §2 (§2 is `streamAssert`). The budget rule and enabler
  acceptance live in tier1b.md §2. Everything the brief attributes to the
  spec is nonetheless really in tier2.md §4 (band verbatim, R² ≥ 0.9 gate,
  zero-truncation statement, voluntary-obs secondary).
- `bench/size/results.jsonl` holds **58** episodes, not 54: four s1
  episodes from an earlier same-day run (`runId 2026-08-02T05:07:14.729Z`,
  $0.40) that the budget rule stopped at the pilot ($113.19 projected,
  no `--force-budget`). The printed summary correctly covers only the 54
  in-run rows — I verified the table reproduces only when filtering
  `runId === '2026-08-02T05:39:27.192Z'`. Any future recomputation must
  filter on runId; RESULTS.md should say so.

---

## 1. What the per-tier results actually license

### 1.1 Ruling on the outcome class

The design (size.mjs header, comment block) preregistered "no crossover in
the measured range — diffs cheaper everywhere ≥ s1" as a first-class
outcome. **That wording is not licensed either.** Diffs are not measurably
cheaper at s1 (−$0.0066 [−0.0478, +0.0227]) or s2 (+$0.0009 [−0.0120,
+0.0129]); they are *not measurably dearer* there, and measurably cheaper
only from s3 up. The correct outcome class is one the harness has no name
for: **one-sided no-crossover** — no tier's interval sits above zero
anywhere on the ladder, the sign settles negative at s3 and stays settled,
and the lower edge of any crossover is unresolved rather than refuted.
"No closed band" is meaningfully different from both preregistered
wordings, and the difference is load-bearing: the s1–s2 nulls leave room
for exactly the small-page premium waves 1–3 measured (+4–6% would be
+$0.005–0.007/ep at these tiers — well inside both intervals, which cap a
premium at +$0.023/ep ≈ +20% at s1 and +$0.013/ep ≈ +10% at s2). This run
neither confirms nor refutes that premium; it brackets the crossover's
upper edge at s3 and leaves the lower edge open.

### 1.2 RESULTS.md-ready text

> **Page-size sweep, Tier B (2026-08-02, stamp `05315affc1963c77` /
> `469784c4c2c2d98e` — the wave-3 stamp; cross-cites wave 3, not wave 2).**
> On `cart-adjust` with `claude-sonnet-5`, over full-snapshot weights
> 1,116–38,081 chars (s1–s5), N = 6/6/6/5/4 per arm (the preregistered
> budget adjustment at s4/s5, then `--force-budget` on the owner's explicit
> in-session headroom ruling), 100% success in both arms at every tier,
> zero truncated observations:
>
> Δ$/ep (diff − re-dump; seeded-bootstrap 90% CIs): s1 −$0.0066
> [−0.0478, +0.0227] · s2 +$0.0009 [−0.0120, +0.0129] · s3 −$0.0338
> [−0.0469, −0.0204] · s4 −$0.1123 [−0.1275, −0.0903] · s5 −$0.1900
> [−0.2377, −0.1420] — at s3/s4/s5 the diff arm is 19% / 39% / 43%
> cheaper per episode.
>
> **The diff arm is never significantly dearer at any measured size, and
> is significantly cheaper from s3 (≈10k chars, ≈2.5k tokens) up, with the
> advantage growing monotonically with page weight.** No crossover exists
> in the measured range. The point estimate changes sign between s2 and
> s3, but the crossover's lower edge is unresolved: at s1–s2 the intervals
> include zero, so this run neither confirms nor refutes the +4–6%
> small-page premium of waves 1–3 (which would be +$0.005–0.007/ep here);
> it caps any such premium at +20% of episode cost at s1 and +10% at s2.
> This is a *one-sided* no-crossover: not the design's "diffs cheaper
> everywhere ≥ s1" (they are only indistinguishable at s1–s2), and not the
> harness's printed "every tier's CI straddles zero" (false for s3–s5; the
> band code hit an untested branch — see sweep-evaluation §2).
>
> Residual behaviour, disclosed: the diff arm bought ~1 voluntary
> observation per episode at every tier (0.80–1.25/ep, flat — no growth
> with page size; re-dump 0.00), costing it +1.0 SDK turn on average —
> usually a 162-char `nochange` check, at worst one voluntary full
> re-dump. Scored intention-to-treat, so this bias runs *against* the diff
> arm and is included in every number above. Excluding it (vol = 0
> episodes only) makes Δ$ more negative at every tier and flips s2's point
> estimate to −$0.0216; no sign conclusion depends on it.
>
> Cost model: the preregistered two-regressor fit passed its R² ≥ 0.9 gate
> (R² = 0.921, n = 54) but recovered a **negative per-turn coefficient**
> (fitted prefix −13,273 chars vs 4,268 measured), so the per-turn /
> per-char decomposition is unidentified on this design and is not cited.
> Descriptive only: cost regressed on conversation-input chars alone gives
> R² = 0.908 with slope 8.1×10⁻⁷ $/char ≈ $3.25/M tokens, consistent with
> the model's input list price. The raw per-tier dollars are the result;
> the fit is a sanity check, not a finding.
>
> Scope: one task (4–6 steps), one model, one engine, synthetic inert
> padding, page weights 1.1k–38k chars. Says nothing about other tasks or
> models, real websites, the truncation regime, task-pressure regimes
> (wave-3-class episodes run 11–23 turns; these run 7–9), or page sizes
> beyond the ladder.
>
> Provenance: `bench/size/results.jsonl` also contains 4 episodes from an
> earlier aborted run (`runId 2026-08-02T05:07:14.729Z`, $0.40, stopped by
> the $60 rule without `--force-budget`); recomputations must filter
> `runId 2026-08-02T05:39:27.192Z`. Actual spend $9.88 vs $88.52
> projected — the linear-in-page-size projection is ~9× pessimistic
> because cost is dominated by the per-episode floor, not page weight.

### 1.3 Is the cost-model fit citable? Ruling: descriptive only, with the caveat mandatory

The tier2 §4.2 gate (cite iff R² ≥ 0.9) is necessary but not sufficient,
and the harness's own side-by-side print of fitted-vs-measured prefix
exists precisely to catch this case: prefix −13,273 chars implies a
per-turn cost of **−$0.011/turn**, which is not a price. The failure is
identification, not noise: `modelTurns` spans only 5–7 and effectively
encodes the arm (re-dump = 5, diff = 6–7), so the turn coefficient soaks
up whatever arm-level cost structure the char model misses (cache-hit
blend, output tokens) — the exact decomposition wave3-evaluation §4 said
could not be done without per-episode `modelUsage`, which this run again
did not persist (§5). I verified the one-regressor refit myself: slope
8.125×10⁻⁷ $/char, R² 0.908 — the turns term buys 1.3 points of R² and a
nonsense coefficient. Cite the slope and R² as description, never the
two-term model, and never as "the prefix costs X".

---

## 2. The template defect — spec for the next harness edit (do not edit now)

Three code paths, one root cause: the sentence the design calls "what this
licenses, and nothing more" is assembled from the *band verdict alone*,
and the band verdict has a hole.

**A. `crossoverBand` (bench/size.mjs:1464–1495).** Add the two one-sided
outcomes. After computing `above`/`below` over `usable`:

- `above` empty, `below` non-empty, and `below` is a contiguous suffix of
  `usable` → kind `no-crossover-upper-only`, text of the form: "NO
  CROSSOVER IN THE MEASURED RANGE — diffs are never significantly dearer
  at any tier; significantly cheaper from ⟨below[0].tier⟩ up; ⟨list of
  smaller tiers⟩ are nulls at this N (CIs include zero)."
- Mirror case (`below` empty, `above` a contiguous prefix) → kind
  `no-crossover-lower-only` with the diffs-dearer wording (this is the
  one-sided version of the product-threatening outcome and should say so).
- Reserve `open` for the shapes that remain: all-straddle (keep the
  current sentence *minus* the "or the sign never settles" clause) and
  non-contiguous sign patterns (new text: "the sign pattern is
  non-monotone across the ladder; no band statement is licensed").

**B. The licensed sentence (bench/size.mjs:1968–1972, `reportTierB`).**
The claim slot currently interpolates `band.text` and nothing else. It
must be assembled from `perTier`: per-tier Δ$ with CI and N, then the
partition into significant/null tiers, then the band verdict as a
subordinate clause. The per-tier intervals are the result; the band is a
summary of them. tier2 §4.2's "band statement verbatim from
`crossoverBand`" stays satisfiable — verbatim as a clause, not as the
entire claim.

**C. The dry self-test (bench/size.mjs:1576–1590).** Add the band shape
this run actually produced — `[straddle, straddle, below, below, below]`
→ expect `no-crossover-upper-only` — and its mirror. The defect shipped
because the only shape reality produced was the only shape `--dry` did
not enumerate.

Ride-alongs for the same edit (both preregistered obligations, neither
mine to do now): persist per-episode `modelUsage` token splits on the
Tier B record (wave3-evaluation §4 item 2 — missed by this run, see §5),
and replace `projectSpend`'s linear-in-page-size pilot model with the
fitted char slope plus per-episode floor (the current rule projected
$88.52 for a $9.88 run and cut s5's N from 6 to 4 for nothing).

---

## 3. Adversarial pass — can this result be faked or broken? No; details

**Identical re-dump observation totals (84,366 chars, every s4 re-dump
episode).** Expected byte-determinism, verified at sequence level, not
suspicious. Every re-dump episode in a tier has the identical
`obsCharSeq` — s4: [21134, 21146, 21146, 20940] = initial full snapshot
(measured 21,108 chars + 25-char envelope + 1), two act-embedded fulls
(+12 for the changed quantity line), and a smaller final full (Notebook
rows removed). The page is static, the successful trajectory is the same
3 acts, and the renderer is deterministic — P5 proved byte-invariance
modulo state ids for the scripted stream, and Tier B's agent simply
reproduces it. Organic variance shows exactly where it should: state-id
digit widths (s3 initial full is 10,053 vs 10,054 chars across episodes;
preflight's s4 scripted total was 84,362 vs Tier B's 84,366), and cost
and duration vary ($0.2783–$0.2900, 20–22 s) while bytes do not — real
API-side stochasticity a fabricated log would be unlikely to include.
Diff-arm sequences are equally deterministic per trajectory shape
(243/245-char diffs, 162-char nochange, 858/860-char final diff — flat
across the ladder, which is Tier A's mechanism carried into Tier B).

**The turns asymmetry (8.0 vs 7.0 SDK turns).** The diff arm's extra turn
is the voluntary observation, one-for-one: vol = 0 diff episodes run 7
turns exactly like re-dump (one s1 re-dump episode ran 8 turns with
vol = 0 — a lone extra assistant turn, immaterial); vol = 1 → 8, vol = 2 →
9. Removing it changes no sign anywhere — it moves every delta *away*
from zero: vol = 0-only diff means vs full re-dump arm give s1 −$0.0143,
s2 −$0.0216 (the only positive point estimate flips negative), s3
−$0.0605, s4 −$0.1273, s5 −$0.2478. The asymmetry is a bias against the
diff arm, retained by intention-to-treat, and the headline conclusions
are insensitive to it in the only direction that could matter.

**Truncation.** `truncatedObs` = 0 in all 54 episodes; the largest single
observation is 38,119 chars (s5 initial full) against the 20,000-token ≈
80,000-char injected budget — 48% of ceiling, nothing near it; P1
additionally verified every tier's full snapshot untruncated and
collapse-free before money was spent. The G11 class is quiet.

**N = 4 at s5.** Honestly reflected, with one nuance. The printed CI
[−0.2377, −0.1420] is the widest on the table (±$0.048 vs s4's ±$0.019),
as it should be. The two arms are completely separated at s5 (diff max
$0.3116 < re-dump min $0.4404; exact rank test one-sided p = 1/70 ≈
0.014), and a Welch-t 90% interval [−0.261, −0.119] also excludes zero
with room — the *sign* is robust. The nuance: a percentile bootstrap on
4-vs-4 samples undercovers, and Welch is wider than the printed interval,
so the CI slightly flatters the *magnitude's* precision. Read s5 as
"−43%, give or take a wide margin", not as ±$0.048 exactly.

**Other channels checked.** Arms structurally distinct per row
(`obsSeq`: `a:full` vs `a:diff`; `armDefinition` stamped); wrongElement 0
and 3 witnessed page actions per successful episode; predicate proven
false on untouched pages (P3) per tier; the agent surface sealed (no
Read/Bash/etc., scratch cwd), so no fixture-on-disk bypass; fixture sizes
in the observation stream track the manifest ladder exactly, so no
tier-file mixup; the 4 stray results.jsonl rows are outside the summary
(§0.3). Nothing here can manufacture the s3–s5 result.

---

## 4. Reconciliation with waves 1–3 — one axis, no contradiction

Plot every measured point on the sweep's axis (per-snapshot page weight)
and the three waves' inversions all sit at the bottom of the ladder, where
this sweep is null:

- **Wave 1** (+5.2%, 1.4–8.0KB fixtures ≈ s1–s2): carried entirely by
  +0.58 turns/ep of voluntary snapshotting — RESULTS.md's own split shows
  the six tasks with zero voluntary obs at **−4.1% (diffs cheaper)** and
  the four with them at +20.9%. The sweep's s1–s2 nulls, and its vol = 0
  sensitivity flipping s2 negative, are the same phenomenon at N too
  small to resolve a ~5% effect (the CIs admit ±10–20%).
- **Wave 3** (+4.4% at 0.73× bytes): pages were ~1.2–1.3k-char snapshots
  — s1-class (§0.2). Its premium happened at *equal* turns (11.3/11.3 …)
  with voluntary obs in **both** arms (1.14–1.71 diff vs 1.11–1.51
  re-dump) and longer diff-arm wall time, i.e. wave-3's residue is
  bookkeeping paid in generation-side tokens on tiny pages, where the
  per-observation saving (~1k chars/obs) is too small to cover any
  behavioural overhead at all.

So the brief's hypothesis is half right: wave-3 discriminative episodes
do run far more turns (11–23 vs 7–9) with more voluntary observation
under task pressure — but that is not needed to reconcile a mid-ladder
premium, because there was no mid-ladder premium. No wave ever measured a
big page; the sweep is the first point above ~2k chars, and it comes out
decisively diff-favourable.

What the sweep therefore bounds, and what it cannot: on this task the
diff arm's voluntary-observation residue does **not** grow with page size
(0.80–1.25/ep, flat s1→s5 — answering wave3-evaluation §4's item 3 for
the low-pressure regime), and at ≥10k chars a full extra turn plus ~1
voluntary observation cannot erase the per-observation saving. For the
small-page premium to reappear at s4/s5 weights, task pressure would have
to induce diff-arm voluntary *full dumps* at a rate that grows with page
size — and note the arithmetic runs the other way for re-dump: under
pressure its voluntary observations are full dumps too (wave 3 measured
1.1–1.5/ep of them), which at s4/s5 weights cost it as much again as its
mandatory stream. The unmeasured quadrant is hard tasks × big pages; the
measured three quadrants all point the same way.

---

## 5. What remains genuinely unanswered on economics

The largest open item is self-inflicted: the run did not persist
per-episode `modelUsage` token splits, despite wave3-evaluation §4 item 2
naming that field as the one addition Tier B needed — so the
input-weight-vs-generation-side decomposition of the diff arm's small-page
premium survives its *third* cohort unanswered, and this run's own
negative per-turn coefficient is that same question resurfacing as an
unidentifiable regression. Beyond that, four things. The small-page
premium itself (the only regime real product usage has actually exhibited
in waves 1–3) is still only bracketed, not measured: s1–s2 nulls at
N = 6/arm cap it at +10–20% of episode cost, and resolving a ~5% effect
there needs on the order of 100 episodes/arm or the token-split field,
whichever is cheaper. The hard-task × big-page quadrant — where wave-3
levels of voluntary observation meet s4/s5 page weights — has never been
run, and it is the one place the sweep's flat ~1-voluntary-obs residue
could plausibly break. The truncation regime is excluded by design, yet
it is the default product experience on pages bigger than the budget —
the sweep priced the 20k-token enabler world, not the 2k-token default
world. And everything above is one 4–6-step task on one model on
synthetic inert padding: longer horizons mechanically compound the diff
arm's advantage through the triangular history term, but behaviour under
length — more chances to distrust the model and buy a full dump — is
exactly what this task cannot exhibit, and real pages whose padding
*changes* (ads, timestamps, live regions) would put nonzero bytes in the
diff stream where this ladder put none.
