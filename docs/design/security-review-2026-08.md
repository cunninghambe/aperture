# Security and hardening review — `ec467ea`, 2026-08-05

Reviewer: a third agent. Did not write `vaultfill.md`, did not build the fill
path, did not write `vaultfill-review.md`. Scope: the whole checkout at
`ec467ea` (tree clean), not a diff — plus the four axes the commissioning brief
named beyond a default sweep.

**Headline.** Four *new* plaintext escapes to agent context, all confirmed by
executed probe, none of which any existing guard arms. Two of them —
`document.title` and `location` — are page-controlled strings that live on
`Snapshot` rather than on `SnapshotNode`, and `redactTainted` walks the node
tree only. The engine's own comment states the rule as *"EVERY string on
`SnapshotNode` that the renderer can emit is a redaction sink"*
(`src/core/snapshot/engine.ts:412-413`). The rule is right and the scope is one
type too narrow. The renderer emits two strings that are not on that type.

Nothing here is a break of origin binding, of consent, or of the vault's
key handling. Every finding is in the containment layer that sits *behind*
those, and the practical adversary for all of them is the same one the needles
were built for: a late-injected skimmer on an origin that already holds the
credential.

---

## 0. What was actually run

Nothing below is inferred from reading alone unless it says so. The repository
was not modified: `git status --porcelain` is empty and `HEAD` is `ec467ea`
before and after. All probe artifacts live in the scratchpad, never in the repo,
and are deleted.

| # | Run | Result |
|---|---|---|
| 1 | `npx electron-vite build` from the shipped tree | clean |
| 2 | Aperture launched `--seed-vault --e2e-consent=allow --e2e-consent-delay-ms=600` | up on 8817; `--seed-vault` refuses beside a real vault, and there is no `vault.aperture` on this machine |
| 3 | `secprobe/probe.html` + `drive.mjs` — nine sinks, one secret (`guard-pw-93a1`) | **5 leaking / 9 probed**, two controls clean |
| 4 | `secprobe/probe2.html` + `drive2.mjs` — navigate-URL and obstructor | 2 further leaks confirmed |
| 5 | HTTP surface: token, wrong token, evil `Origin`, evil `Host`, `Host: localhost`, LAN bind | see §4 — all correct |
| 6 | `GET /metrics` body, decoded and tabulated | see §4.2 |
| 7 | Full-history secrets sweep (53 commits, 2 branches, 6 tags, dangling objects) | see §6 |
| 8 | Electron config audit: fuses, per-window `webPreferences`, CSP, IPC, permissions | see §5 |

Artifacts under test:

```
out/main/index.js    c3970981617bc91e2974af7bf7c1260caa81b480960130a8707d8ef67130d237
out/preload/page.cjs 7cda2dba0c6ebb7bc392dd7d85867af7b8a659298d0c749d7ef36fee28657b0e
```

**The skill did not run.** `/security-review` requires the harness working
directory to be a git root. A delegated agent's working directory is fixed at
launch and cannot be changed — `cd` in a shell call does not move it, and
`EnterWorktree` refuses a path outside the launch directory's repository. The
sweep below was performed manually and covers the same ground; this is recorded
so nobody later reads "the skill passed" into this document.

---

## 1. CONFIRMED — plaintext reaches agent context

All five were produced against the shipped build with the seeded credential
`guard-pw-93a1`, after a successful `vault_request_fill action:"apply"`, with
taint and needles live. Raw wire text, verbatim.

### F1 — `document.title` and `location` are rendered but never redacted (HIGH)

**Mechanism.** `observe()` calls `redactTainted(r.root, …)`
(`src/core/snapshot/engine.ts:213`), whose signature is
`redactTainted(root: SnapshotNode, …)` (`engine.ts:384`) — it walks the node
tree and nothing else. But `renderFull` emits two more page-controlled strings,
on the header line, from `Snapshot` rather than from any node:

```ts
// src/core/snapshot/render.ts:61
out.push(`page ${quote(snap.title)} ${snap.url}`);
```

Both are page-writable without navigating: `document.title = …` and
`history.replaceState(null, '', '/x?pw=' + …)`. A same-document URL change keeps
`documentReplaced` false, so `invalidate()` deliberately *keeps* the needles
alive (`engine.ts:130-141`) — the redaction state is fully armed and simply does
not cover these two fields.

Worse, the delivery is automatic. `const navigated = r.url !== st.last.url`
(`engine.ts:286`) forces a **full snapshot** on any URL change, and a full
snapshot is exactly what prints the header. The mechanism that guarantees the
agent hears about a route change is the mechanism that carries the secret.

**Measured** (probe P-S1/S2):

```
page "TITLESINK guard-pw-93a1" http://127.0.0.1:8900/probe.html?urlsink=guard-pw-93a1
```

**Reproduction.**
1. Launch `npx electron . --seed-vault --e2e-consent=allow --e2e-consent-delay-ms=600`.
2. Serve a login page on `http://127.0.0.1:<port>` with `username` +
   `password` inputs and a button whose handler runs
   `document.title = 'X ' + p.value; history.replaceState(null,'','/x?pw='+p.value)`.
3. `browser_navigate` to it, `vault_entries_for_origin`, `vault_request_fill
   action:"apply"`.
4. `browser_act click` the button, then `browser_snapshot mode:"full"`.
5. The header line carries the password in clear.

### F2 — `browser_tabs list` applies no redaction at all, and is cross-tab (HIGH)

```ts
// src/mcp/tools.ts:480-484
const lines = list.map((tab) =>
  `${tab.id === t.active ? '*' : ' '} ${tab.id} [${tab.container}] ` +
  `${tab.loadState} ${quote(tab.title)} ${tab.url}` + …
```

`tab.title` and `tab.url` come straight from `wc.getTitle()` / `wc.getURL()`
(`src/main/tabs.ts:241-242`). No needle scrub, no taint check, on any path.

