# Tier 1b designs — after the wave-1 cost inversion

Three designs architected 2026-08-01, from the 100-episode wave-1 result
(`bench/RESULTS.md`, final section). Decision-complete: every load-bearing call
is made here, with its reasoning. An implementer should not need to choose
anything; a reviewer should be able to tell a deviation from a decision.

Everything below was written after reading the code, not the write-up, and one
correction to the write-up is load-bearing enough to lead with.

---

## 0. The diagnosis RESULTS.md got subtly wrong, from the episode store

RESULTS.md frames mechanism 1 as: *"If an act produces no observable delta,
that belongs in the act's own result, not in a separate observation the agent
has to spend a turn on."* **The premise is false — it already does, and none of
the 18 `nochange` observations came from acts.** Verified from
`bench/task/results/episodes.jsonl`, not inferred:

- Every diff-arm act embedded exactly one observation, and every one of those
  was a diff: `kinds.diff == pageActions` in all 10 diff-arm task rows
  (186 == 186 pooled), and `attributions` is `{ok: 372}` — zero errored acts,
  so no error-path observations muddy the count.
- Therefore all 90 non-act observations in the diff arm came from voluntary
  `browser_snapshot` calls: 50 initial fulls + 22 voluntary fulls + 18
  `nochange`. The re-dump arm made 56 snapshot calls: 50 initial + 6 voluntary
  (all 6 in `finder-cheapest`).
- The 18 `nochange` and 22 voluntary fulls concentrate in exactly four tasks:

  | task | voluntary full | nochange | prompt property |
  |---|---|---|---|
  | cart-adjust | 8 | 5 (5/5 episodes) | "Do not change anything else" |
  | finder-cheapest | 9 | 5 (5/5) | superlative over a **collapsed** list |
  | inbox-archive | 5 | 5 (5/5) | "Do not archive anything else" |
  | settings-config | 0 | 3 (3/5) | three independent toggles |
  | all six others | 0 | 0 | — |

So the wasted round trips are **agent-chosen verification snapshots**, made
when the prompt asserts a global invariant, plus (in `finder`) structurally
forced re-reads of run-collapsed lists (`… 9 more listitems` hides candidate
prices; both arms did it — 9 voluntary fulls in diff, all 6 of re-dump's
voluntary snapshots are this task). A `browser_snapshot mode:auto` when
nothing has changed since the act's own diff returns `(no visible change)` —
the agent pays a full turn to hear "you already knew that."

Three consequences for the designs below:

1. Item 1's fix is **not** "move no-change into the act result" — it is (a)
   teach the model the completeness guarantee that makes verification
   snapshots pointless, (b) make the unavoidable no-change response honest,
   distinct by cause, and cheap, and (c) stop it consuming the diff budget.
2. Item 2's crossover is **behavioral, not mechanical**. With equal turn
   counts the diff arm is strictly cheaper at every page size (same messages,
   smaller observations — the scripted G2 data shows 0.48x on cart). The 5.2%
   inversion is entirely the +0.58 voluntary turns/episode. A byte sweep that
   only measures bytes would "find" no crossover and answer nothing; the sweep
   must carry real agents.
3. The turn-count delta (429 vs 400 SDK turns = +0.58/ep) matches the
   observation-call delta (90 vs 56 = +0.68/ep) to within SDK turn-accounting
   noise. There is no third mechanism hiding.

### Integrity master plan (read before touching anything)

