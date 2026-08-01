# Tier 2b — closing the propDelta blind-field class, and fixing the instrument that missed it

Status: SPEC, decision-complete. Written 2026-08-01 against `master` at
`f4cd2e2` while wave 2 was still scoring. Companion to
`docs/design/review-external-2026-08-01.md`, which carries the verification
evidence; this file carries the decisions. Implementers execute verbatim,
AFTER the wave. Every ruling has a WHY; where a judgement call was close, the
rejected option is named.

Verified-by-execution facts cited here (probe outputs, wave-data counts) are
in the review doc and are not re-argued.

---

## 0. The instrument, first: why five green fidelity scenarios missed this

This is the most important section of the file. The engine bug is one defect;
an instrument that certifies completeness while structurally unable to see a
defect class is a defect factory.

### Diagnosis — three candidate causes, ruled on individually

**(a) Fixture coverage — CONTRIBUTING, SECONDARY.** None of the five
scenarios (form, rerender, widgets, biglist, selects — `bench/fidelity.mjs:144-283`)
contains a static data table or a mutating href. No scenario could have
exercised the blind fields. But adding a fixture alone would NOT have produced
a RED — see (b) and (c).

**(b) The assertion model — PRIMARY CAUSE, two independent holes.**

1. *The shadow reader discards the blind fields.* `parseElementLine`
   (`bench/lib/streamModel.mjs:23-59`) extracts role, ref, label, value,
   states, optionCount — and drops `href` (bare token, unparsed), `dims`
   (`RxC` token, unparsed), `scroll` (unparsed), and table rows entirely: row
   lines are pipe-joined content lines with no `role eN` head
   (`render.ts:247-252`), so `parseElementLine` returns null on them and they
   enter neither the believed model nor the truth map. The comparison at
   `fidelity.mjs:463-505` compares only what the reader carries. **Both sides
   of the comparison are blind in the same way, so a table fixture would have
   compared stale-vs-fresh as equal.** The caveat at fidelity.mjs:28-32 even
   documents the five-field scope; nobody re-derived that scope when the
   walker's emission set grew. A sixth fixture bolted onto this comparison
   would have been theatre — the coordinator's suspicion is correct.
2. *The defect's exact signature was classified as a harness error.*
   `stepFailure` (`fidelity.mjs:320-323`) treats any `(unchanged` response as
   exit 3 — "a step did not run… this scenario expects every step to change
   the page." Exit 3 means NO VERDICT and reads as "fix your scenario." So the
   one place the harness would have tripped on a table fixture routes the
   engine's false "nothing changed" into a scenario-design complaint instead
   of a RED. Loud, but mislabeled — and mislabeled in the direction that
   invites editing the fixture until the complaint goes away.

**(c) Same-walker ground truth — NOT THE CAUSE for this class.** The walker
captures rows and href correctly and `renderFull` renders them
(`render.ts:233`, `247-252`); the truth snapshot contained the current table
the whole time. The blindness is in what the comparison extracts from the
truth text, not in the truth. (The same-walker caveat remains real for other
classes — a walker that mis-reads the DOM fools both sides — which is what
the independent typed-value/state checks exist for. They survive unchanged.)

### Root cause, one level up

The comparison's field set was written once and never tethered to the
walker's emission set. `SnapshotNode` gained fields (`href`, `rows`, `dims`,
`scroll`, `optionCount`…); `propDelta` and the fidelity reader kept their
original scopes independently. Nothing forced anyone to rule on a new field.
That is the recurrence mechanism, and it gets a mechanical guard (below), not
a resolution to be more careful.

### The fix — assertion model first, then the fixture, then a tripwire

**F1. Extend the shared reader** (`bench/lib/streamModel.mjs`; one copy on
purpose, both benches import it):

- `parseElementLine` additionally returns `href` and `dims`. Parse
  positionally: after extracting label, value, and `[N options]`, and after
  peeling the state-word tail, the remaining bare tokens are (in emission
  order, `render.ts:230-238`) href, `RxC` dims, `(top/heightpx)` scroll.
  Capture href and dims; discard scroll (excluded from the contract — §1).
  hrefs are `sanitizeHref`-guaranteed to contain no whitespace or quotes, so
  token-level parsing is safe.
