# Design: the vault fill path

Status: **SPEC, decision-complete.** Written 2026-08-02 against `master` at
`1381e10` ("bench: head-to-head vs Playwright MCP — 385 episodes,
adjudicated"). One builder executes it verbatim.

Binding companions, read before starting: `docs/design/security.md` in full
(the doctrine is settled and is not re-litigated here), `docs/design/tier1.md`
§2 (the owned divergence between CDP input and isolated-world state mutation),
`docs/design/tier3.md` §1 (W1, and why `ok` has to mean arrival),
`docs/design/tier4.md` §0 and §9 (pre-landing evidence, and the shape of an
acceptance battery).

**Sequencing.** This change edits `src/mcp/**`, `src/preload/**` and
`src/core/snapshot/engine.ts` — all inside `bench/lib/store.mjs`'s `WATCH_DIRS`
— and requires a rebuild, which moves `buildVersion`. It therefore **severs
every existing bench store**. That is the integrity design working, and it is
only payable because the head-to-head cohort completed at `1381e10`: the
tier4 freeze ("no watched-file edit between `tier4-landed` and the h2h
cohort's completion") has lifted. Do not land any part of this while a scored
cohort is open. Land it as ONE change set, verified by ONE battery, followed by
ONE rebuild.

**Ownership.** This document is the only file its author owns. `README.md` and
`docs/HANDOFF.md` are being edited concurrently by another agent and must not
be touched by the builder either; if they need updating, that is a follow-up
after this lands.

---

## 0. The use case, stated once so the rulings can be checked against it

The owner opens a job application or a signup flow. The agent reads the page,
fills the identity fields from the saved profile, attaches the CV from the
library by id, and — where the flow requires signing in — asks Aperture to put
a saved credential into the form. The human does the CAPTCHA, reads the consent
dialog, and clicks. The agent never holds the password, never holds the TOTP
code, and cannot read either back out of the page afterwards.

Everything below is in service of the last sentence.

---

## 1. What actually exists, verified by reading the code at `1381e10`

The coordinator's belief — that the fill EXECUTION path is the hole — is
**correct but incomplete**. The execution path is absent, and four of the
things around it that look present do not do what their comments say. Both
halves are this spec's problem.

### 1.1 Built and working

| Piece | Where | State |
|---|---|---|
| Encrypted vault, argon2id + XChaCha20-Poly1305, write-then-rename | `src/vault/vault.ts` | Built, unit-tested |
| `registrableDomain()` — bundled PSL via `tldts`, `allowPrivateDomains`, ICANN/private assertion, `SUPPLEMENTAL_SUFFIXES` | `src/vault/vault.ts:443-541` | Built, heavily tested (`test/security.test.ts`) |
| `listPublic(origin)` — origin-scoped, no list-all, metadata only | `src/vault/vault.ts:219` | Built |
| `resolveForFill(entryId, committedOrigin)` — not exported to MCP or IPC, returns the secret or a deny code | `src/vault/vault.ts:244` | Built; two defects, F2 and F3 below |
| `VaultEntryPublic` — id, origin, username, hasTotp, lastUsed, and nothing that can carry a secret | `src/shared/types.ts:126` | Built |
| TOTP (RFC 6238), otpauth parsing, human-only `totpCode()` | `src/vault/totp.ts`, `vault.ts:289` | Built, unit-tested |
| Human-only vault window: separate contents id, guarded IPC, `setContentProtection(true)`, navigation denied | `src/main/vaultWindow.ts` | Built |
| Native consent dialog, rate limit, grants, Cancel as default and escape | `src/main/consent.ts` | Built; three defects, F1/F7/F8 |
| Identity profile matcher and fill plan (pure, tested) | `src/vault/profile.ts` | Built |
| Attachment library — agent picks by id, never a path | `src/vault/attachments.ts` | Built |
| Isolated-world write primitive: native prototype setter + `input`/`change` | `src/preload/page.ts:215-256` | Built; four defects, F5 |
| Taint set + tree redaction + free-text redaction | `src/core/snapshot/engine.ts` | Built for node-local values only; see F9 |
| `vault_entries_for_origin` — origin from the tab, never a parameter | `src/mcp/tools.ts:474-511` | Built |
| Untrusted-content envelope | `src/mcp/envelope.ts` | Built, property-tested |

### 1.2 Stubbed

`vault_request_fill` (`src/mcp/tools.ts:513-545`) is registered with a full
schema (`entryId`, `tabId`, `submit`) and a handler that destructures **only
`tabId`**, ignores everything else, and returns:

```
fill refused: the vault fill path is not yet wired in this build.
No credential was read, and none was inserted.
```

That is the whole of the execution path. There is no caller of
`resolveForFill` anywhere in `src/` outside its own file.

### 1.3 Absent entirely

- Any code that chooses WHICH field on a page is the username, password or
  one-time-code field. `collectFields` (`tools.ts:173-193`) deliberately
  **excludes** `inputType === 'password'`, so the profile matcher cannot be
  reused as-is and was never meant to be.
- Any origin re-verification between the human's click and the DOM write.
- Any check that the element about to receive a password is a masked field, is
  in the top frame, is connected, is editable, or is not covered.
- Any post-write verification. Nothing anywhere asks whether the value stuck.
- Any TOTP path that reaches a page. `totpCode()` is reachable only from
  `vaultui:totp`, which the guard in `registerVaultIpc` restricts to the vault
  window.
- Any consent shape for credentials. `requestFillConsent` has one shape, and it
  offers a ten-minute grant.

### 1.4 The gap, named

> Between "the agent proposes a fill" and "the credential is in the page,
> correctly, once, on the right origin" there is: field selection, a
> credential-shaped consent, an origin-safe write, a verification that the
> write survived, and a redaction régime that covers the value after it lands.
> All five are missing. The write PRIMITIVE exists and is sound; everything
> that makes it safe to point at a password does not.

---

## 2. Findings from the read — defects the builder must not carry forward

Each was verified by reading the code at `1381e10`, not inferred. Line numbers
drift; the mechanism is the durable part.

**F1 — `revokeAllGrants()` has no callers.** `src/main/consent.ts:122` says it
is "called when the vault locks or the app loses focus". `grep -rn
revokeAllGrants src/` returns the definition and nothing else. A ten-minute
autofill grant therefore survives a vault lock and an app blur. Credentials
will never ride a grant (§9), but the profile path does, and the doc comment is
a claim nobody checked.

**F2 — `resolveForFill` mutates `lastUsed` and never persists it**
(`vault.ts:268`). No `persist()` call follows. The mutation is lost at lock.

**F3 — `resolveForFill` mutates `lastUsed` BEFORE the fill happens.** It is a
resolve, not a use. A refused, failed, or human-declined fill still stamps the
record.

**F4 — `browser_fill_form` has a consent TOCTOU.** The origin is computed at
`tools.ts:1025`, the human's dialog is awaited at 1026, and the write is issued
at 1053 against `t.webContents(id)` fetched fresh. Nothing between them
re-checks the committed origin. The dialog is open for as long as a human takes
to read it; the tab can navigate in that window, and the values land in a
document the human never approved.

**F5 — the preload's fill loop is four defects in twenty lines**
(`page.ts:215-256`): it does not check `isConnected` (writes into a detached
node and reports success); it does not check `disabled` or `readOnly` (the
`select` path added exactly this check on the rule "a human could not do it
either" — the fill path never got it); it `continue`s silently past any target
that is not an input or textarea, so a partial fill is indistinguishable from a
complete one; and its catch interpolates `err.message` into a `reason` that
`browser_fill_form` prints OUTSIDE the untrusted envelope — one of the four
sites `security.md` names as the weaker guarantee.

**F6 — the success line contradicts itself.** `tools.ts:1058-1062` prints
`filled ${res.filled.length} fields: ${names}` where `names` is the full
REQUESTED list. Ask for three, fill two, and the agent is told "filled 2
fields: givenName, familyName, email" and cannot tell which one is missing.

**F7 — the consent dialog interpolates an agent-authored `reason`**
(`consent.ts:91-95`) capped at 200 chars, quoted and attributed. For ordinary
profile fields that is a defensible trade. For a credential it is a social
engineering channel pointed at the human, written by the component the threat
model declares manipulable.

**F8 — grants are keyed on the full origin, the vault on the registrable
domain.** `requestFillConsent` keys `grants` on `safeOrigin(url)`
(`https://host:port`); the vault matches on eTLD+1. The two systems disagree
about what "the same site" means. Harmless today because no credential path
uses grants; it must stay that way, and §9 makes it structural.

**F9 — needle-based redaction cannot see a password, by construction.**
`taintedValues` (`engine.ts:416`) takes a fresh walk and collects the live
values of tainted keys, so `browser_read` can redact a value the page copied
into free text. But `valueOf` in the walker returns `'••••••'` for
`input[type=password]` (`walker.ts:724`), so the real password is never in the
payload the redactor reads. The mechanism that exists for profile secrets is
structurally blind to vault secrets. `security.md`'s table already marks this
row "designed, not yet implemented"; §11 implements it, and the implementation
cannot be the existing one.

**F10 — the preload's own comment about subframes is wrong at this HEAD.**
`page.ts:165` says "the walker descends into same-origin subframes, so `index`
can hold an element whose owner document is not this one". `walker.ts` contains
no `contentDocument` access and maps `IFRAME` to a leaf role; a preload without
`nodeIntegrationInSubFrames` runs in the main frame only. The index cannot
currently hold a subframe element. §5's top-frame rule makes the claim true by
enforcement rather than by hope, and the comment gets corrected.

Also noted, out of scope, do not fix here: `forget(tabId)` has no callers, so
per-tab snapshot state outlives its tab; and `attachFiles` takes the first
`input[type=file]` on the page (`engine.ts:576-583`).

---

## 3. The fill execution mechanism — the ruling

**Ruled: the credential write is an isolated-world native-prototype-setter
write plus synthetic `input` and `change`, targeted by identity key. It is NOT
CDP `Input.insertText`, and it is NOT the CDP keystroke path that
`browser_act action:"type"` uses.**

This is a deliberate divergence from `act.ts`'s "everything goes through CDP"
doctrine, and it is the same class of owned divergence tier1 §2 records for
`select`. The reasoning is different from `select`'s and must be stated on its
own terms.

### 3.1 Why not the CDP keystroke path

`typeText` (`act.ts:519`) dispatches per-character key events. Key events go to
**whatever has focus at the moment each one is delivered**, and the delivery is
`n` separate CDP round trips over ~12ms each. A 20-character password is ~40
CDP commands spanning a quarter of a second, during which the page may move
focus: an autocomplete dropdown, a validation handler, a modal, a `focus()`
call in a `keyup` listener. If focus moves at character 9, the first nine
characters of the credential are in the password field and the remaining eleven
are in whatever took focus — potentially a visible `input[type=text]` whose
value the walker serialises into the next snapshot, i.e. **straight into agent
context**.

For an ordinary typed string that race is a usability bug. For a secret it is a
disclosure, and it is a disclosure into exactly the component the whole design
exists to keep blind. **Targeting a secret must be by element identity, not by
focus.** That single sentence decides the mechanism.

The isolated-world write has no such race: `index.get(key)` resolves one
element and the setter is called on that element. There is no intermediate
state and no dependency on focus.

### 3.2 Why not `Input.insertText`

`security.md`'s verification queue item 6 asks whether `Input.insertText`
preserves fidelity for React/Vue controlled inputs. **This design does not
depend on the answer.** `insertText` also targets the focused element, so it
loses on §3.1's argument before fidelity is even reached. Queue item 6 stays
open and stays off this critical path; do not close it on the strength of this
document.

### 3.3 What the setter does and does not buy

The write uses `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
'value').set` taken from **this isolated world's** prototype, so a page that
monkeypatches its own builtins cannot intercept or redirect it. React's value
tracker is installed with `Object.defineProperty` on the main world's wrapper
for the node and is therefore not on the object this code touches (the same
world-boundary fact tier1 §2 measured for `select`), so the DOM value diverges
from React's cached value and the dispatched `input` reads as a genuine change.

What it does **not** buy, said plainly:

- No `keydown`, `keyup`, `beforeinput`, or `compositionend`. Sites that build
  state from keystrokes — input masks, phone formatters, "password strength"
  meters that only listen to `keyup`, a few login forms that gate submission on
  having seen typing — will not see what they expect.
- The events carry `isTrusted: false`. A site that checks `isTrusted` on
  `input` will ignore the write.

Both failure modes are **detectable, not silent**, which is what makes this
acceptable: §3.4 catches them and turns them into a fixed refusal rather than a
false success.

### 3.4 The deferred verification — the part that makes `ok` mean something

The preload does not reply when the write returns. It replies at **T+250ms**,
after re-reading each target and comparing against the value it wrote, and its
reply carries a per-target `landed: boolean` — never a value.

- **Not 0ms**, because a controlled component that snaps back does so on its
  next render, and a same-task read-back cannot see it.
- **Not 2000ms**, because the reply is on the critical path of a human-visible
  action, and a framework that has not re-rendered in 250ms has not re-rendered
  because of this write.
- The same-task read-back is kept **as well**, because it catches the
  synchronous class the deferred one cannot attribute: a `maxlength` truncation
  happens inside the setter, so a 20-character password written into a
  `maxlength=16` field comes back short immediately.

`landed: false` on any credential target produces `FILL_REVERTED`. The agent is
told the write did not stick, not that it succeeded.

This is the direct answer to this project's own history: six things marked
"working" broke the moment they were measured end to end. A fill path that
reports success from the fact that the IPC message was delivered is that
failure pre-committed.

### 3.5 One mechanism, not two

The profile path and the credential path use **one preload handler and one
channel**. Targets are kind-tagged; the checks that differ, differ by kind.

Two mechanisms would drift, and the drift would be silent: the credential path
would grow the origin echo and the profile path would keep the TOCTOU. This
codebase has already paid for exactly that inconsistency once — `consent.ts:8`
records it ("the vault got origin binding with no override; profile autofill
got a suggestion. That inconsistency was the single worst thing in this
codebase"). So F4, F5 and F6 are fixed for both paths by the same change.

---

## 4. The decision pipeline — the exact order, and why order is the property

`vault_request_fill action:"apply"` executes these in this order. Every step
before step 8 is decided **without raising a dialog**, so a refusal never
consumes a human interruption and the dialog never becomes an oracle or a
nag surface.

| # | Step | On failure |
|---|---|---|
| 1 | Resolve the tab (`tabId ?? active`) | `NO_TAB` |
| 2 | `vault.state() === 'unlocked'` | `VAULT_LOCKED` |
| 3 | In-flight lock for this tab is free | `FILL_IN_FLIGHT` |
| 4 | `committedOrigin = wc.getURL()`; `vault.resolveEntryFor(entryId, committedOrigin)` — id known, origin matches, transport acceptable. **This runs before any page work**, so a wrong-origin request never even reads the DOM | `NO_MATCH` · `ORIGIN_MISMATCH` · `INSECURE_TRANSPORT` |
| 5 | Decline cooldown for (origin, entryId) is expired | `CONSENT_COOLDOWN` |
| 6 | Fresh `observe()`, then `planCredentialFill(root, { hasTotp })` (§5) | `NO_FIELDS` · `AMBIGUOUS_FIELDS` · `OTP_NO_SEED` · `ALREADY_FILLED` |
| 7 | `resolveRef` each chosen target: connected, non-zero rect, not obstructed | `FIELD_GONE` · `FIELD_OBSTRUCTED` |
| 8 | **Consent** (§9). Credential scope: no grant consulted, no grant offered | `USER_DENIED` · `CONSENT_RATE_LIMITED` · `CONSENT_NO_WINDOW` |
| 9 | `vault.touch()`, but only when `via === 'human'` — a human just proved presence (§9.4) | — |
| 10 | Resolve secrets: `vault.secretsForFill(entryId, committedOrigin)`; TOTP generated here, at the last possible moment (§7) | `TOTP_ALREADY_ISSUED` · `TOTP_UNAVAILABLE` |
| 11 | `markTainted(tabId, keys)` and `registerNeedles(tabId, values)` — **before** the write, so no concurrent snapshot can read a value that is already in the DOM | — |
| 12 | `requestFill(wc, { expectedOrigin, atomic: true, targets })` (§6). The preload re-checks origin, kind, maskedness, frame, connectivity, editability and size in ONE task, then writes, then verifies at T+250ms | see §6.3 and §10 |
| 13 | On a global refusal (`ok:false`) — nothing was written, because validation is complete before the first write — `unmarkTainted` and drop the needles | — |
| 14 | On success: `vault.noteUsed(entryId)` (persisting, best-effort, never fails the fill) | — |
| 15 | If `submit` and every target landed and `focusedKey` is still the password field: CDP Enter, witnessed (§8.3) | `SUBMIT_SKIPPED_FOCUS_LOST` · `SUBMIT_UNCONFIRMED` |
| 16 | Report (§11) | — |

Step 4 before step 6 is load-bearing: **an origin mismatch is decided from the
vault and the tab's own URL, with no reference to page content at all.** The
page cannot influence the decision because the decision is taken before the
page is consulted.

Step 11 before step 12, and step 13's undo, are the pair that closes the
redaction window in both directions: taint before the value can exist in the
DOM, and remove the taint only in the one case where it provably does not.

---

## 5. Field selection — Aperture chooses, the agent never does

**Ruled: the agent supplies `entryId` and `tabId` and nothing else. It cannot
name a target field, now or ever.**

If the agent could name the target, an injected page could steer it into naming
a visible `input[type=text]` — and the walker serialises the values of text
inputs, so the password would come straight back to the agent in the next
snapshot. "The agent cannot name a wrong-origin entry" and "the agent cannot
name a wrong field" are the same property applied to the two halves of the
routing decision.

### 5.1 The pure module

New file `src/vault/fillPlan.ts`. Pure — takes a `SnapshotNode` tree and the
entry's public metadata, returns a decision. No Electron import, for the reason
`envelope.ts` gives for itself: the security boundary has to be unit-testable
without a live browser.

```ts
export type CredentialTargetKind = 'username' | 'password' | 'otp';

export interface CredentialTarget {
  ref: string;            // agent-facing, for the plan only
  key: string;            // identity key, what the write is aimed by
  label: string;          // page-authored — envelope or quote() at every use
  kind: CredentialTargetKind;
}

export type CredentialPlan =
  | { ok: true; targets: CredentialTarget[] }
  | { ok: false; code: PlanDenyCode; candidates?: string[] };

export function planCredentialFill(
  root: SnapshotNode,
  opts: { hasTotp: boolean },
): CredentialPlan;
```

### 5.2 Candidate classification

Walk the tree in document order. Skip any node with `synthetic === true` (they
have no backing element — the trap tier1 §2 names). Consider only nodes with a
`ref` and `role === 'textbox'`.

**Password candidates:** `inputType === 'password'`. Nothing else, ever. No
label heuristic promotes a field to password-candidate.

**OTP candidates**, in tier order:
1. `autocomplete` token `one-time-code` (confidence 1.0)
2. accessible name matching
   `/\b(one[\s-]?time|verification|authenticat\w*|two[\s-]?factor|2fa|mfa|otp|totp|passcode)\b/i`
   **and** `/\bcode\b/i` unless the first alternation already matched `otp`,
   `totp` or `passcode` (confidence 0.85)

and in both cases `inputType` ∈ {`text`, `tel`, `number`, undefined}, and the
node must not be a password candidate, and `isFreeTextPrompt(label)` (reused
verbatim from `profile.ts`) must be false.

**Username candidates**, in tier order:
1. `autocomplete` token `username` or `email` (1.0)
2. `inputType === 'email'` (0.9)
3. name matching `/\b(user\s?name|user\s?id|login|e-?mail|account\s*(name|id)?)\b/i` (0.8)

with the same free-text-prompt exclusion, and excluding anything already
classified password or OTP.

**Rejected: reading the HTML `name` attribute out of the identity key.** The
key does carry it (`N|frame|role|nameAttr`, `walker.ts:396`), and it would lift
recall noticeably. It is refused because the key format is an internal
contract that `disambiguate` is allowed to change, and a matcher that parses it
would break silently the next time it does. **Also rejected: adding a field to
`SnapshotNode`** to carry it — `test/completeness.test.ts` fails CI when a
field joins `SnapshotNode` without a completeness ruling, and that guard is
right; paying it for a recall improvement is not this change's business.

### 5.3 Selection rules

| Situation | Ruling |
|---|---|
| Exactly one password candidate | Selected |
| Two or more password candidates | `AMBIGUOUS_FIELDS`, candidates listed. This is a signup or change-password form (new + confirm), and filling a saved password into "new password" is wrong in a way the human will not notice until later |
| Zero password candidates, one OTP candidate, `hasTotp` | OTP-only fill — the second step of a two-step sign-in |
| Zero password candidates, one OTP candidate, `!hasTotp` | `OTP_NO_SEED` |
| Two or more OTP candidates | `AMBIGUOUS_FIELDS`. Covers the one-box-per-digit UI, which §18 rules out; the wire string names it so the agent tells the human something useful |
| Zero password and zero OTP candidates | `NO_FIELDS` |
| Password candidate whose `value` is non-empty (the walker renders `'••••••'`) | `ALREADY_FILLED`. No `overwrite` parameter is added — the agent has `browser_act action:"clear"` if the human wants it cleared, and that is a page action rather than a credential lever |
| Exactly one top-tier username candidate | Selected alongside the password |
| Two or more candidates tied at the top username tier | `AMBIGUOUS_FIELDS` |
| Zero username candidates, one password candidate | Password-only fill. Common and correct on step-2 pages where the username is already displayed |

Ambiguity **errors with the candidates and never guesses** — the same rule
`select` follows for options, for the same reason: a near-miss that is silently
resolved is a wrong value the human submits.

### 5.4 Order of writes

`username`, then `password`, then `otp`, regardless of document order. It
matches human order, and a page whose username `change` handler reveals the
password field will have run it before the password write. (If the password
field does not exist yet, that is the multi-step case: this call returns
`NO_FIELDS` or fills username-only, and the agent calls again after the page
advances. §8.)

### 5.5 Known limitation, stated not hidden

`SnapshotNode` carries no form association, so nothing checks that the chosen
username and password fields belong to the same `<form>`. A page with a login
form and, say, a newsletter email box could in principle pair them. The
username field is not a secret and the password field is chosen by
`type=password` alone, so the blast radius is a username in the wrong box.
Accepted; not fixed.

---

## 6. The write contract

### 6.1 Main → preload, channel `aperture:fill`

```ts
{
  requestId: string,
  expectedOrigin: string,       // exact serialization to compare against location.origin
  atomic: boolean,              // true for credentials, false for profile fills
  targets: Array<{
    key: string,
    kind: 'profile' | 'username' | 'password' | 'otp',
    value: string,
  }>,
}
```

`expectedOrigin` is the string `safeOrigin(wc.getURL())` produced in main at
step 4 and carried unchanged through the dialog. Main has already run the PSL
comparison against it; the preload's job is only to assert that the document it
is about to write into is still that one.

### 6.2 The preload algorithm — one task, no `await`, validate-then-write

```
if (location.origin !== req.expectedOrigin) reply({ ok:false, reason:'origin-changed' })
```

That comparison is the TOCTOU fix, and it is total rather than narrow: main and
the preload are separate tasks, but **the validation and the write are the same
task**, and a cross-document navigation cannot commit in the middle of one. The
residual window is not "as long as the human reads the dialog" — it is zero.
(`location` is read from the isolated world, where the page cannot redefine
it.)

Then, for every target, in order, **before any write** — collecting failures,
not writing on the first pass:

| Check | Reason on failure |
|---|---|
| `el = index.get(key)`; `el && el.isConnected` | `gone` |
| `el.ownerDocument === document` | `subframe` |
| `el instanceof HTMLInputElement` (credential kinds; profile also allows `HTMLTextAreaElement`) | `not-input` |
| kind `password` ⇒ `el.type === 'password'` | `not-masked` |
| kind `otp` ⇒ `el.type !== 'password'` and not `hidden` | `not-input` |
| `!el.disabled && !el.readOnly` | `not-editable` |
| `r = el.getBoundingClientRect(); r.width >= 16 && r.height >= 8` (credential kinds only) | `too-small` |
| the value setter exists on the prototype | `no-setter` |

If `atomic` and any target failed validation: reply `{ ok:false, reason, key }`
and **write nothing**. If not `atomic`: skip the failed targets, record their
reasons, and write the rest.

Write pass, per surviving target: `el.focus()`, then
`setter.call(el, value)`, then `dispatchEvent(new Event('input', {bubbles:true}))`,
then `new Event('change', {bubbles:true})`. Immediately re-read `el.value`; if
it differs from what was written, mark that target `landed:false` and record
`reverted` (this catches `maxlength` truncation and synchronous sanitisers).

Then `setTimeout(250)`, and in the callback: for each written target, re-read
and compare, producing the final `landed` boolean. Clear the closure's copies
of the values. Reply:

```ts
{ ok: true,
  results: Array<{ key, kind, wrote: boolean, landed: boolean, skipped?: Reason }>,
  focusedKey: string | null }   // document.activeElement resolved back to a key, or null
```

The expected values live in the handler's closure for ≤ 250ms and are never
sent back. The page cannot reach the isolated world's closure, and it already
holds the value in its own DOM regardless.

### 6.3 Fixed reason vocabulary on this channel

`origin-changed` · `gone` · `subframe` · `not-input` · `not-masked` ·
`not-editable` · `too-small` · `no-setter` · `reverted` · `write-failed`

**These are literals. Nothing on this channel ever interpolates `err.message`.**
The catch block replies `write-failed` and nothing else. That closes one of the
four sites `security.md` names under "Preload reason strings are NOT all
literals", and it costs nothing to hold from the start.

### 6.4 Rejected alternatives

- **`form.requestSubmit()` from the isolated world** for submission: it fires
  the `submit` event and runs validation, so it is not obviously wrong — but
  it has no `submitter`, some flows key off which button submitted, and it
  diverges from `act.ts`'s trusted-input doctrine for no gain over a CDP
  Enter that we can witness.
- **A second channel for credentials.** §3.5.
- **Sending the expected values again for verification** instead of holding
  them in the closure: doubles the plaintext transits across IPC to avoid
  holding them 250ms in a world the page cannot reach. Worse on both counts.

---

## 7. TOTP

### 7.1 When the code is generated

At **step 10**, after consent and immediately before the write. Not at plan
time, not at consent time. A code generated before a human reads a dialog can
be several seconds into its window by the time it lands.

### 7.2 The freshness floor

`vault.secretsForFill` returns `{ code, secondsRemaining }` from
`totp(secret, Date.now())`. If `secondsRemaining < 5`, **wait until the next
step boundary and generate again.** A code with two seconds left is rejected by
the server, and a rejected second factor costs an attempt against a lockout
counter — a worse outcome than a one-second delay. The wait is bounded by the
step (≤ 5s given the floor) and is reported in the result line.

### 7.3 Replay

Most verifiers burn a code on first use. If the agent calls `apply` twice
inside one 30-second window, the second write inserts the same digits, the
server rejects them, and the agent concludes the code was wrong and tries
again — a loop that ends in a lockout.

**Ruled:** main keeps `lastIssued: Map<entryId, counter>` where
`counter = floor(now / 1000 / step)`. A second credential fill for the same
entry in the same counter window is refused with `TOTP_ALREADY_ISSUED`, and the
wire text says how many seconds until the next code. The map is process-local,
cleared on vault lock, and is not persisted (a restart is not a replay risk
worth persisting plaintext-adjacent state for).

### 7.4 What the agent learns about the code

Nothing. Not the digits, not the length, not the remaining seconds beyond the
"wait N seconds" of a `TOTP_ALREADY_ISSUED` refusal — which is derived from the
clock, not from the secret.

### 7.5 The seed never moves

`totpCode()` stays human-only on `vaultui:totp`. `secretsForFill` is a new
method on `Vault` with the same non-exported, main-process-only discipline as
`resolveForFill`: not registered on any MCP tool, not on any `vaultui:` channel,
not reachable from the page preload.

---

## 8. Multi-step flows, and origin change mid-flow

### 8.1 The shape

A modern sign-in is: username page → password page → 2FA page → consent page.
Each is a separate `apply` call, each raises its own dialog, and each is
decided from the page as it stands. There is no session, no "flow" object, and
no state carried between calls except the TOTP counter map and the decline
cooldown. That is deliberate: any carried state is state an injected page can
try to make stale.

The plan step is therefore advisory only. Refs and keys from a `plan` call are
**not** honoured by `apply` — `apply` re-observes and re-plans from scratch. Say
so in the tool description, because an agent that believes otherwise will build
a wrong mental model of what it approved with the human.

### 8.2 Origin change mid-flow

Three distinct cases, three distinct answers:

1. **The origin changes between two `apply` calls** (e.g. `example.com` →
   `login.example-sso.net`). Step 4 runs against the new committed origin. If
   the entry's rpId and aliases do not cover it: `ORIGIN_MISMATCH`, terminal,
   no force flag. The only path forward is a human adding an alias in the vault
   window. This is common on real SSO flows and it is the correct answer: the
   credential was saved for one site and the human has not said the other is
   the same site.
2. **The origin changes while the consent dialog is open.** Caught by the
   preload's `expectedOrigin` echo (§6.2): `ORIGIN_CHANGED`, nothing written.
3. **A same-document navigation** (`pushState`, hash change) during a flow.
   The origin is unchanged so the write proceeds, but the DOM may have been
   replaced — caught by `isConnected` on the resolved keys. `invalidate(tabId,
   false)` already forces the next observation to be full; taint and needles
   survive, which is correct (`index.ts:74-78` records why clearing taint on a
   pushState was a hole).

### 8.3 Submit

`submit: true` is honoured only when every target landed and the preload
reports `focusedKey` equal to the password target's key (or the OTP target's,
on an OTP-only fill). Main then dispatches CDP Enter through `pressKey`, armed
with `witnessInput(wc, null, RELEVANT_COUNTERS.key)` exactly as `browser_act`
does. A `lost` verdict yields `SUBMIT_UNCONFIRMED`; anything else is reported
as submitted. A submit that navigates produces `unknown` via the docToken rule
and resolves on the first rung, so the happy path pays no measurable latency.

If focus moved, do not submit: report `SUBMIT_SKIPPED_FOCUS_LOST` and say the
fill stands, so the agent clicks the button itself. Submitting into a page
whose focus we no longer understand is how a credential ends up in a search
box's autosuggest request.

---

## 9. The human-facing consent

### 9.1 A second scope, not a second dialog system

`ConsentRequest` gains `scope: 'profile' | 'credential'`. `requestFillConsent`
branches on it:

| | profile | credential |
|---|---|---|
| Consults `grants` | yes (unchanged) | **never** |
| Offers "Allow for 10 min" | yes, when nothing sensitive | **never — the button is not rendered** |
| Shows page-authored field labels | yes (unchanged) | **no** |
| Shows the agent's `reason` string | yes (unchanged) | **no — F7** |
| Shares the rate limiter | yes | yes |

Everything the credential dialog displays is either Aperture's own literal
text, a URL that Aperture parsed, or a string the human themselves typed into
the vault window. **No page-authored byte reaches this dialog.** That is what
makes it safe to omit `quote()` there, and the omission must not be quietly
reversed later.

### 9.2 What the human sees

```
Title:   Confirm sign-in
Message: Fill your saved sign-in on this page?

Aperture's AI agent asked to fill a saved sign-in on:

    https://accounts.example.com

    Saved for:  example.com
    Account:    brad@example.com
    Will fill:  username and password

The password is never shown to the AI. This website will receive it.
Aperture chose which fields to fill; the AI could not.

Buttons: [ Cancel ]  [ Fill this once ]
```

- The origin line is `safeOrigin(url)`, i.e. `URL.origin`, which serialises IDN
  hosts to **punycode**. `https://gооgle.com` with Cyrillic о displays as
  `https://xn--ggle-55da.com`, which is the entire point of showing it.
- `Saved for:` is the record's `rpId`. When the page's registrable domain
  differs from it — an alias the human added — a fourth line appears:
  `Alias:      filling on partner-example.net, which you approved as example.com`.
- `Will fill:` is drawn from a fixed vocabulary: `username and password`,
  `password`, `two-factor code`, `username, password and two-factor code`.
- On a TOTP fill, one extra line: `This code is valid for about N seconds.`
- `defaultId: 0`, `cancelId: 0`, `type: 'warning'`, `noLink: true` — Cancel is
  both the default and the escape action, so a reflexive Enter or Escape
  denies. Unchanged from the existing dialog, and correct.

### 9.3 Decline

`USER_DENIED`, nothing written, no taint, no needles, no `lastUsed` update, and
a **60-second cooldown** recorded for `(origin, entryId)` during which another
`apply` for the same pair is refused at step 5 without raising a dialog.

The cooldown is not politeness. Without it, an injected page can drive the
agent to re-ask until the human clicks the wrong button — consent fatigue is a
real attack and the rate limiter alone (6 prompts/minute, shared across all
scopes) does not stop a patient one.

### 9.4 Grants, locks, and the idle timer

- Credentials never ride a grant (§9.1), so F8's key-space mismatch can never
  reach the vault.
- **F1 fix:** `Vault` gains an `onLock(fn)` registry; `lock()` invokes it, which
  covers the idle auto-lock as well as the explicit paths.
  `src/main/index.ts` registers `() => { revokeAllGrants(); clearAllNeedles(); }`.
  Wiring it from main avoids an import cycle between `vault.ts` and
  `engine.ts`.
- A **human** approval calls `vault.touch()` (pipeline step 9); a grant-based
  approval does not, and agent activity still does not. The rule stays exactly
  what `vault.ts:65-70` says it is — human interaction resets the idle
  countdown, an always-on agent cannot hold the vault open — and a human
  clicking a dialog is human interaction by any honest reading.

---

## 10. The failure vocabulary

Every refusal is one of these codes. Each code maps to **exactly one wire
string**, defined once in `src/mcp/tools.ts` as a `Record<DenyCode, string>` so
the mapping is total and a new code cannot be added without a string. The only
values ever interpolated are `safeOrigin()` output, integers, and — for
`AMBIGUOUS_FIELDS` alone — page-authored labels, which go inside an envelope.

| Code | Wire text (verbatim; `«…»` marks the only interpolations) |
|---|---|
| `NO_TAB` | `error: no active tab` |
| `VAULT_LOCKED` | `vault is locked — the human must unlock it in Aperture. Nothing was read and nothing was inserted.` |
| `FILL_IN_FLIGHT` | `refused: a fill is already in progress on this tab. Wait for it to finish.` |
| `NO_MATCH` | `refused: no saved sign-in with that id. Call vault_entries_for_origin to see what applies to this page.` |
| `ORIGIN_MISMATCH` | `refused: that saved sign-in does not belong to «origin». This is final — there is no override and no force flag, because a page that could talk you into overriding it could harvest any credential in the vault. If the human believes this site is the same site, they can add an alias in Aperture's vault window.` |
| `INSECURE_TRANSPORT` | `refused: «origin» is not a secure origin. Saved sign-ins are only filled over https (or localhost).` |
| `CONSENT_COOLDOWN` | `refused: the human declined this fill less than a minute ago. Do not ask again — tell them what you were trying to do and let them decide.` |
| `NO_FIELDS` | `refused: this page has no password field and no one-time-code field that Aperture can fill. If the form is on a later step, act on the page first and call again.` |
| `AMBIGUOUS_FIELDS` | `refused: Aperture will not guess between «n» candidate fields on this page, and you cannot choose one — Aperture picks the field, never you. Candidates:` + envelope + `\nIf this is a sign-up or change-password form, saved sign-ins are not filled into it. If each digit of a code has its own box, Aperture cannot fill it; the human must type it.` |
| `ALREADY_FILLED` | `refused: the password field on this page already has a value. Aperture will not overwrite it. Ask the human whether to clear it first.` |
| `OTP_NO_SEED` | `refused: this page wants a one-time code and that saved sign-in has no authenticator seed. The human must supply the code.` |
| `TOTP_ALREADY_ISSUED` | `refused: a one-time code for this sign-in was already inserted in the current 30-second window. Wait «n» seconds for the next code — re-inserting the same one will be rejected by the site and may count against a lockout.` |
| `FIELD_GONE` | `refused: the field Aperture chose is no longer on the page. Nothing was inserted. Call browser_snapshot and try again.` |
| `FIELD_OBSTRUCTED` | `refused: the password field is covered by another element — likely a modal or a cookie banner. Nothing was inserted. Dismiss it first.` |
| `FIELD_NOT_EDITABLE` | `refused: the field Aperture chose is disabled or read-only, so a human could not type into it either. Nothing was inserted.` |
| `PASSWORD_FIELD_NOT_MASKED` | `refused: the password field is showing its contents as plain text — a "show password" toggle is probably on. Aperture only inserts a password into a masked field, because a plain-text field's value appears in the page snapshot. Ask the human to hide it, then call again.` |
| `FIELD_IN_SUBFRAME` | `refused: that field is inside an embedded frame. Aperture fills saved sign-ins into the top-level page only. The human must sign in themselves here.` |
| `FIELD_TOO_SMALL` | `refused: the field Aperture chose is too small to be a real input, which is what a hidden trap field looks like. Nothing was inserted.` |
| `ORIGIN_CHANGED` | `refused: the page changed while the human was deciding, so Aperture did not write anything. The approval was for «origin» and the page is no longer on it. Nothing was inserted. Re-read the page and start again.` |
| `USER_DENIED` | `refused: the human declined. Nothing was inserted. Do not retry — tell them what you were trying to do.` |
| `CONSENT_RATE_LIMITED` | `refused: too many confirmation prompts in a short window. Aperture has paused filling; the human must re-approve in the browser.` |
| `CONSENT_NO_WINDOW` | `refused: Aperture has no window to show the confirmation in. Nothing was inserted.` |
| `FILL_REVERTED` | `warning: the values were inserted and the page did not keep them — a script on this page cleared or rewrote «n» of «m» fields. The sign-in is NOT filled. Tell the human; this site may need them to type it.` |
| `FILL_UNCONFIRMED` | `unknown: Aperture inserted the values but the page did not confirm within 5s. It may or may not be filled. Do NOT call this again — call browser_snapshot and look at the form.` |
| `WRITE_FAILED` | `error: the insertion failed inside the page. Nothing was left in a known state; call browser_snapshot and look at the form.` |
| `SUBMIT_SKIPPED_FOCUS_LOST` | `filled, but not submitted: focus moved off the field before Aperture could press Enter, so it did not press it anywhere else. Click the sign-in button yourself.` |
| `SUBMIT_UNCONFIRMED` | `filled; the Enter keypress was dispatched but never reached the page. Aperture's input path to this tab is not working. Tell the human; this needs the browser restarted.` |

Two rules about this table, both testable:

1. **`ORIGIN_MISMATCH` never names the entry's stored origin.** It names the
   page's. Naming the record's origin would tell a page — through the agent —
   which site a guessed id belongs to. Ids are 8 random bytes so enumeration is
   not the threat; an id the agent already spoke aloud in the transcript is.
2. **No refusal string is ever wrapped in an envelope**, and no page-authored
   text is ever outside one. `AMBIGUOUS_FIELDS` is the single string that
   carries page bytes, and it splits: Aperture's sentences outside, the
   candidate list inside.

---

## 11. What the agent may observe afterwards

### 11.1 Taint

Every credential target's key is added to the tab's `tainted` set at step 11.
`redactTainted` then replaces that node's `value`, `text` and `name` with the
marker on every subsequent walk. This is what covers a page that flips a
password input to `type="text"` after the fill: the walker would then serialise
the real value, and the taint replaces it regardless of type.

### 11.2 Needles — the F9 fix, and the `security.md` row that says "not yet implemented"

The existing free-text redaction reads live values back out of the page and
uses them as search strings. It cannot see a password, because the walker masks
password values before they leave the page (F9). So credential fills register
their values directly as **needles**, held in main:

```ts
registerNeedles(tabId: string, values: string[]): void   // values with length >= 6
clearNeedles(tabId: string): void
clearAllNeedles(): void
```

Needles are applied in two places: `redactTainted`'s walk (so a value copied
into a `<div>` is redacted in **snapshots**, not only in `browser_read`), and
`redactFreeText` (so it is redacted in `browser_read` too). Lifetime: cleared
on `invalidate(tabId, true)` (document replaced), on vault lock, on tab close,
and on a 10-minute timer, whichever is first.

Three honest statements about this:

- **It puts plaintext in main-process memory for up to ten minutes.** Main
  already holds it — `resolveForFill` hands the secret to the main-process fill
  path — so this extends a lifetime rather than creating an exposure class.
  The threat model's out-of-envelope adversary (local code execution as the same
  user) already wins against a same-user process, and the in-envelope adversary
  cannot reach main's heap at all.
- **It is defeated by transformation.** A page that prints the password
  reversed, base64'd, or one character per element is not caught by substring
  matching, and cannot be. Redaction is a mitigation against a careless or
  late-compromised origin, not a boundary — `security.md` already says exactly
  this about post-fill mitigations and this is one of them.
- **A 6-digit TOTP needle will over-redact.** An unrelated `123456` on the page
  becomes the marker. Over-redaction is cosmetic; under-redaction is a
  disclosure. Values shorter than 6 characters are not registered at all (the
  field itself is still tainted).

The redaction marker becomes one exported constant, `REDACTED = '(filled,
value withheld)'`, defined in `engine.ts` and **imported** by `tools.ts:429`,
which currently duplicates the literal `'(filled from profile)'` — a drift
hazard, and wrong text for a vault fill.

### 11.3 The success line

```
filled username and password for brad@example.com on https://accounts.example.com
Aperture chose the fields; the values are not shown to you and there is no tool
here that returns them. Those fields now read as (filled, value withheld) in
snapshots and page text for as long as this page is loaded.
Call browser_snapshot to see the form.
```

Variants: `filled password …`, `filled a two-factor code …`, and with
`submit:true`, a second line `Submitted the form.` The username is
vault-stored and human-authored, so printing it is safe and it is the one thing
the agent genuinely needs in order to tell the human what happened.

This text is Aperture speaking and sits **outside** any envelope.

### 11.3.1 The profile path's result line (F6)

The same change fixes `browser_fill_form`, which shares the mechanism and
therefore now knows exactly which targets landed. Its line becomes:

```
filled 5 of 7 fields: givenName, familyName, email, city, postalCode
not filled: phone (field is disabled), linkedin (field is no longer on the page)
Call browser_snapshot to confirm, and check anything marked SKIP in the plan.
```

The skip reasons come from §6.3's fixed vocabulary, rendered through the same
one-string-per-code table as §10. The current line — a count from one list and
names from another — is replaced, not patched.

### 11.4 The plan output

```
entry 4f2a91c3 · brad@example.com · saved for example.com
will fill: username, password
<untrusted-page-content id=… origin=https://accounts.example.com>
e14 "Email or username" → username
e15 "Password" → password
</untrusted-page-content id=…>
Refs here are advisory: action:"apply" re-reads the page and re-chooses the
fields itself. Ask the human whether to sign in, then call action:"apply".
```

Field labels are page-authored, so they are inside. The header and the
next-step instruction are Aperture's, so they are outside — the invariant 4
rule, applied the same way `browser_fill_form`'s plan applies it.

---

## 12. The tool surface

`vault_request_fill` keeps its name and gains exactly one parameter.

```ts
inputSchema: z.object({
  action: z.enum(['plan', 'apply']).default('plan'),
  entryId: z.string(),
  tabId: z.string().optional(),
  submit: z.boolean().default(false),
})
```

**Four keys, forever.** `test/vaultfill.test.ts` asserts the schema's key set
exactly, so a future "just one more lever" — `only`, `overwrite`, `fieldRef`,
`force`, `skipConsent` — fails CI rather than review. That guard is cheap and
this is precisely the surface where levers accumulate.

Description (agent-facing, replaces the current one; `ENVELOPE_POINTER`
appended because the plan carries page text):

```
Ask Aperture to put a saved sign-in into the page. The password is inserted by
the browser itself, is never returned to you, and there is no tool anywhere in
this server that returns one.

You name the saved sign-in. You do NOT name the field: Aperture chooses which
field on the page receives which value, and it will refuse rather than guess.
A password is only ever inserted into a masked password field in the top-level
page.

Calling action:"apply" raises a confirmation dialog that only the human can
approve. You cannot see it, cannot skip it, and no parameter bypasses it — do
not promise the human it will not appear. Approval is per fill; there is no
"remember this" for saved sign-ins.

Refused if the entry does not belong to the page's own origin. That refusal is
final: there is no override, because a page that could talk you into overriding
it could harvest any credential in the vault.

Call action:"plan" first to see what would be filled, show it to the human, then
call action:"apply". Refs in the plan are advisory — apply re-reads the page.
```

---

## 13. Dev-only affordances, and why they cannot ship live

The live guards need a vault with known contents and a way past a native dialog
no script can click. Both are dev-only, both are gated twice, and both are
tested for inertness.

**`--seed-vault`** (`src/main/index.ts`, beside the existing
`--seed-profile`): calls `vault.seedForDev()`, which builds an **in-memory**
vault — key material generated fresh, `persist()` short-circuited, nothing
written to disk — holding two records:

- `127.0.0.1`, user `guard@example.com`, password `guard-pw-93a1`, TOTP seed
  `JBSWY3DPEHPK3PXP`
- `127.0.0.2`, user `transport@example.com`, no TOTP

`seedForDev()` throws unless `!app.isPackaged` **and** `--seed-vault` is in
`process.argv`, and refuses outright if a real vault file exists, so it can
never overwrite a human's vault.

**`--e2e-consent=allow|deny`** (plus `--e2e-consent-delay-ms=N`): makes
`requestFillConsent` resolve without showing a dialog. Gated on
`!app.isPackaged` **and** the argv flag; prints a loud banner on every
auto-decision; and the resolved `via` is `'dev-auto'`, distinct from `'human'`
and `'grant'`, so a run that accidentally used it is identifiable in the
result.

Both are **main-process argv only**. Neither is an MCP parameter, an IPC
channel, an environment variable, or anything a page or agent can set. A unit
test asserts each is inert when `app.isPackaged` is true, and a guard (G28)
asserts the tool still refuses when the flag is absent, so the flag's presence
is itself observable rather than assumed.

**One thing the flag cannot verify, and therefore must not be trusted to:**
whether the dialog a human actually sees says what §9.2 says it says. That is
recorded once, by hand, as a transcription in the RED/GREEN record (battery
item 11). A dialog nobody has read is a claim nobody has measured, and this
project's list of those is long enough.

---

## 14. File and ownership partition

Single builder. Files that may change:

| File | Change |
|---|---|
| `src/vault/fillPlan.ts` | **new** — pure field selection (§5) |
| `src/vault/vault.ts` | split `resolveForFill` into `resolveEntryFor` (checks only) + `secretsForFill` (secrets, incl. TOTP, §7); add `noteUsed` (persisting, F2/F3); add `onLock` registry; add `seedForDev` |
| `src/main/consent.ts` | `scope` (§9.1); credential dialog text (§9.2); decline cooldown (§9.3); `via: 'dev-auto'`; drop the `reason` string for credential scope (F7) |
| `src/main/index.ts` | register the lock hook `revokeAllGrants` + `clearAllNeedles` (F1); `--seed-vault`; `--e2e-consent` |
| `src/core/snapshot/engine.ts` | `requestFill` new contract (§6.1); needles (§11.2); `unmarkTainted`; export `REDACTED` |
| `src/preload/page.ts` | rewrite the `aperture:fill` handler (§6.2); fixed reason vocabulary (§6.3); correct the stale subframe comment (F10) |
| `src/mcp/tools.ts` | implement `vault_request_fill` (§4, §12); deny-string table (§10); import `REDACTED` instead of duplicating it; fix the `browser_fill_form` result line (F6) and pass `expectedOrigin` (F4) |
| `src/shared/types.ts` | the deny-code union and the fill-result shape |
| `test/vaultfill.test.ts` | **new** (§15.1) |
| `test/vault.test.ts`, `test/security.test.ts` | additions (§15.1) |
| `test/consent.test.ts` | **new** (§15.1) |
| `test/fixtures/login.html`, `test/fixtures/signup.html` | **new** guard fixtures |
| `bench/guards.mjs` | G16–G28 (§15.2) |
| `docs/design/vaultfill-red-record.md` | **new** — the evidence file (§15.3) |

**Must not be touched:** `README.md`, `docs/HANDOFF.md` (another agent owns
them this session); `bench/task.mjs`, `bench/tasks.mjs`, `bench/lib/**`,
`bench/fixtures/**` (WATCH set — editing them severs stores for no reason
belonging to this change); every other `docs/design/*.md`.

Note which side of the watch line each half falls: `bench/guards.mjs` and
`test/fixtures/**` are **not** watched, so the harness half severs nothing. The
`src/**` half does, and the rebuild does, exactly as §0 says.

---

## 15. Verification

### 15.1 Unit tests — every decision that can be made from data

`test/vaultfill.test.ts`, against the pure `fillPlan.ts`:

1. one `type=password` field → selected
2. two password fields → `AMBIGUOUS_FIELDS`, both labels in `candidates`
3. no password, one `autocomplete="one-time-code"`, `hasTotp` → OTP target
4. same, `!hasTotp` → `OTP_NO_SEED`
5. two OTP candidates → `AMBIGUOUS_FIELDS`
6. password field whose value is `'••••••'` → `ALREADY_FILLED`
7. `autocomplete="username"` beats a label-matched candidate
8. two `autocomplete="username"` fields → `AMBIGUOUS_FIELDS`
9. a textbox labelled `"Why do you want this role?"` is never a username
   candidate (`isFreeTextPrompt` reuse)
10. `synthetic: true` nodes are never selected
11. no password, no OTP → `NO_FIELDS`
12. write order is username, password, otp regardless of document order
13. the schema key set is exactly `{action, entryId, tabId, submit}`
14. the deny-string table is total: every member of the code union has exactly
    one string, and no string is empty
15. `ORIGIN_MISMATCH`'s string contains no record-derived origin (given a
    record for `chase.com` and a page on `evil.com`, the output contains
    `evil.com` and not `chase.com`)

