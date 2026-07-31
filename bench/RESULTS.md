# Benchmark results

Re-run 2026-07-31 after the layout-table fix, the positional-ref fix, and the
UA change. `bench/live.mjs` drives a running Aperture; `bench/tokens.mjs` is the
synthetic model.

## The finding that matters most

**`browser_act` does not exist.** The snapshot format legend — injected into
every agent's context — says *"eN stable element ref — use it with
browser_act"*, and `browser_snapshot`'s description says *"prefer letting
browser_act return diffs."* No such tool is registered.

An agent using Aperture today can navigate, snapshot, read, fill a form (behind
the consent dialog), attach a file, capture, and set the theme. **It cannot
click a button or type into an arbitrary field.**

This means the loop the entire project is built around — act, observe delta —
is not closed. It also means:

- The 40× projection in the previous version of this file was never testable,
  because no action could be performed to produce a real diff.
- The reviewer's central question, *task success rate on diffs versus
  re-dumps*, is not merely unmeasured but currently unanswerable.

That is now the top priority, ahead of everything else on the roadmap.

## A. Full snapshot size, real sites

| site | tokens | refs | lines |
|---|---|---|---|
| Hacker News | 9,512 | 233 | 654 |
| GitHub (anthropics/claude-code) | 5,411 | 97 | 418 |
| Wikipedia (Model Context Protocol) | 6,575 | 206 | 600 |
| MDN (Web/API/fetch) | 7,415 | 161 | 713 |

Reproduces the earlier head-to-head run (9,561 / 5,430 / 6,605) within page
drift, so those numbers hold. Against `@playwright/mcp` on the same URLs:
**1.25×–2.77× smaller**, averaging ~1.9×.

## B. Ref stability across a re-snapshot

| site | before | after | survived | % |
|---|---|---|---|---|
| Hacker News | 233 | 233 | 233 | **100%** |
| GitHub | 97 | 97 | 97 | **100%** |
| Wikipedia | 206 | 206 | 206 | **100%** |
| MDN | 161 | 161 | 161 | **100%** |

Identity keys are stable across repeated snapshots of a live page, including
one (HN) whose content changes underneath.

**This is the weak version of the test.** It does not involve an interaction, a
re-render, or a virtualized list. The claim that refs survive a React re-render
that replaces every DOM node remains **untested**, and cannot be tested until
`browser_act` exists.

## C. The no-change floor

| site | full snapshot | observation when nothing changed |
|---|---|---|
| Hacker News | 9,512 | 115 |
| GitHub | 5,412 | 112 |
| Wikipedia | 6,575 | 114 |
| MDN | 7,415 | 115 |

An earlier draft of this file reported these as "diff after a real interaction"
and derived 48×–83× from them. **That was wrong.** The uniform ~113 tokens
across four very different pages is the "no visible change" response plus the
untrusted-content envelope — the floor case, not a diff.

It is still a useful number: it is what an observation costs when nothing
happened, and it bounds the cost of polling. It is not evidence for the diff
design.

## Honest summary of what is proven

| claim | status |
|---|---|
| Snapshots are smaller than playwright-mcp's | **Measured: ~1.9× on four real sites** |
| Refs are stable across re-snapshots | **Measured: 100% on four real sites** |
| Refs survive real re-renders | **Untested** — blocked on `browser_act` |
| Diffs are much cheaper than re-dumps | **Modelled only** (`npm run bench`: 7–10×) |
| Agents succeed as often on diffs | **Unmeasured, currently unmeasurable** |

The synthetic 7–10× is the only defensible figure for the diff mechanism, and
it is a model rather than a measurement.
