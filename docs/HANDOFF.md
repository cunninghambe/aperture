# Handoff

## Current state — all benchmarks green, and this time the green is guarded

283 tests pass. The browser runs, the MCP server works, `browser_act` closes
the act-observe loop, and Claude Code can drive it end to end.

```
bench:fidelity form       GREEN   18/18 refs · 13 diffs + 1 forced resync · typed values round-tripped
bench:fidelity rerender   GREEN   17/17 refs · 0 phantoms through full DOM teardowns
bench:fidelity widgets    GREEN   6/6 refs · clicks, +checked/+expanded, shadow DOM, clock suppressed
bench:fidelity biglist    GREEN   71/71 refs · 70 refs die and revive · size-cap resync fired
bench:fidelity selects    GREEN   7/7 refs · 4 native selects + a custom ARIA combobox
bench:guards              GREEN   11/11 refusals and retractions (1/11 on the pre-fix build)
```

`bench:guards` is new (2026-08-01) and answers a different question from the
fidelity scenarios: not "does the diff describe the page" but "does Aperture
actually refuse what it says it refuses, and actually retract what it says it
retracts". It judges against the fixture's own change-event log, because an
`error:` reply is not evidence that nothing was written. Seven adversarial
findings produced it; nine of its eleven checks failed on the build immediately
before. See `bench/RESULTS.md`.

This suite had already produced two false results that were believed for a
while (phantom refs from a collapsed ground truth; a flawless green from an
empty model). The 2026-07-31 pass treated the benchmark itself as the thing
under test, found six more ways it could print a meaningless green, and closed
them — see `bench/RESULTS.md` ("the benchmark itself went under review") for
the full table. The two headline changes:

1. **Scenarios target elements by label, not by hardcoded ref.** The
   historical false green came from positional refs pointing at nothing in a
   reused session. Targets are now resolved against the agent-side model at
   each step, which also makes label fidelity load-bearing: if a diff fails to
   deliver a label update, the next step cannot even resolve its target.
   Verified by deliberately re-running a scenario in a dirty session — it
   resolved its field to `e1241` and measured correctly.
2. **A run that measured nothing refuses to print a verdict.** Scenarios
   declare minimum tracked refs, minimum diff-mode steps, and whether a resync
   must fire; violations exit 4 ("vacuous") before any comparison happens.
   Exit codes: 0 green · 1 red · 2 truth unusable · 3 step failed · 4 vacuous.

## Run the benchmarks

One scenario per freshly started Aperture is still the *recommendation* (clean
measurement, honest ref counts), but it is no longer a correctness
requirement — label targeting removed the failure mode, and exit 3 catches
anything that still goes wrong.

```bash
# -c-1 is not optional: without it Electron caches the fixtures and an edited
# fixture is measured in its OLD form, silently. fidelity.mjs also appends a
# cache-busting query to the navigation URL for the same reason.
npx http-server test/fixtures -p 8899 -c-1 --silent &
npx electron . > /tmp/ap.log 2>&1 &
sleep 15
TOK=$(grep -oE "Bearer [A-Za-z0-9_-]+" /tmp/ap.log | head -1 | cut -d' ' -f2)
node bench/fidelity.mjs "$TOK" form   # or rerender | widgets | biglist | selects
```

All five in one go, one fresh Aperture each: `bash bench/fidelity-all.sh`.

The guard probe runs the same way — its fixture is `test/fixtures/guards.html`,
so the same 8899 server serves it, and it takes an optional second argument if
you need a different fixture port:

```bash
npm run bench:guards -- "$TOK"
```

The task-success bench owns its whole world instead — it refuses to start if
8817 is already in use, then starts its own Aperture, a `no-store` fixture
server on 8899, the witness collector on 8898 and the MCP proxy on 8896, and
tears all of it down on exit:

```bash
npm run bench:task -- --selftest                # G1+G2 only, spends NO API budget
npm run bench:task -- --tasks cart-adjust --n 2 # a pilot
npm run bench:task                              # the full preregistered suite
```

### Running the scored suite in phases