- `applyObservation` attaches table rows: after a parsed element line with
  role `table`, consume subsequent lines of strictly deeper indentation as
  `entry.rows` (split on ` | `, unquote cells) until indentation returns to
  the table line's level or shallower. Same rule on full snapshots, `+ add`
  subtrees, and `! replace` subtrees — the rows always directly follow their
  table's line.

**F2. Extend the comparison** (`bench/fidelity.mjs`), for ALL scenarios:

- `believed.href !== actual.href` → new counter `WRONG HREF`, problem line
  naming both values. WHY all scenarios: hrefs exist on most fixtures already;
  a stale href anywhere is now visible for free.
- Rows: normalize to a joined string (`rows.map(r => r.join('|')).join('\n')`)
  and compare; mismatch → new counter `WRONG TABLE CONTENT`. dims compare is
  implied (derived from rows on both sides) — do not compare separately.

**F3. Reclassify the defect signature.** `stepFailure` gains the step flag
`mutates` (default `true`; a future scenario may set `mutates: false` for a
deliberate no-op step). For a mutating step, an `(unchanged` response is no
longer exit 3 — it prints
`RED: the engine reported "unchanged" for an action the bench knows mutated the page — information is missing from the stream`
and exits 1. WHY: exit codes are policy. Exit 3 means "the measurement could
not run"; this measurement DID run and found the exact defect class. The
original bug, replayed under a table fixture, must produce a RED a release
gate refuses — not a shrug a scenario author edits around.

**F4. The sixth scenario — `blindfields`.** New fixture
`test/fixtures/roster.html` (fidelity fixtures live in `test/fixtures/`,
served on :8899 by `fidelity-all.sh`):

- A static data table (`<table id="shipments">` — plain text cells, NO links,
  buttons, or inputs inside, so `hasInteractiveDescendant` is false and the
  walker flattens it to `rows`).
- Outside the table: button `Advance shipment` — each click sets two known
  cells to known literals (click 1: row for `#1001` becomes `SHIPPED`,
  click 2: row for `#1002` becomes `CANCELLED`).
- A link `Continue to checkout` with `href="/checkout"`, and a button
  `Rotate link` that sets the href to `/checkout-v2`. Label never changes.
- A bare `<button>Follow</button>` directly under `<main>` (no testid, no id,
  no name, no distinguishing siblings — S-tier by construction) that toggles
  its label to `Following` on click. This is the P2 churn detector's
  validation case; in this scenario it only asserts the stream delivers
  SOMETHING for the change (today: remove+add; post-P2, possibly one update —
  the assertion is on content delivery, not op shape, so it stays green
  across P2).
- A static control paragraph that never changes.

Scenario definition:

```
blindfields: {
  url: `${BASE}/roster.html`,
  steps: [
    { do: 'click', label: 'Advance shipment' },   // table cells -> SHIPPED
    { do: 'click', label: 'Rotate link' },        // href -> /checkout-v2
    { do: 'click', label: 'Advance shipment' },   // table cells -> CANCELLED
    { do: 'click', label: 'Follow' },             // S-tier label morph
  ],
  expect: { minRefs: 5, minDiffs: 3 },
  independent: [
    { ref: 'byLabelTable', rowsInclude: 'SHIPPED' },
    { ref: 'byLabelTable', rowsInclude: 'CANCELLED' },
    { link: 'Continue to checkout', href: '/checkout-v2' },
    { anyLabel: 'Following' },
  ],
}
```

The `independent` block is the same-walker pierce, following the established
pattern of `typed`/`stateChecks` (fidelity.mjs:507-528): the bench KNOWS what
its clicks did (the fixture is ours), so it asserts the believed model —
built only from the stream — contains the literals, without consulting the
truth snapshot. Implement as data-driven checks beside the `typed` loop.

Wire this scenario into `fidelity-all.sh`'s scenario list.

**Required evidence at landing: run `blindfields` against the CURRENT build
before landing the engine fix, and record the RED (step 1 returns
`(unchanged`, F3 fires) in the landing commit message.** An instrument change
that has never seen the defect it claims to catch is the false green all over
again.

**F5. The congruence contract — the anti-recurrence guard.** New
`test/completeness.test.ts`:

- A literal ruling table over every `SnapshotNode` key:
  `'diffed' | 'structural' | 'excluded'`, with the WHY string for every
  `excluded` entry (the table in §1 below is the content). The test builds a
  fully-populated sample node and asserts every own-key of it appears in the
  ruling table. **Adding a field to `SnapshotNode` now fails CI until someone
  records a ruling.**
