# Head-to-head adjudication — Aperture vs Playwright MCP — 2026-08-02

Final adjudication of the head-to-head cohort (385 episodes, $104.53, store
`bench/headtohead/results/episodes.jsonl`, cohort identity
`dfa962c3f89b4d53` / build `6eb65fbf4f37e3a6`, `@playwright/mcp@0.0.78`,
model `claude-sonnet-5`, `pwObservationMode: inline`,
`maxMcpOutputTokens: 50000`, `pwBrowserOverride: chrome`, git `03205a1`,
tree clean). Method: every number below was recomputed per episode from the
store through the suite's own code (`bench/lib/stats.mjs` `propDiffCI` /
`meanDiffCI`; `h2h.mjs`'s `decompose` and `meanRatioCI` re-derived with the
same seeds). The printed report reproduces to the digit — every line of
`--report` (exit 7) was verified against the per-episode records. No source
file was edited, no scored episode was run; the only live probe was a local
`playwright-core` launch check (no API spend, throwaway deleted).

`report()` exits 7 on this store: the SHIM-SUSPECT tripwire (H9) flags
catalog-order and refuses to print a verdict until the investigation is
ruled. §1 is that ruling. The verdict is therefore computed **out of band**
in this document, the wave-2/wave-3 precedent exactly (wave2-evaluation
§0.1, wave3-evaluation §1.3): the shipped suite's refusal stands as its
honest posture, and this document is the scoring record RESULTS.md cites.

---

## 0. Corrections to the brief, before the rulings

The coordinator's aggregate numbers are correct to the digit everywhere I
checked (the full per-arm/per-class table, all three primary CIs, the H10
terms and per-task shares, the three-way deltas, the affordance split, the
wall-clock table, $104.53, 0 faults, 0 contaminated). Six *readings* are
wrong or incomplete, and four of them are load-bearing.

### 0.1 It was not "two" budgetTokens episodes — it was all ten

The store shows `budgetTokensRefused ≥ 1` in **every one of the ten**
pw-sealed catalog-order episodes (14 refusals total: 3/2/1/1/1/2/1/1/1/1)
and in **zero** of the other 100 pw-sealed episodes. The "only two
episodes" claim describes an earlier, smaller store. The corrected fact is
stronger than the brief's version: the agent asked for a smaller snapshot
in *exactly and only* the cell where the page was too big to act on, ten
times out of ten.

### 0.2 The reliability headline is carried entirely by catalog-order

Pooled, as preregistered: **+7.3pp [−3.8, +18.2], bound −10pp HOLDS.**
Remove the one task ruled on in §1 and it becomes **−2.0pp [−13.1, +9.1]**
— the CI then *straddles* the −10pp bound (inconclusive, not a pass, not a
fail). aperture-diff went 10/10 on catalog-order where pw-sealed went
0/10; that single 10-episode cell is +9.3pp of the +7.3pp delta. The
preregistered rule pools all tasks and no preregistered exclusion fires
(H11 needs *both* arms <50%; contamination C2b fired zero times), so the
headline number is +7.3pp — but every citation of it must carry the
minus-catalog sensitivity, because a pooled primary that one cell decides
is exactly the aggregate-level failure this project's stores keep catching
its coordinators in.

### 0.3 H10's "turns, not bytes" is false outside the same one task

The brief asks "WHY does aperture-diff use fewer turns than pw-sealed?"
The store's answer: **it doesn't.** Recomputed with `decompose()`:

| stratum | turnsΔ (pw − diff) | obs-byte share |
|---|---|---|
| pooled costable (as printed) | +1.10 | 46.7% — NOT CONFIRMED |
| pooled minus catalog-order | **−0.01** | **80.6%** |
| neutral-large | +3.23 | 44.4% |
| neutral-large minus catalog-order | **−0.70** | **65.6%** |
| neutral-small | −0.95 | 7.5% |

The entire pooled turn excess is catalog-order's failure spiral (18.5 vs
7.4 turns × 10 episodes ≈ +1.0 turn/ep pooled). On the two healthy
neutral-large tasks the diff arm used *more* turns (console-quota 9.8 vs
9.0, journal-comment 8.6 vs 8.0), and on neutral-small it used ~1 more
(the voluntary-observation residue the size sweep measured). §3 writes the
explanation the report must lead with.

### 0.4 account-prefs is a predicate defect, not a capability finding

