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

---

# Task-success benchmark (2026-07-31)

`bench/task.mjs`. Ten tasks over nine fixtures, driven by a real language model
through a sealed three-tool MCP surface and scored against the fixtures' own
JavaScript. **Built and self-tested; the scored suite has not been run.**

## The runner is the SDK, and the objection that ruled it out is closed

`tier1.md` rejected Claude Code headless for a decisive reason — it ships
filesystem tools, so the agent could read the fixture HTML off disk and bypass
observation entirely. That objection is closed rather than waved away: the
surface is sealed twice over. `disallowedTools` removes the tool *definitions*
from the request, `allowedTools` is a true allowlist, and — the part that does
not depend on the SDK behaving — `browser_navigate` and `browser_read` are
**not registered on the proxy at all**, so no allowlist bug can bring them back.

The one fact the design could not confirm from documentation was whether the SDK
inherits Claude Code's credentials. Measured, not assumed (`bench/authprobe.mjs`
deletes the key-shaped variables from its own child environment):

```
ANTHROPIC_API_KEY in child env: undefined
assistant text: "PONG"
result subtype: success   is_error: false
AUTH OK — the SDK authenticated with NO ANTHROPIC_API_KEY.
```

## The arm is applied at a proxy, never in the prompt

`bench/lib/proxy.mjs` stands between the agent and Aperture and injects
`observe:"full"` for the re-dump arm. The prompt bytes are identical across arms
and hashed into the report. The proxy also feeds the **shadow model** — the same
`applyObservation` the fidelity bench uses, now extracted to
`bench/lib/streamModel.mjs` and imported by both, so a failure attributed to
`model_bookkeeping` cannot secretly be two parsers disagreeing.

One deliberate deviation, recorded because it is the kind of thing that turns
into a false result: `browser_act`'s description is written in the proxy rather
than forwarded, because Aperture's own says "The result is a DIFF against the
page state you already hold" — true in one arm and false in the other.

## What the guards caught, before any budget was spent

**G2 rejected a task that could not have measured anything.** `inbox-archive`
declared `mustObserve: /Alice Fenn/` — the senders that SURVIVE an archive. They
never appear in a diff, because they never change: nothing restates a row that
was not touched. The information that actually decides that task is which
Archive refs just **died**, and the guard printed the stream that proved it:

```
- e3 removed (was: button "Archive message from Priya Raman about Q3 forecast")
```

**The witness was miscounting, twice.** The scripted solver performs a known
number of actions, so `pageActions` must equal `solve.length` exactly — and it
did not. One click on a checkbox emits both `click` and `input`; Aperture's
`type` focuses the field first. Worse, the witness's input debounce meant a
typed field's event landed *after the next action's click*:

```
+    0ms click  search
+  226ms click  add:usb-c-cable-1m
+  226ms input  search              <- attributed to the wrong act
```

That was corrupting `identity_mismatch` attribution, not merely a count. Fixed
by choosing the attribution event by action kind, widening the settle window
past the debounce, and folding inputs backwards onto their own element. All ten
tasks now report actions == solve steps in both arms.

**A first deduplication rule silently ate real work.** A plain 500ms
same-element window collapsed `steppers-balance`'s three deliberate clicks on
one button into one, printing four actions for seven — consecutive MCP
round-trips land ~350ms apart. Only an `input` folds now; two clicks are two
clicks however fast they arrive.

## Deliberate sabotage — every guard fires

| Sabotage | Result |
|---|---|
| A predicate that always returns true | G1 RED: "SUCCEEDS ON AN UNTOUCHED PAGE" |
| Solver stops one step short | G2 RED, with the fixture's own state printed |
| Solver clicks an element outside the allowed set | G2 RED: "touched 2 element(s) outside the allowed set" |
| `observe:"full"` injection disabled | G3 RED + G5 RED + mustObserve RED + predicate RED |

G3 is now stated as a whitelist — every re-dump observation must be a FULL
SNAPSHOT — rather than a blacklist of known diff shapes. An observation the
shape predicates fail to classify is exactly where a diff would hide.

## Selftest (no API budget)

