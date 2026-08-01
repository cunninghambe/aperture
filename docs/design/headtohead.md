# Head-to-head: Aperture vs Playwright MCP — design of record

Architected 2026-08-01, while the wave-2 task-success cohort is **running**.
Decision-complete: every load-bearing call is made here with its reasoning; an
implementer should not need to choose anything, and a reviewer should be able
to tell a deviation from a decision. Everything about Aperture below was
written after reading the code (`bench/task.mjs`, `bench/tasks.mjs`,
`bench/lib/proxy.mjs`, `bench/lib/collector.mjs`, `bench/fixtures/bench.js`,
tier1/tier1b/tier2, RESULTS.md with both corrections); everything about
Playwright MCP was verified against the **published `@playwright/mcp@0.0.78`
tarball** and the `microsoft/playwright` source at main, not against blog
posts — with the un-verifiable residue named in §12.

**Standing constraint while the wave runs:** this file is the only file this
design touches. No watched-file edits, no rebuild (`buildVersion` hashes all
of `out/main/index.js`), no use of ports 8817/8896/8898/8899. §10 partitions
the implementation around that.

---

## 0. The question, and the shape of the answer

For a user choosing how to give an LLM a browser: **does Aperture's
diff-based observation actually beat the incumbent, and on what axis?**

The axes are fixed now, because "beat" is exactly the kind of word that gets
retrofitted to whatever number came out best:

| axis | metric | decidable at this budget? |
|---|---|---|
| reliability | task success per the fixture's own witness | coarsely (±~9pp pooled) |
| precision | wrong-element actions per run, witness-scored | yes (margin +0.2/run) |
| economics | dollars and tokens per episode, per page-size class | yes (cost CIs are tight) |
| felt latency | wall-clock | reported, never verdicted (§2) |

Two prior results bound what to expect and are the reason the design looks
the way it does: RESULTS.md measured Aperture snapshots **~1.9× smaller than
playwright-mcp's** on four real sites (per-observation, not per-dollar), and
wave 1 measured that per-observation savings can invert into a per-dollar
LOSS via extra agent turns on small pages. So the economics question is not
"are diffs smaller" (settled) but "does the saving survive a real agent,
end-to-end, against the real incumbent, at realistic page sizes" — and the
reliability question is whether the diff bookkeeping that saving requires
costs correctness the incumbent's re-dump architecture doesn't pay.

---

## 1. The competitor, as it actually is (verified 2026-08-01)

Pinned version: **`@playwright/mcp@0.0.78`** (latest; published 2026-08-01).
The npm package is a thin shim — the implementation lives in
`playwright-core/lib/coreBundle` (dependency pinned by the package itself to
`playwright 1.62.0-alpha-1783623505000`). Facts below were read from the
0.0.78 tarball's generated README (tool tables and option tables are
generated from source by `update-readme.js`) and from
`packages/playwright-core/src/tools/backend/response.ts` at main.

### 1.1 Architecture: it is a re-dump product

Verified in `response.ts`: interaction tools (`snapshot.ts`, `keyboard.ts`,
`mouse.ts`, `navigate.ts`, `files.ts`, `tabs.ts`, `wait.ts`) call
`response.setIncludeSnapshot()`, which resolves to
`config.snapshot?.mode ?? 'full'` — **every action response embeds a full
aria snapshot of the page by default**. There is no diff mechanism anywhere
in the response path. `--snapshot-mode <full|none>` is the only knob: `none`
removes the snapshot entirely (the agent must then call `browser_snapshot`
explicitly — a strictly worse re-dump, not a diff).

