# Design: the owed-verification programme

**Status:** spec, unexecuted. Written 2026-08-06 against `a9e39d8`, tree clean.
**Baseline, measured while writing this and to be re-confirmed before anything
else:** `npx vitest run` → **662 passed, 27 files**. `npx tsc --noEmit` clean.

---

## 0. What this is

Three claims in this project currently rest on **reasoning** rather than on
**measurement**. Each is named in `docs/HANDOFF.md`'s "Still owed"; each has a
recorded argument for why the reasoning is probably right; and each is, by this
project's own §9 rule, *not a favourable answer*:

> An unmeasured thing is not a favourable answer.
> — `webbotauth.md` §12.3

| # | the claim resting on reasoning | where it is owed from |
|---|---|---|
| **1** | The G33 block discriminates **behaviour**, not spelling — the mux is verified to be on the session the traffic uses, and `agentOwned` is verified not to inherit through `window.open` | `webbotauth.md` §12.5 step 3 |
| **2** | Registering an `onBeforeSendHeaders` listener does not, by itself, change header order or casing on the wire | `security.md` verification queue #7, `webbotauth.md` §12.3 |
| **3** | The class-C (alphabet) and class-D (parity) guards fail when their **mechanism** regresses, not merely when their author's own example is restored | `security.md` "The stopping criterion", classes C and D |

### What this is NOT

- **Not a security hunt.** No sixteenth sink is sought. No mechanism class is
  added. If something turns up that is not an instance of A–G, it is reported
  as an **eighth mechanism** and nothing else is done with it under this spec.
- **Not feature work.** The whole programme is four substitutions, one
  measurement of four legs, one new guard leg, and at most three small guard
  edits. If a step appears to require a product change, stop and report.
- **Not a re-litigation.** Every ruling in `webbotauth.md` §§3–8 and every
  closure in `security.md` stands. This measures the instruments, not the
  subject.

### The house rules that bind this document

1. **RED first.** No green counts until its red has been observed
   (`webbotauth.md` §9). This applies to every guard *repair* below: a repair is
   landed, the row that motivated it is re-applied, the repair must go RED, the
   row is reverted, and the suite must return to green. Both observations are
   recorded.
2. **Artifact hash on every live verdict.** `bench/guards.mjs` prints the
   `out/main/index.js` SHA-256 in its header and on the RESULT line. Every live
   result recorded below carries its hash. Three separate incidents in this
   project were a green run against a stale artifact.
3. **Preregistration.** §1 states, for each item, what outcome licenses what
   sentence — written before the measurement exists. The result tables in §5
   are empty on purpose. Filling them in is the whole job.
4. **A green is a finding.** For items 1 and 3, a row that does not go red is
   not a pass. It is the measurement that the guard recognises its author's
   example rather than the mechanism, and it obliges a guard rebuild.

---

## 1. Preregistration

Written before any of it exists. Each row states the outcome and the exact
sentence it licenses. Nothing below is conditional on which outcome is nicer.

### 1.1 Item 1 — the two live-only sabotage rows

| row | outcome | what it licenses |
|---|---|---|
| **L1** (`installMux` on a session no tab uses) | **RED on exactly {G33a, G33b, G33c-img, G33c-fetch, G33d, G33e-tamper}**, with `npx vitest run` **662/662 GREEN** and `npx tsc --noEmit` clean in the same tree | G33a discriminates on *behaviour*: it fails when the mux is installed on the wrong session even though every source and unit guard is satisfied. The §12.4 note — "a source guard catches the *spelling*, and G33a is what catches the *behaviour*. Both are owed, and only one is done" — is discharged. `webbotauth.md` §12.5 step 3's first row is recorded as observed |
| **L1** | **GREEN on G33a** | G33a does not measure what it claims. It is reading a verdict that survives the artifact it was produced under, or the fixture is serving a cached verdict. **The guard is rebuilt before any other work in this document proceeds**: each guard run must carry a per-run nonce in the fixture path and must hard-fail when `seen` is empty for that nonce. Then L1 is re-applied |
| **L1** | RED, but on a set **other than** the six named | Something other than the mux's session moved. Record the set, revert, and stop: a red set that does not match the `aa8749f1…` run's set means the two artifacts differ in more than the intended substitution |
| **L2** (window-open children inherit `agentOwned`) | **RED on exactly {G33d, G33f}**, with `npx vitest run` **662/662 GREEN** | The refactor fails **twice**, which is the row's entire reason for existing. Signing and the `browser_capture` refusal boundary are shown to be two separate consequences of one keystroke, and both are instrumented |
| **L2** | **RED on G33d only** | The capture leg is vacuous or absent. G33f is rebuilt until it is red under L2 and green (with its non-vacuity control green in the same run) on the clean tree |
| **L2** | **RED on G33f only** | Signing does not key on the tab record `create()` wrote — a finding about `botAuth`'s attribution path, reported and not fixed here |
| **L2** | **GREEN on both** | Neither consequence is instrumented and the "fails twice" claim in `webbotauth.md` §9's sabotage table is false as written. Report; do not paper over |

**G33f is new and therefore carries its own acceptance.** On the clean tree it
must be GREEN *and* its non-vacuity control (a `browser_capture` of the agent's
own tab, in the same run, succeeding) must be GREEN. A G33f that greens because
`browser_capture` fails for every tab is a vacuous pass wearing the right
colour — the `G33-server`/`G30-seed` lesson.

### 1.2 Item 2 — queue #7, header order and casing

**This is preregistered as a measurement whose outcome does not change what gets
written, only what it says.** `security.md`'s queue row #7 is rewritten in all
cases. Four legs; three comparisons; four possible readings.

| reading | comparison | the sentence it licenses |
|---|---|---|
| **R1 — inert** | A ≡ B in name order *and* name casing, and C differs from B only by the three signature names | Registering a listener that returns the request's own header map is **inert on the wire**. The residual is exactly the three added names at a recorded position, and it is scoped to allowlisted origins, which is what `webbotauth.md` §8.2 already discloses. Queue #7 **RESOLVED — favourable** |
| **R2 — order re-serialised** | A ≢ B in name **order** | A returning listener re-orders headers on **every request in the browser**, because `installMux` runs on every container session and the mux always returns an object. This is **wider than §8.2's disclosure**, which is scoped to origins the human chose to identify to. Queue #7 **RESOLVED — unfavourable, browser-wide**; §8.2's scope sentence is contradicted by measurement and an amendment to `webbotauth.md` is **owed and reported, not made** (see §6 partition) |
| **R3 — casing re-serialised** | A ≢ B in name **casing** only | As R2, restricted to casing. Record the exact transform (lowercased? title-cased?). Same browser-wide scope conclusion, same owed amendment |
| **R4 — identity-dependent** | A ≡ B but B ≢ D | Inertness depends on the mux returning `details.requestHeaders` **by identity**. That is currently an accident of one line and nothing asserts it. Queue #7 resolved as R1 **plus** a pinned invariant: one comment in `src/net/webRequestMux.ts` recording that the no-op path must return the same object, and one sentence in the queue row. If B ≡ D as well, record that the spelling is *not* load-bearing, which is the stronger and cheaper answer |

**What is already known and is not re-derived:** the mux returns
`requestHeaders` unchanged when no handler contributes, and it only ever adds
names, because a handler receives a frozen copy and returns additions rather
than holding the map (`webRequestMux.ts`, `collect()`). Those two facts bound
the residual. They do not close it, and this measurement is the only thing that
can, because the open question is a property of **returning anything at all**.

**A bound this measurement cannot exceed, stated up front.** The 8902 probe
speaks **HTTP/1.1 in cleartext**. On HTTP/2 and HTTP/3 every header name is
lowercase by protocol, so the casing question is moot there and the ordering
question is answered by a different Chromium code path. Whatever R-reading
comes out, the queue row records that it is measured on h1 only.

### 1.3 Item 3 — author-independent rows for classes C and D

The stopping criterion's third clause:

> The sabotage row must be an instance of the class that the guard's author did
> not have in hand when writing it — a different member, not the finding that
> prompted it. Equivalently: someone other than the guard's author picks the
> row.

**This document is the independent party.** The four rows in §4 were devised
from the source, against the guards, by someone who wrote neither.

