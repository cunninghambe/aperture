# Vault fill RED record — the stub RED, and the sabotage battery that replaces it

> **CORRECTION, 2026-08-03. §0's POST hashes and all of §2 were stale, and this
> file now says so where it said otherwise.**
>
> An independent review (`vaultfill-review.md` §6) found that the battery in §2
> was **not** run against the shipped source, though §2's own opening sentence
> said it was. Two facts establish it, neither disputable: the builder's
> `sabotages.json` targeted `if (input.disabled || input.readOnly) {`, a line
> that does not exist in the shipped file, and all nine live runs in
> `sabotage-log.txt` report "35/36 guards hold" — a 36-guard build, i.e. before
> G25b existed. The
> recorded POST preload hash (`de617d95…`, 30361 bytes) was likewise the
> pre-S11 bundle and not the shipped one; the three-byte delta is exactly
> `input.disabled` → `isDisabled(input)`. A provenance table whose whole job is
> to name the artifact under test named the wrong one.
>
> The whole battery has now been **re-run against the current shipped source**,
> after the two blocking defects that review found were fixed (`href` was an
> unredacted sink; validation and the write were one task but not one turn) —
> thirteen rows now rather than eleven, since each fix brought a sabotage of its
> own. §0 gains a CURRENT build table and §2's table is entirely re-measured.
> The old numbers are named as superseded rather than deleted, because "the
> record was wrong here" is itself part of the record.
>
> Also corrected, from the same review's fix list: the commit message's
> "turning exactly one guard red" does not survive re-measurement — S2, S4, S10
> and S12 each turn two, correctly, because the shipped checks cover two guards
> apiece. Understating a guard set is harmless; the sentence is still wrong, and
> §2's table now states the real sets.

What this file is: the evidence that G16–G28 **discriminate**. An instrument
that has never seen the defect it guards is the false green all over again
(`docs/design/tier4.md` §0; the fourth application of the F4 lesson, after
`blindfields-red-record.md`, `g14-red-record.md` and `g15-red-record.md`).

The vault fill path is different from those three in one way that changes what
evidence is even possible, and `docs/design/vaultfill.md` §15.3 says so first:
**for a feature that does not exist yet, the ordinary RED proves nothing.**
Every guard fails against a stub. A guard that fails because the tool answered
"the vault fill path is not yet wired in this build" has demonstrated no
discrimination whatsoever. Recording that and calling it evidence would be the
false green in its purest form.

So the evidence is in two parts, and only the second one is a discrimination
proof.

---

## 0. The builds under test — provenance

| fact | value |
|---|---|
| repo | `C:\Users\cunni\dev\aperture` |
| HEAD at the time of parts 1–2 | `57e99b4230887cf4089818b5d8839a8e28886eec` ("docs: vault fill spec — execution path, plus ten defects found around the stub", 2026-08-02 23:27:05 -0400) |
| HEAD at the 2026-08-03 re-run | `c375415` ("vault: the fill path, plus ten defects found around the stub"), plus the two uncommitted blocking fixes |
| Electron | 43.2.0 · Node v22.14.0 (harness) |
| fixture server | scratchpad-only (never the repo — `bench/lib/store.mjs` `WATCH_DIRS` would otherwise sever bench stores), serving `test/fixtures` on **two** listeners, `127.0.0.1:8899` and `127.0.0.2:8899`, `Cache-Control: no-store` on every response. Deliberately not `0.0.0.0`: the fixtures are not exposed to the LAN. |

**The PRE build (part 1, the stub RED).** Working tree clean at HEAD.

| artifact | sha256 | size | mtime |
|---|---|---|---|
| `out/main/index.js` | `dcac2aac371d29f33896dbff5348d54ee4451464422c5bfa14e9669cb03bce01` | 197134 | 2026-08-02 03:04:17 -0400 |
| `out/preload/page.cjs` | `a1d308e83ee5b81ea6b400304902ae03d829860ecd9d51b44a1dd72594449e8b` | 27425 | 2026-08-02 03:04:17 -0400 |