`test/vault.test.ts` additions: `resolveEntryFor` does not mutate `lastUsed`
(F3); `noteUsed` persists across lock/unlock (F2); `secretsForFill` refuses a
second call in the same TOTP counter window; `secretsForFill` waits past a
boundary when `secondsRemaining < 5`; `onLock` fires from the idle timer as well
as from `lock()`.

`test/consent.test.ts` (new, `dialog` mocked): credential scope never reads
`grants`; credential scope's button array has length 2; a decline records a
cooldown and the next call inside 60s does not call `showMessageBox` at all;
the rate limiter counts both scopes; `revokeAllGrants` clears; the credential
detail string contains no caller-supplied `reason`.

`test/security.test.ts` addition: a `dev-auto` consent is refused when
`app.isPackaged` is true.

### 15.2 Live guards — `bench/guards.mjs`, G16–G28

Run against a real Aperture launched with `--seed-vault --e2e-consent=allow`,
with `test/fixtures` served on **both** `127.0.0.1:8899` and `127.0.0.2:8899`
(two listeners, not `0.0.0.0` — do not expose fixtures to the LAN). Every
assertion is against **the fixture's own witness**, never against Aperture's
own report of itself; that rule is the entire reason `guards.mjs` exists.

The fixture (`login.html`) reports booleans only — never values — through a
`#log` element: `pw-match:true`, `visible-decoy-set:false`,
`otp-valid:true`, `submits:1`. It embeds the same TOTP seed and computes the
expected code in its own JavaScript, so `otp-valid` is an independent witness
rather than Aperture agreeing with itself. It must never print a secret,
because §11.2's needles would redact it and the guard would be reading its own
mitigation.