400 episodes is six-odd hours, so it is resumable. Every scored episode is
appended to `bench/task/results/episodes.jsonl` (gitignored) as it completes,
keyed by `(task, arm, runIndex, codeVersion, model)`; a later invocation skips
what is already on record and runs only the rest. The verdict is always
computed over the WHOLE accumulated store — the phases are how episodes get
gathered, not how they get scored, because five partial runs that each score
their own rows give five underpowered verdicts and no result.

```bash
npm run bench:task -- --plan     # a concrete phase plan, waves of N. Starts nothing.
npm run bench:task -- --n 5      # phase: 100 episodes
npm run bench:task -- --n 20     # phase: only the missing 300
npm run bench:task -- --report   # the pooled verdict. Runs no episodes, needs no port.
```

**The integrity guard is the part that matters.** Accumulating across sessions
is valid only if the thing under test did not change between them, so every
episode is stamped with a content hash of the product source, the built
artifacts in `out/`, every fixture, the task definitions, the arm-forcing rule,
the prompt and the verdict thresholds — content hashes, not the git SHA, so an
uncommitted edit moves them. If the store holds episodes that disagree with the
current tree, the run **refuses to aggregate (exit 6)**, names the field and the
files that moved, and says how many episodes are affected. It refuses *before*
starting Aperture, so a mid-cohort edit costs nothing to discover.

There is deliberately no override. `--new-cohort` archives the old store under a
timestamp and starts a fresh one; nothing is discarded and nothing is pooled
across versions. `bench/task/results/episodes.cohort.json` records the file
table the episodes on record were produced from, which is what makes the
refusal a diagnosis rather than a hash mismatch.

Every phase also prints an advisory: running tallies per arm, per-task coverage,
and a plain statement of what the current sample can support (at N=5/task only a
~19pp drop is distinguishable from the ±5pp margin; PARITY is not reachable
until roughly the full preregistered sample). If a catastrophic regression is
already unambiguous — success-delta CI entirely below −25pp — it says so loudly,
so nobody burns six more hours confirming a disaster. **None of it changes the
verdict rule**: PARITY/REGRESSION/INCONCLUSIVE are computed exactly as
preregistered, over whatever is on record.

Others: `npm run bench` (synthetic diff model), `npm run bench:live`
(real-site sizes and ref stability). Results in `bench/RESULTS.md`.

## What the fidelity bench does and does not license

The model side is a mechanical rule-follower. GREEN means the diff stream is
**complete and unambiguous**: a reader that applies every line by the rules
holds the page (refs, roles, labels, values, state flags). If a real agent's
model drifts, the fault is its bookkeeping, not the stream. GREEN does NOT
mean agents succeed on diffs (task-success suite still unbuilt), and the bench
does not check containment or position. Ground truth is a fresh full snapshot
from the same walker/renderer — a walker bug hits both sides identically —
which is why the bench also asserts against things it did itself: typed values
must round-trip, a clicked checkbox must read `checked`.

## Engine fixes that came out of this pass

- **`wasEmitted` deadlock — fixed and observed healing live.** Nodes that got
  a ref mid-diff (the product-count text) never had it re-attached on later
  walks, so `markEmitted` never ran and their changes were gated forever, even
  after a full re-read. `registry.assignRefs` now re-attaches refs for any key
  the registry knows; text lines render their ref once they have one; the next
  full snapshot announces the ref and unlocks the diff channel. In `biglist`,
  the count paragraph went unread → announced by the resync → tracked 71st ref.
- **`isAddressable` drift — gone.** There were *three* copies (walker, engine,
  tests); the engine's lacked `banner`/`contentinfo` so those landmarks never
  received refs despite being indexed for acting. One exported set in
  `walker.ts` now feeds `registry.assignRefs` and the tests. `option` was
  removed from the set deliberately: no ref was ever assigned to one, and a
  native dropdown cannot be clicked by coordinates — selects need a dedicated
  `select` action before options may carry refs.
- **Emission bookkeeping no longer lies.** A diff discarded by the size cap
  used to mark its subtree refs emitted anyway; so did full-snapshot lines
  dropped by the budget cut. Both paths now mark only text the model actually
  received (dry/commit render split; budget-aware marks). Regression-tested.
