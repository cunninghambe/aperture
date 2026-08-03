# Handoff

State as of `1381e10` (head-to-head scored and adjudicated). If you are picking
this up cold, read this file, then [`bench/RESULTS.md`](../bench/RESULTS.md),
then the three adjudications in `docs/design/` (`wave3-evaluation.md`,
`sweep-evaluation.md`, `h2h-evaluation.md`). **The adjudications outrank the
raw reports** — three of the five scored stores are scored *out of band*
because the suite's own guards correctly refuse to print a verdict on them.

---

## Where this stands

The browser runs, the MCP server works, `browser_act` closes the act-observe
loop (click, type, clear, hover, scroll, key, select), and Claude Code can
drive it end to end. The full test suite passes; `npm run typecheck` is clean.

```
bench:fidelity form       GREEN   18/18 refs · 13 diffs + 1 forced resync · 0 wrong [N options] markers
bench:fidelity rerender   GREEN   17/17 refs · 0 phantoms through full DOM teardowns
bench:fidelity widgets    GREEN   6/6 refs · clicks, +checked/+expanded, shadow DOM, clock suppressed
bench:fidelity biglist    GREEN   71/71 refs · 70 refs die and revive · size-cap resync fired
bench:fidelity selects    GREEN   7/7 refs · 4 native selects + a custom ARIA combobox
bench:guards              GREEN   11/11 refusals and retractions (1/11 on the pre-fix build)
npm run bench             ok      6.6x–10.2x synthetic observation-token model
```

The diff design has now been measured end to end against a real competitor.
**It won the cost primary and lost the precision primary.** The precision
failure is a live correctness hazard in our engine, it is the top open defect,
and it is not fixed.

---

## The measurement programme

| campaign | scope | verdict |
|---|---|---|
| Wave 1 — 100 ep, Sonnet 5 | 10 tasks, 1.4–8.0 KB fixtures | **INCONCLUSIVE (ceiling)**, both arms 100%. Produced a cost "finding" that later failed as a finding — see below |
| Wave 2 — 251 ep, $37.34 | 7 bookkeeping-hard tasks | **PARITY**, but exclusion-conditional and fragile; the −5pp/"parity" vocabulary is now retired as unreachable at any affordable n |
| Wave 3 — 230 ep, $76.91 | 3 positional-identity tasks + 2 canaries, post-P1 engine | **PASS**: no diff-bookkeeping penalty larger than 10pp in success or +0.4 wrong-element/run, n=105/arm. MDE ~23.5pp. Diff arm +4.4% dearer in dollars |
| Size sweep Tier B — 54 ep, $9.88 | `cart-adjust`, 5 page-weight tiers, 1,116–38,081 chars | **One-sided no-crossover**: never significantly dearer, significantly cheaper from s3 (~10k chars) up, 19/39/43% at s3/s4/s5 |
| Head-to-head — 385 ep, $104.53 | vs `@playwright/mcp@0.0.78`, 4 arms, 13 tasks | Cost **licensed** (0.31× [0.27, 0.36] on realistic-weight pages); reliability bound **holds but is carried by one task**; precision bound **FAILS** |

**Rules that bind every citation of these numbers:**

- **Wave 2, wave 3 and the head-to-head are scored out of band.** Wave 2's
  `report()` exits 3 (wedged episodes trip G3), wave 3's exits 3 (a 26-byte
  engine validation error classified `other`), the h2h's exits 7 (SHIM-SUSPECT
  on `catalog-order`). Every refusal was investigated and ruled; the rulings
  are in the adjudications and the verdicts were recomputed there with the
  suite's own stats code. A store that exits non-zero is not a faulted store —
  read the ruling.
- **Never pool cohorts.** Different engine stamps, different task sets.
  Cross-wave comparisons are directional narrative only, never CI'd.
- **The size sweep's own printed band sentence is false for its own data**
  (`NO CLOSED BAND — every tier's CI straddles zero`, printed above a table
  where three of five CIs sit entirely below zero). Do not quote it; quote
  sweep-evaluation §1.2.
- **`bench/size/results.jsonl` holds four extra rows** from an earlier aborted
  run. Any recomputation must filter `runId === '2026-08-02T05:39:27.192Z'`.