- For every `'diffed'` field: construct a node pair differing in that field
  alone and assert `propDelta` returns non-null (or, for `children`/
  `optionCount`, that `diffSnapshots` emits ≥1 op). **This single test,
  applied to the pre-fix code, fails on `href` and `rows` — it would have
  caught the original bug the day `rows` was added.**

**F6. Guards tripwire.** `bench/guards.mjs` gains **G13a/G13b** (next free
IDs; current set ends at G12b): navigate to `roster.html`, click
`Advance shipment` — the observation must NOT match `/\(unchanged/` and MUST
contain `SHIPPED` (G13a); click `Rotate link` — observation must contain
`/checkout-v2` (G13b). WHY guards too: fidelity runs one scenario per fresh
Aperture and takes minutes; guards are the fast end-to-end tripwire run
against every live build. Same division of labor the file header describes.

**F7. The task suite carries NOTHING new.** WHY: it measures agents, not
streams (review doc §3 — its wrong-element gap is the deliberate
queue-positional measurement). Adding a table task would conflate defect
classes and pollute cross-wave comparability. Ruled out.

---

## 1. P0 — `propDelta` field completeness

### The field contract, enumerated against `SnapshotNode` (types.ts:50-111)

This table IS the content of the F5 ruling test. "Structural" means the
children/registry machinery reports it; "diffed" means `propDelta` must.

| field | ruling | WHY |
|---|---|---|
| `name` | diffed (already) | — |
| `value` | diffed (already) | — |
| `text` | diffed (already) | — |
| `states` | diffed (already), Offscreen masked | mask stays; scroll-churn noise (diff.ts:363-364) |
| `href` | **diffed — NEW** | a stable label over a mutated target is a wrong-element action the agent cannot detect; security-relevant (§ below) |
| `rows` | **diffed — NEW** | the central bug; flattened tables are pure content |
| `dims` | derived — restated with `rows`, never compared alone | dims is computed from rows (walker.ts:281); rows equality implies dims equality |
| `optionCount` | structural (already) | `optionSetTurnedOver` (diff.ts:324) covers count AND same-count enumeration turnover; propDelta duplication would double-report. Unchanged. |
| `children` | structural (already) | reconcileChildren |
| `scroll` | **excluded** | churns on every scroll by agent, user, or page; the agent's own scroll actions already return observations; semantic consequences of scrolling (Offscreen) are masked for the same reason. The related exclusion precedent is the Offscreen mask. |
| `rect` | excluded | geometry; agents act by ref, not coordinates; changes on every layout shift |
| `headingLevel` | excluded | presentation weight; the heading's text is the operative fact and IS diffed; no observed failure class |
| `autocomplete`, `inputType` | excluded | never rendered (types.ts:97-104) — the model never held them, so there is nothing to keep faithful |
| `shape` | excluded | renderer-internal collapse hint |
| `ref`, `key`, `frameId`, `synthetic` | excluded | identity plumbing, not page facts |

Snapshot-level fields, for completeness: `url` — handled (`navigated` hoist,
engine.ts:259); `title` — **excluded, documented**: tab-badge counters make
title a live region (`(3) Inbox` ticking), and the meaningful correlate (a
route change) is the `navigated` check. Considered and rejected: diffing
title. `viewport` — full-only by design. `modal` — the dialog subtree's
add/remove already reports it.

### Wire format

**href** (update op): append token `href=<newvalue>` to the `~` line:

```
~ e42 href=/phish-target
```

New value only — precedent is name and value, which render the new side only
(render.ts:374-375). No quotes: `sanitizeHref` (walker.ts:697-699) strips
whitespace, control chars, and bidi overrides and caps at 60, so the token
cannot break the line or the parser. `PropDelta` gains
`href?: [string, string]` (old value kept in the op for consumers;
renderer emits only `[1]`).

**rows** (update op): the `~` line gains a `RxC:` tail and the rows follow,
indented, in exactly the element-line row format (extract the row-rendering
in `renderLine` (render.ts:247-252) into a shared
`renderRows(rows, pad): string[]` and use it in both places — two copies of
the row format is how one goes stale):

```
~ e7 3x2:
  "Order" | "Status"
  "#1001" | "SHIPPED"
  "#1002" | "CANCELLED"
```

