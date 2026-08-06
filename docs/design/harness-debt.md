# Harness debt — triage and work orders — 2026-08-06

Status: TRIAGE, decision-complete. Scope: the instruments only — the benches,
their guards, their stores and their printed sentences. No product work, no
security work. Written at HEAD `a9e39d8`, tree clean. Method: every claim of
"landed" or "open" below was verified against the file at this HEAD, not
against HANDOFF's memory of it; every exit-code claim was measured by running
the report modes this session (they start no infrastructure and open no
ports); every hash claim was recomputed with the store's own algorithm.

The ranking currency, fixed in advance: **how likely the defect is to produce
a wrong published claim.** Nothing here ships to a user; an instrument's only
failure mode that matters is a false sentence someone quotes.

Implementers execute the work orders in §3 verbatim. §5 gives the order and
the ownership partition.

---

## 0. Ground truth first — the debt list is stale in five places, and two new defects were found

### 0.1 Already landed. Strike these from every debt list.

Verified in code at `a9e39d8`, all landed in `83fbd45` ("tier4: … G3
error-kind; instance stamp; metric repair") unless noted:

| item | evidence |
|---|---|
| Task-suite G3 exit-3 on a single-line `error:` observation (wave3-evaluation §1.4, all five items) | `bench/lib/streamModel.mjs:319-331` (`isBareError`, `classifyObservation` precedence with page-shaped bytes winning); `bench/task.mjs:952-958` (`redumpImpurities` excludes `error`, includes `other` — ONE definition used by both the G2 precheck at :1049 and report-G3 at :1960, §1.4 item 3 satisfied); G4 denominator drops `error`/`other` at `bench/task.mjs:2011-2026`; tests at `test/benchStream.test.ts:468-486` including the F5 case and the wave-2 walk-timeout case |
| Post-resync "65 vs 236" vacuous comparison (wave3-evaluation §0.2) | `bench/task.mjs:2059-2085` — diff-arm-only, rates with denominators, and the no-cross-arm-reading note printed with it |
| Apparatus instance stamp (wave3-evaluation §0.1) | `bench/task.mjs:490-505, 2289-2328` — `app restart — expected` vs same-instance wording |
| `crossoverBand` false band sentence — the WHOLE of sweep-evaluation §2 | §2A: seven outcomes incl. both one-sided kinds, `bench/size.mjs:1474-1553`; §2B: the licensed sentence assembled from `perTier` with the band as a subordinate clause, `bench/size.mjs:2046-2075`; §2C: `--dry` enumerates `[straddle, straddle, below, below, below]`, its mirror, and the non-monotone shape, `bench/size.mjs:1638-1668` |
| RESULTS.md runId provenance note for `bench/size/results.jsonl` | `bench/RESULTS.md:1228-1230` |

HANDOFF "Open defects" item 6 bullet 1 (crossoverBand) and the user-facing
claims that the task suite's `report()` "exits 3 on the F5 store" and that the
post-resync fix "never landed" are stale. What remains open from
sweep-evaluation §2 is only its two ride-alongs (WO-B1, WO-B4).

### 0.2 Both scored stores exit 6 at this HEAD — not 3, not 7. Measured, not inferred.

Run this session, no ports, no budget:

```
node bench/task.mjs --report            → exit 6 (INTEGRITY)
node bench/headtohead/h2h.mjs --report  → exit 6 (INTEGRITY)
```

HANDOFF's "wave 3's exits 3 … both h2h stores exit 7" described the trees
those stores were scored at. At `a9e39d8` neither refusal ever reaches G3 or
SHIM-SUSPECT: the integrity guard fires first, because the tree moved after
the programme closed. The causes, from the refusals' own file tables:

- **Product rebuild.** `out/main/index.js` and `out/preload/page.cjs` moved
  (WBA + darkmode work). Current buildVersion `73ff606165bba066` vs task
  cohort `469784c4c2c2d98e` and h2h cohort `0916e30fb90b1c02`.
- **Watched-set pollution — the new fact.** Four files landed inside
  `bench/fixtures/`: `botauth-dev-key.json` (WBA seed key) and
  `darkmode/{darknative,darkscheme,light}.html` (the darkmode bench's
  fixtures). The h2h identity hashes that tree RECURSIVELY (`hashTree`,
  `h2hStore.mjs:67-82`), so all four moved its codeVersion
  `dfa962c3f89b4d53 → 8d282bdbf37a6bfa`. The task suite's `hashFileSet`
  (`store.mjs:91-113`) is non-recursive and skips directories, so of the
  four only the json enters ITS watched set — the asymmetry is itself a
  trap: a fixture dropped one directory deep severs one suite and not the
  other, and nothing says so.
- The task-suite store is additionally severed by the engine itself
  (tier5 + security touched `src/core/snapshot/**`) and by the hand-bumped
  suiteVersion (`2026-08-03.1` on record vs `2026-08-04.1` now).

**Verified by recomputation**: hashing `bench/headtohead/**` +
`bench/fixtures/**` with the four intruder files excluded reproduces
`dfa962c3f89b4d53` exactly — the cohort codeVersion of BOTH h2h stores (the
live post-tier5 store and the archived pre-tier5 store,
`episodes.20260805T231456Z.cohort.json`, both read this session). The h2h
harness is still byte-identical to both scored cohorts; only fixture-dir
pollution and the product rebuild severed them.

Consequences that shape everything below:

1. **No fix in this document can strand a store that is not already
   stranded.** Every scored cohort is closed, severed at HEAD, and carries an
   adjudication as its verdict of record (`wave2/wave3-evaluation.md`,
   `h2h-evaluation.md`, `h2h-post-tier5-evaluation.md`). The freeze is over
   and the inter-cohort window is open. This is the moment the deferred
   harness edits were waiting for.
2. The archived stores remain readable and re-scorable exactly as they are
   (JSONL untouched; `bench/lib/stats.mjs` recomputation, or `--report` at a
   checkout of the recorded gitSha with a matching rebuild). Nothing below
   touches any store file or any archived sidecar.
3. The four-benches-one-port situation (`fidelity`, `guards`, `task`,
   `darkmode`, plus `size` and `headtohead` all owning 8817) makes the
   port-refusal behavior each runner already has load-bearing; nothing below
   changes port handling.

### 0.3 Two defects this triage found that no list carries

- **`surfaceOverheadChars` is never persisted to the cohort sidecar.**
  `report()`'s cold path reads it from the sidecar
  (`h2h.mjs:2591-2594` — the comment promises exactly that) but
  `runScoredPhase`'s `writeCohort` extra (`h2h.mjs:2137-2147`) never writes
  it. Verified: absent from both h2h sidecars. So every cold `--report` and
  `--phase 4` — including BOTH printed verdicts of record — ran H10 with the
  `toolSurface` term silently 0. Materially small (H4 pins the sealed
  surfaces byte-identical, so the aperture-diff − pw-sealed surface delta is
  ~0 by construction; pw-stock comparisons are where it is nonzero), but it
  is precisely the "metric that cannot see a field looks exactly like a
  metric that measured zero" class. Folded into WO-A3.
- **The watched-set pollution class itself** (0.2). Not a one-off: darkmode
  is an actively developed bench whose fixtures currently sit inside the
  scored suites' content hash, so a contrast tweak to a darkmode fixture
  mid-cohort would sever a future scored cohort silently. The size sweep
  solved this class by construction (`bench/size/fixtures/` + a `--dry`
  refusal if a size fixture leaks into the watched set, `size.mjs:1574-1584`);
  darkmode got neither. WO-C1.

### 0.4 Confirmed open

- h2h obligations 4, 5, 7, 8, 9, 10 (HANDOFF "Still owed"): no `--ruling`
  flag exists (`parseArgs`, `h2h.mjs:2433-2470`); `report()` never prints
  `pwBrowserOverride` (grep: the identifier appears only at the stamping
  site, :2146); H10 still prints the binary CONFIRMED/NOT-CONFIRMED and
  prices turns at the Aperture arm's context (:2015-2044, :2355-2373); the
  wall-clock footer still says "dominated by API queueing noise"
  (:2421-2422); no `identity_mismatch` vocabulary note; no tab-policy /
  warm-revisit disclosure.
- account-prefs predicate: still `s.frequency === 'weekly'`,
  `bench/headtohead/neutralTasks.mjs:112`.
- size.mjs ride-alongs: no `modelUsage` capture anywhere in the file; the
  two-regressor fit prints as `cost ≈ …` whenever R² ≥ 0.9 with no
  identification check (`size.mjs:2024-2038`); `projectSpend` still linear
  (:1748-1761); no `--report` mode, so the only readers of
  `bench/size/results.jsonl` are humans under a filter-by-runId obligation.
- HANDOFF item 7 standing gaps: all open; README already scopes them
  honestly (README:198, 307, 317, 768), so none currently overclaims.

---

## 1. Ruling 1 — is out-of-band scoring load-bearing? Yes as process; it must not be the specified end state.

The record: four scored stores, four non-zero exits, four hand adjudications
— and all four refusals were CORRECT. Wave 2's exit 3 flagged wedged
episodes (real, quarantined); wave 3's exit 3 flagged a taxonomy gap (real,
now fixed); both h2h exit 7s flagged a genuine product finding that needed a
human ruling. The refusal layer is the part of the programme that worked.
What failed is the loop back: no refusal, once investigated and ruled, could
ever be acknowledged in band, so the suites' designed capability — printing
their own verdict of record — was never exercised even once, and every
verdict in RESULTS.md is a hand-transcribed recomputation. Hand transcription
is where wrong published claims breed; the adjudications themselves caught
the coordinators' readings wrong repeatedly (h2h-evaluation §0: "six
readings wrong, four load-bearing").

