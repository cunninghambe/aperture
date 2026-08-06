# Aperture

An AI-native, privacy-first browser. The primary user is an agent; the human is
the one who stays in charge.

> **Status: early but real.** The browser runs, the MCP server works, and Claude
> Code can drive it end to end — snapshot, act, diff, autofill, capture. The
> diff engine has been measured against a real competitor over **two** scored,
> preregistered head-to-head cohorts on a byte-identical apparatus: it won the
> cost primary both times, **lost the precision primary in the first, and passed
> it in the second** after an engine fix that was specified, preregistered and
> independently adjudicated before its numbers existed. The vault has a working
> UI, tested crypto, PSL-backed origin binding, and a wired MCP fill path gated
> by a native consent dialog the agent cannot reach. See
> [What has been measured](#what-has-been-measured) for the numbers and their
> scope, and [Honest status](#honest-status) for what is *not* done — nothing
> below is claimed as working unless it is marked working.

---

## Why build this

Every "AI browser" shipping today — Dia, Comet, Neon, Edge Copilot Mode, Brave
Leo — is a chat sidebar bolted onto Chromium, driving a model *the vendor
chose*. Aperture inverts that: it is a browser whose control surface is an MCP
server, so **you** bring the agent. Claude Code attaches to a browser you are
already using, with your sessions and your logins, and you watch it work.

Opera Neon shipped an in-browser MCP endpoint in March 2026, so the idea is
validated. Two things are still unoccupied: nobody has built this on Electron,
and **nobody has solved incremental page observation**, which is where almost
all the token cost in agentic browsing actually goes.

## The core idea: diffs, not re-dumps

Every browser-MCP today (playwright-mcp, browser-use, chrome-devtools-mcp)
re-serializes the entire page after every single action. Aperture treats the
loop as **act → observe delta**: `browser_act` returns what changed, against a
page state the model already holds.

For scale, from `npm run bench:live` on four real sites: an Aperture full
snapshot of Hacker News is 9,519 tokens (233 refs), a GitHub repo page 5,269
(100), a Wikipedia article 6,197 (209), an MDN reference 7,102 (163). An
observation that reports *nothing changed* costs ~112–115 tokens on any of
them. That gap is the whole design.

Making the gap safe rather than merely small is the actual engineering:

- **Stable refs.** `e42` names a *logical element*, not a DOM node, so it
  survives a React re-render that replaced every node. Identity is
  `data-testid` → `name` → non-generated `id` → role + accessible name +
  nearest named ancestor + semantic path. Framework-generated ids (`:r1:`,
  hash suffixes) are rejected, because keying on them would make every ref
  unstable.
- **Keyed reconciliation, not tree-edit-distance.** Identity keys turn matching
  into a hash lookup, so diffing is O(n), with a longest-increasing-subsequence
  pass so "one row jumped to the top" is one op, not twenty.
- **Explicit resets.** Diffs name the state they apply to (`diff from #7.3`). On
  navigation, on >30% change, or after 12 diffs, the engine emits a full
  snapshot headed `FULL SNAPSHOT — replaces all prior state`, which tells a
  model whose context was compacted to discard its mental model. The fallback
  thresholds are reasoned choices, not tuned values — nothing has measured them
  against alternatives.
- **Explicit retirement.** A `replace` op carries a `gone:` list naming every
  ref it destroyed, and a `- gone:` op reports deaths that have no addressable
  root to hang off. Restating a subtree without saying what died is how an
  agent ends up believing in elements that no longer exist.
- **Noise suppression.** A clock is recognized by shape and suppressed — even
  mid-task, when every observation follows an action (this specifically did
  not work until it was benchmarked: in an act-observe loop the statistical
  demotion path can never fire, and the shape path was gated behind it).
  Anything changing repeatedly on its own is demoted; the element the agent
  acts on or reads is promoted straight back. Without this, one ticking
  timestamp defeats the entire diff argument.
- **Positional fallback — the known weak point, and it cost us a benchmark
  before it was fixed.** Elements distinguishable only by position (ten
  identical "Add to cart" buttons, a queue of identical rows) get a
  document-order ordinal appended to their key, and reordering is exactly what
  breaks positional identity. In the first head-to-head this was measured in
  the field: under row removal those ordinals re-keyed to positions, a plan
  captured before the removal executed one row off, and the click *landed* —
  the one preregistered primary Aperture failed. A positional family's refs now
  **retire on any membership change**, so a stale ref is refused rather than
  silently rebound. The hazard is still reached constantly and now lands never:
  see [Correctness](#correctness-the-primary-we-lost-and-then-fixed).
- **Ref discipline.** Only actionable elements get refs. On the four real sites
  above, Aperture's full snapshots are **1.25×–2.77× smaller than
  `@playwright/mcp`'s of the same URLs, averaging ~1.9×**. That is a
  per-snapshot byte comparison and nothing more — per-observation is not
  per-dollar, which the campaigns below spent three waves learning.

## What has been measured

Six scored campaigns with preregistered rules, plus the engine's own fidelity
benches. Every claim here is quoted at the scope its verdict grants. The
measurement detail, the corrections, and the failed analyses live in
[`bench/RESULTS.md`](bench/RESULTS.md) and the adjudications in
`docs/design/{wave3,sweep,h2h,h2h-post-tier5}-evaluation.md`.

### Cost, against the real incumbent

On an 11-task benchmark against **Playwright MCP 0.0.78**, both products sealed
to an identical three-tool surface, driven by claude-sonnet-5 (385 episodes,
build `0916e30f…`; design preregistered in `docs/design/headtohead.md`, the fix
and its re-measurement in `docs/design/tier5.md` §9 and
`docs/design/tier5-ruling.md` §7, adjudicated in
`docs/design/h2h-post-tier5-evaluation.md`):

- On **realistic-weight pages** — the preregistered neutral fixtures, ~6k
  Aperture tokens against ~22k in Playwright's dialect — end-to-end agent cost
  was **0.390× sealed Playwright MCP's [0.338, 0.455]**. That is *worse* than
  the pre-fix engine's 0.313×, by exactly the amount the fix makes honest: one
  extra full snapshot per episode on one fixture, in 10 of 10 episodes,
  +$0.066/ep, where the old engine skipped it by reviving dead positional refs.
- On the **small adversarial home fixtures the 1.30× premium is gone**:
  **0.823× [0.693, 0.975] CHEAPER**, and said thinly — the CI upper is 0.975,
  and about a quarter of the movement is the incumbent drifting 7.8% dearer for
  no attributable reason. The premium died with the defect: Aperture's output
  tokens fell 6,285 → 2,131 per episode, confined to the three queue tasks,
  because agents no longer re-derive ordinal plans and repair after silent
  wrong landings.
- On small *neutral* pages the difference is null (**0.977× [0.937, 1.019]**),
  unchanged across both cohorts.
- **Disclosure pinned by the preregistration:** both cohorts run a
  shared-tab-per-run protocol, so Aperture's engine carries warm ref state
  across a run's episodes while the Playwright arms have none. The asymmetry is
  real, favours neither side uniformly, and is in the numbers rather than
  hidden from them — the warm-revisit cost above is precisely it being paid.

Where the crossover sits, from a page-size sweep on one task (54 episodes,
full-snapshot weights 1,116–38,081 chars, **measured on the pre-tier5 engine
and not re-run since**): **the diff arm is never significantly dearer at any
measured size, and is significantly cheaper from ≈10k chars (≈2.5k tokens)
up** — 19% / 39% / 43% cheaper per episode at the top three rungs, growing
monotonically with page weight. At the two smallest rungs the intervals include
zero, so the sweep neither confirms nor refutes the +4–6% small-page premium
the earlier waves measured; it caps any such premium at +20% of episode cost.
One task, one model, synthetic inert padding.

### Correctness: the primary we lost, and then fixed

- **Precision (head-to-head primary): the +0.2/run wrong-element bound HOLDS,
  and the sign reversed.** Pooled delta **−0.109 [−0.200, −0.036]**; the
  pre-fix cohort measured +0.173 [0.018, 0.345] against the same bound and
  FAILED. **Zero landed wrong-element actions across all 220 Aperture
  episodes** — the home rate went 0.540 → 0.000 — against 0.240/run for sealed
  Playwright on the same fixtures. Two caveats travel with the number: the
  negative sign is partly the incumbent's own sampled wrong clicks rising
  8 → 12 between cohorts, so the durable claim is **Aperture's zero, not
  Playwright's 0.24**; and zero-landed-wrong is a measured result on fixtures
  purpose-built to stress re-rendering identical-row lists, not a structural
  guarantee.
- **The hazard is still reached — it now fails loudly instead of landing.**
  Agents acted on stale refs **90 times in 50 home episodes** (the pre-fix
  cohort: 27 landed wrong plus 8 refused), and every one was refused with a
  restatement naming what died, followed by a re-observation and a correct act.
  Hard-queue success rose with it: 40% → 70% and 50% → 90%. This is the
  designed currency conversion, not a hazard that stopped occurring — a
  distinction the store can make because the retirement events are on the wire.
- **Reliability (head-to-head primary): the −10pp non-inferiority bound HOLDS,
  and now holds without the ruled cell.** +10.0pp [−0.3, +20.2] pooled; the CI
  touches zero, so this is non-inferiority and **no superiority claim**. The
  delta is carried by one task (`catalog-order`, where sealed Playwright scores
  0/10 and both Aperture arms 10/10); excluding it, +1.0pp [−9.2, +11.2] —
  parity, with the bound still holding, which the pre-fix cohort could not say.
  On the disclosed-adversarial home set Aperture now leads 90% to 88%, retiring
  by measurement the earlier cohort's "the incumbent led on our own hard set".
- **None of that task-success gap belongs to the diff mechanism.** diff −
  re-dump is **+0.0pp [−9.2, +9.2]**; re-dump − sealed carries the entire
  +10.0pp. The product gap is **engine and dialect** — compact rendering of a
  page Playwright's dialect renders at ~22k tokens — and no share of it may be
  attributed to diffs. What diffs measurably win is economics, and nothing
  else; what they measurably cost reliability is zero, which after the
  retirement surgery is itself a result.
- **Sealing the incumbent cost it capability, and that matters more than our
  win.** On this cohort stock Playwright MCP scored 81.8% against its own
  sealed configuration's 76.4% — inside this cohort's noise, but the direction
  repeats the archived cohort's +15.5pp finding, and on `catalog-order` the
  stock surface converts what the sealed one cannot (100% vs 0%). **The sealed
  comparison understates the incumbent, and stock Playwright remains the
  stronger choice where its full surface is acceptable.** Every stock number
  carries "with code-execution, network-inspection and screenshot tools
  disabled".
- **The mechanism guard printed CONFIRMED and is adjudicated as task-mix
  arithmetic.** Its pooled 62.7% observation-byte share crosses the 50% bar
  only because `catalog-order` is in the pool — the same single cell that held
  the share *under* the bar last cohort, from the other side (33.3% without
  it). Where both arms solve the page, observation bytes are about half the
  cost delta and the turn term runs modestly *against* Aperture, because
  refusal recoveries and the warm-revisit expand buy real round-trips. The
  clean isolation of the observation channel is diff versus re-dump on the same
  engine and dialect: **0.46×** on realistic-weight pages.

**Scope, and it is narrow.** One model (claude-sonnet-5, an undated alias —
cross-cohort comparisons of *agent behaviour*, including "the incumbent got
slightly worse", are observations and never claims). Our fixtures — 5
disclosed-adversarial plus 6 preregistered-neutral, synthetic, static,
logged-out, no anti-bot, no iframes, no auth; the "13-task" label of the older
docs was always 11 prompts, hash-unchanged across both cohorts. MCP mode only:
Playwright's own recommended CLI/skills mode, which its README concedes is the
token-efficient path, is unmeasured, and if that mode wins the economics then
MCP-vs-MCP was the wrong fight. **Every Playwright episode ran branded Chrome
150.0.7871.187, not the pinned chromium build the spec named** — that build
cannot spawn on this machine, so the pinned browser never ran (Aperture ran its
own Electron-bundled Chromium, as always). Sealed Playwright ran with codegen
off, which makes key/scroll/type-without-submit return zero bytes — its shipped
conduct, disclosed in the shared tool description. Sonnet has trained on
Playwright's dialect and never on Aperture's; that asymmetry is unclaimable in
either direction. `account-prefs` scores near-zero in every arm on a
case-sensitive predicate defect, deliberately left unfixed so the task set
stayed byte-identical between cohorts; it is in the reliability pool and
excluded from every cost claim. The measured build is the fix **plus** the
2026-08-05 security hardening, so every number above is stamped `0916e30f…`
rather than to the fix's own landing. The suite's own report still exits
non-zero on this store (the `catalog-order` tripwire, re-investigated and ruled
the same genuine product difference), so the verdict was computed out of band
with the suite's own stats code. The full disclosure block is in
[`bench/RESULTS.md`](bench/RESULTS.md).

### Speed

Aperture finished faster than Playwright MCP in **every task class, in both
head-to-head cohorts** — median wall-clock per episode, 385 episodes each:

| task class | Aperture | Playwright MCP (sealed) | (stock) |
|---|---|---|---|
| adversarial home | **36.7s** | 96.3s | 84.4s |
| neutral, small pages | **24.7s** | 41.5s | 46.1s |
| neutral, real-page weight | **24.7s** | 61.7s | 58.5s |

The load-bearing half of that is **browser time** — the seconds spent inside
the tool call, not waiting on the model — measured directly per call:

| task class | Aperture | Playwright MCP |
|---|---|---|
| adversarial home | **1.1s** | 42.4s |
| neutral, small pages | **0.7s** | 18.2s |
| neutral, real-page weight | **0.7s** | 12.2s |

That is ~0.075s per action against ~3s, and it is the same mechanism the cost
result measures: a full aria snapshot generated and shipped across a process
boundary on every action, versus a diff computed in-process.

**Stated at the scope it was measured, which is narrower than the table looks.**
Wall-clock was preregistered as *reported, never verdicted* — there is no
confidence interval and no bound it passed, because end-to-end time at these
episode lengths is dominated by API queueing noise (`pw-sealed`'s
neutral-large episodes range [34.4s, 141.2s]). One machine, serial runs, one
model. What survives that caveat: the direction is consistent across all six
class-cohort cells, and the browser-time component is not queueing noise —
it is time the browser spent, recorded per call.

Two things this does **not** claim. It says nothing about **raw Playwright**:
a script with no model in the loop runs at machine speed and wins outright on
any task it already knows how to do. And the wall-clock gap is not the diff
mechanism's alone — the same engine in re-dump mode posts 33.8s/24.3s/27.6s,
so most of the browser-time advantage is Aperture's in-process engine rather
than diffs specifically.

A side effect worth recording: Aperture's home median was **70.5s before the
positional-rebind fix and 36.7s after**. Wrong actions were burning turns;
not making them made the browser faster.

### The mechanism, on our own bench

- **Diff fidelity: six scenarios GREEN** (`npm run bench:fidelity`) — typing
  with a mid-run resync, full DOM teardowns, clicks and state flips through a
  shadow root with a ticking clock suppressed, mass ref death and revival
  through the size-cap resync, native `<select>`s plus a custom ARIA combobox,
  and a same-walker pierce that asserts table-cell text, an `href` rewrite and
  a label morph against a model built from the stream alone. Vacuity guards
  mean a run that measured nothing exits without printing a verdict at all.
  **What a green licenses:** the diff stream is complete and unambiguous *for a
  mechanical rule-following reader* — if a real agent's model drifts, the fault
  is its bookkeeping, not missing information in the stream. It does **not**
  prove an LLM does that bookkeeping correctly, and it does not check
  containment or position: a stream that reordered the world would still pass.
- **Refusals and retractions: 11/11** — the oldest block of `npm run
  bench:guards`, judged against the fixture's own change-event log rather than
  Aperture's own report, because an `error:` reply is not evidence that nothing
  was written. The same probe scored 1/11 on the build immediately before the
  fixes. The suite has since grown to cover redaction, egress and request
  signing; its last full run was **72/72 green** against artifact
  `4115dd9f…`, and it refuses to start at all against a build older than
  `src/`.
- **Ref stability across a re-snapshot: 100%** on four real sites, including
  one whose content changes underneath. Through a *full re-render* refs survive
  when the element has a distinguishing name and **cannot be re-identified when
  siblings are identical** — the positional hazard above, measured in the lab
  before the head-to-head measured it in the field. Since the retirement fix
  that case is refused rather than rebound.
- **The synthetic token model** (`npm run bench`) puts observation cost at
  6.6×–10.2× lower in diff mode over a 20-action sequence, rising with page
  size. It is a model of one fixture family, not a measurement of anything an
  agent did, and the campaigns above supersede it for any deployment claim.

An earlier version of this file claimed ~50×, then ~40×, from design targets
nobody had measured. Both were wrong, in the same way: neither accounted for
fixed per-response overhead, and neither counted the turns an agent spends
deciding. The envelope overhead has since been cut from 420 to 104 chars — 79
tokens per response, reconciled to the byte — and the honest headline is the
one above, which is smaller than the first draft and better evidenced.

### What none of this settles

- **Live websites.** Every scored fixture is synthetic. No anti-bot, no A/B
  drift, no iframes, no auth.
- **Other models.** One model throughout. A model that reads 22k-token dumps
  reliably, or one that cannot read 6k, moves every headline number.
- **The truncation regime** — an agent on a page bigger than its budget. That is
  the *default* product experience, and the sweep priced the enabler world
  instead.
- **Hard tasks on big pages.** The one unmeasured quadrant of the cost picture,
  and the one place the sweep's flat voluntary-observation residue could
  plausibly break.
- **Long horizons.** Everything is ≤16 actions with budgets that always fit.
- **Structure, containment, position, iframes** — outside what the fidelity
  bench calls faithful.

## Small tool surface, deliberately — with a measured counterweight

Every registered MCP tool costs schema tokens before it does anything, and
playwright-mcp (~50 tools) and chrome-devtools-mcp (51) levy that tax on every
session. Aperture ships **14**, kept down by putting related operations behind
an `action` discriminator rather than splitting them into a tool each:

```
browser_tabs      browser_navigate   browser_snapshot   browser_read
browser_act       browser_fill_form  browser_profile    browser_attach
browser_capture   browser_container  browser_theme      browser_console
vault_entries_for_origin             vault_request_fill
```

`browser_act` covers click, type, clear, hover, scroll, key and select.

**The counterweight, because it was measured against us:** in the head-to-head,
giving the incumbent *more* tools made it better, not worse. Stock Playwright
beat its own three-tool sealed configuration by 15.5 points on the first
cohort and by 5.5 on the second (inside that cohort's noise, same direction),
and both times the dividend concentrated exactly where a scoping affordance was
missing — on the one task the sealed surface fails outright, stock converts
every run. A small surface is a real token saving and a real capability cost,
and this project has now paid the second half twice.

Note what is absent: there is no `vault_reveal`, no `vault_unlock`, no
`vault_export`, and no tool that reads the filesystem. Those capabilities do not
exist on this surface at all — see below for why that is the enforcement
mechanism rather than a policy.

## Autofill: the thing that makes this useful daily

A job application asks for the same twelve facts the last one did. Aperture
stores them once, and the agent proposes filling them:

```
profile "Demo" · 11 of 12 fields ready

e3  "First name"             → givenName: Brad
e5  "Email address"          → email ~85%: brad@example.com
e8  "Apartment, suite, etc." → addressLine2: —  SKIP: no-value
e16 "Date of birth"          → dateOfBirth ~85%: (from profile — value not shown)
```

Calling `apply` then raises a **native OS dialog** naming the origin and the
fields. The agent cannot render it, see it, click it, or pass a parameter that
skips it, and sensitive fields never ride on a prior grant.

That gate used to be a sentence in the tool description asking the agent to
check with the human — which made the approval the *agent's* judgement, and the
agent is exactly the component we assume a hostile page can steer. The vault got
origin binding with no override while profile autofill got a polite suggestion.
That inconsistency was the worst thing in this codebase and is now fixed.

Note what is *not* in the plan above: "Why do you want this role?" is a prose
question, not an identity field, and matching a stray keyword inside one is how
you end up submitting "Director" as an essay answer. Free-text prompts are
excluded by shape.

Matching uses the HTML `autocomplete` attribute first — it is a standardized
declaration of exactly what a field wants, and a surprising share of real forms
set it correctly — then label heuristics. Low-confidence matches are **reported
but not filled**: silently putting a wrong value in a field the human then
submits is worse than leaving it blank.

**Attachments** (CV, cover letter, portfolio) work the same way, with one hard
constraint: the agent picks files **by id from a library the human curated**, and
cannot pass a path. "Attach my CV" and "read any file on this machine and upload
it somewhere" are the same primitive if the agent controls the path — so it
doesn't.

This is also the honest answer to CAPTCHAs (see below): the human proves they're
human, the agent does the typing. No evasion involved, which is exactly why it
keeps working.

## Dark mode

Three layers, because no single one covers every case:

1. **Tell the site the truth** — `prefers-color-scheme` reports the real
   preference, so sites shipping their own dark theme use it. Always better than
   anything synthesized.
2. **Chromium force-dark** for sites without one. It works on the rendered
   layout tree and runs in the compositor, so it costs nothing per frame.
   Applied per-tab via CDP `Emulation.setAutoDarkModeOverride` — **verified
   working on Electron 43**, which is what makes per-site control possible at
   all (the Blink setting alone is process-wide).
3. **Filter inversion** as fallback and for brightness/contrast, which
   force-dark doesn't expose at runtime.

Per-site policy is Auto / On / Off, where Auto measures the page's background
luminance and skips sites that are already dark.

The filter fallback and the control model are adapted from
[Nightfall](https://github.com/cunninghambe/nightfall) — specifically its
counter-inversion set with the nesting guard, which stops a photo inside an
already-counter-inverted container coming out net-inverted. An extension can't
reach layer 2; owning the browser is the only way to get it.

## Privacy

- **Identity containers** — isolated cookie jar, cache, and storage per
  container, with a per-container fingerprint seed. Containers cannot be
  merged and sites cannot be moved between them from the agent surface: a page
  that could talk the agent into merging two containers defeats the isolation in
  one move, so that stays a human decision.
- **Fingerprint consistency over randomness.** Randomizing canvas noise per load
  makes you *more* identifiable — real browsers are boringly stable, so a
  machine whose fingerprint changes every load is wearing a sign. One seed per
  container, every surface derived from it, frozen while the container holds
  state. (The seed exists and is stable; the per-surface derivation is not yet
  applied — see [Honest status](#honest-status).)
- **Tracker blocking** via Ghostery's compiled engine (EasyList/EasyPrivacy
  scale), because an agent makes far more requests per minute than a human and
  per-request matching cost is on the hot path.
- Chromium's phone-home features (variations, domain reliability, autofill
  server) are switched off at launch, and WebRTC is prevented from leaking the
  local IP.

## The password vault is agent-blind by construction

We are building a password manager into a browser an agent can drive. That
creates an unusual requirement: **the agent must be able to cause a login
without ever being able to read the credential.** Agent context goes to a model
API, gets logged, and may be summarized or persisted — treat a credential
entering it as a full compromise.

Two properties do the work, and both are structural rather than procedural:

1. **No getter exists.** Not disabled, not flagged — absent. `vault_request_fill`
   performs the insertion and reports which fields it touched. A getter that
   exists can be called, and anything the agent can call, a hostile page can
   talk it into calling.
2. **Unnameability.** `vault_entries_for_origin` returns only entries matching
   the page's own origin. On `evil.com` the agent is never told a `google.com`
   entry exists, so a prompt injection has no identifier to weaponize. Removing
   the vocabulary beats blocking the action.

Origin mismatch is **terminal** — no `force` flag anywhere in the surface. The
agent is precisely the component we assume is manipulable; giving it an override
reduces the design to the agent's judgment under adversarial input.

Crypto: Argon2id (moderate limits, calibrated) → XChaCha20-Poly1305. The
192-bit nonce means random nonces are safe without counter state.

**Taint redaction is best-effort, not a guarantee.** Mirrored values are caught
by exact substring match, so a reformatted date (fill `1990-01-05`, page echoes
`January 5, 1990`), a case change, or a value split across text nodes all defeat
it — and it over-redacts, turning every "Anna" on the page into a marker if that
is your first name. It raises the cost of an accidental echo; it is not a
boundary. The boundaries are origin binding and the process split.

**What this does not claim:** a page can read back its own DOM, so a password
delivered to an origin is a password that origin has. A password manager's real
guarantee is *correct routing*, not secrecy from the site. Passkeys are the
actual fix; every password in a vault is technical debt.

## The vault window

The password manager is a separate window with three properties that are
structural rather than policy:

1. **The agent cannot address it.** TabManager never learns about it, so it has
   no tab id — and every agent action routes through TabManager by id. There is
   no argument the agent could pass to reach it. Not a blocked one, an
   unrepresentable one. *Verified:* with the vault window open, `browser_tabs`
   lists only the browser tab.
2. **It is excluded from capture.** `setContentProtection(true)` maps to
   `WDA_EXCLUDEFROMCAPTURE` on Windows, so screenshots and screen shares see a
   blank region — including the agent's own capture tool. *This is asserted by
   the code and not yet verified by a probe on the deployment OS; it is queued.*
3. **Its IPC is separate and sender-checked.** The `vaultui:` channels verify
   the caller is the vault window on every call, so knowing a channel name is
   not enough to use it.

`revealForHuman` is the one function in the codebase that returns a plaintext
password. It is safe only because of where it can be called from, and it must
never grow a caller outside that window.

**Honest limitation:** the security design calls for this to run in its own OS
process (hardened: its own low-privilege account). It currently runs in the
browser process. That is sound against the threat that actually matters — a
hostile page steering the agent — and not sound against local code execution as
the same user. That is the T-Base tier in `docs/design/security.md`.

## Two-factor codes

The vault stores TOTP seeds and shows live codes with a countdown. **No
registration, no accounts, no network calls** — TOTP (RFC 6238) is an offline
standard, and "Google Authenticator" is just one client for it. Paste what the
site prints next to its QR code. Verified against the RFC's own test vectors.

**On using 2FA to unlock the vault itself: don't bother, and here's why.** The
vault is encrypted with a key derived from your passphrase. A TOTP check would
be an `if` statement in the UI — and an attacker with the vault file ignores the
UI entirely and attacks the passphrase. Worse, verifying codes requires storing
the seed *in* the vault, so it is available to exactly the attacker it claims to
stop. A second factor only means something at rest if it contributes **key
material**, which is what a TPM or Windows Hello does and what TOTP structurally
cannot. Storing codes for other sites is genuinely valuable; gating the vault
with one is theatre.

## Crash reporting (off by default)

Reports go to your own uh-oh instance, and only if you turn it on.

A browser is the worst app to wire crash reporting into carelessly, because the
crash context *is* the sensitive data: URLs are browsing history, titles are
page content, stack traces can carry form values, and this process holds the MCP
token and your profile. So:

- **Allowlist, not denylist.** The event is rebuilt from an empty object with
  only named fields copied in — a `delete` pass would leak whatever the SDK adds
  in a future version.
- **URLs become a salted hash of the origin.** You get "these crashes cluster on
  one site" without recording which site. The salt is per-install, so hashes
  can't be compared across users or matched against a list of popular domains.
- **Your home directory is stripped** from file paths, since it usually contains
  your real name.
- **The vault reports nothing.** Not scrubbed — excluded, by tag and by any
  vault module appearing in any stack frame. False positives cost a diagnostic;
  a false negative costs a credential.
- **Fail closed.** uh-oh's client documents that a `beforeSend` which throws
  results in the event being sent *unmodified* — backwards for a scrubber — so
  ours never throws and returns null on any failure.
- **A final independent gate** re-scans the serialized payload and drops the
  whole event if a secret survived, precisely because it doesn't depend on the
  structural pass being correct.

A dedicated envelope suite covers this, including "an unknown top-level field is
dropped" and "a malformed event fails closed."

**Verify it end-to-end, not just in unit tests.** `npx electron . --test-crash`
sends a probe error deliberately containing a URL, an email, a bearer token and
your home path, so you can inspect what actually landed on the server. That flag
exists because the unit tests were green while the pipeline was completely
broken — three separate ways:

- The scrubber rebuilt events against a shape I had *assumed* rather than the
  real `EventEnvelopeSchema` (`stacktrace` is a flat array, not `{frames}`;
  `mechanism` is required; breadcrumbs use `ts`, not `timestamp`). The server
  400'd every event. The tests passed because they used the same invented shape
  as the code did.
- That same wrong shape meant `originatesInVault` found no frames — so the vault
  exclusion, the strongest claim in this section, silently excluded nothing.
- With events finally arriving, the leak audit found the username in every stack
  frame: real frames are `file:///C:/Users/name/…` with forward slashes, while
  the stripper matched `os.homedir()`'s backslash form.

All three are fixed and now covered, including an assertion that scrubbed output
still satisfies the wire contract. The lesson is worth keeping: a test that
shares the code's assumptions validates the assumption, not the behaviour.

## Capture → Notion

One button, on a fallback chain that matches what you actually mean:

1. A Notion page is open in a tab → append the capture there.
2. Notion configured but no page open → append to today's dated page.
3. Otherwise → write a PNG to `Pictures/Aperture`.

Every step falls through on failure, and step 3 cannot fail short of a full
disk. Losing a screenshot because an API call returned 400 would be the worst
outcome for a button whose entire job is "keep this".

The capture is filed, never returned to the agent's context — invisible text in
a screenshot is a known prompt-injection vector against vision models.

> ⚠ **The Notion API path is unverified.** Two pages of Notion's own docs
> disagree on the field names for file uploads, and I had no workspace token to
> test against. It is written to fail loudly and fall back to disk. Validate it
> before trusting it; the token goes in the vault window's Notion tab, never
> through the agent or a chat message.

## Prompt injection is the defining threat

Brave demonstrated hidden text in a Reddit post making Comet exfiltrate a user's
one-time passcode, and invisible text in screenshots steering a vision model.
This is not patchable at the model layer.

Aperture's response is structural: **every tool result carrying page text is
wrapped in an `<untrusted-page-content>` envelope** whose delimiters carry a
fresh per-call random nonce that is stripped from the body — so the closing tag
cannot occur inside the content no matter what the page writes, by construction
rather than by the nonce staying secret. What the envelope *means* is stated in
the tool descriptions, not repeated in every response: clients re-send tool
descriptions on every request, so that explanation survives context compaction.
Harness speech never appears inside an envelope, and page bytes never appear
outside one — including `browser_tabs`' list of page-authored tab titles and
`browser_fill_form`'s page-authored field labels, both of which reached the
agent bare until an audit caught them. The snapshot format reinforces it: all
page-authored text is quoted and control/bidi characters are stripped, so a page
cannot emit text that parses as snapshot structure or forge a `FULL SNAPSHOT`
header.

### The other half: a value Aperture filled must not come back out

The envelope marks page bytes as untrusted. It does nothing about the case where
the untrusted bytes are *your own secret*, copied out of the field Aperture just
filled and into somewhere the agent reads. Four review rounds went after that,
and the useful output is not the number of holes closed — it is the shape they
had. Sorted by **mechanism** rather than by surface, fifteen findings collapse to
seven classes, and `docs/design/security.md` carries the table:

| | mechanism | the failure it names |
|---|---|---|
| **A** | enumeration | a field nobody listed carries the value out |
| **B** | scope | the redactor's reach does not follow the value — to the origin the tab carried it to, or through the opener chain |
| **C** | alphabet | redactor and renderer read different bytes (an invisible separator, whitespace, URL percent-encoding) |
| **D** | parity | one helper, several call sites, and only some of them got the treatment |
| **E** | egress | Aperture acts *outside* the page on a string the page chose |
| **F** | coverage | a whole data class the machinery was never wired to — a filled date of birth came back verbatim for three gates |
| **G** | lifetime | *when* the redactor holds the value; the navigation that delivered it was the one that disarmed the redactor |

**The point is the stopping criterion, and it is one you can fail.** "No more
findings" is unfalsifiable and had been wrong four times. What replaced it:
*every mechanism has a guard that fails when that mechanism regresses; each
guard has been shown to fail by sabotage; and the sabotage row is an instance of
the class its author did not have in hand* — someone other than the guard's
author picks the row. That third clause is the whole difference. An independent
gate applied it to the two newest guards, re-ran their recorded rows (both red,
as claimed), then wrote its own row for each — and **both went green**. A guard
that fails on the example it was written from has been shown to recognise its
author's example, not to catch the mechanism. Twice, satisfying the clause
*changed* a guard rather than confirming it.

Stated rather than buried: **two of the seven rows, C and D, have no
author-independent row yet.** What is known about them is exactly the standard
that was just shown to be insufficient, and they are the first thing a fifth
reviewer should point at. And one residual is deliberate: a short all-digit
sensitive value — a one-time code, a six-to-eight-digit account number — is
matched only on the origin it was filled into, so a copy of it on an origin the
tab merely *carried* is not scrubbed there. On a carried origin nothing
distinguishes those digits from the page's own order number, and a marker that
is sometimes a lie is worse than coverage that is sometimes absent. Two guards
hold that bound from both sides: one fails on over-redaction, one on
under-redaction. Page-side transformation — base64, reversal, one character per
element — defeats substring matching and always will.

## About CAPTCHAs — read this before expecting Camoufox behavior

The original goal here was "avoids CAPTCHAs like Camoufox." Having researched
the 2026 state of the art, **that premise does not hold, and building toward it
would be building the wrong thing.**

CAPTCHA decisions are made across five layers:

| Layer | Weight | Where Aperture stands |
|---|---|---|
| IP / ASN reputation | hard gate | Your proxy choice; nothing a browser fixes |
| TLS (JA3/JA4) + HTTP/2 | hard gate | **Free** — a real Chromium gives a real Chrome fingerprint |
| Automation-protocol tells | high | Avoid CDP `Runtime.enable`; use isolated worlds |
| Browser fingerprint | consistency tax | Containers (above) get you to *unremarkable*, not *good* |
| **Behavior** | **the decision variable** | **The hard part, and not a browser problem** |

Camoufox is excellent at the fingerprint layer and its own docs call the
behavioral layer work-in-progress. But Cloudflare shipped **Precursor** on
2026-07-13: continuous, session-scoped behavioral scoring explicitly built to
detect *agentic* behavior, which survives page refresh. Cloudflare names
"mathematically perfect Bézier curves" as a bot signal — indicting every
humanization library by technique.

And an LLM agent has a signature no browser fork can hide: **bursts of perfect
action separated by multi-second silences while the model thinks.**

The strategically correct answer in late 2026 is the opposite of hiding.
**Web Bot Auth** (RFC 9421 HTTP message signatures) lets an agent
cryptographically identify itself and be *allowed*. From 2026-09-15 Cloudflare
blocks Agent-class traffic by default on ad-monetized pages for newly onboarded
domains, with bot operators enrolling as *signed agents* through its dashboard.

**That date is not Aperture's deadline, and chasing it would be a mistake.**
Enrollment as deployed assumes a hosted agent whose requests egress from
operator infrastructure holding the operator's private key. Aperture is a local
personal browser: a project-level key would ship inside every install, i.e. be
public, i.e. be worthless — anyone could sign as "Aperture", and the first
abuser burns the key's reputation for everyone. Checked against Cloudflare's
published policy rather than inferred: signed-agent enrollment requires
widespread use of zones, which one install per human fails per key, and there is
no per-user enrollment path in the policy at all.

**So what shipped is the capability, not the registration** — and it is built
and live-verified, not planned (`docs/design/webbotauth.md`):

- **Ed25519 signing per identity container, not per install.** One key across
  containers would hand every allowlisted origin a cross-container correlator,
  which is the exact thing the container work exists to prevent.
- **Structurally off, not defaulted off.** Nothing signs unless a human writes
  `userData/botauth.json` naming a directory URL where the public key is
  published. With no directory URL there is nothing to verify a `keyid` against,
  and an unverifiable `keyid` is a supercookie.
- **Main-frame document requests in agent-owned tabs, to origins the human
  listed — and nothing else.** Subresources are unsignable, which closes the
  oracle where page script on an allowlisted origin could mint signatures with
  a chosen method and path via `fetch()`. Human tabs are never signed, even on
  allowlisted domains: a bot assertion over a human's browsing is the
  anti-detect lie inverted.
- **The agent surface is zero.** No tool reads, writes or reports any of it, and
  the allowlist is withheld from the agent because it is a targeting map.
- **Verified against a build, both ways.** The guard suite runs 72/72 green with
  the feature present and goes red on six named legs with the request mux
  uninstalled — including the three *absence* guards, which are wired to
  hard-fail rather than pass trivially when nothing signs anywhere. Both
  artifact hashes are recorded. Interop was measured against Cloudflare's own
  signer and verifier before any of that.

Still owed, and named as owed: two live-only sabotage rows, and the header-order
measurement of what an installed request listener does to Chromium's wire.

Aperture is built for **your** browsing: your accounts, your sessions, your
automation. It is not a mass-evasion tool and will not be pointed in that
direction.

## Honest status

| Area | State |
|---|---|
| Electron shell, tab model (`WebContentsView`), browser UI | **Working** — launches and browses |
| MCP server over Streamable HTTP, 14 tools | **Working** — verified against a live browser |
| Bearer auth + DNS-rebinding guards | **Working** — verified (401 / 403) |
| Untrusted-content envelope | **Working** — verified in both directions by `bench:live` on every site: page bytes always inside, Aperture's own `ok …` always outside |
| Snapshot engine end-to-end (walker → refs → diff → render) | **Working** — verified on real sites and six fidelity fixtures |
| `browser_act` (click/type/clear/hover/scroll/key/select) | **Working** — trusted CDP input for pointer/keyboard, isolated-world setter for `select`; returns a diff |
| Input witness (act acknowledged ⇒ input actually reached the page) | **Working** — covers targeted acts plus scroll and key; `unknown` never fails an act, and a page that self-navigates mid-settle is invisible to it |
| Diff fidelity — typing, re-renders, clicks/state flips, shadow DOM, both resync fallbacks, native + ARIA selects, table/href/label blind spots | **GREEN** across six scenarios (`npm run bench:fidelity`), with vacuity guards so an empty run cannot score |
| Refusals and retractions (disabled, obstructed, blank-query, bounded error text, option-list retraction) | **GREEN** — 11/11, judged against the page's own event log; the wider guard suite's last full run was 72/72 (`npm run bench:guards`) |
| Ref stability across a re-snapshot | **Measured: 100%** on four real sites |
| Ref survival through a full re-render | **Measured**: survives for named elements; identical siblings **cannot be re-identified** — since the retirement fix they are refused rather than rebound |
| Positional refs under row *removal* | **Fixed and re-measured** — the family retires on membership change; zero landed wrong-element actions in 220 episodes, 90 stale acts refused in 50 |
| Positional refs under row *insertion* | **Fixed** — a positional family that gains a member escalates to a full `replace` |
| Equal-size same-walk family churn (one member out, one in) | **Undetectable in principle** at the key level — recorded, not pretended at |
| Cost vs Playwright MCP | **Measured** — 0.390× on realistic-weight pages, 0.823× on the adversarial small ones, null on small neutral ones; see above for scope |
| Task success attributable to the diff mechanism | **Measured: none** — diff − re-dump +0.0pp [−9.2, +9.2]; the product gap is engine and dialect |
| Page-size cost crossover | **Measured on the pre-tier5 engine** — diffs never significantly dearer, significantly cheaper from ≈10k chars up; lower edge unresolved, not re-run since |
| Autofill: profile matching, plan/apply, sensitive-field redaction | **Working** — verified end-to-end |
| Autofill consent gate | **Working** — native OS dialog the agent cannot render, see, click, or bypass |
| Dark mode (per-tab force-dark + per-site policy) | **Working** — CDP override verified on Electron 43 |
| Password manager UI | **Working** — content-protected window, entry CRUD, reveal with auto-hide, generator, identity + attachment + Notion editors |
| Vault MCP fill path | **Working** — crypto, origin binding (bundled PSL), native consent dialog, and the insertion itself; the password is never returned to the agent |
| Redaction of filled values in everything the agent reads | **Working** — seven mechanism classes, each with a guard, five of seven sabotaged by someone other than the guard's author. Residual: a short all-digit value on a *carried* origin |
| Web Bot Auth (RFC 9421 request signing) | **Working** — per-container key, agent-owned main-frame documents only, off unless a human configures it. Two live sabotage rows and the header-order measurement still owed |
| 2FA (TOTP) | **Working** — verified against the test vectors in RFC 6238 |
| Capture → Notion | **Working**; disk fallback verified. The Notion API path is **unverified** |
| Crash reporting to uh-oh | **Working** — verified end-to-end against a live server, payload audited for leaks. Off by default |
| Attachments (CV upload via `DOM.setFileInputFiles`) | Built; library is human-curated. Multi-upload forms need the ref→node bridge |
| Tracker blocking | Wired; not yet measured |
| Identity containers | Sessions, partitions and a stable per-container seed working; per-surface fingerprint derivation not applied |
| `inert` / `pointer-events: none` / small modal dialogs | **Known gap** — only `:disabled` and the covering-overlay hit-test are enforced |
| Structure/containment/position fidelity, iframes, model-side budget truncation | **Not measured by any benchmark** |
| Live-web behaviour | **Not measured** — every scored fixture is synthetic |
| Extensions | Not started — see below |

**A bug worth recording, because testing caught it and the design predicted it.**
The first end-to-end autofill run filled the date of birth through the
agent-blind path, and then leaked it straight back out in the next snapshot —
because the walker reads input values from the DOM. Filling correctly is only
half the job: the value now lives in the page, and the agent has tools that read
the page. Fixed with a per-tab taint set that redacts those fields before
anything downstream sees them, cleared on navigation. The redaction is a fixed
marker rather than a length-accurate mask, because length is real information
about a secret.

**Known risks, stated rather than buried:**

- **The positional-ref hazard is closed in one currency, not abolished.** On a
  re-rendering list of identical rows, a stale ref is now refused rather than
  silently rebound — but the agent still *reaches* for it, 90 times in 50
  measured episodes, and every refusal costs a round-trip. What was measured is
  zero landed wrong actions on fixtures built to force them; that is a result on
  those fixtures, not a structural guarantee.
- **A positional family that loses one member and gains another in the same
  walk is undetectable in principle** at the key level — membership size is
  unchanged and no key looks added, so no fixture can produce it and no
  diff-side rule can catch it. Closing it would need walker-side identity
  rebinding, which was ruled out on its own false-positive risk.
- **Two of the seven redaction guard classes have never faced an
  author-independent sabotage row** (C, alphabet; D, parity). They catch the
  instances they were written from, which is exactly the standard shown to be
  insufficient.
- Electron has no `declarativeNetRequest` and no `chrome.action`, so modern MV3
  content blockers and extension toolbar UI do not work out of the box. The
  community shim (`electron-chrome-extensions`) is ~13 months stale, GPL-3, and
  untested against Electron 43. Aperture uses Ghostery for blocking instead and
  treats Chrome-extension compatibility as an open question, not a promise.
- Several Electron API behaviors the design depends on still need verification —
  chiefly whether Electron's WebAuthn support can host a platform authenticator
  (if not, passkeys become a Chromium-patch project and the vault roadmap stays
  password-primary), and whether `setContentProtection` actually excludes the
  vault window from capture on Windows 11. `docs/design/security.md` and
  `docs/design/tier2.md` §6 carry the ranked queue. One item already resolved
  unfavourably: overriding the UA does **not** keep `Sec-CH-UA` client hints
  coherent, which cost a claim this file used to make.

## Getting started

```bash
npm install && npm run build && npx electron .
```

On launch it prints a ready-to-paste command and writes the same config to
`%APPDATA%/aperture/mcp.json`. The bearer token is regenerated every launch.

```bash
claude mcp add --transport http aperture http://127.0.0.1:8817/mcp -H "Authorization: Bearer <token>"
```

```bash
npm test         # full suite — snapshot engine, security, vault, bench readers
npm run typecheck
```

Benchmarks, and what each one answers, are in
[`docs/HANDOFF.md`](docs/HANDOFF.md); the results and their adjudications are in
[`bench/RESULTS.md`](bench/RESULTS.md).

## Layout

```
src/
  main/       Electron main: window, tab manager, IPC
  preload/    shell.ts (trusted chrome UI) · page.ts (hostile territory)
  renderer/   the browser chrome UI
  core/       snapshot engine — walker, registry, diff, render, volatility
  mcp/        MCP server + tool surface
  privacy/    containers, tracker blocking
  net/        the one webRequest mux · Web Bot Auth signing
  vault/      agent-blind password vault
bench/        tokens · live · fidelity · guards · task · size · headtohead · probes
docs/design/  snapshot.md · security.md · webbotauth.md · the tier specs · the adjudications
```