**Restatement, not a row-level edit script — decided.** WHY: (i) the
repo's own doctrine at diff.ts:39-45 — a wholesale restatement is far less
likely to be misapplied by a model than an interleaved edit script, and model
reliability outranks diff minimality; (ii) rows have no identity — a row-diff
needs row matching, which is the second diff engine the constraint forbids;
(iii) tables are capped at 50 rows with truncated cells (walker.ts:753), so
the worst case is bounded and the `tooBig`/`DIFF_SIZE_RATIO` valve
(engine.ts:294-296) already converts pathological cases into a full resync.

**Update op, not replace — decided.** The alternative (emit `! replace` of
the table node, zero new vocabulary) was seriously considered and rejected
for one reason: economics under self-ticking tables. The engine feeds only
`update` ops to the volatility tracker (engine.ts:234-244), and a
rows-carrying update with no state bits is `contentOnly` (diff.ts:131-132),
so a stock-ticker table that rewrites itself every second follows the exact
suppression path a ticking clock does — demoted by streak/EWMA, reported as
`N live-region updates suppressed`. A replace-based design has no suppression
path and restates 50 rows per tick forever, which is the economics failure
the coordinator flagged. `PropDelta` gains `rows?: string[][]` and
`dims?: { rows: number; cols: number }` (both set together).

propDelta comparison rule for rows: compare only when BOTH sides have `rows`
defined (cheap early-exit loop over ≤50×cols strings); emit delta when
unequal. When flattening flips (table gains/loses an interactive descendant),
one side has `rows` and the other has `children` — the children-side
reconciliation already restates content through add/replace ops; emitting a
rows delta too would double-report. One asymmetric case is covered
explicitly: old has `rows`, new has neither rows nor children (table emptied)
→ emit rows delta with `rows: []`.

Volatility feed (engine.ts, beside the existing update handling): for a
rows-carrying update, `noteChange` receives as `text` the first differing
cell's new value (first cell of first row if lengths differ). WHY first
differing cell: it is what a human would call "the change", it gives
`TIMER_SHAPE` a shot at a clock-in-a-cell, and it is O(cells) with
early exit.

### Files touched (all in one atomic set — "Set B", §5)

| file | change |
|---|---|
| `src/core/snapshot/types.ts` | `PropDelta` gains `href?: [string,string]`, `rows?: string[][]`, `dims?: {rows,cols}` |
| `src/core/snapshot/diff.ts` | propDelta compares href (`(o.href ?? '') !== (n.href ?? '')`) and rows per the rule above. Also P4 here (§4). Document the exclusion table in propDelta's doc comment, pointing at `test/completeness.test.ts`. |
| `src/core/snapshot/render.ts` | extract `renderRows`; `renderOp` update case appends `href=…` bit and the `RxC:` + rows tail |
| `src/core/snapshot/engine.ts` | volatility feed for rows updates (first differing cell). **The `unchanged` branch is NOT touched** — see below. |
| `src/mcp/tools.ts` | `FORMAT_LEGEND` gains `~ eN href=/path` and `~ eN RxC:` lines; completeness sentence amended (below) |
| `bench/lib/streamModel.mjs` | update-line parser: extract `href=` token; on `RxC:` tail, consume indented row lines into `entry.rows` (same attachment rule as F1). **Must land atomically with the render change** — precedent and WHY at streamModel.mjs:157-164 (the isNoChange atomicity note). |
| `docs/design/security.md` | new finding entry — below |

### The security.md entry — ruled IN

