# Tier 4 — the cohort-severing bundle: the prepend/rebinding fix + the wave-3 harness repairs

Status: SPEC, decision-complete. Written 2026-08-02 against `master` at
`f37a5db` (tree clean; tags `wave2-scored`, `wave3-scored`, `sweep-scored` all
present; wave-3 archives and the RESULTS.md wave-3 section verified on disk).
Companions: `wave3-evaluation.md` (§0.1, §0.2 and §1.4 are implemented here
verbatim; §6 step 3 is this bundle), `tier3.md` (§3.1 recorded the engine hole
this bundle closes; §8 probe 2 is its first evidence), `headtohead.md` (the
suite that runs NEXT, on the build this bundle produces — §7 below amends it
by appendix). Two builders execute verbatim: **Builder A owns `bench/**` +
tests-of-bench and never touches `src/**`; Builder B owns `src/**` +
tests-of-src and never touches `bench/**`.**

**Why one bundle, restated as the governing constraint.** Every item below
touches the watched set — `src/core/snapshot/**` (WATCH_DIRS) or
`bench/task.mjs` / `bench/lib/proxy.mjs` / `bench/lib/streamModel.mjs`
(WATCH_FILES, `bench/lib/store.mjs:63-78`) — so landing any of it moves
`codeVersion`, and the rebuild moves `buildVersion`. That severs every
existing store, which is the integrity design working (wave3-evaluation §1.3).
Severance is paid ONCE: all items land as ONE change set, verified by ONE
battery, followed by ONE rebuild. Any sequencing that rebuilds between two
item landings, or lands an item after the head-to-head's H0 has pinned a
build, is wrong by construction. The single exception is §5 (`bench/size.mjs`
is outside the watched set and may trail — its own section says under what
rule). This is the LAST engine change before the head-to-head
(wave3-evaluation §6 step 4): after the battery goes green, the next scored
work is `headtohead.md` phase 0 on this build, and nothing in the watched set
moves again until the h2h cohort is complete.

**Pre-landing evidence runs come first.** Three recordings are made against
the CURRENT build (`out/` as it exists at `f37a5db`) before either builder
lands: the G15 RED (§1.6), the diff-rebinding unit RED (§1.5), and the G2
selftest byte-capture (§1.7). An instrument that has never seen the defect it
guards is the false green all over again — the F4 lesson, third application.

---

## 1. Item 1 — P2: a positional family that GAINS a member escalates to `replace`

### 1.1 The defect, verified by probe at THIS head

Re-verified 2026-08-02 by throwaway vitest against `src/core/snapshot/diff.ts`
at `f37a5db` (probe deleted, tree clean; construction mirrored tier3 §8
probe 2 — a `list` parent whose `listitem` children carry the S-tier keys
`S|0|listitem||list:tickets|list`, bare + `|#1…`, exactly what
`disambiguate` produces for content-identical rows):

- **Prepend into a 6-row positional family** (new tree: same six key STRINGS
  plus `|#6`) → exactly ONE op:

  ```
  [{ "op": "add", "after": "e7", "subtreeKey": "…|#6" }]

  page #1.1 (diff from #1.0)
  + after e7:
    listitem
  ```

  Not merely silent — **actively wrong-ended**: `e7` is the LAST row's ref,
  so the wire tells the model a row was appended at the BOTTOM while the page
  prepended at the TOP. Every held ref rebinds one row down (the page-side
  index re-binds each key to its new document-order occurrence), no diff line
  says so, and the one line that is emitted points the model's attention at
  the wrong end of the list.

- **1 → 2 growth** (a single bare-keyed element gains an identical twin
  above it) → one `add`; the bare key silently rebinds to the NEW element.
  So the hole is not confined to pre-existing families: a family is BORN
  around a held ref and the ref changes owner in the same instant.

- **Removal from a 7-row family** → one `replace` with a `gone` list — P1
  behaving exactly as landed. The asymmetry is the finding: the engine
  already owns the concept "this family's ordinals are invalid, restate it";
  it just only reaches for it on membership LOSS.

Why P1 cannot see it (code fact, `diff.ts:230-255`):
`positionalFamilyLostAMember` asks whether an OLD family key is absent from
the new tree. On insertion no old key is absent — the surviving keys are the
same strings bound to different rows — and the key SET `{bare, #1…#6}` is
identical for a prepend and for an append, so no key-set predicate can
distinguish the harmful case from the harmless one (tier3 §3.1's probe
finding, unchanged).

### 1.2 The candidates, ruled on

- **Extend the P1 escalation to any positional-family membership change
  (insertion as well as removal) → one `replace` of the container** —
  **CHOSEN.** It reuses the exact op, rendering, and reader vocabulary P1
  already proved live in wave 3 (110-vs-64 stale-ref acts, the §3 mechanism
  finding: under re-keying, explicit retirement/restatement beats silence).
  It is symmetric with the wave-3-vindicated design, costs nothing on pages
  without positional families, and needs zero wire or reader changes.
- **Content-anchored positional keys (detect displacement by content)** —
  REJECTED on the premise: positional families only exist where siblings are
  content-identical to the walker (identical role, name, no sibling
  discriminator — `walker.ts:342-368`). There is no content to anchor on;
  that is what "positional" means. Any content strong enough to split the
  family would already have split it via `identityKey`/`siblingDiscriminator`.
