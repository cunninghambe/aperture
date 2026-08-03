# Independent security review — the vault fill path at `c375415`

Reviewer: a second agent that did not write `docs/design/vaultfill.md` and did
not build the change. Date 2026-08-03. Scope: `c375415` ("vault: the fill path,
plus ten defects found around the stub") against `docs/design/vaultfill.md`
(the spec), `docs/design/vaultfill-red-record.md` (the builder's evidence) and
`docs/design/security.md` (binding doctrine).

**Verdict: BLOCK.** Two defects, both cheap to fix, both inside a property this
change claims to have closed. Everything else the builder reported reproduced,
including the parts that were easy to fake and hard to check. The fix list is
§9; the daily-driver question is §10.

---

## 0. What was actually run, so this review is checkable the way it asks the
## builder's to be

Nothing below is inferred from reading alone unless it says so.

| # | Run | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | clean |
| 2 | `npx vitest run` | 20 files, **500 passed** |
| 3 | `npx electron-vite build` from the shipped tree | clean; **byte-identical** to the `out/` already on disk (so the shipped source and the shipped artifact agree) |
| 4 | live guards, `--e2e-consent=allow` | **37/37 GREEN** |
| 5 | live guards, `--e2e-consent=deny` | **3/3 GREEN** |
| 6 | live guards, no flag (`--phase=none`) | **2/2 GREEN** (G28: a real dialog stands, the call never completes) |
| 7 | five sabotages re-applied to the **shipped** source, rebuilt, re-run | each turned its named guard(s) and nothing else — §6 |
| 8 | four new adversarial fixtures + one driver, written for this review | §3, §4, §7 |

Artifacts under test:

```
out/main/index.js    25ad709a5835121c59f43fe373f6caba35b10c01e9fd963f1a0314f8e1328e37  228462
out/preload/page.cjs 510b3597fb4c5862d8492b0b9b69b266869adc57403188a62d96fd13a2b69891   30364
```

Review probes (throwaway, scratchpad only, never the repo — the `WATCH_DIRS`
rule): `vfprobe/rev-sinks.html`, `vfprobe/rev-race.html`, `vfprobe/rev-frame*.html`,
`revprobe.mjs`, `revstall.mjs`, `revbattery.sh` + `rev-sabotages.json`.
Raw output: `rev-guards-allow.txt`, `rev-sabotage-log.txt`, `revsab-R-S*.txt`.
The working tree and `out/` were returned to their shipped state and verified
(`git status` clean, both hashes above re-confirmed).

---

## 1. The load-bearing property — does the agent-facing process hold plaintext?

**Checked.** Every new response type in `src/shared/types.ts`, every new IPC
payload, every string `vault_request_fill` and `browser_fill_form` can emit, and
the process topology (`startMcpServer` is called from `main`, in-process — there
is no utility process).

**Found.** No agent-facing response type or message can carry a secret:

- `FillChannelResult` / `FillTargetResult` carry `key`, `kind`, and the booleans
  `wrote` / `landed`, plus a `skipped` drawn from the closed `FillSkipReason`
  union. `landed` is a boolean *about* a value and never a value. Verified by
  reading the preload's reply construction, not only the type: the only
  string-valued fields on the wire are `key` (an identity key) and literals.
- The expected values live in the preload handler's closure for 250ms and are
  nulled in a `finally`. They are never echoed back.
- `secretsForFill`'s return never leaves `applyFill`. The success line prints
  `entry.username` (vault-stored, human-authored), `pageOrigin` (parsed by
  Aperture), and — on a TOTP fill — `waitedMs` rounded to seconds. The code
  itself, its length, and its remaining validity are absent. `TOTP_ALREADY_ISSUED`
  interpolates `secondsUntilNext`, which is `step - (now mod step)`: clock
  arithmetic, not secret-derived.
- The deny-string table is `Record<FillDenyCode, string>`, total by typecheck,
  and the only interpolations are `safeOrigin()` output, integers, and
  `AMBIGUOUS_FIELDS`' page-authored candidate labels, which are enveloped.
- Page-authored text reaching the agent through the plan and through
  `AMBIGUOUS_FIELDS` comes from `st.last.root` — the tree `observe()` has
  **already** passed through `redactTainted` — so a page that puts a filled
  value into a field label cannot round-trip it through the plan.

**But the doctrine sentence is now false as written, and was already loose.**
`security.md` opens with "The process that talks to the agent never receives
plaintext on any channel, in any message type." The process that talks to the
agent is `main`, and `main` receives the password from `secretsForFill` and now
**retains it for up to ten minutes** as a needle. The spec is honest about this
(§11.2, first bullet) and the engine's comment repeats it; the doctrine file was
not allowed to be edited by the builder (spec §14). The operative property — the
one I verified and the one the design actually rests on — is the *next* sentence
in `security.md`: **no agent-facing response type has a field that can carry a
secret.** That holds. The headline sentence should be restated to match, because
a reader who trusts it literally will draw a wrong conclusion about the needle
store. Follow-up, not blocking.

**Verdict: PASS**, with a required doctrine-wording correction (§9, item 6).

---

## 2. F4 — the consent TOCTOU

**Checked.** `src/preload/page.ts` `aperture:fill`, and both call sites in
`src/mcp/tools.ts`. I constructed the interleaving rather than trusting the
comment.

The preload's first statement is `location.origin !== req.expectedOrigin`. From
there to the last `setter.call` there is **no `await`, no `then`, no `yield`,
and no promise** — the handler is a plain synchronous function body, and the
only asynchrony is the `setTimeout` *after* the writes. So:

- A cross-document navigation cannot commit inside one task. If the tab
  navigates while the dialog is open, the message is delivered to whichever
  document exists when the task runs: the old one (origin matches, write is
  the one that was approved) or the new one (origin differs → `origin-changed`,
  nothing written). There is no third state. **The residual window is genuinely
  zero**, as claimed.
- If the new document happens to be *same-origin*, the origin check passes — but
  the new preload instance starts with an empty identity index, so every target
  resolves `gone` and the atomic path writes nothing. Measured indirectly: this
  is the same mechanism G21 exercises.
- `location` is read in the isolated world; the page cannot redefine it.
  Sabotage R-S1 (deleting the comparison) turned **G20 and only G20** red on the
  shipped source, so the check is load-bearing rather than decorative.
- Both fill paths now carry `expectedOrigin`, so the profile path's original
  TOCTOU is closed by the same code. The credential path takes it from
  `wc.getURL()`; the profile path from `t.info(id)?.url`. If that cached URL is
  ever stale in either direction the comparison fails **closed** (`safeOrigin('')`
  is the literal `'unknown'`, which matches no origin).

**Verdict: PASS.** The claim in the commit message is accurate.

**However** — the same-task argument is true and the *conclusion drawn from it*
is too strong. See §4: validation and the write are in one task, but they are
not in one *turn*, and the page gets to run code between them.

---

## 3. F9 — needle redaction. **BLOCKING DEFECT FOUND.**

**Checked by probe, not by reading.** `vfprobe/rev-sinks.html` fills the seeded
credential, then copies the password into every sink the walker serialises:
a `<div>`'s text, an `input[type=text]`'s value, an `aria-label`, a `title`, a
table cell, a `<select>` option label, an `<img alt>`, and an anchor's `href`.
Then `browser_snapshot mode:full`, `browser_read`, and a ref-scoped
`browser_read` of the select.

Result — everything is redacted **except the link target**:

```
textbox e6 "Nickname" ="(filled, value withheld)"
link e7 "Continue to checkout" /leak?pw=guard-pw-93a1        <-- plaintext
button e8 "menu (filled, value withheld)"
table e9 2x2
  "note" | "(filled, value withheld)"
combobox e10 "alpha (filled, value withheld) beta" ...
img e13 "picture (filled, value withheld)"
```

`browser_read` was clean; the scoped read of the select was clean.

**Mechanism.** `redactTainted` scrubs `n.value`, `n.text`, `n.name` and
`n.rows`. `SnapshotNode.href` is a fifth serialised, page-controlled field —
`render.ts:233` emits it on the full snapshot and `render.ts:390` emits it in a
diff as `href=…` — and no scrub is applied to it. `hrefOf` keeps a query string
up to 40 characters and the whole string up to 60, which comfortably fits any
password a human would use.

**Why this is blocking rather than a residual.**

1. It is the exact row this change exists to close. `security.md`'s injection
   table says "Copy value into a `<div>` and have the agent read it → Redaction
   while the fill is tainted (**designed, not yet implemented**)", and the commit
   message says needles "apply to both paths". They apply to both *paths*; they
   do not apply to all the *fields* one of those paths renders.
2. The success line tells the agent, in Aperture's own voice, that the values
   "now read as (filled, value withheld) in snapshots and page text". With an
   href sink that statement is false.
3. This project has already had one security finding on precisely this field
   (`security.md`, "a link's href could change under a stable label"). `href` is
   the field this codebase forgets.
4. The threat it re-opens is the one the mitigation is aimed at and no other:
   `security.md` concedes that a hostile origin can exfiltrate with its own
   `fetch()`, so needles only ever mattered against a *late-injected skimmer on
   an otherwise-honest origin* — a script that can write the DOM and steer the
   agent but cannot phone home. An `href` is the cheapest thing such a script
   can write.
5. The fix is one line, in the function whose comment already explains why all
   three of the other fields are scrubbed.

**Where redaction still does not reach, after that fix** (residuals, correctly
outside this change's claims but worth writing down once):

- **Transformation** defeats substring matching — stated in §11.2 and true.
- **Truncation**: `valueOf` truncates long input values, so a page can place the
  password across a truncation boundary and leak a fragment per field. Same
  class as "one character per element"; covered by the stated residual.
- **Free-text prose channels that are not the two redaction paths**:
  `browser_act`'s obstruction error interpolates a page-authored `tagName#id`,
  and the `select` error paths print page-authored option labels and
  suggestions. All are `quote()`d but none are needle-scrubbed. A page could set
  `id="<password>"` on an overlay. These are pre-existing surfaces, not created
  here, and the fix (route them through the same scrub) is a follow-up.
- **`browser_capture`** files a PNG to Notion or disk without any redaction —
  but it never returns the image to the agent and refuses non-agent-owned tabs,
  so it is not an agent-context leak. Worth a line in the residuals list.

**Verdict: BLOCK.** Fix 1 in §9.

---

## 4. The write pass — validate-then-write is not atomic against the page.
## **BLOCKING DEFECT FOUND.**

Spec §6.2 validates every target *before any write*, then writes in a second
pass. The write pass calls `input.focus()`, then the setter, then dispatches
`input` and `change`. **All three of those synchronously run page JavaScript**,
inside the same task, *after* validation and *before or between* the remaining
writes. Write order is username → password → otp, so the username's handlers
always run before the password is written.

Measured with `vfprobe/rev-race.html`, whose username field has
`focus`/`input`/`change` handlers that mutate the password field:

| the page does, mid-write | Aperture answers | the page's own witness |
|---|---|---|
| `p.type = 'text'` | `filled username and password …` | `pw-match:true pw-type:text pw-len:13` |
| `p.disabled = true` | `filled username and password …` | `pw-match:true` |
| `p.readOnly = true` | `filled username and password …` | `pw-match:true` |
| `p.remove()` | `FILL_REVERTED` — correct | `pw-type:gone pw-match:false` |

So a page can have the saved password written into an **unmasked** field, or
into a field a human could not type in, and Aperture reports plain success. The
`remove` row is the one the design catches, and it catches it well: the deferred
T+250ms check tests `el.isConnected`, which is exactly the right check and is
why that row fails loud.

**What is and is not compromised.** Taint and needles held in every row — the
snapshot and `browser_read` were clean, because the identity key does not
include the input type (`N|frame|role|nameAttr`), so the taint survives a
`type` flip. So this is **not** a disclosure to the agent today; it is the
failure of an invariant that three separate pieces of shipped text assert:

- the tool description: "A password is only ever inserted into a masked password
  field in the top-level page";
- `PASSWORD_FIELD_NOT_MASKED`'s own prose, whose stated reason is "a plain-text
  field's value appears in the page snapshot";
- the preload's comment on that check.

It also means **G22 measures a window an attacker need not use.** G22 unmasks
during the consent dialog and is refused; unmasking 200ms later, inside the
write pass, succeeds. And it puts the human's password in cleartext on their own
screen — the thing the masked-field rule is for, at the human end.

Given the doctrine that a false success is this project's cardinal failure
("a fill path that reports success from the fact that the IPC message was
delivered is that failure pre-committed"), and that the fix is a few lines in
the function that already has every predicate written, this is blocking.

**Verdict: BLOCK.** Fix 2 in §9.

Related, non-blocking: `atomic: true` means "no writes if validation fails", not
"rollback". After a `FILL_REVERTED` the **username is still in the form**
(measured: `user-match:true` in the isTrusted row of §5). That is fine — a
username is not a secret and the wire string says the sign-in is NOT filled —
but the record and the spec both describe atomicity in terms that a reader could
mistake for a rollback.

---

## 5. The setter mechanism — U1, re-measured independently

Re-ran the builder's `u1probe.html` variants myself, on the shipped build, and
read the page's own witness rather than Aperture's report:

| variant | Aperture says | page's witness |
|---|---|---|
| plain | `filled username and password …` | `pw-match:true pw-len:13` |
| React value tracker | `filled username and password …` | `pw-match:true pw-len:13` |
| `input` listener reverting unless `e.isTrusted` | `FILL_REVERTED` ("the page did not keep them … the sign-in is NOT filled") | `pw-match:false pw-len:0` |

The React fixture installs the tracker the way React installs it —
`Object.defineProperty` on the *node*, in the main world — and dedupes on
`input`. The isolated-world prototype setter is not that object, the tracker
goes stale, the dispatched `input` reads as a genuine change, and the value
survives the fixture's re-render. **The builder's U1 conclusion holds on both
variants the review named.**

The `isTrusted` row is the one that mattered most: it fails **loud**, with the
sign-in explicitly not filled, and the page holds an empty password field. It is
not a silent partial fill. I also confirmed the two mechanisms that make that
verdict trustworthy discriminate: R-S5 (`VERIFY_DELAY_MS = 0`) turns G18b red,
and the same-task read-back catches the synchronous-sanitiser class the deferred
check cannot attribute.

The record's own correction — that `maxlength` does **not** constrain a
programmatic assignment, so §3.4's stated justification for the same-task
read-back was wrong — is correct, is in the shipped comment, and is the kind of
thing that usually gets quietly dropped. Credit where due.

**Verdict: PASS.** No `FILL_REVERTED` I could produce was a disguised partial
fill; the one partial-write case (`remove`) reports `FILL_REVERTED` and names
"1 of 2 fields".

---

## 6. The sabotage matrix — five rows re-applied to the shipped source

Not spot-checked from the log: re-applied, rebuilt, relaunched, re-run, reverted.

| # | sabotage (as I applied it, to shipped source) | must turn RED | observed |
|---|---|---|---|
| R-S10 | `if (isDisabled(input) \|\| input.readOnly) {` → `if (false as boolean) {` | G25 | **35/37 — G25 and G25b**, and only those |
| R-S1 | `if (location.origin !== req.expectedOrigin) {` → `if (false as boolean) {` | G20 | **36/37 — G20**, and only G20 |
| R-S4 | `registerNeedles(id, needleValues);` → `void needleValues;` | G19 | **36/37 — G19**, and only G19 |
| R-S2 | `input.type !== 'password'` check → `if (false as boolean) {` | G22 | **36/37 — G22**, and only G22 |
| R-S5 | `VERIFY_DELAY_MS = 250` → `0` | G18b | **36/37 — G18b**, and only G18b |

All five discriminate. G1–G15 stayed green in every run.

**Three things the record states more strongly than the evidence supports.**

1. **The battery was not run against the shipped source.** The record says each
   sabotage was "applied to the **shipped** source". The builder's own
   `sabotages.json` targets `if (input.disabled || input.readOnly) {` — a line
   that does not exist in the shipped file — and every run in
   `sabotage-log.txt` reports "35/36 guards hold", i.e. a build with 36 guards,
   before G25b existed. So S1, S2, S3, S5 and S10 were all measured on the
   pre-S11 preload. My re-runs above repair that for four of them; **S3
   (`isConnected`) remains proven only against the pre-S11 build.** The delta is
   one line and the conclusions plainly carry, but the record's sentence should
   not have been written that way.
2. **The provenance table's POST preload hash is not the shipped artifact.**
   §0 records `de617d95…` / 30361 bytes. The shipped `out/preload/page.cjs` is
   `510b3597…` / 30364 bytes, and a clean rebuild from the shipped source
   reproduces `510b3597…` byte-for-byte. Three bytes is exactly
   `input.disabled` → `isDisabled(input)`, so the recorded hash is the pre-S11
   build. The `out/main/index.js` row matches. The final 37/37 run must have
   been on the shipped preload (G25b cannot pass otherwise), so this is a stale
   table rather than a false result — but a provenance table whose whole job is
   to name the artifact under test named the wrong one.
3. **"turning exactly one guard red"** (commit message) does not survive
   re-measurement: on the shipped source, R-S10 turns two red — correctly, since
   the shipped check covers both cases. Understating the guard set is harmless;
   the sentence is still wrong.

**S9, S2-vs-G18a and S8 — the three the record says it could not discriminate
as written.** I agree with all three analyses, and none leaves a real regression
uncovered:

- **S2 cannot turn G18a red**, because G18a's page is masked throughout. Correct,
  and G22 covers the check.
- **S8 as literally worded** (add a `force` flag) cannot turn a live guard red,
  because the guard does not pass the flag. Applying it as its *effect* (the
  origin comparison stops refusing) is the honest translation and it turns G17a
  red. The lever half is caught by `test/vaultfill.test.ts` item 13, which pins
  the schema's key set — I confirmed that test exists and is exact.
- **S9 is not live-discriminable in this apparatus**, because `--e2e-consent`
  decides before any grant is consulted or created, so no grant can exist during
  a guard run. The substitute is `test/consent.test.ts` → "a live profile grant
  for the same origin does not cover a credential", which builds exactly that
  state with the dialog mocked and asserts `showMessageBox` was called once for
  the credential. I read it and it cannot pass if the credential branch consults
  grants; I did **not** re-execute the sabotage (it would mean editing
  `consent.ts`, and I judged the risk to that file — see §9 item 3 — not worth
  it for a conclusion available by inspection).

**Verdict: PASS on discrimination, FAIL on the record's provenance claims.**

---

## 7. Consent — can the agent reach the dialog?

**Checked.** `src/main/consent.ts` in full, the call site in `applyFill`, and
`test/consent.test.ts`.

- **No `reason` field exists on `CredentialConsentRequest`.** Confirmed at the
  type level: `ConsentRequest` is a discriminated union and the credential arm
  has no such member, so an agent string could not be passed even by accident —
  it would not typecheck. F7 is genuinely closed, structurally.
- **The credential branch never touches `grants`.** There is no `grants.get` in
  it; the whole grant mechanism sits inside `if (req.scope === 'profile')`.
  Buttons are exactly `['Cancel', 'Fill this once']`, `defaultId: 0`,
  `cancelId: 0`, so Enter and Escape both deny. F8's key-space mismatch cannot
  reach the vault.
- **Every displayed byte is Aperture's, the vault's, or a parsed URL.** `origin`
  is `safeOrigin()` = `new URL(url).origin`; `savedFor`/`username` are
  human-typed vault fields; `willFill` comes from `describeTargets`, whose four
  return values are literals; `totpSeconds` is an integer. `entryId` is
  agent-supplied but is used only as a cooldown map key and is never rendered.
- **Timing**: the agent chooses *when* to call, which is inherent. It cannot
  shorten, extend, or dismiss the dialog. `--e2e-consent-delay-ms` is
  main-process argv.
- **Outcome**: only `--e2e-consent` decides without a human, gated on
  `!app.isPackaged` **and** argv, re-read per call, with a loud banner and a
  distinct `via: 'dev-auto'`. G28 (no flag → an 8s call never completes, page
  untouched) reproduced GREEN for me on a real dialog.
- **Cooldown** is checked twice — pipeline step 5 and again at the top of
  `requestFillConsent` — so a future caller cannot route around it. Verified
  live: deny phase 3/3, including "a retry is refused by the cooldown **without**
  a second consent call".
- **Punycode**: I could not raise an IDN dialog without a hosts-file edit either,
  but the property is one step removed from the dialog and is checkable —
  `new URL('https://gооgle.com/x').origin` is `https://xn--ggle-55da.com`, and
  `safeOrigin` is the only producer of that line. What remains unverified is
  whether the Win32 task dialog renders the punycode string it is handed, which
  is not in doubt.

**Verdict: PASS.** I could not find a path by which the agent influences the
dialog's content, timing, or outcome.

---

## 8. The known-open list — correctly deferred, and two of them are now closed

| item | status after this review |
|---|---|
| U2 (`Input.insertText` fidelity) | correctly deferred; nothing here depends on it |
| U3 (dialog modality on Windows) | still unverified; G28 shows the call blocks on it, which is the property that matters for safety |
| U4 (dialog invisible to `browser_capture`) | still unverified |
| **U5 (preload in subframes)** | **now measured — the premise holds.** A same-origin iframe containing a password field: the walk emits `iframe e17` as a leaf, the plan answers `NO_FIELDS`, and the frame's own witness shows nothing written. Subframe elements never enter the index |
| U6 (`wc.getURL()` mid-navigation) | correctly left unverified; the preload echo makes it irrelevant |
| U7 (TOTP against a real verifier) | still open; the fixture's independent arithmetic is the strongest offline check and G26a passes |
| **`FILL_UNCONFIRMED` unreachable** | **now reached.** A page that spins the renderer for 6.5s inside the write pass produces exactly the specified answer at 6520ms — "inserted … did not confirm within 5s … may or may not be filled" — with the values actually landed and taint + needles correctly **kept** (snapshot and read both clean). The record understates this as needing "a page that hangs the preload"; a busy loop in an event handler is enough, and it behaves correctly |
| `FIELD_IN_SUBFRAME` unreachable | **confirmed unreachable**, by the U5 measurement above. Consequence worth naming: a real iframe SSO login answers `NO_FIELDS`, whose text tells the agent to "act on the page first and call again" — which will make the agent loop. The accurate message exists and cannot fire |
| `forget(tabId)` has no callers | **confirmed** — `TabManager.close()` does not call it, so needles (plaintext) outlive the tab by up to ten minutes and `states` leaks a `tainted` set per closed tab. Tab ids are monotonic (`t${++tabSeq}`), so there is no id-reuse hazard on top of it |
| punycode dialog check not done | confirmed; see §7 |
| nothing tested against a real site | confirmed. Everything, including this review, is fixtures |

---

## 9. Fix list

**Blocking — do not leave these for later.**

1. **Scrub `href` with the needles.** In `redactTainted` (`engine.ts`), add
   `href` to the needle branch beside `value`, `text`, `name` and `rows` —
   which also covers the diff renderer, since deltas are computed from the
   already-redacted tree. Then extend `test/fixtures/login.html`'s "Echo
   password to page" button to also write `a.href = '/leak?pw=' + value`, so
   **G19 asserts it**; without that, the next reviewer is back to reading.
   (Measured leak line, for the RED that should precede the fix:
   `link e7 "Continue to checkout" /leak?pw=guard-pw-93a1`.)

2. **Re-validate immediately before each write.** In the preload's write pass,
   between `input.focus()` and `setter.call(...)`, re-assert the target's
   invariants for that kind — `isConnected`, `ownerDocument === document`,
   `type === 'password'` for `password`, `!isDisabled(input) && !input.readOnly`
   — and on failure in `atomic` mode stop writing and reply
   `{ ok: false, reason, key }`. The predicates already exist a few lines above;
   this is a re-check, not new policy. Add a guard on a fixture whose username
   `focus`/`input` handler unmasks or disables the password field
   (`vfprobe/rev-race.html` is that fixture, ready to move into `test/fixtures`),
   and sabotage it to prove it discriminates.

**Required but not blocking.**

3. **`src/main/consent.ts` contains a literal NUL byte** (offset 4193, the
   `declineKey` separator `` `${origin}\0${entryId}` `` written as a raw
   character). Git therefore classifies the file as **binary**: this change's
   entire consent diff renders as `Bin 4151 -> 12418 bytes`, so the credential
   dialog, the cooldown and the dev-auto path were unreviewable in any `git
   diff`, `git show`, or PR view. Replace the raw byte with the six-character
   escape sequence backslash-u-0-0-0-0 (or with a separator that is not a
   control character at all). One character, and it restores reviewability to
   the most sensitive file in this change.

4. **Correct `vaultfill-red-record.md`**: the POST preload hash (§0), the S10 row
   (§2 — it quotes the shipped line but the sabotage applied the pre-S11 one),
   and the sentence "applied to the **shipped** source". Either re-run S3 against
   the shipped preload or say plainly that S1/S2/S3/S5/S10 were measured on the
   pre-S11 build. My re-runs in §6 can be cited for four of the five.

5. **Correct the commit message's "turning exactly one guard red"** if the
   history is ever amended; otherwise note it in the record.

6. **`security.md` follow-up** (the builder was forbidden from touching it):
   restate the load-bearing property as being about response types rather than
   the process; move the "copy into a `<div>`" row from "designed, not yet
   implemented" to implemented-with-named-residuals; and correct "four
   interpolate `err.message`" — the fill site is now a fixed vocabulary, leaving
   three (resolve, read, select).

**Worth doing while the context is fresh.**

7. Call `forget(tabId)` from `TabManager.close()`. One line; it stops plaintext
   riding a ten-minute timer after the tab is gone.
8. Register needles for **sensitive profile** values too. The mechanism now
   exists, and the old `taintedValues` approach fails whenever the page copies a
   national ID out and then clears the input.
9. Route `browser_act`'s obstructor id and the `select` error labels through the
   same needle scrub (§3, residuals).
10. `unmarkTainted` on a globally-refused fill deletes taint unconditionally, so
    a refused credential fill could clear a taint an earlier fill placed on the
    same key. The needle twin (`dropNeedles`) documents exactly this residual;
    the taint half does not. Practically unreachable today, worth a comment.
11. Submit: `focusedKey` is measured in the page at T+250ms and the CDP Enter is
    dispatched an IPC round trip later, so a page can move focus in between. The
    blast radius is an Enter in the wrong field, not a credential in one.
12. `vault_request_fill` calls `observe()` for its own purposes, which advances
    the shared snapshot baseline and marks refs emitted without the agent ever
    seeing that render. Pre-existing (`browser_fill_form` does the same) and the
    fidelity scenarios stay green, but a page change between the agent's last
    observation and the fill is silently absorbed.

---

## 10. Is this safe to leave running as the owner's daily browser?

**Yes, with fix 1 landed before the vault holds a real credential.**

The reasoning, stated so it can be argued with:

- **The credential path is dormant until the owner opts in.** There is no
  `vault.aperture` on this machine, so `vault.state()` is not `unlocked` and
  every `apply` answers `VAULT_LOCKED` before it touches the page. Nothing in
  this change becomes reachable until a human creates a vault and adds an entry.
- **Every fill costs a deliberate human click**, on a native dialog the agent
  cannot see, render, or skip, with Cancel as both default and escape, no
  "remember this", a 60s decline cooldown, and a shared 6/minute limiter. I
  verified there is no parameter, grant, or agent string that reaches it.
- **Origin binding is terminal and is decided before the page is consulted.**
  The vault will not name an entry on the wrong origin, so a manipulated agent
  cannot even ask.
- **The two defects above are containment failures, not disclosure paths, with
  one exception.** Fix 2 is an invariant break with no measured leak — taint and
  needles held in every row I ran. Fix 1 *is* a leak, but only for an origin
  that has already been handed the password, and its practical target is the
  narrow late-injected-skimmer case. That is precisely the case the needles were
  built for, which is why it blocks; it is not a reason to stop using the
  browser.
- **The dev affordances are the residual worth naming.** The owner runs an
  unpackaged build, so `!app.isPackaged` is always true and the argv flag is the
  *only* gate on `--e2e-consent`. That is acceptable — anything that can set
  Aperture's command line has already won under `security.md`'s envelope — but it
  means the packaged-inertness test is not the gate that protects daily use; the
  absence of the flag is. G28 makes that observable, and I reproduced it.
- **Nothing here moves the snapshot stream** (fidelity 6/6 in the record;
  G1–G15 green in all six of my launches), so ordinary browsing is unaffected.

What I would not yet claim: that this works on a real login form. Every
measurement in the record and in this review is against fixtures, by design and
by admission. The first real site is still an experiment, and `FILL_REVERTED`
plus a human is the correct answer when it fails.