```
G1 null-agent — every predicate must be FALSE on an untouched page
  todo-complete        todo.html          predicate FALSE  snapshot 1391 chars
  finder-cheapest      finder.html        predicate FALSE  snapshot  826 chars  [collapsed: … 9 more listitems]
  … 10/10 FALSE
G1 PASS

G2 scripted solver
  todo-complete    diff   SOLVED 2 page actions · obs 1F/2D/0N · 1970 chars
  todo-complete    redump SOLVED 2 page actions · obs 3F/0D/0N · 4254 chars
  steppers-balance diff   SOLVED 7 page actions · obs 1F/7D/0N · 3332 chars
  steppers-balance redump SOLVED 7 page actions · obs 8F/0D/0N · 7965 chars
  … 10/10 solved in both arms, every mustObserve matched
G2 PASS
```

## Pilot (8 episodes, real agent) — and the number that matters

```
[  1/8] cart-adjust     diff    PASS wrong=0 steps=5 obs=1F/3D/1N · 2309ch · $0.0830 · 19s
[  2/8] cart-adjust     redump  PASS wrong=0 steps=4 obs=4F/0D/0N · 4414ch · $0.0982 · 18s
[  5/8] settings-config diff    PASS wrong=0 steps=4 obs=1F/3D/0N · 1317ch · $0.0873 · 19s
[  6/8] settings-config redump  PASS wrong=0 steps=4 obs=4F/0D/0N · 2769ch · $0.0851 · 17s

diff arm   : 2048 chars/episode  (73.7% of observations were diffs)
re-dump arm: 3592 chars/episode        ratio 0.57x
success 4/4 vs 4/4 · wrong-element 0.000 vs 0.000 · $0.0925/episode
RESULT: INCONCLUSIVE (exit 2)   [G8: below the N=5 floor — a PILOT, not a result]
```

**The agent gives back much of the diff advantage by re-snapshotting
voluntarily.** The scripted solver observes 2171 vs 4481 chars on `cart-adjust`
(0.48x); the language model observes 2779 vs 4414 (0.63x), because it takes full
snapshots nobody asked it to take. Intention-to-treat scoring counts those
rescues against the diff arm, which is the honest choice and is production
reality.

**The first pilot tripped G4 at 57.1%**, below the preregistered 60% floor. The
threshold was not touched. Diagnosing it found a fidelity bug in the harness
instead: the proxy's `browser_act` description said "you do not need to call
browser_snapshot after every action" where the product says "That is the whole
point: do not call browser_snapshot after every action" — permissive where
production is imperative, which inflates exactly the behaviour that was
breaching the floor. Restoring the product's own strength (arm-symmetric, so it
cannot bias the comparison between arms) moved the diff share 63.6% → 73.7% and
the cost ratio 0.80x → 0.57x. **This change was made after seeing a pilot
result and is recorded here for that reason.**

Short tasks stay structurally fragile for G4: with three acts, two voluntary
snapshots alone breach the floor. The full run may still abort on G4, and that
would be a real finding about instruction-following, not a harness defect.

## Both arms scored 100% on the pilot tasks — read G10

`tier1.md` flagged the ceiling problem and it is live: a suite both arms solve
every time cannot detect a bookkeeping penalty even if one exists. G10 refuses
to call that PARITY and returns INCONCLUSIVE. Sonnet rather than Opus is the
sensitivity choice already made against this; if the full run ceilings anyway,
the tasks are too easy and the honest response is harder tasks, not a verdict.

## Known limitations, stated rather than papered over

- The SDK exposes no temperature control, only `effort`. Runs are stochastic.
  That affects both arms identically, but a single episode is noise.
- **An `ok click` that did not land.** Once in roughly 450 scripted acts,
  Aperture returned `ok click e6` followed by `(no visible change)` and the
  witness recorded no event at all — the click never reached the button. Not
  reproducible in three cold starts. It is an Aperture-side flake, and the
  concerning half is that the tool said `ok`.
- No fixture forces purely positional identity. `inbox.html` was built for it —
  six identical "Archive" buttons — but the walker's sibling discriminator keys
  each one by its own row's text, so the hazard does not arise. Accessible names
  distinguish them, and `identity_mismatch` therefore has no dedicated fixture.