| Guard | Claim |
|---|---|
| G16a | on a page with no saved sign-in, the tool says so and **no dialog is raised** |
| G16b | on `http://127.0.0.2:8899` — a loopback address `isLocalhost()` does not exempt — an entry saved for `127.0.0.2` is refused `INSECURE_TRANSPORT` before any page work, and the witness shows nothing written. This is why the second listener and the second seeded record exist |
| G17a | an entry listed on `127.0.0.1` is refused on `localhost:8899` with `ORIGIN_MISMATCH`, the page witness shows nothing written, and the message names neither the stored origin nor an override |
| G17b | `vault_entries_for_origin` on `localhost` lists nothing — the entry is unnameable there, which is why G17a's id had to be learned elsewhere |
| G18a | after apply, `pw-match:true` **and** `visible-decoy-set:false`: the password reached the masked field and only it |
| G18b | on the fixture's snap-back field (an `input` listener that clears it), the result is `FILL_REVERTED`, not a success line |
| G19 | after apply, `browser_snapshot` and `browser_read` contain neither the password nor the code, including after the fixture's "echo to a div" button copies the value into visible text |
| G20 | with `--e2e-consent-delay-ms=1500` and the fixture navigating at 800ms, the result is `ORIGIN_CHANGED` and the witness shows nothing written on either document |
| G21 | with the password field removed by a click between plan and apply, the result is `FIELD_GONE` and nothing is written |
| G22 | with "show password" toggled on, the result is `PASSWORD_FIELD_NOT_MASKED` and nothing is written |
| G23 | on `signup.html` (password + confirm), the result is `AMBIGUOUS_FIELDS`, no dialog, nothing written |
| G24 | with an `aria-modal` overlay over the form, the result is `FIELD_OBSTRUCTED` and nothing is written |
| G25 | with the password field `readonly`, the result is `FIELD_NOT_EDITABLE` and nothing is written |
| G26a | on the 2FA step, `otp-valid:true` — the digits Aperture inserted match the code the fixture computed independently |
| G26b | a second apply inside the same window is refused `TOTP_ALREADY_ISSUED` and the field is unchanged |
| G27a | `submit:true` produces exactly one submission (`submits:1`), with the values present in the submitted form |
| G27b | with `--e2e-consent=deny`, the result is `USER_DENIED`, the witness shows nothing written, and an immediate retry is refused `CONSENT_COOLDOWN` **without** a second consent call |
| G28 | with no `--e2e-consent` flag at all, an apply does not complete on its own — the flag's presence is observable, so a green run cannot be a run that quietly auto-approved |

