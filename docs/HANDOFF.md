# Handoff

## Current state — all benchmarks green

179 tests pass. The browser runs, the MCP server works, `browser_act` closes the
act-observe loop, and Claude Code can drive it end to end.

```
bench:fidelity form       GREEN   16/16 refs, 0 wrong, 0 phantom
bench:fidelity rerender   GREEN   14/14 refs, 0 wrong, 0 phantom
```

> A previous version of this file said the `rerender` bench was RED and warned
> against using Aperture agentically on re-rendering pages. **That was wrong.**
> The engine's diff stream was faithful the whole time; the *benchmark* was
> reading a lossy ground truth. See below.

## Run the benchmarks

**One scenario per freshly started Aperture.** Ref numbers count up per tab, so
a second scenario in the same session types into refs that no longer exist. The
bench now exits 3 rather than scoring such a run — see "the false green" below.

```bash
npx http-server test/fixtures -p 8899 --silent &
npx electron . > /tmp/ap.log 2>&1 &
sleep 15
TOK=$(grep -oE "Bearer [A-Za-z0-9_-]+" /tmp/ap.log | head -1 | cut -d' ' -f2)
node bench/fidelity.mjs "$TOK" rerender
```

Others: `npm run bench` (synthetic diff model), `npm run bench:live` (real-site
snapshot sizes and ref stability). Results in `bench/RESULTS.md`.

## What the RED actually was

The bench compared the agent's model against a **default** full snapshot — and
the renderer collapses runs of ≥5 same-shape siblings into
`… 3 more listitems (…) — read e3`. Refs behind that elision were absent from
the ground truth while being perfectly real on the page, so every one was
reported as a phantom. The agent's model was correct throughout.

`form` stayed green because collapse keys on `shapeHash` (child roles joined);
leaf inputs have no children, so form fields can never collapse. That contrast
was the whole tell, and it took instrumenting both streams to see it.

**Fixes that landed:**

| fix | effect |
|---|---|
| `expand: true` on `browser_snapshot` | Uncollapsed rendering. Also a real product fix: collapsed items previously had **no reachable refs** — the elision says "read eN" but `browser_read`'s ref scoping is unimplemented |
| Bench truth uses `expand: true`, and aborts (exit 2) if the truth is still elided or budget-cut | The bench refuses to judge rather than manufacturing phantoms |
| `RefEntry.needsReannounce` | A run whose elided tail contains a revived, previously-emitted ref renders in full. Closes a latent silent-revival hole that this bench never triggered |
| `gone:` list filtered to emitted refs | Token waste only; `markDead` still runs for every destroyed key |

## The false green — read this before trusting any bench run

While fixing the above, the implementer's first `rerender` run reported GREEN
and was wrong. Running it in a session that had already run `form` meant every
action failed with `e2 could not be acted on (gone)`, no diffs were produced,
and **an empty model scored a flawless green**.

It was caught only because the tracked-ref count dropped 14 → 8 and the raw
stream was dumped instead of the verdict being trusted.

The bench now exits 3 the moment a step is rejected. Verified firing.

**The general lesson, earned repeatedly on this codebase:** a green that comes
from an empty measurement looks identical to a green that comes from correct
behaviour. Check the counts, not just the verdict.

## Known gaps, none blocking

- **`wasEmitted` deadlock.** Nodes that only receive a ref during diffing (the
  product-count text in the rerender fixture) are gated by `wasEmitted === false`
  in `diff.ts`, but `markEmitted` only runs when a ref-bearing line renders —
  which never happens for them. Their changes are suppressed **permanently**,
  even after a full re-read. It withholds rather than invents, so it cannot
  cause phantoms, but it is a lasting blind spot.
- **`isAddressable` drift** between `engine.ts` and `walker.ts` — the engine's
  list lacks `option`, `banner`, `contentinfo`.
- **`browser_read`'s `ref` scoping** is accepted and partially honoured; the
  in-page scoping is not implemented, so it reads the whole document.

## Next, in order

1. **Task-success benchmark** — now genuinely unblocked. Diff mode vs re-dump
   mode over a fixed task set, scoring completion **and wrong-element actions**.
   The second metric is the interesting one and the reason to build it.
2. **Shorten the `<untrusted-page-content>` envelope on continuation responses.**
   Measured at ~109 tokens against a ~15-token diff payload, so it dominates
   small observations and caps the small-page ratio at 2.2× (`bench/RESULTS.md`).
3. **Vault fill path** — unblocked since the consent dialog exists.
4. **Web Bot Auth**, before the 2026-09-15 Cloudflare deadline the README cites.

## Method that has actually worked here

Six times in one session, something marked "working" was broken the moment it
was measured end to end: the crash pipeline, the HN snapshot, the UA client
hints, the benchmark harness twice, and the fidelity ground truth. Every time,
the unit tests and the assumption agreed with each other, and only the real
output disagreed.

Instrument and compare against ground truth. Do not reason from the code alone,
and do not trust a verdict without looking at the numbers behind it.