Every fix below edits watched files (`bench/lib/store.mjs` WATCH_DIRS/FILES:
`src/core/snapshot`, `src/mcp`, `src/preload`, `bench/fixtures`,
`bench/task.mjs`, `bench/tasks.mjs`, `bench/lib/*.mjs`). Any one of them moves
`codeVersion` and the next scored run exits 6. **So: land items 1 and 3 (and
item 2's small product enabler) as ONE change set, run the full verification
battery, then start the wave-2 cohort with `--new-cohort`.** The wave-1 store
is archived by that flag, not deleted; its INCONCLUSIVE stands as recorded and
`bench/RESULTS.md` is not edited retroactively.

Also bump `SUITE_VERSION` in `bench/lib/store.mjs` to `2026-08-02.1`: the
content hashes would catch the edits anyway, but the bump records that the new
cohort is a *deliberately* different experiment (store.mjs itself is unwatched
by design, and the version constant is the intent channel).

Sequence, exactly:

1. Land all edits in items 1 + 2-enabler + 3.
2. `npx tsc --noEmit` · `npx vitest run` · `npx electron-vite build`.
3. `bench:fidelity` × 5 scenarios GREEN · `bench/guards.mjs` all green
   (including the two new probes below) · `npm run bench` unchanged.
4. `npm run bench:task -- --selftest` — G1+G2 over the wave-2 task set.
5. Finalize the wave-2 preregistration block (§3.6) — it is already written;
   step 5 is confirming no edit during 1–4 changed it.
6. `npm run bench:task -- --new-cohort --n 5`, apply the interim rule (§3.6),
   then `--n 20`.

Item 2's sweep harness lives entirely outside the watched set and runs
independently any time after step 3.

---

## 1. Unchanged observations — honest, distinct, cheap, and taught away

### The calls

1. **A zero-op observation stops consuming sequence numbers and the diff
   budget.** Today `observe()` calls `nextDiffSeq()` on the empty path
   (`src/core/snapshot/engine.ts` ~line 253), so every "nothing changed"
   response burns one of the 12 `MAX_DIFFS_PER_EPOCH` slots and hastens a full
   resync the agent then pays for. WHY: the cap exists to bound *accumulated
   model-side application error* (its own doc comment says so); applying zero
   ops accumulates zero error. A page state that did not change should not get
   a new state id either — the id names a state, and there is no new state.

2. **The two meanings of "nothing changed" get two wordings.** Today the act
   path and the snapshot path render the identical bytes
   (`page #N.M (no visible change)`), but they mean different things: after an
   act it is *diagnostic* (your click had no visible effect — real signal, the
   parent brief is right that this must not be destroyed); after a voluntary
   snapshot it is *redundant* (you already hold the page). The engine knows
   which is which (`opts.afterAction`); the wire should say which is which.

3. **The completeness guarantee moves into the tool descriptions.** The
   fidelity bench proved the diff stream is information-complete for a
   mechanical reader; nothing anywhere *tells the model that*. The missing
   sentence — "anything a diff does not mention is unchanged" — is exactly the
   license the model needs to skip the verification snapshot it is currently
   buying with a turn. This is a description fix, not an engine fix, because
   the engine is not the deficient component: the stream already carries the
   information, the model doesn't trust it.

4. **The unchanged response stays inside the untrusted envelope.** Considered
   and rejected: unwrapping it (it contains zero page-authored bytes, so
   doctrinally it could sit outside). Rejected because the doctrinal argument
   cuts both ways — "no page bytes → no envelope" vs "the observation channel
   is always enveloped" — and when a security-boundary rule is ambiguous the
   tie-break is *fewer exceptions*: a conditional envelope is a special case
   every future call-site audit must reason about, to save ~26 tokens on a
   response the rest of this item is making rare. Not worth it.

5. **A URL change with zero tree ops is news, not "no visible change".**
   Today the `navigated` check sits *below* the empty early-return, so a
   `pushState` that changes the URL without an immediate DOM delta returns
   "(no visible change)" while silently updating `st.last.url` — the agent is
   never told. Hoist the check above the early return; a navigation falls
   through to the full-snapshot branch as it already does when ops exist.

6. **Do not suppress the round trip server-side.** The turn is spent by the
   time the server sees the call; no wire format can refund it. The only
   levers that remove turns are the model-facing words (call 3) — and the
   measurement of whether they worked is wave 2 (§1.5).

### Wire format (exact strings)

Non-empty diffs are untouched. The empty case, currently
`page #${seq} (no visible change)${extra}`, becomes:

- After an action (`afterAction: true`):
  `page #E.S (unchanged — the action caused no visible change)`
- Otherwise (voluntary snapshot):
  `page #E.S (unchanged — you already hold the current page)`

where `E.S` is the **current, un-advanced** state id. Existing notes append
unchanged in form: ` (2 live-region updates suppressed; 1 changes in regions
you have not read)` — and note the second half is a bug fix by itself: the
empty path currently hardcodes `unreadChanges: 0`, so a page whose only
changes were in never-rendered regions reports "no visible change" with no
caveat. Pass the real `result.unreadChanges` through.

Both variants share the `(unchanged` prefix so one regex classifies them.

### Files and functions

| file | change |
|---|---|
| `src/core/snapshot/render.ts` | New export `renderUnchanged(seq, {afterAction?, suppressed?, unreadChanges?})` holding the strings above — one spelling, unit-testable. `renderDiff`'s `ops.length === 0` branch delegates to it (so no second spelling can drift). |
| `src/core/snapshot/engine.ts` | In `observe()`: hoist `const navigated = r.url !== st.last.url` above the empty-ops check; empty path becomes: update `st.last` root/title in place (no `nextDiffSeq`, no `diffsThisEpoch` increment, seq untouched), return `kind:'unchanged'` with `renderUnchanged(st.last.seq, {afterAction: opts.afterAction, suppressed: result.suppressed, unreadChanges: result.unreadChanges})`. This also deletes the latent `baseSeq: st.last.seq`-after-reassignment confusion. |
| `src/mcp/tools.ts` | `browser_act` description: after "That is the whole point: do not call browser_snapshot after every action." append: `A diff is complete: anything it does not mention is unchanged (suppressed live-region churn and unread regions are called out explicitly when they exist). If an action reports "unchanged", that is a finding — the action had no visible effect — not a failure to observe.` `browser_snapshot` description: append: `If every action's result has been a diff, you already hold the current page: a snapshot adds nothing and returns a one-line "unchanged" notice. Snapshot when you have lost track of the page (for instance after compaction) or genuinely need a restatement.` `FORMAT_LEGEND`: add a line `(unchanged …)  nothing visible changed; your model of the page is already current`. |
| `bench/lib/proxy.mjs` | `ACT_DESCRIPTION` (arm-neutral by contract) gains: `The report after each action is complete: anything it does not mention is unchanged. Do not call browser_snapshot to re-verify what a report already told you — it will return nothing new.` Arm-neutrality check: in the re-dump arm the report is a full snapshot, for which both sentences are also true. The proxy continues to write this description itself and to forward `browser_snapshot`'s verbatim, so the product-side snapshot wording flows to the bench automatically. |
| `bench/lib/streamModel.mjs` | `isNoChange` becomes `/^page #\d+\.\d+ \(unchanged/m`. **Must land atomically with the render change** — with the old regex, the new wording classifies as `other`, which trips G3 in the re-dump arm (impossible there, but `other` also pollutes `unclassified`) and G4's share arithmetic in the diff arm. |
| `bench/fidelity.mjs` | `stepFailure`'s probe `/\(no visible change\)/` becomes `/\(unchanged\b/`. |
| `bench/task.mjs` | Persist the observation sequence for wave-2 diagnosability: in `runEpisode`'s return add `obsSeq: ep.observations.map(o => (o.tool === 'browser_act' ? 'a' : 's') + ':' + o.kind)`, and in `doSnapshot` tag the recorded observation with `{mode, expand}` as forwarded. WHY: wave 1 cannot answer *where in the episode* voluntary snapshots happen (end-of-task verification vs mid-task confusion) because only kind totals were stored; this closes that hole for a few bytes per episode. |
| `test/snapshot.test.ts` | Update the `renderDiff` empty-case test to expect `unchanged`; token bound < 20 (the new snapshot-variant line is 57 chars ≈ 15 tokens). Add cases for both wordings and for the unread-changes note surviving the empty path. |
| `test/benchStream.test.ts` | `isNoChange` positive cases use the new strings; add a negative case asserting the retired `(no visible change)` spelling no longer classifies (nothing emits it). |
| `bench/guards.mjs` | Two new live probes. **G12a:** drive an act, then `browser_snapshot mode:auto` twice; the second response must match `/\(unchanged — you already hold/` and carry the *same* `#E.S` as the first — proving seq no longer advances. **G12b:** issue 13 auto-snapshots after one act, then a real act; its observation must be a `page #… (diff from …)`, not a forced `FULL SNAPSHOT` — proving unchanged observations no longer consume the 12-diff budget. |

`src/mcp/envelope.ts`, the proxy's arm forcing, and `SYSTEM_PROMPT` in
`bench/task.mjs` are deliberately untouched. The system prompt could also
preach "don't re-verify", but the bench should measure whether the *product's*
teaching works, not paper over it with bench-side prompting.

### Behavior change owned out loud

Previously an agent looping on `mode:auto` snapshots would eventually trip the
12-diff cap and receive a healing full snapshot. Now it receives `unchanged`
forever. Accepted: the heal exists for accumulated application error, and an
agent that is genuinely lost is told (in the snapshot description and the
legend) to ask for `mode:"full"` — which still works, unconditionally.

### What this deliberately does not fix

`finder-cheapest`'s voluntary snapshots are partly *structural*: diff subtrees
render with collapse on (`renderOp` → `expand: false`), so a filtered list
arriving via a `replace` can hide candidate prices behind `… N more`, and a
correct agent MUST then expand-snapshot. That is a real, honest cost of the
collapse design, already priced into the diff arm by intention-to-treat
scoring. Expanding diff subtrees would surrender the token saving that is the
product's reason to exist. No change; the size sweep and the wave-2 report
must simply remember `finder`-class voluntary fulls are not "defensive."

### Acceptance

1. `npx tsc --noEmit`, `npx vitest run` (updated tests), `npx electron-vite build` — clean.
2. All five `bench:fidelity` scenarios GREEN (the `widgets` suppression note
   and both resync fallbacks re-exercised under the new wording).
3. `bench/guards.mjs`: previous 11 plus G12a/G12b — all green.
4. `npm run bench:task -- --selftest`: G1+G2 PASS; G2 notes show `0N` in both
   arms (the scripted solver never voluntarily snapshots, so any nochange here
   is a regression).
5. `grep -rnF --include=*.ts --include=*.mjs --include=*.js --include=*.cjs
   "(no visible change)" src bench` exits 1 (no matches).

   **This criterion was originally mis-specified and is corrected here.** It
   read `grep -r "no visible change" src bench/lib test` returns nothing, which
   is unsatisfiable two ways at once: the mandated act wording *contains* the
   bare phrase (`… caused no visible change)`), and the negative test this same
   section requires in `test/benchStream.test.ts` must hold the retired literal
   while the grep over `test` demands its absence. The spec asked for a string
   to exist and be proven absent simultaneously. The implementation was correct
   throughout; the check was aimed at the wrong surface.

   The pattern is the **parenthesised retired form**. The current act wording
   cannot match it — the character before `no` is a space, not an open paren.
   `test/` is out of scope on purpose, so the negative case can hold the retired
   literal plainly: a stale *positive* assertion there fails vitest at runtime
   anyway, because nothing emits the string. Scope is `src bench` rather than an
   enumerated file list so future bench files are covered by default.

   This grep is only a tripwire against resurrecting the old spelling — a
   revert, a cherry-pick, a paste from an old branch. It cannot catch retired
   *semantics* under a novel spelling (`page #N.M (nothing changed)`); that is
   guarded structurally instead, by the `isNoChange` contract tests and by live
   probe G12a, which pin the actual wire bytes.
6. Wave-2 advisory metric (not a verdict input): diff-arm voluntary
   observations/episode (`steps − pageActions − 1`), wave-1 baseline 0.80, and
   nochange/episode, wave-1 baseline 0.36 — reported per task with `obsSeq`
   available for diagnosis. The description fix is falsifiable: if these do
   not move, the trust hypothesis is wrong and the next lever is the system
   prompt, recorded as such.

### Contamination flags

- Engine wording + `streamModel.mjs` regex are one atomic change set; landing
  either alone makes the bench misclassify observations.
- The two description edits are shown byte-identically to both arms, but
  byte-identity is not the operative argument, and for `browser_snapshot` it is
  wrong: that sentence's antecedent ("if every action's result has been a
  diff") is vacuously false in the re-dump arm, where acts return full
  snapshots, so its teaching can only move diff-arm behavior. Accepted, not
  fixed, on **estimand** grounds: the teaching is part of the shipped diff
  product, and wave 2 compares diff-as-shipped against re-dump-as-shipped. An
  intervention that is a component of the treatment cannot contaminate the
  treatment comparison — contamination is asymmetry in *handling* (harness,
  prompts, scoring), and the handling is symmetric. Wave 1 bounds the risk of a
  withheld benefit: the re-dump arm made 6 voluntary snapshots in the entire
  wave, all in the now-retired `finder-cheapest`, plausibly all structural
  expands — though intent was not recorded, which is why wave 2 stores
  `{mode, expand}` per snapshot. The residual hazard runs the *other* way — a
  re-dump agent over-reading the false-antecedent sentence and skipping a
  **necessary** snapshot, which would bias success toward diffs — and it is
  monitored rather than assumed away: re-dump voluntary observations/episode is
  reported per task, baseline 0 on all three retained tasks, and any movement
  is investigated before the arm comparison is cited.
- Every touched file except tests/guards/fidelity is inside `codeVersion` →
  wave-1 cohort closes; that is forced anyway and is why sequencing bundles
  items 1 and 3.

---

## 2. The byte-size crossover — a sibling harness, not a bolt-on

### Reframing, because the framing in the brief is half-inverted

"Diffs must pay above some page size and cost above none" has the mechanism
backwards: per-episode, with equal turns, diffs are cheaper at *every* size
and cheapest **relatively** at large sizes (the full-dump denominator grows;
the diff numerator doesn't). What made them cost more at 1.4–8.0 KB was extra
*turns*, and turns are behavior. So the crossover being located is:

> the page size at which the diff arm's per-observation saving outgrows the
> cost of the extra turns diff-mode behavior induces, **measured with a real
> agent, end to end, in dollars.**

Two honest possible outcomes, both publishable: a crossover size band, or "no
crossover in the measured range — diffs cheaper everywhere ≥ s1" (plausible
once item 1 lands and the nochange turns disappear). The design must be able
to establish either.

**Own script: yes.** `bench/size.mjs`, not `bench/task.mjs`. WHY: task.mjs is
the preregistered correctness experiment with an integrity-guarded cohort and
a verdict rule; the sweep is a cost study with a different design (size ladder,
no PARITY/REGRESSION semantics, correctness demoted to a validity guard).
Bolting it on would churn the cohort on every fixture tweak and invite reading
cost curves as preregistered claims.

### Separating page size from task difficulty

The confound: padding changes the a11y tree and the task at once. The
separation is **inert, unaddressable padding below an untouched task region**:

- One task: `cart-adjust` (fixed 3-act solve, the invariant-style prompt that
  provoked the wave-1 behavior). Prompt, predicate, `allowed`, `data-bench`
  ids, and the task-relevant markup byte-identical across all tiers.
- Padding is appended after the task markup as `<div>` sections containing
  only `<h3>` headings and `<p>` prose. Verified against the code, this adds
  **zero refs and zero interactive surface**: `heading` and text are not in
  `ADDRESSABLE` (`src/core/snapshot/walker.ts` line 85), so the agent's
  decision space — the set of refs it can act on — is unchanged; only
  observation weight changes. Padding must contain **no** `<a>`, `<ul>`,
  `<table>`, `<form>`, `<section aria-label>`, `<nav>` (all addressable
  roles), and no strings matching task labels.
- Run-collapse cannot eat the padding: `sameShapeRunLength` bails on falsy
  shape, and leaves have shape `''`, so heading/paragraph runs never collapse.
  Verified in `src/core/snapshot/render.ts` (line ~268) — but asserted anyway
  (below) rather than trusted, per house rule.
- Padding is static: no script touches it, so it appears in **zero diffs** —
  the diff arm's observation bytes stay ~constant across tiers while the
  re-dump arm's scale. That asymmetry is not a bug; it is the variable.

Fixtures are **generated**, not hand-edited: `bench/size/make-fixtures.mjs`
clones `bench/fixtures/cart.html` into `bench/size/fixtures/cart-s{1..5}.html`
(s1 = byte-identical clone) with seeded, varied prose. Generated outputs are
checked in (runs must not depend on regeneration); the generator is the audit
trail.

**Location is load-bearing:** `bench/size/fixtures/`, NOT `bench/fixtures/` —
the latter is inside the task suite's `codeVersion` hash (`WATCH_DIRS` in
`bench/lib/store.mjs`), and adding a size fixture there would invalidate task
cohorts forever after. `bench/size/**` is unwatched by construction.