That this bundle is the stub is not inferred from the hashes — it is what the
run itself says. Every credential guard's recorded reply is the stub's own fixed
string, `fill refused: the vault fill path is not yet wired in this build`,
which exists nowhere in the post build. The harness half of the change
(`bench/guards.mjs`, `test/fixtures/login.html`, `test/fixtures/signup.html`)
was on disk and the `src/**` half was not yet written; **no rebuild was run**
between authoring the harness and the run below, so what part 1 measures is the
stub engine driven by the final guards.

**The POST build (part 2, and the acceptance battery) — SUPERSEDED, and how.**

| artifact | sha256 | size | status |
|---|---|---|---|
| `out/main/index.js` | `25ad709a5835121c59f43fe373f6caba35b10c01e9fd963f1a0314f8e1328e37` | 228462 | was the shipped main bundle at `c375415`; the review reproduced it byte-for-byte from the shipped source |
| `out/preload/page.cjs` | `de617d9524eb83c30b28138714578b7bc91c031f74135c6ac2ec97e28b1d7119` | 30361 | **never the shipped artifact.** The shipped `c375415` preload was `510b3597fb4c5862d8492b0b9b69b266869adc57403188a62d96fd13a2b69891`, 30364 bytes — three bytes being `input.disabled` → `isDisabled(input)`. This row was the pre-S11 build |

**The CURRENT build — the one every measurement in §2 and §3 below was made
against.** Working tree: `c375415` plus the two blocking fixes from
`vaultfill-review.md` §9 (uncommitted; the builder is instructed not to commit).

| artifact | sha256 | size |
|---|---|---|
| `out/main/index.js` | `d0ff6c6c6ab58974526a8ab2cffb9d8c2e872c573f4090d83868ebb0ae032dc4` | 229572 |
| `out/preload/page.cjs` | `7cda2dba0c6ebb7bc392dd7d85867af7b8a659298d0c749d7ef36fee28657b0e` | 30506 |

Reproduced by `npx electron-vite build` three times — before the battery, on the
battery's own restore, and again at the end — with all three producing these
bytes exactly. So the shipped source and the shipped artifact agree, and the
artifact every green run below was measured against is this one.

`buildVersion` moves with every one of these rebuilds, which severs every
existing bench store. That is the integrity design working, and §15.4 item 10
below records it doing so.

---

## 1. Part 1 — the stub RED (ordering and apparatus, NOT discrimination)

`bench/guards.mjs` G16–G28 and `test/fixtures/login.html` were authored first
and run against the unmodified stub build.

Command:

```
npx electron . --seed-vault --e2e-consent=allow --e2e-consent-delay-ms=1500
node bench/guards.mjs <token>
```

Result: **19/36 guards hold · RESULT: RED — G16-seed, G16a, G16b, G17b, G17a,
G18a, G19, G18b, G20, G21, G22, G23, G24, G25, G26a, G26b, G27a.**

The pre-existing regression net G1–G15 (18 checks) was **green throughout**,
against the same build and the same command line.

Representative verbatim output:

```
FAIL  G16-seed  the dev-seeded vault is reachable, so the credential guards test something
        NO entry nameable on http://127.0.0.1:8899. Every credential guard below therefore fails on apparatus, not on discrimination.
FAIL  G18a  the password lands in the masked field and nowhere else (no focus-following spill)
        reply: fill refused: the vault fill path is not yet wired in this build.
        witness: pw-match:false user-match:false visible-decoy-set:false otp-valid:false submits:0 submitted-values-match:false echoed:false pw-masked:true pw-present:true
FAIL  G26b  a second fill inside the same 30s window is refused, and the field is unchanged
        reply: fill refused: the vault fill path is not yet wired in this build.
```

### What this run does and does not prove

**It proves:** the guards execute; both fixture listeners serve; the MCP
transport, the snapshot model bookkeeping and the `browser_read` witness
plumbing all work; `login.html` and `signup.html` render and report; the
URL-armed page changes fire (G21's witness shows `pw-present:false`, G22's shows
`pw-masked:false`); and no guard is accidentally green.

