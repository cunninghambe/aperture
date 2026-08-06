# Handoff

State as of `e3f8add`. If you are picking this up cold, read this file, then
[`bench/RESULTS.md`](../bench/RESULTS.md), then the adjudications in
`docs/design/`. **The adjudications outrank the raw reports** — most of the
scored stores are scored *out of band*, because the suite's own guards
correctly refuse to print a verdict on them.

Reading order, decisive first:

1. `h2h-post-tier5-evaluation.md` — the closing cohort. §7 is the
   RESULTS.md-ready text, §8 the README-ready paragraph, §0 four framing
   corrections that bind anyone citing it.
2. `tier5-ruling.md` — the tripwire adjudication and §7's preregistration, the
   terms the cohort above was judged against.
3. `sink-closure-review-4.md` and `security.md` — the seven-class table, the
   stopping criterion, and what must not be undone.
4. `webbotauth.md` §12–§13 — what was built, what was verified live, what is
   still owed.
5. `h2h-evaluation.md`, `wave3-evaluation.md`, `sweep-evaluation.md` — the
   archived cohorts, kept as history.

---

## Where this stands

The browser runs, the MCP server works, `browser_act` closes the act-observe
loop (click, type, clear, hover, scroll, key, select), Claude Code can drive it
end to end, the vault fill path is wired behind a native consent dialog, and
Web Bot Auth request signing is built and live-verified. The full test suite
passes; `npm run typecheck` is clean.

```
bench:fidelity form         GREEN   18/18 refs · 13 diffs + 1 forced resync · 0 wrong [N options] markers
bench:fidelity rerender     GREEN   17/17 refs · 0 phantoms through full DOM teardowns
bench:fidelity widgets      GREEN   6/6 refs · clicks, +checked/+expanded, shadow DOM, clock suppressed
bench:fidelity biglist      GREEN   71/71 refs · 70 refs die and revive · size-cap resync fired
bench:fidelity selects      GREEN   7/7 refs · 4 native selects + a custom ARIA combobox
bench:fidelity blindfields  GREEN   table cells, an href rewrite and a label morph, asserted from the stream alone
bench:guards --phase=allow  GREEN   72/72 at artifact 4115dd9f… (webbotauth.md §13)
npm run bench               ok      6.6x–10.2x synthetic observation-token model
```

The diff design has been measured end to end against a real competitor, twice,
on a byte-identical apparatus with one engine treatment between the cohorts.
**It won the cost primary both times, lost the precision primary in the first,
and passed it in the second.** The precision fix (`tier5`) was specified,
preregistered and independently adjudicated before its numbers existed; the
adjudication is `h2h-post-tier5-evaluation.md` and it closes the head-to-head
programme as specified.

---

## The measurement programme

| campaign | scope | verdict |
|---|---|---|
| Wave 1 — 100 ep, Sonnet 5 | 10 tasks, 1.4–8.0 KB fixtures | **INCONCLUSIVE (ceiling)**, both arms 100%. Produced a cost "finding" that later failed as a finding — see below |
| Wave 2 — 251 ep, $37.34 | 7 bookkeeping-hard tasks | **PARITY**, but exclusion-conditional and fragile; the −5pp/"parity" vocabulary is now retired as unreachable at any affordable n |
| Wave 3 — 230 ep, $76.91 | 3 positional-identity tasks + 2 canaries, post-P1 engine | **PASS**: no diff-bookkeeping penalty larger than 10pp in success or +0.4 wrong-element/run, n=105/arm. MDE ~23.5pp. Diff arm +4.4% dearer in dollars |
| Size sweep Tier B — 54 ep, $9.88 | `cart-adjust`, 5 page-weight tiers, 1,116–38,081 chars | **One-sided no-crossover**: never significantly dearer, significantly cheaper from s3 (~10k chars) up, 19/39/43% at s3/s4/s5 |
| Head-to-head, pre-tier5 — 385 ep, $104.53 | vs `@playwright/mcp@0.0.78`, 4 arms, 11 prompts | Cost **licensed** (0.313× on realistic-weight pages, 1.295× DEARER on home); reliability bound **holds but is carried by one task**; precision bound **FAILS** (+0.173 [0.018, 0.345]) |
| Head-to-head, post-tier5 — 385 ep, $97.17 | same harness byte-for-byte, build `0916e30f…`, only the engine changed | Precision bound **HOLDS and the sign reversed** (−0.109 [−0.200, −0.036]; zero landed wrong-element actions in 220 episodes); reliability **HOLDS, and now without the ruled cell** (+10.0pp [−0.3, +20.2]; minus catalog-order +1.0pp [−9.2, +11.2]); economics **0.390× [0.338, 0.455]** neutral-large, **0.823× [0.693, 0.975]** home, **0.977×** neutral-small |

**Rules that bind every citation of these numbers:**

- **Wave 2, wave 3 and both head-to-heads are scored out of band.** Wave 2's
  `report()` exits 3 (wedged episodes trip G3), wave 3's exits 3 (a 26-byte
  engine validation error classified `other`), both h2h stores exit 7
  (SHIM-SUSPECT on `catalog-order`). Every refusal was investigated and ruled;
  the rulings are in the adjudications and the verdicts were recomputed there
  with the suite's own stats code. A store that exits non-zero is not a faulted
  store — read the ruling.
- **Never pool cohorts.** Different engine stamps, different task sets.
  Cross-wave comparisons are directional narrative only, never CI'd. This binds
  the two head-to-head cohorts too: the archived pre-tier5 store
  (`episodes.20260805T231456Z.jsonl`) is read for comparison and never
  re-scored, never pooled.
- **The model alias is undated**, so cross-cohort movements in *agent
  behaviour* — "the incumbent got slightly worse", "its refused-stale count
  fell 75 → 24" — are observations and never claims. Every primary is a
  within-cohort contrast for this reason.