### Size tiers, operationally defined

Size = **chars of the untruncated full snapshot** (measured by the harness:
`browser_snapshot mode:full budgetTokens:20000`), not file bytes — file bytes
are not what the agent pays for. Targets:

| tier | target snapshot chars | ≈ tokens | anchors |
|---|---|---|---|
| s1 | ~1.2k (unpadded baseline, measured) | ~300 | wave-1 fixture class |
| s2 | 4k | 1k | — |
| s3 | 10k | 2.5k | — |
| s4 | 21k | ~5.3k | GitHub repo page (measured 5,269 tok) |
| s5 | 38k | ~9.5k | Hacker News front page (measured 9,519 tok) |

Geometric ladder ending at the largest real page already measured, so the
curve's right edge is anchored to reality rather than to an arbitrary blob.

### The enabler this needs from the product (the only product change in item 2)

`browser_act` has no `budgetTokens` parameter, so the re-dump arm's
act-embedded full snapshots render under `DEFAULT_BUDGET = 2000` tokens and
would be **truncated from s3 up** — which G11's own reasoning calls unfair
("truncation does not fall equally on the arms"). Add `budgetTokens` to
`browser_act`'s input schema in `src/mcp/tools.ts` (same zod shape as
`browser_snapshot`: `int, min 200, max 20000, optional`), threaded into every
`observe(...)` call in the act handler — `ObserveOptions` already accepts it;
`renderFull` already spends it; diffs ignore it (no budget cut exists there).
Default behavior unchanged.

