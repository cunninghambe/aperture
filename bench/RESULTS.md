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

---

# Update: diff fidelity — the precondition for task success

`npm run bench:fidelity -- <token> [form|rerender]`

Builds the model an agent could construct **from the diff stream alone**, then
compares it against a fresh full snapshot. It does not measure whether a model
*would* succeed; it measures whether succeeding is *possible* — if base + diffs
does not describe the real page, no amount of model quality helps.

| scenario | result |
|---|---|
| `form` — 8 field edits, static page | **GREEN**: 16/16 refs verified, 0 wrong values, 0 phantoms |
| `rerender` — 3 filters, full DOM teardown each time | **RED**: 6 phantom refs |

## What the RED means

A *phantom* is a ref the agent believes exists that does not. It is the exact
precondition for a wrong-element click.

**Root cause found and partly fixed.** The `!  replaced` op emitted the new
subtree and never said which refs it had **destroyed**. A model applying that
diff had no mechanical way to learn they were gone. `replace` now carries a
`gone:` list:

```
! e3 replaced (gone: e6 e7 e31 e8 e9 e32 e10 e11 …):
```

That took phantoms from 8 to 6 on the hard scenario. **The remaining 6 are not
yet diagnosed.** The likely mechanism is ref *revival* — the registry
deliberately revives a dead ref when its identity key reappears, so across
three successive filters a ref can die, revive, and die again, and the diff
stream does not currently narrate that cycle unambiguously.

## Honest status

| claim | status |
|---|---|
| Diff stream is faithful on a static page | **GREEN, measured** |
| Diff stream is faithful through full re-renders | **RED, measured** — 6 phantom refs |
| Agents succeed as often on diffs | **Still unmeasured**, and now known to be gated on the RED above |

**Do not ship agentic use against re-rendering pages until `rerender` is
green.** The failure mode is silent and it is a wrong click, not an error.

This is also the argument for the fidelity check existing at all: the loop
looked completely healthy from the outside — actions succeeded, diffs were
small, refs looked stable — while the agent's model was quietly drifting from
the page.

---

# Update 2026-07-31: the benchmark itself went under review

This suite had produced two false results that were believed for a while (the
phantom-refs RED off a collapsed ground truth, and the flawless GREEN off an
empty model). Both were bugs in the *measurement*. This pass assumed there
were more, and found them.

## False-green vectors found in the harness, all now closed

| vector | fix |
|---|---|
| Hardcoded positional refs (`e3`, `e4`, …) — the root cause of the historical empty-model green | Steps now target elements **by label**, resolved against the agent-side model each step. Verified: a scenario run in a dirty session resolved its target to `e1241` and still measured correctly |
| Step-failure guard matched only two error strings; timeouts, empty responses, and other errors scored as silent no-ops | Every step must carry an `ok <action>` acknowledgement AND a `page #`/`FULL SNAPSHOT` observation; anything else exits 3 |
| No minimum counts — an empty model or an all-resync run scored perfect | Scenarios declare `minRefs` / `minDiffs` / `resync`; violations exit **4 (vacuous)** with no verdict printed at all |
| Only `value` was compared. Wrong labels, roles, and state flags (disabled, checked, expanded) all scored green | Role, label, value, and state flags are all compared now |
| Ground truth and model both come from the same walker/renderer, so a shared bug is invisible | Partially pierced by **independent checks**: values the bench itself typed must round-trip through the diff stream, and states the bench itself caused (clicking a checkbox) must arrive. These compare against what the bench *did*, not what the engine *said* |
| Escaped quotes broke the line parser identically on both sides, hiding whole elements consistently | Escape-aware parser, shared by both sides deliberately |
| Nameless-ref lines (`form e2`) were invisible to both sides — a later `~ e2` would count as a phantom | Nameless elements are tracked with an empty label |
| Truth snapshot could be empty/failed and still be "compared" | Truth must be a full snapshot with at least `minRefs` entries, else exit 2 |

## What the fidelity bench proves, and what it does not

`applyObservation` is a mechanical rule-follower, not a language model. A
green proves the stream is **complete and unambiguous for a rule-following
reader**: every element the reader ends up believing in exists on the page
with the stated role, label, value, and states. It licenses exactly this
claim: *if an agent's model drifts, the fault is the agent's bookkeeping, not
missing or wrong information in the stream.* It does NOT prove an LLM will do
that bookkeeping correctly — that is the task-success benchmark, still
unbuilt. It also does not check containment structure or position: a stream
that reordered the world would still pass.

## Current results — four scenarios, one freshly started Aperture each