- **Wave 1's pooled "+5.2% — diffs cost more" is arithmetic, not a finding.**
  Split by subset the sign flips (six tasks with zero voluntary observations:
  −4.1%; four with them: +20.9%). It was published twice before anyone split
  it. Pooling hid a sign change — this is the failure mode this programme keeps
  catching its own coordinators in, most recently in the h2h brief (§0).

---

## Open defects, with their evidence

### 1. Removal-side ordinal rebinding — the headline, and it lost a primary

**What.** A positional family (identical rows, no ids, no distinguishing
accessible names) re-keys **downward** when a member is removed. The
restatement block retires only the *tail* refs (`! e2 replaced (gone: e57
e58)`) and silently re-binds e3–e16 to *positions*: the same `e10` means "the
4th row's Reject" before and after, whatever submission now sits 4th.

**Consequence.** A plan captured against snapshot N executes one row off after
any removal above it, silently, labels agreeing. The click **lands**.
Playwright cannot make this mistake land — its refs are per-snapshot and a
stale one is refused — so the same underlying staleness pays out in the
opposite currency: **Aperture executes stale plans; Playwright refuses them.**

**Evidence.** h2h-evaluation §2. Pooled wrong-element +0.173/run [0.018, 0.345]
against a preregistered +0.2 bound → **BOUND FAILS**; +0.380 [0.060, 0.740] on
the home set, where all of it lives. 27 landed wrong-row clicks (Aperture-diff)
vs 8 (pw-sealed), while pw-sealed logged 75 refused dead-ref acts, 9× ours. The
decomposition attributes it to the engine, **not** the diff mechanism
(diff − redump −0.10 [−0.36, +0.15]; redump − sealed +0.27 [0.08, 0.49]). The
wrong rejects cluster exactly on the rows that *slid into* the 5th/9th/13th
positions after the first removal — identical sequences across runs.

**Status of the surrounding work.** tier3 §3.1 recorded the rebinding gap.
tier4 §1 closed only the **growth** side (a positional family that gains a
member escalates to a full `replace`). **The removal side is live.**

**Candidate fixes** (h2h §2.3): escalate positional-family *shrink* the way
growth escalates, or retire-and-reissue the whole family's refs on any
membership change. Both trade landed-wrong for refused-stale — deliberately
moving to Playwright's side of the silent-vs-loud tradeoff on this markup
class. That is an engine decision for a stage-C window and a **fresh cohort**;
nothing in the existing store can be re-scored under it.

**Domain honesty, both directions.** The home fixtures were *built* to produce
this (disclosed adversarial); wrong-element is 0.000 on every neutral fixture
with realistic markup. So the hazard's measured domain is re-rendering
same-label lists — queues, tables, feeds — real but not universal. And
pw-sealed also beat both Aperture arms on home-set *success* (82% vs 76%/70%):
on the fixtures we designed to break our own bookkeeping, the incumbent held up
better than we did, on our own sealed surface.

### 2. `identity_mismatch` cannot fire on identical-label rows

The detector compares labels; the queue rows are identical by construction, so
a rebound ref lands on a same-labelled button and `labelsAgree` passes. Zero
`identity_mismatch` in 385 episodes is a **detector limitation, not an absence
of the hazard** — `wrong_choice` bundles the rebind route there. Never cite the
zero as evidence. (h2h §0.6, obligation §8.6.)

### 3. Replace-op elision can hide a changed survivor

A replace subtree renders collapsed. A surviving ref in the elided tail whose
*content changed in the same re-render* goes stale in the model with no
re-announcement (`runOwesReannounce` covers revived refs, not changed ones). No
fixture constructs this; it is the most plausible remaining fidelity hole.
tier2 §1 (expand `add`/`replace` subtrees, `expand: false` → `true` at
render.ts ~410 and ~433) is the ruled fix and has **not** landed.

### 4. `~ eN "A"` is ambiguous by format

One quoted string could be a name change or a text change; no reader, model or
mechanical, can tell. Harmless today because name and text co-change for the
nodes that emit it, but the format owes a disambiguator. Deliberately deferred
(tier2 §10) rather than forced through a wire-format change mid-backlog.

### 5. `inert`, `pointer-events: none`, and small modal dialogs

