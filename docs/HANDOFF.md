# Handoff

## Current state — all benchmarks green, and this time the green is guarded

200 tests pass. The browser runs, the MCP server works, `browser_act` closes
the act-observe loop, and Claude Code can drive it end to end.

```
bench:fidelity form       GREEN   18/18 refs · 13 diffs + 1 forced resync · typed values round-tripped
bench:fidelity rerender   GREEN   17/17 refs · 0 phantoms through full DOM teardowns
bench:fidelity widgets    GREEN   6/6 refs · clicks, +checked/+expanded, shadow DOM, clock suppressed
bench:fidelity biglist    GREEN   71/71 refs · 70 refs die and revive · size-cap resync fired
```

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
npx http-server test/fixtures -p 8899 --silent &
npx electron . > /tmp/ap.log 2>&1 &
sleep 15
TOK=$(grep -oE "Bearer [A-Za-z0-9_-]+" /tmp/ap.log | head -1 | cut -d' ' -f2)
node bench/fidelity.mjs "$TOK" form      # or rerender | widgets | biglist
```

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
- **iframes and the modal-obstruction path** are claimed in the design and
  exercised by no benchmark or test.
- **Selects are unactable** — there is no `select` action on `browser_act`;
  agents cannot choose an option today.
- Shadow-root focus is invisible to the walker (`document.activeElement` is
  the host, which gets pruned) — model and truth agree, so the bench cannot
  see it either. Cosmetic, but it is a known shared blind spot.

## Next, in order

1. **Task-success benchmark** — diff mode vs re-dump mode over a fixed task
   set, scoring completion **and wrong-element actions**. Everything else on
   this list is smaller than this.
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
3. **`select` action** for browser_act, then restore `option` to the
   addressable set.
4. **Vault fill path** — unblocked since the consent dialog exists.
5. **Web Bot Auth**, before the 2026-09-15 Cloudflare deadline the README
   cites.

## Method that has actually worked here

Seven times now, something marked "working" was broken the moment it was
measured end to end: the crash pipeline, the HN snapshot, the UA client hints,
the benchmark harness twice, the fidelity ground truth, and this pass's
volatility-in-act-loops + shadow-DOM clicks. Every time, the unit tests and
the assumption agreed with each other, and only the real output disagreed.

Instrument and compare against ground truth. Do not reason from the code
alone, do not trust a verdict without the counts behind it — and when a
benchmark goes green, spend a day trying to make it lie to you before you
believe it.
