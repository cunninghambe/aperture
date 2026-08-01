# Aperture

An AI-native, privacy-first browser. The primary user is an agent; the human is
the one who stays in charge.

> **Status: v0.2, early but real.** The browser runs, the MCP server works, and
> Claude Code can drive it end to end — snapshot, diff, autofill, capture. The
> vault has a working UI, tested crypto, and PSL-backed origin binding. 179
> tests pass, including regression tests for every finding of the security
> review. See
> [Honest status](#honest-status) for what is *not* done — nothing below is
> claimed as working unless it is marked working.

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
re-serializes the entire page after every single action. A real page is
15–20k tokens as a naive accessibility-tree dump. A 20-action task therefore
burns 200k+ tokens re-reading a page that mostly did not change.

Aperture treats the loop as **act → observe delta**. `browser_act` returns what
changed, against a page state the model already holds.

`npm run bench` measures both modes over the same 20-action sequence on the same
page. Observation cost, in tokens:

| list items | full snapshot | re-dump mode | diff mode | ratio |
|---|---|---|---|---|
| 5 | 236 | 4,956 | 756 | **6.6×** |
| 24 | 937 | 19,677 | 2,158 | **9.1×** |
| 60 | 2,276 | 47,796 | 4,836 | **9.9×** |
| 150 | 5,698 | 119,658 | 11,680 | **10.2×** |

> **An earlier version of this README claimed ~50×.** That number was a design
> target I had never measured, and the first benchmark contradicted it. The
> real figure is roughly **7–10×**, rising with page size. Still a large win —
> and an order of magnitude smaller than what I had written down.
>
> Even this is a synthetic page, not a head-to-head run against playwright-mcp
> on real sites. Read it as a floor on the mechanism's value, not as a
> competitive result.
>
> The number that matters more is one nobody has published: **task success
> rate on diffs versus full re-dumps.** A model reconstructing page state from
> a base snapshot plus twelve deltas is doing bookkeeping that a re-dump does
> for it. If completion rates drop, the token saving is negative and this whole
> design is wrong. The fallback thresholds (30% change, 12 diffs) are currently
> reasoned guesses, not tuned values.
>
> `npm run bench` measures the token half on a local fixture. The success-rate
> half needs a task suite and is the single largest open gap in the project.

Making that safe rather than merely small is the actual engineering:

- **Stable refs.** `e42` names a *logical element*, not a DOM node, so it
  survives a React re-render that replaced every node. Identity is
  `data-testid` → `name` → non-generated `id` → role + accessible name +
  nearest named ancestor + semantic path. Framework-generated ids (`:r1:`,
  hash suffixes) are rejected, because keying on them would make every ref
  unstable.
- **Keyed reconciliation, not tree-edit-distance.** Identity keys turn matching
  into a hash lookup, so diffing is O(n) with a longest-increasing-subsequence
  pass so "one row jumped to the top" is one op, not twenty.
- **Explicit resets.** Diffs name the state they apply to (`diff from #7.3`). On
  navigation, on >30% change, or after 12 diffs, the engine emits a full
  snapshot headed `FULL SNAPSHOT — replaces all prior state`, which tells a
  model whose context was compacted to discard its mental model.
- **Noise suppression.** A clock is recognized by shape and suppressed after one
  unprompted tick; anything changing repeatedly on its own is demoted; anything
  the agent reads or acts on is promoted straight back. Without this, one
  ticking timestamp defeats the entire diff argument.
- **Positional fallback, acknowledged as fragile.** Elements distinguishable only by position (ten identical "Add to cart" buttons) get a document-order ordinal appended to their key. That makes those refs positional, and reordering is exactly what breaks positional identity — a real limitation, and the honest trade against the alternative, which was one ref for ten buttons and a silent click on the wrong product.
- **Ref discipline.** Only actionable elements get refs. Measured against
  playwright-mcp on the same pages: 97 refs vs 446 on a GitHub repo page, 206 vs
  611 on a Wikipedia article. That makes each snapshot **~1.9× smaller** — the
  README previously claimed 4.5×, which was a third-party number for a
  different tool. See [bench/RESULTS.md](bench/RESULTS.md).

## Small tool surface, deliberately

Every registered MCP tool costs roughly 1,000 tokens of schema before it does
anything. playwright-mcp (~50 tools) and chrome-devtools-mcp (51) levy a ~50k
token tax on every session. Aperture ships **13**, kept down by putting related
operations behind an `action` discriminator rather than splitting them into a
tool each:

```
browser_tabs      browser_navigate   browser_snapshot   browser_read
browser_fill_form browser_profile    browser_attach     browser_capture
browser_container browser_theme      browser_console
vault_entries_for_origin             vault_request_fill
```

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
  container, with a persistent per-container fingerprint. Containers cannot be
  merged and sites cannot be moved between them from the agent surface: a page
  that could talk the agent into merging two containers defeats the isolation in
  one move, so that stays a human decision.
- **Fingerprint consistency over randomness.** Randomizing canvas noise per load
  makes you *more* identifiable — real browsers are boringly stable, so a
  machine whose fingerprint changes every load is wearing a sign. One seed per
  container, every surface derived from it, frozen while the container holds
  state.
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

**Taint redaction is best-effort, not a guarantee.** Mirrored values are caught by exact substring match, so a reformatted date (fill `1990-01-05`, page echoes `January 5, 1990`), a case change, or a value split across text nodes all defeat it — and it over-redacts, turning every "Anna" on the page into a marker if that is your first name. It raises the cost of an accidental echo; it is not a boundary. The boundaries are origin binding and the process split.

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
   blank region — including the agent's own capture tool.
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

37 tests cover this, including "an unknown top-level field is dropped" and "a
malformed event fails closed."

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

All three are fixed and now have tests, including one asserting that scrubbed
output still satisfies the wire contract. The lesson is worth keeping: a test
that shares the code's assumptions validates the assumption, not the behaviour.

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
wrapped in an `<untrusted-page-content>` envelope** that states the boundary at
the point of consumption. The snapshot format reinforces it — all page-authored
text is quoted and control/bidi characters are stripped, so a page cannot emit
text that parses as snapshot structure or forge a `FULL SNAPSHOT` header.

## About CAPTCHAs — read this before expecting Camoufox behavior

The original goal here was "avoids CAPTCHAs like Camoufox." Having researched
the 2026 state of the art, **that premise does not hold, and building toward it
would be building the wrong thing.**

CAPTCHA decisions are made across four layers:

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
**Web Bot Auth** (RFC 9421 HTTP message signatures; W3C spec finalized May 2026)
lets an agent cryptographically identify itself and be *allowed*. Cloudflare
begins splitting AI traffic into Search/Agent/Training on 2026-09-15, blocking
unidentified agents by default on ad-monetized pages. Aperture should implement
Web Bot Auth — it is on the roadmap and anti-detect is not.

Aperture is built for **your** browsing: your accounts, your sessions, your
automation. It is not a mass-evasion tool and will not be pointed in that
direction.

## Honest status

| Area | State |
|---|---|
| Electron shell, tab model (`WebContentsView`), browser UI | **Working** — launches and browses |
| MCP server over Streamable HTTP, 13 tools | **Working** — verified against a live browser |
| Bearer auth + DNS-rebinding guards | **Working** — verified (401 / 403) |
| Untrusted-content envelope | **Working** — verified |
| Snapshot engine end-to-end (walker → refs → diff → render) | **Working** — verified on a real form |
| Autofill: profile matching, plan/apply, sensitive-field redaction | **Working** — verified end-to-end |
| Dark mode (per-tab force-dark + per-site policy) | **Working** — CDP override verified on Electron 43 |
| Attachments (CV upload via `DOM.setFileInputFiles`) | Built; library is human-curated. Multi-upload forms need the ref→node bridge |
| Tracker blocking | Wired; not yet measured |
| Identity containers | Sessions and partitions working; per-container fingerprint not applied |
| Vault | Crypto, origin binding (bundled PSL) and API shape done; **MCP fill path deliberately refuses** rather than pretending |
| Password manager UI | **Working** — content-protected window, entry CRUD, reveal with auto-hide, generator, identity + attachment + Notion editors |
| Capture → Notion | **Working**; disk fallback verified. The Notion API path is **unverified** — see caveat below |
| 2FA (TOTP) | **Working** — verified against RFC 6238 test vectors |
| Crash reporting to uh-oh | **Working** — verified end-to-end against a live server, payload audited for leaks. Off by default |
| Autofill consent gate | **Working** — native OS dialog the agent cannot render, see, click, or bypass |
| Token benchmark | **Working** — synthetic (`npm run bench`) plus real-site head-to-head vs playwright-mcp, see [bench/RESULTS.md](bench/RESULTS.md) |
| Layout-table handling | **Fixed** — the benchmark found HN collapsing to 1 usable ref |
| `browser_act` (click/type/hover/scroll/key) | **Working** — trusted CDP input, returns a diff, verified on a real form |
| Ref survival through a full re-render | **Measured**: survives for named elements; **FAILS for identical siblings** (positional keys can mis-target). See [bench/RESULTS.md](bench/RESULTS.md) |
| Diff fidelity, static page | **GREEN** (`npm run bench:fidelity`) |
| Diff fidelity, full re-render | **GREEN** — the earlier RED was a lossy benchmark, not an engine fault |
| Task-success benchmark | **Not started** — now genuinely unblocked |
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

- Electron has no `declarativeNetRequest` and no `chrome.action`, so modern MV3
  content blockers and extension toolbar UI do not work out of the box. The
  community shim (`electron-chrome-extensions`) is ~13 months stale, GPL-3, and
  untested against Electron 43. Aperture uses Ghostery for blocking instead and
  treats Chrome-extension compatibility as an open question, not a promise.
- Several Electron API behaviors the design depends on need verification before
  being relied on — chiefly whether overriding the UA keeps `Sec-CH-UA` client
  hints coherent (if it does not, spoofing the UA is *worse* than not), and
  whether Electron's WebAuthn support can host a platform authenticator.
  `docs/design/security.md` carries the full verification queue.

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
npm test         # snapshot engine (37 tests)
npm run typecheck
```

## Layout

```
src/
  main/       Electron main: window, tab manager, IPC
  preload/    shell.ts (trusted chrome UI) · page.ts (hostile territory)
  renderer/   the browser chrome UI
  core/       snapshot engine — walker, registry, diff, render, volatility
  mcp/        MCP server + tool surface
  privacy/    containers, tracker blocking
  vault/      agent-blind password vault
docs/design/  snapshot.md · security.md
```