### 15.3 RED-first, adapted honestly

The project standard (`g15-red-record.md`, `g14-red-record.md`,
`blindfields-red-record.md`) is that a guard must have failed against the defect
before it is trusted. **For a feature that does not exist yet, the ordinary RED
proves nothing**: every guard fails against a stub, and a guard that fails
because the tool returns "not yet wired" has demonstrated no discrimination
whatsoever. Saying so is the point; quietly recording a trivial RED and calling
it evidence would be the false green in its purest form.

So the evidence comes in two parts, both required, both recorded in
`docs/design/vaultfill-red-record.md`:

**Part 1 — the stub RED (ordering, not discrimination).** Author G16–G28 and
`test/fixtures/login.html` FIRST, run them against the unmodified `1381e10`
build, and record the verbatim output. Every one of them fails. This proves the
apparatus runs, the fixture serves, the seeded vault is reachable, and the
guards are not accidentally green — nothing more, and the record must say
nothing more.

**Part 2 — the sabotage battery (this is the discrimination proof).** After
the build is green, apply each sabotage below to the shipped source **one at a
time**, rebuild, run the guards, confirm the named guard goes RED and the
others stay green, then revert. Record each result.

| # | Sabotage (one line) | Must turn RED |
|---|---|---|
| S1 | delete the `location.origin !== expectedOrigin` check in the preload | G20 |
| S2 | delete the `el.type === 'password'` check | G22, G18a |
| S3 | delete the `isConnected` check | G21 |
| S4 | skip `registerNeedles` | G19 |
| S5 | reply immediately with `landed: true` instead of verifying at T+250ms | G18b |
| S6 | on multiple password candidates, take the first instead of refusing | G23 |
| S7 | drop the TOTP counter-window record | G26b |
| S8 | accept an `ORIGIN_MISMATCH` when a (newly added) `force` flag is passed | G17a |
| S9 | let credential scope consult `grants` | G27b |
| S10 | delete the `disabled`/`readOnly` check | G25 |