The coordinator is right that this belongs in `security.md`. Entry to add
(match the file's existing finding format): **"A link's href could change
under a stable label with no report"** — mechanism: propDelta omitted href,
the ref stayed live and correct, the zero-op path told the agent
"unchanged"; consequence: a page (or injected script) could rotate
`Continue to checkout` to an attacker path after the agent read it, and the
agent clicks with a stale belief — a phishing primitive against the agent's
memory rather than its eyes; found by external review 2026-08-01
(`review-external-2026-08-01.md` §1, probe-verified); fixed by tier2b P0;
regression-guarded by `test/diff-blindfields.test.ts`, fidelity `blindfields`
step 2, and guard G13b.

### Interaction with the `f4cd2e2` unchanged path — ruled

With propDelta complete over the contract table, zero ops means: no semantic
change in anything the product renders, up to the four documented exclusions
(scroll offset, geometry, heading weight, page title). Therefore:

- **The `unchanged` branch stays exactly as `f4cd2e2` shipped it** — no seq,
  no epoch slot, baseline absorbed. The review doc's verdict stands: the
  branch's reasoning ("applying zero ops accumulates zero error") was wrong
  only because its precondition was false. P0 makes the precondition true.
  Do not revert; do not add a "heal anyway" timer — that would be paying the
  resync tax to compensate for a completeness bug we no longer have.
- **The baseline absorption (`st.last = {...}`) becomes safe** for the same
  reason: everything it can absorb is either reported (then this branch is
  not taken) or excluded-by-ruling (then absorbing it is the design).
- **The completeness sentence becomes true with one honest clause.** Amend in
  `browser_act`'s description (tools.ts): "A diff is complete: anything it
  does not mention is unchanged. (Scroll positions and pixel layout are not
  tracked; everything rendered — text, values, labels, states, links, table
  content — is.)" WHY the clause: the unqualified sentence was this bug's
  amplifier; the qualified one is exactly what the engine now guarantees, and
  it is short enough not to dilute the license the sentence exists to grant.

### Acceptance (P0)

1. **Promote the review probe** to permanent `test/diff-blindfields.test.ts`
   with provenance header: *"Origin: external-review probe, 2026-08-01
   (docs/design/review-external-2026-08-01.md §1). These four cases executed
   against f4cd2e2 with inverted expectations: rows-change and href-change
   produced ZERO ops. They are the regression tests for that bug."* Cases,
   with post-fix expectations: (a) flattened table, all cells changed → one
   update op carrying `rows`; (b) href changed under stable key/label → one
   update op carrying `href`; (c) baseline-replacement unreportability →
   now unreachable: first diff is non-empty; add the complementary assertion
   that two IDENTICAL trees still produce zero ops; (d) control: text change
   still reported.
2. Renderer round-trip: update-with-rows renders head + rows; extended
   `streamModel` reader parses it back to the same rows; same for `href=`.
3. `test/completeness.test.ts` (F5) green — and verified to FAIL when either
   new propDelta comparison is commented out (mutation check, run once
   manually, noted in the PR).
4. Volatility: a rows update on a key `isVolatile` returns true for →
   `suppressed` increments, no op emitted (unit, diff.ts level).
5. Fidelity `blindfields`: RED recorded against the pre-fix build (F4),
   GREEN after. All six scenarios GREEN. Guards G1–G13 green.
6. `npx tsc --noEmit`, `npx vitest run`, `npx electron-vite build` clean.

---

## 2. P1 — the two dead guards: one wired, one deleted

### `isPositionalKey` — WIRE IT. Escalate positional-class removals to a parent replace.

**The wiring decision.** In `diff.ts`'s `walk()`, beside the existing
match-ratio replace check (diff.ts:155-174), add a third escalation
condition: **positional renumbering**. Detection: let
`positionalBase(key) = key.replace(/\|#\d+$/, '')`. The old children contain
a *positional family* when ≥2 of them share a `positionalBase` and at least
one member's key `isPositionalKey(...)` (the first occurrence keeps the bare
key — walker.ts:354-359 — so the family is "the bare key plus its `|#N`
suffixed siblings"). If any member of a positional family is REMOVED (its key
is absent from the new children and from `newByKey`) while other members
survive, every surviving member's ordinal has silently renumbered: emit one
`replace` of the container (`op: 'replace'`, subtree `n`, `gone` via
`buryUnder`) instead of per-child ops, exactly as the match-ratio branch
does, and return.

WHY this wiring and not a rendered "fragile" marker: the wave measured the
failure live — 6 wrong-element clicks in `queue-positional`, every one a
stale ordinal after a removal (review doc §3). A marker tells the model to
distrust a ref while giving it nothing to re-resolve with; a container
restatement hands it fresh label→ref lines in the same observation, using an
op the shadow reader and the model already understand
(streamModel.mjs:75-79). No new vocabulary. Cost is bounded by the family's
container size (queue: 8 lines), paid only on the removal-from-a-family
event, which is precisely the event that invalidates the ordinals. The
re-dump arm's 3 wrong clicks in the same task show restatement doesn't cure
model miscounting entirely — the fix targets the diff-arm-specific increment
(6→~3), not the task's intrinsic difficulty.