`statesOf` consults `:disabled` only; the `select` handler refuses on
`isDisabled` only; `resolveRef`'s hit-test catches a *covering* overlay but not
these. So: a `<select>` inside an `[inert]` subtree is writable by
`action:"select"`; a control in the inert background of a small
`dialog.showModal()` is clickable whenever the dialog does not cover its point;
and a `pointer-events: none` target hit-tests to whatever is beneath it,
producing an obstruction error naming an innocent bystander. Every one is the
agent acting where a human demonstrably cannot. Spec: tier2 §5.

### 6. Input-witness (W1) residuals

W1 now covers scroll and key as well as element-targeted acts (tier3 §1.3,
closing the Gate-2 open item), and its `unknown`/`landed`/`lost` tallies are
exposed on `/metrics` with a >10% advisory (tier4 §6.3). Two residuals stand,
both by design and both stated in the contract:

- **`unknown` never fails an act.** A dead poll channel, a failed arming, or a
  subframe-and-silent act all fall through to `observe`.
- **A page that self-navigates on a timer during settle yields `unknown` per
  act**, so a wedge on that page class is invisible to W1 — bounded only by the
  bench liveness canary, whose fixture does not navigate.

Related loose thread, still on the books: the once-in-~450-acts `ok click e6`
that never reached the button (wave 1), unreproduced in three cold starts. W1
is the mechanism that would now catch it; nothing has re-observed it.

### 7. Benchmark and harness defects found by the adjudications

- **`crossoverBand` (bench/size.mjs:1464–1495) prints a false sentence** for
  the one band shape reality produced. `--dry`'s four test cases enumerate
  win / lose / band / all-straddle and miss `[straddle, straddle, below,
  below, below]`. Spec for the fix, including the licensed-sentence assembly
  and the new dry cases: sweep-evaluation §2.
- **`modelUsage` token splits are still not persisted by `size.mjs`**, despite
  wave3-evaluation §4 item 2 naming that field as the one addition Tier B
  needed. The input-weight vs generation-side decomposition of the small-page
  premium has now survived three cohorts unanswered. (The h2h *does* persist
  them, which is how the h2h could attribute the home-set premium to output
  tokens: 6.3k vs 3.1k per episode at equal turns.)
- **The two-regressor cost fit is unidentified** on the sweep's design —
  R² = 0.921 but a *negative* per-turn coefficient (fitted prefix −13,273 chars
  vs 4,268 measured). Cite the one-regressor description (slope 8.1×10⁻⁷
  $/char, R² 0.908) or nothing; never "the prefix costs X".
- **H10's mechanism guard pools failure-loop cells** into a mechanism share and
  prices the turn term at the Aperture arm's per-turn context. That is why it
  printed `NOT CONFIRMED` at 46.7% observation-byte share when the true figure
  where the claim lives is 66–81%. Fix spec: h2h §8.4.
- **`account-prefs` has a case-sensitive predicate defect** — agents completed
  the task, the page said `digest Weekly`, the predicate wanted `weekly`. Every
  arm "failed" it. Symmetric, so it moves the headline by one episode; it is
  **not** a capability finding and must never be quoted as one. Fix severs the
  cohort. (h2h §0.4, obligation §8.3.)
- **`report()` never prints `pwBrowserOverride`**, despite the harness comment
  promising it does. Every pw episode ran branded Chrome 150.0.7871.187, not
  the pinned chromium-1232 (which cannot spawn on this machine —
  `spawn UNKNOWN`), while the cohort's `chromium.browserVersion` records the
  pinned build that never ran. Scoring integrity is unaffected; the disclosure
  is mandatory. (h2h §0.5, obligation §8.1.)

### 8. Standing gaps in what the benches can see

- **Structure and position are not part of "faithful".** The fidelity bench
  verifies existence + role + label + value + states. A stream that scrambled
  containment would pass. Designed, not built.
- **Model-side budget truncation is unmeasured.** The bench aborts when the
  *truth* is cut, but an agent living on a 2000-token budget of a 9k-token page
  is the production case and no scenario measures it.
- **iframes** are claimed by the design and exercised by no benchmark or test.
- **The obstruction gate is exercised only by `bench:guards`** (G7a/G7b); no
  fidelity scenario raises a modal, so a hit-test regression would slip past
  the standing five.