Every arm "failed" account-prefs (1/10, 1/10, 0/10, 0/5). The streams show
why: agents completed the entire task and the page confirmed
`Saved: notifications on, delivery sms, digest Weekly.` — capital W. The
predicate requires `frequency === 'weekly'`, case-sensitive; the two
"successes" are the two episodes whose agent happened to type lowercase.
This is a fixture scoring defect, symmetric across arms (it moves the
headline delta by one episode: minus account-prefs the pooled delta is
+7.0pp). H11 correctly excluded it from cost claims, but the report's
"capability finding" framing must not be quoted — nothing about capability
was measured in that cell. Fix (case-normalize the predicate) severs the
cohort and waits for the next one; the cell stays in the reliability pool
as scored, intention-to-treat, the wave-3 F5 posture.

### 0.5 Every pw episode ran on branded Chrome, and the report never says so

The spec pins `--browser chromium` (rev 1232 / 151.0.7922.10, recorded in
the identity). The cohort records `pwBrowserOverride: chrome`, and probing
this machine confirms why: the pinned chromium binary fails to spawn
(`browserType.launch: spawn UNKNOWN` — a machine property; branded Chrome
150.0.7871.187 launches cleanly). So all 165 pw episodes ran Chrome 150,
not the pinned chromium — while the cohort's `chromium.browserVersion`
field records the *pinned* build, i.e. a browser that never ran. H0's
preflight prints the override, but `report()` does not, despite the
harness comment promising "printed in every report". Scoring integrity is
unaffected (H2/H2b/H3 all ran under the same Chrome; the witness is
engine-agnostic by construction), but the deviation is disclosure-mandatory
(§5) and the report omission is a defect for the next harness edit (§8).

### 0.6 `identity_mismatch = 0` does not mean the positional-ref hazard is absent

The detector compares labels, and the home queue rows are *identical*
("Queued submission", "Approve"/"Reject" × N) — a rebound ref lands on a
same-labelled button and `labelsAgree` passes. On these fixtures the
detector cannot fire by construction. §2 shows at wire level that the
hazard is not only present but is the likely dominant mechanism of the
precision failure.

---

## 1. SHIM-SUSPECT / catalog-order — the ruling owed since the pilot

### 1.1 The facts, all verified per episode

- **pw-sealed 0/10; pw-stock 5/5; aperture-diff 10/10; aperture-redump
  10/10.** The only zero-cell in the store outside account-prefs.
- **The shim is mechanically sound.** H3's scripted solver solved
  catalog-order *through the sealed shim on pw-sealed* in 4 steps / 3 page
  actions (selftest record: `SOLVED 4 steps · 3 page actions · 360817
  chars`). Clicks by ref land; snapshots arrive; the witness scores.
- **The information was delivered, every time.** Every episode's first
  observation is a ~89,100-char full aria snapshot whose bytes are on the
  episode row (`fullStream`); `button "Add Meridian desk clock to order"
  [ref=fNe62]` appears ~4,500 chars in. C2b (delivered-bytes witness)
  fired zero times in 385 episodes; `apparatusContaminated` is null on
  every row. This is the post-C1 world: the 50k-token MCP cap held
  (largest observation ≈ 21.8k tokens).
- **The agent never acted on it.** Across all ten episodes: 0
  witness-visible page actions in 120 steps. Per episode: 7–9 whole-page
  ~89K dumps of the *same unchanged page* (534K–811K obs chars/ep), 1–3
  `budgetTokens` requests (refused in one line, no step charged), 2–5
  scroll/key acts that returned **zero bytes** (pw's shipped conduct for
  `browser_mouse_wheel`/`browser_press_key` under `--codegen none`, the
  C5 finding), and then clicks on the generated *department nav links*
  ("Thicketwell holdings list 2", ref fNe6, near the top of the dump) —
  which navigate to a 404-class page and kill the fixture — or heading
  clicks, or `task_done` without success. All ten classify `gave_up`;
  every one hit the 12-step cap.
- **pw-stock's cure is one tool.** Same engine, same model, same page,
  same ~90K dumps (452K–630K obs chars/ep — *more* bytes than the sealed
  failures): every run goes `browser_snapshot → browser_find → … →
  browser_click fNe62 → find → click fNe1017 → find → click fNe1014`,
  5/5. The refs it clicks are the very refs the sealed agent held in its
  first observation. Note where the qty/place refs live: e1017/e1014,
  i.e. at the *end* of a ~1,000-ref page.

### 1.2 Ruling

**FAIR PRODUCT DIFFERENCE within the sealed frame — not a shim artifact,
not a task artifact — with a mandatory dual reading, because the sealed
frame is Aperture-shaped by construction.**