| row | outcome | what it licenses |
|---|---|---|
| **C-i1**, **C-i2**, **D-i1**, **D-i2** | **RED** on `npx vitest run` | That class's guard is shown to fail on an instance its author did not have in hand. `security.md`'s cell changes from "**NO — not attempted**" to "**YES — <row id>**", with the assertion that failed named |
| any row | **GREEN** (expected for all four; see §4) | **That is a finding about the guard, not a pass.** The guard recognises its author's example. The repair named alongside the row is landed, the row is re-applied and must go RED, then reverted. The cell reads "**YES — <row id>, and it changed the guard**", matching the E and G precedent |
| any row | GREEN, and the named repair **also** fails to catch it | The repair is wrong. Stop, record, and report — do not iterate repairs until one sticks. A guard tuned until a known row goes red is a guard fitted to that row, which is the failure this whole clause exists to detect |

**Precedent, and why a green is expected.** The two rows elsewhere that
satisfied this clause *both changed their guards*: `downloadURL` with an inline
receiver passed 567/567, and a helper moving needles into the origin-bound set
confined coverage without deleting anything and passed 575/575. Both were green
on the first attempt and both fixes were one line of the guard. A row nobody
would have thought of is worth more than three rows everybody would.

**PROBE-C0 is preregistered separately** (§4.1) because it is not a row: it is a
measurement of the tree **as it stands**, with no substitution. Its outcome is
recorded in §5.3 and **acted on by nobody under this spec** — see §4.1's ruling.

---

## 2. Item 1 — the two live-only sabotage rows

Read `webbotauth.md` §12.5 step 3 and §13 first. §13 established the harness:
72/72 green at artifact `4115dd9f51778767…`, 66/72 at `aa8749f1288475e5…` with
`installMux(` commented out, red on exactly six legs including all three
*absence* guards via the vacuity trap. Both rows below run against that
established harness.

### 2.1 Row L1 — the mux on a session no tab uses

**What the row must demonstrate:** that G33a fails on the *behaviour* when every
offline instrument is satisfied. §12.4's S-W8 already applied
`installMux(session.defaultSession)` and observed it **RED at source level** —
`test/botauth.test.ts` asserts `containers.code` does not match
`/defaultSession/`. That is the spelling. This row must therefore be spelled so
that **no offline guard sees it**, or it measures nothing new.

**The substitution.** In `src/privacy/containers.ts`, inside
`private harden(s: Session, c: Container)`, replace the line

```ts
    installMux(s);
```

with

```ts
    {
      // SABOTAGE ROW L1 — REVERT ME. docs/design/owed-verification.md §2.1.
      const key = 'default' + 'Session';
      const s = (session as unknown as Record<string, Session>)[key]!;
      installMux(s);
    }
```

**Why it is spelled that way, and why that is not cheating.** The row's job is
to prove the *live* leg discriminates, so it must survive every *offline* leg.
The block shadows `s` so the literal `installMux(s)` — which
`test/botauth.test.ts` locates with `indexOf('installMux(s)')` and requires to
sit after `private harden(` — is textually unchanged; the split string keeps
`/defaultSession/` from matching; the shadow is block-scoped so `will-download`
and `setUserAgent` still receive the real container session, which keeps the
blast radius to the one wire this row is about. `session` and the `Session` type
are already imported at the top of the file, so no import changes and `tsc`
stays clean.

Its plausibility as a refactor is beside the point and is not claimed. S-W8
already covered the plausible spelling and was red. What is unmeasured is
whether the live leg catches the *act* when the spelling is invisible, and a
row that is invisible to every source guard is the only way to ask.

**Expected:** `npx tsc --noEmit` clean · `npx vitest run` **662/662 GREEN** ·
guards **67/73 — RED on {G33a, G33b, G33c-img, G33c-fetch, G33d, G33e-tamper}**,
the same six as the `aa8749f1…` run (73 rather than 72 because G33f has landed
by then, and G33f stays GREEN here: nothing signs, but the popup is still not
`agentOwned` and `browser_capture` still refuses it), from a **different**
artifact hash.

**The five collateral reds are the vacuity trap working, not noise.** G33b/c/d
are absence guards and hard-fail when G33a is not green in the same run;
G33e-tamper has no captured signature to mutate. Their reds carry no independent
information and must be reported as such.

**A green on G33a means** the guard does not discriminate and needs rebuilding —
see §1.1 for the specific rebuild.

**Revert:** restore the single `installMux(s);` line, rebuild, re-run guards,
confirm the hash returns to the green artifact's and the count to 72/72 (73/73
once G33f lands — see §2.3 for the ordering).

### 2.2 Row L2 — window-open children inherit `agentOwned`

**What the row must demonstrate:** that one keystroke fails **twice**. Signing
the popup is one consequence; silently widening `browser_capture`'s refusal
boundary is the other, and they are instrumented separately because a future
refactor will hit both and a single red would let a reviewer fix one.

**The substitution.** In `src/main/tabs.ts`, in the `setWindowOpenHandler`
callback, add one property to the `create` call:

```ts
    wc.setWindowOpenHandler(({ url }) => {
      if (!isAllowedScheme(url)) return { action: 'deny' };
      this.create({
        url,
        container: rec.container,
        activate: true,
        // SABOTAGE ROW L2 — REVERT ME. docs/design/owed-verification.md §2.2.
        agentOwned: rec.agentOwned,
        inherits: flatten(this.originScope(rec.id)),
      });
      return { action: 'deny' };
    });
```