- **Walker-side rebinding detection (compare key→element bindings across
  walks)** — REJECTED, and this deliberately overrules tier3 §3.1's aside
  that the hole "needs walker-side rebinding detection." The preload does
  keep the previous walk's `key → HTMLElement` index (`page.ts:27,186-193`),
  so the comparison is implementable — but it is WRONG on the exact fixture
  class under test: `replaceChildren` re-renders create all-new DOM nodes for
  every row on every act, so object-identity comparison flags every key of
  every family as rebound on every mutation, and the escalation would fire on
  every act — degenerating the diff arm into a re-dump arm (G4/G7 would trip,
  and the wave-3 fixtures' streams would change wholesale). For rows that are
  content-identical, "the same row" IS a positional claim; DOM node identity
  is noise, not signal. The key set plus its size is the entire recoverable
  truth, and §1.4 states what remains unrecoverable.
- **Defer past the head-to-head** — REJECTED: wave3-evaluation §6.4 already
  ruled measuring a build scheduled for replacement is the exact waste
  wave2-evaluation §7 declined; real-shaped pages insert rows.

### 1.3 The change — exact (Builder B, `src/core/snapshot/diff.ts` + `walker.ts` comments)

Add, beside `positionalFamilyLostAMember` and with a mirrored doc comment:

```ts
/**
 * Did an insertion renumber the ordinals of surviving siblings?
 *
 * The mirror of `positionalFamilyLostAMember`, and the close of tier3 §3.1's
 * open hole: prepending an identical row into a positional family used to
 * emit ONE `add` op (claiming insertion at the END — the ordinal suffix is
 * always the highest) while every held ref silently rebound one row down.
 * The key SET cannot distinguish prepend from append, so this fires on ANY
 * genuine growth of a positional family: the append false-positive costs one
 * bounded restatement of a family that is by construction small-N identical
 * rows, and the prepend false-negative cost an agent acting on the wrong row
 * with no diff line saying so (docs/design/tier4.md §1).
 *
 * A positional family here is judged on the NEW side (≥2 new children
 * sharing a `positionalBase`, at least one ordinal-suffixed — which growth
 * guarantees). It gained a member when some member key is absent from the
 * whole OLD tree (a key that existed elsewhere moved, it was not born) while
 * at least one member key was already among this parent's old children — a
 * survivor whose binding the insertion may have shifted.
 */
function positionalFamilyGainedAMember(
  oldKids: SnapshotNode[],
  newKids: SnapshotNode[],
): boolean {
  const oldKidKeys = new Set(oldKids.map((c) => c.key));
  const families = new Map<string, string[]>();
  for (const c of newKids) {
    const base = positionalBase(c.key);
    const fam = families.get(base);
    if (fam) fam.push(c.key);
    else families.set(base, [c.key]);
  }
  for (const [, keys] of families) {
    if (keys.length < 2) continue;
    if (!keys.some(isPositionalKey)) continue;
    let added = false;
    let survived = false;
    for (const key of keys) {
      if (oldKidKeys.has(key)) survived = true;
      else if (!oldByKey.has(key)) added = true;
    }
    if (added && survived) return true;
  }
  return false;
}
```

Call site — the existing third-escalation block in `walk()`
(`diff.ts:205-215`) becomes:

```ts
if (
  positionalFamilyLostAMember(oldKids, newKids) ||
  positionalFamilyGainedAMember(oldKids, newKids)
) {
  // …existing replace body, byte-identical…
}
```

Constraints on the implementation, each checkable by inspection:

1. **`positionalFamilyLostAMember` is not edited.** Not one byte. The
   removal path's behavior is pinned by §1.5's stability tests and §1.7's
   live byte-capture.
2. **No new wire vocabulary.** The escalation emits the existing `replace`
   op through the existing `renderDiff` path — `! eN replaced:` (the `gone`
   suffix is empty on pure growth, and `buryUnder` naturally produces `[]`
   because every old key survives; `render.ts:438-440` already renders that
   as no suffix, and `streamModel.mjs:167-170` already parses it). If Builder
   B finds themself touching `render.ts`, `types.ts`, or any reader, STOP —
   that is a spec violation, not an implementation detail.
3. **Synthetic safety.** The file's stated invariant — every `ensureRef` call
   site is synthetic-safe — holds by the same argument as P1: a node with ≥2
   children under family analysis cannot be a manufactured option node. Add
   P2 to the invariant comment's list rather than weakening it.
4. **`oldByKey` is the existing closure index** (`diff.ts:70`); no second
   index is built.
5. **Comment repairs ride along (Builder B):** the `disambiguate` comment
   block (`walker.ts:308-331`, "The renumbering half IS handled … escalates a
   removal from a positional family") and P1's own comment (`diff.ts:189-204`)
   now say **membership change (removal or insertion)** and cite this spec.
   The queue.html wire comment (Builder A's file) is already post-P1-correct
   and mentions only removals, which remains true for that fixture — no edit.

### 1.4 Economics and the stated residuals

- **Cost is bounded by family size, and positional families are small by
  construction.** The escalation can only fire where siblings are
  content-identical to the walker; anything with a distinct name, testid, id,
  or sibling discriminator is outside the family. A feed prepending
  distinctly-titled items pays one `add`, exactly as today. A queue of
  identical rows pays one restatement of that queue — which wave 3 measured
  as the CHEAPER failure mode (the re-dump arm's implicit restatement, minus
  its full-page cost).
- **Append is restated too, and that is accepted, not accidental**: the key
  set cannot distinguish prepend from append (§1.1), so the choice is a
  bounded false-positive on appends or a silent rebinding on prepends. A
  page that appends one identical row per act pays one family restatement
  per act; the `DIFF_SIZE_RATIO`/`MAX_DIFFS_PER_EPOCH` ladder
  (`engine.ts:300-322`) still caps the pathological end at a full resync.
- **Residual 1 — equal-size same-walk churn is undetectable, in principle.**
  Remove one identical row and insert another between two observations and
  the key set, the family size, and every per-key property are unchanged;
  there is no signal at any layer this engine owns (§1.2's walker-side
  ruling covers why DOM identity cannot supply one). Stated, owned, and
  bounded: it requires two opposing mutations inside one settle window on a
  family of indistinguishable rows. No current fixture, home or neutral, can
  produce it.
- **Residual 2 — a member MOVED IN from elsewhere in the old tree** (its key
  already existed, so `added` stays false) does not fire P2. Same-base keys
  in two parents require the same role, name, anchor AND ancestry path
  (`identityKey`, `walker.ts:375-398`), i.e. a cross-parent identical family
  — the T2 twin-queues construction deliberately prevents exactly this, and
  the walk-global ordinal space means such a page is already outside the
  solver's validity envelope (`task.mjs` `nth` constraint). Excluded, stated.

### 1.5 The permanent unit tests, with provenance (Builder B)

New file `test/diff-rebinding.test.ts`, constructed-node style
(`test/diff-blindfields.test.ts` is the pattern). Header provenance is
mandatory: origin tier3.md §8 probe 2 (2026-08-02, the no-insert-task
ruling's evidence), re-verified at `f37a5db` for this spec (§1.1), promoted
to permanent regression by wave3-evaluation §6 step 3.

| # | case | expected |
|---|---|---|
| 1 | prepend into 6-row identical family (old `bare,#1..#5`; new `bare,#1..#6`) | exactly one op, `op === 'replace'`, subtree carries all 7 rows; `gone` empty or absent |
| 2 | append (same trees as 1 — the point: indistinguishable) | same `replace` (the documented conservative cost) |
| 3 | 1 → 2 growth (`bare` → `bare,#1`) | one `replace` (the born-family rebinding, §1.1) |
| 4 | 0 → 2 birth (no old member) | plain `add` ops — no survivor, nothing held, no escalation |
| 5 | growth of family A does not escalate untouched sibling family B (two named sections) | replace scoped to A's container only |
| 6 | non-positional add (distinct names, no `\|#` keys) | plain `add`, no escalation |
| 7 | **removal 7 → 6** (tier3 §8 probe 2's second half) | `ops` DEEP-EQUAL to the recorded P1 baseline: one `replace` with the exact `gone` list, and `renderDiff` output byte-equal to the recorded wire |
| 8 | removals-only sequence of two successive removals | P1 fires each time; no P2 contribution (assert via op count/shape) |

**Ordering, which is the evidence:**

- Cases 1–3 are the RED-first set: Builder B authors and runs them against
  UNEDITED `diff.ts` first; they must fail with `op === 'add'` (case 1 must
  show the `after: <last-row-ref>` wrong-end detail in the failure output).
  The RED run's output goes in the landing commit message (the G14/tier3
  precedent for unit-level guards).
- Cases 7–8 are the GREEN-stable set: authored and run against UNEDITED
  `diff.ts` FIRST, where they must PASS — proving the expectations encode
  the pre-fix removal behavior — and must still pass after the edit,
  proving the fix cannot change removal behavior at the op/byte level. Both
  runs are named in the commit message.

### 1.6 G15 — the live guard, RED-first (Builder A)

**Fixture `test/fixtures/prepend.html`** — built to queue.html's conventions
(the proven positional-family construction; copy them, do not re-derive):
content-identical rows, no `<a>`/`<h1>`–`<h4>` inside rows, no ids/testids on
rows or their buttons, the divider-span-on-every-3rd-CURRENT-index rule to
stay under COLLAPSE_RUN, `replaceChildren` re-render. Specifics:

- `<h1>Dispatch queue</h1>`; `<p data-status>5 tickets waiting</p>`
  (addressed by attribute, queue.html's unread-route lesson);
  `<ul aria-label="Tickets">` of **5** rows, each
  `<li><span>Ticket</span><button>Take</button></li>` (plus the divider span
  per the index rule). Internal row ids `r1..r5` live in a JS array only —
  never in a DOM attribute.
- `<button id="add-urgent">Add urgent ticket</button>` OUTSIDE the list
  (distinct label + non-generated id → distinct key, outside the family).
  Click: `state.unshift({id:'u'+(++n)})`, full `replaceChildren` re-render,
  status text updated — the SPA prepend, all-new nodes.
- `<div id="log"></div>`; clicking any Take button appends
  `<p>took: <rowId></p>` resolved by the li's CURRENT index into the state
  array (delegated listener on the `<ul>`). Taking does NOT mutate the list
  — the log is the page's own record of which row was actually hit, the
  fixture's whole reason to exist.
- Header comment: states the construction, cites this section, and notes the
  fixture is insert-mutating BY DESIGN and therefore must never be imported
  by `bench/tasks.mjs` (the `nth` solver constraint stands).

**Guard G15** (`bench/guards.mjs`, after G14, own model map per the G13/G14
block pattern): navigate with cache-buster, settle, full snapshot into a
local model; require exactly 5 `Take` buttons in the model; record
`heldRef` = the FIRST `button eN "Take"` in the snapshot TEXT (document
order on the wire, not Map order). Click `Add urgent ticket`; `reply` is the
returned observation. Then:

- **G15a — the escalation fired**: `/^! e\d+ replaced/m.test(reply)` AND the
  replace block contains ≥ 6 `button eN "Take"` lines (the family restated
  whole). FAIL detail prints the reply's op lines verbatim (G13's style).
- **G15b — the restatement is truthful**: parse the FIRST `button (e\d+)
  "Take"` ref out of the replace block, click it, take a follow-up full
  snapshot, and assert it contains `took: u1` — the top line of the restated
  wire really is the prepended row, so a model that re-reads the restatement
  re-derives every ordinal correctly. (Runs only if G15a found a replace
  block; otherwise recorded FAIL alongside G15a.)

**RED record — `docs/design/g15-red-record.md`, authored BEFORE Builder B
lands, against the `out/` bundle at `f37a5db`** (the g14-red-record.md
template: build provenance table with `out/` hashes and mtimes, exact
commands, verbatim output, "what this proves / what is not claimed"). The
RED run must additionally record the hazard demonstration the green guard
cannot show: after the pre-fix `+ after eN:` reply, click `heldRef` (the ref
read as row 1's button before the prepend) and show the log line reads
`took: u1` — the held ref landed on the prepended row, retargeted in
complete silence. That page-evidenced retarget plus the wrong-end `add` line
is the defect, in the page's own words.

### 1.7 G2 / streamAssert byte-identity on the wave-3 fixtures (both builders' obligation, Builder A executes)

The wave-3 fixtures are removals-only by construction (queue.html's header;
tier3 §3.1.2), so P2 must be unreachable on them and their wire behavior
must not move. Verified three ways, cheapest first:

1. **Unit level:** §1.5 cases 7–8 (op/byte deep-equality on removals).
2. **Live level, pre-captured:** before either builder lands, Builder A runs
   `npm run bench:task -- --selftest` on the current build and records the
   G2 notes table (per task × arm: `obs F/D/N` counts and `obsChars`) for
   all five wave-3 tasks into the g15-red-record.md appendix. After the
   bundle lands and rebuilds, the same command must reproduce those numbers
   EXACTLY (the queue-class fixtures carry no timers, so volatility is inert
   and the scripted streams are deterministic). Any drift is a stop-ship
   finding to be diagnosed before the battery proceeds.
3. **Assert level:** the existing streamAsserts (`destructiveRefs(first)
   .size >= 2`, T2's interview/deliveries scoping, T4's `a:full` resync
   crossing) run unmodified inside `--selftest` and must pass unmodified.

---

## 2. Item 2 — the G3 error kind (wave3-evaluation §1.4, implemented exactly)

All Builder A. The ruling is already made; this section is the file-level
mechanics and nothing here may drift from §1.4's text.

1. **`bench/lib/streamModel.mjs`** gains the one-definition classifier the
   proxy and the tests share:

   ```js
   /** A dispatch-free engine validation reply: page-byte-free by
    *  construction (every page-embedding reply is multi-line with an
    *  untrusted(...) envelope; single-line is the tools.ts validation
    *  vocabulary — wave3-evaluation §1.2/§1.4). */
   export const isBareError = (text) =>
     text.startsWith('error: ') && !text.includes('\n');

   /** THE observation taxonomy, in precedence order. Page-shaped bytes win:
    *  a reply that contains a FULL SNAPSHOT or diff header classifies as
    *  that, whatever its first line says — neither arm-purity route ever
    *  excuses a reply carrying page-shaped bytes. */
   export function classifyObservation(text) {
     if (isFullSnapshot(text)) return 'full';
     if (isDiff(text)) return 'diff';
     if (isNoChange(text)) return 'nochange';
     if (isBareError(text)) return 'error';
     return 'other';
   }
   ```

2. **`bench/lib/proxy.mjs`** `recordObservation` (284-305) replaces its
   inline ternary with `classifyObservation(text)`. Nothing else in the
   function moves; the text is still kept whole; `lastFullAt` still updates
   on `full` only. (The `ep.done` / step-budget refusals still return before
   `recordObservation` — proxy.mjs:311-315 — so the new kind concerns
   upstream replies only, as §1.4 notes.)
3. **`bench/task.mjs`**:
   - the `kinds` tally (`runEpisode`, line 729) gains `error: 0`; the
     per-episode progress print (line 1734) becomes
     `…N/${kinds.other}?/${kinds.error}E`.
   - **one arm-purity definition, both call sites**:

     ```js
     /** Observations that violate re-dump arm purity. Kind `error` is
      *  excluded: a single-line `error:` reply carries no page
      *  representation and both arms can receive it identically
      *  (wave3-evaluation §1.4). `other` is INCLUDED: unclassified is
      *  where a diff would hide. */
     export const redumpImpurities = (kinds) =>
       (kinds.diff ?? 0) + (kinds.nochange ?? 0) + (kinds.other ?? 0);
     ```

     The G2 pre-flight (line 997 — which today tests only `diff|nochange`
     and would miss an `other` the scored-run G3 catches) and report-G3
     (line 1900) both switch to `redumpImpurities(r.kinds) > 0`.
   - **G3's message** gains, verbatim: *"A single-line `error:` reply
     carries no page representation and both arms can receive it
     identically; it is recorded as kind `error` and does not bear on arm
     purity."*
   - **G4's denominator** (line 1952) drops `error` AND `other`:
     `dAll = full + diff + nochange`. Numerator unchanged. (Numerically
     irrelevant on any clean store; wrong on principle before — §1.4.4.)
   - `unclassified` (line 767) remains kind `other` only — `error` texts
     are classified, not odd, and stay retrievable from `observations`.
4. **Tests** (`test/benchStream.test.ts` for the classifier;
   `test/benchReport.test.ts` for `redumpImpurities` and a report-level G3
   case), exactly §1.4.5's set plus the whitelist-preservation case:
   - `"error: unsupported key: F5"` → `error`
   - `"error: e3 could not be acted on (gone).\nThe page as it stands
     now:\n…FULL SNAPSHOT #4…"` → `full`
   - `"could not read the page (walk timed out)"` → `other` (unchanged; the
     G6b quarantine route still owns that class)
   - `"error: something\nsecond line"` (multi-line, no shape) → `other` —
     still trips G3; the whitelist property is preserved exactly where it
     matters
   - `redumpImpurities({other: 1})` > 0 (the pre-flight now catches what
     only report-G3 caught before)
5. **Cross-boundary contract (seam 3, §8):** the single-line rule leans on a
   `src/mcp/tools.ts` invariant Builder B must not erode — every
   dispatch-free validation reply is one line, every page-embedding reply is
   multi-line behind `untrusted(...)` with `quote()` stripping newlines
   (tools.ts:730-737). Builder B makes no tools.ts text changes in this
   bundle; any FUTURE multi-line bare error is a breaking change to this
   classification and must arrive with a bench-side ruling.

---

## 3. Item 3 — the instance stamp (wave3-evaluation §0.1)

All Builder A; the fields already cross the wire (the `/metrics` reply
carries `app.getAppMetrics()` verbatim, and wave 3's sidecars show
per-process `creationTime` — server.ts:86-93, wave3-evaluation §0.1).

1. **`metricsStamp` (`bench/task.mjs:474-479`)** additionally extracts the
   Browser process identity, still reading only named fields (seam 2's
   tolerate-extras rule intact):

   ```js
   const browser = procs.find((p) => p?.type === 'Browser');
   return {
     gpuPid: gpu?.pid ?? null,
     procs: procs.length,
     browserPid: browser?.pid ?? null,
     browserCreated: browser?.creationTime ?? null,
     witness: json?.witness ?? null,          // §6.3; null on older builds
   };
   ```

   The poll-failed branch returns the same shape with `gpuPid:
   'poll-failed'` and nulls. The episode row inherits all of it through the
   existing `stampFields` spread (~line 1721) — no schema machinery.
2. **New exported pure classifier**, unit-testable:

   ```js
   /** Why did the GPU pid change between two consecutive episodes?
    *  - 'restart':  browser identity ALSO changed (pid or creationTime) —
    *                a new Aperture instance; expected between phases.
    *  - 'crash':    browser identity present on both rows and IDENTICAL —
    *                the GPU process relaunched inside one instance; the
    *                wedge hypothesis's signature.
    *  - 'unmeasured': either side is 'poll-failed'.
    *  - 'unknown-instance': browser identity missing on either row
    *                (pre-tier4 store). */
   export function classifyGpuTransition(a, b) { … }
   ```

3. **`printApparatusNote` (2193-2217)** classifies each transition and
   prints per-kind suffixes:
   - `[app restart — expected]  (browser pid A -> B)` for `restart`;
   - `[SAME-INSTANCE GPU RELAUNCH — crash candidate]` for `crash`;
   - `[apparatus poll failed across this boundary — unmeasured]`;
   - `[instance identity not recorded (pre-tier4 rows) — cross-check the
     aperture.<stamp>.log]`.
   The crash-hypothesis paragraph (the current "A changed GPU pid is a GPU
   process that crashed…" text) prints ONLY when ≥1 transition classifies
   `crash` or `unknown-instance`; a store whose every transition is
   `restart` gets instead: *"All GPU pid transitions coincide with a new
   Aperture instance: app restarts between phases, not crashes."* Advisory
   only, as before — no verdict effect, no exit-code effect.
4. **Tests** (`test/benchReport.test.ts`): `classifyGpuTransition` over all
   four kinds; a `report()` console-capture case with a two-instance
   synthetic store asserting the `app restart — expected` wording appears
   and the crash paragraph does NOT; the existing `metricsStamp` seam test
   extended for the new fields (and still tolerating extras). Old stores
   (wave 2/3 archives) must remain readable: every new read is
   null-tolerant, verified by the pre-tier4-rows test case.

---

## 4. Item 4 — the post-resync metric repair (wave3-evaluation §0.2)

**Ruling: the metric is RESTRICTED to the diff arm, with the restriction
printed.** The §0.2 alternative — an engine-epoch window for the re-dump arm
— is closed by an engine fact, not by preference: the arm forcing routes
every re-dump observation through `opts.full → nextFullSeq()`
(engine.ts:196-225, 68-73), so every re-dump observation OPENS an epoch and
an epoch-anchored window is exactly as arm-invariant as the observation-kind
window it would replace. There is no re-dump resync event distinct from "an
observation happened"; the concept is diff-arm-shaped, and the honest fix is
to say so in the output.

Mechanics (Builder A, `bench/task.mjs`):

1. **The proxy tag is unchanged.** `post_resync` (proxy.mjs:352-355) keeps
   its definition and keeps being stamped in BOTH arms — the recorder stays
   arm-blind; the vacuity was a reading, and readings are fixed in the
   report. `postResyncFailures` stays on the episode row (old stores stay
   comparable, field for field).
2. **The report line** (task.mjs:1983-1986) is replaced by a diff-arm-only
   block computed from the acts arrays (rates, not just counts — a count
   without its denominator is how the 65-vs-236 misreading happened):

   ```
   Resync-window fragility (diff arm ONLY — see note):
     within 2 observations of a FULL SNAPSHOT: <x>/<n> acts non-ok (<pct>)
     all other acts:                           <y>/<m> acts non-ok (<pct>)
     NOTE: the re-dump arm is excluded BY CONSTRUCTION — under the arm
     forcing every observation is a full snapshot, so every act tags
     post_resync and the count degenerates to "all non-ok acts"
     (wave3-evaluation §0.2). No cross-arm reading of this block is
     licensed.
   ```

   Computation: over discriminative-stratum diff-arm rows, partition
   `r.acts` by `tags.includes('post_resync')`; non-ok = `attribution !==
   'ok'`. Zero-denominator prints `—`.
3. **Test** (`test/benchReport.test.ts`): a synthetic store where the
   re-dump arm has acts tagged `post_resync`; assert the printed block names
   the diff arm only, contains the NOTE sentence, and prints no re-dump
   number in it.

---

## 5. Item 5 — the sweep sentence-template fix, incorporated by reference

A sibling session is adjudicating the size sweep and will specify the
sentence-template fix in **`docs/design/sweep-evaluation.md` §2 — that
section, when it lands, is the NORMATIVE text and Builder A implements it
verbatim.** This spec's contribution is the seam, so the two documents
cannot collide:

- **The seam is `bench/size.mjs`'s report-sentence assembly**: the
  `crossoverBand()` templates (~line 1464, the `band.text` strings the
  verdict block interpolates) and the `What this licenses, and nothing more`
  block (~lines 1968-1972) that quotes `band.text` into the licensed
  sentence. Nothing outside `bench/size.mjs` may be touched for this item,
  and no number, threshold, or episode-selection rule may change — sentence
  templates only. If sweep-evaluation §2 asks for more than sentence
  assembly, Builder A stops and escalates rather than improvising.
- **Sequencing rule:** `bench/size.mjs` is outside the watched set (store.mjs
  WATCH_DIRS/WATCH_FILES — verified), so this item alone cannot sever
  anything. It lands WITH the bundle if sweep-evaluation.md §2 exists by
  landing time; otherwise it is the one item permitted to TRAIL the rebuild,
  and it must land before any sweep sentence is next cited or re-printed.
  The `--selftest` template checks in size.mjs (~1583-1588) are updated in
  the same edit if the templates they pin change.

---

## 6. Item 6 — fold in or defer, each ruled

### 6.1 The `headingLevel` residual — CLOSED, nothing to build

tier3 §4.3's ruling landed and is verified at this head: the completeness
sentence admits heading weight (`src/mcp/tools.ts:558`) and
`test/completeness.test.ts:48` names it as the sole rendered-but-excluded
field with the ruling cited. No residual work exists; recorded here so its
absence from the change set reads as a decision.

### 6.2 The congruence tether's tsc-only enforcement — DEFERRED (no CI in this bundle)

`test/typecheck.test.ts` (tier3 §4.4) already makes `npm test`
self-sufficient — the guard lives where the green comes from, which was the
recurrence path Gate 2 proved. A CI workflow would re-run the same command
on a remote runner: real value (a contributor who never runs `npm test`),
zero engine relevance, and — decisive here — a `.github/workflows/` file is
outside the watched set, so bundling it buys nothing that landing it any
quiet afternoon would not. Deferred out of this bundle with no successor
milestone assigned; it does not gate the head-to-head.

### 6.3 W1 `unknown`-rate telemetry — FOLDED IN (the one live signal worth persisting)

Gate 2's `deadActs`-went-retrospective finding was repaired for `lost`
(tier3 §1.5's `engine_input_loss` is live attribution), but **`unknown` is
still invisible**: every unknown verdict falls through to `observe` and the
store cannot distinguish a healthily-witnessed run from one where the
witness silently degraded to unknown-mode (dead poll channel, navigating
fixtures) — in which W1's lost-detection is blind and a recurrence of the
wave-2 wedge could ack `ok` unseen. The head-to-head is 4–6 scored hours on
the most external-facing comparison in the programme; it should not run with
the witness's own health unmeasured. Smallest sufficient design, riding the
existing apparatus seam:

- **Builder B, `src/core/snapshot/act.ts`:** module-level
  `const WITNESS_TALLY = { landed: 0, unknown: 0, lost: 0 }` and exported
  `witnessTally()` (a copy, not the live object). Exactly ONE increment per
  `settle()` resolution, at every resolution path: recorder-mode settle,
  subframe one-shot, and the `UNKNOWN_WITNESS` constant (act.ts:207).
  Cumulative since process launch, process-global (the bench runs one tab;
  stated in the comment). No behavior change to any verdict.
- **Builder B, `src/mcp/server.ts`:** the `/metrics` reply gains
  `witness: witnessTally()`. One clause added to security.md's existing
  `/metrics` entry: the counters are event tallies, no page data.
- **Builder A, `bench/task.mjs`:** `metricsStamp` already picks the field up
  (§3.1). Report addition, after the apparatus note, when any row carries
  it: sum the FINAL row of each instance (group rows by
  `apparatus.browserCreated` — counters reset per instance) and print

  ```
  Input witness (cumulative across N instance(s)): landed L · unknown U · lost K
  ```

  plus, iff `U / (L + U + K) > 0.10`: *"ADVISORY: the input witness
  answered `unknown` for >10% of settles — W1's lost-detection was blind for
  that share (dead poll channel or navigating pages). Cross-check the child
  log before trusting the absence of input-loss errors."* Advisory only.
- **Tests:** one `test/act.test.ts` case asserting tally deltas across a
  landed and an unknown scenario on the existing fake-IPC harness (Builder
  B); a `benchReport.test.ts` console-capture case for the advisory line
  and the per-instance summation (Builder A).

---

## 7. Head-to-head compatibility — an appendix to `headtohead.md` (that file is not edited)

Binding on the h2h implementation, by wave3-evaluation §6.4's sequencing
(the h2h runs on the post-bundle build; `headtohead.md` §10 confirms it has
no stamp-sharing requirement and H0 pins whatever build it measures).

1. **Observation wire format: UNCHANGED.** The prepend fix adds no
   vocabulary — it changes only WHEN the existing `! eN replaced…` op fires
   (§1.3.2). No reader (streamModel, the h2h's planned ariaModel, any
   `mustObserve`/streamAssert) needs a change.
2. **H2b (witness parity) is unaffected.** H2b compares deduped WITNESS
   event lists — page-side capture-phase events — across engines; the
   observation channel is not an input to it. Byte-identical witness
   streams remain byte-identical.
3. **Where P2 can fire on the h2h fixture classes.** Home set: removals-only
   by construction — unreachable, and §1.7 pins the streams byte-identically.
   Neutral set: §4.2 rule 2 bans identical-sibling interactive elements, so
   button/link families cannot form; unnamed structural wrappers (e.g. `<li>`
   shells around distinct links) CAN still key positionally, so P2 would fire
   only if such a wrapper family GAINED a member mid-task — no §4.3 task's
   solve path inserts a row (mutations are form fills, panel replaces, text
   updates, and confirmations appended into non-family parents). If a
   neutral fixture nonetheless trips it, the behavior is the safe bounded
   restatement, it shows up in the H3 scripted streams BEFORE any budget,
   and it is Aperture's shipped conduct on that markup — measured, not
   patched around.
4. **H8 amendment (the one real change):** `aperture-redump` arm purity in
   the h2h reads *"nothing but FULL SNAPSHOTs (G3 whitelist, unchanged)"*.
   As of this bundle the whitelist is **{`full`, single-line `error`}** with
   `error` defined exactly as §2.1 (`isBareError`) and excluded from purity
   for the reason wave3-evaluation §1 ruled: a dispatch-free validation
   reply carries zero page bytes and both arms can receive it identically.
   Without this amendment the h2h reproduces the F5 INFRA trap on its first
   agent that presses an unsupported key. The pw arms' classification
   (§5.3 of headtohead.md) is untouched — their error replies are already
   header-only responses in their own taxonomy. The h2h proxy should import
   `classifyObservation` from `bench/lib/streamModel.mjs` for its aperture
   arms rather than re-deriving it — one definition, per this suite's
   standing rule.
5. **H0 pins this build.** The h2h cohort records the post-bundle
   `buildVersion`; nothing in the watched set moves between this bundle's
   battery and the h2h cohort's completion (§0). The `/metrics` `witness`
   field (§6.3) is available to the h2h harness if it chooses to sample
   apparatus health; nothing in headtohead.md obliges it to.

---

## 8. Partition — two builders, seams named

**Builder A — bench/harness + tests-of-bench (never touches `src/**`):**
- `bench/lib/streamModel.mjs` — `isBareError`, `classifyObservation` (§2.1)
- `bench/lib/proxy.mjs` — `recordObservation` switch (§2.2)
- `bench/task.mjs` — kinds tally + progress print, `redumpImpurities` +
  both call sites, G3 message, G4 denominator (§2.3); `metricsStamp`
  fields, `classifyGpuTransition`, `printApparatusNote` rework (§3);
  post-resync block (§4); witness summary + advisory (§6.3)
- `bench/guards.mjs` — G15 (§1.6); `test/fixtures/prepend.html`
- `bench/size.mjs` — §5, by reference to sweep-evaluation.md §2
- `bench/lib/store.mjs` — SUITE_VERSION bump (e.g. `2026-08-04.1`)
- `test/benchStream.test.ts`, `test/benchReport.test.ts` — §2.4, §3.4,
  §4.3, §6.3 tests
- `docs/design/g15-red-record.md` — §1.6 RED + §1.7 byte-capture appendix

**Builder B — src/engine + tests-of-src (never touches `bench/**`):**
- `src/core/snapshot/diff.ts` — `positionalFamilyGainedAMember` + call site
  (§1.3); invariant-comment updates
- `src/core/snapshot/walker.ts` — comment repairs only (§1.3.5)
- `src/core/snapshot/act.ts` — `WITNESS_TALLY` / `witnessTally()` (§6.3)
- `src/mcp/server.ts` — `/metrics` `witness` field (§6.3)
- `test/diff-rebinding.test.ts` (§1.5), `test/act.test.ts` tally case
- `docs/design/security.md` — one clause on the metrics entry (§6.3)

**Atomicity seams (contracts crossing the partition):**
1. **G15 ↔ the diff.ts change**: A's fixture+guard prove B's fix. A authors
   and runs G15 RED against the pre-fix build BEFORE B lands
   (g15-red-record.md); post-landing G15 must go green with the identical
   fixture, guard, and command line.
2. **`/metrics` reply shape**: B serves `{pid, uptimeS, metrics: […],
   witness: {landed, unknown, lost}}`; A reads only named fields and
   tolerates extras by construction (the existing tier3 seam 2, extended).
   Neither renames a field unilaterally.
3. **The single-line `error:` grammar**: A's `isBareError` leans on B-side
   tools.ts emitting one-line validation errors and multi-line
   page-embedding replies only (§2.5). B changes no reply text in this
   bundle; the invariant is pinned by A's classifier tests.
4. **No new wire vocabulary** (seam by absence): B's fix must reuse the
   existing `replace` op and rendering so that A ships ZERO reader changes
   for item 1. If B cannot, stop — the spec is wrong, do not improvise
   across the boundary.

**RED-first ordering, per new instrument:** G15 → RED vs pre-fix build,
recorded in g15-red-record.md, before B lands. `diff-rebinding` cases 1–3 →
RED vs pre-fix src, output in the landing commit message. Cases 7–8 →
GREEN vs pre-fix src first, still green after (both runs named in the
commit message). §2's classifier tests → the F5 case is RED vs the old
inline ternary (classifies `other`); noted in the commit message. §3/§4/§6.3
report tests are new-behavior tests, not guards — normal TDD, no RED record
owed.

---

## 9. Acceptance battery — run after both builders land, before the rebuild is trusted

| # | check | expectation |
|---|---|---|
| 1 | pre-landing recordings exist | g15-red-record.md (G15 RED + §1.7 byte-capture appendix); commit message carries the §1.5 RED/GREEN-stable runs |
| 2 | `npx tsc --noEmit` | clean |
| 3 | `npx vitest run` | green — incl. diff-rebinding (all 8), benchStream classifier set, benchReport additions (G3 predicate, apparatus wording, post-resync block, witness advisory, metricsStamp seam), act.ts tally case, and every pre-existing test untouched-and-green |
| 4 | `npx electron-vite build` | clean; ONE rebuild; `out/` hashes move (expected — severance is the design) |
| 5 | fidelity, all six scenarios | GREEN (no fidelity change in this bundle; regression only) |
| 6 | live guards G1–G15 | all PASS on the post-fix build; G15 green against the byte-identical fixture/guard that recorded RED |
| 7 | `npm run bench:task -- --selftest` | G1+G2 both arms, all five wave-3 tasks + canaries PASS; T2/T4 streamAsserts unmodified and passing |
| 8 | §1.7 byte comparison | G2 notes table (obs F/D/N + obsChars per task × arm) EXACTLY equal to the pre-landing capture for all five tasks; any drift stops the line until diagnosed |
| 9 | severance behaves | `npm run bench:task -- --plan` prints under the NEW codeVersion; the runner refuses to extend the wave-3 store (refuse-to-pool posture observed, not assumed) |
| 10 | canary sabotage | rename the canary fixture's `data-bench` → `--selftest` exits 3 INFRA; revert (the true-positive path survived the report edits) |
| 11 | apparatus plumbing | a `--selftest` run's apparatus jsonl rows carry `browserPid`/`browserCreated`/`witness`; the report prints the witness summary line |
| 12 | §5 status resolved | sweep-evaluation.md §2 implemented in size.mjs (with its `--selftest` template checks updated), OR explicitly recorded as trailing with the §5 sequencing rule quoted |
| 13 | tree + tag | working tree clean; commit tagged `tier4-landed` |

**Launch gate for the head-to-head (the last line of this bundle):** items
1–13 green → the engine is frozen for the h2h. `headtohead.md` §9 phase 0
(harness build + preflights H0–H5/H2b) may begin, with H0 pinning THIS
build's versions and §7 of this document binding the h2h implementation
(the H8 error-kind amendment and the shared `classifyObservation` import).
No watched-file edit of any kind between `tier4-landed` and the h2h
cohort's completion; anything discovered mid-h2h waits for a post-h2h
bundle, exactly as headtohead.md §10 already requires.

---

## 10. What this bundle deliberately does NOT include

- **No walker-side element-identity rebinding detection** — ruled out on
  the `replaceChildren` false-positive argument (§1.2); the key set plus
  membership is the whole recoverable truth for indistinguishable rows.
- **No detection of equal-size same-walk family churn** (§1.4 residual 1) —
  undetectable in principle at the key level; no fixture can produce it;
  stated rather than pretended at.
- **No new wire vocabulary, no reader changes, no renderer changes** — item
  1 is a firing-condition change on an existing op, and that is a load-bearing
  property (§7.1), not an omission.
- **No new scored suite, no wave 3.5, no task/fixture changes** —
  wave3-evaluation already ruled the next task-success evidence comes from
  the head-to-head's fixtures. `prepend.html` is a GUARD fixture, never a
  task, and must never be imported by tasks.mjs (§1.6).
- **No h2h implementation** — headtohead.md's own partition governs it; this
  bundle only amends its assumptions by appendix (§7) and hands it a frozen
  build.
- **No edits to headtohead.md, wave3-evaluation.md, or any adjudication
  record** — this file is the amendment vehicle.
- **No sweep re-run and no sweep-number changes** — §5 is sentence templates
  only, implemented by reference to the sibling adjudication.
- **No CI workflow** (§6.2 — deferred, unwatched, ungating).
- **No threshold retuning** — `MAX_DIFFS_PER_EPOCH`, `DIFF_SIZE_RATIO`,
  `REPLACE_MATCH_RATIO`/`REPLACE_MIN_CHILDREN`, the G4 60% floor, and every
  preregistered bound stand exactly as landed.
- **No dependency, port, or prompt changes** — SYSTEM_PROMPT, tool
  descriptions, and ARM_DEFINITION are byte-identical; nothing new listens
  anywhere.

---

## 11. What was verified by probe and by code read, for this spec

**Probed live at `f37a5db` (throwaway vitest against `diff.ts`, deleted,
tree clean):** prepend into a 6-row positional family → exactly one `add`
with `after: <last-row-ref>` and the rendered wire `+ after e7:` (§1.1,
quoted verbatim); 1→2 growth → one `add`, bare key rebinds; removal 7→6 →
one `replace (gone: …)` — P1 intact. These are the RED premises for §1.5
cases 1–3 and the GREEN premise for case 7.

**Verified by code read at `f37a5db`:** the watched set (store.mjs
WATCH_DIRS/WATCH_FILES — size.mjs and guards.mjs outside it);
`positionalFamilyLostAMember`'s removal-only trigger and `oldByKey`'s
availability (diff.ts:70, 205-255); the replace wire form and its
empty-`gone` rendering (render.ts:431-440) and parse (streamModel.mjs:
165-193); `recordObservation`'s inline taxonomy and the early returns that
keep proxy refusals out of it (proxy.mjs:284-315); the G2-precheck/report-G3
predicate drift (task.mjs:997 vs 1900); G4's denominator (1951-1952); the
post-resync tag (proxy.mjs:352-355) and its report line (task.mjs:1983-1986);
the arm forcing's epoch consequence that closes the §4 alternative
(engine.ts:68-73, 196-225, proxy.mjs:327, 395); `metricsStamp`/`stampFields`
and `printApparatusNote` (task.mjs:474-501, 1693-1721, 2193-2217); the
`/metrics` handler shape (server.ts:86-93); `witnessInput`'s verdict
resolution points incl. `UNKNOWN_WITNESS` (act.ts:97, 207, 250-325);
queue.html's construction and divider rule (copied into §1.6, not
re-derived); tier3 §4.3/§4.4 landings for §6.1–6.2 (tools.ts:558,
completeness.test.ts:48, test/typecheck.test.ts); wave-3 archival + tags for
§0's preconditions.

**Asserted but not probe-verified — the residuals, owned:** that the G2
scripted streams are run-to-run deterministic on the queue-class fixtures
(no timers, so volatility is inert — argued from code; §1.7's byte-capture
is the check, and battery item 8 is where a wrong assumption surfaces,
before any budget); that Electron's `getAppMetrics()` types the main process
`'Browser'` on this platform (observed in wave 3's own sidecars, which is
better than the docs — but the §3 tests still null-tolerate); that no
neutral-fixture solve path inserts into an unnamed-wrapper family (§7.3 —
argued from the frozen §4.3 specs; H3 catches a miss before any budget);
`sweep-evaluation.md` §2's content (unwritten at authoring time — §5's seam
and stop-rule are the containment).