**It proves nothing else, and in particular it proves no discrimination.**
Sixteen of the seventeen failures have the identical cause — the stub's fixed
refusal string — and would be produced equally by a guard that asserted
anything at all.

Two further honesty notes about this run, because leaving them out would make
it read stronger than it is:

- **`G16-seed` failed for a reason the spec did not anticipate.** §15.3 part 1
  says the stub RED proves "the seeded vault is reachable". It cannot:
  `--seed-vault` is part of *this* change, so no vault could be seeded against
  the stub build. `entryHere()` therefore returned nothing. Rather than
  collapsing thirteen guards into one `exit 3` "could not run" line, the harness
  records a failed `G16-seed` and carries on with a placeholder id, so every
  guard still executes on its own terms. A broken seed on a shipped build reads
  as thirteen loud REDs, never as a vacuous green.
- **`G26a-blind` PASSED in part 1, vacuously.** Nothing was inserted, so no code
  could leak. A guard that passes against the stub is by definition proving
  nothing there; it earns its place in part 2 (S4).

---

## 2. Part 2 — the sabotage battery (this is the discrimination proof)

Each sabotage is a one-line regression applied to the **shipped** source, one at
a time. Rebuild, launch, run the full guard set, revert, rebuild. Reverting is
by saved buffer and never by `git checkout`: the working tree holds the whole
unlanded change set.

**The first version of this section did not do what that paragraph says**, and
the review caught it: the sabotage targets were written against a pre-S11 draft,
so all nine live rows S1–S10 were measured on a **36-guard** build whose preload
is not the one that shipped — `sabotage-log.txt` reports "35/36 guards hold"
nine times, and only S11 ever saw the 37-guard build. Every row below has now
been re-measured against the current
shipped source — the same source the §0 CURRENT hashes name — after this
review's two blocking fixes landed. Nothing in this table is inherited from the
earlier run.

Runner: `scratchpad/battery.sh` + `sabotages.json` + `sabotage.mjs`
(throwaway). Per-run raw output: `scratchpad/sab-S*.txt`; the roll-up is
`scratchpad/sabotage-log-2.txt`. Each patch is applied by exact string
replacement that **refuses unless the target text occurs exactly once**, which
is the mechanical version of the check that failed last time.

Every live run was `electron.exe <repo> --seed-vault --e2e-consent=allow
--e2e-consent-delay-ms=1500` followed by
`node bench/guards.mjs <token> http://127.0.0.1:8899 --phase=allow` — the
byte-identical fixture, guard and command line as the green run, with the
fixture server on both `127.0.0.1:8899` and `127.0.0.2:8899`.