**Ruled, four parts:**

1. **The exit codes stay as specified.** Exit 7 on an unruled SHIM-SUSPECT
   and exit 3/6 on the task suite's guards are the honest postures. No
   re-specification of exit codes to "warn and print anyway" — a tripwire
   that prints a verdict is not a tripwire.
2. **The acknowledgement path gets built, for SHIM-SUSPECT only** (WO-A2).
   SHIM-SUSPECT is the one guard whose designed resolution is a *human
   ruling document* rather than a code fix — and it re-fires
   deterministically: catalog-order will trip it in every future cohort on
   this task set (pw-sealed 0/10, twice, ruled the same fair product
   difference twice). Without an ack path, every future h2h cohort is
   hand-scored forever, by construction. That is the capability loss to
   close. The loop becomes: tripwire → exit 7 → investigation → ruling doc
   in `docs/design/` (unwatched, so writing it does not sever) → `--report
   --ruling <doc>` → verdict printed WITH the flag and the ruling reference,
   exit 0 — all inside the cohort's lifetime, before the tree moves.
3. **No acknowledgement path for the task suite.** Its two historical
   refusal classes are both closed by better means: wedges are G6b-
   quarantined (preregistered), and the dispatch-free `error:` taxonomy gap
   is fixed (§0.1). A remaining G3/G11 trip is presumptively real
   contamination, and a store that is really contaminated SHOULD read as
   faulted until a human fixes the apparatus. An ack flag there would be a
   pooling override wearing a ruling costume — the thing `store.mjs` says
   there is deliberately no flag for.