- `browser_read` is withheld by design; innerText re-reads would route around
  diff bookkeeping and dilute the variable under test.
- Fixtures use `data-bench`, never `data-testid`: `data-testid` is Tier-1 input
  to the identity-key scheme, so using it would change the behaviour being
  measured.

## Running it

```bash
npm run bench:task -- --selftest                      # G1+G2, no API budget
npm run bench:task -- --tasks cart-adjust --n 2       # pilot
npm run bench:task                                    # 10 tasks x N=20 x 2 arms
```

The runner owns its whole world: it refuses to start if 8817 is already in use,
then starts its own Aperture, a `no-store` fixture server on 8899, the witness
collector on 8898 and the MCP proxy on 8896, and tears all of it down on exit.

---

# Update 2026-08-01: adversarial review of `select`, and the guard probe it produced

Three reviewers went at the `select` action, the task-success harness, and
everything previously green. They landed seven findings. **All seven were real
and all seven are fixed.** Nothing was deferred and nothing was refuted — this
is the first review pass here where the reviewers were right about everything
they claimed.

## The measurement that matters: a new live probe, run before and after

These findings are about *refusals* and *retractions*, not about diff fidelity,
so they do not belong in a fidelity scenario. `bench/guards.mjs` and
`test/fixtures/guards.html` measure them directly, against the fixture's own
change-event log rather than against Aperture's own report — an `error:` reply
is not evidence that nothing was written.

The probe was run against the **pre-fix build** (source stashed, rebuilt) and
then against the fixed one. Same probe, same fixture, same machine:

```
                                                       pre-fix   fixed
G1a  removed <div> retires the refs inside it            FAIL     PASS
G1b  the mechanical reader drops them                    FAIL     PASS
G2   a country->state cascade updates [N options]        FAIL     PASS
G3   select refuses a <select disabled>                  FAIL     PASS
G4a  select refuses a select in <fieldset disabled>      FAIL     PASS
G4b  the snapshot line for it SAYS disabled              FAIL     PASS
G5   a blank option query is refused                     FAIL     PASS
G6a  a no-match error is bounded                         FAIL     PASS
G6b  candidate labels are escaped                        FAIL     PASS
G7a  select behind an aria-modal overlay is refused      FAIL     PASS
G7b  and succeeds once the overlay is gone (control)     PASS     PASS

pre-fix: 1/11 · fixed: 11/11
```

The witness lines are the part worth reading. Pre-fix, after seven calls
Aperture had answered `ok` to, the page's own event log read:

```
witness: country=US locked=b grouped=y ship= ship=ovn ship=ovn
```

`locked=b` is a `change` event on a `<select disabled>`. `grouped=y` is one on a
select inside `<fieldset disabled>`. `ship=` is a field reset to its placeholder
by a whitespace-only query. The last `ship=ovn` was written through a
full-viewport `aria-modal="true"` overlay. No human and no CDP input path can
produce any of those four. Post-fix the same sequence leaves `country=US` and
nothing else until the overlay is dismissed.

## Finding by finding

**1. A removed subtree orphaned every ref inside it unless its root happened to
be addressable.** `diff.ts`'s removal loop bailed on `if (!ref) continue` BEFORE
the descendant-`gone` walk. `generic` and `listitem` are not in `ADDRESSABLE`,
so removing a `<div>` panel or an `<li>` row retired nothing: no report, no
`markDead`, refs left `live` forever. The descendant walk now runs first, and a
new `gone` op (rendered `- gone: e2 e3`) carries the deaths when there is no
addressable root to hang them off. The original fix only ever covered
`selects.html`'s shape, where the removed root is a `<ul role=list>` and
therefore addressable.

**2. `select` bypassed the obstruction hit-test.** The design's reasoning — "it
needs no coordinates, so it needs no hit-test" — is right about coordinates and
wrong about *reachability*: `resolveRef` is the only thing in the codebase that
refuses an action because something covers the target. Every element-targeted
action now passes that gate, `select` included. What survives of the original
call is the part that mattered: `select` takes nothing from the resolve but the
answer, dispatches no CDP input, and stays on the IPC path.