| # | sabotage (as applied, to the shipped source) | must turn RED | observed, 2026-08-03 |
|---|---|---|---|
| S1 | `src/preload/page.ts`: `if (location.origin !== req.expectedOrigin) {` → `if (false as boolean) {` | G20 | **38/39 · RED — G20**, and only G20 |
| S2 | `src/preload/page.ts`: `checkTarget`'s `if (!(input instanceof HTMLInputElement) \|\| input.type !== 'password') {` → `if (false as boolean) {` | G22, G22b | **37/39 · RED — G22 and G22b**, and only those. The masked check now lives in one function called from both passes, so deleting it loses both windows at once — which is the point of it being one function |
| S3 | `src/preload/page.ts`: `checkTarget`'s `if (!el.isConnected) return 'gone';` → deleted | G21 | **38/39 · RED — G21**, and only G21. Worth recording *how* it failed: the reply became `FIELD_TOO_SMALL`, because a detached node's rect is 0×0 and the size check catches the same page with the wrong reason. The check is load-bearing for the right ANSWER, not for the refusal |
| S4 | `src/mcp/tools.ts`: `registerNeedles(id, needleValues);` → `void needleValues;` | G19 (G19b too — with no needles at all, the href sink leaks as well) | **37/39 · RED — G19 and G19b**, and only those |
| S5 | `src/preload/page.ts`: `const VERIFY_DELAY_MS = 250;` → `= 0;` | G18b | **38/39 · RED — G18b**, and only G18b |
| S6 | `src/vault/fillPlan.ts`: `if (passwords.length > 1) {` → `if (false as boolean) {` | G23 | **38/39 · RED — G23**, and only G23 |
| S7 | `src/vault/vault.ts`: `this.lastIssued.set(entryId, counter);` → `void counter;` | G26b | **38/39 · RED — G26b**, and only G26b |
| S8 | `src/vault/vault.ts`: `if (rec.rpId !== rp && !rec.aliases.includes(rp)) {` → `if (false as boolean) {` | G17a | **38/39 · RED — G17a**, and only G17a |
| S9 | `src/main/consent.ts`: two lines at the top of the credential branch consulting `grants` | G27b | **not live-discriminable** — see below. Run against `test/consent.test.ts` instead: *"a live profile grant for the same origin does not cover a credential"* went **RED** (`showMessageBox` called 0 times, expected 1) and green on revert. The 2026-08-03 review declined to run this one because `consent.ts` held a raw NUL byte; that byte is gone, so it was run |
| S10 | `src/preload/page.ts`: `if (isDisabled(input) \|\| input.readOnly) return 'not-editable';` → `if (false as boolean) …` | G25, G25b | **37/39 · RED — G25 and G25b**, and only those |
| S11 | *(added by the builder)* `src/preload/page.ts`: `isDisabled(input)` → `input.disabled` — §6.2's check, literally | G25b | **38/39 · RED — G25b**, and only G25b |
| S12 | *(added by the 2026-08-03 review)* `src/core/snapshot/engine.ts`: `if (n.href) n.href = scrub(n.href, needles, REDACTED_HREF);` → deleted | G19b (G19 too — its check is over the whole snapshot) | **37/39 · RED — G19 and G19b**, and only those. This restores the B1 defect exactly, and the measured leak line is the reviewer's: `link e35 "Continue to checkout" /leak?pw=guard-pw-93a1&c=` |
| S13 | *(added by the 2026-08-03 review)* `src/preload/page.ts`: the write-pass re-check `const bad = checkTarget(t, input);` → `null` | G22b | **38/39 · RED — G22b**, and only G22b. This restores the B2 defect exactly: reply `filled username and password for guard@example.com on http://127.0.0.1:8899`, witness `pw-match:true … pw-masked:false` — the saved password in a plain-text field, reported as success |

**Twelve live sabotages, each turning exactly its named guard set and nothing
else** — including, in every run, all eighteen of the pre-existing G1–G15
checks. Where a row turns two guards, that is because the shipped check covers
two cases; the commit message's "turning exactly one guard red" was wrong about
S2, S4, S10 and S12 and is corrected here rather than left standing. S9 is the
one row no live guard can reach, and the reason is structural (below).

Two honest notes about the apparatus, neither of which changes a result:

- The **unsabotaged** bundle is byte-identical before, during and after the
  battery: three separate `npx electron-vite build` runs — one before the first
  row, one on the battery's own restore, one at the end — all produce the §0
  CURRENT hashes exactly. Two source comments were reworded mid-battery and the
  bundle did not move at all, which is what esbuild dropping comments looks
  like. So every row differs from the shipped artifact by its one sabotage and
  by nothing else.
- `test/fixtures/login.html` gained two clarifying HTML comments between rows.
  Comments are not walked and not rendered; the full 39/39 run recorded in §3
  was made after them, on the exact final tree.

### S11 — a hole in §6.2, found by trying to sabotage it

§6.2's editability check is written `!el.disabled && !el.readOnly`. Implemented
literally, that check **does not see a control disabled by an ancestor
`<fieldset disabled>`**: the IDL `disabled` property reflects the content
attribute only, so it reads `false` while the control is unusable to a human.