This is the plausible form and needs no evasion: `create`'s options already
accept `agentOwned?: boolean`, the rationale writes itself ("the agent's popup
is the agent's tab"), and **no offline guard in the tree sees it** —
`test/egress.test.ts` rules the Electron member `setWindowOpenHandler`, not the
options object handed to `create`.

**Expected:** `npx tsc --noEmit` clean · `npx vitest run` **662/662 GREEN** ·
guards **RED on exactly {G33d, G33f}**, everything else green — in particular
G33a, G33b and both G33c legs, because signing a popup does not disturb them.

**Revert:** delete the one line, rebuild, re-run, confirm the artifact hash
returns to the green one.

### 2.3 G33f — the second detector, which does not exist yet

**Measured while writing this spec: `bench/guards.mjs` contains no leg
asserting `browser_capture`'s agent-owned refusal.** `src/mcp/tools.ts` refuses
with `'refused: browser_capture only works on tabs you opened.'` when
`!info?.agentOwned`, and nothing anywhere observes it. So L2 cannot fail twice
against the tree as it stands, and the second detector is part of what is owed
rather than an addition to scope.

**Where it goes.** Inside the existing G33 block in `bench/guards.mjs`,
immediately after the G33d leg, reusing G33d's popup. The marginal cost is two
tool calls.

**What it asserts, both halves required:**

```
G33f  — a window.open popup is NOT capturable by the agent
        (a) browser_capture on the popup tab is REFUSED, the refusal text
            matching /refused: browser_capture only works on tabs you opened/
        (b) NON-VACUITY, same run: browser_capture on the AGENT'S OWN tab
            (diskOnly) SUCCEEDS
```

Both halves in one `check`. Without (b) the leg passes whenever
`browser_capture` is broken for every tab, which is a vacuous green wearing the
right colour — the same failure `G33-server` and `G30-seed` are shaped to
prevent. Use `diskOnly: true` on both calls so no Notion credential is touched
and nothing leaves the machine.

**Resolving the popup's tab id:** the popup arrives as a new tab in
`browser_tabs {action:'list'}`; select the entry whose URL ends `/page2`. If no
such tab is listed, G33f fails with `'the popup tab was never created — the leg
did not run'`, which is the third vacuity mouth closed.

**G33f is NOT wrapped in `requiresPresence`.** The capture refusal is
independent of whether anything signs; gating it on G33a would make it hard-fail
during L1 for a reason that has nothing to do with L1, and would corrupt L1's
preregistered red set. State this in the leg's comment.

**Its own RED-first pair, both recorded:** GREEN with both halves on the clean
tree (72 → **73 legs**), RED under L2.

### 2.4 Ordering for item 1

G33f lands **before** L1 and L2, because L2's preregistered red set names it and
L1's preregistered red set is stated against a run that contains it. So:

1. Add G33f. Build. Run guards on the clean tree. Expect **73/73 GREEN**.
   Record the hash. *(This is G33f's green; its red comes at step 3.)*
2. Apply L1. Build. `tsc`, `vitest`, guards. Record hash and red set. Revert.
   Rebuild. Confirm 73/73 and the original hash.
3. Apply L2. Build. `tsc`, `vitest`, guards. Record hash and red set — this is
   also G33f's red. Revert. Rebuild. Confirm 73/73 and the original hash.

---

## 3. Item 2 — queue #7, the header-order measurement

A diff of launches, captured server-side. Four legs, three builds, three
launches.

### 3.1 The capture harness

**New file: `bench/probes/webbotauth/headerorder.mjs`.** Standalone, no
dependencies beyond `node:http` and `node:fs`, run with plain `node`. It is a
probe, not a guard: it does not judge, it records.

**What it does.** Binds **8902** on both `127.0.0.1` and `::1` — both, for the
same reason the G33 server does: on Windows `localhost` resolves to `::1` first,
and a leg whose request never arrived is a vacuous result. For every request it
appends one JSON line to a file named by `--out`:

```
{ "seq", "authority", "url", "method", "httpVersion",
  "rawNames": [ ...req.rawHeaders even-index entries, IN ORDER, ORIGINAL CASING... ],
  "lowerNames": [ ...the same, lowercased... ],
  "signatureHeaders": { present names and their values, for the C leg only } }
```

`req.rawHeaders` is the only reading that preserves both order and original
casing; `req.headers` lowercases and merges and must not be used for the
comparison. Serve a 200 with `cache-control: no-store` and a body naming the
leg, so a human watching the window can tell the legs apart.

**Cache-busting is mandatory.** Each navigation targets a unique path
(`/cap/<leg>/<epoch-ms>`), because a conditional request carries
`If-None-Match`/`If-Modified-Since` and a warm leg would differ from a cold one
for a reason that is not the listener.

### 3.2 The four legs

All four launched with **byte-identical flags**, in the same container, from a
freshly seeded profile:

```
npm start -- --seed-vault --seed-profile \
             --e2e-consent=allow --e2e-consent-delay-ms=1500 \
             --seed-botauth=bench/fixtures/botauth-dev-key.json
```

| leg | tree | navigate an **agent tab** to | what the listener does |
|---|---|---|---|
| **A** — control | `installMux(s);` commented out in `containers.harden()` (§12.5 step 1's form) | `http://127.0.0.1:8902/cap/A/<ms>` | there is no listener |
| **B** — installed, no-op | clean tree | `http://localhost:8902/cap/B/<ms>` (**not** allowlisted) | `collect()` returns null; mux calls back with `details.requestHeaders` **by identity** |
| **C** — installed, contributing | clean tree, same launch as B | `http://127.0.0.1:8902/cap/C/<ms>` (allowlisted) | mux calls back with `{ ...headers, ...additions }` — three names added |
| **D** — installed, new object, no additions | clean tree **plus** one substitution: in `installMux`, change the `additions === null` branch to `callback({ requestHeaders: { ...headers } })` | `http://localhost:8902/cap/D/<ms>` | a **new** object with identical content |

Open the agent tab with `browser_tabs {action:'open'}` so the request is a
main-frame document from an `agentOwned` tab, matching the surface queue #7 is
about. B and C share one launch and one artifact; A and D each need their own
build.

**Leg D's substitution is a sabotage row in form and is reverted like one.** It
exists solely to separate "a listener returned an object" from "a listener
returned a *different* object", which is the discrimination the question
actually turns on and which no amount of reading `webRequestMux.ts` can settle.

### 3.3 The comparison

Diff **`lowerNames` arrays** for order and **`rawNames` arrays** for casing.
Compare values for nothing — `Signature`, `Signature-Input` and a fresh `nonce`
differ per request by design, and `Cookie` may differ across launches.

```
order:   lowerNames(A) vs lowerNames(B)        -> R1 / R2
casing:  rawNames(A)   vs rawNames(B)          -> R1 / R3
identity:lowerNames(B) vs lowerNames(D)        -> R4
         rawNames(B)   vs rawNames(D)
added:   lowerNames(C) minus lowerNames(B)     -> must be exactly
                                                  ["signature","signature-input","signature-agent"]
                                                  (record their POSITIONS and
                                                   their casing as sent)
```

**Confounders to check before concluding anything.** If `lowerNames(A)` and
`lowerNames(B)` differ by a name that is not a signature header — `cookie`,
`accept-encoding`, `if-none-match`, `priority`, `sec-fetch-*` — the legs are not
comparable and the run is void. Re-run with a fresh profile and unique paths
before reading the diff as R2. Record the void run; do not silently discard it.

**If C's added names do not number exactly three**, or arrive with casing other
than what `botAuth.ts` writes, that is recorded in the queue row too — it is
part of the same question and costs nothing extra to observe.

### 3.4 What gets written

`security.md`'s queue table, row 7, is rewritten in full — replacing everything
from "**Still open as of 2026-08-05, and now MEASURABLE for the first time**" to
the end of the Item cell — with the paragraph §5.2 records, prefixed
`**RESOLVED 2026-08-06 by the four-leg header-order measurement** (`docs/design/owed-verification.md` §3)`
and stating: the reading (R1–R4), the exact diff, the artifact hash of each leg,
that the measurement is HTTP/1.1 cleartext only, and — under R2 or R3 — that the
residual is **browser-wide** rather than scoped to allowlisted origins.

The "If unfavorable" cell keeps its current text under R1 and R4. Under R2 or R3
it is replaced by:

> Documented fingerprint residual on **every request in the browser**, not only
> on origins the human chose to identify to. `webbotauth.md` §8.2's scope
> sentence is contradicted by measurement and is owed an amendment.

---

## 4. Item 3 — author-independent rows for classes C and D

Read `security.md`'s seven-class table and `sink-closure-review-4.md` first.

Four rows, two per class, run offline. Every one is judged by
`npx vitest run` against the 662-test baseline and by `npx tsc --noEmit`. None
of them needs a port, a build, or a launch, which is why item 3 runs **first**
in §6's command list.

**Why two rows per class rather than one.** One row satisfies the criterion.
Two are specified because in each class the two rows attack **different clauses
of the same guard**, and a guard that survives one clause and fails the other is
a different fact about that guard than one that survives both. Each row costs
one substitution, one `vitest` run and one revert.

### 4.1 Class C — alphabet

**The mechanism:** the redactor and the renderer read different bytes.
**The instances the guard was written from:** F-B (invisible code points), F-C
(URL percent-encoding).
**The guard, per the table:** walk-time `stripFormat`, one `redactUrl`
composing `scrubUrlish`, `canonicalNeedle`.
**What the guard's author believes** — stated in `walker.ts`'s `truncate` header
and `text.ts`'s `stripFormat` header — is that the class is closed **by
construction**: the walk emits strings that are *already in the renderer's
alphabet*, in one place, "rather than by two treatments kept in step by review".

That belief has two load-bearing halves, and each row attacks one:

- **(a)** the renderer performs no byte-changing transformation the walker has
  not already performed;
- **(b)** every page string reaching the agent passes through the walker, or
  through the one other path that was given the same strip by hand.

The author's own row attacks neither; it removes decoding from `redactUrl`,
which is the F-C instance restated.

---

#### PROBE-C0 — no substitution, run once, recorded, **not acted on**

Before either row, run this against the **shipped** functions (import `sanitize`
and `stripFormat` from `src/core/snapshot/text.js` — not a reimplementation):

```ts
const walkNorm = (s: string) => stripFormat(s.replace(/\s+/g, ' ').trim());
// walker.ts truncate() / directText() / the document title: collapse, then strip.

for (let cp = 0; cp <= 0x2fff; cp++) {
  const ch = String.fromCodePoint(cp);
  const w = walkNorm(`guard ${ch} pw93a1`);   // <space><cp><space>
  if (sanitize(w) !== w) record(cp);
}
```

**Preregistered outcome and its ruling.** If any code point is recorded, the
walker's normaliser and the renderer's are **not composable**: `sanitize` is not
idempotent, the walk emits bytes `sanitize` will further alter, and a needle
containing whitespace can be missed at redaction time and reassembled at render
time. That is F-B's own sentence — *Aperture removed the separator on the way
out* — for a code point the fix's correctness argument did not consider.

**It is recorded in §5.3 and fixed by nobody under this spec.** It is a defect
in shipped code, not in a guard, and this document's scope is verification plus
at most small guard edits. Landing a guard that fails on a clean tree would
leave the suite red with no authorised repair. **Report it upward as its own
decision.** The single-codepoint form of the same assertion (§4.1's C-i1 repair)
passes on the tree as it stands and is the form that lands.

---

#### Row C-i1 — a render-side deletion of a code point `stripFormat` does not name

Attacks half **(a)**.

**The substitution.** In `src/core/snapshot/text.ts`, inside `sanitize()`,
immediately after `t = stripFormat(t);`:

```ts
  // SABOTAGE ROW C-i1 — REVERT ME. docs/design/owed-verification.md §4.1.
  // Plausible rationale: soft hyphens and zero-width joiners are invisible,
  // survive copy-paste, and make the model's copy of the text unstable.
  t = t.replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, '');
```

**Why this is an instance the author did not have in hand.** `isStripped` is an
enumerated code-point predicate, deliberately written as a predicate rather than
a character class, and it is **shared** by the walker and the renderer — so
*widening* it is safe and the author's mental model is that the alphabet is
closed. The hazard is not in the enumeration; it is that nothing anywhere
asserts the renderer deletes **only** what the enumeration names. U+00AD,
U+200B–U+200D and U+FEFF are all invisible, all absent from `isStripped`, and all
one plausible line away from being removed at render time. The moment one is,
a page that writes `guard-pw<U+00AD>-93a1` presents bytes matching no needle and
Aperture itself hands the model the value whole — F-B verbatim, different code
point, same function, and outside every existing fixture.

**Expected: GREEN, 662/662, tsc clean.** G19g plants U+202D, which the walker
already strips; `absentEverywhere` in `bench/guards.mjs` reads through the same
enumerated set. No offline or live instrument in the tree is pointed at a code
point outside it.

**The repair, if green.** One executable property in `test/snapshot.test.ts`,
beside `describe('quote')`, importing `sanitize` and `stripFormat` from
`../src/core/snapshot/text.js`:

```ts
describe('the alphabet: the renderer removes nothing the walker left', () => {
  // THE CLASS-C INVARIANT, AS A MEASUREMENT RATHER THAN A LIST.
  //
  // walker.ts emits stripFormat(collapse(trim(x))) so that redactObserved
  // searches the bytes quote() -> sanitize() will emit. That argument holds
  // only while sanitize deletes nothing stripFormat left behind, and the
  // enumeration in isStripped is what makes it look as though it must. It
  // does not have to: any later edit that removes one more invisible at
  // render time re-opens F-B for that code point, and every fixture in this
  // repository plants U+202D.
  //
  // Swept, not listed. That is the completeness.test.ts move: "rendered" is
  // a measurement.
  const walkNorm = (s: string) => stripFormat(s.replace(/\s+/g, ' ').trim());

  it('sanitize is the identity on anything the walker already normalised', () => {
    const offenders: string[] = [];
    for (let cp = 0; cp <= 0x2fff; cp++) {
      const ch = String.fromCodePoint(cp);
      // Whitespace is excluded: the two-run case is a separate, OPEN question
      // recorded in docs/design/owed-verification.md §4.1 PROBE-C0.
      // `"` and `\` are excluded: sanitize ESCAPES them, which is injective
      // and expanding and cannot hide a needle.
      if (/\s/.test(ch) || ch === '"' || ch === '\\') continue;
      const w = walkNorm(`guard${ch}pw93a1`);
      if (sanitize(w) !== w) offenders.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    for (const cp of [0xfeff, 0x2060, 0xfe0f, 0x1d173, 0xe0001, 0xe0020]) {
      const ch = String.fromCodePoint(cp);
      if (/\s/.test(ch)) continue;
      const w = walkNorm(`guard${ch}pw93a1`);
      if (sanitize(w) !== w) offenders.push(`U+${cp.toString(16).toUpperCase()}`);
    }
    expect(
      offenders,
      'sanitize() removed a code point the walker left in. The redactor ran on ' +
        'the walker output; whatever sanitize removes after that is a separator ' +
        'Aperture deletes on the way out, which is F-B. Either add the code ' +
        'point to isStripped (shared by both sides) or do not remove it here.',
    ).toEqual([]);
  });
});
```

**Verified while writing this spec: this assertion passes on `a9e39d8` and fails
under C-i1.** The sweep was run against a faithful transcription of `sanitize`
and `stripFormat`; the implementer runs it against the shipped module, which is
the measurement of record.

Then: re-apply C-i1 → must be RED naming `U+00AD` first → revert → 663/663.

---

#### Row C-i2 — a transformation after the redaction on the one path that is not the walker's

Attacks half **(b)**.

**The substitution.** In `src/mcp/tools.ts`, in `browser_read`, after the
redaction and before the return:

```ts
      const live = await taintedValues(id, wc);
      let safe = redactFreeText(id, body);
      for (const v of live) {
        if (v.length >= 4) safe = safe.split(v).join(REDACTED);
      }
      // SABOTAGE ROW C-i2 — REVERT ME. docs/design/owed-verification.md §4.1.
      // Plausible rationale: innerText leaves the runs a <pre> block puts in,
      // and this file is the token budget. Collapsing them costs nothing.
      safe = safe.replace(/\s{2,}/g, ' ');