- *Not a shim artifact.* The shim's mechanics are proven end-to-end (H3
  wire-routed solve, delivered bytes, symmetric settle, refusal that costs
  no step). Nothing the harness built refused, truncated, or misrouted
  anything in these ten episodes.
- *Not a task artifact.* The spec was frozen before the fixture existed
  (§4.3 T6), the linter and changelog are clean, and three of four arms
  solve it at 100%. The nav links the agent wandered into are ordinary
  page furniture; clicking one is a real agent error with a real
  consequence, symmetric across sealed arms (no arm has navigate-back).
- *What the cell measures:* **claude-sonnet-5 cannot reliably convert a
  ~22k-token whole-page re-dump into a targeted action through a 3-tool
  surface with no scoping affordance.** The model diagnosed it for us: it
  reached for `budgetTokens` — a smaller snapshot — in exactly and only
  this cell, ten out of ten episodes, and there is nothing on Playwright's
  sealed surface that can honour the request. Aperture's channel renders
  the same page at ~6k tokens (24.9K chars scripted total for the whole
  episode) and the same model solves it in ~4 steps, 20/20 across its two
  arms. That asymmetry — whose observation channel keeps a realistic page
  inside the model's operating range — is precisely the thing the
  benchmark exists to measure. The cell stays.

**The `budgetTokens` refusal (C3) is defensible, and stays.** There is no
honest mapping: `budgetTokens` is Aperture semantics; Playwright's own
size controls (`browser_find`, snapshot `depth`) are stock-surface
affordances measured in pw-stock, and synthesizing a translation would be
the harness playing the competitor's hand. The refusal costs no step, is
worded as pw words its own refusals, and replaced a silent drop — the
strictly worse prior behaviour. What must be said every time (and the arm
definition already says): the sealed schema *advertises* the parameter in
all sealed arms because H4 demands byte-identical surfaces, so the sealed
frame shows the model an affordance only Aperture can honour. That is not
a thumb on the scale added by the harness; it is the sealed design's
built-in shape — sealing to the product's surface seals to the product's
affordances. §3.1 of the design predicted the objection ("a comparison
where the incumbent is amputated measures our amputation") and bought the
answer in advance: pw-stock runs, and §7.4's demotion sentence is
triggered and printed (§5).

**Consequence for printing a verdict: the investigation the tripwire
demands is complete, and the verdict may print — out of band, here.** The
preregistered pooled numbers stand as computed *with the cell in*; every
pooled reliability citation carries the minus-catalog sensitivity (§0.2);
economics is robust either way (§3); and the deployment-relevant
catalog-order number for the incumbent is pw-stock's 100%, said in the
same breath as the sealed 0%.

---

## 2. The precision failure — attribution, mechanism, and the sentence

### 2.1 The numbers (§7.3's owed split)

Pooled (the preregistered primary): **+0.173 wrong-el/run [0.018, 0.345]
vs bound +0.2 — BOUND FAILS** (the CI upper exceeds it; the point estimate
alone does not). Concentration: every wrong-element action in the store is
on the three home queue tasks; all four arms are at 0.000 on all six
neutral tasks and both remaining home tasks. Home-only: diff 0.540/run,
redump 0.760, pw-sealed 0.160, pw-stock 0.080; home-only delta **+0.380
[0.060, 0.740]**.

The attribution table (home, all acts):

| arm | ok | wrong_choice (landed, wrong element) | dead-ref errors | identity_mismatch |
|---|---|---|---|---|
| aperture-diff | 431 | **27** | 8 | 0 |
| aperture-redump | 421 | **38** | 14 | 0 |
| pw-sealed | 423 | **8** | 75 | 0 |
| pw-stock | 254 | 2 | 8 | 0 |

Decomposition (wrong-el, bootstrap 95%): diff − redump **−0.100 [−0.355,
+0.145]** — the diff mechanism is not implicated (points the *other*
way); redump − pw-sealed **+0.273 [0.082, 0.491]** — significant. The
brief's suspicion is verified: **this is an ENGINE/DIALECT cost, not a
DIFF cost.** ("Engine/dialect" bundles the snapshot rendering, the ref
discipline, the action stack, and the model's format familiarity — the
inseparable remainder of §3.5.)

### 2.2 The mechanism, at wire level

queue-resync's rows are identical and id-stripped by design; Aperture
keys them **ordinally**. The store's diff streams show what that means
under removal: after each reject, the restatement block
(`! e2 replaced (gone: e57 e58)`) retires only the **tail** refs and
re-binds e3–e16 to *positions* — the same e10 is "4th row's Reject"
before and after, whatever submission now sits 4th. A plan captured
against snapshot N ("the original 5th's Reject is e12") executes one row
off after any removal above it, silently, labels agreeing. The failure
signature in the store matches exactly: the repeated wrong rejects are
q6/q11/q16 — the rows that *slid into* the 5th/9th/13th positions after
the first removal (runs 1, 4, 5 wrong-click identical sequences
e12→reject:q6, e50→reject:q11, e58→reject:q16).

Playwright's dialect cannot make this mistake **land**: refs are
per-snapshot, and a stale ref is refused —
`### Error · Ref eN not found in the current page snapshot. Try capturing
new snapshot.` (H1's verbatim probe) — which is why pw-sealed's agents
show 75 dead-ref errors (9× Aperture's) and only 8 landed wrong actions.
Same underlying staleness, opposite failure currency: **Aperture executes
stale plans; Playwright refuses them.** Per-act the store cannot separate
"agent re-derived ordinals wrong" from "ordinal ref rebound under a
correct plan" (identical labels blind the detector, §0.6) — but both
routes are downstream of positional identity on unlabeled rows, and the
one-row-shift clustering says the rebind route is live.

### 2.3 The licensed sentence, and the fix-cycle ruling

The exact honest sentence (this, and nothing stronger or softer):

> "On fixtures purpose-built to stress diff-tracking on re-rendering,
> identically-labelled lists, agents driving Aperture landed +0.38
> wrong-element actions per run more than agents driving Playwright MCP
> sealed to the same three tools (95% CI [0.06, 0.74]; pooled over all 13
> tasks +0.17 [0.02, 0.35] against a preregistered +0.2 bound, which
> FAILS). The excess is not the diff mechanism (diff − redump −0.10
> [−0.36, +0.15]); it is the engine's positional ref identity on
> unlabeled rows (redump − sealed +0.27 [0.08, 0.49]): Aperture's
> persistent refs keep a stale plan executable — clicks land, one row
> off — where Playwright's per-snapshot refs make the same staleness
> error out and force re-derivation. This is a correctness hazard, not a
> cost: the wrong actions mutate real state."

**Worth its own fix cycle: YES.** It is the one preregistered primary that
failed; it is concentrated, reproducible (identical wrong sequences across
runs), and mechanism-attributed to a named, already-half-open hole: tier3
§3.1's rebinding gap, of which tier4 §1 closed only the *growth* side
(family gains a member → escalate to `replace`). The removal side —
survivors re-keying downward so tail-`gone` misdescribes a middle removal
— is what queue-resync exercises and what this store measured losing to
the incumbent. The candidate fixes (escalate shrink the way growth
escalates; or retire-and-reissue the whole family's refs on any
membership change) all trade landed-wrong for refused-stale — deliberately
moving to Playwright's side of the silent-vs-loud tradeoff on this markup
class. That is an engine decision for a stage-C window and a fresh
cohort; nothing in this store can be re-scored under it.

Scope honesty both directions: the home set was *built* to produce this
(disclosed adversarial; wrong-el 0.000 everywhere else, including every
neutral fixture with realistic markup), so the hazard's measured domain is
re-rendering same-label lists — real (queues, tables, feeds) but not
universal. And pw-sealed beat both Aperture arms on the home set's success
too (82% vs 76%/70%) — on the fixtures we designed to break *our*
bookkeeping, the incumbent held up better than we did, on our own sealed
surface. That sentence stays even though the CI includes zero, as colour.

---

## 3. H10, and the explanation the report must lead with

### 3.1 The economics verdict (licensed, robust)

- **neutral-large: 0.313× [0.271, 0.364]** — the preregistered headline
  claim is licensed; the CI is entirely below 1.0. Excluding
  catalog-order (§1's cell, where pw's dollars are failure dollars):
  **0.333× [0.275, 0.410]** — the claim does not depend on the ruling.
  Per successful episode it is stronger still (≈0.21× with the cell in).
- **home: 1.295× [1.043, 1.594] DEARER.** The wave-1/2/3 small-page
  premium, measured at last against the real incumbent. Mechanism, from
  the token splits the store now persists: at near-equal turns and
  *fewer* observation bytes (7,638 vs 10,362 chars/ep), the diff arm
  generated **6,285 output tokens/ep vs pw-sealed's 3,092** — the
  bookkeeping tax paid in generation-side tokens, exactly wave-3's
  hypothesis, now confirmed with the `modelUsage` field wave 3 lacked.
- **neutral-small: 0.957× [0.901, 1.023] null** — the sweep's s1–s2 null
  reproduced end-to-end against the real competitor.

### 3.2 What actually drove H10 below its bar

H10 printed `observation-byte share 46.7% — MECHANISM NOT CONFIRMED`,
turnCount (+25,612 tok/ep) the largest term. The decomposition in §0.3
shows that number is **one task wearing a mechanism costume**: the pooled
turn delta (+1.10 turns/ep) collapses to −0.01 without catalog-order, and
the obs-byte share rises to 80.6% (65.6% within neutral-large-minus-
catalog, where the *turn term runs against Aperture*). The report must
lead with this, verbatim in spirit:

> "Observation bytes are the mechanism. Where the economics claim lives —
> realistic-weight pages both arms actually solved — Aperture's saving is
> carried by the observation channel (obs-byte share 66–81%), with the
> turn count flat or slightly against it (its agents buy ~1 voluntary
> check-in turn). The pooled H10 share fell to 46.7% only because
> pw-sealed's catalog-order collapse added ~1 turn/ep of pooled excess;
> those turns are not an independent cost driver but the *behavioural*
> consequence of the same observation channel — an agent re-dumping and
> flailing on a 22k-token page it cannot scope. H10's arithmetic treats
> turns and bytes as separable; on this store they are not."

The guard behaved as designed — it forced exactly this paragraph into
existence rather than letting "diffs are cheaper because diffs are small"
be asserted unexamined. Its two blind spots are now on record for the next
edit (§8): it pools failure-loop cells into a mechanism share, and its
`turnCount` term prices turns at the *Aperture* arm's mean context, which
undercounts the pw arm's actual per-turn weight on large pages.

The specific answers to the brief's proposed explanations: *fewer forced
re-observations?* — no; outside catalog-order pw-sealed's voluntary
snapshot rate matches Aperture's (1.2–1.5/ep vs 1.3–2.4). *Better
recovery?* — not measurable here. *Empty responses under `--codegen none`
forcing extra probing?* — real and not confined to the collapsed cell
(pw-sealed logged 0.40/ep on home, 1.33/ep on neutral-small, 1.97/ep on
neutral-large: typing without submit, key presses and wheel scrolls all
return zero bytes), but outside catalog-order it did not convert into
extra full dumps — the voluntary snapshot rates match the Aperture arms —
so it is a minor cost term, held in check by the C5 description repair. The dominant truth is
simpler: on healthy tasks the arms take the same number of turns and pw's
turns each carry a full page.

---

## 4. The three-way decomposition — what the CIs permit

Success (Newcombe 95%): diff − redump **+2.7pp [−8.0, +13.4]** (the diff
mechanism); redump − sealed **+4.5pp [−6.8, +15.7]** (engine + dialect at
equal observation strategy); diff − sealed **+7.3pp [−3.8, +18.2]**.
Every interval includes zero, and the middle term flips sign without
catalog-order (−5.0pp [−16.3, +6.4]) — the decomposition is hostage to
the same cell as the headline. **What this permits: directional colour
only.** No sentence may attribute any share of the reliability headline to
the diff mechanism or to the engine; at n=110/arm this instrument cannot
separate them, and the report should say so in those words.

Where the three-way grid *did* earn its cost:

- **Precision decomposes significantly** (§2): the failure is
  engine/dialect (+0.27 [0.08, 0.49]), not mechanism (−0.10 [−0.36,
  +0.15]). This is the store's one attributable decomposition, and it
  points at our engine.
- **Economics decomposes by construction** (point estimates, colour):
  neutral-large $/ep 0.1947 (diff) / 0.4634 (redump) / 0.6223 (sealed) —
  the mechanism is worth 0.42× (diff/redump, same dialect) and the
  dialect a further 0.74× (redump/sealed, both full re-dump; Aperture's
  full snapshot of the same pages is ~3–4× smaller than pw's aria dump).
  Both terms are real; the mechanism is the larger.

---

## 5. RESULTS.md-ready text

> **Head-to-head vs Playwright MCP 0.0.78 — scored 2026-08-02, adjudicated
> in docs/design/h2h-evaluation.md (385 episodes, $104.53, cohort
> `dfa962c3f89b4d53`, claude-sonnet-5).** The shipped report exits 7
> (SHIM-SUSPECT: catalog-order); the tripwire's investigation is complete
> and ruled (fair product difference, not a shim or task artifact —
> h2h-evaluation §1), and this verdict is computed out of band with the
> suite's own stats code, the wave-2/-3 precedent.
>
> **Reliability (primary): the −10pp non-inferiority bound HOLDS.**
> aperture-diff − pw-sealed, pooled over all 13 tasks: +7.3pp
> [−3.8, +18.2]. Sensitivity, mandatory beside any citation: the delta is
> carried entirely by catalog-order (pw-sealed 0/10, all other arms
> 100%); excluding that one task it is −2.0pp [−13.1, +9.1], which
> straddles the bound — inconclusive at this n. On the disclosed-
> adversarial home set alone the incumbent led on success (82% vs 76%,
> CI includes zero).
>
> **Precision (primary): the +0.2/run wrong-element bound FAILS.**
> +0.173 [0.018, 0.345] pooled; +0.380 [0.060, 0.740] on the home set,
> where all of it lives. Attribution: 27 landed wrong-row clicks (diff)
> vs 8 (pw-sealed); zero `identity_mismatch` anywhere — a detector
> limitation on identical-label rows, not an absence of the hazard: the
> wire shows Aperture's ordinal refs re-keying to positions under row
> removal, so stale plans execute one row off where Playwright's
> per-snapshot refs error out (75 refused dead-ref acts, 9× Aperture's).
> Engine/dialect, not the diff mechanism (diff − redump −0.10 [−0.36,
> +0.15]; redump − sealed +0.27 [0.08, 0.49]). A correctness hazard on
> re-rendering same-label lists; fix cycle owed (tier3 §3.1's removal
> side). Full sentence: h2h-evaluation §2.3.
>
> **Economics (primary): the realistic-page claim is licensed.** On
> preregistered neutral fixtures at real-page snapshot weight
> (5.5–6k Aperture tokens; ~22k tokens in pw's dialect), end-to-end
> episode cost was **0.313× Playwright MCP's [0.271, 0.364]** (0.333×
> [0.275, 0.410] excluding catalog-order; ≈0.21× per successful
> episode). On small pages the inversion persists: home 1.295×
> [1.043, 1.594] DEARER — paid in generation-side tokens (6.3k vs 3.1k
> output tokens/ep at equal turns), the wave-3 mechanism confirmed with
> real token splits; neutral-small null (0.957× [0.901, 1.023]).
>
> **H10 (mechanism): printed NOT CONFIRMED at 46.7% observation-byte
> share; the true explanation, which this section must lead with:
> observation bytes ARE the mechanism where the claim lives** (80.6%
> pooled excluding catalog-order; 65.6% within neutral-large, where the
> turn term runs *against* Aperture). The pooled turn excess that
> depressed the share is one task's failure loop — pw-sealed re-dumping
> and flailing on a 22k-token page — i.e. behaviour downstream of
> observation size, not an independent turn advantage. Aperture holds no
> general turn advantage on this store.
>
> **Affordance (mandatory §7.4 sentence):** "Sealing Playwright MCP to
> three tools cost it measurable capability; the sealed comparison
> understates the incumbent, and the stock numbers are the
> deployment-relevant ones." pw-stock 89.1% vs pw-sealed 73.6%
> (Δ +15.5pp, greater than the headline CI half-width), the dividend
> concentrated in catalog-order (100% vs 0% — `browser_find` converts
> the 22k-token page every run) and the hard queue tasks. Non-ref
> targeting in pw-stock: 0.00/episode — the selector escape was never
> used. Any pw-stock claim carries "with code-execution,
> network-inspection and screenshot tools disabled" (§3.4,
> preregistered).
>
> **Scope, all mandatory:** one model (claude-sonnet-5, with the SDK's
> haiku-4-5 auxiliary present identically in all four arms — H7 clean);
> our fixtures (7 disclosed-adversarial + 6 preregistered-neutral;
> synthetic, not live web); MCP mode only (Playwright's recommended CLI
> mode unmeasured); `--pw-observation inline` (0.0.78 writes action
> snapshots to files and links them — the harness inlined the bytes,
> charging the competitor for the response its design document
> describes; `asshipped` is a different, unrun experiment); pw arms ran
> branded Chrome 150.0.7871.187 under `--pw-browser chrome` because the
> pinned chromium-1232 cannot spawn on this machine (probed:
> `spawn UNKNOWN`) — the spec's pinned chromium never ran, and Aperture
> ran its own Electron-bundled Chromium as always; sealed pw arms ran
> `--codegen none` (zero-byte replies for key/scroll/type-without-submit
> are its shipped conduct, C5-disclosed in the shared tool description);
> Aperture arms received `budgetTokens: 20000` injected on neutral-large
> (H6) while the sealed schema's `budgetTokens` is advertised-but-refused
> on pw arms (C3, disclosed in the arm definition); SDK
> `MAX_MCP_OUTPUT_TOKENS=50000` pinned in all arms (C1), delivered-bytes
> witness fired zero times (C2b); account-prefs is a case-sensitive
> predicate defect scored as failure in every arm (h2h-evaluation §0.4)
> — kept in the pool, excluded from cost claims (H11), not a capability
> finding. Wall-clock reported, never verdicted: pw-sealed's ~40s/ep of
> browser-side time on home (vs Aperture's ~1.1s, per-proxy `upstreamMs`)
> is a real, attributable felt-latency gap the §2 boilerplate
> ("dominated by API queueing noise") understates. Guard-layer record and
> what the benchmark cannot settle: h2h-evaluation §6–§7. Programme
> lineage: four archived cohorts ($77.38 — kill shot; pilot with the
> pw-stock zero-tool registration fault; the unset-MCP-cap contamination
> cohort; the C2c-severed cohort) precede this clean one (0 harness
> faults, 0 contaminated).

### README-ready paragraph

> On a 13-task benchmark against Playwright MCP 0.0.78 (both products
> sealed to an identical 3-tool surface; claude-sonnet-5; design
> preregistered in docs/design/headtohead.md, adjudicated in
> docs/design/h2h-evaluation.md): on realistic-weight pages Aperture's
> diff observation cut end-to-end agent cost to **0.31× [0.27, 0.36]** of
> Playwright MCP's, with the saving attributable to observation bytes,
> and task success within the preregistered −10pp bound (+7.3pp [−3.8,
> +18.2] — carried by one task where the sealed incumbent scored 0%;
> excluding it, parity is unresolved at this n). Aperture **lost the
> precision primary** (+0.17 [0.02, 0.35] wrong-element actions/run vs a
> +0.2 bound): on re-rendering identical-row lists its persistent refs
> let stale plans land one row off where Playwright's per-snapshot refs
> error out — a correctness hazard we are fixing, not a cost. On small
> pages Aperture was 1.30× dearer [1.04, 1.59]; unsealed, Playwright MCP
> with its full default surface (code-execution, network-inspection and
> screenshot tools disabled) outscored its own sealed configuration
> 89% to 74%, so the sealed comparison understates the incumbent and
> stock Playwright remains the stronger choice where its full surface is
> acceptable. One model, our fixtures, MCP mode only; Playwright's CLI
> mode and live websites are unmeasured.

---

## 6. Guard-layer credibility — one paragraph

The layer's full record this programme: **three apparatus faults, all
real, all caught before a verdict** — (1) the pw-stock schema-registration
fault (server 500'd at initialize; 22 zero-tool episodes; caught by the
pilot wipeout after H0/H1/H3/H4 had certified the arm through
`proxy.direct` instead of the wire — fixed with wire-routed solver steps
and the both-ways SHIM-SUSPECT, RED-proved); (2) the SDK's unset MCP
output cap silently eating pw's ~87K-char snapshots (caught because
SHIM-SUSPECT forced the catalog-order investigation; it had flipped the
reliability headline's sign; fixed by C1's pinned 50k cap + C2b's
delivered-bytes witness, RED-proved against the four contaminated
episodes, 0 false positives across 90); and (3) the C2c reconciliation
heuristic, which **manufactured a finding** — it flagged four delivered
episodes (two of them successes) on a cacheRead accounting error and was
demoted to advisory-only in the same commit that ruled the restored cell
genuine. One genuine competitor limitation was found and turned into a
human ruling rather than a silent choice (0.0.78 links action snapshots
to files; a filesystem-less agent would have observed nothing;
`--pw-observation inline|asshipped` is now a stamped, unpoolable identity
choice), plus two smaller ones handled the same way (zero-byte action
replies under `--codegen none` → the C5 description repair; frame-prefixed
refs → the widened grammar). Verdict on the layer: **still
discriminating.** Every alarm it raised was adjudicated by evidence
against the store, the one guard that invented signal was demoted rather
than allowed to exclude cells, its load-bearing successor (C2b) fired
zero times on the clean cohort, and the surviving tripwire
(SHIM-SUSPECT) was — on investigation — flagging a genuine result, which
is what a tripwire is for. The residual bias to watch is structural, not
evidential: three of its four kills were the harness's own defects, so
the layer's history says our first-draft apparatus is the most dangerous
component in this benchmark — and that the layer, not the coordinators'
aggregate readings (wrong twice more in this brief alone, §0), is what
has kept the numbers honest. Trust the final numbers to the extent they
survived it: 0 faults, 0 contaminated, every detector RED-proved, and the
one open flag ruled here rather than waved through.

---

## 7. What this benchmark can never settle

1. **Live-web generalisation.** Six neutral fixtures at realistic token
   weight are still synthetic, static, logged-out, and bot-friendly. No
   anti-bot, no A/B drift, no iframes, no auth. (headtohead.md §11.1's
   WebArena-class follow-up remains the only honest path.)
2. **Other models.** Everything above is claude-sonnet-5 with one prompt
   discipline. The catalog-order collapse in particular is a fact about
   *this model's* retrieval-under-load as much as about either product; a
   model that reads 22k-token dumps reliably — or one that cannot read 6k
   — moves every headline number.
3. **Familiarity asymmetry, unclaimable in either direction.** Sonnet has
   trained on Playwright's dialect and never on Aperture's. A pw win may
   be partly familiarity; an Aperture win is despite it; neither is
   measurable here.
4. **The sealed frame itself.** The 3-tool seal is Aperture's shape.
   pw-sealed measures Playwright's observation channel behind our
   affordance set — a construct no Playwright user runs. The stock arm
   bounds the distortion (+15.5pp) but with four escape-hatch tools
   withheld, so "Playwright MCP as deployed" is bracketed, never measured.
5. **Playwright's CLI/skills mode** — the incumbent's own recommended
   token-efficient path (its README concedes the MCP token axis). If that
   mode wins the economics, MCP-vs-MCP was the wrong fight; nothing here
   detects it.
6. **Long horizons and the truncation regime.** ≤16 actions, budgets that
   always fit. Context compaction over hundreds of actions — where diff
   token ceilings and re-dump context flooding actually diverge — and the
   page-bigger-than-budget regime are unexercised in both products.
7. **Which precision mechanism, per act.** On identical-label rows the
   witness can prove a wrong element was hit but can never separate
   agent ordinal-arithmetic error from silent ref rebinding on any single
   act. The clustering evidence (§2.2) is strong; per-act ground truth
   would need instrumentation neither product exposes.
8. **Wall-clock as felt.** Reported with the browser-time decomposition
   (which this store shows is NOT noise: ~40s/ep browser-side for pw on
   home vs ~1s for Aperture), but API queueing still dominates the
   remainder and no verdict is licensed.

---

## 8. Obligations created by this adjudication (next harness/cohort edits — no code now)

1. **Report prints the browser override.** `report()` must surface
   `pwBrowserOverride` from the cohort sidecar; H0's promise ("printed in
   every report") is currently kept only by the preflight. (§0.5)
2. **SHIM-SUSPECT ruling acknowledgement.** A `--ruling <doc>` path that
   lets `--report` exit 0 while printing the flag *and* the ruling
   reference, so an adjudicated store does not read as a faulted one
   forever.
3. **account-prefs predicate** case-normalizes (`String(v).toLowerCase()`
   at the fixture's state fn). Severs the cohort; next run only. (§0.4)
4. **H10 hardening:** print the pooled share alongside
   minus-flagged-cells (any SHIM-SUSPECT or H11 cell), and price the turn
   term at each arm's own per-turn context rather than the aperture
   arm's. Wave 1's per-task rule caught this; the pooled headline should
   not need an adjudicator to re-derive it. (§3.2)
5. **§2 wall-clock boilerplate** amended to cite the measured
   `upstreamMs` split instead of attributing the whole gap to queueing
   noise. (§5 scope block)
6. **§5.2 vocabulary note:** document that `identity_mismatch` is
   unreachable on identical-label rows and that `wrong_choice` there
   bundles the rebind hazard. (§0.6)
7. **Engine, stage-C:** the removal-side rebinding fix (escalate
   positional-family shrink, or retire-and-reissue on membership change)
   — the §2.3 fix cycle, measured by a fresh cohort on an unchanged task
   set before the precision sentence can be retired.

---

*Recomputation note: every interval above reproduces with
`bench/lib/stats.mjs` (seeds 20260802 for bootstrap CIs, Newcombe for
proportions) over `bench/headtohead/results/episodes.jsonl`, filtering
nothing except where stated. The archived stores
(`episodes.20260802T{110003,134505,165251,192640}Z.jsonl`) are
fault-history evidence only and must never pool with the live store —
five distinct cohort identities, one clean.*