This is not a hypothetical. It is the identical hole the `select` path closed —
`src/preload/page.ts`'s `aperture:select` handler says so in its own comment,
"`isDisabled` and not `el.disabled`, because `el.disabled` is false for a select
disabled by an ancestor `<fieldset disabled>`" — and the fill path never got it.
Doctrine says a fill must refuse what a human could not do; §6.2's spelling
lets a saved password land in a disabled field and reports success.

Fixed by using `isDisabled` (already imported in that file), which can only ever
refuse *more*, never less. Guarded by **G25b**, a guard not in §15.2's table,
against a new `login.html?mode=fieldset`. S11 above is the proof it
discriminates: with §6.2's literal check the fill lands and Aperture answers
`filled username and password …` while the page reports `pw-match:true`.

### S12 and S13 — the two defects an independent review found, and their guards

Both were **blocking** in `vaultfill-review.md`, both were measured there before
they were fixed here, and both now have a live guard that fails if they return.

**S12 / B1 — `href` was an unredacted sink.** `redactTainted` scrubbed `value`,
`text`, `name` and `rows`. `SnapshotNode.href` is the fifth serialised,
page-controlled field, `render.ts` emits it on the full snapshot and in the
diff, and nothing scrubbed it — so a page that copied a filled password into a
link target handed it straight to the agent, in the one channel `browser_read`
structurally cannot see. `login.html`'s echo button now writes that link, and
**G19b** asserts the marker is there instead. S12 is the proof it discriminates.

**S13 / B2 — validation and the write were one task but not one turn.** The
preload validated every target and then wrote in a second pass, and `focus()`
plus the dispatched `input`/`change` run page JavaScript synchronously in
between. A username handler doing `p.type = 'text'` therefore got the saved
password written into an unmasked field — on the human's own screen, in the
clear — while Aperture answered `filled username and password …`. Every
predicate is now re-asserted between `focus()` and `setter.call`, from the same
function the pre-pass uses; a mid-write refusal replies with a count of what was
already written, so main keeps the taint and answers `FILL_INTERRUPTED` rather
than a code that claims nothing was inserted. **G22b** measures it against
`login.html?mode=race`, and S13 is the proof it discriminates.

### The three places the spec's own table was wrong, stated rather than smoothed over

**S2 does not turn G18a red, and cannot.** G18a fills an ordinary login page
whose password field is `type=password` throughout. Deleting the check that the
target *is* masked changes nothing on a page where it always is. G18a is a
different claim — that the value lands in the masked field and in no other — and
what discriminates it is the visible decoy, not this check. Recorded as
observed; no guard was weakened to make the table come out right.

**S8 as literally worded — "accept an `ORIGIN_MISMATCH` when a (newly added)
`force` flag is passed" — cannot turn any live guard red**, because a newly
added flag that the guard does not pass changes nothing. What ships as this
regression in practice is a flag with a helpful default, so S8 was applied as
its *effect*: the origin comparison stops refusing. That turned G17a red as
specified. The other half — someone adding the lever at all — is caught
independently and more cheaply: adding `force: z.boolean().default(true)` to
`VAULT_FILL_SCHEMA` turns `test/vaultfill.test.ts` → *"13. has exactly four
keys, forever"* RED. Both were run.

**S9 is not discriminable by any live guard in this apparatus, and the reason is
structural rather than a gap in the guard.** A grant is only ever created by a
human clicking "Allow for … (10 min)" on a *profile* dialog. Every path that
gets a live run past the native dialog is `--e2e-consent`, which decides before
any grant is consulted or created — so no grant can exist during a guard run,
and a credential path that consulted grants would consult an empty map. Rather
than invent a guard that could only ever check an unreachable state, S9 is run
against `test/consent.test.ts`, which constructs exactly that state with the
dialog mocked: a human approves a profile fill with the 10-minute button, the
next profile fill rides the grant with no dialog, and the credential fill that
follows **must** still raise one. That test went red under S9 and green on
revert. It is a real discrimination test; it is just not a live one.