A sabotage that does **not** turn its guard red is a defective guard, and it is
fixed before the change lands. This table is what replaces the missing
historical RED, and it is strictly stronger: it demonstrates discrimination
against ten specific regressions rather than against one historical defect.

### 15.4 Acceptance battery

Run in order, after the builder lands and before the rebuild is trusted.

| # | Check | Expectation |
|---|---|---|
| 1 | §15.3 part 1 recorded | `vaultfill-red-record.md` exists with verbatim stub-RED output and the build provenance table (HEAD, `out/` hashes, Electron version), in `g15-red-record.md`'s format |
| 2 | `npx tsc --noEmit` | clean |
| 3 | `npx vitest run` | green, including every pre-existing test untouched |
| 4 | `npx electron-vite build` | clean; ONE rebuild |
| 5 | fidelity, all six scenarios | GREEN — this change must not move the snapshot stream |
| 6 | live guards G1–G15 | still all PASS. The engine and preload were edited; the old guards are the regression net |
| 7 | live guards G16–G28 | all PASS |
| 8 | §15.3 part 2 | all ten sabotages recorded, each turning its named guard RED and no other |
| 9 | `npm run bench:task -- --selftest` | G1+G2 both arms, all five wave-3 tasks PASS. `codeVersion` and `buildVersion` have moved; that is expected and is severance working |
| 10 | severance behaves | the runner refuses to extend the pre-existing store rather than pooling across the version change |
| 11 | the dialog was read by a human | one manual run with **no** `--e2e-consent`, with the dialog's text transcribed verbatim into the record and checked against §9.2 line by line, including the punycode origin on an IDN fixture |
| 12 | packaged inertness | a unit test asserts `--seed-vault` and `--e2e-consent` do nothing when `app.isPackaged` |
| 13 | tree + tag | clean; tagged `vaultfill-landed` |