- **The measured build is tier5 plus four security commits**, not "the
  post-tier5 build". The attribution survives on three measured grounds
  (h2h-post-tier5 §0.1) — tier5's own mechanism files are byte-unchanged since
  its landing, the result carries tier5's designed signature, and the cost
  movement is localized to the cells that mechanism lives in — but the hash on
  every claim is `0916e30f…`.
- **Both h2h cohorts run a shared-tab-per-run protocol.** Aperture's engine
  carries warm ref state across a run's episodes; the pw arms have none. The
  preregistration pinned this as a mandatory disclosure and the frozen report
  cannot print it, so it travels with every economics number by hand.
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
  catching its own coordinators in, most recently in H10, which printed
  MECHANISM CONFIRMED off one cell in the pool and NOT CONFIRMED off the same
  cell one cohort earlier.

---

## What was closed, and what the closure costs

### Removal-side ordinal rebinding — CLOSED, and the currency it was traded for

**What it was.** A positional family (identical rows, no ids, no distinguishing
accessible names) re-keyed **downward** when a member was removed. The
restatement block retired only the *tail* refs and silently re-bound the rest
to *positions*, so a plan captured against snapshot N executed one row off
after any removal above it, silently, labels agreeing. The click **landed**.
It cost the precision primary: +0.173/run [0.018, 0.345] against a
preregistered +0.2 bound, 27 landed wrong-row clicks in 50 home episodes.

**The fix.** `tier5`: a positional family's refs retire on *any* membership
change, so the ref is dead rather than rebound and the act is refused. This is
deliberately moving to Playwright's side of the silent-vs-loud tradeoff on this
markup class.

**The evidence it worked**, from the fresh cohort measured against §7 of
`tier5-ruling.md` as written before any of it existed:

| preregistered | measured |
|---|---|
| pooled wrong-element CI upper ≤ +0.2 | **−0.109 [−0.200, −0.036]** — holds, sign reversed |
| diff-arm home `wrong_choice` (was 27) at least halves | **0** |
| aperture refused-stale acts rise from 8 toward ~75 | **90** |
| redump improves in step | **0 wrong-element too** — an engine-level fix and only an engine-level fix moves both arms |

Zero landed wrong-element actions across all 220 Aperture episodes. Under the
old home rate the probability of that by luck is e^(−27), and the re-dump arm
replicates it independently.

**What the closure costs, and it must be said in the same breath:**

- **The hazard is still reached, constantly.** Agents acted on stale refs 90
  times in 50 home episodes — 5.7/ep on the fixture built for it. The staleness
  *attempt* rate rose (35 → 90) because a refusal invites a retry and each
  retry is another refusal. What changed is that no attempt lands.
- **Refusals buy round-trips.** The turn term now runs against Aperture (−0.7
  to −1.2 turns/ep in the mechanism decomposition), and observation chars rose
  3% on home — the gone-list tax, at the low end of what was predicted.