- **`[N options]` staleness is measurable but only on the guard fixture** — no
  fidelity scenario contains a dependent select.
- **Shadow-root focus is invisible to the walker** (`document.activeElement` is
  the host, which gets pruned) — model and truth agree, so the bench cannot see
  it either. A known shared blind spot.
- **Equal-size same-walk family churn is undetectable in principle** at the key
  level — see the deferred backlog.

### 9. Product surfaces not finished

- **Vault MCP fill path** — refuses deliberately (`fill refused: the vault fill
  path is not yet wired in this build`). Unblocked since the consent dialog
  exists. tier2 §6 sequences the WebAuthn probe ahead of its design on purpose:
  if Electron cannot host a platform authenticator, passkeys become a
  Chromium-patch project and the vault roadmap stays password-primary.
- **Multi-select is replace-only.** Adding to an existing selection is not
  expressible; the result says so out loud rather than implying otherwise.
- **Optgroups are passive** — shown in listings and errors, never matched.
  `"group > label"` queries are deferred, so two same-labelled options in
  different groups are distinguishable only by value.
- **Per-container fingerprint derivation is not applied** — the seed exists and
  is stable, nothing derives from it yet.
- **Attachments**: multi-upload forms need the ref→node bridge.
- **The Notion API path is unverified** and falls back to disk.

---

## Obligations created by the h2h adjudication (§8) — no code was written for any of these

1. **`report()` must print the browser override** — surface `pwBrowserOverride`
   from the cohort sidecar. H0's promise is currently kept only by the
   preflight.
2. **A SHIM-SUSPECT ruling acknowledgement** — a `--ruling <doc>` path letting
   `--report` exit 0 while printing both the flag and the ruling reference, so
   an adjudicated store stops reading as a faulted one forever.