**3. `select` wrote through disabled selects.** `matchOption` refuses a disabled
OPTION on the rule "a human cannot choose it, so neither can we"; the rule was
never applied one level up. Two halves, and the second is worse: `statesOf` read
only `el.disabled`, which is `false` for a control disabled by an ancestor
`<fieldset disabled>`, so the snapshot line carried **no** disabled flag and the
agent could not even see why the action should fail. Both fixed — the walker now
consults `:disabled`, which is the platform's own answer to "is this actually
disabled" and the only one that accounts for the ancestor.

**4. `[N options]` and the inline enumeration were never diffed.** `propDelta`
does not compare `optionCount`, and a removed synthetic option emits nothing
because it has no ref. A native select's option list is now treated as a
property of the select: when the LIST turns over — not when the selection moves
— the select is restated as one `replace`. Cheap, because a long select restates
as a single line.

**5. Select error paths emitted unbounded, unsanitized page text.** `describe()`
applied neither `quote()` nor any cap, and the candidate list was uncapped.
Measured here on a page whose whole snapshot is under 800 chars: a single
no-match error cost **12,408 chars**, and the reviewers measured 20,380 and
36,031 on theirs. The same call now costs 636. `quote()` also closed the
forgery: a label of `Beta" [disabled] and "Gamma` used to render as a second,
differently-named, apparently-unusable option, and bidi overrides passed through
untouched while the snapshot line for the SAME option escaped them correctly.

One thing the cap broke, and a second change fixed: `browser_read` on a select
is the ONLY way to see inside a long dropdown, and a label truncated to 80
characters with an ellipsis matches no tier — it makes the option permanently
unselectable. That listing uses `quoteFull` (neutralized, not capped) and relies
on its own `maxChars` bound. Errors keep the cap, because an error has no such
bound and a page must not get to choose how many tokens its own text costs us.

**6. A blank option query selected the placeholder.** Only the prefix tier was
guarded, so an empty query hit the exact-VALUE tier against the
`<option value="">` that heads most country, state and title pickers — silently
resetting a field the human then submits. The unit test that looked like it
covered this passed for the wrong reason: its fixture gave every option a value
equal to its label, so no option had an empty value. `blank-query` is now its
own refusal, distinct from `empty` ("this select has no options"), because the
agent's remedy differs.

**7. No unicode normalization before matching.** Fail-safe, but the no-match
suggestion then names a label that is screen-identical to the query, which is a
loop the agent cannot get out of. `norm()` now applies NFC. Canonical
equivalence can only merge spellings of the same string, so it cannot promote a
near-miss into a match.

**`reapExcept` was dead code** — one grep hit, the definition — and read as a
second net under the diff's bookkeeping. It was not one and must not become one:
a full snapshot's lines are subject to run collapsing and the budget cut, so
"absent from this snapshot" does not mean "absent from the page", and reaping on
that basis would kill refs the agent can still legitimately act on. Deleted,
with the reasoning recorded where it stood.

## The benches were structurally blind to two of these, and are not now

The shared reader required a role-plus-ref prefix to parse a line at all, so
`[N options]` fell off the end of the state-word loop and was dropped on the
floor. A stale marker could never turn a scenario red, however wrong the agent's
belief about the list. The reader now parses `optionCount` and understands
`- gone:`; `fidelity.mjs` compares markers against the truth snapshot and prints
`WRONG [N options] MARKERS`. All five scenarios report 0.

## Full verification after the fixes

```
npx tsc --noEmit -p tsconfig.json        clean
npx vitest run                           283 passed (11 files)
npx electron-vite build                  ok

bench:fidelity form       GREEN  18/18 refs · 13 diffs + 1 resync · 0 wrong markers
bench:fidelity rerender   GREEN  17/17 refs · 3 diffs
bench:fidelity widgets    GREEN   6/6  refs · suppression seen
bench:fidelity biglist    GREEN  71/71 refs · resync fired
bench:fidelity selects    GREEN   7/7  refs · 8 diffs
bench/guards.mjs          GREEN  11/11 guards (1/11 on the pre-fix build)
npm run bench             ok     6.6x-10.2x, unchanged
npm run bench:task --selftest   G1 PASS · G2 PASS · no API budget spent
```

## Running the guard probe