Re-run on 2026-08-03 against the shipped `consent.ts`, and this time the run is
recorded rather than reasoned about: with two lines consulting `grants` at the
top of the credential branch, `npx vitest run test/consent.test.ts` reports
**1 failed | 17 passed**, the failure being exactly that test —
`expected "spy" to be called 1 times, but got 0 times`, i.e. the credential fill
rode the grant and raised no dialog. On revert, 18 passed.

---

## 3. The §15.4 acceptance battery

Re-run in full on 2026-08-03 against the current source (`c375415` + the two
blocking fixes). Where a number moved, the old one is named.

| # | check | result |
|---|---|---|
| 1 | §15.3 part 1 recorded | this file, §1 |
| 2 | `npx tsc --noEmit` | **clean** |
| 3 | `npx vitest run` | **20 files, 501 tests passed** (447 at `c375415`'s parent; 500 at the reviewed build; +1 here — `14c`, which pins the one refusal that can follow a partial write to not claiming "nothing was inserted") |
| 4 | `npx electron-vite build` | **clean** (hashes in §0, CURRENT table) |
| 5 | `bash bench/fidelity-all.sh` | **ALL FIDELITY SCENARIOS: GREEN** — form, rerender, widgets, biglist, selects, blindfields. Neither fix moves the snapshot stream, including G13b's "a link whose href moves under a stable label reports the new target", which is the guard the `href` scrub could most plausibly have broken |
| 6 | live guards G1–G15 | **18/18 PASS.** The engine and preload were edited; these are the regression net |
| 7 | live guards G16–G28 | **PASS in all three phases** — allow **39/39** (was 37/37; +G19b, +G22b), deny 3/3, none 2/2 |
| 8 | §15.3 part 2 | re-recorded above against the shipped source: **12 live sabotages, each turning exactly its named guard set and nothing else**, plus S9 recorded non-live |
| 9 | `node bench/task.mjs --selftest` | **SELFTEST PASS** — G1 null-agent (5 predicates FALSE), G2 scripted solver (5 tasks × 2 arms SOLVED), G6b liveness canary PASS. No API budget spent |
| 10 | severance behaves | **verified.** `node bench/task.mjs --report` against the 230-episode store answers `RESULT: INTEGRITY (exit 6)`, names what moved, and says "Nothing has been run, nothing has been changed, and nothing has been discarded. … There is deliberately no flag that pools them anyway." |
| 11 | the dialog was read | **done, §4 below** — one manual run with no `--e2e-consent`, dialog captured and transcribed. The IDN half was **not** verified; see §5 |
| 12 | packaged inertness | `test/security.test.ts` → "dev-only affordances are inert in a packaged build": `--e2e-consent` decides nothing and `--seed-vault` throws, when `app.isPackaged` |
| 13 | tree + tag | **not done — deliberately.** The builder was instructed not to commit |

---

## 4. Battery item 11 — the dialog, as a human sees it

One run with `npx electron . --seed-vault` and **no** `--e2e-consent`, on
`http://127.0.0.1:8899/login.html`. The real native dialog was raised and left
standing; the window (title `Confirm sign-in`, 763×549 physical px) was captured
by `PrintWindow` on that HWND alone, and read.

Transcription, verbatim:

```
[title bar]  Confirm sign-in

  ⚠  Fill your saved sign-in on this page?

     Aperture's AI agent asked to fill a saved sign-in on:

         http://127.0.0.1:8899

         Saved for:  127.0.0.1
         Account:    guard@example.com
         Will fill:  username and password

     The password is never shown to the AI. This website will receive it.
     Aperture chose which fields to fill; the AI could not.

                                   [ Cancel ]   [ Fill this once ]
```

Checked against §9.2 line by line: title, message, the agent-attribution line,
the indented origin, the three labelled facts, both closing sentences, and two
buttons with Cancel first and carrying the default-button border. No
page-authored byte appears anywhere in it, and no agent-authored byte either.

One cosmetic divergence worth recording: §9.2 writes the three facts as an
aligned column using padding spaces, and Windows renders the task dialog in a
proportional font, so `Will fill:` does not line up with `Saved for:` and
`Account:` on screen. Substance is unaffected; the spec's ASCII alignment simply
does not survive the font.

---

## 5. What was NOT verified

- **The punycode origin on an IDN fixture (the second half of battery item
  11).** Showing `https://xn--ggle-55da.com` for a Cyrillic-о lookalike needs
  that host to resolve to the loopback fixture server, which needs a hosts-file
  entry — a system modification, and not one to make for a test. The property
  itself is `URL.origin`'s and is asserted where it can be: `safeOrigin()` is
  the only thing that ever produces the origin line, and it is `new
  URL(url).origin`. The *rendering* of a punycode origin in the live dialog is
  unverified.
- **U2, U3, U4, U6, U7** from §16 remain open exactly as the spec left them.
  **U5 was closed by the 2026-08-03 review**, which put a password field in a
  same-origin iframe and measured the walk emitting `iframe` as a leaf, the plan
  answering `NO_FIELDS`, and the frame's own witness showing nothing written.
- **`FIELD_IN_SUBFRAME` and `FILL_UNCONFIRMED`** have wire strings and code
  paths but no guard reaches them. The review reached `FILL_UNCONFIRMED` by
  probe (a busy loop in an event handler is enough — the page need not hang the
  preload) and found `FIELD_IN_SUBFRAME` unreachable, which is the consequence
  of U5's result. Both remain unguarded here.
- **`FILL_INTERRUPTED` after a password has already landed.** G22b covers the
  case that matters — the password refused because the field changed — but the
  arithmetic case where username AND password are in and the OTP target is the
  one that changes has no fixture. The code path is the same one; the count in
  the wire string is not separately measured.
- **Real-world sites.** Everything here is fixtures.

---

## 6. U1 — resolved by probe

§16's U1 asks whether the isolated-world setter plus synthetic `input`/`change`
actually takes on a real `<input>`. `docs/design/tier1.md` §2 measured the
world-boundary argument for `<select>` and never for `<input>`, and never
against a site that checks `event.isTrusted`. The probe §16 names was run before
the guards were trusted, throwaway, five variants, one password field per page.

| variant | verdict | the page's own witness |
|---|---|---|
| plain `input[type=password]` | **landed** | `pw-match:true pw-len:13` |
| React value tracker (`Object.defineProperty(node,'value',…)` on the main-world wrapper, dedupe-and-snap-back on `input`) | **landed** | `pw-match:true pw-len:13` |
| `maxlength=8` | **landed** | `pw-match:true pw-len:13` |
| `input` listener reverting unless `e.isTrusted` | **FILL_REVERTED** | `pw-match:false pw-len:0` |
| `input` listener doing `p.value = p.value.slice(0,8)` synchronously | **FILL_REVERTED** | `pw-match:false pw-len:8` |

**The setter path takes.** The world-boundary argument holds for `<input>` as it
did for `<select>`: React's tracker is installed on the main world's wrapper for
the node, the isolated world's prototype setter is not that object, so the
dispatched `input` reads as a genuine change and the controlled component keeps
the value.

**The `isTrusted` class fails, and fails the way the design intends** — reported
as `FILL_REVERTED` with the sign-in explicitly NOT filled, rather than a silent
mis-fill. §18 rules out an agent-selectable fallback for exactly this case; the
answer is a human.

**One spec claim is falsified by this probe.** §3.4 justifies keeping the
same-task read-back with "a `maxlength` truncation happens inside the setter, so
a 20-character password written into a `maxlength=16` field comes back short
immediately". It does not: `maxlength` constrains *user* input and does not
apply to a programmatic value assignment, and the 13-character password landed
whole in a `maxlength=8` field. The same-task read-back is still worth keeping
and is still kept — the fifth variant shows it catching a synchronous sanitiser,
which the deferred T+250ms check cannot attribute — but it earns its place on
that class, not on `maxlength`. The comment in `src/preload/page.ts` says so.
