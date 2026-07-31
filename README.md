# Aperture

An AI-native, privacy-first browser. The primary user is an agent; the human is
the one who stays in charge.

> **Status: v0.1, early.** The shell runs and browses, the MCP server works and
> Claude Code can drive it, and the snapshot engine's logic is built and tested.
> The in-page bridge that connects them is not wired yet. See
> [Honest status](#honest-status) — nothing below is claimed as working unless
> it is marked working.

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

| | playwright-mcp style | Aperture (design target) |
|---|---|---|
| Initial observe | ~10,000 tok | ~1,200 tok (budgeted) |
| Per action | ~10,000 tok | ~40–150 tok |
| 20-action task | **~210,000 tok** | **~4,000 tok** |

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
- **Ref discipline.** Only actionable elements get refs. Playwright MCP puts 789
  refs on a GitHub page; a disciplined pass puts ~245, and the output is 4.5×
  smaller.

## Small tool surface, deliberately

Every registered MCP tool costs roughly 1,000 tokens of schema before it does
anything. playwright-mcp (~50 tools) and chrome-devtools-mcp (51) levy a ~50k
token tax on every session. Aperture ships 8 tools behind `action`
discriminators.

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

**What this does not claim:** a page can read back its own DOM, so a password
delivered to an origin is a password that origin has. A password manager's real
guarantee is *correct routing*, not secrecy from the site. Passkeys are the
actual fix; every password in a vault is technical debt.

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
| MCP server over Streamable HTTP, 8 tools | **Working** — verified against a live browser |
| Bearer auth + DNS-rebinding guards | **Working** — verified (401 / 403) |
| Untrusted-content envelope | **Working** — verified |
| Snapshot engine: refs, diff, render, volatility | **Built and tested** (37 tests) — *not yet wired to a live page* |
| In-page walker | Written; the preload↔main bridge is the next piece |
| Tracker blocking | Wired; not yet measured |
| Identity containers | Sessions and partitions working; per-container fingerprint not applied |
| Vault | Crypto and API shape done; **fill path deliberately refuses** rather than pretending |
| Extensions | Not started — see below |

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