```bash
npx http-server test/fixtures -p 8899 -c-1 --silent &
npx electron . > /tmp/ap.log 2>&1 &
sleep 15
TOK=$(grep -oE "Bearer [A-Za-z0-9_-]+" /tmp/ap.log | head -1 | cut -d' ' -f2)
npm run bench:guards -- "$TOK"      # optional 2nd arg: fixture base URL
```

Exit 0 all guards hold · 1 a guard failed · 3 the probe could not run.

## What this pass does NOT close

- **The obstruction gate is exercised only by this probe.** `fidelity.mjs` never
  raises a modal, so a regression in the hit-test itself would still go
  unnoticed by the standing five scenarios.
- **`[N options]` staleness is now measurable but only exercised on the guard
  fixture.** No fidelity scenario contains a dependent select; the `selects`
  scenario's lists never change size.
- **Optgroup labels are still passive.** `describe`'s group line is quoted now
  but still never matched — qualified queries remain deferred.
- **Only `:disabled` is consulted, not `inert` or `pointer-events: none`.** A
  select inside an `inert` subtree is still writable by `action:"select"`; the
  hit-test catches the overlay case but not that one.

---

# Task-success, wave 1 — 100 episodes, Sonnet 5 (2026-08-01)

`node bench/task.mjs --n 5` · N=5/task/arm across all 10 tasks · $11.03 · exit 2

## RESULT: INCONCLUSIVE (ceiling), and a cost result nobody ordered

```
success  diff    : 50/50 = 100.0%   wrong-element 0.000/run
success  re-dump : 50/50 = 100.0%   wrong-element 0.000/run
delta            : +0.0pp  95% CI [-7.1pp, +7.1pp]  (Newcombe)
```

G10 fired: both arms ≥98%, so the suite **cannot** detect a diff-bookkeeping
penalty even if one exists. Preregistered rule says INCONCLUSIVE licenses no
README claim, and it doesn't. Smallest true drop this run could distinguish
from the parity margin: **~15.5pp**. Anything subtler is invisible here.

Zero wrong-element actions in 372 page actions across both arms is worth
noting but is not a finding — it is what a ceiling looks like.

## The unordered result: diffs cost MORE here

| | diff | re-dump |
|---|---|---|
| page actions / ep | 3.72 | 3.72 |
| observations / ep | 5.52 | 4.84 |
| observation chars / ep | 2,975 | 4,520 |
| **$ / ep** | **0.1131** | **0.1075** |

Diffs cut observation bytes **34.2%** and still came out **5.2% more
expensive**, because they induced **7.3% more turns** (8.58 vs 8.00). Identical
page actions, so the agent did the same work — it just needed more round trips
to decide on it.

Two mechanisms, both visible in the observation-kind counts
(`diff` arm: 186 diff / 72 full / **18 nochange**; `re-dump` arm: 242 full):

1. **18 `nochange` observations.** A full API round trip that returns "nothing
   changed" — the agent pays a turn to learn nothing. The re-dump arm has no
   such category: its equivalent observation still re-anchors the whole page.
2. **34 more voluntary observations** across 50 episodes. Intention-to-treat
   counts these against the diff arm, correctly: rescues are production reality.

### Why turn overhead wins on this suite

Each turn re-sends the system prompt, the tool definitions, and the entire
history. Saving ~390 tokens of observation while adding 0.58 turns that each
re-send several thousand tokens is a losing trade. **The fixtures are small
(1.4–8.0 KB) — that is the whole explanation, and it is a property of the
suite, not of diffs.** Diffs pay when the observation dominates the per-turn
context; on a 2 KB fixture it never does.

This does not contradict the ~1.9× per-snapshot saving measured on real pages.
It bounds it: **that saving is per-observation, and per-observation is not
per-dollar.** The crossover is a real quantity this suite is on the wrong side
of, and it has not been located.

## What this licenses

Nothing, in the README. Specifically **not**:

- "no correctness penalty" — ceiling-limited to ±15.5pp
- "diffs are cheaper" — on this suite they are 5.2% *dearer*

## What it changes

The ceiling was the anticipated risk and has an anticipated fix (harder tasks
or a weaker model). The cost inversion was not anticipated and is the more
actionable of the two:

1. **Suppress `nochange` round trips.** 18 turns bought nothing. If an act
   produces no observable delta, that belongs in the act's own result, not in a
   separate observation the agent has to spend a turn on.
2. **Locate the crossover.** Fixture page size is the independent variable that
   was never varied. Until it is, "diffs save tokens" has no stated domain.
3. **Then re-run for correctness** on tasks that are not at ceiling.

Item 1 is a product bug this benchmark found. That is the benchmark working.

## Correction to the section above (2026-08-01, same day)

**Mechanism 1 as written is wrong, and the error is mine.** The wave-1 section
says the 18 `nochange` observations were act round trips, and proposes moving a
no-delta result "into the act's own result, not a separate observation." It is
already there. Checked against the episode store rather than against the
write-up:

```
diff arm: pageActions = 186,  kinds.diff = 186   -> equal
```

Every act carried exactly one observation and every one of those was a diff.
`attributions` is `{ok: 372}` — zero errors in either arm. The 72 fulls and 18
nochange are **over and above** the acts: 50 fulls are the mandatory opener
(5 runs x 10 tasks), leaving **40 agent-chosen `browser_snapshot` calls**.

They are not spread evenly. Six of ten tasks took **zero**:

| task | voluntary obs, diff arm | voluntary obs, re-dump arm |
|---|---|---|
| finder-cheapest | 14 | **6** |
| cart-adjust | 13 | 0 |
| inbox-archive | 10 | 0 |
| settings-config | 3 | 0 |
| other six | 0 | 0 |

Two different causes, which the original write-up merged into one:

- **`finder-cheapest` is structural, not defensive** — it is the only task where
  the *re-dump* arm also snapshotted voluntarily, so the cause cannot be diff
  bookkeeping. Diff subtrees render collapsed, so a filtered list arriving via a
  `replace` can hide candidate prices behind `… N more`, and a correct agent
  must then expand. That is an honest, permanent cost of the collapse design.
- **`cart-adjust`, `inbox-archive`, `settings-config` are defensive.** All three
  prompts assert a global invariant ("do not change anything else"). The agent
  re-snapshots to verify a negative, which means it does not trust that anything
  a diff omits is unchanged. **The completeness guarantee is real but never
  stated to the model.**

So the fix is not a wire-format change. It is teaching the guarantee in the tool
descriptions, plus three genuine engine bugs found while confirming this:
`nextDiffSeq()` advances on the empty path (unchanged observations hasten paid
resyncs), `unreadChanges` is hardcoded to 0 (changes in never-rendered regions
report as "no visible change" with no caveat), and the `navigated` check sits
below the early return (a zero-op pushState reports no change).

**What survives unchanged:** the INCONCLUSIVE verdict, the ceiling, and every
number in the tables. **What does not survive at its stated scope: "diffs cost
5.2% more here."** The pooled +5.2% is carried entirely by the four tasks with
voluntary observations, and in the six with none the sign flips:

| subset | diff $/ep | re-dump $/ep | delta | turns/ep |
|---|---|---|---|---|
| 6 tasks, zero voluntary obs | 0.1077 | 0.1123 | **−4.1%** (diff cheaper) | 8.40 vs 8.57 |
| 4 tasks with voluntary obs | 0.1213 | 0.1004 | **+20.9%** | 8.85 vs 7.15 |

The four contribute +$0.419 of gap, the six −$0.138; net +$0.281, so the four
carry the whole inversion and then some. The turn excess is likewise entirely
theirs (+34 turns vs −5). At the suite's sd ≈ $0.026/ep the six-task −$0.0046
is ~0.7 SE from zero — indistinguishable from parity — while the four-task
+$0.0209 is ~2.5 SE. Within the four: cart-adjust +44.6%, inbox-archive +26.3%,
finder +13.7%, settings −2.7%; the three defensive tasks alone (+$0.346) more
than account for the net.

So the pooled +5.2% survives as **arithmetic** and fails as a **finding**. The
correctly scoped version: diff observation was not dearer per se on this suite;
episodes became dearer exactly where the agent bought voluntary snapshots —
three tasks with invariant-asserting prompts (defensive, the untaught
completeness guarantee) and one with collapsed lists (structural, now retired).
Where no voluntary snapshots occurred, diffs were cheaper on fewer turns.
Whether any inversion survives the teaching fix is a wave-2 question.