The sweep harness injects `budgetTokens: 20000` into **every** act and
snapshot call in **both** arms, at the proxy: add an `inject` object to
`newEpisode(...)` in `bench/lib/proxy.mjs`, spread into `forwarded` in `doAct`
and `doSnapshot`. Default `{}` — provably a no-op for the task suite. The
agent never sees the parameter (the proxy's schemas are unchanged), so it
cannot behave differently around it.

Stated exclusion: the *truncation regime* (agent on a page bigger than its
budget) remains unmeasured, deliberately — its correctness effects would
dominate its cost effects and it is a different experiment. Wave-1's claim
table already lists it as not measured; this keeps it that way honestly.

### Harness design (`bench/size.mjs`)

Owns its world exactly like task.mjs (own fixture server on 8899 serving
`bench/size/fixtures`, collector on 8898, proxy on 8896, one fresh Aperture,
refuses occupied ports). Results append to `bench/size/results.jsonl`, stamped
with `codeVersion` for provenance but with **no** integrity guard — the sweep
is not a poolable cohort, and each run's report states the stamp it ran under.

**Preflight (free), run for every tier — abort on any failure:**

1. Full snapshot has ≥ target chars × 0.9 and ≤ × 1.1, no
   `more lines beyond budget`, no collapse marker inside the padding region.
2. Ref parity: the set of `eN → (role, label)` pairs parsed from the s1 full
   snapshot equals every other tier's exactly. (Padding contributed no refs,
   numbering did not shift.)