- **Warm revisits pay an expand.** A positional family reappearing after
  absence with exactly its old membership is now retired rather than revived,
  so the consumer re-pays a collapse expand it used to skip. Measured at
  +$0.066/ep on one fixture, in 10 of 10 episodes — the entire worsening of the
  realistic-page economics from 0.313× to 0.390×. `tier5.1` ("same-set
  reappearance revives") is prototyped and recorded in `tier5-ruling.md` §6,
  and is **NOT owed**: its preregistered trigger did not fire, and landing it
  would spend a RED-first cycle plus a fresh cohort to improve a claim that is
  not at risk.
- **Zero-landed-wrong is a measurement, not a guarantee.** It holds on fixtures
  purpose-built to stress re-rendering identical-row lists, with one model.
  Wrong-*current*-ref choices remain possible in principle in our dialect; this
  store measured none in 220 episodes while agents on Playwright's dialect
  landed 20.
- **The negative sign is partly the incumbent's.** pw-sealed's own wrong clicks
  rose 8 → 12 across cohorts under the undated alias. The durable claim is
  Aperture's zero, not Playwright's 0.24.

---

## Open defects, with their evidence

### 1. `identity_mismatch` — CLOSED (documented domain, claim retired, tier6 §5)

A **label-divergence tripwire, not a rebind detector**: it compares
page-reported label to shadow-model label (`labelsAgree`), so it is unreachable
by construction on identical-label rows — which is every fixture built to
stress positional rebinding. The rebind hazard's detectors of record are
`wrong_choice` (page ground truth from the task's `allowed` set, h2h.mjs:352)
and the refused-stale counts; the zero is never citable, in either direction.
The bucket stays: it still catches the cross-family class (bench/tasks.mjs
~331), and deleting it would sever stores and break the
`benchAttribution.test.ts` pins for no measurement gain. There is no honest
repair — one would need page-side ground truth for what each ref pointed at
when read, which the product deliberately withholds from the wire. The
vocabulary note lives in headtohead.md §5 (obligation #9 discharged); the
`proxy.mjs` docstring **rides the next harness bundle**, with tier2 §8.2's
hygiene comment.

### 2. Replace-op elision — FIXED (tier6 §2)

`add`/`replace` op subtrees render expanded (render.ts, the two `expand`
literals). The changed-survivor case is pinned by unit rows in
`test/snapshot.test.ts` and by the new `filterlist` fidelity scenario, both
shown RED against the pre-fix build — `"e3: agent has label \"In stock\",
page has \"Backordered\""`, one wrong label and one failed independent check,
against build `1faac8cb…`. Seven fidelity scenarios now; none of the
pre-existing six moved a diff, resync or ref count. Arithmetic in RESULTS.md.

### 3. `~ eN "A"` ambiguity — FIXED (tier6 §3)

Upgraded from tier2 §10's deferral because it was **corrupting, not merely
ambiguous**: a text-only delta on an aria-labelled button emitted a bare
`~ e1 "✕"` and the shared reader applied it as a LABEL change, leaving a wrong
belief nothing downstream ever contradicts. Wire rule now: a bare quoted string
on a `~` line is always and only the new accessible name; inner text is spelled
`text "…"`; a name/text co-change emitting identical strings is deduped. The
reader parses by the token BEFORE each quoted string — one escape-aware scan,
not another regex excision, because a name whose content ends in `text ` defeats
any excision order. Renderer, reader, legend and tests landed together; the
misapply is pinned RED-first in `test/benchStream.test.ts`.

### 4. `inert` / `pointer-events` / small modals — FIXED (tier6 §4)

Rendered `inert` and `no-pointer` state words (State bits 2048/4096, appended to
STATE_NAMES); a `blocked: 'inert' | 'modal' | 'no-pointer'` field on the resolve
reply, computed in the preload; a per-action refusal matrix in tools.ts asked
BEFORE the hit-test — `select` allows no-pointer, which is the keyboard
asymmetry and is load-bearing; belt-and-braces refusals in the `aperture:select`
handler; and the inert ascent added to the fill preflight (`checkTarget`,
returning the existing `not-editable` token). Guards **G34–G36**, eleven legs
plus three added by the sabotage matrix, with the red record in
`docs/design/g34-36-red-record.md`. Pre-fix evidence includes `ok select e62 →
"Beta"` with the page's own witness reading `inert-select=b`.

One correction to the spec, measured: a modal `<dialog>`'s `::backdrop` covers
the whole viewport in Chromium, so the pre-fix build already refused an ordinary
background click — as an *obstruction*, naming the dialog and advising the agent
to dismiss an overlay. What actually landed pre-fix was the containment escape
hatch (guard G36d): `resolveRef` excuses obstruction when the target CONTAINS
the element at the point, and every addressable ancestor of the dialog does.

### 5. W1 residuals — CLOSED AS DESIGNED (tier6 §6)

`unknown` never fails an act, by contract (act.ts 98–103, 267): a mechanism that
turns its own unavailability into an error would invent failures — the Gate-2
lesson made structural. A page that self-navigates on a timer during settle
yields `unknown` per act (the `docToken` mismatch proves the document changed,
not that the input arrived), so a wedge on that page class is invisible to W1 in
principle and is covered only bench-side, by the collector's fixture-truth
witness events. Verified in the same function: a wedge on a NON-navigating page
cannot escape through that door — nothing navigates, the token still matches,
the counters stay frozen through the 2500ms re-poll → `lost`.

Three strengthenings considered and rejected on the record: escalating N
consecutive `unknown`s (converts apparatus states into invented act failures);
distinguishing timer-navigation from input-navigation (not derivable from the
recorder's counters); a self-navigating liveness canary (receives `unknown`
whether the input path is healthy or wedged, so it cannot discriminate).

The production surface is `witnessTally()` on `/metrics` with the >10% advisory
(tier4 §6.3). **It has never seen production data**: 0 of 385 h2h episodes and
0 of 230 task episodes carry a witness field, both cohorts predating the stamp,
so the advisory's only discrimination evidence is its `benchReport.test.ts`
console-capture row and the first post-tier6 cohort will be its first live
reading.

Related loose thread, still on the books: the once-in-~450-acts `ok click e6`
that never reached the button (wave 1), unreproduced in three cold starts. W1
is the mechanism that would now catch it; nothing has re-observed it.

### 6. Benchmark and harness defects found by the adjudications

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
  prices the turn term at the Aperture arm's per-turn context. **It has now
  been wrong in both directions off the same single cell**: `NOT CONFIRMED` at
  46.7% pre-tier5 (80.6% without catalog-order), `MECHANISM CONFIRMED` at 62.7%
  post-tier5 (33.3% without it). Neither printed verdict is a licensed reading.
  Where both arms solve the page, observation bytes are ~half the cost delta;
  the clean isolation is the diff/redump ratio, 0.46× on neutral-large. Fix
  spec: h2h §8.4. It stayed unfixed on purpose — the harness was frozen
  byte-identical so the two cohorts stayed comparable.
- **`account-prefs` has a case-sensitive predicate defect** — agents completed
  the task, the page said `digest Weekly`, the predicate wanted `weekly`. Every
  arm "failed" it. Symmetric, so it moves the headline by one episode; it is
  **not** a capability finding and must never be quoted as one. It was left
  broken deliberately so the post-tier5 cohort ran a byte-identical task set;
  **that constraint is now discharged and the fix is unblocked** for whenever a
  next cohort exists (it severs the store). Note that an adversarial reader can
  point at this cell to fire §7's economics-failure clause literally — diff
  $0.1502 vs redump $0.1357 — and `h2h-post-tier5-evaluation.md` §1.3 rules it
  does not fire, on three evidential grounds: the same inequality with the same
  margin exists in the archived pre-tier5 store, tier5's cost on this fixture is
  ±12 chars, and H11 excludes a both-arms-under-50% cell from every cost claim
  in either direction. Read §1.3 before re-opening it.
- **`report()` never prints `pwBrowserOverride`**, despite the harness comment
  promising it does. Every pw episode ran branded Chrome 150.0.7871.187, not
  the pinned chromium-1232 (which cannot spawn on this machine —
  `spawn UNKNOWN`), while the cohort's `chromium.browserVersion` records the
  pinned build that never ran. Scoring integrity is unaffected; the disclosure
  is mandatory. (h2h §0.5, obligation §8.1.)

### 7. Standing gaps in what the benches can see

- **Structure and position are not part of "faithful".** The fidelity bench
  verifies existence + role + label + value + states. A stream that scrambled
  containment would pass. Designed, not built.
- **Model-side budget truncation is unmeasured.** The bench aborts when the
  *truth* is cut, but an agent living on a 2000-token budget of a 9k-token page
  is the production case and no scenario measures it.
- **iframes** are claimed by the design and exercised by no benchmark or test.
- **The obstruction gate is exercised only by `bench:guards`** (G7a/G7b); no
  fidelity scenario raises a modal, so a hit-test regression would slip past
  the standing six.
- **`[N options]` staleness is measurable but only on the guard fixture** — no
  fidelity scenario contains a dependent select.
- **Shadow-root focus is invisible to the walker** (`document.activeElement` is
  the host, which gets pruned) — model and truth agree, so the bench cannot see
  it either. A known shared blind spot.
- **Equal-size same-walk family churn is undetectable in principle** at the key
  level — see the deferred backlog.

### 8. Security — the two classes with no author-independent sabotage row

The redaction programme is closed against a criterion that can be failed (below,
"The security programme"), and two of its seven rows have **not** been put
through the criterion's third clause:

- **Row C, alphabet** — walk-time `stripFormat`, one `redactUrl` composing
  `scrubUrlish`, `canonicalNeedle`. Only the builder's own sabotage row exists.
  Part of the class's repair is by construction (`redactFreeText` has no
  `marker` parameter, so "right marker, wrong scrub" is a compile error), which
  is stronger than a row — but that is an argument, not a measurement.
- **Row D, parity** — `urlsurfaces.test.ts` over all three page-influenced
  arguments of `routeCapture`. F-G was itself an independent finding *about*
  this guard, which is evidence it was narrow rather than evidence it is now
  wide.

Everything known about C and D is that they catch the instance they were
written from, which is exactly the standard the fourth gate measured to be
insufficient. **This is the first thing a fifth reviewer should point at**, and
the job is constructing those two rows — not inventing a sixteenth attack.

Disclosed residuals, none of them oversights:

- **A short all-digit sensitive value on a *carried* origin is not scrubbed
  there.** A one-time code, a 6–8 digit national ID, account number or salary is
  registered like any other needle but matched only on the origin it was filled
  into. On a carried origin nothing distinguishes those digits from the page's
  own order number; a marker that is sometimes a lie is worse than coverage
  that is sometimes absent. Both directions of that bound are guarded (one leg
  fails on over-redaction, one on under-redaction).
- **Page-side transformation defeats substring matching and always will** —
  base64, reversal, one character per element. Documented as unclosable; it is
  not a mechanism class.
- **The TTL boundary** — ten minutes, after which copies the page made go clear.
  Named as a member of the lifetime class, guarded by the lifetime invariant.
- **The vault window runs in the browser process**, not its own low-privilege
  OS account. Sound against the threat that matters (a hostile page steering the
  agent), not sound against local code execution as the same user.

### 9. Product surfaces not finished

- **Multi-select is replace-only.** Adding to an existing selection is not
  expressible; the result says so out loud rather than implying otherwise.
- **Optgroups are passive** — shown in listings and errors, never matched.
  `"group > label"` queries are deferred, so two same-labelled options in
  different groups are distinguishable only by value.
- **Per-container fingerprint derivation is not applied** — the seed exists, is
  stable, and is written into every container record; nothing derives from it
  yet (verified: `fingerprintSeed` has no reader in `src/`).
- **Attachments**: multi-upload forms need the ref→node bridge.
- **The Notion API path is unverified** and falls back to disk.
- **Passkeys are blocked on a probe, not on design.** tier2 §6 sequences the
  WebAuthn platform-authenticator probe first on purpose: if Electron cannot
  host one, passkeys become a Chromium-patch project and the vault roadmap stays
  password-primary.

---

## The security programme — what it is, and what must not be undone

Fifteen findings across four rounds, and the count never bent: read found 0,
probe 4, fixing 5, gate 7, fix 9, gate 11, fix 13, gate 15. "No more findings"
is therefore the wrong criterion — unfalsifiable, and wrong four times. Sorted
by **mechanism** rather than by surface, the findings collapse to seven classes,
each with a guard — and two of them additionally closed **by construction**,
where the wrong call is now a compile error rather than a reviewable mistake
(`redactFreeText` lost its `marker` parameter; `registerNeedles` returns what it
added). The table is in `security.md`; do not restate the programme as a count
of sinks.

**The criterion, and it can be failed:**

> Every mechanism has a guard that fails when that mechanism regresses; each
> guard has been shown to fail by sabotage; and **the sabotage row is an
> instance of the class that the guard's author did not have in hand** —
> equivalently, someone other than the guard's author picks the row.

The third clause is the whole difference, and it was earned by measurement, not
argument: the fourth gate re-applied two guards' recorded rows (both red, as
claimed), then wrote its own row for each — **both went green**. Twice more,
satisfying the clause *changed* a guard rather than confirming it (rows E and
G), and in both cases the author-independent row was green on the first attempt
and the fix was one line of the guard.

**What a future session must not undo** (`sink-closure-review-4.md` §8). Each
exists because a specific measured leak came through it:

1. **Needles survive navigation.** `invalidate` must not clear them again. The
   navigation is how the value arrives somewhere the agent reads.
2. **Needles are keyed by origin, and a tab's scope includes what it carries** —
   its opener's whole scope and every origin it has left. Coverage follows the
   value, not the tab's location.
3. **The strip happens at walk time.** `walker.ts` must hand the redactor the
   same bytes `quote()` will emit. Move it back downstream and one invisible
   character reopens everything.
4. **One `redactUrl`, and `redactFreeText` has no marker parameter.** Restoring
   that parameter makes "right marker, wrong scrub" spellable again.
5. **Both fill paths arm needles before the write** — and a third one must too.
6. **`needlesFor` and `scrubbablesFor` are not exported.** The store returns
   scrubbed text and a boolean; never a value.
7. **The marker is a claim about a match, not about a location.** It appears on
   origins the value was never filled into, and it must stay true there.

**What the criterion does not claim.** It does not claim there is no sixteenth
finding. It claims something narrower and checkable: a sixteenth finding that is
an instance of A–G fails a guard, and one that is not is an **eighth mechanism**
— which is the thing to report, because it is the only kind of finding that
moves the count that matters.

---

## Still owed

### Web Bot Auth

Built, merged, and live-verified (`webbotauth.md` §13): 72/72 green with the
feature present at artifact `4115dd9f…`, and 66/72 with the request mux
uninstalled — red on exactly the six named legs, including the three *absence*
guards, which are wired to hard-fail rather than pass vacuously when nothing
signs anywhere. Both artifact hashes are recorded, and the ordering deviation
(green run first, to establish the harness before a red could mean anything) is
recorded with it. What remains:

1. ~~**§12.5 step 3 — the two live-only sabotage rows.**~~ **PERFORMED
   2026-08-06** — `docs/design/owed-verification.md` §5.1. Both rows run live
   against a 73-leg harness (G33f was built first, because L2's red set names
   it). **L1** (the mux on a session no tab uses, spelled as a block-scoped
   shadow so no source guard can see it): `tsc` clean, **666/666 vitest green**,
   guards **67/73 RED on exactly {G33a, G33b, G33c-img, G33c-fetch, G33d,
   G33e-tamper}** — the behaviour discriminated while every offline instrument
   stayed satisfied. **L2** (window-open children inheriting `agentOwned`):
   guards **71/73 RED on exactly {G33d, G33f}** — it *does* fail twice, and the
   second failure is the popup being **captured** where it should have been
   refused. Both reverted; the artifact hash returned byte-identical both times.
2. ~~**Verification queue #7 — header order and casing.**~~ **PERFORMED
   2026-08-06** — `docs/design/owed-verification.md` §5.2, written into
   `security.md`'s queue row. **Reading R1 — inert on the wire.** Four legs, not
   two: A (no listener) ≡ B (listener, no-op path) in name **order** and name
   **casing**; and B ≡ D (listener returning a *new* object with identical
   content) in both as well, which is the stronger answer — inertness does not
   depend on returning `details.requestHeaders` by identity, so that spelling is
   not load-bearing. C's residual is exactly `Signature-Agent`,
   `Signature-Input`, `Signature`, **appended after every pre-existing name**,
   with no existing name moved or re-cased. `webbotauth.md` §8.2's scope
   sentence is **confirmed** by measurement, so no amendment is owed. Bound:
   **HTTP/1.1 cleartext only**; h2/h3 and remote (non-loopback) paths are not
   measured and are recorded as such.

### Security

3. ~~**Author-independent sabotage rows for classes C and D**~~ (defect 8
   above). **PERFORMED 2026-08-06** — `docs/design/owed-verification.md` §5.3,
   written into `security.md`'s class C and D cells. Four rows, two per class,
   each attacking a different clause of the same guard, constructed by someone
   who wrote neither guard. **All four were GREEN**, which is the finding and
   not a pass: **all four changed the guard.** That is the third, fourth, fifth
   and sixth time satisfying the stopping criterion's third clause has changed a
   guard rather than confirmed it. Every repair was then shown RED under its own
   row and green on the clean tree, and every row was reverted.

**NEW, and owed as its own item — raised by PROBE-C0 and REPAIRED under
authority.** The class-C sweep, run with no substitution against the shipped
module, found that `sanitize` was **not idempotent on walker output**:
`walker.ts` collapsed whitespace *before* stripping the invisibles, so deleting
a code point sitting **between two spaces** left a double space that the
redactor's needle did not contain and that `sanitize` then closed up at render
time — handing the model the secret whole. **69 code points**; F-B exactly, for
a case F-B's own correctness argument did not consider; and whitespace-bearing
needles are the ordinary case, since the profile fill path registers full names
and street addresses. **Repaired**: strip-before-collapse, in one shared
`normalizeText` in `src/core/snapshot/text.ts` whose output is a fixed point of
`sanitize` by construction, with the guard importing it rather than
transcribing it. RED before, GREEN after, single-code-point F-B form green on
both sides. **This is the one behaviour change in `src/` from that programme**;
everything else it touched was a sabotage row and every one was reverted.

### Harness obligations, carried forward verbatim — no code was written for any of these

The harness was frozen byte-identical so the two head-to-head cohorts stayed
comparable, and it stayed frozen. That freeze is now over.

4. **`report()` must print the browser override** — surface `pwBrowserOverride`
   from the cohort sidecar. H0's promise is currently kept only by the
   preflight.
5. **A SHIM-SUSPECT ruling acknowledgement** — a `--ruling <doc>` path letting
   `--report` exit 0 while printing both the flag and the ruling reference, so
   an adjudicated store stops reading as a faulted one forever. Until it
   exists, exit 7 is the shipped suite's honest posture and both h2h stores
   read as faulted forever.
6. **`account-prefs` predicate case-normalizes** (`String(v).toLowerCase()` at
   the fixture's state fn). Severs the cohort; next run only. **Now unblocked** —
   the byte-identical-task-set constraint was discharged with the cohort.
7. **H10 hardening** — print the pooled share alongside minus-flagged-cells
   (any SHIM-SUSPECT or H11 cell), and price the turn term at each arm's own
   per-turn context rather than the Aperture arm's.
8. **§2 wall-clock boilerplate** amended to cite the measured `upstreamMs`
   split instead of attributing the whole gap to queueing noise. The gap is
   real and attributable: sealed pw's browser-side time on home is 42.4s/ep
   median vs Aperture's 1.1s.
9. **§5.2 vocabulary note** — document that `identity_mismatch` is unreachable
   on identical-label rows and that `wrong_choice` there bundles the rebind
   hazard.
10. **The report must print the tab-policy / warm-revisit disclosure** that
    `tier5-ruling.md` §7 pinned. `h2h-post-tier5-evaluation.md` §4.2 carries it
    meanwhile, by hand.

**Not owed, deliberately:** `tier5.1` ("same-set reappearance revives"). Its
preregistered trigger did not fire, its entire value at current prices is
+$0.066/ep on one fixture's warm revisits while that fixture's ratio is already
licensed at 0.660×, and landing it costs a RED-first cycle plus a fresh cohort
to improve a claim that is not at risk. Prototyped and recorded in
`tier5-ruling.md` §6; available if the identity-tier work (radio `name`-attr
keying, §6's separate note) ever gets its own tier.

---

## Deferred backlog

**From `tier2.md`** (its own §9 order; §4 is the only item that has since been
done — the size sweep ran):

- **§1 — expand `add`/`replace` op subtrees in diffs** (stage C). Ruled DO IT;
  `expand: false` is still hardcoded at both render sites. This is also the fix
  for defect 2 and retires the `finder-cheapest` collapse cost.
- **§2 — sharpen `streamAssert`** to `streamAssert(diffStream, acts)` so
  `queue-positional`'s assertion actually discriminates positional from
  content-based keying (stage C).
- **§3 — preload reason strings narrowed to a fixed vocabulary**
  (`reason: 'exception'` + a 200-char detail) at all five `catch` sites in
  `page.ts`. security.md records four; the `select` handler made it five, which
  is the argument for the item: a construction does not need re-making every
  time a handler lands.
- **§5 — `inert` / `pointer-events: none` / small modal dialogs** (defect 4).
- **§6 — the security verification queue.** Two probes are real work and
  neither has run: **WebAuthn platform authenticator in Electron** (ranked
  first — it decides whether passkeys are reachable at all) and
  **`setContentProtection` vs capture on Windows 11** (the vault window
  currently asserts the favourable answer in a comment, which is exactly the
  class of claim this project's method section exists because of). Item #6
  (`Input.insertText` fidelity) is closed by inspection; **item #4 (webRequest
  listener eviction) is CLOSED BY CONSTRUCTION** — `src/net/webRequestMux.ts`
  is the one `onBeforeSendHeaders` registration in `src/` and
  `test/botauth.test.ts` asserts that receiver-independently; **item #8
  (`Signature-Agent` structured-field form) is RESOLVED** by the differential
  probe, 13/13, with the library version and draft revision pinned; item #7
  (header order/casing) is **RESOLVED — favourable, R1**, by the four-leg
  measurement of 2026-08-06 (`docs/design/owed-verification.md` §3);
  item #3 (debugger detectability) is queued behind a trigger condition.
- **§7 — Web Bot Auth. DONE and live-verified.** `src/net/botAuthCore.ts` (pure
  leaf: RFC 9421 canonicalization, RFC 7638/8037 thumbprints, config
  validation, the signing predicate), `src/net/botAuth.ts` (keys, directory
  export, one mux handler) and `src/net/webRequestMux.ts` (THE one
  `onBeforeSendHeaders` registration). Two design decisions worth not
  re-litigating, recorded in `webbotauth.md` §11: the keypair is **per
  CONTAINER, not per install** — one key across containers hands every
  allowlisted origin a cross-container correlator, the exact thing the
  container work exists to prevent — and the scope is **main-frame documents in
  `agentOwned` tabs only, not subresources**, because a subresource clause
  re-opens a `fetch()` signature-minting oracle for page script on an
  allowlisted origin. Signing is off unless a human writes
  `userData/botauth.json`, and with no directory URL it is structurally off
  rather than defaulted off, because an unverifiable `keyid` is a supercookie.
  The agent surface is zero — no tool reads, writes or reports any of it, and
  the allowlist is withheld as a targeting map. **The "register as a signed
  agent before 2026-09-15" goal stays killed**, corroborated against
  Cloudflare's published policy rather than inferred: signed-agent enrollment
  requires widespread-zone use, which one install per human fails per key. What
  is still owed is in "Still owed" above — two live sabotage rows and queue #7,
  not code.
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
  Post-tier5 this is **retired for the home set** — the 1.295× DEARER became
  0.823× CHEAPER when the bookkeeping tax died with the defect — and **stays
  live for neutral-small**, which is 0.977× [0.937, 1.019], a null in both
  cohorts.
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
node bench/fidelity.mjs "$TOK" form   # or rerender | widgets | biglist | selects | blindfields | filterlist
npm run bench:guards -- "$TOK"        # optional 2nd arg: fixture base URL
```

All seven fidelity scenarios in one go, one fresh Aperture each:
`bash bench/fidelity-all.sh`.

Exit codes for `fidelity.mjs`: 0 green · 1 red · 2 truth unusable · 3 step
failed · 4 **vacuous** (a run that measured nothing refuses to print a verdict
at all). `guards.mjs`: 0 all guards hold · 1 a guard failed · 3 could not run.

**`guards.mjs` refuses a stale build (exit 3).** If `out/main/index.js` is older
than any file under `src/`, it names both timestamps and stops before the first
check — three separate incidents here were a green guard run against an artifact
that predated the fix it was supposed to measure, and that failure is invisible
by construction. It prints the artifact's SHA-256 in its header and in the
RESULT line, so a pasted verdict says what produced it. Build first, then
restart Aperture, then run the guards; the credential guards additionally need
fixtures on **127.0.0.1:8899 and 127.0.0.2:8899**, with `localhost:8899`
reaching the same server (it is a third *origin*, not a third binding).

**The `allow` phase needs two more seed flags than it used to**, both since
2026-08-05, and neither is optional:

```bash
npx electron . --seed-vault --seed-profile \
  --seed-botauth=bench/botauth-dev-key.json \
  --e2e-consent=allow --e2e-consent-delay-ms=1500 > /tmp/ap.log 2>&1 &
```

The G30 block exercises the **profile** fill path, which had none of the
credential path's redaction machinery wired to it for three gates
(`docs/design/sink-closure-review-3.md` F-F). The G33 block measures Web Bot
Auth signing, and G33b/c/d assert the **absence** of signatures — vacuously
true against a launch with no signing configured, so they hard-fail unless
G33a (presence) is green in the same run. In both cases a forgotten flag reads
as REDs rather than as a block of quiet passes, which is the whole point:
`G30-seed` and the G33 vacuity trap exist because a green run against an
unarmed build is byte-identical to a green run against an armed one. Note also
that the vault's idle auto-lock is five minutes and is not reset by a dev-auto
consent, so the credential guards have to finish inside that window — a fresh
Aperture per run, which is the recommendation anyway.

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
node bench/headtohead/h2h.mjs --report          # exits 7 on the current store — read h2h-post-tier5-evaluation §6
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
  aggregate and wrong about every subset. Both h2h reliability headlines are
  carried entirely by one task, and H10's mechanism share has now been one task
  wearing a mechanism costume *twice, in opposite directions*: NOT CONFIRMED at
  46.7% off catalog-order's presence, CONFIRMED at 62.7% off the same cell one
  cohort later. A number consistent with a story is not the same as a true one
  — split it before you publish it.
- **A guard recognising its author's example is not a guard.** The security
  programme's stopping criterion needed a third clause for exactly this: two
  guards caught the sabotage row their author wrote and passed a different
  instance of the very same class. Twice more, an author-independent row was
  green on the first attempt and the fix was one line of the guard. If you write
  a guard, someone else picks the row that tests it.

The guard layer is the thing that has kept the numbers honest, not the
coordinators' aggregate readings. Its record across this programme: three
apparatus faults, all real, all caught before a verdict; one guard that
*manufactured* a finding and was demoted to advisory rather than allowed to
exclude cells; one surviving tripwire which, on investigation, was flagging a
genuine result; and the tier5 economics tripwire, which fired on a false premise
and was **honored rather than voided** — its diagnostic half caught a wrong spec
argument (every conventional HTML radio group is a positional family under the
shipped identity scheme) before a cohort was bought on it, while its stop-ship
half was ruled mis-specified. Most of its kills were the harness's own defects —
so the layer's history says our first-draft apparatus is the most dangerous
component in any benchmark here.

Instrument and compare against ground truth. Do not reason from the code alone,
do not trust a verdict without the counts behind it — and when a benchmark goes
green, spend a day trying to make it lie to you before you believe it.

---

## Where the programme stopped — 2026-08-06, HEAD `6e919d6`

Everything below is either done and verified, or written down with its evidence.

### Green at the stop
`npx tsc --noEmit` · `npx vitest run` · `npx electron-vite build` ·
`bash bench/fidelity-all.sh` 6/6 · `node bench/guards.mjs <tok> --phase=allow`
**72/72 at artifact `4115dd9f…`** (`webbotauth.md` §13 is the record, and it
records the discriminating RED against a differently-hashed artifact in the
same session) · `node bench/task.mjs --selftest` PASS. The `deny` and `none`
phases were last recorded green at the 2026-08-03 pause and have not been
re-run since; re-run them before quoting them.

### Tags
`wave2-scored` · `wave3-scored` · `sweep-scored` · `tier4-landed` ·
`h2h-scored` · `vaultfill-landed`

### What closed here

- **The head-to-head programme.** Both primaries measured twice on a
  byte-identical apparatus with one engine treatment between the cohorts; the
  one failed primary was fixed under preregistration and re-measured passing;
  every economics claim carries its class, its CI and its disclosures. What
  remains unsettleable is unchanged — live web, other models, the sealed frame
  itself, familiarity asymmetry, Playwright's CLI mode, long horizons — plus
  one addition: the undated model alias makes cross-cohort agent-behaviour
  comparisons observations, never claims.
- **The tier5 tripwire**, ruled ACCEPT by an independent adjudicator who did not
  build the fix (`tier5-ruling.md`). The §9.4 claims freeze is lifted; RESULTS
  and README now restate from the post-tier5 store only.
- **The redaction programme**, against a criterion that can be failed — seven
  mechanism classes, seven guards, five of them sabotaged by someone other than
  the guard's author.
- **Web Bot Auth**, built, merged and live-verified with both artifact hashes
  recorded.
- **Two false sentences in `security.md`** that the vault fill work created
  ("the process never receives plaintext" was narrower than written; the
  redaction row said "designed, not yet implemented" when it was implemented).
  Both corrected 2026-08-05.

### What is not done
Everything under "Open defects" and "Still owed" above. Nothing there blocks the
Thursday backlog below.

### The rule that produced everything here
Six things marked "working" broke the moment they were measured end to end,
and every specification written for this project has had at least one defect
found by its own builder. Nothing is believed because it was designed that
way; a guard that has only ever passed is a guard of unknown value.

---

## Two rulings worth not re-opening

**The tier5 economics tripwire fired, and was ruled ACCEPT** (`tier5-ruling.md`,
by an adjudicator who did not write the spec and did not build the change). Read
it before anyone proposes narrowing the retirement pre-pass:

- The firing family on `journal-comment` is **not** the star-group wrappers the
  builder's record blamed — wrappers hold no refs, so the "nothing held" gate
  skips them every time. It is the **five radios themselves**, keyed
  `N|0|radio|rating`, because `identityKey` ranks the shared `name` attribute
  above the radios' unique ids. **Every conventional HTML radio group is a
  positional family under the shipped identity scheme.** The §4.2 neutrality
  lint could not have caught it: the lint checks unique accessible names, a
  property the identity key never consults.
- Retirement fires on **all six** neutral fixtures, not one; five are costless
  (±3–18 chars) and were invisible to the char-delta instrument that was
  supposed to detect them.
- Every neutral firing is a **same-set reappearance** after absence, never a
  live membership change, so first-contact cost is identical pre- and post-fix.
  The whole +96% is warm-revisit cost, and the pre-fix cheapness was
  manufactured by the revival channel tier5 exists to close.
- Candidate (b) — narrow the pre-pass to non-ADDRESSABLE nodes — was
  **prototyped and measured dead**: byte-identical to the unpatched fix, because
  `radio` and `list` are both ADDRESSABLE. It excludes only the family that
  already cannot fire.

Superseded by tier5: tier4 §1.7's byte-identity pin. G1's `queue-resync`
snapshot moved 2067 → 2074, fully explained — cross-fixture positional revival
is severed, so seven refs mint as 3-char `eNN` instead of 2-char `eN`.

**The `catalog-order` SHIM-SUSPECT tripwire fired on both cohorts and is ruled
the same fair product difference both times.** pw-sealed: 0/10, all `gave_up`,
all at the step cap, zero witness-visible page actions in 120 steps, every
episode asking for a `budgetTokens` affordance only Aperture's channel can
honour. pw-stock: 5/5, same engine, bigger dumps. The cell measures the model
failing to convert a ~22k-token re-dump into a targeted action through a 3-tool
surface with no scoping affordance — and **the deployment-relevant incumbent
number on that task is stock's 100%, said in the same breath.**

---

## Backlog — added 2026-08-03, DONE 2026-08-06 (see below)

Owner-requested, not started, no design work done. Listed in the order given.

1. **Screenshot + autocrop.** The capture path exists (`browser_capture`, the
   Notion default from the original build). What is new is autocrop — trimming
   the shot to the meaningful region rather than the whole viewport. Open
   questions for whoever specs it: crop to what (the acted element, the
   changed region, detected content bounds)? Does the agent choose, or does
   Aperture? Does a crop ever hide something the human needed to see — the
   consent dialog case argues for care here.

2. **Dark mode — some text is unreadable.** A real defect in shipped UI, not a
   feature request. Native dark mode came from the `nightfall` work
   (`cunninghambe/nightfall`); the failure is contrast on some text. Needs the
   actual offending surfaces identified first (browser chrome? vault UI?
   page-side `Emulation.setAutoDarkModeOverride` output?) — the fix differs
   completely between our own UI and Chromium's auto-darkening of arbitrary
   pages.

3. **Voice instructions for agent response.** Spoken input driving the agent.
   Undesigned. Note the security doctrine applies unchanged: voice is a
   channel to the agent, and the agent remains the manipulable component —
   consent for anything sensitive still has to live in the native dialog a
   voice command cannot click.

None of these is blocked by anything above, and nothing above is blocked by
them. The items they were queued behind — the tier5 tripwire ruling, the
security session, Web Bot Auth, and the owed h2h cohort — are all closed.


---

## Thursday's backlog — closed 2026-08-06, HEAD `6e919d6`

| item | outcome |
|---|---|
| Screenshot autocrop | **Shipped.** Auto-trim by default, which cannot hide visible content by construction; detail crop declines to the full frame on a closed list including any open modal — declined even when the modal *is* the target. Eight decline paths demonstrated live. `docs/design/autocrop.md` |
| Dark-mode contrast | **Shipped.** The reported defect was Chromium force-dark's band seam — text flipped light below brightness 150, backgrounds darkened only above 205, so the ~98–205 band kept a light fill under light text. Measured 1.21:1, now 7.87:1. Diagnosis also found two defects nobody reported: the dark-mode policy engine had exactly ONE call site (the `browser_theme` MCP tool) so it had never run during normal browsing, and theme `light` did not stop darkening while reporting that it had. Both fixed. `docs/design/darkmode-contrast.md`, bench `npm run bench:darkmode` |
| Voice input | **Dropped by the owner.** Spec kept at `docs/design/voice.md`, marked DROPPED, because the reasoning is the useful part: the honest design turned out to be that Aperture should never open the microphone at all. All code removed; seven files returned byte-identical to HEAD, which is the removal's own proof. |

Two dark-mode bench reds were **ruled, not waived**, and the distinction is the
point of recording them:

- `fg-aaa/fff` was the **bound** being wrong. `REQ = min(4.5, max(3.0, 0.8 ×
  authored))` demanded 3.0:1 from a surface its author shipped at 2.32:1 —
  which §6.1's own rationale forbids — and failed even though inversion had
  *improved* it to 2.82. Corrected to never demand more than the author
  shipped, then verified to move exactly two rows and flip exactly one verdict.
- `bg-909090/333` was closed by **measurement**: a sweep of the live contrast
  tuning found 110 is the max-min point (worst margin +0.32 against +0.14 at
  105), with the two binding rows moving in opposite directions and every
  dark-native row unaffected because auto-skip injects no filter. The 0.8
  factor was not touched.

One process note worth keeping: the removal pass **refused a coordinator
instruction and was right to**. It was told to delete an `input::placeholder`
rule as note-channel debris; that rule is dark mode's own omnibox fix (§3-F5,
3.88 → 6.44), and deleting it would have silently reverted the repair the same
session had just made.
