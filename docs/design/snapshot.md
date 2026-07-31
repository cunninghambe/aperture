# Design: the page snapshot subsystem

The unit of agentic browsing is **act → observe delta**, not "snapshot". That
single decision drives everything else: diffs ride along on action results, and
a standalone full snapshot is the exception (session start, navigation, resync),
not the loop body.

## Why not `Accessibility.getFullAXTree`

CDP's full AX tree is the obvious source and the wrong one:

1. **No incremental mode.** It forces a full a11y computation in the renderer on
   every call. A `MutationObserver` in an in-page walker gives us dirty subtrees
   for free, so re-snapshot cost scales with *change size*, not page size.
2. **No geometry or live values.** We need rects, scroll offsets, viewport
   intersection, and current input values. The AX tree omits or buries them.
3. **No identity material.** Identity keys need DOM attributes (`data-testid`,
   `name`, `id`) the AX tree does not carry.

The cost is reimplementing role and accessible-name computation. Accepted: the
agent needs *operational* semantics, not WCAG-audit fidelity.

The walker runs in the preload's **isolated world**, so page JS can neither see
nor redefine it. A hostile page can still starve it (busy loop) — that degrades
to a timeout, never to forged output.

## Format

Indented plain text, not JSON. Braces, quoted keys, and key repetition cost
40–60% overhead for structure a model reads natively from indentation. Per-choice
justification:

| Choice | Instead of | Saving |
|---|---|---|
| 2-space indent | closing tags/braces | closers double structural cost |
| `e42` | UUID / CSS path | 1–2 tok vs 10–30 |
| bare `button` | `role="button"` | 1 tok vs 5 |
| `="value"` | `value="value"` | 1 tok per field |
| states only when set | `disabled=false` | pay only when true |
| `/pricing` | full URL | origin is on the page line |
| `a \| b \| c` rows | nested cell nodes | ~4× cheaper; markdown prior |

The format legend is paid **once**, in the `browser_snapshot` tool description.

## Identity

```
Tier 1  data-testid / data-test / data-qa / data-cy
Tier 2  name attribute (form controls only)
Tier 3  id, unless it looks framework-generated
Tier 4  role + accessible name + nearest named ancestor + semantic path
```

Tier 4's *anchor* — the nearest ancestor with an accessible name — is what tells
ten identical "Add to cart" buttons apart: each is anchored by its own card's
heading. The semantic path uses only meaningful ancestors (landmark, form,
dialog, list, table), never generic wrappers, so div-soup churn does not break
identity.

Generated ids are rejected (`:r1:`, `radix-*`, embedded hashes, CSS-module
suffixes, >40% digits) because keying on them makes every ref unstable — the
exact failure the subsystem exists to prevent.

**Honest limitation:** for genuinely indistinguishable duplicates, a reorder can
swap refs. Since the elements are indistinguishable by construction, no agent
plan can depend on the distinction.

## Diffing

Identity keys dissolve the matching problem that makes tree-edit-distance
expensive, so this is keyed reconciliation — the virtual-DOM trick — at O(n),
plus:

- **LIS pass** so "one row jumped to the top" is one `move`, not twenty.
- **Regional replace.** Below 40% matched children (in containers of ≥8), emit
  one `!` replace instead of interleaved adds and removes. Costs more tokens
  than a minimal edit script, but a wholesale restatement is far less likely to
  be misapplied by a model maintaining the page in its head. Model reliability
  beats diff minimality.
- **Removals echo the label** so the agent never needs a lookup for what it lost.
- **Offscreen is masked** from deltas — it flips on every scroll.

## Fallback to full

A diff is emitted unless any of: navigation; diff ≥ min(60 lines, 30% of the
last full); ≥12 diffs since the last full; agent asked for `mode:"full"`; a modal
appeared or dismissed over >50% of the viewport.

Sequence ids are `#epoch.step`. Every diff names its base, so a model whose
context was compacted can *notice* it no longer holds the base and re-sync
rather than silently applying a diff to a state it has forgotten.

## Noise suppression

Three layers, cheapest first: (1) free by construction — we serialize semantics,
so CSS animation and transforms produce nothing; (2) shape heuristics — clock and
counter text is recognized on sight and suppressed after one unprompted change;
(3) EWMA + streak tracking for everything else.

The load-bearing rule: **agent-caused changes are never suppressed**, and reading
or acting on a node re-promotes it. Suppression must never hide something the
agent cares about, and caring is expressed through the tools.

## Progressive disclosure

Full snapshots are budgeted (default ~2,000 rendered tokens). Priority: modal
layer → in-viewport → off-viewport skeleton → collapsed stubs. Runs of ≥5
same-shape siblings render as 3 in full plus `… K more (shape)`, where the shape
description is what lets the model decide whether it needs the rest.

An **emission ledger** tracks what the model has actually been shown, so diffs to
never-emitted regions are dropped (a change in a collapsed footer the model never
saw is not news) — counted in the diff header rather than silently discarded.