This is worse than F1 in two ways. It needs no full snapshot — one
`browser_tabs` call is enough, and the tool is `readOnlyHint`-adjacent and cheap,
so an agent calls it freely. And it is an **aggregate across every open tab**,
while needles are keyed per tab (`needlesFor(tabId)`, `engine.ts:544`). Even
after F1 is fixed inside `observe()`, this listing sits outside the engine
entirely and would still leak.

**Measured** (probe P-S2b):

```
<untrusted-page-content id=b7cc5c43 origin=multiple>
* t1 [default] complete "TITLESINK guard-pw-93a1" http://127.0.0.1:8900/probe.html?urlsink=guard-pw-93a1
</untrusted-page-content id=b7cc5c43>
```

### F3 — `el.tagName` reaches agent prose raw, uncapped, outside the envelope (HIGH)

This is both a plaintext sink and a prompt-injection surface, and it is named
nowhere in `security.md`'s residuals list.

```ts
// src/preload/page.ts:893
return reply({ ok: false, reason: 'not-a-select', tag: el.tagName });
```
```ts
// src/mcp/tools.ts:1332-1333
return text(
  `error: ${ref} is a <${(sel.tag ?? 'element').toLowerCase()}>, not a ` + …
```

Every other page-authored string in `browser_act`'s prose goes through `quote()`
— which strips control and bidi characters, caps at `MAX_TEXT = 80`, and escapes
the delimiters (`src/core/snapshot/text.ts:36-75`). This one does not. It is
interpolated bare, into a sentence that sits deliberately **outside** the
untrusted envelope, in Aperture's own voice.

A custom element name may contain `[a-z0-9._-]` plus a wide Unicode range and
has **no length limit**. That is enough for both a needle leak and a
hyphen-separated instruction of arbitrary length in the harness's voice.

**Measured** (probe P-S3), from a page that ran
`document.createElement('x-' + password)`:

```
error: e10 is a <x-guard-pw-93a1>, not a native <select>, and only native
selects take action:"select". …
```

**Reproduction.** As F1 steps 1-3, then have the page append
`document.createElement('x-' + p.value)` with `role="button"`, snapshot to get
its ref, and call `browser_act action:"select" ref:<ref> option:"anything"`.

### F4 — select error prose and the select **success** line carry page labels unscrubbed (MEDIUM)

`vaultfill-review.md` item 9 named "`browser_act`'s obstructor id and the
`select` error labels" as a follow-up. Confirmed, and it is one call site wider
than the review recorded: the **success** path leaks too.

| site | code | envelope | measured |
|---|---|---|---|
| `no-match` suggestions | `tools.ts:1362` | inside | `"optsink guard-pw-93a1"` |
| `ambiguous` candidates | `tools.ts:1353` | inside | leaks |
| `ok select …` success label | `tools.ts:1417` | **outside** | `ok select e9 → "optsink guard-pw-93a1"` |
| `disabled` option label | `tools.ts:1368` | outside | same class, not separately armed |
| multi-select `previous` | `tools.ts:1410` | outside | same class, not separately armed |

The success line is the one to note: it is `quote()`d, so it is framed
correctly, but `quote()` is a *neutralizer*, not a *redactor*. Nothing on this
path consults the needles.

**Measured** (probe P-S8a / P-S8b), verbatim:

```
error: no option on e9 is called "zzz-nope" (3 options). Nearest by name:
<untrusted-page-content id=228ebb22 origin=http://127.0.0.1:8900>
"optsink guard-pw-93a1"
"optsink guard-pw-93a1 two"
"plain"
</untrusted-page-content id=228ebb22>
```
```
ok select e9 → "optsink guard-pw-93a1"
```

### F5 — obstructor id carries the secret, outside the envelope (MEDIUM)

`vaultfill-review.md` item 9's other half, now measured rather than reasoned.

```ts
// src/mcp/tools.ts:1299-1304
`error: ${ref} is covered by ` +
  `${r.obstructor ? quote(r.obstructor) : 'another element'} — ` + …
```

`obstructor` is built from the obstructing element's own `tagName` and `id`
(`src/core/snapshot/act.ts:53`). `quote()` bounds it to 80 characters, which is
comfortably more than a password.

**Measured** (probe P-S4), from an overlay with `id = 'ovl-' + password`:

```
error: e17 is covered by "DIV#ovl-guard-pw-93a1" — likely a modal or cookie
banner. Dismiss it first; …
```

### F6 — `browser_navigate`'s `loaded <url>` line is page-rewritable, and sits outside the envelope (MEDIUM)

```ts
// src/mcp/tools.ts:538-544
return text(
  `${info?.loadState === 'failed' ? 'failed' : 'loaded'} ${info?.url}\n` +
    untrusted(safeOrigin(info?.url ?? ''), `title: ${quote(info?.title ?? '')}`) +
    '\nCall browser_snapshot to see the page.',
);
```

The comment above these lines reasons carefully about the *title* — "page-authored
… so it is quoted and sits inside the untrusted envelope" — and treats the URL
as Aperture's own fact. It is not. A page that calls `history.replaceState`
during load settle chooses those bytes, and they are emitted raw, unquoted,
uncapped, **outside** the envelope, as the first line the agent reads after
landing.

**Measured** (probe P-N1), from a page that replaceStates on load:

```
loaded http://127.0.0.1:8900/probe2.html?navsink=IMMEDIATE-INJECTION-MARKER
<untrusted-page-content id=6286afbd origin=http://127.0.0.1:8900>
title: "Probe 2"
</untrusted-page-content id=6286afbd>
```

Percent-encoding limits fluency (no raw spaces), which is why this is MEDIUM and
F3 is HIGH — but hyphens, slashes and dots survive, and the length is unbounded.

### Controls that held

Stated so the negatives are as checkable as the positives.

| control | expectation | measured |
|---|---|---|
| `href` in the snapshot line | scrubbed since `0ff819e` | `link e1 "Continue to checkout" /leak?pw=(filled,value-withheld)` — **clean** |
| `browser_read` innerText | scrubbed via `redactFreeText` + live `taintedValues` | **clean** |
| the fill success line itself | no secret-bearing field | **clean** |
| `value` / `text` / `name` / `rows` | redacted | **clean** (marker present throughout) |