What also changes is *why* the extra turns happened — agent distrust of an
untaught guarantee, not a round-trip design flaw.

The lesson repeats one line up: the first correction fixed the mechanism and
left the headline claim at a scope the data never supported. **Pooling hid a
sign change.** A number that is right about the aggregate and wrong about every
subset is not a finding, and this one was published twice before anyone split it.

The general lesson is the one this suite keeps re-teaching: **the write-up was
reasoned from the aggregate, and the aggregate was consistent with a story that
the per-episode records refute.** Consistent is not the same as true.

---

# Task-success, wave 2 — 251 episodes, Sonnet 5 (2026-08-01)

`--new-cohort --n 5` then `--n 20` · 7 tasks (3 retained, 4 new) · $37.34 ·
stopped at 251/280 when the apparatus wedged. Full adjudication:
`docs/design/wave2-evaluation.md`. Scoring is out-of-band by necessity: two
wedged episodes trip G3, so `report()` exits 3 INFRA on this store by design —
the suite refuses to score itself, and that refusal is correct.

## Headline (holds under every analysis of the store)

> **On this 7-task bookkeeping-hard suite with claude-sonnet-5, no
> diff-bookkeeping penalty larger than 10pp was found.**

## Primary result (exclusion-conditional, fragile, stated as such)

The final six episodes (#245–250, 3 per arm) recorded zero landed page
actions — Aperture's input path wedged while acks still returned `ok`. Their
exclusion was adjudicated legitimate on three grounds (absent measurements
with two independent witnesses; the terminal-contiguous-block counterfactual;
inclusion itself requires waiving preregistered G3). Over the 245 clean:

```
success  diff    : 120/123 = 97.6%
success  re-dump : 119/122 = 97.5%
success  delta   : +0.0pp   95% CI [-4.8pp, +4.8pp]   (Newcombe)
wrong-el delta   : +0.03/run  95% CI [-0.04, +0.12]   (bootstrap, seeded)
```

Primary rule: CI lower −4.75pp ≥ −5pp AND wrong-el upper +0.12 ≤ +0.2 →
**PARITY**, clearing the margin by 0.25pp. With the six included, only the
secondary holds. The exclusion decision decides the verdict class; the
headline above is therefore the secondary sentence, not this one.

> "On this 7-task fixture suite, with claude-sonnet-5, agents observing via
> diffs completed tasks +0.0pp as often as agents observing via full re-dumps
> (95% CI [−4.8pp, +4.8pp]), with +0.03 wrong-element actions per run
> (95% CI [−0.04, 0.12]), at 0.67x the observation cost."
> It says nothing about other models, real websites, longer tasks, larger
> pages, the budget-truncation regime, browser_read workflows, or iframes.

Margin provenance: the −10pp secondary was added 2026-08-01, after wave 1
returned INCONCLUSIVE and before any wave-2 episode ran; the −5pp primary is
unchanged from tier1.md §3. MDE at this n: ~12pp — a true penalty smaller
than that is invisible to this sample. The 29-episode shortfall costs ~0.6pp
of CI width and no verdict class; the stop was apparatus-forced, not
data-driven.

## Disclosures

- **Cost:** the wave-1 inversion narrowed but did not close: $0.1476 vs
  $0.1395/ep (+5.8% for diffs) at 0.67x observation bytes. The tier1b
  teaching measurably moved behavior — voluntary obs 0.80 → 0.58/ep,
  nochange 0.36 → 0.28/ep, diff share 73.7% → 82.3% — directionally right,
  incomplete. The crossover remains the size sweep's question.
- **One task carried all signal.** All 12 wrong-element acts and all 6 clean
  failures are `queue-positional` (15/18 vs 14/17, CI [−24.3, +26.7]pp); the
  other six tasks went 210/210. $26.73 of $35.17 bought ceiling episodes.
  Wave 3 inverts the mix (see wave2-evaluation §4).
- **G9 blind spot:** every episode's usage includes the SDK's auxiliary
  Haiku model alongside Sonnet (251/251, arm-symmetric). No bias, but G9
  only checks the requested model appears — it cannot catch a partial
  wrong-model serve.
- **The wedge** (input path dead, acks alive, walker timeouts; occlusion
  hypothesis falsified by live probe; root cause undecidable — child log was
  discarded). Shipping fix W1 and instrumentation are specced; the wedged
  episodes' `engine_ref_loss` counts are partly misattributed invalid-argument
  errors, also specced.

What wave 2 can never settle: sub-12pp penalties, unconditional −5pp parity,
this occurrence's wedge root cause, and the pre-P1 queue wrong-element ratio —
that question dies with the cohort by design.


---

# Task-success, wave 3 — 230 episodes, Sonnet 5 (2026-08-01/02)

`--new-cohort --n 5` (pilot) then `--n 35` (interim TRIM) · 3 discriminative
tasks x 35/arm + 2 canaries x 5 · $76.91 against the $85 cap · zero wedged
episodes · canaries 20/20 · full adjudication: `docs/design/wave3-evaluation.md`.

**Wave 3 — PASS.** "On this 3-task positional-identity suite (post-P1
engine) with claude-sonnet-5, no diff-bookkeeping penalty larger than 10pp
in task success or +0.4 wrong-element actions per run was found."
At n=105/arm the smallest true drop this run could distinguish from the
−10pp bound is about 23.5pp. Margin clearance: success CI lower −7.0pp
clears the bound by +3.0pp; wrong-element CI upper +0.286 clears +0.40 by
0.114/run.