WHY not "positional field on the node": the promised-but-absent
`node.positional` (walker.ts:320) is not needed by this design — the diff
side recomputes positionality from the key shape, which is already the
contract `isPositionalKey` tests. The stale comment at walker.ts:308-322 is
rewritten to describe the actual mechanism (diff-side escalation).

**Tests.** The misleading test at `test/security.test.ts:203`
("marks positional keys so the diff engine knows they are fragile") is
REPLACED by two:
1. The regex unit test survives under an honest name:
   "recognises ordinal-suffixed keys".
2. A behavior test: seven children sharing an S-tier base (bare + `|#1..#6`),
   remove the third → `diffSnapshots` emits exactly one `replace` op on the
   parent whose `gone` list covers the dead refs; no bare `remove`/`move` ops
   for family members. And the negative: removing a NON-family child among
   distinct-keyed siblings still produces an ordinary `remove` (no
   escalation).

This changes diff byte output for positional-family removals (cohort note,
§5). It also changes `queue-positional`'s wire pattern — the fixture comment
at bench/fixtures/queue.html:56-59 ("the diff after a removal carries … the
refs of the LAST row dying") becomes stale; update that comment in the same
change set. Any post-P1 wave re-run is a new cohort anyway (§5).

### `fuzzyRescue` — DELETE IT.

WHY, three independent reasons, any one sufficient:
1. Its doc comment promises "anything below [threshold] fails with a
   micro-snapshot instead of acting" — the act path already fails loudly
   today (that IS the shipped behavior); the function is a guessing fallback
   that was never trusted enough to wire, and the product's controlling
   failure class is wrong-element actions. A 0.62-threshold guess is a
   wrong-element action generator with a confidence knob.
2. Its scoring provably cannot serve the case that motivates rescue:
   token-Jaccard names Follow→Following 0.0 (probe-verified, review doc §5),
   so a label morph scores 0.45·0 + 0.2 + 0.2 + 0.15·geom < 0.62 even with
   perfect geometry. The genuine label-morph problem is P2's, with a metric
   chosen for it.
3. Dead-but-tested exports are how this review found us: code that reads as
   active protection and is not.

Delete `fuzzyRescue`, `RESCUE_THRESHOLD`, `eqIdent`, `geomProximity`
(registry.ts:137-173, 198-206 — sole consumers), and the
`describe('fuzzyRescue')` block (`test/snapshot.test.ts:184-204`). A test
asserting a deleted function's behavior does not survive.

**`nameSimilarity` stays, with a dated tenure.** It keeps one prospective
consumer (P2's product-side metric incorporates it) and its tests. Annotate
at the definition: *"Sole intended consumer is tier2b P2 reconciliation. If
P2's measurement (churn.mjs) rules the fix unwarranted, delete this and its
tests in the same decision — do not leave a second tested orphan."* The P2
decision record (§3) closes this either way.

---

## 3. P2 — S-tier reconciliation, measurement-gated

### (a) Measure first — `bench/churn.mjs`, wire-level

New probe, same shape as fidelity (MCP client against :8817, fixtures on
:8899). It drives: the six fidelity scenarios' step lists plus the five
size-tier fixtures' scripted mutations, captures every diff observation, and
counts **churn pairs**: a `- eX removed (was: role "A")` and a `+ … role "B"`
line in the SAME diff, equal role, `labelAffinity(A,B) ≥ 0.45`, labels
unequal. Reports: churn pairs per 100 ops, and every pair listed with its
affinity. `labelAffinity` lives in `bench/lib/streamModel.mjs` (plain JS —
bench scripts cannot import TS; the one-copy rule is served by putting it in
the shared lib, and the eventual TS twin is bound to it by a shared vector
table, below).

Detector validation: the `Follow`→`Following` button in `roster.html` (F4)
must be reported as exactly one churn pair when `blindfields`' step list is
replayed. A detector that has never detected is the F4 lesson again.

**Decision rule, recorded in advance:** implement the reconciliation IFF
churn pairs exceed **1% of all ops** across the sweep, OR any churn pair has
an interactive role (button, link, checkbox, tab, menuitem) outside the
planted validation case. WHY the second clause: interactive churn is the
harmful kind (a held ref dies mid-plan); text churn is cosmetic. If neither
trips: record the numbers in a tier2b addendum, delete `nameSimilarity` per
§2, close P2 as measured-and-declined. No third outcome.

Honest scope statement, in the file header: the sweep measures fixture-class
pages (the size tiers are anchored to GitHub/HN reproductions). It does not
measure the long tail of the web; the decision rule accepts that, because the
alternative — shipping a speculative matcher with a known false-merge risk on
no evidence at all — is worse.

### (b) The metric, if it proceeds

```
labelAffinity(a, b) = max( tokenJaccard(a, b), normPrefix(a, b) )
normPrefix(a, b)    = lcp(fold(a), fold(b)) / max(len(fold(a)), len(fold(b)))
```

`fold` = lowercase + whitespace collapse. Threshold **0.45**. Required test
vectors (shared JSON table, e.g. `bench/lib/affinity-vectors.json`, asserted
by BOTH the vitest suite against the TS implementation and a churn.mjs
self-check against the JS one — that is the drift guard between the twins):

| a | b | affinity | pairs? |
|---|---|---|---|
| Follow | Following | 0.67 (prefix) | YES — the case Jaccard scored 0 |
| Add to cart | Added to cart | 0.50 (tokens) | YES |
| Save | Delete | 0 | no |
| Item 1 | Item 2 | 0.83 (prefix) | metric says yes — excluded by bucket rule below, and the vector documents WHY the bucket rule exists |

### (c) The reconciliation, if it proceeds — and its bounds

Second pass in `diffSnapshots`, after `reconcileChildren`, over leftovers
only:

- Bucket unmatched-old and unmatched-new nodes by `(role, anchor, path)`
  parsed from their S-tier keys (T/N/I-tier keys never enter — those tiers
  don't carry the name, so they never churn this way).
- A bucket reconciles ONLY when it holds exactly one old and exactly one new
  node (uniqueness rule), both keys non-positional, and
  `labelAffinity ≥ 0.45`. Ambiguous buckets fall through to today's
  remove+add — **never guess between candidates**.
- On reconcile: `registry.rekey(ref, newKey)` (new method: move the `byKey`
  entry so the page-side act index and future walks agree — without this the
  kept ref resolves to a dead key and every act on it fails), then emit one
  `~` update with the name delta (and any other propDelta fields).
- Bound on the worst case: a false merge yields one wrong name-update on a
  ref that now targets the bucket's single survivor — strictly narrower than
  today's outcome (ref dies + phantom-risk add), because uniqueness
  guarantees the survivor is the only same-role element at that semantic
  position. Stated, accepted.

Acceptance: the Follow/Following unit pair produces one `update` and zero
remove/add; the `Item 1`/`Item 2` construction (both present both sides)
produces NO reconciliation (keys match normally); an ambiguous two-old/one-new
bucket falls through to remove+add. `blindfields` stays green across the
change (F4 asserts content delivery, not op shape — by design).

---

## 4. P3 / P4 — small, mechanical

**P3 — doc counts, made unable to go stale.** Edit `README.md:478` to
`npm test         # full suite — snapshot engine, security, vault, bench readers`
and `docs/HANDOFF.md:5` to "The full test suite passes." (no numbers). Then
the guard: `test/docs.test.ts` reads both files and FAILS on
`/\b\d+\s+tests?\b/`. WHY a guard and not a correction: 187 and 283 were both
corrections once. The number is available from `vitest` output to anyone who
wants it; a hardcoded copy has been stale twice and flattering never — remove
the class, not the instance. (37 in README:311 refers to a subsystem's tests
in prose; the regex as written would catch it — rewrite that sentence to
"a dedicated envelope suite" in the same edit. The guard is allowed to force
prose to be durable.)

**P4 — `keysOf`.** `diff.ts:384-388`: return the `Set` directly
(`keysOf(n): Set<string>` — `collectKeys` into it, no spread). Both call
sites (`buryUnder` diff.ts:90, removal loop diff.ts:279) are `for…of` and
work unchanged. Rides with Set B (same file). Cosmetic, per the review
ruling; no test beyond compilation.

---

## 5. Ordering, atomicity, cohort impact

**Wave-2 preservation comes first and touches nothing contested.**
`bench/task/results/` is gitignored by design (measurements aren't source).
After the wave completes: copy `episodes.jsonl` + `episodes.cohort.json` to a
timestamped archive alongside the existing
`episodes.20260801T160431Z.*` pair; write the wave-2 outcome (per-task
success/wrong/nochange, the queue-positional analysis, cost) into
`bench/RESULTS.md` citing `buildVersion afc408d7b0895342` and
`suiteVersion 2026-08-02.1`; tag the repo `wave2-scored` at the commit the
wave ran on. That triple (RESULTS.md section + tag + archived jsonl) is the
citable artifact regardless of everything below.

**Set A — the instrument (bench + tests only, NO src, NO rebuild):**
F1–F7, P3, churn.mjs authoring. Everything here can be AUTHORED during the
wave (no watched files, no ports); nothing here may be RUN until the wave
frees :8817/:8899. Set A lands first and runs against the current build to
record the blindfields RED (F4's evidence requirement). Parallelism flag: this
is the "no rebuild" work the coordinator asked for.

**Set B — the engine (one rebuild):** P0 + P4 + the streamModel update-line
parser additions. The renderer change and its reader change are ATOMIC
(streamModel.mjs:157-164 precedent). Lands second; flips blindfields RED →
GREEN.

**Set C — P1** (positional replace escalation + fuzzyRescue deletion + test
replacement + queue.html comment update). Src change; **land in the same
build as Set B** — two diff-stream byte changes should cost one cohort bump,
not two. Separate commits, one rebuild.

**P2:** churn.mjs RUN after B/C (needs the app; any build). Decision recorded
in an addendum to this file either way; implementation (if triggered) is its
own small set afterward.

**Byte output / cohorts — stated plainly:** Set B/C changes diff bytes (new
`~` variants, replace escalation) while leaving full snapshots byte-identical
for pages without the new features. Irrelevant nuance in practice: ANY src
change forces a rebuild, `buildVersion` hashes `out/main/index.js`, and the
task store pools nothing across buildVersions — so the first post-landing
benchmark run REQUIRES `--new-cohort`. Wave 2's result is already preserved
above and is comparable to future waves only as a separate cohort, which is
the honest comparison anyway (different engine).

Suggested landing order, explicit: `wave2 archive` → `Set A` (record RED) →
`Set B+C` (one rebuild; fidelity all-six GREEN, guards G1–G13 green) →
`churn.mjs run` → `P2 decision addendum` → (conditional) `P2 implementation`.

---

## 6. What this fix set does NOT address

Stated so nobody mistakes silence for coverage:

1. **LLM application of a faithful stream.** Fidelity proves the information
   arrives; wave-style task benches own whether a model uses it. The
   queue-positional intrinsic difficulty (re-dump arm also made 3 wrong
   clicks) is model behavior, not stream defect — P1 narrows the diff-arm
   increment only.
2. **One-column table wire ambiguity.** A 1-col table's rows render
   identically to bare text lines (`renderLine`'s pipe-join has nothing to
   join). The F1 reader disambiguates by indentation under a table line, but
   the wire itself stays ambiguous to a naive reader. Real 1-col data tables
   are rare; not worth a format change now. Documented here, revisit if a
   fixture ever hits it.
3. **Title-only and scroll-only changes stay unreported** — by the §1
   exclusion rulings, now documented and contract-tested rather than
   accidental. If a real failure class emerges (an agent needing tab-title
   state), it re-enters through the F5 ruling table, which is the point of
   having one.
4. **Fidelity still cannot distinguish same-labeled refs.** The comparison is
   label-keyed; two identical "Approve" buttons that swapped refs would pass
   it. Ordinal-identity correctness is carried by the P1 unit tests and the
   task bench's wrong-element metric, not by fidelity. Structural limit,
   acknowledged.
5. **`optionSetTurnedOver` stays bespoke.** It predates this work, covers its
   class (including same-count enumeration turnover), and folding it into
   propDelta would change working wire behavior for no defect. The F5 table
   records it as `structural`.
6. **`attachFiles` still targets the first file input**
   (engine.ts:570-575) — pre-existing, flagged in its own comment, unrelated.
7. **The same-walker ground-truth caveat** (fidelity.mjs:20-27) remains: a
   walker that mis-reads the DOM fools both sides of every comparison. The
   independent checks (typed values, state flips, and now F4's content
   literals) pierce it pointwise, not universally. That is inherent to
   self-hosted ground truth; the alternative (a second, independent walker)
   is a project, not a fix.
