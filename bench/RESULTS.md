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

---

# Update: `browser_act` implemented, diffs finally measurable

## The loop, closed

```
> browser_act { action: "type", ref: "e3", text: "Brad" }
ok type e3
page #1.1 (diff from #1.0)
~ e3 ="Brad" +focused
```

## Real 8-action sequence (local form, 324-token page)

| | tokens |
|---|---|
| Full snapshot | 324 |
| Per action | 119–126 (mean ~124) |
| **8 actions, diff mode** | **1,315** |
| **8 actions, re-dump mode** | **2,916** |
| ratio | **2.2×** |

## The finding that matters: the envelope dominates small diffs

The diff payload for a typed field is **~15 tokens** (`~ e3 ="Brad" +focused`).
The observation costs **~124**. The other **~109 tokens is the
`<untrusted-page-content>` envelope**, emitted in full on every single response.

So on a small page the prompt-injection wrapper is roughly **7× larger than the
payload it wraps**, and it is what caps the ratio at 2.2× rather than the ~20×
the mechanism itself achieves.

That envelope is not optional — it is the structural separation that stops page
text being read as instructions. But repeating the full preamble per call is
waste: the legend is already paid once per session in the tool description, and
the same argument applies here. A shortened continuation form
(`<untrusted id="…">` with the explanation only on first use) would recover
most of the difference.

**Projected effect on a real page** (HN, 9,512-token snapshot, 8 actions):
9,512 + 8×124 = **10,504** vs 9,512×9 = **85,608** → **8.1×**. The fixed
envelope cost matters far less as the page grows, which is why the small-form
number is the pessimistic one.

## Revised claim status

| claim | status |
|---|---|
| Smaller snapshots than playwright-mcp | **Measured: ~1.9×** |
| Refs stable across re-snapshots | **Measured: 100%**, four sites |
| Diffs cheaper than re-dumps | **Measured: 2.2×** small page, **~8×** projected large |
| Diff payload itself is tiny | **Measured: ~15 tokens** per field edit |
| Refs survive real re-renders | **Still untested** — now unblocked |
| Agents succeed as often on diffs | **Still unmeasured** — now possible |

The earlier synthetic 7–10× and the 40× projection were both optimistic in the
same way: neither accounted for a fixed per-response overhead.

---

# Update: ref stability under a real re-render — measured, and it failed first

Fixture: `test/fixtures/rerender.html`. Every keystroke calls
`replaceChildren()` and rebuilds the whole list from scratch — no node reuse at
all, no `id`, no `data-testid`. This is the worst case the identity-key scheme
claims to survive, and it is what a naive React list does.

## First run: the claim failed

Typing into the search box reallocated **every ref in the list**. `e4` "Anker
7-in-1 USB-C Hub" became `e29`; the entire `main` was re-added as `e28`.

**Cause, and it was a design flaw rather than a bug.** `accessibleName()` falls
back to `textContent`, so a `<ul>`'s name was every product inside it. Filtering
changed the container's name → changed the *anchor* → changed the identity key
of every descendant.

The anchor exists to disambiguate siblings. Deriving it from content makes it
change precisely when content changes, which is when stability is needed. **An
anchor derived from content cannot stabilise content.**

**Fix:** containers take only an *explicit* name — `aria-label`,
`aria-labelledby`, `title`, or their own child heading — never a textContent
fallback. Leaf elements still use the full accessible name, because a button's
name genuinely *is* its text.

## Second run: passes, with one honest exception

```
~ e2 ="anker" +focused
! e3 replaced:
  list e3
    listitem
      link e4  "Anker 7-in-1 USB-C Hub"   ← survived
      button e5 "Add to cart"             ← survived
    listitem
      link e12 "Anker 655 8-in-1"         ← survived (was e12 before filtering)
      button e7 "Add to cart"             ← POSITIONAL: was another product's
```

| element class | survives full re-render? |
|---|---|
| Form field with a `name` attribute (`e2`) | **Yes** — Tier-1 identity |
| Container with a heading (`e3`) | **Yes** |
| Link with a distinguishing accessible name (`e4`, `e12`) | **Yes** |
| Button identical to its siblings (`e5`, `e7`) | **No — follows position** |

The links survive because their names distinguish them. The "Add to cart"
buttons are identical to each other, so they fall back to the positional
ordinal — and after filtering, position 2's ordinal belongs to a different
product than it did before.

**This is a live correctness hazard, not a cosmetic one.** An agent that reads
the list, filters it, and then clicks a remembered button ref can act on the
wrong product. The mitigation available today is that `browser_act` returns a
diff after every action, so the agent sees the list was replaced — but nothing
*stops* the mis-click.

The reviewer who predicted this was right: for elements distinguishable only by
position, reordering is exactly what breaks positional identity, and the LIS
pass does not help because these are not the same elements moving — they are
different elements occupying the same slots.

**Proper fix, not yet implemented:** derive the ordinal from the nearest
*distinguishing* ancestor rather than from document order — the enclosing
`listitem`'s link name, here — so a button inherits its product's identity.
That makes the button's key a function of its row, which is what a human means
by "that product's add-to-cart button".

## Status after this round

| claim | status |
|---|---|
| Refs survive a full re-render **when the element has a distinguishing name** | **Measured: yes** |
| Refs survive a full re-render **when siblings are identical** | **Measured: NO** — positional, can mis-target |
| Agents succeed as often on diffs | **Still unmeasured** |