---

## 16. What could NOT be verified, and the probe for each

This spec was written from the source at `1381e10`. **No Electron process was
launched and nothing below was measured.** Each item names the probe that would
settle it; each probe is a throwaway, deleted after (this repo's convention).

**U1 — does the isolated-world setter + synthetic `input`/`change` actually
take on real login forms?** The mechanism is the same one `aperture:fill`
already ships, and tier1 §2 measured the world-boundary argument for `<select>`
— but never for `<input>`, and never against a site that checks
`event.isTrusted`. *Probe:* a fixture with four password fields — plain, React
controlled, a `maxlength=8` field, and one whose `input` listener reverts unless
`e.isTrusted` — fill each and report `landed` per field. Run before the guards
are written; if the `isTrusted` field fails, that is a real-world class this
design reports as `FILL_REVERTED` rather than silently mis-filling, which is
the correct outcome but should be known before it is discovered by a human
losing a job application.

**U2 — `Input.insertText` fidelity** (`security.md` queue item 6). Unverified
and deliberately off this path (§3.2). Do not close it on this document.

**U3 — is `dialog.showMessageBox(BaseWindow, …)` genuinely modal on Windows,
and can it be dismissed programmatically?** The typings accept a `BaseWindow`
(`node_modules/electron/electron.d.ts:7728`, checked), and `index.ts:39`
creates a `BaseWindow`, not a `BrowserWindow` — so the existing
`parent as BrowserWindow` cast is unnecessary but harmless. Runtime modality is
unverified. *Probe:* open the dialog, attempt `browser_act` calls against the
tab underneath, and attempt to dismiss it from page JS.

**U4 — is the native dialog invisible to `browser_capture`?** Near-certain,
since `webContents.capturePage()` captures a page surface and cannot see
another OS window, but not measured. *Probe:* raise the dialog, call
`browser_capture` on an agent-owned tab, inspect the PNG. (Related but
separate: `security.md` queue item 5, `setContentProtection` vs BitBlt, is about
the vault window and stays open.)

**U5 — does the page preload run in subframes in this configuration?**
`nodeIntegrationInSubFrames` is not set, and `webContents.send` targets the main
frame, so subframe elements should never enter the index (F10). §5's top-frame
rule makes this moot by enforcement, but the assumption is untested. *Probe:* a
fixture with a same-origin iframe containing a password field; check whether the
walk sees it and whether `aperture:fill` can reach it.

**U6 — can `wc.getURL()` return an uncommitted URL mid-navigation?** The design
does not depend on the answer, because the preload compares
`location.origin` in the writing document. Left unverified on purpose.

**U7 — TOTP against a real verifier.** `totp()` is unit-tested against RFC
vectors; nothing has been checked against a live service. The guard's fixture
computes the expected code independently, which is the strongest check
available offline.

**U8 — none of the guards in §15.2 have been run.** They are specified, not
executed. §15.3's ordering exists precisely so their first run is a recorded
one.

---

## 17. Residuals accepted, stated rather than papered over

1. **A password delivered to a renderer is a password that origin now has.**
   Taint, needles and atomic fill+submit are hardening against a late-injected
   skimmer on an otherwise-honest origin. They are not boundaries.
   `security.md` says this; repeating it here is deliberate, because this
   document is the one that adds the mitigations and would otherwise read as if
   they were guarantees.
2. **Needle redaction is defeated by transformation** (§11.2).
3. **Over-redaction of 6-digit needles** (§11.2).
4. **No form association** in field selection (§5.5).
5. **Sign-in forms inside iframes are unsupported** (§8, `FIELD_IN_SUBFRAME`).
   Some large SSO providers use them. The human signs in there.
6. **One-box-per-digit OTP UIs are unsupported** (§5.3, §18).
7. **Main holds plaintext for the needle window** (§11.2).
8. **The 250ms verification window is a heuristic.** A framework that reverts at
   400ms reports `landed: true` and the agent is told the fill succeeded when
   it did not. Raising the window costs latency on every fill; the number is a
   judgement, not a measurement, and it is the first thing to revisit if a real
   site misbehaves.
9. **`isTrusted: false`** on the dispatched events (§3.3).

---

## 18. What this deliberately does NOT include

- **Saving or updating a credential from a page.** Nothing here writes to the
  vault. "Aperture noticed you signed in, shall I save this?" is a whole
  design — it needs a capture path from a form submission, a heuristic for
  which submission was a sign-in, and a UI for confirming it — and every one of
  those is a new way for a page to get something into the vault. Human-only
  `vaultui:add` remains the only writer.
- **Sign-up and change-password forms.** Two password fields is a refusal
  (§5.3), not a feature. Generating a password, filling both boxes, and saving
  the result is the natural next feature and it is the one above.
- **One-box-per-digit OTP entry.** It needs per-character distribution, focus
  choreography, and a detector for the shape. Refused with a message that names
  it.
- **Iframe sign-in.** §17.5.
- **Passkeys / WebAuthn.** `security.md` is explicit that passkeys are the
  actual fix and every stored password is technical debt; queue item 2 (can
  Electron host a platform authenticator?) is unanswered, and answering it is
  its own project.
- **A `browser_act`-style `type` fallback for credentials.** Any
  agent-selectable fallback re-introduces the choice §3.1 removed. If the
  setter path does not take on a site, the answer is `FILL_REVERTED` and a
  human.
- **Cross-tab or headless fills.** The fill targets the tab the human can see.
- **An AST/CI check that no agent-facing response type carries a secret.**
  `security.md` asks for one ("enforced by a CI check over the response
  union's AST, not by review discipline"). It is still not built, this change
  does not build it, and the deny-string table test (§15.1 item 14) is not a
  substitute for it.
- **Fixing `forget(tabId)` never being called, or `attachFiles` taking the
  first file input.** Both are real; neither is this path.
- **Any change to the snapshot stream.** Battery item 5 exists to prove it.