3. G1: predicate false on the untouched page.
4. G2: scripted `cart-adjust` solve passes in both arms; `mustObserve`
   `/Quantity: 4/` matches the diff stream.
5. Diff-stream invariance: the scripted diff-arm observation stream at tier
   s_k is byte-identical to s1's modulo `#E.S` numbers — proving the padding
   never leaks into a diff. This is the sharpest single check in the design:
   if it holds, the ONLY thing varying across tiers is full-snapshot weight.

**Tier A — mechanism (scripted, deterministic, no API budget):** one scripted
episode per tier per arm; record every request/response size; report
observation chars/episode and equal-turn conversation-input chars
(Σ over turns of prefix + history) per arm per tier. Output: the pure
mechanism curve and ratio. No dollars are claimed from this tier.

**Tier B — behavior (real agent, the tier that answers the question):**
`claude-sonnet-5`, the same `agentDriver` loop as task.mjs, N=6 per arm per
tier (60 episodes), intention-to-treat. Record SDK `total_cost_usd`, turns,
kinds, obsChars, success. Budget rule, decided now: run s1 at N=2/arm first,
project total spend as cost·(Σ tier sizes / s1 size) — if projected > $60,
drop s5 to N=4 and s4 to N=5 before shrinking anything else; never drop
tiers. (Wave-1 measured $0.11/ep at s1-class sizes and sd ≈ $0.026; s5
re-dump episodes plausibly reach $0.5–1.)