MARGIN PROVENANCE. The −10pp bound is wave 3's preregistered PRIMARY and is
the same number wave 2 carried as a secondary; it was frozen before any
wave-3 episode ran (run-log preregistration block, printed before the
pilot). The wave-2 −5pp/"parity" vocabulary is retired — unreachable at
any affordable n off the ceiling, and wave 2 cleared it by 0.25pp only via
a post-hoc quarantine. The +0.4/run wrong-element bound replaced the pooled
+0.2/run with the arithmetic in wave2-evaluation §4.2. The realized n is
105/arm, not the designed 135: the preregistered interim rule fired TRIM at
the pilot ($0.374/ep > $0.35, a cost condition, blind to the arm delta) and
capped later phases at −−n 35. At the observed rates that widened the CI
half-width to ~12.6pp against the ~9.8pp projected at full quotas; the PASS
stands on the realized interval, not the projection.

Disclosures, all mandatory beside any citation:
1. `report()` exits 3 INFRA on this store: G3 reads one re-dump observation
   as arm contamination. The observation is a 26-byte engine validation
   error (`error: unsupported key: F5`) carrying zero page bytes, produced
   on a dispatch-free code path the arm forcing never touches; the ruling
   and spec fix are in wave3-evaluation §1. This verdict is computed out of
   band with the suite's own stats code; the verdict class is PASS under
   every disposition of that episode (included / excluded / flipped to
   success).
2. Direction: the point estimates favor diffs (+5.7pp success, −0.21
   wrong-el/run, fewer wrong-element on all three tasks), but every CI
   includes zero. Directional colour, not a finding; the licensed claim is
   the bound above and nothing stronger.
3. Cost: the diff arm cost MORE in dollars — $0.3622 vs $0.3470/episode
   (+4.4%) at 0.73× the observation bytes (11,075 vs 15,240 chars/ep). The
   wave-1/-2 inversion persists at ~3× wave-2's observation volume; the
   crossover remains the size sweep's question (§4).
4. Canaries 20/20 in both arms. They license exactly one sentence: the
   apparatus and easy-task floor held. Their numbers appear in no claim.
5. Apparatus: zero wedged episodes; G6b quiet; zero truncated observations;
   zero dead clicks/types (six no-page-effect scrolls, witness-silent by
   design). The single GPU-pid transition in the report is the pilot→full
   app restart between two Aperture instances, not a crash (wave3-evaluation
   §0.1); within each instance the GPU process creationTime is constant
   across all 230 samples.
6. Comparisons with wave 2 are directional narrative only — different
   engine (post-P1), different tasks, never pooled, never CI'd.

---