3. **`account-prefs` predicate case-normalizes** (`String(v).toLowerCase()` at
   the fixture's state fn). Severs the cohort; next run only.
4. **H10 hardening** — print the pooled share alongside minus-flagged-cells
   (any SHIM-SUSPECT or H11 cell), and price the turn term at each arm's own
   per-turn context rather than the Aperture arm's.
5. **§2 wall-clock boilerplate** amended to cite the measured `upstreamMs`
   split instead of attributing the whole gap to queueing noise. The gap is
   real and attributable: pw-sealed ~40s/ep of browser-side time on home vs
   Aperture's ~1.1s.
6. **§5.2 vocabulary note** — document that `identity_mismatch` is unreachable
   on identical-label rows and that `wrong_choice` there bundles the rebind
   hazard.
7. **Engine, stage-C: the removal-side rebinding fix** (defect 1 above),
   measured by a fresh cohort on an unchanged task set before the precision
   sentence can be retired.

---

## Deferred backlog

**From `tier2.md`** (its own §9 order; §4 is the only item that has since been
done — the size sweep ran):

- **§1 — expand `add`/`replace` op subtrees in diffs** (stage C). Ruled DO IT;
  `expand: false` is still hardcoded at both render sites. This is also the fix
  for defect 3 and retires the `finder-cheapest` collapse cost.
- **§2 — sharpen `streamAssert`** to `streamAssert(diffStream, acts)` so
  `queue-positional`'s assertion actually discriminates positional from
  content-based keying (stage C).
- **§3 — preload reason strings narrowed to a fixed vocabulary**
  (`reason: 'exception'` + a 200-char detail) at all five `catch` sites in
  `page.ts`. security.md records four; the `select` handler made it five, which
  is the argument for the item: a construction does not need re-making every
  time a handler lands.
- **§5 — `inert` / `pointer-events: none` / small modal dialogs** (defect 5).
- **§6 — the security verification queue.** Two probes are real work and
  neither has run: **WebAuthn platform authenticator in Electron** (ranked
  first — it decides whether passkeys are reachable at all) and
  **`setContentProtection` vs capture on Windows 11** (the vault window
  currently asserts the favourable answer in a comment, which is exactly the
  class of claim this project's method section exists because of). Item #6
  (`Input.insertText` fidelity) is closed by inspection; item #4 (webRequest
  listener eviction) is moot until §7 lands and is then handled by
  construction; item #3 (debugger detectability) is queued behind a trigger
  condition.
- **§7 — Web Bot Auth.** Part 3 (`docs/design/webbotauth.md` + the Cloudflare
  enrollment investigation) was marked LANDS NOW and has **not** been written.
  Part 2 is the stage-C implementation: `src/net/botAuth.ts` (per-install
  Ed25519, RFC 9421 signature base, `Signature`/`Signature-Input`/
  `Signature-Agent`) routed through one multiplexed
  `src/net/webRequestMux.ts`, signing only agent-attributable requests, off by
  default. **The "register as a signed agent before 2026-09-15" goal is
  killed** — that is Cloudflare's rollout date, not a registration cutoff, and
  there is no sound custody story for a project key shipped inside every
  install. The README now says this.
- **§8 — two hygiene comments** (engine.ts's inert diff-seq burn; proxy.mjs's
  byte-symmetry argument, which tier1b §1 corrected). Ride-alongs on the first
  stage-C commit touching each file.
- **A CI workflow** — deferred with no successor milestone (tier4 §6.2).
  `test/typecheck.test.ts` already makes `npm test` self-sufficient.

**Measurement gaps nobody has run:**

- **Hard tasks × big pages.** The one unmeasured quadrant. The sweep is
  low-pressure (7–9 turns); wave-3-class episodes run 11–23 turns with
  voluntary observation in *both* arms. It is the one place the sweep's flat
  ~1-voluntary-observation residue could plausibly break. (sweep §4/§5.)
- **The truncation regime.** Excluded by design from the sweep, yet it is the
  default product experience on pages bigger than the budget — the sweep priced
  the 20k-token enabler world, not the 2k-token default world.
- **The small-page premium itself.** Waves 1–3 measured +4–6%; the sweep's
  s1–s2 nulls cap it at +10–20% of episode cost but neither confirm nor refute
  it. Resolving a ~5% effect there needs ~100 episodes/arm **or** the
  `modelUsage` token-split field, whichever is cheaper. The field is cheaper.
- **P2 equal-size same-walk family churn.** A positional family that loses one
  member and gains another in the same walk is **undetectable in principle** at
  the key level (`added` stays false, membership size is unchanged), so no
  fixture can produce it and no diff-side rule can catch it. Recorded rather
  than pretended at (tier4 §1.4 residual 1, §10). If it is ever to be closed it
  needs walker-side identity rebinding — new identity machinery, ruled out of
  tier4 on the `replaceChildren` false-positive argument.
- **Live-web generalisation.** Every scored fixture is synthetic, static,
  logged-out and bot-friendly. headtohead.md §11.1's WebArena-class follow-up
  remains the only honest path.
- **Other models, Playwright's CLI/skills mode, long horizons.** All named in
  h2h §7 as things this benchmark can never settle.

---

## Running the benchmarks

One scenario per freshly started Aperture is the *recommendation* (clean
measurement, honest ref counts), not a correctness requirement — label
targeting removed the failure mode and exit 3 catches anything that still goes
wrong.

```bash
# -c-1 is not optional: without it Electron caches the fixtures and an edited
# fixture is measured in its OLD form, silently. fidelity.mjs also appends a
# cache-busting query to the navigation URL for the same reason.
npx http-server test/fixtures -p 8899 -c-1 --silent &
npx electron . > /tmp/ap.log 2>&1 &
sleep 15
TOK=$(grep -oE "Bearer [A-Za-z0-9_-]+" /tmp/ap.log | head -1 | cut -d' ' -f2)
node bench/fidelity.mjs "$TOK" form   # or rerender | widgets | biglist | selects
npm run bench:guards -- "$TOK"        # optional 2nd arg: fixture base URL
```

All five fidelity scenarios in one go, one fresh Aperture each:
`bash bench/fidelity-all.sh`.

Exit codes for `fidelity.mjs`: 0 green · 1 red · 2 truth unusable · 3 step
failed · 4 **vacuous** (a run that measured nothing refuses to print a verdict
at all). `guards.mjs`: 0 all guards hold · 1 a guard failed · 3 could not run.

The scored suites own their whole world — each refuses to start if 8817 is in
use, then starts its own Aperture, a `no-store` fixture server, the witness
collector and the MCP proxy, and tears all of it down on exit:

```bash
npm run bench:task -- --selftest                # G1+G2 only, spends NO API budget
npm run bench:task -- --plan                    # a concrete phase plan. Starts nothing.
npm run bench:task -- --n 5                     # a phase
npm run bench:task -- --report                  # pooled verdict. Runs no episodes, needs no port.

node bench/size.mjs --dry                       # band/template self-test, no budget
node bench/size.mjs --selftest                  # Tier A
node bench/size.mjs --sweep --n 6               # Tier B (add --force-budget only on an explicit ruling)

node bench/headtohead/h2h.mjs --lint            # fixture linter
node bench/headtohead/h2h.mjs --selftest        # H0–H4 guards, no API budget
node bench/headtohead/h2h.mjs --report          # exits 7 on the current store — read h2h-evaluation §1
```

Others: `npm run bench` (synthetic diff model), `npm run bench:live` (real-site
sizes, ref stability, and the envelope's both-ways assertion).

## Cohort integrity — read this before editing anything

Accumulating episodes across sessions is valid only if the thing under test did
not change between them. Every episode is stamped with a **content hash** of
the product source, the built artifacts in `out/`, every fixture, the task
definitions, the arm-forcing rule, the prompt and the verdict thresholds — content
hashes, not the git SHA, so an uncommitted edit moves them. If the store holds
episodes that disagree with the current tree, the run **refuses to aggregate
(exit 6)** before starting Aperture, names the field and the files that moved,
and says how many episodes are affected.

There is deliberately no override. `--new-cohort` archives the old store under a
timestamp and starts a fresh one; nothing is discarded and nothing is pooled
across versions. `episodes.cohort.json` records the file table the episodes on
record were produced from, which is what makes the refusal a diagnosis rather
than a hash mismatch.

Practical consequence, and it has shaped every plan in this repo: **a one-line
comment edit in a watched file severs the store.** That is why the specs
partition work into stages, why the size sweep had to run before the first
stage-C commit, and why fixes discovered mid-cohort wait for a bundle.
`bench/size/**` and `bench/guards.mjs` are outside the watched set.

## Method that has actually worked here

Every time something marked "working" was measured end to end, it was broken:
the crash pipeline, the HN snapshot, the UA client hints, the benchmark harness
twice, the fidelity ground truth, volatility-in-act-loops, shadow-DOM clicks,
the `select` pass's first green (a stale cached fixture and a mechanism test
with no teeth) and its second (seven adversarial findings, every one real).
Every time, the unit tests and the assumption agreed with each other, and only
the real output disagreed.

Three corollaries earned the hard way:

- **A benchmark that cannot see a field is not evidence about that field, and
  it looks exactly like a benchmark that checked it.** The shared stream reader
  required a role-plus-ref prefix to parse a line, so `[N options]` was dropped
  on the floor and no scenario could go red on a stale marker however wrong the
  agent's belief. When adding a claim to the product, check that the reader can
  see the bytes that carry it.
- **`tsc` agrees too.** The `select` success path read a variable declared
  inside the failure branch and compiled clean, because `origin` is a DOM
  global — the type checker bound it to `lib.dom` while the main process would
  have thrown `ReferenceError` on every successful select.
- **Pooling hides sign changes.** Wave 1's cost headline was right about the
  aggregate and wrong about every subset. The h2h's reliability headline is
  carried entirely by one task and its H10 mechanism share was one task wearing
  a mechanism costume. A number consistent with a story is not the same as a
  true one — split it before you publish it.

The guard layer is the thing that has kept the numbers honest, not the
coordinators' aggregate readings. Its full record across this programme: three
apparatus faults, all real, all caught before a verdict; one guard that
*manufactured* a finding and was demoted to advisory rather than allowed to
exclude cells; and one surviving tripwire which, on investigation, was flagging
a genuine result. Three of its four kills were the harness's own defects — so
the layer's history says our first-draft apparatus is the most dangerous
component in any benchmark here.

Instrument and compare against ground truth. Do not reason from the code alone,
do not trust a verdict without the counts behind it — and when a benchmark goes
green, spend a day trying to make it lie to you before you believe it.