**Cost model, fitted not assumed:** the SDK's caching makes "each turn
re-sends everything" priced at a blend nobody can compute a priori. So: fit
`cost_ep ≈ a·Σ_t(P + H_t) + b` over Tier B episodes by least squares (P =
prefix constant, fitted; H_t = measured history chars at turn t). Cite the
model only if R² ≥ 0.9 across the sweep; otherwise report raw dollars only
and say the model failed. Either way Tier A's equal-turn curve stands on its
own as the mechanism bound.

### Operational definition of "the crossover"

For each tier: Δ$(s) = mean diff-arm $/ep − mean re-dump $/ep, with a seeded
bootstrap 90% CI. **The crossover is reported as a band:** the interval from
the largest tier whose CI is entirely above zero to the smallest tier whose CI
is entirely below zero. Degenerate cases are results, not failures:

- All CIs below zero → "diffs cheaper at every measured size ≥ s1" (expected
  post-item-1; this retires wave-1's inversion as a fixed product bug).
- All CIs above zero → diffs never pay on this suite even at HN size — a
  product-threatening finding that goes in RESULTS.md in exactly those words.
- A CI straddling zero at some tier → that tier is inside the band; more
  episodes narrow it only if someone cares to pay for precision.

Validity guard: if per-tier success rates differ between arms by >10pp, the
cost comparison at that tier is flagged CONFOUNDED and excluded from the band
(a failing arm's episodes are not the same work). Success is otherwise not a
deliverable of this harness.

Secondary deliverable: voluntary observations/episode per arm per tier — does
defensive snapshotting return at scale, after item 1's fix? This is the
behavioral input the next design round would need.

### Sequencing

Runs after the item-1/3 change set is landed and verified (step 3 of §0), so
it measures the fixed product. Results go to `bench/size/results.jsonl` plus a
dated section appended to `bench/RESULTS.md`, per house practice.

### Acceptance

1. Preflight 1–5 green for all five tiers.
2. Tier A table produced; diff-arm observation chars flat (±10%) across
   tiers while re-dump's scale ≥ 0.9× linearly with snapshot size.
3. Tier B completes within the budget rule; the report prints the cost curve,
   the band (or its degenerate statement), the R² line, and the confounding
   flags if any.
4. The task suite's `--plan` before and after adding `bench/size/**` shows an
   unchanged `codeVersion` — proof the sweep cannot touch the cohort. (The
   `browser_act budgetTokens` product edit does move it — that is why it lands
   inside the §0 bundle, not later.)

---

## 3. Breaking the ceiling — harder tasks first, weaker model as contingency

### The call, and why in this order

**Primary: harder tasks, same model (`claude-sonnet-5`).** WHY: the headline
claim is about the model class people deploy; a Haiku-only regression would
leave the Sonnet question open and a Haiku-only parity would prove little
about it either. Weak models also fail for reasons unrelated to bookkeeping
(instruction-following collapse, G4 degeneration), which pollutes exactly the
attribution this suite exists to make.

**Preregistered contingency: Haiku sensitivity cohort.** Trigger, stated
numerically now: if the wave-2 `--n 5` pilot shows pooled success ≥ 98% in
both arms, run the same 7 tasks with `--model claude-haiku-4-5` (verify the id
resolves in the SDK at run time; G9 catches a wrong serve) into a **separate
store** (`--store bench/task/results/episodes-haiku.jsonl` — required anyway,
since `model` is in the identity and one store refuses two models). Its result
licenses only a sensitivity sentence, never the headline claim.

### What "hard for diff bookkeeping" means, precisely

The variable under test is whether the model maintains an accurate page model
across many delta applications. Difficulty must load on that, not on general
reasoning. The loads, each traceable to a measured engine behavior:

| load | engine behavior it exercises | wave-1 coverage |
|---|---|---|
| L1 positional identity | ordinal keys (`\|#n`, walker `disambiguate`) reassigned when earlier siblings are removed — stale refs land on real, wrong elements | **none** (RESULTS: "No fixture forces purely positional identity") |
| L2 forced mid-task resync | `MAX_DIFFS_PER_EPOCH` full restatement — model must discard everything yet retain task facts learned pre-resync | none (max 7 acts/task) |
| L3 die → revive → die | replace ops with `gone:` lists, registry revival | partial (wizard panels die once) |
| L4 cross-diff accumulation | facts that exist only in past diffs, never restated — re-dumps restate them, diffs do not; this is the arms' honest difference | partial (leaderboard, 3 pages) |

A hard task is one where a bookkeeping slip produces a **wrong action the
witness can see**, not merely a slower path — wave 1's lesson is that 372
correct actions teach nothing.

### Wave-2 task set: 7 tasks

**Retained from wave 1, byte-identical (fixtures and prompts untouched), for
cross-cohort comparability:** `inbox-archive` (removal bookkeeping),
`wizard-submit` (panel replacement), `leaderboard-max` (L4-lite). **Retired to
a `RETIRED` export in `bench/tasks.mjs`:** the other seven — every one sat at
100/100 in both arms; keeping them would dilute the pooled delta (a real 15pp
drop on the hard third of a 14-task suite pools to ~4pp — inside the −5pp
margin, a false PARITY by construction). The retired definitions stay in the
file as documentation; they are simply not in `TASKS`.

Sizes stay in the wave-1 class (~1–2 KB) so difficulty and page size remain
orthogonal axes (size is item 2's variable).

**New task 1 — `queue-positional` (L1), fixture `queue.html`.** A moderation
queue of 7 visually identical rows: identical row text ("Queued submission"),
identical button labels ("Approve" / "Reject"), **no** links or headings
inside rows. Verified against the walker: `siblingDiscriminator` consults only
`A`/`H1`–`H4` siblings, `identityKey` falls through Tier-1 (no
testid/name/non-generated id — use generated-looking or no ids) to the S-tier
with identical name/anchor/path → `disambiguate` ordinals → positional keys.
Acting removes the row, so every lower row's ordinal — and therefore key, and
therefore ref — shifts: the stale-ref trap, live. Prompt: *"Reject the
submissions currently 2nd and 5th from the top, then approve every remaining
submission."* Witness ids `approve:q1..q7`/`reject:q1..q7`; allowed =
`{reject:q2, reject:q5, approve:q1,q3,q4,q6,q7}`; predicate: rejected set ==
{q2,q5} ∧ approved set == the other five ∧ queue empty. Fixture keeps a status
line "N pending" updated per action; `mustObserve: /5 pending/`. Solver (needs
`nth`, below): `Reject nth:5`, `Reject nth:2`, then `Approve nth:1` × 5 —
descending-then-top order so each scripted step's target is unambiguous under
removals-only mutation. maxSteps 16.
*Known unknown, checked at build time:* the fixture must be probed live to
confirm ordinal keys actually engage (archive row 1 → the diff must touch ≥ 2
refs, since lower rows re-keyed). Enforced mechanically via `streamAssert`
(below), not by hoping.

**New task 2 — `vault-code` (L2 + L3), fixture `vault.html`.** Four panels,
each `replaceChildren()`-swapped (all refs die per transition). Panel 1:
"Reveal code" → shows `VC-83QK` (revealed only after the click, so the code
travels in a **diff**, not in the initial full both arms get for free); then
"Begin". Panels 2 and 3: five required toggles each (unique labels, e.g.
"Enable alpha safeguard") + "Continue". Panel 4: "Security code" textbox +
"Unlock". 16 page actions (reveal, begin, 5 toggles, continue, 5 toggles,
continue, type, unlock) ⇒ ≥ 13 diff observations in the diff arm ⇒ the
12-diff cap **forces a mid-task FULL SNAPSHOT** (post-item-1 accounting: only
real diffs count, so 16 acts still trip it) — and the code is on no panel
after the first, so it must survive the model's own state reset. Predicate:
`unlocked === true ∧ code === 'VC-83QK' ∧ all ten toggles on`.
`mustObserve: /VC-83QK/`. maxSteps 22.

**New task 3 — `catalog-revive` (L3), fixture `catalog.html`.** Search box +
12 uniquely named/priced products; every keystroke rebuilds the list from
scratch (rerender-fixture style). Prompt: find and shortlist the cheapest
'steel' item, then clear to 'oak' and shortlist the cheapest 'oak' item. Refs
die on filter 1, revive on the implicit clear inside `type` (click +
clearField + typeText), die again on filter 2 — the agent must act only on
current-era refs. Filtered result sets are kept ≤ 4 items so no run collapse
occurs post-filter and the deciding prices arrive complete inside the
`replace` diff (avoids importing `finder`'s structural-expand confound into a
bookkeeping task). allowed = `{search, add:<steel-cheapest>, add:<oak-cheapest>}`;
predicate: shortlist exactly those two, in order; `mustObserve` = the cheapest
steel price literal (e.g. `/\$4\.25/`). Solve: `type(search,'steel')`,
`click(add steel-cheapest)`, `type(search,'oak')`, `click(add oak-cheapest)`.
maxSteps 12.

**New task 4 — `ledger-balance` (L4, the arms' honest difference, maximally
loaded), fixture `ledger.html`.** "Apply next adjustment" applies a
predetermined delta sequence `+4, −2, +5, +1, +2, −3, +3`; the running balance
is **never displayed**; each application updates a "last 4 adjustments" log
(≤ 4 rows visible — below `COLLAPSE_RUN`, so full snapshots restate the recent
history uncollapsed while a diff shows only the newest entry). Prompt: apply
adjustments until the balance is exactly +10, then "Close ledger" (prefix sums
4, 2, 7, 8, **10** → stop after the 5th). The re-dump arm re-reads recent
history every turn for free; the diff arm must accumulate across turns —
precisely the bookkeeping the experiment claims is safe. Predicate:
`closed === true ∧ balance === 10`. allowed = `{apply, close}`;
`mustObserve: /applied \+2/` (the 5th delta, which exists only in the 5th
click's diff). Solve: `click(Apply) × 5, click(Close)`. maxSteps 14.

All four fixtures follow the existing witness pattern (`bench.js`, `data-bench`
ids, never `data-testid` — Tier-1 identity input, same rule as wave 1) and
must individually pass G1 (predicate false untouched, snapshot untruncated).

### Harness changes (`bench/task.mjs`, same change set)

1. **`nth` solver targeting.** `resolveLabel(model, step)` gains optional
   `step.nth` (1-based): filter hits by label+role as today, then pick
   `hits[nth-1]` in **model insertion order**, which equals document order
   *only under removals-only mutation* — `applyObservation` appends adds at
   the end regardless of position. This constraint is documented at the
   function and `queue.html` is designed removals-only to honor it. If the
   stream ever lies about ordering, the solver clicks a wrong element and the
   witness fails G2 loudly — the guard covers its own helper.
2. **Per-task `streamAssert(diffStream)`**, optional, checked in G2 beside
   `mustObserve` (same failure format, stream printed). Used by
   `queue-positional`: after the first removal the stream must name ≥ 2
   distinct refs across remove/update/replace/gone ops — the mechanical proof
   that positional re-keying is actually happening, without which the fixture
   is silently not testing L1.
3. `obsSeq` persistence (already specified in item 1).

### Wave-2 preregistration (written now, before any scored episode)

- Tasks: `inbox-archive`, `wizard-submit`, `leaderboard-max`,
  `queue-positional`, `vault-code`, `catalog-revive`, `ledger-balance`.
  N = 20/task/arm (140/arm; 280 episodes total), model `claude-sonnet-5`, arms and forcing rule
  unchanged, guards G1–G11 unchanged, G10 unchanged.
- Verdict margins unchanged: PARITY iff success-delta CI lower ≥ −5pp AND
  wrong-element CI upper ≤ +0.2/run.
- **Preregistered secondary outcome** (new, and honest about power): if the
  verdict is INCONCLUSIVE but the success-delta CI lower bound ≥ −10pp and the
  wrong-element bound holds, the licensed sentence is: *"On this 7-task
  bookkeeping-hard suite with claude-sonnet-5, no diff-bookkeeping penalty
  larger than 10pp was found."* WHY this exists: at 140/arm and ~85% success the CI half-width is ~8.4pp,
  so PARITY requires observing the diff arm ahead by >= +3.4pp — probability
  ~0.2 under true parity. The primary is retained but is underpowered by
  construction; the secondary bound exists so a true null has a reachable,
  honestly-worded licensed statement. NOTE: an earlier draft of this block said
  the -5pp margin was "arithmetically unreachable". That was an overclaim, and
  the distinction matters: *impossible* would license replacing the primary,
  whereas *underpowered* licenses only adding a secondary beside it. The
  original primary is unchanged and is reported first.

### Acceptance

1. Verification battery of §0 green, including `--selftest` over the 7 tasks:
   G1 all-false, G2 solved in both arms, every `mustObserve` matched, the
   `queue-positional` `streamAssert` matched, action counts exact (G5).
2. `vault-code` scripted diff-arm episode shows a mid-run `FULL SNAPSHOT`
   (the forced resync fired) *and* still solves — G2 output is the evidence.
3. The pilot wave runs under `--new-cohort`; the interim rule's branch taken
   is recorded in RESULTS.md with the pooled rates that triggered it.
4. Wave-2 report: per-task success split, attribution table (the
   `model_bookkeeping` / `identity_mismatch` / `engine_ref_loss` split is
   finally load-bearing — `queue-positional` is the first fixture where
   `identity_mismatch` can actually occur), and the preregistered primary or
   secondary sentence, nothing more.

### Contamination flags

- `bench/tasks.mjs`, `bench/task.mjs`, new fixtures under `bench/fixtures/`
  are all watched → this is the same forced `--new-cohort` as item 1; one
  bundle, one archive event.
- Retained tasks must be byte-identical (their `promptHash` is per-task in
  the identity; any drift is named by the integrity guard — that is the
  mechanism that keeps "retained for comparability" honest).
- The Haiku contingency uses its own store; no flag exists to pool across
  models, and none is added.

---

## Things verified vs. things not verifiable from here

Verified against code or the episode store (citations above): the nochange
provenance arithmetic; act-embedded observations always present and all
`ok`-attributed; the redump arm's 6 voluntary snapshots all in `finder`; the
zero-op path consuming seq + diff budget and discarding `unreadChanges`; the
`navigated`-check ordering; `heading`/text unaddressability; leaf shape `''`
defeating run collapse; `siblingDiscriminator`'s A/H1–H4-only rule and the
ordinal fallback; `browser_act`'s missing `budgetTokens`; the watched-file
sets; the proxy's forwarding/forcing rules.

Could NOT verify, stated so the implementer treats them as checks, not facts:

1. **Why** the agent snapshotted voluntarily — no reasoning transcripts are
   stored; the invariant-prompt correlation is strong but intent is inferred.
   `obsSeq` closes this for wave 2.
2. That `<p>` prose renders at the expected token weight with zero refs on
   this walker — covered by the size preflight's ladder/ref-parity asserts.
3. That `queue.html` actually produces ordinal keys until probed live —
   covered by `streamAssert` in G2.
4. The exact current Haiku model id — checked at contingency time; G9 backstops.
5. Whether SDK prompt caching applies to these runs — the size sweep fits its
   cost model empirically and refuses to cite it below R² 0.9.