- **Volatility suppression now works in the loop it exists for.** Every
  act-observe observation has `afterAction: true`, which reset the streak, so
  nothing could ever be demoted while an agent was acting — a ticking clock
  rode along in every diff. Clocks are now shape-promoted regardless of
  `afterAction`, except for the element the action targeted (`actedKey`), and
  `onAgentTouch` — which was never wired — is called from `browser_act` and
  scoped `browser_read`. Unread changes also feed the tracker now (they never
  did, so an unread clock spammed the "unread changes" note forever).
- **Shadow DOM was claimed and unclickable.** `elementFromPoint` stops at the
  shadow host and `Node.contains` does not cross shadow boundaries, so every
  in-shadow element reported "obstructed". The hit-test now descends through
  open shadow roots and compares containment along the composed tree.
  `widgets` clicks a shadow button as part of the green.
- **`browser_read` `ref` scoping implemented** (was accepted and silently
  ignored). Scoped reads resolve through the isolated-world index, same keys
  as acting; unknown/gone refs error loudly. Verified live.

## Engine fixes from the 2026-08-01 adversarial review — all seven findings real

Three reviewers attacked the `select` action, the task-success harness, and
everything previously green. Every finding they raised reproduced live, and
every one is fixed. `bench/RESULTS.md` has the before/after table and the
finding-by-finding write-up; the short version:

- **A removed subtree orphaned every ref inside it unless its root happened to
  be addressable.** `diff.ts` bailed on `if (!ref) continue` *before* the
  descendant-`gone` walk, and `generic`/`listitem` are not addressable — so
  removing a `<div>` panel or an `<li>` row retired nothing at all. The walk now
  runs first, and a new `gone` op (`- gone: e2 e3`) reports deaths that have no
  addressable root to hang off. The earlier fix only covered the one shape the
  `selects` fixture happens to use.
- **`select` bypassed the obstruction hit-test.** Right that it needs no
  coordinates, wrong that it therefore needs no *reachability* answer — that
  resolve is the only modal gate in the codebase. Every element-targeted action
  now passes it. `select` still dispatches no CDP input and stays on the IPC
  path; it just takes the answer.
- **`select` wrote through a `<select disabled>`, and through one disabled by an
  ancestor `<fieldset disabled>`.** The fieldset half was worse: `statesOf` read
  only `el.disabled`, so the snapshot line carried no `disabled` flag and the
  agent could not see why the call should fail. The walker now consults
  `:disabled`.
- **`[N options]` and the inline option enumeration were never diffed.** A
  country→state cascade left the agent holding three option names that no longer
  existed plus a marker telling it the list was short enough not to read. A
  native select whose option LIST turns over is now restated as one `replace`;
  a selection change is still one `~` line.
- **Select error paths emitted unbounded, unsanitized page text** — 12,408 chars
  for one no-match on a page whose whole snapshot is under 800. Now capped and
  `quote()`d, so a label of `Beta" [disabled] and "Gamma` can no longer forge a
  second option in our own vocabulary. The `browser_read` listing deliberately
  uses `quoteFull` (no length cap): truncating a label there makes the option
  unselectable, and that path is bounded by `maxChars` instead.
- **A blank option query selected the placeholder** — `""` matched the
  `<option value="">` that heads most pickers, resetting a field the human then
  submits. `blank-query` is now its own refusal.
- **No unicode normalization before matching.** Fail-safe, but the suggestion it
  produced was screen-identical to the query. `norm()` applies NFC.
- **`reapExcept` deleted.** Never called from anywhere, and it read as a second
  net under the diff's bookkeeping. It cannot become one: a full snapshot's
  lines are subject to run collapsing and the budget cut, so "absent from this
  snapshot" does not mean "absent from the page".
- **The bench could not have caught two of these.** The shared stream reader
  dropped `[N options]` on the floor, so a stale marker could never turn a
  scenario red. It now parses `optionCount` and understands `- gone:`, and
  `fidelity.mjs` prints `WRONG [N options] MARKERS` (0 on all five scenarios).

## Known gaps and hazards, honestly

- **Structure and position are not part of "faithful".** The bench verifies
  existence + role + label + value + states. A stream that scrambled
  containment would pass. A structural check needs indentation/parent
  tracking through moves and replaces — designed, not built.