The `0ff819e` blocker fixes both hold. `href` is scrubbed with its own
whitespace-free marker, and the write-pass re-validation is live — the tool
description's "re-checked at the instant of the write" is backed by
`REASON_TO_CODE`'s `not-masked` / `not-editable` arms (`tools.ts:376-387`).

---

## 2. Why the existing guards did not catch F1 and F2

Worth stating precisely, because the fix for the *mechanism* is cheaper than the
fix for the instances.

**G19 would have caught it. No fixture arms it.** G19's assertion is
`!after.includes(SEEDED_PW)` over the **whole** snapshot text
(`bench/guards.mjs:954`). That predicate covers the header line. It never fires
because `test/fixtures/login.html`'s echo button writes `echo.textContent` and
`leaklink.href` and nothing else — it never touches `document.title` or
`history.replaceState`. Adding two lines to that button makes G19 red today and
green after the fix, with no new guard code.

**`completeness.test.ts` covers the fields — and asks the wrong question.**
The table is total over `keyof Snapshot`, so `url` and `title` both carry
rulings (`test/completeness.test.ts:120-131`):

- `url: { ruling: 'structural', by: 'the navigated hoist in engine.ts, which forces a full snapshot' }`
- `title: { ruling: 'excluded', why: '…tab-badge counters make the title a live region…' }`

Both rulings are correct *about diff fidelity*, which is the only vocabulary the
table has: `diffed` / `structural` / `excluded` all answer "will the agent be
told when this changes?". Neither answers "can this carry a secret?". So the one
CI check whose whole job is to stop a field entering the model without a ruling
will pass a new page-controlled string indefinitely — the failure class is
outside its question. And `title`'s ruling of `excluded` reads, to a later
reader, as *not delivered to the model*, when the renderer emits it on every
full snapshot and on every `browser_tabs` line.

The durable fix is a second axis on that table — `sink: yes|no` — plus moving
the engine comment's rule from "every string on `SnapshotNode`" to "every string
the renderer can emit".

---

## 3. Prompt-injection surface: page bytes outside the envelope

The brief asked for a current count. `security.md` names two residuals; there
are **nine** call sites where page-derived or page-influenced bytes land outside
an envelope, and the composition of the named residual has changed.

| # | site | treatment | in `security.md`? |
|---|---|---|---|
| 1 | `tools.ts:1301` obstructor `tagName#id` | `quote()` | yes — named |
| 2 | `tools.ts:1333` `sel.tag` | **raw, uncapped** | **no** — F3 |
| 3 | `tools.ts:539` `info?.url` | **raw, uncapped** | **no** — F6 |
| 4 | `tools.ts:1368` disabled option label | `quote()` | no |
| 5 | `tools.ts:1410` multi-select `previous` labels | `quote()` | no |
| 6 | `tools.ts:1417` select success label | `quote()` | no |
| 7 | `tools.ts:645` `r.reason` ← `page.ts:772` `err.message` | raw | yes — as "read" |
| 8 | `tools.ts:1285` `r.reason` ← `page.ts:651` `err.message` | raw | yes — as "resolve" |
| 9 | `tools.ts:1394` `sel.reason` ← `page.ts:952` `err.message` | raw | **no** — see below |

**The preload `reason:` audit in `security.md` is stale in a way that hides a
substitution.** The doctrine says four sites interpolate `err.message`, at lines
42/95/162/193, and names them walk / resolve / read / fill. The current four are:

- `src/preload/page.ts:202` — walk. Lands **inside** the envelope (the engine
  renders it as the observation). Harmless, as documented.
- `src/preload/page.ts:651` — resolve. Outside.
- `src/preload/page.ts:772` — read. Outside.
- `src/preload/page.ts:952` — **select**. Outside.

The **fill** site is now a fixed vocabulary — that half of the review's fix 6 is
already true in the code. But a *new* `err.message` site appeared on the select
path, so the total is coincidentally still four and the doctrine's arithmetic
looks current while its membership is wrong. `vaultfill-review.md` fix 6 says
"leaving three (resolve, read, select)" — that is the correct list, and it is the
one to write down.

The mitigating property `security.md` relies on still holds: these messages come
from native DOM calls in an isolated world whose builtins the page cannot
monkeypatch, so the page cannot *choose* the string. That argument does **not**
cover F3, where the page chooses the bytes directly by naming an element.

---

## 4. MCP server, transport, and `/metrics`

### 4.1 Transport — measured, and correct

| check | result |
|---|---|
| `GET /metrics`, no token | `401` |
| `GET /metrics`, wrong token | `401` |
| `GET /metrics`, valid token, `Origin: https://evil.example.com` | `403` |
| `GET /metrics`, valid token, `Host: evil.example.com` | `403` |
| `GET /metrics`, valid token, `Host: localhost:8817` | `401` (host accepted, auth refused — correct) |
| bind scope | `netstat`: `127.0.0.1:8817` only; no `0.0.0.0` listener |
| LAN reachability | connection refused |

Host and Origin validation run *before* auth (`src/mcp/server.ts:60-61`), so the
DNS-rebinding defence is not gated behind a token a page does not have. `/metrics`
sits below the auth gate as documented (`server.ts:95`). The bearer is
`randomBytes(24).toString('base64url')` per launch (`server.ts:47`). This part of
the design is sound and I could not find a way through it.

Two notes, both LOW and both out-of-envelope:

- **The bearer comparison is not constant-time** (`server.ts:64`,
  `auth !== \`Bearer ${token}\``). Over loopback against a per-launch 24-byte
  token this is not a practical attack; noted only because it is a one-line
  change to `timingSafeEqual`.