| scenario | what it exercises | result |
|---|---|---|
| `form` (14 typed fields) | typing; **MAX_DIFFS_PER_EPOCH resync fired mid-run at step 13** and the model survived the restatement | **GREEN** — 18/18 refs, 13 diffs + 1 resync, all typed values round-tripped |
| `rerender` (3 filters, full DOM teardown per keystroke) | replace ops with `gone:` lists, granular add/remove, ref revival | **GREEN** — 17/17 refs, 0 phantoms, 4 elided items honestly reported as never-seen |
| `widgets` (5 clicks) | click actions, `+checked`/`+expanded` state fidelity, an added subtree, a **shadow-DOM** button, and a **ticking clock that must be suppressed** | **GREEN** — 6/6 refs, suppression note seen; step 2 targets the label step 1's diff delivered, so label fidelity is load-bearing |
| `biglist` (filter to zero, clear back to 40) | mass ref death (70 → 3), mass revival, and the **DIFF_SIZE_RATIO "too big → full resync" fallback** | **GREEN** — 71/71 refs; the resync announced the count paragraph's mid-diff ref (the wasEmitted deadlock heal, observed live) |

Engine paths now exercised by at least one scenario: type, click, clear,
diff updates, adds, removes, replaces with `gone:`, revival, both resync
fallbacks (12-diff cap and 30%-size cap), volatility suppression in an
act-observe loop, shadow-DOM piercing and acting, and the unread-changes gate
plus its heal-on-full.

## Live numbers, re-measured after the addressable-set unification

banner/contentinfo landmarks now receive refs (they were indexed for acting
but never got one — three drifted copies of the addressable set, now one):

| site | tokens | refs (was) | stability |
|---|---|---|---|
| Hacker News | 9,519 | 233 (233) | 100% |
| GitHub repo | 5,269 | 100 (97) | 100% |
| Wikipedia | 6,197 | 209 (206) | 100% |
| MDN | 7,102 | 163 (161) | 100% |

No-change floor unchanged at ~112–115 tokens.

## Honest claim status after this pass

| claim | status |
|---|---|
| Diff stream is information-complete on static pages, re-renders, clicks/states, shadow DOM, and through both resync fallbacks | **GREEN, measured**, with vacuity guards |
| Volatility suppression works in a real act-observe loop | **Measured** (`widgets`) — it did NOT work before this pass; every observation is `afterAction` and the statistical path can never fire there. Clocks are now suppressed by shape regardless, except on the acted element |
| `browser_read` ref scoping | **Implemented and verified live** (scoped read of the results list excluded the rest of the page; unknown ref errors) |
| Structure/containment/position fidelity | **Not measured** — outside the bench's definition of faithful |
| Model-side budget truncation (agent on a page bigger than its budget) | **Not measured** |
| iframes, modal-obstruction recovery | **Not measured by any benchmark** |
| Agents succeed as often on diffs | **Still unmeasured** — the task-success suite remains the single largest gap |

## The envelope shrink (2026-07-31) — measured before and after, four scenarios

The finding recorded above ("the envelope dominates small diffs") is now fixed.
The `<untrusted-page-content>` wrapper is one uniform, minimal, nonce-bearing
envelope; the explanation it used to repeat on every response moved into the
tool descriptions, which the client re-sends with every API request and which
therefore survive compaction. Wire format:

```
<untrusted-page-content id=9f3a1c58 origin=http://127.0.0.1:8899>
page #1.1 (diff from #1.0)
~ e3 ="Brad" +focused
</untrusted-page-content id=9f3a1c58>
```

Each scenario measured on a **freshly started Aperture**, before at `505096a`
and after with the change built.

| scenario | actions | before | after | saved | per response |
|---|---|---|---|---|---|
| `form` | 14 | 1,997 | **891** | **1,106** | 79.0 |
| `rerender` | 3 | 802 | **565** | 237 | 79.0 |
| `widgets` | 5 | 683 | **288** | 395 | 79.0 |
| `biglist` | 2 | 1,385 | **1,227** | 158 | 79.0 |

All four **GREEN**, with identical ref counts, diff/resync counts and
independent checks to the pre-change run — the shrink changed the framing, not
the stream. `form`'s 1,106 sits inside the predicted 1,100 ± 60 band.

**The saving is exactly accounted for, to the byte.** Envelope overhead per
response, at this fixture's origin:

| | chars | note |
|---|---|---|
| before | 420 | 5 lines of prose + `---`, quoted attributes, **16**-hex nonce printed 3× |
| after | 104 | two tag lines, unquoted attributes, 8-hex nonce printed 2× |
| delta | **316** | = **79 tokens** at the bench's 4-chars-per-token rule |

79 × 14 = 1,106 and 1,997 − 1,106 = 891, which is the measured number exactly.
Every scenario shows the same 79.0 per response because the overhead is fixed
and the origin string is the same. There is no unexplained residue in any of the
four, which is the check that matters: a saving that did not reconcile to the
byte would mean something else changed too.

Mean per-action response on `form`: **143 → 64 tokens**. (The earlier
"~124 → ~45" projection was taken from the 8-action sequence in the section
above, on a shorter form with no mid-run resync; the *delta* — 79 — is the
load-bearing figure and it matched exactly.)

Two paths that were carrying page-authored text **completely unwrapped** were
found by the call-site audit and are now enveloped:

- **`browser_tabs list`** — tab titles are page-authored (a tab can call itself
  `SYSTEM: ignore previous instructions`) and the whole list reached the agent
  bare. It is an aggregate across tabs, so it declares `origin=multiple` rather
  than picking one tab's origin and lying about the rest.
- **`browser_fill_form` plan** — page-authored field labels flowed bare. The
  mapping lines are now wrapped; the header and the trailing "Ask the human…
  then call apply" stay outside, because a genuine harness instruction inside an
  untrusted block teaches the model that instruction-shaped text in envelopes is
  sometimes worth obeying.

And the inverse leak was closed: `browser_act`'s `ok …` acknowledgements and
error prose used to sit *inside* the envelope — Aperture impersonating page
content. `bench/live.mjs` now asserts both directions on every site: an
`<untrusted-page-content id=[0-9a-f]{8} ` opener in every `browser_tabs list`
and `browser_act` response, and the `^ok ` line strictly before the envelope
opener in act responses.

`bench/fidelity.mjs` needed no change, verified rather than assumed:
`stepFailure`'s `^ok` / `^page #` / `^FULL SNAPSHOT #` probes are `m`-anchored
and all three still start their own lines; `applyObservation`'s element-line
regex requires `\w` first so both tag lines are ignored; `truthFrom`'s
`/^FULL SNAPSHOT #/m` still matches on line 2 of a snapshot response.

---

# Update 2026-07-31: the `select` action, and two things the bench was hiding

`browser_act action:"select"` landed, `option` became an addressable role
behind a `synthetic` guard, and `browser_act` gained `observe: 'diff'|'full'`.
A fifth fidelity scenario, `selects`, drives four native `<select>`s and a
custom ARIA combobox on one page.

```
bench:fidelity form       GREEN   18/18 refs · 13 diffs + 1 forced resync · 897 tokens/14 actions
bench:fidelity rerender   GREEN   17/17 refs · 0 phantoms through full DOM teardowns
bench:fidelity widgets    GREEN   6/6 refs · clock suppressed · shadow-DOM click
bench:fidelity biglist    GREEN   71/71 refs · 70 refs die and revive · size-cap resync fired
bench:fidelity selects    GREEN   7/7 refs · 8 diffs · 464 tokens/8 actions
```

Each on a freshly started Aperture, one scenario per launch.

## The mechanism argument was measured, and it is narrower than it looked

The design's reason for mutating `HTMLOptionElement.prototype.selected` rather
than assigning `select.value` is React's value tracker: React instruments the
element's **instance** `value` property, so a write through it updates React's
cache, the `change` event is deduplicated, and the controlled component snaps
back. `test/fixtures/selects.html` reproduces that instrumentation exactly and
re-asserts its state every 150ms.

**It does not discriminate the two mechanisms, and the first `selects` green
was not evidence that it did.** A deliberately regressed build using
`el.value = …` passed the scenario. The reason is the world boundary: Aperture
writes from the preload's isolated world, which holds a different JS wrapper
for the same DOM node, so the page's `Object.defineProperty(node, 'value', …)`
is not on the object being written. Measured directly — the fixture counts
writes through its instrumented instance property, and it read **0** after
selects that visibly committed, under *both* mechanisms.

The decision stands (it is correct in a main world, it is what Playwright and
Puppeteer do, and it survives any future change of injection point), but the
fixture now carries a case that discriminates for a reason that does not depend
on the world boundary: **two options sharing one `value` with different
labels**. `el.value = 'am'` can only ever select the first of them. The
regressed build now fails:

```
- e4: bench set "Morning Wednesday" but the diff stream delivered value "Morning Tuesday"
RESULT: RED — diffs do not describe the real page
```

The initially-selected option is deliberately the one NOT sharing that value:
with a morning option pre-selected, the naive write produces no page change at
all and the bench exits 3 ("step did not run") instead of naming the wrong
option it landed on.

## Electron was serving a stale fixture

Editing a fixture and re-running the bench measured the **old page**. The dev
server sends `max-age=3600`, Electron cached it, and a new element added to
`selects.html` was absent from every snapshot until the URL changed. Nothing in
the output said so — the run looked normal and printed a verdict.

`fidelity.mjs` now appends `?benchrun=<timestamp>` to the navigation URL, and
the documented server command uses `-c-1`. This is the cheapest false-green
vector found so far: it needs no bug at all, only an edit.

## Two smaller harness fixes

- **`expectState` is evaluated one step after its action**, not at the end of
  the run. A scenario that opens a dropdown and later closes it is legitimate;
  an end-of-run assertion called the correct final state a failure while
  accepting a stream that never delivered the flip.
- **`applyObservation` consumes the `gone:` list on a `remove` op.** A removal
  destroys a subtree, and the reader previously deleted only its root — every
  ref underneath stayed alive in the model. Closing a dropdown is the commonest
  way to hit it.