- **Replace-op elision can hide a changed survivor.** A replace subtree
  renders collapsed; a surviving ref in the elided tail whose *content
  changed in the same re-render* would go stale in the model with no
  re-announcement (`runOwesReannounce` covers revived refs, not changed
  ones). No fixture constructs this yet; it is the most plausible remaining
  fidelity hole.
- **`~ eN "A"` is ambiguous by format**: one quoted string could be a name
  change or a text change; no reader, model or mechanical, can tell. Harmless
  today because name and text co-change for the nodes that emit it, but the
  format owes a disambiguator.
- **Model-side budget truncation is unmeasured** — the bench aborts when the
  *truth* is cut, but an agent living on a 2000-token budget of a 9k-token
  page is the production case and no scenario measures it.
- **iframes** are claimed in the design and exercised by no benchmark or test.
  The **modal-obstruction path** is now exercised, but only by `bench:guards`
  (G7a/G7b) — no fidelity scenario raises a modal, so a hit-test regression
  would still slip past the standing five.
- **`[N options]` staleness is measurable now, but only on the guard fixture.**
  No fidelity scenario contains a dependent select; `selects.html`'s lists never
  change size.
- **Only `:disabled` is consulted, not `inert` or `pointer-events: none`.** A
  select inside an `inert` subtree is still writable by `action:"select"` — the
  hit-test catches the overlay case, not that one. Deferred deliberately:
  `inert` needs its own walker state (the agent should see it on every element,
  not just selects), and inventing a half-answer for one action is how the
  `disabled` gap happened in the first place.
- **The `select` mechanism's headline justification does not reproduce from
  here.** React's value tracker lives on the page's own wrapper for the DOM
  node; the preload writes from an isolated world, which has a different
  wrapper, so a naive `select.value = x` is *not* deduplicated the way it would
  be from a main-world script. Measured both ways against the fixture's write
  counter — 0 either time. The prototype-setter mechanism is kept on grounds
  that survive that (main-world correctness, and it is the only way to select
  one of two options sharing a `value`), and the `selects` scenario now fails
  RED on a regression for that second reason. If Aperture ever injects into the
  main world, re-read this.
- **Multi-select is replace-only.** Adding to an existing selection is not
  expressible; the result says so out loud rather than implying otherwise.
- **Optgroups are passive** — shown in listings and errors, never matched.
  `"group > label"` queries are deferred, so two same-labelled options in
  different groups are distinguishable only by value.
- Shadow-root focus is invisible to the walker (`document.activeElement` is
  the host, which gets pruned) — model and truth agree, so the bench cannot
  see it either. Cosmetic, but it is a known shared blind spot.

## Next, in order

1. **Task-success benchmark** — **BUILT 2026-07-31, and the scored suite has
   not been run.** `bench/task.mjs`: ten tasks over nine fixtures, a real
   language model driving a sealed three-tool MCP surface, scored against the
   fixtures' own JavaScript rather than against the snapshot pipeline (half of
   which is the variable under test). The arm is applied at a proxy that
   injects `observe:"full"`, so the prompt bytes are identical in both arms and
   the model cannot tell which arm it is in. `npm run bench:task -- --selftest`
   runs G1 + G2 and spends **no API budget**; it passes, and every guard was
   confirmed by deliberate sabotage. What remains is the human's call, because
   it spends their quota: 10 tasks x N=20 x 2 arms = 400 episodes, measured at
   **$0.0925/episode and ~20s/episode** in the pilot, so roughly **$37 and
   3-4 hours**. Read `bench/RESULTS.md` first — in particular G4 (the pilot sat
   at 73.7% against a 60% floor, and short tasks are fragile) and G10 (both
   arms scored 100% on the two pilot tasks, which is the ceiling problem
   `tier1.md` warned about and would return INCONCLUSIVE rather than PARITY).

   Two things worth carrying forward regardless of whether the suite is ever
   run. The agent **gives back much of the diff saving by re-snapshotting
   voluntarily**: the scripted solver observes 0.48x on `cart-adjust`, the
   language model 0.63x. And once in ~450 acts, Aperture returned `ok click e6`
   for a click that never reached the button — the witness recorded no event at
   all. Not reproducible in three cold starts, but the tool said `ok`.