Response format (from `_build()`): markdown sections in order —
`### Error`, `### Result`, `### Ran Playwright code` (suppressible with
`--codegen none`), `### Open tabs`/`### Page` (URL/title/console counts,
rendered on change), `### Modal state`, `### Snapshot` (the aria snapshot in
a ```yaml fence), `### Events`. Refs render as `[ref=eN]` inside the
snapshot; action tools take `target` = "Exact target element reference from
the page snapshot, **or a unique element selector**".

So the two products are, by architecture, the two arms the existing suite
already runs: Aperture ships the diff arm, Playwright MCP ships the re-dump
arm — with a different snapshot dialect, different ref discipline, and a
different action stack. That correspondence is what makes a controlled
comparison possible at all.

### 1.2 The core tool surface (default, no --caps)

`browser_click`, `browser_type`, `browser_press_key`, `browser_hover`,
`browser_drag`, `browser_drop`, `browser_select_option`, `browser_fill_form`,
`browser_file_upload`, `browser_handle_dialog`, `browser_navigate`,
`browser_navigate_back`, `browser_snapshot`, `browser_find`,
`browser_take_screenshot`, `browser_console_messages`,
`browser_network_requests`, `browser_network_request`, `browser_evaluate`,
`browser_run_code_unsafe`, `browser_wait_for`, `browser_resize`,
`browser_tabs`, `browser_close`. Opt-in via `--caps`: vision (mouse_* by
coordinate), pdf, devtools, config, network (route mocking), storage,
testing (verify_* assertions).

### 1.3 The escape hatches — the brief's central worry, confirmed

The original design rejected Claude Code headless because filesystem tools
would let the agent read fixture HTML from disk and bypass observation.
Playwright MCP ships **four** analogous escapes, in core, on by default:

1. **`browser_evaluate`** — arbitrary JS in the page. Reads any DOM state,
   drives any mutation, without ever touching the observation channel.
2. **`browser_run_code_unsafe`** — its own description says it: "executes
   arbitrary JavaScript in the Playwright server process and is
   RCE-equivalent." That is Node, on the bench machine — it can read the
   fixture HTML **from disk**. The Claude-Code-headless objection, reborn
   inside the competitor's own surface.
3. **`browser_network_request`** — returns full response bodies. Two
   distinct kills: the page's own document request IS the fixture source;
   and — sharper — **the witness itself is visible**: every fixture posts
   its full ground-truth state to `127.0.0.1:8898/e`, so the network log
   contains the answer key verbatim.
4. **Selector targeting** — `target` accepts a CSS/text selector, so the
   agent can act on elements it never observed. Not disableable by config.

How each is neutralised is specified per-arm in §3. The one-line summary:
1–3 are withheld in every arm (with the deviation disclosed), 4 is blocked
by ref-grammar enforcement in the sealed arm and left in — measured and
reported — in the stock arm.

### 1.4 A fact that reframes the stakes

The 0.0.78 README's own opening section now recommends **against** MCP for
token-sensitive agents: "Modern coding agents increasingly favor CLI-based
workflows exposed as SKILLs over MCP because CLI invocations are more
token-efficient: they avoid loading large tool schemas and verbose
accessibility trees into the model context" — steering users to
`playwright-cli` + skills, and positioning MCP for "specialized agentic
loops … where maintaining continuous browser context outweighs token cost
concerns." The incumbent has publicly conceded the axis Aperture attacks.
This benchmark measures Aperture against **Playwright MCP**, the like-for-like
MCP incumbent; it does not measure the CLI mode, and §11 names that as the
strongest external threat to the comparison's relevance.

---

## 2. Ruling on the metric: wall-clock is reported, never primary

**The user's wall-clock proposal is rejected as a primary metric.** Reasons,
from measured data rather than taste:

1. At wave-1 scale an episode is ~19–25s over ~8.6 SDK turns. The browser's
   own work is sub-second per action (the proxy's settle window alone is
   260ms; Aperture act round trips are a few hundred ms). The dominant terms
   are model inference and API queueing — **time mostly re-measures tokens
   plus provider-side noise that is uncorrelated with the tool under test**
   and not reproducible across days.
2. Time cannot be pooled or resumed across phases honestly (an episode run
   during a rate-limit spike is not the same measurement), while tokens,
   turns and witness outcomes are stable under resumption — and the whole
   harness is built around resumable phased runs.
3. The part of felt latency that IS attributable to the tool — payload size
   inflating time-to-first-token per turn, extra turns adding whole
   round-trips — is exactly what tokens and turns already measure, with far
   tighter CIs.

**Primary metrics, preregistered:** task success (witness predicate),
wrong-element actions per run (witness-scored), dollars per episode
(`total_cost_usd` from the SDK) with input/output/cache token components
(`modelUsage`), SDK turns, and observation chars per episode. **Wall-clock
is reported honestly** because it is what a user feels: median and IQR per
arm per size class, plus a decomposition the harness must record to make the
report non-misleading — per-call upstream latency (`upstreamMs`, measured at
the proxy around the upstream call) so browser time and model+API time are
separated. Wall-clock feeds no verdict, and the report must say in one
sentence why: "at these episode lengths, wall-clock differences are
dominated by API queueing noise; the attributable component is the token and
turn deltas reported above."

---

## 3. Arms and tool-surface parity

### 3.1 The parity problem, decided

A comparison where one side has more affordances measures the affordances.
A comparison where the incumbent is amputated measures our amputation. Both
criticisms are correct, so **both configurations run**, with the headline
preregistered:

| arm | surface | observation | what it measures |
|---|---|---|---|
| `aperture-diff` | sealed 3-tool (`browser_act`, `browser_snapshot`, `task_done`) | Aperture default: diffs | the product as the existing suite seals it |
| `aperture-redump` | same 3-tool | `observe:"full"` forced at proxy | decomposition control (§3.5) |
| `pw-sealed` | same 3-tool names/schemas, shimmed onto Playwright MCP | Playwright default: full aria snapshot per action | **the headline opponent**: the incumbent's observation channel behind an identical affordance set |
| `pw-stock` | Playwright core surface minus the escapes (§3.4) + `task_done` | Playwright default | the incumbent as a user actually deploys it; the affordance dividend |

**The headline comparison is `aperture-diff` vs `pw-sealed`.** WHY: with the
affordance set held identical, the remaining difference is the thing the
project claims matters — the observation channel each product ships (diff
stream + persistent identity refs vs full re-dump + per-snapshot refs),
plus each engine's action-execution quality, which is inseparable from the
product and honestly part of "choose one." `pw-stock` is secondary: it
answers the deployment question ("would I actually be better off with stock
Playwright MCP?") and bounds the sealing's cost to the competitor — if
`pw-stock` beats `pw-sealed` materially, the sealed comparison undersold the
incumbent and the report must say so (§7.4).

### 3.2 The sealed surface, exactly

The sealed proxy (new code, §8) registers the same three tools in all three
sealed arms, with **byte-identical names and input schemas** (the current
`bench/lib/proxy.mjs` schemas, verbatim: `browser_act` with
action ∈ {click, type, hover, scroll, key, clear}, ref, text, key, deltaY,
submit; `browser_snapshot` with mode/budgetTokens/expand; `task_done` with
note). The agent cannot tell which product it is driving except by what
comes back — which is the variable under test. The MCP server is named
`browser` in every arm (the SDK's `mcpServers` key), so tool ids are
`mcp__browser__browser_act` etc. everywhere and the model never sees a
product name.

**Shim mapping for `pw-sealed`** (every row is a decision):

| sealed call | Playwright MCP call | notes |
|---|---|---|
| `act click ref` | `browser_click { target: ref }` | `element` param omitted (it exists for permission UIs) |
| `act type ref text submit` | `browser_type { target, text, submit }` | pw default is fill-at-once; that IS its shipped typing |
| `act clear ref` | `browser_type { target, text: '' }` | fill semantics make this exact |
| `act key key` | `browser_press_key { key }` | |
| `act hover ref` | `browser_hover { target: ref }` | |
| `act scroll deltaY` | `browser_mouse_wheel` at viewport centre (`--caps=vision`, sealed arm only) | keeps the harness's absolute rule that **nothing ever calls `browser_evaluate`**, not even internally — an integrity story with no exceptions is auditable; no fixture requires scrolling (H-preflight asserts scripted solvers never scroll) so this affordance is expected dead in practice, and agent scroll use is recorded per arm |
| `browser_snapshot *` | `browser_snapshot {}` | `mode`/`expand`/`budgetTokens` are Aperture semantics; pw is always full, never collapsed, never budgeted, so `full` is honoured, `auto` upgrades to full, `expand` is vacuously satisfied, `budgetTokens` is ignored. Documented in the run log, not silently |
| `task_done` | handled at the proxy, never forwarded | same as today |

**Ref-grammar enforcement:** the shim refuses any `ref`/`target` not
matching `/^e\d+$/` with the error
`error: "<value>" is not a known element ref` — otherwise §1.3's escape #4
re-enters through the sealed schema (an agent passing a CSS selector as a
"ref"). Aperture rejects non-refs natively; this makes the refusal
symmetric.

**Playwright launch configuration, sealed arms** (recorded verbatim in
every episode): `--isolated --browser chromium --caps vision
--codegen none --snapshot-mode full --output-dir <scratch>
--viewport-size 1280x720 --allowed-origins
"http://127.0.0.1:8899;http://127.0.0.1:8898"`. Headed (default), because
Aperture is headed — symmetric rendering environments. `--codegen none` is a
shipped configuration switch, chosen because the "### Ran Playwright code"
section is codegen tutoring for a workflow this agent cannot use (it has no
code execution), and its tokens are overhead orthogonal to observation. The
allowed-origins list **must** include 8898 or the witness dies silently —
preflight H2 exists to catch exactly that misconfiguration.

**Stale-behaviour note:** whether a pw ref from snapshot N still resolves
after the page changed, and the exact wording of its stale-ref error, could
not be verified offline (§12). The preflight records both by probing (click
a ref, mutate the page, act on the dead ref, capture the reply verbatim).
Nothing in scoring depends on the answer — errors are errors in both arms —
but the report must quote the actual behaviour rather than assume it.

### 3.3 The tool descriptions, exactly

The arm must be invisible AND no description may lie in any arm — the two
constraints that produced `proxy.mjs`'s existing deviation note. Decisions:

- **`browser_act` description, one neutral text, byte-identical across all
  four arms (pw-stock excepted — it doesn't have this tool):**

  ```
  Click, type, hover, scroll, or press a key on the page, then observe what
  changed.

  The browser reports the result of each action for you. That is the whole
  point: do not call browser_snapshot after every action. The report after
  each action is complete: anything it does not mention is unchanged. Do not
  call browser_snapshot to re-verify what a report already told you — it
  will return nothing new.

  Input is dispatched as real browser input, so framework handlers, native
  widgets and validation behave exactly as they do for a human.
  ```

  Changes from the existing `ACT_DESCRIPTION` and WHY: "Aperture reports…"
  → "The browser reports…" (no product names anywhere the model can see);
  the stale-ref recovery sentence is **dropped** because it is verified true
  for Aperture and unverified for Playwright, and a description that may lie
  in one arm is the exact defect the proxy's own header comment exists to
  prevent. The imperative "That is the whole point: do not call
  browser_snapshot after every action" is **kept at product strength** — the
  pilot measured that weakening it moves behaviour (G4 63.6%→73.7%). Every
  sentence retained is true in all arms: in pw arms the "report" is a full
  snapshot, for which completeness is vacuously true; in the aperture arms
  it is the diff/unchanged contract.

- **`browser_snapshot` description: forwarded verbatim from each product.**
  Aperture's carries its format legend; Playwright's is its own one-liner.
  WHY asymmetric bytes are correct here: the observation channel's
  self-explanation is part of the observation channel — stripping Aperture's
  legend would break its format contract, and writing Playwright a legend it
  doesn't ship would be coaching the competitor with our prose (or
  sabotaging it with bad prose; either way, not its product). Both
  description texts are hashed into the run identity and printed.

- **`task_done`:** existing `DONE_DESCRIPTION`, unchanged, all arms.

- **System prompt:** the existing `SYSTEM_PROMPT` from `bench/task.mjs`,
  byte-identical across `aperture-diff`, `aperture-redump`, `pw-sealed`
  (it says "exactly three tools", which is true for all three). `pw-stock`
  gets the minimal truthful variant — same text with the tool sentence
  replaced by: `You have a set of browser tools and task_done. There is no
  filesystem, no shell and no other tool.` and "Act on elements by their ref
  (the eN codes)" retained (true: pw refs are eN). Both prompts hashed and
  printed; the asymmetry is inherent to measuring a different surface and is
  stated in the report.

Note what this implies and is accepted: `aperture-diff` episodes here are
**not poolable with the wave-2 cohort** (different act description, different
harness) — the head-to-head is its own experiment with its own store (§8).
Wave-2 numbers may be cited beside it, never pooled.

### 3.4 `pw-stock`, exactly

The proxy forwards, **verbatim from Playwright's own `tools/list`** (names,
schemas, descriptions untouched), the core surface minus:

| withheld | reason (each is a §1.3 escape or a harness-integrity need) |
|---|---|
| `browser_evaluate`, `browser_run_code_unsafe` | observation bypass; the second is also disk access to fixtures — the vector the whole methodology exists to exclude |
| `browser_network_requests`, `browser_network_request` | fixture source AND the witness's answer key are in the network log |
| `browser_take_screenshot` | a second observation channel (vision) — a different experiment; Sonnet can read images, so leaving it in confounds the text-observation comparison |
| `browser_tabs`, `browser_close`, `browser_resize` | harness integrity: multi-tab witnesses are unattributable, close ends the session outside `task_done`, resize breaks the pinned symmetric viewport |

Kept, deliberately, including things Aperture's sealed surface lacks:
`browser_navigate`/`browser_navigate_back` (restricted by
`--allowed-origins` to the fixture and collector origins; re-navigation
resets fixture state — a real consequence of a real affordance),
`browser_find` (an honest observation-economics affordance),
`browser_fill_form` (pw's genuine multi-field dividend),
`browser_select_option`, `browser_drag`, `browser_drop`,
`browser_file_upload`, `browser_handle_dialog`, `browser_wait_for`,
`browser_console_messages` (all inert on these fixtures but part of the
shipped surface and its schema-token cost). Launch flags as §3.2 but **no
`--caps vision`** and **default codegen** (typescript): stock means the
default experience, and the codegen tokens are part of what stock costs; the
report's decomposition separates them (§7.3).

Selector targeting stays in `pw-stock` (not disableable, and honestly part
of the shipped affordance set). The proxy records, per act, whether `target`
matched `/^e\d+$/`; the report gives the non-ref-targeting rate. The witness
scores wrong-element actions identically regardless of how the element was
targeted, so the metric survives.

The README sentence for any `pw-stock` claim must carry the qualifier
"with code-execution, network-inspection and screenshot tools disabled" —
preregistered here so it cannot be dropped later.

### 3.5 Why `aperture-redump` is in the grid

Three pairwise comparisons decompose the headline into named causes:
`aperture-diff` vs `aperture-redump` isolates the **diff mechanism** (same
engine, same snapshot dialect); `aperture-redump` vs `pw-sealed` isolates
**engine + snapshot dialect at equal observation strategy** (both re-dump);
`aperture-diff` vs `pw-sealed` is the product headline. Without the middle
term, a headline win is unattributable — exactly the "winning for a reason
other than the one claimed" failure §6's H10 exists to catch. Cost: ~130
episodes, ~$20. Worth it; this is the scientific core of the design.

---

## 4. Task sets, and the home-turf problem

### 4.1 The decision

Two fixture classes, both run, reported separately, never pooled into one
headline number:

1. **Home set (disclosed adversarial):** the 7 wave-2 tasks
   (`bench/tasks.mjs` `TASKS`), byte-identical, imported not copied. These
   fixtures were purpose-built to break **diff bookkeeping** —
   `queue-positional` exists to punish stale-ref assumptions,
   `ledger-balance` gives the re-dump arm free history restatement. They are
   Aperture-adversarial in the correctness dimension and
   Aperture-favouring in none that is obvious — but they encode our
   engine's identity mechanics (rows stripped of ids to force ordinal keys),
   so a skeptic is right that they are not neutral ground **in either
   direction**, and the report labels them "fixtures purpose-built to stress
   diff-tracking failure modes, published with their design rationale."
   What a result here licenses: a claim about **worst-case-for-diffs
   correctness** ("on fixtures built to break diff bookkeeping, X"). What it
   does not license: any claim about typical pages, and no cost claim at all
   (they are all small).

2. **Neutral set (6 new fixtures, 3 small + 3 large):** specified in §4.3,
   authored under the §4.2 protocol. This set carries the headline.

Real live pages are **rejected** as a scored arm: no witness is possible
(ground truth would have to come from a snapshot pipeline — one of which is
under test; the exact circularity this suite's history forbids), content
drifts under the cohort, and interactive tasks against third-party sites are
irreproducible. Real pages stay in what they are already good for: the
standing snapshot-size table (RESULTS.md §A) is cited beside the neutral
results as the size anchor, and the neutral-large fixtures are built to that
measured size band. A WebArena-class dockerised-site arm is named in §11 as
the credible follow-up, not attempted here — its evaluators, task style and
infra are a separate project, and bolting a week of docker onto this
benchmark would guarantee it never runs.

### 4.2 What makes a fixture neutral, checkably

Neutrality cannot rest on authorial intent (the author of this document
knows both tools). It rests on four mechanically auditable properties:

1. **Spec-before-contact:** the six task specs — prompt, predicate, allowed
   set, solve script, size target — are fixed in §4.3 of THIS document,
   committed before any of the six fixtures exists and before either engine
   has ever loaded one. Git history is the proof.
2. **Conventional-markup rules, enforced by a linter**
   (`bench/headtohead/lint-fixtures.mjs`, run in preflight): every
   interactive element has a unique accessible name (the identical-sibling
   construction is the known Aperture-specific trap — banned here, it lives
   in the home set where it is disclosed); form fields have `id`/`name`/
   `<label>` as an ordinary site would; headings and landmarks are present;
   **no `data-testid`** (Tier-1 identity input for Aperture AND Playwright's
   default `--test-id-attribute` — banned symmetrically); `data-bench`
   witness ids only (inert to both engines — verified for Aperture's walker,
   asserted for Playwright by its README's testid default); no native
   `<select>` (the sealed schema has no select action; symmetric absence);
   no vocabulary from either tool's internals in ids, classes or comments.
3. **Freeze-and-changelog:** fixture hashes are recorded in the store's
   cohort file before the first scored episode. G1/G2-class preflights DO
   drive fixtures with both engines before scoring — that is unavoidable and
   correct (an unsolvable fixture measures nothing) — so post-first-contact
   edits are permitted **only** to restore mechanical solvability, and every
   one lands in `bench/headtohead/FIXTURE_CHANGELOG.md` with a diff summary.
   An edit that adds difficulty after first contact voids the fixture's
   neutrality claim; the changelog is how a skeptic checks.
4. **Task shapes from a public taxonomy:** each spec names its Mind2Web-
   style category (form completion, filter-and-pick, dependent controls,
   content-grounded entry, iterative adjustment, locate-and-act) rather than
   being invented around either engine's mechanics.

**Size classes**, because §0's cost question flips with page size and a
benchmark confined to 1–2KB fixtures would stack the economics against the
diff mechanism (wave 1 proved exactly that): small ≈ wave-1 class (~300–600
snapshot tokens), large targeted at the **measured real-page band** — full
Aperture snapshot 5,000–9,500 tokens (GitHub-repo to Hacker-News size,
RESULTS.md §A). Large-fixture bulk is realistic and **addressable** (nav
links, tables, article links — real pages carry hundreds of refs; HN has
233) but static — it never mutates, so it appears in every pw re-dump and in
zero Aperture diffs. That asymmetry is not a thumb on the scale; it is the
mechanism under measurement, and it is exactly what a real page does. Bulk
is produced by a seeded generator with a distinctive word list so the
preflight can assert no diff ever names bulk content (§6 H-preflight 6).

### 4.3 The six neutral task specs (fixed here, before any fixture exists)

Common to all: witness pattern identical to the existing fixtures (fixture
registers a state function; capture-phase listeners report `data-bench`
actions; predicates read collector state only). `mustObserve` regexes are
checked against the **aperture-diff** scripted stream (as today) and, new,
against the concatenated pw-sealed observation stream (H3) — proving the
deciding information travels through each product's observation channel.

**T1 `booking-form` (small; form completion).** Service-booking form: name,
email, phone, notes (free text, NOT in allowed), radio slot group Morning/
Afternoon/Evening, checkbox "Send confirmation by email", Book button;
submit replaces the form with a confirmation panel. Prompt: `Book an
appointment on this page. The name is Alex Morgan, the email address is
alex.morgan@example.com, the phone number is 555-0142, the preferred slot is
Afternoon, and ask for email confirmation. Then submit the booking.`
allowed: `name,email,phone,slot-afternoon,confirm-email,submit`. Predicate:
`submitted===true && name==='Alex Morgan' && email==='alex.morgan@example.com'
&& phone==='555-0142' && slot==='afternoon' && confirm===true`.
mustObserve: `/Booking confirmed/`. solve: 3 types, 3 clicks. maxSteps 12.

**T2 `inventory-pick` (small; filter/locate-and-pick).** Requisition page:
two headed groups (Fasteners ×5, Adhesives ×5), each row a distinctly named
part with visible price and an "Add <part> to requisition" button; a
quantity stepper ("Increase <part> quantity") appears on added rows.
Prompt: `Add the cheapest part in the Fasteners section to the requisition,
then set its quantity to 3.` allowed: `add:hex-bolt, inc:hex-bolt`.
Predicate: requisition exactly `[{part:'hex-bolt', qty:3}]`. mustObserve:
`/Hex bolt.*qty 3|quantity 3/` (in the stepper clicks' reports). solve:
click add, click inc ×2. maxSteps 10. Note recorded in the spec on purpose:
ten same-shape rows will run-collapse in Aperture's initial full snapshot —
that is Aperture's shipped behaviour on conventional markup, and if it costs
an expand round-trip, that cost is real and belongs in the number.

**T3 `account-prefs` (small; dependent controls).** Settings page: "Enable
notifications" toggle reveals a delivery-method radio group (Email/SMS/Push)
and a "Digest frequency" textbox; a "Save changes" button commits (unsaved
edits are not state). Prompt: `Enable notifications, choose SMS delivery,
set the digest frequency to weekly, and save the changes.` allowed:
`notifications, method-sms, frequency, save`. Predicate: saved state
`{notifications:true, method:'sms', frequency:'weekly'}`. mustObserve:
`/SMS|Digest frequency/` (the revealed controls arrive via the toggle's
report). solve: click, click, type, click. maxSteps 10.

**T4 `journal-comment` (large; content-grounded entry).** Long-form article
page (~6–8k-token snapshot: header with byline `By Carmen Reyes`, 12–16
sections, 120–160 in-text/nav/footer links from the seeded generator) with a
comment widget at the end: name, comment, star-rating radios 1–5, submit.
Prompt: `Post a comment on this article: the name field should be the
article author's name as shown in the byline, the comment text is
"Insightful piece.", give it a 4-star rating, and submit.` allowed:
`c-name, c-text, star-4, c-submit`. Predicate:
`comment==={name:'Carmen Reyes', text:'Insightful piece.', rating:4}`.
The byline forces the agent to OBSERVE page content, not just target
controls — the observation channel is load-bearing for the answer itself.
mustObserve: `/Comment posted/`. solve: 2 types, 2 clicks. maxSteps 12.

**T5 `console-quota` (large; iterative adjustment — the economics probe).**
Dashboard page (~6–9k-token snapshot: sidebar of ~60 nav links, several
stat tables) with a Quota panel: "Projected monthly cost: $36", an
"Increase quota" stepper (+$12 per click, page updates the projection each
click), "Apply changes". Prompt: `Increase the API quota until the projected
monthly cost shown reaches exactly $84, then apply the changes.` allowed:
`inc-quota, apply`. Predicate: `applied===true && projected===84`.
mustObserve: `/\$84/` (exists only in the 4th click's report). solve: click
×4, click apply. maxSteps 12. WHY this task exists: five acts on a 7k-token
page is where re-dump economics compound — each pw action response restates
the whole page; each Aperture response is a one-line diff. This is the
cleanest single measurement of the product's pitch on realistic weight.

**T6 `catalog-order` (large; locate-and-act, multi-step).** Storefront page
(~6–9k-token snapshot: ~150 product links across category sections) with an
order widget. Prompt: `Find the product called "Meridian desk clock" in the
Homeware section, add it to the order, set the quantity to 2, and place the
order.` allowed: `add:meridian-desk-clock, qty-inc:meridian-desk-clock,
place-order`. Predicate: order `[{item:'meridian-desk-clock', qty:2}]` and
placed. mustObserve: `/Meridian desk clock.*(added|qty 2)/`. solve: click
add, click inc, click place. maxSteps 12.

Small fixtures are hand-written; large ones are generated
(`bench/headtohead/fixtures/make-fixtures.mjs`, seeded, outputs checked in —
the size-sweep precedent). Size targets verified by preflight against the
**untruncated Aperture full snapshot** (the harness measures it, band ±20%),
with the pw snapshot size for the same fixture measured and reported beside
it — expected larger (§0's ~1.9×), which is the incumbent's own cost, not a
calibration error.

---

## 5. Ground truth across two engines

The witness survives the engine swap **by construction**, verified against
the code rather than asserted: `bench/fixtures/bench.js` is plain
capture-phase DOM listeners plus `fetch` to a hardcoded
`http://127.0.0.1:8898/e` as a CORS "simple request" (`text/plain`, no
preflight), and `bench/lib/collector.mjs` answers with permissive CORS
headers anyway. Any browser on the same host that runs page JS delivers it —
Playwright's chromium included. Predicates read collector state only; no
predicate anywhere touches either product's snapshot pipeline. Confirmed
engine-relevant details: Playwright's `browser_type` uses fill semantics,
which dispatches a genuine `input` event (one event, not per-keystroke — the
witness's 100ms debounce coalesces either shape identically); clicks are
real trusted clicks; both engines run the same fixture bytes from the same
`no-store` server.

What does NOT survive unchanged, and the decisions:

1. **The shadow model.** `bench/lib/streamModel.mjs` parses Aperture's wire
   format only. The pw arms get their own reader,
   `bench/headtohead/lib/ariaModel.mjs`: parse the `### Snapshot` yaml
   section of each response into `ref → {role, label}`; each response's
   snapshot **replaces** the model wholesale (that is the re-dump
   architecture — no application of deltas, nothing to drift). It exists for
   the same two jobs as the Aperture shadow model: label-targeted scripted
   solving (G2/H3 needs `resolveLabel` over it) and `identity_mismatch`
   attribution (page-reported label vs model label, reusing `labelsAgree`).
2. **Attribution vocabulary.** `model_bookkeeping` vs `engine_ref_loss`
   is a diff-arm concept (it needs a model that can be stale). For pw arms
   the attribution set is: `ok`, `wrong_choice`, `identity_mismatch`,
   `no_page_effect`, `stale_ref_error` (the act errored on a ref the
   previous snapshot did contain — pw's analogue of ref loss), `tool_fault`
   (§6 H9). The report compares like with like and says where the
   vocabularies differ.
3. **Observation classification.** Aperture arms keep
   `isFullSnapshot`/`isDiff`/`isNoChange`. pw arms get shape predicates over
   the section format (`### Snapshot` present = full observation; absent =
   header-only), plus per-section char accounting (`Snapshot`, `Ran
   Playwright code`, other) — the decomposition input for §7.3.
4. **Witness-parity probe (new, H2b):** one scripted, identical action
   sequence driven through BOTH engines on the same fixture must produce
   **identical deduped witness event lists** (type+bench+value sequences).
   This is the mechanical proof the predicates are engine-agnostic — that
   the same physical work scores the same — and it runs before any budget.
   If engines differ (e.g. an event-pattern difference the dedupe rules
   mishandle), the dedupe fix lands, the probe re-runs, and the changelog
   records it. The witness is the one component that must be beyond
   suspicion in a cross-engine fight; this probe is its passport.

Settle timing (260ms quiet / caps), dedupe rules and predicate evaluation
are shared code, one copy, both engines — asymmetric timing would be a
quiet thumb on the scale.

---

## 6. Guards — in the spirit of the existing eleven

Exit codes: `0 MEASURED · 3 INFRA · 4 VACUOUS · 5 SELFTEST · 6 INTEGRITY ·
7 HARNESS-FAULT`. Note the philosophical difference from `task.mjs`: this
suite is two-sided, so **a competitor win is exit 0** — MEASURED means the
preregistered questions were answered, whichever way. Nonzero still must
never be read as "roughly fine."

**Preflights (no API budget):**

- **H0 pin check.** `@playwright/mcp` version read from its installed
  `package.json` == the cohort's pinned `0.0.78`; chromium build recorded;
  Aperture `buildVersion` recorded; launch flag strings byte-compared to
  this spec. Mismatch with an existing store → INTEGRITY, same
  refuse-to-pool posture as the task suite, no override flag.
- **H1 response-shape probe.** Drive one scripted act per pw arm; assert the
  response contains a `### Snapshot` section (snapshot-mode full is live),
  `pw-sealed` responses contain **no** `### Ran Playwright code` (codegen
  none took), and record one full response verbatim into the run log — the
  report's appendix must show the actual bytes each arm's agent read.
  Also probe and record pw's stale-ref behaviour (§3.2).
- **H2 null-agent, per engine.** G1 as today, but run under BOTH engines:
  every predicate false on the untouched page AND the witness's `load`
  event arrives under Playwright's chromium with the §3.2 launch flags —
  this is the guard that catches an `--allowed-origins` list that silently
  starves the collector.
- **H2b witness parity.** §5.4. Identical scripted work → identical deduped
  witness streams across engines, exact match, else HARNESS-FAULT.
- **H3 scripted-solver parity — the load-bearing one.** The deterministic
  solver must solve **every task in every arm** before a scored episode
  runs: aperture arms via the existing shadow model, pw arms via the aria
  model, `pw-stock` via the sealed-equivalent action subset of its own
  surface (clicks/types by ref through pw's own tool names). Every
  `mustObserve` must match the arm's observation stream. **Any failure is
  presumed a harness/shim defect, not a competitor defect** — exit 7, no
  verdict, and the failure text names the arm, the step, and the raw reply.
  This is the direct answer to "what if Playwright fails a task our harness
  can't score fairly": a configuration our own scripted driver cannot pass
  is disqualified from scoring anyone.
- **H4 arm-blindness fingerprint.** Sealed arms' `tools/list` (names,
  schemas, act/done descriptions) byte-identical across `aperture-*` and
  `pw-sealed` except the forwarded snapshot description; all description
  hashes printed; system-prompt hashes printed; per-arm tool-schema token
  counts recorded (decomposition input).
- **H5 fixture neutrality lint** (§4.2 rule 2) green over the six neutral
  fixtures; size bands verified; large-fixture bulk vocabulary absent from
  every G2 diff stream (the "padding never leaks into a diff" assert,
  adapted); `bench.js` copy in the h2h fixture dir hash-equal to
  `bench/fixtures/bench.js`.

**Live guards (during/after scoring):**

- **H6 budget symmetry.** Same maxSteps and maxTurns per task in all arms,
  asserted from one shared table; per-episode `capHits` recorded. Aperture
  arms on large fixtures get `budgetTokens: 20000` injected via the proxy's
  existing `inject` mechanism on every act and snapshot — WHY: the default
  2000-token budget would truncate large-page fulls, and a truncated page
  is not the page (`pw` has no budget to truncate). Zero `truncatedObs`
  anywhere or the affected episodes rerun after diagnosis (G11's rule).
- **H7 model identity.** G9 per arm, plus: the SET of served model keys must
  be identical across arms. A cross-arm model mismatch is the single most
  flattering possible bug and aborts with INFRA.
- **H8 arm purity.** `aperture-redump` receives nothing but FULL SNAPSHOTs
  (G3 whitelist, unchanged); `aperture-diff` diff share ≥60% (G4,
  unchanged); pw arms: every action response classified, any `other`-shaped
  observation surfaced verbatim (the unclassified-is-where-bugs-hide rule).
- **H9 harness-fault accounting.** Every failed episode is classified from
  the witness and the reply stream: `task_wrong` (acted, witness refutes),
  `gave_up` (task_done without success, or turn cap), `tool_fault` (a reply
  whose error the shim itself originated — shim errors carry a distinct
  prefix — or an MCP transport failure). Episodes with `tool_fault` are
  excluded from scoring and repeated after the fix; if >10% of any arm's
  episodes fault, exit 7 for the cohort. A comparison whose failure mode is
  "the competitor scored zero because our shim broke" is worthless, and
  this is the tripwire that says so before a verdict exists. Additional
  tripwire: any task where `pw-sealed` scores 0% while `pw-stock` ≥80% →
  flag SHIM-SUSPECT, investigate before any verdict is printed.
- **H10 win-reason decomposition — the guard the brief asked for by name.**
  If the headline shows an Aperture cost advantage, the report must
  decompose the per-episode token delta into: observation chars, tool-schema
  + description overhead, codegen-section chars (pw), turn-count delta ×
  mean per-turn context, and output tokens. The harness computes the share
  of the cost delta explained by **observation bytes** — the claimed
  mechanism — and prints `MECHANISM CONFIRMED` only if that share ≥50%.
  Below that, the verdict stands but the report MUST lead with the actual
  explanation ("Aperture won on turns, not bytes", "the schema overhead of
  20 tools did it", …). Wave 1's lesson is baked in as a rule: the
  decomposition is also printed **per task**, because pooling hid a sign
  change once already and a number right about the aggregate and wrong
  about every subset is not a finding.
- **H11 capability floor.** Any (task, class) cell where BOTH headline arms
  succeed <50% is excluded from cost claims (a failing arm's episodes are
  not the same work — the size-sweep rule) and reported as a capability
  finding instead.
- **H12 ceiling.** G10 unchanged in spirit: if both headline arms are ≥98%
  on success pooled, the reliability comparison is INCONCLUSIVE-by-ceiling
  and only the economics claims survive — stated in exactly those words.

---

## 7. Preregistered analysis, and the sentences each outcome licenses

### 7.1 The rules (fixed here, before any episode)

- **Reliability (primary):** success delta Δ = `aperture-diff` −
  `pw-sealed`, Newcombe 95% CI, pooled over ALL 13 tasks (pooling the
  Aperture-adversarial home set is deliberately conservative against
  Aperture). Bound: **non-inferiority at −10pp** (at N=10/task/arm,
  130/arm, half-width ≈8–9pp at plausible rates — the bound is chosen above
  the MDE for reachability, stated openly, same posture as wave 2's
  secondary). Reported per class as colour.
- **Precision (primary):** wrong-element delta CI upper ≤ **+0.2/run**
  (the existing margin, reused unchanged).
- **Economics (primary):** cost ratio `aperture-diff`/`pw-sealed` per size
  class, seeded-bootstrap 90% CI on the per-episode dollar means. The
  headline economic claim requires the **neutral-large** CI entirely below
  1.0; neutral-small and home are reported whichever way they fall. Token
  decomposition per H10. Secondary: $/successful-episode.
- **Affordance check (secondary):** `pw-stock` vs `pw-sealed` success and
  cost — bounds nothing, but §7.4's sentence depends on it.
- **Decomposition (secondary):** the §3.5 three-way comparison, reported as
  three named deltas with CIs, no verdict semantics.

No interim peeking rule is needed beyond §9's phase gates, which condition
only on pooled levels and cost projections, never on the headline delta.

### 7.2 If Aperture wins (economics holds, reliability bound holds)

The licensed sentence, exactly — model-qualified, version-qualified,
class-qualified, with CIs:

> "On a 13-task suite (7 fixtures purpose-built to stress diff-tracking
> failure modes, 6 preregistered neutral fixtures), with claude-sonnet-5,
> agents observing via Aperture's diffs completed tasks within [Δ, CI] of
> agents using Playwright MCP v0.0.78 sealed to the same three-tool surface,
> with [w, CI] wrong-element actions per run, and cost [R]× as much per
> episode on realistic-size pages ([CI]; [S]% of the saving is observation
> bytes). Playwright MCP with its full default surface scored [x]; details
> and losses in bench/RESULTS.md."

It does NOT license: claims about other models, live websites, logged-in
flows, iframes, longer tasks, the truncation regime, Playwright's CLI mode,
or any unqualified "Aperture is better."

### 7.3 If Aperture loses — written now, so this is not a marketing device

- **Reliability loss** (success CI entirely below −10pp): README gains,
  verbatim: *"On this suite, agents using Playwright MCP v0.0.78 completed
  tasks [d]pp more often than agents using Aperture ([CI]). Aperture's diff
  observation is cheaper per token but, as of this build, less reliable;
  for unattended tasks, choose Playwright MCP and treat Aperture's savings
  as not yet safe to spend."* The per-task attribution table decides what
  gets fixed; the sentence stays in the README until a **new cohort** on an
  unchanged task set clears the bound.
- **Economics loss or null** (neutral-large ratio CI includes or exceeds
  1.0): README gains, verbatim: *"On pages up to ~[Y] snapshot tokens,
  Aperture's diff observation did not measurably reduce end-to-end agent
  cost against Playwright MCP v0.0.78 ([R], [CI]). The per-snapshot size
  advantage is real ([~1.9×], RESULTS.md) but did not survive end-to-end
  accounting on this suite."* This one is product-threatening and goes in
  anyway — the mechanism's domain claim is the product's reason to exist,
  and a benchmark that cannot emit this sentence is marketing.
- **Precision loss** (wrong-element CI above +0.2): the wrong-element
  sentence with its CI, plus the attribution split naming whether the
  excess is `identity_mismatch` (the positional-ref hazard live in
  production) — which the README must state as a correctness hazard, not a
  cost.
- **Mixed** (cheaper but bound-failing, or reliable but not cheaper): both
  sentences appear; neither is softened by the other's presence.

### 7.4 The affordance sentence

If `pw-stock` beats `pw-sealed` on success by more than the success CI
half-width, the report must state: *"Sealing Playwright MCP to three tools
cost it measurable capability; the sealed comparison understates the
incumbent, and the stock numbers are the deployment-relevant ones."* — i.e.
the headline demotes itself. Preregistering this is what makes the sealed
headline honest rather than a rigged ring.

### 7.5 INCONCLUSIVE

Any primary whose CI straddles its bound licenses nothing on that axis, in
the existing suite's tradition: the run prints what would have been needed
(episodes to bound, at observed rates) and stops. No secondary sentence is
invented after the fact; the only preregistered fallback is the −10pp
reliability bound already stated.

---

## 8. Harness architecture

**Everything new lives in `bench/headtohead/`** — outside `codeVersion`'s
watched set (verified: WATCH_DIRS covers `src/core/snapshot`, `src/mcp`,
`src/preload`, `bench/fixtures`; WATCH_FILES the six named bench files) and
requiring **no rebuild of `out/`**, so authoring it cannot invalidate any
cohort. It imports the shared libraries (`bench/lib/collector.mjs`,
`bench/lib/streamModel.mjs`, `bench/lib/stats.mjs`, `bench/tasks.mjs`)
without editing them.

```
bench/headtohead/
  package.json            # NESTED npm project: @playwright/mcp pinned 0.0.78,
                          # @modelcontextprotocol/sdk. WHY nested: the root
                          # package.json stays untouched (no dependency churn
                          # in the product tree, no accidental rebuild trigger,
                          # independent pinning). `npx playwright install
                          # chromium` runs here; browser build recorded.
  h2h.mjs                 # runner: phases, store, guards, report (task.mjs's
                          # structure: wave-major targets, resume-by-key,
                          # append-per-episode, verdict over the whole store)
  lib/pwUpstream.mjs      # MCP SDK client over stdio to `playwright-mcp`
                          # (stdio, not HTTP: pw's server requires proper MCP
                          # session init; the SDK client does the handshake,
                          # and stdio needs no port). One server process per
                          # arm per run, --isolated; per-episode freshness by
                          # navigation with cache-buster, same as Aperture's.
  lib/proxy.mjs           # the sealed/stock proxy: same skeleton as
                          # bench/lib/proxy.mjs (episode state, step caps,
                          # witness attribution, observation recording) with
                          # two upstream adapters (aperture HTTP / pw stdio),
                          # the §3.2 shim, the §3.4 allowlist forwarding,
                          # per-section char accounting, upstreamMs timing
  lib/ariaModel.mjs       # §5.1 pw snapshot reader + resolveLabel
  lib/h2hStore.mjs        # store/identity: modeled on bench/lib/store.mjs;
                          # identity = hash over bench/headtohead/** + the two
                          # fixture dirs + aperture buildVersion + pw version +
                          # chromium build + model + prompt/description hashes
                          # + verdict rule + arm definitions. Same refuse-to-
                          # pool posture, same --new-cohort archival, own
                          # store at bench/headtohead/results/episodes.jsonl
  lint-fixtures.mjs       # §4.2 rule-2 linter
  fixtures/               # 6 neutral fixtures + make-fixtures.mjs + a
                          # byte-identical COPY of bench/fixtures/bench.js
                          # (H5 hash-checks it; served roots cannot cross)
  FIXTURE_CHANGELOG.md
  results/
```

**Ports:** Aperture 8817 (hardcoded), fixtures 8899 and collector 8898
(hardcoded in fixture bytes — reused, which is why the whole suite is
port-gated behind the running wave), h2h proxy **8894** (new; 8896 left to
the task suite so a stray process from either suite cannot be mistaken for
the other), pw over stdio (no port). The runner owns its world exactly as
`task.mjs` does: refuses occupied ports, starts everything, kills
everything, verifies 8817 actually closed.

**Drivers:** the SDK `query()` exactly as `task.mjs`'s `agentDriver` —
same `settingSources: []`, same `disallowedTools` belt, `permissionMode:
'dontAsk'`, `maxTurns = maxSteps + 6`, empty scratchpad cwd, auth via Claude
Code's own credentials (already measured), model `claude-sonnet-5`. The only
per-arm differences: the proxy URL and, for `pw-stock`, the allowedTools
list and the §3.3 prompt variant.

**Episode row** (superset of the task suite's): task, class, arm, runIndex,
success, wrongElement, pageActions, steps, capHits, kinds (per-arm
vocabulary), obsChars, sectionChars (pw arms), obsSeq, acts w/ attribution,
nonRefTargeting (pw-stock), turns, costUsd, inputTokens/outputTokens/
cacheRead/cacheCreate (from `modelUsage`), durationMs, upstreamMs total,
failureClass, driverError, and the full identity stamp.

---

## 9. Phases, budget, runtime — cheapest disconfirming check first

| phase | what | episodes | est. cost | gate |
|---|---|---|---|---|
| 0 | build harness, fixtures, ALL preflights H0–H5 (+H2b) | 0 scored | $0 | any red → fix before money |
| 1 | **kill shot**: `console-quota` (T5, neutral-large), `aperture-diff` vs `pw-sealed`, N=3/arm | 6 | ~$4 | if aperture mean cost ≥ 0.9× pw here — on the class MOST favourable to the mechanism — the economics premise is likely dead; STOP-AND-DECIDE printed, human decides whether the rest is worth running. Conditions on cost levels only, not on the headline delta |
| 2 | pilot: all 13 tasks × 4 arms × N=2 | 104 | ~$15 | projections from measured $/ep; H8/H9 rates checked; SHIM-SUSPECT scan |
| 3 | fill: headline arms N=10, `aperture-redump` N=10, `pw-stock` N=5 | to 455 total | ~$60–85 | resumable, wave-major, append-per-episode |
| 4 | report + verdict over the whole store | 0 | $0 | H10 decomposition mandatory |

Cost model behind the estimate (stated so it can be discounted): wave-1
measured $0.11/ep on small fixtures for the aperture arms; pw small-class
episodes carry ~1.5–2× observation bytes plus schema overhead → est.
$0.13–0.18; large-class pw episodes re-send a 6–9k-token snapshot per
action → est. $0.4–0.9 with SDK caching (the widest error bar in this
table, and the reason phase 2 exists); large-class aperture ~$0.15–0.25.
**Budget cap $130**, degrade rule fixed now: reduce `aperture-redump`
large-class N to 6, then `pw-stock` large-class N to 3; never drop an arm,
never drop a class. `--force-budget` requires the human saying so in the
session, in words. Runtime: ~455 episodes at 25–90s ≈ **4–6 h scored**,
serial; implementation ~2–4 focused days.

---

## 10. Implementation partition against the live wave

- **Safe NOW:** this document. Also technically safe now (unwatched files,
  no rebuild, no shared ports): the nested package, `pwUpstream`,
  `ariaModel`, the shim, the linter, the neutral fixtures, and pw-only
  smoke tests (stdio, no port conflict — chromium may be launched freely).
  Convention from tier2 §0.2 applies: batch it, and nothing touches
  `bench/task/results/`.
- **Blocked until the wave exits:** anything that starts Aperture (8817) or
  binds 8898/8899 — i.e. all preflights involving the witness or the
  aperture arms, and every scored phase. Run order after the wave: the
  task suite's own stage-B items first (tier2 §9 — the Haiku contingency
  and the size sweep want the wave-2 stamp), then this suite. The
  head-to-head has no stamp-sharing requirement with wave 2 — it is its own
  experiment — so it may also run after stage-C edits land; H0 pins
  whatever Aperture build it measures and refuses to pool across builds.
- The head-to-head **never** edits watched files. If implementation
  discovers it needs a product change (it should not — the `inject`
  mechanism and `budgetTokens` already exist), that change waits for a
  stage-C window and the h2h cohort restarts under the new stamp.

---

## 11. What this benchmark cannot settle

Stated so the absence of a claim reads as a decision:

1. **Live-web generalisation.** Fixtures — even neutral, realistic-weight
   ones — are not logged-in, anti-bot-gated, A/B-tested production sites.
   The neutral-large class buys realistic *token weight*, not realistic
   *adversity*. A WebArena-class dockerised-site arm is the credible next
   step and is deliberately out of scope.
2. **Other models.** claude-sonnet-5 only. A model that never loses ref
   bookkeeping — or one that always does — moves every number.
3. **Model familiarity asymmetry, disclosed in Aperture's favour being
   unclaimable:** Sonnet's training data contains Playwright MCP's format
   and conventions; it has never seen Aperture's. A pw win may partly be
   familiarity; an Aperture win is despite it. Unmeasurable here either
   way, and stated in the report.
4. **Playwright's CLI/skills mode** (§1.4) — the incumbent's own
   recommended token-efficient path is not an MCP server and is not
   measured. If that mode wins the economics outright, this comparison's
   frame (MCP vs MCP) is the wrong fight; nothing here detects that.
5. **The truncation regime** (agent budget smaller than the page), iframes,
   multi-tab, file upload/download, drag-and-drop, vision workflows —
   unexercised by every fixture, in both products.
6. **Long-horizon sessions.** Max ~16 page actions. Context-compaction
   behaviour over hundreds of actions — where diffs' token ceiling and
   re-dumps' context flooding really diverge — is a different experiment.
7. **Wall-clock as experienced** — reported, decomposed, never verdicted
   (§2); a user on a different API tier feels different numbers.
8. **Ecosystem value** — codegen, trace viewers, test integration, the
   things people actually pick Playwright for that are not observation.

## 12. Verified vs. not verifiable from here

**Verified** (source named inline above): the 0.0.78 tool surface, flags and
`--caps` list (packaged README, generated from source); full-snapshot-per-
action architecture and the section format (`response.ts` at main;
`setIncludeSnapshot` call sites in `keyboard/mouse/navigate/files/tabs/
wait/snapshot.ts`); `--snapshot-mode`, `--codegen`, `--test-id-attribute`
defaults; `browser_evaluate`/`browser_run_code_unsafe`/network tools in
core with the RCE description quoted; selector-or-ref targeting; the CLI
concession text; witness engine-agnosticism (`bench.js` + `collector.mjs`
read in full); the watched-set boundary and port bindings; the proxy
`inject`/`budgetTokens` enabler existing on the running build.

**Not verifiable offline — every one is a named preflight, not an
assumption:** (1) pw ref persistence across snapshots and its stale-ref
error text (H1 probes and records). (2) That main-branch `response.ts`
behaviour matches the pinned 0.0.78 bundle exactly (H1's shape probe is the
authority at run time; main was read 2026-08-01, the day 0.0.78 shipped).
(3) pw `fill` event pattern under the witness (H2b). (4) `browser_mouse_wheel`
parameter shape under `--caps=vision` (H-preflight in the shim's smoke
test; scroll is expected dead anyway). (5) Real pw episode cost at the
large tier — the widest estimate in §9, which is what phase 2's projection
gate is for. (6) Whether `--allowed-origins` interacts with the witness
fetch (H2 exists precisely for it). (7) Everything about Sonnet's format
familiarity (§11.3 — disclosed, not measured).

---

*The rule that produced the rest of this repo's benches applies here with
extra force, because this one has an opponent: when it first shows Aperture
winning, spend a day trying to make it lie.*