```

**Why this is an instance the author did not have in hand.** The read path is
the one page-text path that does not go through the walker, and its alphabet
agreement is maintained *by hand*, by a comment, in a different file from the
one that argues the property. `stripFormat(body)` sits correctly **before**
`redactFreeText`; nothing asserts that nothing else sits **after** it. A page
serving `<pre>my  pass phrase</pre>` — an ordinary double space, no adversarial
construction, and `<pre>` is the one element where innerText preserves runs —
puts `my  pass phrase` past a needle of `my pass phrase`, and this line then
emits the value whole. The needles that carry whitespace are not exotic: the
profile fill path registers full names and street addresses (`G30a-e`).

**Expected: GREEN, 662/662 (663/663 if the C-i1 repair has landed), tsc clean.**
No offline guard reads this function's ordering; G19f reads the carrier tab
through the shipped fixture, which plants no double space.

**The repair, if green.** The read pipeline is frozen by its **order**, in
`test/urlsurfaces.test.ts` (the file `security.md` already names as the guard
for "a helper written for a sentence and wired to some of the places it
applies"), using the shared `test/lib/source.ts` reader:

```ts
it("browser_read's body is transformed BEFORE redaction and not after", () => {
  // The one page-text path that is not the walker's. Its alphabet agreement is
  // maintained by hand, so the hand is what gets frozen: every mutation of the
  // body happens before redactFreeText, and the only thing between that call
  // and the return is the length cap and the envelope.
  //
  // Ordering, not presence. `stripFormat(body)` being present says nothing if
  // something else re-normalises the bytes afterwards, which is F-B with the
  // steps in the wrong order.
});
```

Assert, over the `browser_read` handler body with prose stripped: the index of
`stripFormat(body)` is less than the index of `redactFreeText(id, body)`; and
between `redactFreeText(id, body)` and `return text(untrusted(` the only
expressions assigning to `safe` are the `split(v).join(REDACTED)` loop and the
`.slice(0, maxChars)` cap — i.e. no `.replace(`, `.normalize(`, `.trim(` or
`stripFormat(` occurs in that span. Name the allowed spellings as a frozen list
so an addition fails by name.

Then: re-apply C-i2 → must be RED → revert → green.

### 4.2 Class D — parity

**The mechanism:** one function, two call sites, divergent treatment.
**The instances the guard was written from:** sink 10, F-G.
**The guard:** `test/urlsurfaces.test.ts`, "every routeCapture call site treats
ALL THREE page-influenced arguments".
**The author's own row:** restore `openUrls: t.list().map(…)` on the human path.

Read the guard's actual mechanics rather than its claim:

```ts
const sites = SOURCES.filter(
  (f) => /routeCapture\(/.test(f.code) && !/export async function routeCapture/.test(f.code),
);
expect(sites.map((f) => f.rel).sort()).toEqual(['src/main/ipc.ts', 'src/mcp/tools.ts']);
for (const f of sites) {
  const opts = /routeCapture\([\s\S]*?\n\s*\}\)/.exec(f.code)?.[0] ?? '';
  ...
}
```

Two facts follow from that text and neither is in its comment:

- **it enumerates FILES, not call sites** — `exec` returns the **first** match
  only, so a second `routeCapture(` in an already-listed file is never examined;
  and the file that *defines* `routeCapture` is excluded whole, so a call site
  inside `src/capture/capture.ts` is invisible too;
- **it asserts the SHAPE of an expression, not what the expression computes** —
  `openUrls` must be a one-element array literal containing no `.list(` or
  `.map(`, which any helper call satisfies.

`test/fillpaths.test.ts` was rebuilt in the fourth gate for exactly the first
defect — it had enumerated a `registerTool` block instead of the writes — and
`urlsurfaces.test.ts` still has it. That is strong evidence the author did not
have these in hand: the lesson landed in a sibling file and not in this one.

---

#### Row D-i1 — a second call site in a file the guard has already ticked off

**The substitution.** In `src/mcp/tools.ts`, in `browser_capture`, after the
existing `routeCapture` call, add a second one on a plausible path — the
crop-decline retry the surrounding code is already shaped for:

```ts
      // SABOTAGE ROW D-i1 — REVERT ME. docs/design/owed-verification.md §4.2.
      // Plausible rationale: when a detail crop declines, re-file the full
      // frame so the human still gets the shot they asked for.
      if (declined) {
        await routeCapture(cap.bytes, {
          openUrls: t.list().map((x) => x.url),
          title: title ?? info?.title ?? '',
          sourceUrl: info?.url ?? '',
          diskOnly,
          cropNote: cap.note,
        });
      }
```

Every one of the three page-influenced arguments is unscrubbed and the
destination is chosen by the tab list — F-G and sink 10 together, in a file the
guard has already checked and passed.

**Expected: GREEN.** `sites` is unchanged (the file was already in the list), and
`exec` stops at the first options object.

**The repair, if green.** Enumerate by **call site**, the way
`test/fillpaths.test.ts` does after its rebuild:

- replace `exec` with `matchAll` over `/routeCapture\(/g` and check **every**
  options object in every file, including the file that defines `routeCapture`
  (exclude the definition itself by its signature line, not the whole file);
- freeze the site list by **enclosing function name**, so a new site fails by
  name rather than by count.

That one change closes both defects at once. A call site added inside
`src/capture/capture.ts` — the variant this row does not run — is covered by the
same repair, and is recorded here so nobody spends a second run on it.

---

#### Row D-i2 — F-G restored on the human path, one function away

**The substitution.** Two edits in `src/main/ipc.ts`. At module scope:

```ts
// SABOTAGE ROW D-i2 — REVERT ME. docs/design/owed-verification.md §4.2.
// Plausible rationale: "the destination lookup is the same on both paths;
// give it a name."
function captureDestination(t: Tabs): string {
  return t.list().map((x) => x.url).find((u) => u) ?? '';
}
```

and at the `capture:page` call site:

```ts
      openUrls: [captureDestination(t)],
```

**Why the guard cannot see it.** `[captureDestination(t)]` matches
`/^\s*\[[^,\]]*\]\s*,?\s*$/` — one element, no comma, no bracket — and the line
contains neither `.list(` nor `.map(`, both of which now live one function away.
The guard's stated claim is "the capture destination must come from the ACTIVE
TAB ONLY"; what it asserts is the shape of a literal. This is the S-E3 and S-L2
lesson in a third place: an act caught or missed by how its author spelled it.

And it is squarely class D rather than class A, because it restores **divergent
treatment across the two call sites** — `src/mcp/tools.ts` keeps its literal,
`src/main/ipc.ts` does not — which is the mechanism the row is for.

**Expected: GREEN.**

**The repair, if green.** In the same `it(...)`, after the shape check, resolve
one level of indirection: if the sole array element is a call expression, locate
that function in the same file and apply the `.list(`/`.map(` check to its body;
if the callee cannot be located in the file, **fail** with a message saying the
destination expression must be resolvable at the call site. Failing closed on
an unresolvable spelling is the point — a guard that cannot see through an
indirection must say so rather than pass.

Keep the depth at one. A general call-graph walk in a source-level test is a
second parser, which is the failure `test/lib/source.ts` exists to prevent.

---

## 5. The result tables — empty on purpose

The implementer fills these in. Do not delete a row that came out unfavourably;
do not add a row that was not preregistered.

### 5.1 Item 1

| step | tree | artifact sha256 (16) | tsc | vitest | guards | red set | matches preregistration? |
|---|---|---|---|---|---|---|---|
| G33f acceptance | clean + G33f | `1faac8cbef6193c3…` | clean | 666/666 | **73/73** | — | **YES.** Both halves green: popup `t9` REFUSED with the matching text, agent's own tab `t8` captured — the non-vacuity control |
| L1 | + §2.1 substitution | `cefc723f21cfa4f1…` | clean | **666/666** | **67/73** | {G33a, G33b, G33c-img, G33c-fetch, G33d, G33e-tamper} | **YES — exactly the six**, the same set as the `aa8749f1…` run. G33f stayed GREEN, as §2.1 predicted |
| L1 revert | clean + G33f | `1faac8cbef6193c3…` | clean | 666/666 | **73/73** | — | **YES** — hash returned **byte-identical** to the acceptance artifact |
| L2 | + §2.2 substitution | `749ec3fe8e7b0b27…` | clean | **666/666** | **71/73** | {G33d, G33f} | **YES — exactly the two.** G33a, G33b and both G33c legs green, as preregistered |
| L2 revert | clean + G33f | `1faac8cbef6193c3…` | clean | 666/666 | **73/73** | — | **YES** — hash returned **byte-identical** |

**L1 discharges `webbotauth.md` §12.5 step 3's first row.** G33a fails on the
*behaviour* while every offline instrument is satisfied: `tsc` clean and
**666/666 green** in the same tree, because the literal `installMux(s)` is
textually unchanged inside the shadowing block and `'default' + 'Session'` never
matches `/defaultSession/`. The §12.4 note — "a source guard catches the
*spelling*, and G33a is what catches the *behaviour*. Both are owed, and only
one is done" — is discharged. The five collateral reds are the vacuity trap
working: G33b/c/d hard-fail when G33a is not green in the same run and
G33e-tamper has no captured signature to mutate; they carry no independent
information.

**L2 discharges the "fails twice" claim, and G33f's own RED-first pair.** One
added property, two independent detectors, and G33f's failure detail is the
finding itself: the popup was **captured** — `captured 68KB · saved to
…aperture-2026-08-06T16-54-30-846Z.png` — where it should have been refused,
with the non-vacuity control GREEN in the same run, so the red is not an
artifact of a broken capture path.

**The decision not to wrap G33f in `requiresPresence` is vindicated by
measurement, not by argument.** Under L1 nothing signs, so a `requiresPresence`
wrapper would have hard-failed G33f and made L1's red set seven legs instead of
the preregistered six. G33f stayed green there, exactly as §2.3 said it must.

### 5.2 Item 2

| leg | tree | artifact sha256 (16) | `lowerNames` | `rawNames` differ from A? |
|---|---|---|---|---|
| A control | `installMux(s)` commented out | `eec46d143680f0fe8…` | 11 names: host, connection, upgrade-insecure-requests, user-agent, accept-language, accept, sec-fetch-site, sec-fetch-mode, sec-fetch-user, sec-fetch-dest, accept-encoding | — |
| B installed, no-op | clean | `1faac8cbef6193c3…` | **identical 11, same order** | **NO — identical, including casing** |
| C installed, signing | clean (same launch as B) | `1faac8cbef6193c3…` | the same 11 **in the same order**, plus signature-agent, signature-input, signature at positions 11–13 of 14 | only by the three appended names; **no pre-existing name moved or re-cased** |
| D installed, new object | clean + §3.2 D substitution | `a1fb9b550e243578…` | **identical 11, same order** | **NO — identical to both A and B, including casing** |

**Reading:** ☑ **R1** ☐ R2 ☐ R3 ☐ R4 — *and B ≡ D, which §1.2's R4 row names as
"the stronger and cheaper answer".*

**Added names in C, in order and as sent:** `Signature-Agent`,
`Signature-Input`, `Signature` — title-case exactly as `botAuth.ts` writes them,
**appended after every pre-existing name** (positions 11, 12, 13 of 14).
Exactly three, as required.

**Void runs, if any, and why:** none. The confounder check is clean — A and B
differ by **no** name at all, so there is no `cookie` / `accept-encoding` /
`if-none-match` / `priority` / `sec-fetch-*` discrepancy to make the legs
incomparable. Unique cache-busting paths (`/cap/<leg>/<epoch-ms>`) on every
navigation and `no-store` on every response, so no leg is a conditional request.

**The paragraph written into `security.md` queue row 7:** written, in full, as
specified in §3.4 — the reading, the exact diff, all four artifact hashes, the
h1-cleartext bound, and the note that §8.2's scope sentence is **confirmed**
rather than contradicted (so the amendment §3.4 held in reserve under R2/R3 is
**not owed**, and `webbotauth.md` stays untouched as §7 requires).

**What R1 + (B ≡ D) licenses, stated as §1.2 preregistered it.** Registering a
listener that returns the request's own header map is **inert on the wire** —
neither order nor casing is re-serialised. The residual is exactly the three
added names at a recorded position, scoped to allowlisted origins, which is what
`webbotauth.md` §8.2 already discloses. Queue #7 **RESOLVED — favourable.** And
because B ≡ D as well, that inertness does **not** depend on the mux returning
`details.requestHeaders` by identity: returning a *new* object with identical
content is equally inert. So the one-line spelling in `installMux` is **not
load-bearing**, and the pinned invariant §1.2 would have required under R4 is
**not needed** — no comment was added to `src/net/webRequestMux.ts`, which keeps
`src/**` free of everything except the authorised PROBE-C0 repair.

**A caveat on the A/B pair, stated because nobody else will.** Leg A ran against
`127.0.0.1` and leg B against `localhost`, because B must sit off the allowlist
to exercise the mux's no-op path. The two therefore differ in the *value* of
`Host`. They do not differ in any header **name**, in name order, or in name
casing, which is the entire comparison — but a perfectly matched pair would
have needed a second non-allowlisted binding for A, and that was not run.

### 5.3 Item 3

| row | class | clause attacked | vitest | outcome | repair landed | row re-applied → red? |
|---|---|---|---|---|---|---|
| PROBE-C0 | C | — (no substitution) | — | **code points recorded: 69** (0–0x2FFF, space-cp-space form). The raw sweep returns 71; `U+0022` and `U+005C` are excluded because `sanitize` **escapes** them, which is injective and expanding and cannot hide a needle — leaving exactly the coordinator's 69. Single-code-point form: **0 offenders**, so the F-B fix holds on HEAD. Named example reproduces verbatim: walk → `"my  pass phrase"`, needle **absent**, render → `"my pass phrase"` | **LANDED — repair authorised by the coordinator** (see §9). Strip-before-collapse, in one shared `normalizeText` in `src/core/snapshot/text.ts` | **YES** — flipping `normalizeText` back to collapse-then-strip re-reds the guard, which also proves the guard reads the **shipped** function rather than a transcription of it |
| C-i1 | C | renderer deletes only what the walker deleted | **663/665** — i.e. **GREEN on all 26 pre-existing test files**; the only two failures are the guard landed by this programme | **GREEN — the finding.** No instrument that existed at `a9e39d8` sees it | `test/snapshot.test.ts`, one new `describe`, three `it`s | **YES — RED naming `U+00AD` first**, then `U+200B`, `U+200C`, `U+200D`, `U+FEFF` |
| C-i2 | C | every page string goes through the walker or the one hand-treated path | **665/665 GREEN**, tsc clean | **GREEN — the finding** | `test/urlsurfaces.test.ts`, one new `it`: `stripFormat(body)` must precede `redactFreeText`, and the writes to `safe` between the redaction and the return are frozen **by name** | **YES — RED**, naming the extra assignment (`expected [ 'redactFreeText(id, body);', …(2) ] to deeply equal [ …(1) ]`) |
| D-i1 | D | the guard enumerates call sites, not files | **666/666 GREEN**, tsc clean | **GREEN — the finding.** See the note below on the row's literal spelling | `test/urlsurfaces.test.ts`, inside the existing `it`: `matchAll` over every `routeCapture(`, definition excluded by **signature** not by file, sites frozen by **enclosing surface name** | **YES — RED**, 3 sites where 2 are frozen |
| D-i2 | D | the guard asserts what the expression computes, not its shape | **666/666 GREEN**, tsc clean | **GREEN — the finding** | same `it`: one level of bare-identifier indirection resolved in-file, **failing closed** when the callee cannot be located | **YES — RED**, naming the resolved body: *`captureDestination()` derives the capture destination from the tab list*. The fail-closed leg was separately shown red against an unresolvable callee |

**Neither "the repair also fails to catch it" branch fired.** §1.3's third row —
green, and the named repair also misses — did not occur for any of the four. No
repair was iterated: each was written once, from the source, before its row was
re-applied.

**One disagreement with the spec, recorded rather than smoothed over (D-i1).**
Spelled *verbatim* as §4.2 writes it — including `cropNote: cap.note` in the
second options object — the row goes **RED**, but on `test/autocrop.test.ts`'s
*caption-channel* leg ("cropNote is written at the two routeCapture call sites
and nowhere else"), **not** on the class-D guard. That leg counts `cropNote:`
occurrences per file with `matchAll` and is about a different property entirely.
The class-D guard — *every routeCapture call site treats ALL THREE
page-influenced arguments* — was **GREEN in the same run**, which is the
measurement the row exists to make. §1.3's preregistration reads its outcome off
the whole-suite colour, and that conflates the two. So the row was also run with
the incidental `cropNote:` line dropped — still a faithful class-D instance,
since `cropNote` is documented in `tools.ts` as explicitly **not**
page-influenced and is optional in `routeCapture`'s signature — and that isolated
form is **GREEN, 666/666**. Both readings are recorded; the isolated one is the
class-D verdict.

Incidentally, `test/autocrop.test.ts` already enumerates by `matchAll` — so the
lesson `test/fillpaths.test.ts` learned in the fourth gate had landed in **two**
sibling files and not in `urlsurfaces.test.ts`, which is stronger evidence for
§4.2's claim than the spec had when it was written.

### 5.4 The `security.md` cells, written from §5.3

Replace the class **C** row's last cell — currently
"**NO — not attempted.** The builder's row is the only one…" — with one of:

> **YES — C-i1 (and C-i2), and it changed the guard.** A render-side deletion of
> a code point `isStripped` does not name (U+00AD): the walk emits it, no needle
> matches, and `sanitize` removes it on the way out — F-B with a different code
> point. **GREEN, 662/662**, invisible to every fixture because all of them plant
> U+202D. `test/snapshot.test.ts` now measures the invariant across a swept
> alphabet rather than trusting the shared enumeration; **RED** after.

or, if either row was red first attempt:

> **YES — <row>.** <the substitution>: **RED** on <assertion>, tsc clean.

Replace the class **D** row's last cell — currently
"**NO — not attempted.** F-G was itself an independent finding…" — with the
same shape, naming D-i1 and D-i2.

Then replace the paragraph beginning "**Two rows of the seven have not been put
through the third clause: C and D.**" with what §5.3 shows, and amend the closing
sentence "The next reviewer's job is therefore verifying seven guards, and
constructing an author-independent row for C and D" to record that the row
construction is done and by whom.

**If a row went green and its repair landed, say so in the same sentence.** The
existing table does this for E and G and the reason is stated there: *twice,
satisfying the clause changed the guard rather than confirming it.* A third and
fourth instance of that is the most informative thing this programme can produce
and it must not be smoothed into a pass.

---

## 6. The implementer's ordered command list

**Port discipline, first and binding.** Two sibling workstreams may launch
Aperture. **8817 is contended.** Everything in phase 1 is offline and needs no
port. Before phase 2 or 3, check and **wait** — do not kill anything you did not
start:

```powershell
Get-NetTCPConnection -LocalPort 8817,8902 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
```

Empty output means the ports are free. If not, wait and re-check. 8901 is the
WebAuthn probe's and 8894/8896/8898/8899 are the bench's; none is touched here.

### Phase 0 — baseline

```bash
cd C:/Users/cunni/dev/aperture
git status --short                 # must be empty
git rev-parse --short HEAD         # must be a9e39d8
npx tsc --noEmit
npx vitest run                     # must be 662 passed, 27 files
```

Any deviation: stop and report. A baseline that is not the preregistered one
invalidates every count in §1.

### Phase 1 — item 3 (offline, no ports, run first)

```bash
# PROBE-C0 — no substitution. Run against the SHIPPED module, record, revert
# the scratch file. Do NOT fix what it finds; see §4.1.
# (a temporary test file, or `npx vitest run <file>` on one, then delete it)

# C-i1
#   apply §4.1's substitution in src/core/snapshot/text.ts
npx tsc --noEmit && npx vitest run          # record count and any failure names
#   revert; land the repair in test/snapshot.test.ts; re-run (expect 663)
#   re-apply C-i1; expect RED naming U+00AD; revert; expect 663

# C-i2
#   apply §4.1's substitution in src/mcp/tools.ts
npx tsc --noEmit && npx vitest run
#   revert; land the repair in test/urlsurfaces.test.ts; re-run
#   re-apply C-i2; expect RED; revert

# D-i1
#   apply §4.2's substitution in src/mcp/tools.ts
npx vitest run
#   revert; land the matchAll + enclosing-function repair in
#   test/urlsurfaces.test.ts; re-run; re-apply D-i1; expect RED; revert

# D-i2
#   apply §4.2's two edits in src/main/ipc.ts
npx vitest run
#   revert; land the one-level indirection repair; re-run; re-apply; expect RED; revert
```

Fill in §5.3. Write the §5.4 cells into `security.md`.

### Phase 2 — item 1 (needs 8817 and 8902)

```bash
# check the ports (above) and WAIT if occupied

npx tsc --noEmit && npx vitest run
npx electron-vite build                     # guards refuse a stale artifact

# 1. G33f's own green, on the clean tree
npm start -- --seed-vault --seed-profile \
             --e2e-consent=allow --e2e-consent-delay-ms=1500 \
             --seed-botauth=bench/fixtures/botauth-dev-key.json
node bench/guards.mjs <token> http://127.0.0.1:8899 --phase=allow
#    expect 73/73 GREEN; record the hash

# 2. L1 — §2.1's block-shadow substitution in src/privacy/containers.ts
npx tsc --noEmit && npx vitest run          # MUST stay 662/662 — the row's point
npx electron-vite build
#    relaunch, re-run guards; expect 67/73, RED on the six named in §1.1
#    record the hash; REVERT; rebuild; relaunch; expect 73/73 and the step-1 hash

# 3. L2 — §2.2's one added property in src/main/tabs.ts
npx tsc --noEmit && npx vitest run          # MUST stay 662/662
npx electron-vite build
#    relaunch, re-run guards; expect RED on exactly {G33d, G33f}
#    record the hash; REVERT; rebuild; relaunch; expect 73/73 and the step-1 hash
```

Fill in §5.1.

### Phase 3 — item 2 (needs 8902; 8817 only for the agent tab)

```bash
# leg A — control
#   comment out `installMux(s);` in containers.harden()
npx electron-vite build
node bench/probes/webbotauth/headerorder.mjs --out /tmp/hdr-A.jsonl &
#   launch with the phase-2 flags; browser_tabs open http://127.0.0.1:8902/cap/A/<ms>
#   record the artifact hash from any guards header, or shasum out/main/index.js

# legs B and C — clean tree, ONE launch
#   restore installMux(s); rebuild; launch
#   open http://localhost:8902/cap/B/<ms>      (not allowlisted, no-op path)
#   open http://127.0.0.1:8902/cap/C/<ms>      (allowlisted, three headers added)

# leg D — new object, no additions
#   in installMux, the additions===null branch -> callback({ requestHeaders: { ...headers } })
#   rebuild; launch; open http://localhost:8902/cap/D/<ms>
#   REVERT the mux edit; rebuild

# diff, per §3.3
node bench/probes/webbotauth/headerorder.mjs --diff /tmp/hdr-A.jsonl /tmp/hdr-BC.jsonl /tmp/hdr-D.jsonl
```

Fill in §5.2. Write the queue-#7 paragraph into `security.md` **whatever it
shows**.

### Phase 4 — close out

```bash
git diff --stat package.json package-lock.json   # MUST be empty
git diff --stat src/                             # only the landed guard repairs, if any
npx tsc --noEmit && npx vitest run
git status --short                               # every sabotage row reverted
```

Then update `docs/HANDOFF.md`'s "Still owed": strike items 1, 2 and 3 as
performed, replacing each with a one-line pointer to this document's §5 result
tables, and — if PROBE-C0 recorded anything, or if item 2 read R2/R3 — add the
two new owed items named in §4.1 and §3.4. Do not delete the section.

**No commits.** Leave the tree for review.

---

## 7. File and ownership partition

| path | who may touch it, and how far |
|---|---|
| `docs/design/owed-verification.md` | **this document.** The implementer appends **only** to §5's result tables and adds one closing section, "Execution report", recording anything the procedure could not follow and why. No ruling above is edited |
| `docs/design/security.md` | implementer, **scoped**: queue row #7 (§3.4), the class C and D cells plus the two paragraphs named in §5.4. **Nothing else.** No new mechanism class, no new queue item |
| `docs/HANDOFF.md` | implementer: the "Still owed" strike-through and pointers in phase 4 |
| `docs/design/webbotauth.md` | **untouched.** It is closed and §13 is its last section. If item 2 reads R2 or R3, §8.2's scope sentence is contradicted — that is **reported**, not edited, and the correction is owed as its own item |
| `bench/guards.mjs` | implementer: the **G33f leg only**, inside the existing G33 block. Nothing existing changes — not a claim, not a message, not an ordering |
| `bench/probes/webbotauth/headerorder.mjs` | implementer, new, fully. Standalone `node`, no dependency additions |
| `test/snapshot.test.ts` | implementer: **one new `describe`** (the C-i1 repair). No existing test edited |
| `test/urlsurfaces.test.ts` | implementer: the C-i2 repair (one new `it`) and the D-i1/D-i2 repairs **inside the existing `it`**. Assertions are only ever **widened**; no existing expectation is loosened, no regex narrowed |
| `src/**` | implementer: **sabotage rows only, every one reverted**, plus — under reading R4 only — one **comment** in `src/net/webRequestMux.ts`. No behaviour change anywhere in `src/` is authorised by this document |
| `package.json` / `package-lock.json` | **untouched.** An acceptance check, not a hope |
| everything else | untouched |

**Two sibling workstreams are speccing in this repository.** Nothing in this
partition overlaps `src/net/botAuth*.ts`, the bench cohort's stores, or any
port outside 8817/8902. If a file in this partition has moved under you, stop
and report rather than merging.

---

## 8. What could not be verified from here, and what still cannot be

Stated in the §12.7 tradition, because a list of what an unexecuted spec did not
measure is the honest half of it.

**Determined by reading the source only — no probe was run:** every claim in §2,
§3 and §4.2 about what the guards currently assert and what they cannot see;
the absence of any `browser_capture` refusal leg in `bench/guards.mjs`; the two
structural defects in `urlsurfaces.test.ts` (file-level enumeration, expression
shape); the fact that `test/botauth.test.ts` locates `installMux(s)` by literal
`indexOf` and refuses `/defaultSession/`.

**Determined by execution while writing this spec:** the 662/662 · 27-file
baseline (`npx vitest run` at `a9e39d8`); and the class-C alphabet sweep, run
against a **transcription** of `sanitize`/`stripFormat` rather than against the
shipped module — which is why PROBE-C0 re-runs it against the real import
before anything is concluded from it. That transcription showed the
single-codepoint form clean and the two-whitespace-run form **not** clean, which
is the whole reason §4.1 splits them.

**Not verifiable from here, and not by this spec either:**

- **Whether Chromium's behaviour on HTTP/2 or HTTP/3 matches leg B's.** The 8902
  probe is cleartext h1. The queue row must say so.
- **Whether the header order observed at 8902 is the order a *remote* server
  sees.** A loopback socket and a proxied WAN request traverse different
  Chromium paths, and nothing here distinguishes them.
- **Whether G33f's refusal check would survive a `browser_capture` rewrite** that
  keeps the refusal string and drops the condition. It matches the message
  because the message is the observable; a leg that matched the condition would
  be a source guard wearing a live guard's clothes.
- **Anything about the tree the sibling workstreams leave behind.** This spec is
  written against `a9e39d8` and every count in it is a count at `a9e39d8`.
- **Whether the four rows in §4 exhaust classes C and D.** They do not, and the
  criterion does not ask them to. It asks for *an* instance the author did not
  have in hand. Four is two more than the criterion requires and is still not a
  proof of width.

---

## 9. Execution report

Executed 2026-08-06 against `a9e39d8`. Baseline re-confirmed before anything
else: `npx tsc --noEmit` clean, `npx vitest run` **662 passed, 27 files** — the
preregistered baseline exactly.

### 9.1 The one addition to this spec: PROBE-C0 was REPAIRED, under authority

§4.1 files PROBE-C0 as a measured defect in shipped `src/` and rules that it is
"fixed by nobody under this spec", because no repair was authorised and landing
a guard that fails on a clean tree would leave the suite red. **The repair was
authorised by the coordinator before execution began**, and it was the
highest-priority item. This section records it, because it is the one place
where the executed programme is wider than the document above.

**The defect, re-measured against the SHIPPED module** (§4.1's transcription was
a scratchpad copy; the rule was to re-run it against the real import, and that
was done first): `sanitize` is not idempotent on walker output. `walker.ts`
collapsed whitespace **before** stripping the invisibles, so for any code point
`isStripped` removes that sits **between two whitespace characters**, the walk
emits a run of two spaces — behind the collapse, which has already gone past —
and `sanitize`'s own `\s{2,}` closes it up again at render time.

    walkNorm("my <U+202D> pass phrase")  ->  "my  pass phrase"   needle ABSENT
    sanitize("my  pass phrase")          ->  "my pass phrase"    the secret, whole

**69 code points** in the 0–0x2FFF sweep (71 raw, less `U+0022` and `U+005C`,
which `sanitize` escapes rather than deletes — injective and expanding, so they
cannot hide a needle). The single-code-point form was **0 offenders**, i.e. the
F-B fix holds on HEAD, which is the constraint the repair had to preserve.

**The repair chosen: strip BEFORE collapse, in one shared exported
`normalizeText`** in `src/core/snapshot/text.ts`, called by `walker.ts`'s three
normalising sites (`truncate`, `directText`, and the document title).

Its output is a **fixed point of `sanitize` by construction**: no stripped code
point survives, every whitespace run is a single plain space, and there is no
leading or trailing whitespace — so every clause of `sanitize` is a no-op on it.
That is the property the whole class-C argument rests on, restored by
construction rather than by review. It also makes `redact.ts`'s `canonicalNeedle`
true as written: that function collapses a needle's whitespace **on the stated
ground that "walker.ts collapses every run of whitespace to one space"**, and
before this change that sentence was false — the walker collapsed and then
re-introduced runs by deleting invisibles. The guard that pins it **imports**
`normalizeText` rather than transcribing it, so the walker's order cannot drift
out from under the assertion; flipping the order back re-reds it, which was
verified.

**Why the two other candidates lose.**

*Registering the collapsed form as an additional needle.* The number of variants
is unbounded, not large. Each stripped code point at a whitespace boundary adds
one space, so a needle with `k` internal spaces would need a needle for every
assignment of run lengths to those `k` positions, and a page may plant several
invisibles per gap. `engine.ts`'s `needleForms` already registers
`canonicalNeedle(v)` — but that canonicalises **downward**, to single spaces,
and the defect pushes the *text* upward, away from the needle, so the existing
mechanism cannot help. Worse, it treats the symptom on the redaction side and
leaves the walker emitting bytes that differ from what the renderer emits, so
every other consumer of walk output, present and future, keeps the hole. That is
fitting the instrument to the row — the exact failure §4's third clause exists to
detect.

*Making `sanitize` idempotent.* Measured, this **does not close the leak**.
Reordering `sanitize`'s internals to strip-then-collapse leaves `walkNorm` still
emitting `"my  pass phrase"`, the needle still absent at redaction time, and
`sanitize` still collapsing it to `"my pass phrase"` at render — an identical
outcome. The only variant that stops the reassembly is deleting the `\s{2,}`
collapse from `sanitize` altogether, and that (a) still does not restore
redactor/renderer byte agreement — the value remains in the model's copy with a
double space in the middle, which is not redaction and whose spacing the page
chooses; (b) unbounds the token cost `sanitize` exists to bound; and (c) changes
every rendered snapshot line, every error message and every `browser_read`
envelope in the product. A strictly larger behaviour change that fixes strictly
less.

**RED-first, both observations recorded.** The guard was landed first, spelled
against the *then-shipped* order, and observed **RED**: 69 offenders in the
whitespace sweep and `expected 'my  pass phrase' to contain 'my pass phrase'` on
the named instance — with the single-code-point F-B leg **GREEN in the same run**,
establishing the no-regression baseline. The repair then took it **GREEN**, and
the F-B leg stayed green. `npx vitest run` went 662 → **665**.

**Scope note against §7.** §7 says "no behaviour change anywhere in `src/` is
authorised by this document". The `normalizeText` repair is a behaviour change in
`src/core/snapshot/text.ts` and `src/core/snapshot/walker.ts`. It is the
coordinator's authorised addition and is the only such change; every other
`src/` edit in this programme was a sabotage row, and every one was reverted.
`package.json` and `package-lock.json` were untouched, as §7 requires.

### 9.2 What was not verifiable, and remains so

Beyond §8's list, which stands:

- **HTTP/2 and HTTP/3 header behaviour.** The 8902 probe is cleartext h1. Every
  reading in §5.2 is an h1 reading and the queue row says so.
- **Whether a *remote* server sees the order 8902 saw.** Loopback and a proxied
  WAN request traverse different Chromium paths; nothing here distinguishes them.
- **Leg A ran on `127.0.0.1` and leg B on `localhost`**, because B must be off
  the allowlist. They differ in the `Host` *value* and in no header **name**,
  order or casing — which is the whole comparison — but a perfectly matched pair
  would have wanted a second non-allowlisted binding for A.
- **The D-i2 repair resolves ONE level of BARE-IDENTIFIER indirection only.** A
  destination hidden behind a *member* call on another object — `t.somethingElse()`
  — is still invisible to it, and is covered only by the `.list(`/`.map(` ban on
  the call-site line itself. Following a method through a class in another file
  is a call-graph walk, which §4.2 rules out as a second parser. The guard fails
  closed on an unresolvable *identifier*, not on an unresolvable *expression*.
- **G33f matches the refusal MESSAGE, not the condition**, as §8 already warned.
  A `browser_capture` rewrite that keeps the string and drops the `agentOwned`
  test would still green it.
- **The four rows do not exhaust classes C and D**, and the criterion does not
  ask them to.

### 9.3 Harness notes for whoever runs this next

- The guard fixtures are served from **`test/fixtures`**, not `bench/fixtures`.
  The runbook in `docs/HANDOFF.md` names the bindings but not the directory, and
  the first run of this programme was lost to that: it failed at
  `cannot resolve "Alpha action"` with `0 refs tracked`, which is what a fixture
  server pointed at the wrong directory looks like.
- `bench/probes/webbotauth/headerorder.mjs` binds **8902**, which is also the G33
  verifier's port. The two cannot run at once.
- Every live verdict here carries its artifact SHA-256, and both reverts were
  confirmed by the hash returning **byte-identical** to the pre-row artifact —
  which is a stronger revert check than `git status`, and is the reason §1's rule
  2 exists.