2. ~~**Shorten the `<untrusted-page-content>` envelope on continuation
   responses**~~ — **DONE 2026-07-31.** Landed as one *uniform* minimal
   envelope rather than a first/continuation pair: the explanation moved into
   the tool descriptions, which the client re-sends every request and which
   therefore survive compaction, where a "have I explained this yet" flag on
   the server would be wrong after compaction, after a reconnect, and with two
   clients. Overhead 420 → 104 chars, **79 tokens saved per response**;
   `form` 1,997 → 891 (−1,106), all four scenarios still GREEN and the saving
   reconciles to the byte. The audit also found two paths carrying page text
   **entirely unwrapped** — `browser_tabs list` and `browser_fill_form`'s plan
   — and the inverse leak, `browser_act` putting its own `ok …` and error
   prose *inside* the envelope. See `bench/RESULTS.md` and the four invariants
   in `docs/design/security.md`.
3. ~~**`select` action** for browser_act, then restore `option` to the
   addressable set.~~ — **DONE 2026-07-31.** Native `<select>` only, driven by
   the isolated-world `HTMLOptionElement.prototype.selected` setter plus
   `input`/`change` (no CDP, no popup, no keyboard). Custom ARIA comboboxes use
   the existing `click`, which is what put `option` back in `ADDRESSABLE` —
   guarded by a `synthetic` flag so the walker's manufactured option nodes for
   a native select can never receive a ref, in `assignRefs` and at every
   `ensureRef` site in `diff.ts`. Every native select now emits `[N options]`
   (previously only when >4) because that marker is the agent's only
   discriminator between the two kinds; `browser_read` on the ref lists them.
   Matching is five exact-first tiers in `src/core/snapshot/selectOption.ts`,
   with no edit distance anywhere: ambiguity at any tier errors with the
   candidates rather than falling through, so `"United States"` resolves
   uniquely and never meets `"United States Minor Outlying Islands"`.
   `browser_act` also gained `observe: 'diff'|'full'` on the existing
   `opts.full` path. Two false-green vectors were found in the process — see
   `bench/RESULTS.md`.

   **Reviewed adversarially 2026-08-01 and it did not survive intact**: seven
   findings, all real, all fixed, all now measured by `bench:guards`. The
   synthetic-ref guard and the five matching tiers held under attack; what did
   not was everything around them — the obstruction gate, the disabled check,
   the option-list retraction, and the size and escaping of the error text.
4. **Vault fill path** — unblocked since the consent dialog exists.
5. **Web Bot Auth**, before the 2026-09-15 Cloudflare deadline the README
   cites.

## Method that has actually worked here

Nine times now, something marked "working" was broken the moment it was
measured end to end: the crash pipeline, the HN snapshot, the UA client hints,
the benchmark harness twice, the fidelity ground truth, the
volatility-in-act-loops + shadow-DOM clicks, the `select` pass's first green (a
stale cached fixture and a mechanism test with no teeth), and now the `select`
pass's *second* green — seven findings, every one of which reproduced live
against a build whose 200 unit tests and five fidelity scenarios were all
passing. Every time, the unit tests and the assumption agreed with each other,
and only the real output disagreed.

The 2026-08-01 pass added a corollary about benchmarks specifically. Two of the
seven findings were **structurally invisible** to the suite: the shared stream
reader required a role-plus-ref prefix to parse a line, so `[N options]` was
dropped on the floor and no scenario could go red on a stale one however wrong
the agent's belief. A benchmark that cannot see a field is not evidence about
that field, and it looks exactly like a benchmark that checked it. When adding a
claim to the product, check that the reader can see the bytes that carry it.

The `select` pass added a variant worth naming: **`tsc` agreed too.** The
success path read a variable declared inside the failure branch and compiled
clean, because `origin` is a DOM global — so the type checker bound it to
`lib.dom` while the main process would have thrown `ReferenceError` on every
successful select. A test that actually calls the handler is what caught it,
and `test/act.test.ts` now holds that test.

Instrument and compare against ground truth. Do not reason from the code
alone, do not trust a verdict without the counts behind it — and when a
benchmark goes green, spend a day trying to make it lie to you before you
believe it.