- **Port 8817 is fixed with no fallback.** A local process that squats it before
  Aperture starts becomes the agent's MCP server. Out of envelope by
  `security.md`'s own terms (local code execution as the same user), but the
  failure is silent to the human — Aperture's `http.once('error', reject)` makes
  startup fail loudly, which is the right half; the squatter answering the agent
  is the half nothing observes.

### 4.2 `/metrics` — no page data, but the documented shape is incomplete

Decoded live body, tabulated:

```
top-level keys: pid, uptimeS, metrics, witness
witness: {"landed":64,"unknown":0,"lost":0}
per-process fields: cpu, pid, type, creationTime, memory, integrityLevel, sandboxed
```

`security.md` documents the per-process element as `{ type, pid, cpu, memory }`.
The real array also carries `creationTime`, `integrityLevel`, `sandboxed` and
`serviceName`. The code comment is honest ("passed through verbatim so a consumer
reading only the fields it knows keeps working when Electron adds one"); the
*table* in the doctrine file is not. **The load-bearing claim — no page data, no
tab, no URL, no user-authored value — held under inspection.** This is doc drift,
not a disclosure.

A useful by-product: the endpoint answers §5's sandbox question empirically.

```
type       pid     integrity   sandboxed
Browser    7920    medium      false      ← main process, expected
GPU        37240   low         true
Utility    65432   medium      false
Tab        23708   medium      false      ← the shell chrome view
Tab        31700   untrusted   true       ← a web-content tab
```

Web content runs sandboxed at untrusted integrity. The unsandboxed renderer is
the local shell UI. That is the right way round, and it is why §5's `sandbox:
false` finding is MEDIUM rather than HIGH.

---

## 5. Electron and process hardening

### What is already correct

Stated first because it is most of the checklist, and because the fixes below
should not read as a project that skipped this. Fuses are configured via
`build/afterPack.cjs` and the three insecure defaults are all closed
(`RunAsNode`, `EnableNodeCliInspectArguments`,
`EnableNodeOptionsEnvironmentVariable` → `false`;
`EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`,
`EnableCookieEncryption` → `true`). `contextIsolation: true` and
`nodeIntegration: false` on every window. `webviewTag` off, no remote module, no
custom protocol handlers, no `certificate-error` override, no
`--disable-web-security`. CSP on both renderer HTML files with no `unsafe-eval`
and no `unsafe-inline` on `script-src`, verified to survive the bundler in
`out/renderer/*.html`. Zero `innerHTML`/`eval`/`document.write` anywhere in
`src/preload`, `src/renderer`, `src/core`. Tab navigation is scheme-allowlisted
in the main process, with regression coverage. Permission handlers deny by
default on every container session. `setContentProtection` on the vault window.
**`src/preload/page.ts` exposes nothing to the main world at all** — no
`contextBridge` call exists in it, verified by grep; a page has no IPC surface.
The vault IPC surface validates every sender.

### E1 — the shell window has no navigation allowlist (HIGH, theoretical)

```ts
// src/main/index.ts:223-227
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) event.preventDefault();
  });
});
```

A denylist of exactly one scheme, applied to every `webContents` including the
chrome view. `src/main/vaultWindow.ts:83` gets this right for the vault
(unconditional `preventDefault`); the shell window has no equivalent. If that
renderer is ever navigated to a remote origin, the preload re-runs and re-exposes
`window.aperture` — `tabs.navigate` (any tab, anywhere), `capture()` (screenshot
the active tab and route it), `vault.open`, and full tab enumeration with URLs
and titles.

**Classified theoretical, deliberately.** The guard is missing; the trigger is
not. `src/renderer/main.ts` builds the tab strip with `createElement` +
`textContent` and never touches `innerHTML` — I checked, because a page-authored
tab title rendered as HTML would have made this live. There is no link, no
`window.open`, and no injection sink in the shell today. This is a missing
structural guard on the highest-value window, not a one-click exploit.

### E2 — unvalidated `shell.openExternal` from the chrome renderer (HIGH, theoretical)

```ts
// src/main/index.ts:100-103
chrome.webContents.setWindowOpenHandler(({ url }) => {
  void shell.openExternal(url);
  return { action: 'deny' };
});
```

No scheme check. On Windows `openExternal` is a `ShellExecute`-class primitive:
`file:///C:/Windows/System32/…`, `ms-msdt:`, `search-ms:`, UNC paths. The
project already knows this — `src/main/vaultWindow.ts:222-227` allowlists the
same call to Notion HTTPS URLs with a comment saying exactly why. The shell
handler did not get the same treatment.

Same honesty caveat as E1: reaching it needs script in the chrome renderer,
which needs E1 or a future injection. E1 and E2 are one chain and should be
fixed in one change; together they are the only path in this review that ends in
code execution.

### E3 — `sandbox: false` on the shell window (MEDIUM)

```ts
// src/main/index.ts:53-59
chrome = new WebContentsView({
  webPreferences: {
    preload: join(__dirname, '../preload/shell.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  },
});
```

It buys nothing: `out/preload/shell.cjs` uses only `contextBridge` and
`ipcRenderer`, both available to a sandboxed preload, and there is no `node:`
import anywhere in `src/preload/`. `src/main/vaultWindow.ts:70` already reaches
this conclusion for the vault window. Confirmed live in §4.2 — that renderer runs
at medium integrity, unsandboxed, and it is the process holding the most
privileged bridge. `app.enableSandbox()` is not called.

### E4 — sixteen `ipcMain.handle` channels with no sender validation (MEDIUM)

`src/main/ipc.ts:67-73` wraps `ipcMain.handle` with no check at all. The file's
own docblock states the assumption — "Every handler here assumes a trusted
caller; that assumption is only sound because the chrome UI loads local content"
— and E1 is precisely the reason that premise is not guaranteed. Among the
unguarded channels: `tabs:navigate`, `capture:page`, `vault:open`, `vault:lock`.

The correct implementation already exists next door
(`src/main/vaultWindow.ts:116-128`, `e.sender.id === vaultWindowContentsId()`).
Port it, but check `senderFrame` origin rather than only `webContents.id` — the
id survives a navigation, so an id-only check would not catch E1, which is the
case that matters.

### E5 — `defaultSession` is never hardened (MEDIUM)

`harden()` is called only from `containers.sessionFor()`
(`src/privacy/containers.ts:79`), which operates on `persist:c-*` partitions.
Both trusted windows omit `session`/`partition` and therefore land on
`session.defaultSession` (`index.ts:54-59`, `vaultWindow.ts:63-74`), which has no
permission request handler, no permission check handler, and no ad/tracker
blocker. Bounded today because neither window loads remote content — but it is
the third link of the E1 chain: navigate the shell somewhere hostile and that
origin is auto-granted camera, mic and geolocation on top of `window.aperture`,
in an unsandboxed process.

### E6 — Electron 43.2.0 is one patch behind (MEDIUM)

`package-lock.json` and the installed tree both resolve `43.2.0` = Chromium
150.0.7871.129. Stable is 43.3.0 = Chromium 150.0.7871.212. The one
Electron-level fix named in 43.3.0 is a UAF in
`protocol.registerStreamProtocol`, which is **not applicable** — no custom
protocol is registered anywhere in `src/`. The Chromium `.129 → .212` delta is
security-relevant but the specific CVEs are **unverified**; treat it as "assume
renderer-exploitable bugs are fixed in .212". A low-risk patch bump.

### E7-E11 — lower

- **E7 (LOW).** `GrantFileProtocolExtraPrivileges` left at its permissive
  default and `strictlyRequireAllFuses` unset, so a future Electron fuse lands
  silently at its default. Two lines in `build/afterPack.cjs`.
- **E8 (LOW).** Eight `ipcMain.on('aperture:*-result')` channels
  (`act.ts:30-45`, `engine.ts:95-110`) dispatch on `requestId` alone with no
  check that the replying renderer is the tab the request went to. Presupposes
  an isolated-world compromise; the payloads are already treated as untrusted.
- **E9 (INFO).** `partition: undefined` at `src/main/tabs.ts:73` is ignored
  (`session` is also passed and wins). Per-tab process separation comes from
  Chromium site isolation. The property holds; the comment's stated mechanism is
  wrong, and a later reader could "clean up" the `session` line believing this
  one carries it.
- **E10 (INFO, but it voids a stated property).** `agent:activity` is subscribed
  to in `src/preload/shell.ts:60` and consumed in `src/renderer/main.ts:138`, and
  **nothing in `src/main/` or `src/mcp/` ever sends it**. The agent-activity pill
  never leaves "agent idle". `main.ts:134-135` states the property it is meant to
  hold — "a browser an agent can drive should never leave the human guessing
  whether something else is at the wheel" — and it is not held. This is the
  eighth thing marked working that is not.
- **E11 (INFO).** Renderer CSP omits `form-action`, `base-uri`, `frame-ancestors`,
  `object-src`. Free to add.

---

## 6. Secrets, history, and what the public repo discloses

### Clean

**No real secrets, at HEAD or anywhere in history. No history scrubbing is
required.** 53 commits, 2 branches, 6 tags, plus dangling objects, all swept.
Zero files were ever deleted (`--diff-filter=D` is empty), so there is no
add-then-delete residue. No artifact or binary file was ever committed. The
high-entropy hits are all synthetic and were opened individually:
`guard-pw-93a1` / `transport-pw-5c72` (the `seedForDev` fixture, double-gated),
`JBSWY3DPEHPK3PXP` (the canonical public TOTP demo seed), the RFC 6238 test key,
`hunter2`, and a hand-made `Bearer` string in `test/scrub.test.ts:17` which is
25 characters where a real token is 32.

**Committed bench artifacts are two markdown files.** `bench/RESULTS.md` and
`bench/headtohead/FIXTURE_CHANGELOG.md`. Zero episode logs, `.jsonl`,
screenshots or transcripts have ever been committed. `RESULTS.md` was read: it
carries aggregate counts against four logged-out public sites, no page content,
no cookies, no credentials.

### S1 — three pre-redaction bench logs hold live-format bearer tokens (LOW, on disk only)

Child-log redaction landed at **`6708162`** (2026-08-01 22:30Z),
`bench/lib/aperture.mjs:116-123`. Persistence and redaction landed in the *same*
commit — the prior version kept output in memory only, so no pre-persistence
artifact exists. But the working tree ran ahead of the commit, and three logs
were written before the scrub line existed:

```
bench/task/results/aperture.20260801T221529Z.log
bench/task/results/aperture.20260801T221729Z.log
bench/task/results/aperture.20260801T221833Z.log
```

Each contains a full `Bearer …` token. All three are gitignored
(`bench/task/results/`) and were verified absent from history. The tokens are
dead — per-launch, loopback-bound. Delete them; the risk is a future paste into
a bug report, not the tokens themselves.

### S2 — real personal data in a committed dev seed (LOW, deliberate to reconsider)

```ts
// src/main/index.ts:178-186
givenName: 'Brad', familyName: 'Cunningham',
fullName: 'Brad Cunningham', email: 'brad@example.com',
…
organization: 'PlusLife', jobTitle: 'Director',
city: 'Melbourne', region: 'VIC',
```

Real name, real employer, real city — mirrored in `bench/fidelity.mjs:177,184`
and `test/profile.test.ts:27-34`. Email, phone and street are placeholders. On a
public repo this is a linkage: the `cunninghambe` GitHub handle
(`README.md:314`), the `cunni` Windows username in absolute paths throughout the
red records, and this seed all point at one machine and one person. The author's
name is already in `LICENSE` and `package.json` by choice; the *employer* and
*city* are the two that add something. Swapping to `Acme` / `Testville` costs
nothing.

### S3 — `.gitignore`'s vault pattern matches nothing (LOW, but the net is illusory)

```
*.vault
.aperture-token
userdata/
```

The app's vault file is `vault.aperture` (`src/vault/vault.ts:105`).
`git check-ignore vault.aperture` → **not ignored**. The other two patterns have
zero code references. Verified by `git check-ignore`, none of the app's real
runtime artifacts are covered: `vault.aperture`, `profiles.dat`,
`telemetry.json`, `mcp.json`, `notion.dat`.

The real protection is that all of them live under `app.getPath('userData')` =
`%APPDATA%/aperture`, outside the repo. But **three tests point `userData` at
the repo root** — `test/consent.test.ts:26`, `test/security.test.ts:419`,
`test/vaultfill.test.ts:25` all mock `getPath: () => process.cwd()`. A future
test that exercises a persist path drops key material into the repo root, into a
gap the ignore file was written to close and does not. Also `bench/task/episodes.jsonl`
and any `*.png` outside `results/` are not ignored.

### S4 — `mode: 0o600` on `mcp.json` does nothing on Windows (LOW, doc claim is false)

```ts
// src/main/index.ts:229-235, 254-255
 * It is written 0600 and lives outside any project directory …
await writeFile(dest, JSON.stringify(config, null, 2), { mode: 0o600 });
```

Node honours only the read-only bit from `mode` on Windows; NTFS ACLs are
untouched. Measured:

```
NT AUTHORITY\SYSTEM     : FullControl
BUILTIN\Administrators  : FullControl
LAPTOP-…\cunni          : FullControl
```

Inherited default. Anyone who could read it is already out of envelope, so the
impact is nil — but the comment asserts a protection that does not exist on the
project's only supported platform, and the token is *also* printed to stdout
(`index.ts:259-262`), which is what put it in the bench logs of S1.

### What the published docs disclose (accepted, listed for the record)

Ports (8817/8899/8898/8896, `docs/design/tier2.md:38-40`); the vault filename,
its Argon2id → XChaCha20-Poly1305 construction, and that TPM/Windows Hello
contribute no key material (`README.md:362,413,417-418`); the bearer-token file
path; that `revealForHuman` is the sole plaintext egress; the dev bypass flags
`--seed-vault --e2e-consent=allow` reproduced verbatim along with the full
seeded record (`docs/design/vaultfill.md:988-990`); and that the author runs
unpackaged so argv is the only gate (`vaultfill-review.md:526-528`).

None of this is a vulnerability — it is a design document doing its job, and the
threat model is explicit that anything which can set Aperture's command line has
already won. Two items are worth a decision rather than a shrug: exact spend on
the author's Anthropic subscription (~$230-320 across `HANDOFF.md`,
`RESULTS.md`, `tier3.md`, `sweep-evaluation.md`), and timestamps throughout the
red records that place the author in US Eastern with working hours down to the
minute. Neither is a security fact; both are personal ones on a public repo.

---

## 7. `security.md` — the sentences this project has made false

Correcting the doctrine file is in scope as a finding. Six items.

1. **The load-bearing property, line 23.** *"The process that talks to the agent
   never receives plaintext on any channel, in any message type."* False as
   written. `main` is the process that talks to the agent, and `secretsForFill`
   delivers the password to it (`tools.ts:971`), where `registerNeedles` then
   retains it for up to ten minutes (`engine.ts:489-502`). `vaultfill-review.md`
   §1 already called this and the fix is the file's own *next* sentence: **no
   agent-facing response type has a field that can carry a secret.** That one I
   re-verified and it holds. Restate the headline as being about response types,
   and state the needle store's plaintext lifetime explicitly rather than leaving
   a reader to infer it.

2. **The injection table, line 40.** *"Copy value into a `<div>` and have the
   agent read it → Redaction while the fill is tainted (**designed, not yet
   implemented**)."* It is implemented, and measured working. Move it, and
   attach the residuals honestly: transformation defeats substring matching;
   truncation boundaries leak fragments; and — new as of this review — **the
   redaction covers `SnapshotNode` only, so `Snapshot.url`, `Snapshot.title`, the
   tab listing and every free-text prose channel are outside it** (F1-F6).

3. **The preload `reason:` audit, lines 110-119.** Line numbers are stale
   (42/95/162/193 → 202/651/772/952) and, more importantly, the *membership*
   changed while the count did not: **fill** is now a fixed vocabulary and
   **select** is a new `err.message` site. The correct sentence is
   `vaultfill-review.md`'s: three land outside the envelope — resolve, read,
   select.

4. **The residuals list, lines 100-106.** It names one `quote()`-capped
   residual. Add the two **uncapped, unquoted** ones this review measured:
   `sel.tag` (`tools.ts:1333`) and `info?.url` (`tools.ts:539`). The `quote()`
   argument — "the worst a page achieves is a strange quoted string" — does not
   apply to either, because neither is quoted.

5. **`GET /metrics`, lines 132-134.** The documented per-process shape
   `{ type, pid, cpu, memory }` omits `creationTime`, `integrityLevel`,
   `sandboxed` and `serviceName`. The no-page-data claim holds; the field list
   does not.

6. **Verification queue item 3** ("Is `webContents.debugger` attach detectable
   from page JS?") is still open and the fill path still depends on CDP for
   submit (`pressKey`) and for file attachment. Unchanged, restated so it is not
   read as closed.

---

## 8. The known-open list from `vaultfill-review.md` §§5-12 — verified

Each confirmed against the code at `ec467ea`.

| item | claim | verdict |
|---|---|---|
| 7 | `forget(tabId)` has no caller; needles ride a 10-minute timer past tab close | **CONFIRMED.** `grep -rn "forget("` over `src/`, `test/`, `bench/` returns only the export. `TabManager.close()` (`tabs.ts:107-124`) removes the view, closes the webContents, deletes from the map — and never calls `forget`. `states` also leaks a `tainted` set per closed tab. |
| 8 | profile (non-credential) values get no needles | **CONFIRMED.** `registerNeedles` has exactly one call site, `tools.ts:1001`, in the credential path. The profile path calls `markTainted` alone (`tools.ts:1624`), so it still relies on `taintedValues` reading live values back — which fails the moment the page copies a national ID out and clears the input. |
| 9 | `browser_act` / `select` error prose is not needle-scrubbed | **CONFIRMED AND WIDER.** Measured as F4 and F5. The review named the obstructor id and the select *error* labels; the select **success** line (`tools.ts:1417`) leaks too, and so do the `disabled` and multi-select `previous` paths. |
| 11 | submit focus race | **CONFIRMED as characterised.** `focusedKey` is measured in the page at reply time (`page.ts:473-477`) and compared in main an IPC round trip later (`tools.ts:1058`). The page can move focus in between. Blast radius is an Enter in the wrong field, not a credential in one — the *value* is aimed by element identity, not by focus. |
| 12 | `observe()` advances the shared baseline | **CONFIRMED.** `vault_request_fill` calls `await observe(id, wc)` at `tools.ts:823` for its own planning; `browser_fill_form` does the same at `tools.ts:1541`. Refs are marked emitted for a render the agent never saw, and a page change between the agent's last observation and the fill is silently absorbed. |
| — | `FILL_UNCONFIRMED` reachable, `FIELD_IN_SUBFRAME` unreachable | not re-measured; no reason to doubt the review's measurements |

All five are correctly characterised. Item 7 is the one I would raise a tier:
`forget` is one line and it is the only item on the list that leaves **plaintext**
alive after the user has visibly closed the thing it belongs to.

---

## 9. Prioritised fix list

Each item: files, whether it moves a benchmark cohort identity, what must re-run.

### P0 — before the vault holds a real credential

**1. Redact `Snapshot.url` and `Snapshot.title`.** (F1)
*Files:* `src/core/snapshot/engine.ts` (redact `r.url` / `r.title` alongside
`redactTainted`, before the `navigated` comparison at line 286 so the forced full
snapshot renders the scrubbed strings), `src/core/snapshot/render.ts` if the
marker needs the whitespace-free form for the URL — it does, same reasoning as
`REDACTED_HREF`.
*Guard:* extend `test/fixtures/login.html`'s "Echo password to page" handler with
`document.title = …` and `history.replaceState(…)`. G19's existing whole-snapshot
predicate then asserts it with no new guard code; add G19c naming the header line
on its own, mirroring how G19b was split from G19.
*Cohort:* **no.** The snapshot stream for pages that do not write secrets into
their title or URL is byte-identical.
*Re-run:* `vitest`, `bench/guards.mjs --phase=allow`, `bench/fidelity-all.sh`.

**2. Redact the tab listing.** (F2)
*Files:* `src/mcp/tools.ts:480-491` — scrub each line against that tab's own
needles before joining. This needs a per-tab scrub helper exported from
`engine.ts`, because the listing is an aggregate and `redactFreeText` is
single-tab.
*Guard:* new G19d — fill in one tab, echo into its title, `browser_tabs list`
from another tab.
*Cohort:* **no.** Tab listings carry no secret on any benchmark fixture.
*Re-run:* `vitest`, `guards.mjs`.

**3. `quote()` and needle-scrub `sel.tag`.** (F3)
*Files:* `src/mcp/tools.ts:1333`. One call. This is the only P0 item that is also
a prompt-injection fix, and it closes the uncapped-length problem at the same
time since `quote()` caps at 80.
*Cohort:* **no.**
*Re-run:* `vitest` (add a `selectOption` case), `guards.mjs`.

**4. `forget(tabId)` from `TabManager.close()`.** (§8 item 7)
*Files:* `src/main/tabs.ts:107-124`, one line.
*Cohort:* **no.**
*Re-run:* `vitest`.

**5. Pin the shell window's navigation and allowlist `shell.openExternal`.**
(E1 + E2 — one change, they are one chain)
*Files:* `src/main/index.ts:100-103` and after line 60. Mirror
`vaultWindow.ts:83` and `vaultWindow.ts:222-227`. Roughly four lines.
*Cohort:* **no.**
*Re-run:* `vitest`, one manual launch to confirm the chrome UI still works.

### P1 — same pass, lower blast radius

**6. Route every prose channel through the needle scrub.** (F4, F5, F6)
*Files:* `src/mcp/tools.ts` — obstructor (1301), disabled label (1368),
multi-select previous (1410), select success (1417), suggestions (1362),
candidates (1353), navigate URL (539). The clean shape is one
`safeForAgent(tabId, s)` helper that does `quote()` **and** the needle scrub, so
a future call site cannot get one and miss the other.
*Cohort:* **no.**
*Re-run:* `vitest`, `guards.mjs`.

**7. Add a `sink` axis to `completeness.test.ts`.** (§2)
*Files:* `test/completeness.test.ts` — a second field on `Ruling`, total over both
`keyof SnapshotNode` and `keyof Snapshot`, so a new page-controlled string cannot
be added without ruling on whether it is a redaction sink. Update the engine
comment at `engine.ts:412-413` from "every string on `SnapshotNode`" to "every
string the renderer can emit".
*Cohort:* **no.**
*Re-run:* `vitest`.

**8. Sender-validate `src/main/ipc.ts`.** (E4)
*Files:* `src/main/ipc.ts:67-73`, port the `vaultWindow.ts:116-128` guard, check
`senderFrame` origin not only `webContents.id`.
*Cohort:* **no.**
*Re-run:* `vitest`, one manual launch.

**9. `sandbox: true` on the shell window; harden `defaultSession`.** (E3, E5)
*Files:* `src/main/index.ts:58` (delete the line), and either
`harden(session.defaultSession, …)` at startup or pass the container session into
both trusted windows. Consider `app.enableSandbox()`.
*Cohort:* **no**, but this one genuinely can break the UI — verify by launch, not
by test.
*Re-run:* `vitest`, manual launch, `guards.mjs` (the chrome view is not on the
guard path, but a startup regression would take everything with it).

**10. Correct `docs/design/security.md`.** (§7, all six items)
*Cohort:* n/a. *Re-run:* `test/docs.test.ts` if it pins any of these strings.

### P2 — housekeeping

11. `electron@43.3.0` (E6). *Re-run:* full suite + `guards.mjs`; a Chromium bump
    is the one change here that **could** move fidelity output, so re-run
    `fidelity-all.sh` and compare before claiming no cohort impact.
12. Delete the three pre-redaction bench logs (S1).
13. Fix `.gitignore`: `*.vault` → `vault.aperture`, add `profiles.dat`,
    `telemetry.json`, `mcp.json`, `notion.dat`, `*.jsonl`, `*.png`, `.claude/`;
    drop the two dead patterns (S3).
14. Change the demo seed's `organization` / `city` to placeholders (S2).
15. Correct the `0600` comment at `index.ts:229-235` — say plainly that the mode
    is a no-op on Windows and the file's protection is the user profile (S4).
16. Needles for sensitive profile values (§8 item 8).
17. `GrantFileProtocolExtraPrivileges: false`, `strictlyRequireAllFuses: true`
    (E7); CSP `object-src`/`base-uri`/`form-action`/`frame-ancestors` (E11);
    `timingSafeEqual` on the bearer (§4.1); sender check on the
    `aperture:*-result` channels (E8); fix the `partition: undefined` comment
    (E9).
18. **Wire `agent:activity`, or delete the pill** (E10). It is a stated security
    property that is silently false.
19. **The suite is RED at `ec467ea`, and has been since `7a66107`.**
    `npx vitest run` → **511 passed, 1 failed**. `test/docs.test.ts` forbids a
    test count in prose, and `docs/HANDOFF.md:494` says *"Free battery green: 512
    tests, fidelity 6/6"*. The guard is working exactly as designed and the
    sentence that tripped it is the one claiming the battery is green. Not a
    security defect — filed here because a suite that is red at HEAD teaches
    whoever runs it to skim the result, and every finding in §1 depends on
    somebody reading a red line and believing it.

---

## 10. What I could not verify

- **The specific Chromium CVEs** in the `150.0.7871.129 → .212` delta. I found no
  per-patch list I trust and will not guess numbers.
- **E1 and E2's trigger.** I confirmed the guards are missing and that the
  preload re-binds on navigation. I did not find, and did not manufacture, a way
  to make the shell renderer navigate. Both are filed theoretical for that reason.
- **Anything against a real login site.** Every measurement here, as in the two
  reviews before it, is against fixtures. The first real site is still an
  experiment.
- **Punycode rendering in the Win32 task dialog** — same as `vaultfill-review.md`
  §7; the string handed to the dialog is provably punycode, what the dialog draws
  is not in doubt but is not measured.
- **Whether `document.title` / `location` leak through any path I did not
  enumerate.** I probed nine sinks and found five. The `href` finding at
  `c375415` and these two suggest the honest prior is that more exist. The
  structural fix (P1 item 7) matters more than the four instance fixes, because
  it changes what the next reviewer has to do from *reading* to *reading a table
  that must be total*.
- **`--seed-vault` behaviour beside a real vault.** There is no `vault.aperture`
  on this machine, so `seedForDev`'s refusal branch was not exercised. Read, not
  run.

---

## 11. Is this safe as the owner's daily browser?

**Yes — with fix 1, 2 and 3 landed before the vault holds a real credential, and
fix 5 landed before anything is added to the chrome UI that can navigate it.**

The reasoning, stated so it can be argued with:

- **The boundaries held.** Origin binding is decided from the vault and the tab's
  committed URL before the page is consulted, and has no override. Consent is a
  native dialog with no agent-reachable parameter, Cancel as both default and
  escape, a decline cooldown checked twice, and a rate limiter. The credential
  path is dormant until a human creates a vault. The agent-facing response types
  still carry no field that can hold a secret — I re-checked this and it is the
  property the design actually rests on. `src/preload/page.ts` exposes nothing to
  page script at all. The MCP transport refused every rebinding and auth probe I
  threw at it.

- **Every finding here is in the containment layer, not a boundary.** F1-F6 all
  require an origin that **already holds the password** — Aperture just wrote it
  into that origin's DOM. `security.md` is right that such an origin can
  exfiltrate with its own `fetch()`, so the needles only ever mattered against a
  late-injected skimmer that can write the DOM and steer the agent but cannot
  phone home. That is a narrow adversary. It is also precisely the adversary the
  needles were built for, which is why these block rather than merely annoy.

- **The tab-list leak (F2) is the one I would not sit on.** It needs no full
  snapshot, no navigation, and no unusual agent behaviour — one cheap
  `browser_tabs` call. And it is cross-tab, so it is the only finding here whose
  blast radius is not confined to the origin that already has the secret.

- **What would change the answer.** Any of: the shell UI gaining a link,
  `window.open`, or an `innerHTML` sink (E1+E2 stop being theoretical the day
  that lands, and the chain ends in code execution); a real credential entering
  the vault before fixes 1-3; or the `agent:activity` pill staying dead while the
  human is told the browser shows them when the agent is at the wheel. The last
  one is not exploitable and is the one I would fix first anyway, because a
  security property that is false and believed is worse than one that is absent.

- **The dev affordances remain the honest residual.** The owner runs unpackaged,
  so `!app.isPackaged` is always true and the absence of `--e2e-consent` on the
  command line is the only gate. That is acceptable under the stated envelope —
  anything that can set Aperture's argv has already won — but it means the
  packaged-inertness test is not what protects daily use. G28 makes it
  observable. It reproduced.

One last thing, about method rather than findings. The `href` sink at `c375415`
was found by probe after a review-by-reading missed it. The two biggest findings
here — `title` and `location` — were also found by probe, and they sit *one type
declaration away* from the field that fix closed, guarded by a completeness
table that rules on both of them and asks the wrong question about each. The
lesson the project keeps paying for is not "probe more". It is that the guards
which are supposed to make probing unnecessary are scoped to the last failure
rather than to the failure class.