4. **Closed cohorts exit 6 forever, and that is correct — say so in the
   refusal.** Report-mode integrity is NOT relaxed: `report()` re-scores,
   so a codeVersion mismatch means the scoring code differs from what
   stamped the rows, and printing anyway is exactly the "confident
   percentage, exactly like a real result" failure the store exists to
   prevent. (Relaxing only buildVersion in report mode was considered and
   rejected: it buys nothing — mid-cohort you cannot rebuild anyway without
   severing, and post-cohort the adjudication is the verdict of record —
   and it costs a guard surface.) What the refusal owes instead is one
   sentence pointing at the adjudications (WO-A1 for h2h, WO-B5 for task),
   so "severed" stops reading as "faulted".

Hand adjudication therefore remains the protocol for *investigating* a
tripwire; the ruling document becomes machine-referenced instead of
permanently out-of-band. The suites recover self-scoring for every future
cohort whose only flag is the one with a standing ruling protocol.

---

## 2. Ruling 2 — the demonstrated-victim ranking

"Would this guard have caught a real error, had it existed?" — answered from
the record, and the ranking follows it. A defect with a demonstrated victim
outranks a hypothetical.

| rank | defect | victim on record | what a mechanical fix would have done |
|---|---|---|---|
| 1 | H10's binary verdict + Aperture-priced turn term + pooled flagged cells | Printed a WRONG verdict in BOTH cohorts, opposite directions, off the same cell (NOT CONFIRMED 46.7% / 80.6% without catalog-order; CONFIRMED 62.7% / 33.3% without). Two adjudications each spent a section un-saying it | The minus-flagged-cells share line pre-empts both wrong verdicts arithmetically; the CONFIRMED word is the part that lies — delete it (WO-A3) |
| 2 | Report omits mandatory disclosures: `pwBrowserOverride`, warm-state/tab protocol, wall-clock attribution, `identity_mismatch` reachability | The cohort identity records a chromium build that NEVER RAN while the report stays silent (h2h-evaluation §0.5) — an actively false record for anyone quoting it; the warm-state disclosure pinned by tier5-ruling §7 travels "by hand" (h2h-post-tier5 §4.2); the printed wall-clock footer attributes to "queueing noise" a gap its own table shows is 42.4s vs 1.1s browser-side | Disclosures printed by the instrument travel with every quotation automatically (WO-A1) |
| 3 | No SHIM-SUSPECT ack path | Four stores hand-scored; coordinators' aggregate readings wrong six times in one brief; every future cohort inherits the same fate deterministically | Closes the loop in band (WO-A2, per Ruling 1) |
| 4 | account-prefs case-sensitive predicate | Every arm "failed" a completed task; the cell nearly fired tier5's economics-failure clause literally, needing a three-ground sub-ruling to stop it (h2h-post-tier5 §1.3); the report's "capability finding" framing had to be struck (h2h-evaluation §0.4) | One line; unblocked since the byte-identical constraint discharged (WO-A4) |
| 5 | Watched-set pollution (bench/fixtures shared) | ALREADY severed both scored stores' report paths, silently, while nobody was looking (§0.2) — the failure occurred, it just had no cohort in flight to kill | Relocation + a startup refusal in the polluting bench (WO-C1) |
| 6 | Two-regressor fit prints unidentified coefficients as a cost model | Near-miss: R² 0.921 with a −$0.011/turn "price"; the adjudicator caught it before publication (sweep-evaluation §1.3) | An identification check demotes it mechanically (WO-B2) |
| 7 | `modelUsage` not persisted by size.mjs | The input-vs-generation decomposition survived THREE cohorts unanswered (wave3-evaluation §4 item 2 named the field; the sweep ran without it; the unidentified fit in rank 6 is the same question resurfacing). The h2h persisted it and could therefore attribute the home premium to output tokens — the field's value is demonstrated, by contrast | WO-B1 |
| 8 | `bench/size/results.jsonl` stray rows guarded only by a documentation obligation | No victim yet — the printed table was clean and RESULTS carries the note — but "any recomputation must filter by runId" is a per-human trap of exactly the class this repo distrusts | A reader that refuses to pool runIds (WO-B3) |
| 9 | Standing bench blind spots (HANDOFF item 7) | The `[N options]` class had its victim historically (a reader that couldn't see the bytes; fixed); the obstruction gate and dependent-select remain single-fixture; the rest are disclosed scope limits with no false sentence anywhere | Two cheap fidelity scenarios (WO-C2); the rest stay documented (§4) |

Items 1–2 are the "instrument that lies" tier — they print false or
misleading sentences about their own data. Fix or delete: for H10's verdict
word the answer is **delete** (the numbers stay, the binary goes); for the
disclosures it is **fix** (print what the preregistrations pinned).

---

## 3. Work orders

House rules binding every WO: RED first where a guard changes (write the
failing case, watch it fail, then fix); no store file, sidecar, or archived
artifact is ever edited; `docs/design/**` is unwatched everywhere, so ruling
documents never sever; each bundle lands complete before any next cohort's
first episode.

Severance summary (the §0.2 facts make this short): **nothing below strands
anything not already stranded.** WOs A1–A4 move the h2h codeVersion; WO-B5
moves the task codeVersion; WO-C1 moves both (by removing files from
`bench/fixtures/`); WOs B1–B4 and C2 touch only unwatched files
(`bench/size.mjs`, `bench/fidelity.mjs`, `bench/guards.mjs`,
`bench/darkmode.mjs`, `test/**`). The archived h2h codeVersion
`dfa962c3f89b4d53` is momentarily restored by WO-C1 and re-severed by
WO-A1–A4; restoration is NOT a goal (buildVersion `0916e30f`/`6eb65fbf` is
unrecoverable without rebuilding at the recorded SHAs), and the §0.2 hash
recomputation already banked the integrity fact the restoration would have
proved.

### WO-A1 — the report prints its mandatory disclosures (h2h obligations 4, 8, 9, 10 + refusal pointer)

Files: `bench/headtohead/h2h.mjs` only.

1. Change `report(rows, surfaceOverheadChars = {})` (h2h.mjs:2182) to
   `report(rows, surfaceOverheadChars = {}, cohort = null)`; at the call
   site (:2594) pass `cohort`.
2. Immediately after the total-spend line (:2199), print a `PROVENANCE
   (mandatory — travels with every quotation)` block:
   - **Browser override.** If `cohort?.pwBrowserOverride`:
     `pw browser: '--pw-browser <value>' override — every pw episode ran the
     override browser; the identity's chromiumRevision (<rev>) records the
     PINNED build, which did not run. (h2h-evaluation §0.5)`
     If explicitly null: `pw browser: pinned chromium <rev> (no override)`.
     If cohort is absent or the field is missing:
     `pw browser: NOT RECORDED in this cohort sidecar — treat the identity's
     chromiumRevision as unverified.` Never silent.
   - **Warm-state / tab protocol** (the tier5-ruling §7 pinned disclosure,
     verbatim as one fixed string):
     `tab policy: shared-tab-per-run — Aperture's engine carries warm ref
     state across a run's episodes; the pw arms have no warm state to reuse.
     The asymmetry is real, favors neither side uniformly, and is in the
     numbers rather than hidden from them (it is what prices the
     warm-revisit expand against Aperture).`
3. In the PRECISION block (after :2327), print the vocabulary note
   (obligation 9), one fixed string:
   `note: identity_mismatch cannot fire on identical-label rows (the
   detector compares labels); on such fixtures wrong_choice bundles the
   rebind hazard and a zero identity_mismatch count is evidence of nothing,
   in either direction. (h2h-evaluation §0.6)`
4. Replace the wall-clock footer (:2421-2422) with:
   `The browser-time medians above are measured per-call upstream latency
   (upstreamMs) and are attributable; only the remainder of wall-clock is
   API queueing noise. Where the medians diverge (e.g. ~40s vs ~1s
   browser-side on home), the gap is real felt latency, reported and never
   verdicted.`
5. In `main()`'s integrity-refusal block (:2576-2584), after the
   no-override line, add:
   `A refused store is not a faulted store. If its cohort is closed and
   adjudicated, the adjudication in docs/design/ is its verdict of record
   (HANDOFF reading order); this refusal only says the CURRENT tree cannot
   re-score it.`
6. Doc amendment (same PR): `docs/design/headtohead.md` §2's boilerplate
   sentence (~lines 164-168) gains the same upstreamMs wording as item 4.

RED-first: not a guard change — print-only. Verification: `node --check`,
`node bench/headtohead/h2h.mjs --dry` green, then `--report` still exits 6
at HEAD and now prints the item-5 pointer line (observable without ports).
The disclosure block itself is exercised by WO-A2's dry cases (below), which
drive `report()` over synthetic rows with a synthetic cohort.

Severance: moves h2h codeVersion (already severed; lands in the A bundle
before any next cohort).

### WO-A2 — the SHIM-SUSPECT ruling acknowledgement (h2h obligation 5)

Files: `bench/headtohead/h2h.mjs` only.

1. `parseArgs` (:2433): add `ruling: null` to defaults and
   `else if (a === '--ruling') out.ruling = argv[++i];`. In `main()`, if
   `opts.ruling` is set without `opts.report || opts.phase === 4`, bail
   INFRA: `--ruling is an acknowledgement for --report / --phase 4; it
   gates no scored run.`
2. New exported pure helper (beside `harnessFaultCheck`):

   ```js
   export function rulingAcknowledges({ problems, rulingPath, root }) {
     const shim = problems.filter((p) => p.startsWith('SHIM-SUSPECT'));
     const other = problems.filter((p) => !p.startsWith('SHIM-SUSPECT'));
     if (!problems.length) return { ack: false, reason: 'nothing to acknowledge' };
     if (other.length) return { ack: false, reason: `non-SHIM problems present (${other.length}) — a ruling cannot acknowledge ${other[0].split(' — ')[0]}` };
     if (!rulingPath) return { ack: false, reason: 'no --ruling given' };
     const abs = resolve(root, rulingPath);
     if (!existsSync(abs)) return { ack: false, reason: `ruling document not found: ${rulingPath}` };
     const title = readFileSync(abs, 'utf8').split('\n')[0].trim();
     return { ack: true, shim, title, rel: rulingPath };
   }
   ```

3. `report()` gains an `opts = {}` last parameter carrying
   `{ ruling, root }`; its tail (:2424-2426) becomes: print problems as
   today; then
   `const r = rulingAcknowledges({ problems, rulingPath: opts.ruling, root: opts.root });`
   — if `r.ack`, print:
   `ACKNOWLEDGED — the flag(s) above stand, and are RULED, not waived:` then
   per flag `  <flag line>` then
   `  ruling: <rel> — "<title>"` then
   `  The ruling is the verdict of record for the flagged cell(s); this
   report's numbers are printed under it. (Built per harness-debt.md WO-A2;
   the path h2h-evaluation §8.2 specified.)`
   and return `EXIT.MEASURED`. Otherwise return `EXIT.HARNESS_FAULT` as
   today (printing `r.reason` when `--ruling` was given but did not
   acknowledge).
4. **The teeth, stated as an invariant:** `--ruling` can acknowledge ONLY a
   problem set that is entirely SHIM-SUSPECT lines. H7/H8/H9/contamination
   problems are never acknowledgeable — those mean the apparatus, not the
   competitor, and no document waives an apparatus fault.

RED-first (the guard-changes rule applies — this changes what exit 0 means):
extend `dryRun()` with four cases against `rulingAcknowledges`, written and
run red before the report tail changes:
- `['SHIM-SUSPECT — catalog-order: …']` + an existing temp ruling file →
  `ack: true`.
- same problems, missing file → `ack: false`.
- `['SHIM-SUSPECT — x', 'H9 — pw-stock: …']` + existing file →
  `ack: false` (**the sabotage row**: if this ever goes green with
  `ack: true`, the flag has become a waiver — this case is the one that
  must stay red forever).
- `[]` + file → `ack: false`.

Acceptance: at a checkout of `3828b64` with a matching rebuild (optional,
port-gated; see §5 verification matrix), `--report --ruling
docs/design/h2h-post-tier5-evaluation.md` would exit 0 printing the flag and
the reference. At HEAD, acceptance is the dry cases plus `--report` behavior
unchanged (exit 6 before any ruling logic — integrity outranks
acknowledgement, deliberately).

Severance: moves h2h codeVersion (already severed; A bundle).

### WO-A3 — H10: delete the verdict that lied twice, keep the numbers, price turns honestly (h2h obligation 7 + §0.3 sidecar gap)

Files: `bench/headtohead/h2h.mjs`.

1. **Delete the binary.** Remove the `MECHANISM CONFIRMED` / `MECHANISM NOT
   CONFIRMED` prints (:2363-2367). In their place, after the pooled share
   line, print:
   - `minus flagged cells (<list>): share <X>%` — flagged = tasks named in
     SHIM-SUSPECT lines ∪ H11 `excludedCells` ∪ `contaminatedCells` keys.
     Factor the SHIM-SUSPECT scan (:1915-1935) into an exported
     `shimSuspectTasks(rows)` returning task ids, used by both
     `harnessFaultCheck` and this print.
   - per-class shares (`decompose` restricted to each class), alongside the
     existing per-task table.
   - the isolation line:
     `clean observation-channel isolation (diff/redump, same engine, same
     dialect): <ratio>x on neutral-large` via `meanRatioCI` over `costable`
     aperture-diff vs aperture-redump `costUsd`, neutral-large.
   - one fixed sentence:
     `The pooled share is task-mix arithmetic — across the two scored
     cohorts it crossed its own 50% bar in opposite directions off the same
     single cell. No binary mechanism verdict is licensed by it; read the
     minus-flagged share and the diff/redump isolation.`
2. **Per-arm turn pricing** in `decompose` (:2033-2040): compute
   `meanCtxPerTurnB` alongside `meanCtxPerTurnA`; the term becomes
   `turnsDelta * (turnsDelta >= 0 ? meanCtxPerTurnB : meanCtxPerTurnA)` —
   excess turns are priced at the context of the arm that spent them, which
   is what they cost. Comment it with the h2h-evaluation §3.2 finding
   (pricing pw's failure-loop turns at Aperture's small context undercounted
   them).
3. **Persist `surfaceOverheadChars`** in `runScoredPhase`'s `writeCohort`
   extra (:2137-2147): `surfaceOverheadChars,` — one line. Cold reports then
   stop zeroing the `toolSurface` term for cohorts created after this lands.
   (Archived sidecars stay as they are; both printed verdicts of record ran
   with the term at 0 and their adjudications reproduced exactly that — the
   fact is recorded here and needs no retro-repair.)
4. **`VERDICT_RULE.mechanism`** (:88) becomes:
   `'H10: decomposition is advisory — printed pooled, minus-flagged-cells,
   per class and per task, with the diff/redump isolation ratio; no binary
   mechanism verdict is printed (harness-debt.md WO-A3)'`. This changes the
   stamped verdictRule → **may not land mid-cohort, ever**; it lands now, in
   the open window.

RED-first: two dry cases before the fix — (a) synthetic rows where arm B has
2× arm A's per-turn context and `turnsDelta = +1`: assert the `turnCount`
term equals B's context (fails against the current A-priced code); (b)
synthetic rows with one SHIM-SUSPECT task carrying 90% of the obs delta:
assert pooled share crosses 0.5 while minus-flagged share does not, and that
`shimSuspectTasks` names the cell.

Severance: h2h codeVersion + verdictRule (already severed; A bundle).

### WO-A4 — account-prefs case-normalization (h2h obligation 6)

Files: `bench/headtohead/neutralTasks.mjs`.

Change :112 from `s.frequency === 'weekly'` to
`String(s.frequency).toLowerCase() === 'weekly'`.

One deliberate deviation from h2h-evaluation §8.3's parenthetical ("at the
fixture's state fn"): normalize at the **predicate**, not in the fixture, so
the witness keeps recording the raw page state and the tolerance is visible
where the judgment is made. Same effect, better evidence trail. Do not
"harden" the other five neutral predicates in the same commit — only
account-prefs is ruled; if inspection finds a sibling of the same class,
record it as a note in the predicate comment and stop.

RED-first: add to `dryRun()` a predicate-tolerance table —
`account-prefs` predicate over `{notifications:true, method:'sms',
frequency:'Weekly'}` must pass and over `{…, frequency:'daily'}` must fail.
Write it first; it is red against `===` today; green after.

Severance: h2h codeVersion (already severed). This is the fix
h2h-post-tier5-evaluation §9.1 explicitly unblocked; it MUST be in the same
pre-cohort bundle as WO-A1–A3 so the next cohort's baseline includes it
(next-run-only, exactly as ruled).

### WO-B1 — size.mjs persists `modelUsage` (wave3-evaluation §4 item 2; sweep-evaluation §2 ride-along; three cohorts overdue)

Files: `bench/size.mjs` (unwatched — severs nothing, ever).

1. Add a pure `flattenModelUsage(mu)` mirroring `h2h.mjs:858-864`:
   returns `{ modelKeys: Object.keys(mu ?? {}), inputTokens, outputTokens,
   cacheRead, cacheCreation }` summing `inputTokens`, `outputTokens`,
   `cacheReadInputTokens`, `cacheCreationInputTokens` across models.
2. `agentDriver`'s return (:986-991) gains `modelUsage: result?.modelUsage
   ?? null` and `...flattenModelUsage(result?.modelUsage)`.
3. `runEpisode`'s returned row (:883-916) carries them through
   (`modelUsage`, `modelKeys`, `inputTokens`, `outputTokens`, `cacheRead`,
   `cacheCreation`); `record()` (:1891-1907) persists them (they ride the
   spread — verify the `diffStream` truncation still lands after the
   spread).
4. `reportTierB` prints one new descriptive line per tier when the fields
   are present: `tokens/ep D: in <i> out <o> cacheRead <c> · R: …` — the
   decomposition wave 3 could not do becomes readable off the next sweep's
   store directly.

RED-first: dry case feeding `flattenModelUsage({ 'claude-sonnet-5':
{ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100,
cacheCreationInputTokens: 7 } })` asserting all four sums and the key list.
(The SDK-side shape is verified against `h2h.mjs`'s working extraction; its
live confirmation is inherently first-sweep — noted in §6.)

### WO-B2 — the cost-fit identification guard (sweep-evaluation §1.3's near-miss, made mechanical)

Files: `bench/size.mjs`.

1. Add `fitCostModelDescriptive(rows)`: one-regressor OLS of `costUsd` on
   `convInputChars` → `{ slope, intercept, r2, n }`.
2. In `reportTierB`'s fit block (:2024-2038), before printing the two-term
   model, apply the identification check: `identified = fit.perTurn > 0 &&
   fit.prefixFitted >= 0`. When `fit.ok && fit.r2 >= 0.9 && !identified`,
   print instead:
   `R² = <r2> but the fit is NOT IDENTIFIED — the per-turn coefficient is
   <perTurn> (a negative or zero "price"), i.e. turns encode the arm rather
   than a cost. The two-term model is not citable (sweep-evaluation §1.3).
   Descriptive only: cost ≈ <slope> $/char on conversation-input chars,
   R² = <r2d> — cite this or nothing; never "the prefix costs X".`
   The identified path prints as today, plus the descriptive line.
3. Dry case (RED first): a synthetic sample where `modelTurns` takes only
   two values perfectly correlated with a binary cost offset (recreating the
   sweep's degenerate design) must route to the NOT IDENTIFIED branch;
   the existing noiseless-synthetic case must stay on the identified branch.

### WO-B3 — `--report` for the sweep, with a runId pooling refusal (the results.jsonl trap becomes a guard)

Files: `bench/size.mjs`. The store file is NOT touched — the four stray rows
stay exactly where they are; what changes is that a machine, not a footnote,
enforces the filter.

1. Extract the per-tier aggregation from `reportTierB` (:1973-2010) into
   `perTierFrom(rows)` — tier order by each tier's `tierChars` ascending
   (carried on every row), independent of the fixtures manifest, so a cold
   report needs nothing but the store; `tierA` becomes an optional argument
   — its single print line is skipped when absent.
2. New mode `--report [--run <runId>]` (extend `usage()` and the mode gate
   at :1785): loads `bench/size/results.jsonl` via `loadStore` from
   `../lib/store.mjs` (malformed lines refuse, house rule), groups rows by
   `runId`, prints the roll — `runId · n · $total · codeVersion(s)` — and
   then:
   - exactly one runId, or `--run` names one → verify the selected rows
     carry ONE distinct `codeVersion`/`buildVersion` pair (else refuse,
     EXIT.INFRA, naming the split — a runId that spans two builds is a
     corrupted run, not a poolable one); print `reportTierB` over them, with
     a provenance header naming runId, stamp, and n.
   - multiple runIds and no `--run` → print the roll and REFUSE
     (EXIT.INFRA):
     `this file holds <k> runs; scoring them pooled would average different
     experiments. Name one: --report --run <runId>. (The 2026-08-02 file
     holds a 4-episode aborted pilot beside the 54-episode scored run —
     sweep-evaluation §0.3.)`
     There is deliberately no `--all`.
3. Dry case (RED first): feed the grouping/refusal helper a synthetic
   two-runId array → refuses; one-runId → proceeds; one runId with two
   buildVersions → refuses.

Acceptance at HEAD (portless): `node bench/size.mjs --report` over the real
file prints the two-run roll and refuses; `--report --run
2026-08-02T05:39:27.192Z` reproduces the adjudicated per-tier table (the
digits of sweep-evaluation §1.2 — s3 −$0.0338 [−0.0469, −0.0204] etc.; seed
20260801 is already pinned in `meanDiffCI` calls). This acceptance check IS
the re-scorability guarantee for the sweep store, mechanized.

### WO-B4 — `projectSpend` — DEFERRED, deliberately

The linear-in-page-size projection is preregistered (tier1b §2) and its
failure mode mis-allocates N (it cut s5 to N=4 for a $9.88 run projected at
$88.52); it cannot print a false claim. Replacing it re-opens a
preregistered budget rule outside any live design — that belongs in the next
sweep's own design doc, where the replacement (fitted char slope + measured
per-episode floor, per sweep-evaluation §2's ride-along note) gets
preregistered properly. Action now: one comment on `projectSpend`
(:1742-1747) recording the measured ~9× pessimism and pointing here. Nothing
else.

### WO-B5 — the task suite's refusal points at the verdicts of record

Files: `bench/task.mjs` (`bailIntegrity`, :1460).

Add to the refusal epilogue (after the "deliberately no flag" line):
`A refused store is not a faulted store. If its cohort is closed and
adjudicated (wave2/wave3-evaluation.md), the adjudication is its verdict of
record; this refusal only says the CURRENT tree cannot re-score it.`

Severance: moves task codeVersion — already severed (§0.2); the wave-3 store
is closed history and `--new-cohort` archives it automatically whenever the
next task cohort starts. Verification: `--report` at HEAD exits 6 printing
the new line (portless).

### WO-C1 — evict the intruders from the watched set, and make the class refuse

Files: `bench/darkmode.mjs`, `bench/guards.mjs`, file moves, one new test.
All unwatched.

1. `git mv bench/fixtures/darkmode bench/darkmode-fixtures` and update
   `bench/darkmode.mjs:43` (`FIXTURE_DIR`) accordingly.
2. `git mv bench/fixtures/botauth-dev-key.json bench/botauth-dev-key.json`
   and update the four references in `bench/guards.mjs` (:27, :2425, :2453,
   :2644).
3. **The class guard**, mirroring `size.mjs:1574-1584`'s precedent: at
   `darkmode.mjs` startup, build BOTH identities — `buildIdentity`
   (`bench/lib/store.mjs`) and `buildH2hIdentity`
   (`bench/headtohead/lib/h2hStore.mjs`, or just its `hashTree` over
   `bench/fixtures`) — and refuse to run if either watched file table
   contains a path under the bench's own fixture dir: the same "this bench
   cannot move a scored suite's codeVersion" invariant the size sweep
   asserts about itself on every `--dry`. Both, because the two suites
   watch `bench/fixtures` with different recursion (§0.2) and a guard that
   checks only one re-creates the asymmetry it exists to close.
4. New `test/watchedSet.test.ts` (RED first — both assertions fail at HEAD
   before the moves, pass after; note which identity each targets):
   - the H2H watched tree (`hashTree(root, 'bench/fixtures')`) contains no
     path under `bench/fixtures/darkmode/` — red at HEAD (recursive hash);
   - every file the TASK identity watches under `bench/fixtures/` is
     `.html` or `.js` (the witness and fixtures are the only things that
     belong there; the dev key was neither) — red at HEAD (the json).
5. Doc path updates in the same change: `docs/design/webbotauth.md` and the
   HANDOFF run-command that cite `--seed-botauth=bench/fixtures/…` (path
   fact only, no claims touched — flagged for the owner in §5).

Effects, stated so nobody over-reads them: this restores the archived h2h
codeVersion `dfa962c3f89b4d53` exactly (verified, §0.2) until the WO-A
bundle re-moves it — the archived stores stay refused either way because
their buildVersions are unrecoverable; the real value is that a darkmode
fixture edit can no longer sever a scored cohort in flight, and the next
cohorts' baselines stop hashing another bench's files.

Verification: `node --check` both benches; `npx vitest run
test/watchedSet.test.ts`; `node bench/size.mjs --dry` (its separation check
must stay green); guards' live re-run with the moved key path is port-gated
— next guards session, and the `allow`-phase G33 vacuity trap will hard-fail
if the path update is wrong, which is exactly the guard doing its job.

### WO-C2 — the two cheap coverage gaps with history (HANDOFF item 7, actionable subset)

Files: `test/fixtures/**` + `bench/fidelity.mjs` — both unwatched (fidelity
serves `test/fixtures`, not `bench/fixtures`; keep it that way for exactly
WO-C1's reason).

1. **Obstruction under fidelity** (the gate is currently exercised only by
   `bench:guards` G7a/G7b, so a hit-test regression slips the standing six).
   New scenario `modal`: a fixture that opens `dialog.showModal()` over a
   button mid-scenario. Accept: acting on the covered ref through
   `browser_act` is REFUSED with the obstruction error naming the dialog;
   closing the dialog and re-acting lands; the refusal and the recovery are
   both asserted from the stream. RED-first is structural: write the
   scenario before wiring, watch it fail for the right reason (scenario
   unknown), then wire; then sabotage once — comment out the engine's
   hit-test call in a scratch build and confirm the scenario goes RED (the
   scenario exists to refuse exactly that regression).
2. **Dependent select / `[N options]` staleness** (currently measurable only
   on the guard fixture): extend the `selects` scenario with a
   country→city dependent pair. Accept: after changing the parent, the
   stream re-announces the child's `[N options]` marker with the new count,
   asserted from the stream alone; a stale count is RED.
3. Port discipline: fidelity runs own 8817 — run in a free window, one
   scenario per fresh Aperture, per the standing recommendation.

Everything else in item 7 stays documented, not built — §4.

---

## 4. Standing gaps (HANDOFF item 7) — disposition of the rest

These cannot print a false sentence; they are absence of coverage, already
disclosed in README (:198, :307, :317, :768) and RESULTS. The test applied:
does a cheap fixture close it, does it have a victim, would a reader of the
current docs be misled?

| gap | disposition |
|---|---|
| Obstruction gate outside fidelity | **Build** — WO-C2.1 (regression would be a wrong GREEN on the standing six) |
| `[N options]` staleness only on the guard fixture | **Build** — WO-C2.2 (the class had a historical victim: the reader that dropped the marker) |
| Structure/containment/position not part of "faithful" | **Defer, designed.** A containment-path digest per ref compared model-vs-truth is the shape of the fix, but it is a walker+bench project, not a fixture. No victim; README states the limit verbatim. Revisit only if a structure-scrambling defect ever appears in the wild |
| Model-side budget truncation unmeasured | **Defer to the next measurement campaign** — it is the sweep's named "truncation regime" quadrant (sweep-evaluation §5), a paid cohort, not harness debt |
| iframes claimed by design, exercised by nothing | **Defer with the docs as-is** — README already lists it as not measured; building iframe fidelity belongs with the WebArena-class follow-up |
| Shadow-root focus shared blind spot | **No action possible at the bench** — model and truth agree by construction; recorded |
| Equal-size same-walk family churn | **No action possible in principle** at the key level (tier4 §1.4); recorded |

---

## 5. Implementation order, ownership, verification

Order (each bundle lands whole; nothing here waits on a cohort, everything
must precede the next one):

1. **Bundle C1** — watched-set eviction (WO-C1). First because it is 30
   minutes, it stops an active pollution class while darkmode is under
   development, and it leaves the watched sets truthful for everything
   after.
2. **Bundle A** — the h2h harness (WO-A1 + A2 + A3 + A4, one PR). The
   wrong-claim tier lives here. Single owner because the four WOs edit the
   same two files (`h2h.mjs`, `neutralTasks.mjs`) and share dry cases.
3. **Bundle B** — size + task (WO-B1 + B2 + B3 + B5; B4 is a comment).
   Independent of A; may run in parallel with it (zero file overlap).
4. **WO-C2** — fidelity scenarios, when a port window exists.

Ownership partition (three implementers, disjoint files, no coordination
needed beyond the order above):

- **A**: `bench/headtohead/**` — WO-A1–A4.
- **B**: `bench/size.mjs`, `bench/task.mjs` — WO-B1–B5.
- **C**: `bench/darkmode.mjs`, `bench/guards.mjs`, `bench/fidelity.mjs`,
  `test/fixtures/**`, `test/watchedSet.test.ts`, file moves — WO-C1, C2.

Verification matrix:

| check | needs | when |
|---|---|---|
| `node --check` every edited file; `h2h --dry`; `h2h --lint`; `size --dry` (incl. all new RED-first cases); `npx vitest run` | nothing | every bundle, at land time |
| `task --report` / `h2h --report` exit 6 with the new pointer lines | nothing | bundles A, B |
| `size --report --run 2026-08-02T05:39:27.192Z` reproduces sweep-evaluation §1.2's table to the digit | nothing | bundle B — this is the acceptance test for WO-B3 |
| `watchedSet.test.ts` red before / green after the moves | nothing | bundle C1 |
| fidelity `modal` + `selects` scenarios green; `modal` sabotage RED | port 8817 free | WO-C2, one scenario per fresh Aperture |
| guards `allow` phase green with the moved key path (G33 trap validates it) | port 8817 free, fixtures on 127.0.0.1/127.0.0.2:8899 | next guards session |
| optional, full-circle: checkout `3828b64`, rebuild, `--report --ruling docs/design/h2h-post-tier5-evaluation.md` exits 0 | a worktree + rebuild + port window | only if the owner wants the demonstration; not required — the dry cases carry WO-A2's guarantee |

HANDOFF corrections owed (owner's file, not this one — listed so they are
not lost): item 6 bullet 1 (crossoverBand) is fixed and should say so with
this document as the record; "Running the benchmarks" should note both
scored stores now exit 6 at any post-programme tree and that the
adjudications are the verdicts of record; the `--seed-botauth` path changes
with WO-C1; obligations 4–10 collapse to "see harness-debt.md" once bundles
A/B land.

---

## 6. What this triage could not verify

- **No bench was run live.** Port 8817 is contended by sibling work; every
  claim here rests on static reading plus the two portless `--report`
  invocations and hash recomputations recorded in §0.2. Specifically NOT
  re-verified live: the guards suite after any change (its own artifact-hash
  refusal covers staleness), fidelity 6/6, `deny`/`none` guard phases
  (HANDOFF already flags those as stale-green).
- **`npx vitest run` was not executed** (tree clean at a HEAD the HANDOFF
  records green; nothing was edited by this triage).
- **The SDK `result.modelUsage` shape for the size driver** is asserted from
  `h2h.mjs`'s working extraction against the same SDK dependency, not from a
  live sweep episode; WO-B1's flattening is dry-tested, but the field's
  population is confirmable only on the next paid sweep.
- **`verdict-post-tier5.txt` was not re-derived**; its reproduction is taken
  from h2h-post-tier5-evaluation's recomputation note. Consistent with it,
  the §0.3 finding (toolSurface term 0 on cold reports) implies both printed
  H10 blocks ran with that term absent — the adjudications reproduced the
  printed numbers, so nothing published moves; recorded here as provenance.
- **The exact darkmode-fixture serving path after WO-C1** (`bench:darkmode`
  is live-only; `node --check` and the fixture-dir constant are the static
  guarantee; first live run confirms).
- **Whether any sibling workstream is concurrently editing
  `bench/fixtures/`** — if one is, WO-C1's `git mv` should be coordinated to
  land after theirs; the `watchedSet.test.ts` invariant will catch any
  recurrence regardless.
