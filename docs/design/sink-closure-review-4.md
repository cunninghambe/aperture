# Independent security gate, fourth pass — `9f2b8b2`

Reviewer: the same fourth agent. F-A, F-B, F-C, F-E, F-F and F-G are mine; so is
the six-class table and the terminating criterion this commit claims to meet.
Scope: the committed tree at `9f2b8b2`, working tree clean.

---

## VERDICT: **BLOCK**, narrowly — the criterion is not met, and I under-specified it

The findings are closed. F-F and F-G are dead, measured. The battery holds: tsc
clean, **561 tests**, build clean, **guards 63/63** with the artifact hash in the
RESULT line. Row A still goes RED. Both sabotage rows I re-applied from the
builder's own table go RED for the reasons the table claims.

Then I wrote *my own* sabotage row for the two classes I was told to distrust —
a different instance of the same class, not the one the guard was written from —
and both went **GREEN**.

| | builder's row | my row (same class, different instance) |
|---|---|---|
| **Row F (coverage)** | drop `registerNeedles` → **RED**, names `browser_fill_form` | a third fill path through a module-scope helper → **561/561 GREEN** |
| **Row E (egress)** | delete `will-download` → **RED** both ways | a new affordance on `clipboard.writeText` + `shell.openPath` → **561/561 GREEN** |

Both guards catch the regression they were written from and miss the next member
of their own class. That is the recurrence pattern this entire programme has been
about — *a helper written for a sentence, wired to only some of the places the
sentence applies* — now reproduced in the guards instead of the code.

And the criterion is mine, so the under-specification is mine: I wrote *"every
mechanism has a guard that fails when that mechanism regresses, and each guard
has been shown to fail by sabotage."* Those two clauses are not equivalent, and
the commit satisfies the second while failing the first. The missing clause is
below (§5).

Two smaller items, neither blocking, both needing a sentence changed: the
all-digit residual leaks in the **snapshot** and the tool description is again
wider than the truth (§4); and `dropNeedles`'s cross-fill residual is correctly
disclosed but for a wrong reason (§5b).

---

## 0. What was run

Repo unmodified except this file. All sabotage in a throwaway copy at `9f2b8b2`
with `node_modules` junctioned; probes and drivers in the scratchpad.

| # | Run | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | clean |
| 2 | `npx vitest run` | **561 passed / 24 files** |
| 3 | `npx electron-vite build` | clean |
| 4 | `bench/guards.mjs --phase=allow`, three loopback origins, `--seed-profile` | **63/63 GREEN**, hash `4b2869a3…` |
| 5 | F-F re-run (four surfaces) | **dead** |
| 6 | F-G verification (source) | **closed** |
| 7 | Row A sabotage (case B) | **RED**, right reason |
| 8 | Row F sabotage ×2 (builder's, mine) | **RED** / **GREEN** |
| 9 | Row E sabotage ×2 (builder's, mine) | **RED** / **GREEN** |
| 10 | The all-digit residual, measured live | **leaks in the snapshot** |

---

## 1. The findings are closed

**F-F.** Profile fill, `--seed-profile`, sensitive `dateOfBirth`:

```
P1  SAME TAB, copied into text + href + title   clean
P2  SAME TAB, browser_read                      clean
P3  CARRIER TAB, snapshot with no arguments     clean
      page "CARRIER (withheld: matches a filled value)" …?carried=(withheld:matches-a-filled-value)
      link e1 "go (withheld: matches a filled value)" /leak?pw=(withheld:…)
        "cell" | "(withheld: matches a filled value)"
P4  the tab listing                             clean
```

G30a–e cover the same five shapes live and all pass. **F-G** is closed at both
call sites, and `urlsurfaces.test.ts` now asserts the one-element literal *and*
the absence of a tab-list derivation, which is the stronger of the two forms.

**The marker rewording is the best small change in this commit.** `(withheld:
matches a filled value)` is a claim about a match rather than about a location,
which is exactly the defect I measured last round — the old marker asserted
provenance and asserted it falsely on a carried origin. It is also a general
lesson worth keeping: *a redaction marker is a sentence the agent may act on, so
it must be true of every place it can appear*, not only of the place it was
designed for.

---

## 2. Row F (coverage) — the guard enumerates the wrong unit

`fillpaths.test.ts` rests on one claim, stated in its own comment: *"`requestFill`
is the ONE funnel from main into the preload's write pass — there is no second
way to put a value in a field. So enumerating its call sites enumerates the fill
paths."*

**The claim is true. The implementation does not enumerate call sites of
`requestFill` — it enumerates `server.registerTool(` blocks whose text happens to
contain `requestFill(`.** Those are different sets, and `toolBlocks` drops
`parts[0]`, so everything above the first `registerTool` is invisible.

I built a genuinely new third fill path in that gap — not a copy of either
existing one:

```ts
/** a third fill funnel, wired through a module-scope helper */
async function quickFillHelper(wc, tabId, origin, targets) {
  markTainted(tabId, targets.map((t) => t.key));
  // no registerNeedles — the F-F shape, one refactor away
  const res = await requestFill(wc, { expectedOrigin: origin, atomic: false, targets });
  return res.ok;
}
```

declared above the first `registerTool`, called from a new `browser_quickfill`
tool whose own handler never names `requestFill`. Result: **tsc clean, 561/561
green**, `fillpaths.test.ts` included. Both of its assertions pass vacuously —
the frozen writer list still reads `['browser_fill_form','vault_request_fill']`
because the new tool's block does not contain `requestFill(`, and the parity loop
iterates that same empty-of-the-new-path set.

The file-level assertion *did* hold: a new **file** calling `requestFill` fails.
The hole is entirely within `tools.ts`, which is where a third fill path would
most naturally be written.

**Fix, and it is smaller than the current test.** Enumerate the thing the claim is
about. Count `requestFill(` occurrences across `src/` and freeze the number
(currently two); for each occurrence, require `registerNeedles(` and
`markTainted(` in the enclosing function rather than in the enclosing
`registerTool` block. My sabotage adds a third occurrence and fails on the count
alone, before any structural parsing.

---

## 3. Row E (egress) — "enumerated to exhaustion" enumerates eleven regexes

`egress.test.ts` is the best-argued file in this commit and its two-directional
check (new affordance / stale ruling) is genuinely strong — the builder's own
sabotage row proves both halves fire. Its docblock's central claim is that the
class *can* be enumerated to exhaustion because *"the set of ways a browser
reaches outside a page is small, fixed, and named by the platform."*

**That is true of the platform and not of the test.** `PRIMITIVES` is eleven
hand-written regexes, and one of them is `/shell\.openExternal\(/` — the single
function name, not the `shell` module. So `shell.openPath`,
`shell.moveItemToTrash`, `shell.writeShortcutLink`, `shell.showItemInFolder`,
`clipboard.writeText`, `webContents.print`/`printToPDF`, `session.setProxy` and
`https.request` are all outside the enumeration.

I added a new affordance acting on page-supplied strings through two of them:

```ts
clipboard.writeText(info?.title ?? '');   // page-written
void shell.openPath(info?.url ?? '');     // page-written
```

in a new `browser_share` tool. Result: **561/561 green.** No ruling required, no
row added, nothing named. This is the eleventh sink's own shape — Aperture acting
outside the page on bytes the page chose — shipped past the guard built for it.

**Fix, in the idiom `completeness.test.ts` already established for its class:
replace the list with a measurement of the API surface actually in use.** Every
egress primitive here arrives through `import { … } from 'electron'`. Freeze that
symbol set across `src/` and require a ruling for each symbol; a new import —
`clipboard`, `net`, `protocol`, `powerMonitor`, or `shell` reaching a second
function — then fails by name. Keep the eleven per-primitive rows on top; they
are good and they carry the argument. That is the same move that turned "which
fields are rendered" from a seven-name list into a canary measurement, and it is
available here where the builder's docblock says it is not.

**On the coordinator's specific question — is a source test plus unit tests
sufficient for a class with no live guard?** For the *download* row, yes, and I
checked the part that would have made it not: the handler calls
`item.setSaveDialogOptions({ defaultPath })` and **not** `setSavePath`, so the
native save dialog is still raised and the transfer is still human-gated. Had it
set a save path, a page could write files silently and no test in this repo would
have noticed. `safeDownloadName`'s unit tests are thorough and include the
non-vacuity case ("leaves an ordinary name exactly as it was") and the
truncate-from-the-front reasoning, which is a spoofing defence most codebases get
backwards. The class's weakness is not the absence of a live guard. It is the
enumeration above.

---

## 4. Row A, and the deliberate all-digit residual

**Row A still goes RED**, for the right reason. Case B re-applied — a new
`SnapshotNode.placeholder`, rendered verbatim by `renderLine`, ruled
`sink: 'not-page-text'` with a plausible sentence:

```
× which fields are RENDERED is measured, not listed
  > plants a canary in every string-bearing field of both types
  → expected [ 'SnapshotNode.placeholder' ] to deeply equal []
```

**The all-digit residual is real and it is wider than "a copy is unscrubbed".**
Measured live, with the one-time code standing in for the shape — filled, then
the page copies it into a div and a link:

```
O1  snapshot   link e1 "Continue to checkout" /leak?pw=&c=108140   ← the filled code, in clear
O2  browser_read                                                    clean
```

`browser_read` is clean only because it takes a live `taintedValues` walk. The
href is not innerText, so `browser_read` cannot see it at all — which is the
G19b argument from the first review, reopened for this value class. `G26a-blind`
asserts the code is absent from `browser_read` and nothing asserts it is absent
from a snapshot, so the residual is unguarded in the direction it actually
leaks.

**Ruling: the direction is right and the instrument is wrong.** The problem R4
identified was *collision with unrelated content*, and I measured it on a
**carried** origin — a tab that had merely passed through the filled origin
rewrote an order number on an unrelated site. Excluding by **shape** (all-digit,
under nine) pays for that with coverage everywhere, including on the filled
origin where a short numeric value never collides with anything the redactor
should care about. And the shape rule does not only catch one-time codes: a
6–8 digit `nationalId`, `bankAccount`, `taxId` or a `salaryExpectation` of
`120000` are all sensitive by the product's own ruling, all long-lived, and all
now unneedled.

The instrument that matches the problem is **scope, not shape**: register short
all-digit values, and exclude them from the *carried*-origin expansion in
`needlesFor` — match them only on the origin they were filled into. That closes
O1, keeps the false positive I measured from firing, and needs no new concept.

**And one sentence is again wider than the truth.** `browser_fill_form` now
says sensitive values *"once inserted … read as `(withheld: matches a filled
value)` in snapshots and page text."* True of the field. False of a copy, for
any sensitive value that is six-to-eight digits. This is the third round in
which a corrected sentence has been corrected to a new sentence that is still
slightly too wide, and the pattern is worth naming: **the sentence describes the
mechanism's intent; the qualifier lives in a predicate two files away.**

---

## 5. The criterion, audited

### 5a. What is wrong with it

I set: *every mechanism has a guard that fails when that mechanism regresses,
and each guard has been shown to fail by sabotage.* The commit meets the second
clause honestly — six rows, each recorded, and the three I re-applied behave as
claimed. It does not meet the first, and §2 and §3 are the proof: a guard that
fails on the instance it was written from has not been shown to fail *when the
mechanism regresses*.

The missing clause, and it is the whole difference:

> **The sabotage row must be an instance of the class that the guard's author did
> not have in hand when writing it** — a different member, not the finding that
> prompted it. Equivalently: someone other than the guard's author picks the row.

That is cheap to satisfy and it is exactly what this gate did. Two of six guards
failed it. Rows A, B and C would, I think, survive the same treatment — A is a
measurement rather than a list, B was verified across five live legs including
one I constructed, C is enforced by a helper whose wrong call no longer compiles
— but I have only demonstrated it for A.

### 5b. `dropNeedles` on the profile path — acceptable, wrong reason

Reachable, and more easily than the comment suggests: `overwrite: true` plus an
`origin-changed` refusal (the G20 shape) drops a needle registered by an earlier
**successful** fill of the same value. The field stays masked by taint; what is
lost is coverage of every copy the page already made.

**Ruling: acceptable to ship, and the disclosure is exemplary** — it names the
preconditions, the mitigation and what is lost. But its justification is wrong:
*"keeping needles for a fill that provably wrote nothing is the over-redaction R4
is about."* It is not. R4 is a needle matching *unrelated* content on *another*
origin. A needle for a value an earlier fill genuinely did write into this origin
is exactly-correct redaction, and keeping it costs nothing R4 cares about. The
real trade is value-keyed dropping versus refcounting, and the exact fix is
three lines: have `registerNeedles` return the subset it actually *added*, and
drop only that. Then a second fill of the same value adds nothing and drops
nothing, and the residual disappears with no over-redaction anywhere.

---

## 6. Is the programme done? — **no, and there is a seventh class**

Close. Everything I can construct through both fill paths is covered, four
mechanism classes have guards I would trust a stranger to run, and the criterion
— once repaired with §5a's clause — is a terminating one.

But the coordinator asked for the one thing that should reopen this, and it
exists.

### The seventh mechanism: **LIFETIME**

*When* the redactor holds a value, as distinct from **where** it looks (scope)
and **what bytes** it compares (alphabet).

Sort the existing findings by that question and a class falls out that the six do
not span:

- **The seventh sink** — `invalidate(documentReplaced)` called `clearNeedles`, so
  the navigation that delivered the value was the one that disarmed the
  redactor. Filed under *scope*; it is not a scope bug. The scope was right and
  the value was forgotten at the wrong moment.
- **`dropNeedles`'s cross-fill residual** (§5b) — a refusal on attempt two
  un-protects attempt one. Neither scope nor alphabet nor coverage.
- **The TTL boundary** — ten minutes, after which every copy the page made goes
  clear, with no event and no guard. Disclosed, never measured.
- **`unmarkTainted`'s asymmetry** — taint comes off on a global refusal and stays
  on every uncertain outcome. Correct, and reasoned about nowhere near the other
  three.

Coverage today is one assertion inside another class's guard (`fillpaths.test.ts`
requires registration *before* the write — a lifetime property in a coverage
file) and one live leg (G19h, navigation survival). That is one member of the
class guarded, out of four.

**This is the finding that should reopen the programme, and it should be the last
one.** The next round should not hunt: it should take the four members above,
write the lifetime invariant as one sentence — *a needle exists from before the
write until the value can no longer be in the page or in anything the page
derived from it* — and build one guard that fails when any of the four breaks it.
Then rows A–G are seven of seven under the repaired criterion, and the question
"is it safe" stops depending on whether a reviewer ran out of ideas.

---

## 7. Blocking fix list

**E1. `fillpaths.test.ts`: enumerate `requestFill(` occurrences, not
`registerTool` blocks.** Freeze the count across `src/`; require both arming
calls in the enclosing function. §2's sabotage must go red.

**E2. `egress.test.ts`: measure the Electron symbol surface.** Freeze the set of
symbols imported from `electron` across `src/` and require a ruling for each,
keeping the eleven primitive rows on top. §3's sabotage must go red.

**E3. Correct `browser_fill_form`'s description** so the copy-coverage claim
carries the all-digit qualifier — or, better, remove the need for the qualifier
by making the short-numeric exclusion scope-based rather than shape-based (§4).

### Recommended, not blocking

- `registerNeedles` returns what it added; `dropNeedles` takes that (§5b).
- Add §5a's clause to the criterion in `security.md`, and record which guards
  have been sabotaged by someone other than their author. Today: A, B, and the
  two I broke.
- Name the **lifetime** class in `security.md` with its four members, even before
  it has a guard. An unguarded class that is named is a different thing from one
  that is not.

---

## 8. The closing answer, and what must not be undone

**Can a page-authored secret still reach the agent by any path I can construct?**
For a credential or a non-numeric sensitive profile value: **no.** I have run
every construction from four gates against this build and they are all dead.

For a **six-to-eight-digit** sensitive value — a one-time code, a short national
ID or account number, a salary — **yes**, in one line, measured: the page copies
it into a link target and the next snapshot carries it in clear. That is
deliberate, disclosed, and narrower than anything previously found; it is a
residual to reshape rather than a hole to plug.

**What a future session must not undo.** These are the load-bearing pieces, and
each one exists because a specific measured leak came through it:

1. **Needles survive navigation.** `invalidate` must not clear them again. The
   navigation is how the value arrives somewhere the agent reads.
2. **Needles are keyed by origin, and a tab's scope includes what it carries** —
   its opener's whole scope and every origin it has left. Coverage follows the
   value, not the tab's location.
3. **The strip happens at walk time.** `walker.ts` must hand the redactor the
   same bytes `quote()` will emit. Move it back downstream and one invisible
   character reopens everything.
4. **One `redactUrl`, and `redactFreeText` has no marker parameter.** Restoring
   that parameter makes "right marker, wrong scrub" spellable again.
5. **Both fill paths arm needles before the write** — and a third one must too.
6. **`needlesFor` and `scrubbablesFor` are not exported.** The store returns
   scrubbed text and a boolean; never a value.
7. **The marker is a claim about a match, not about a location.** It appears on
   origins the value was never filled into, and it must stay true there.

The programme is one class from done. It is not done because the criterion I
wrote had a hole in it, and the two newest guards fell through exactly that hole
— which is, one level up, the same finding as every other round: the fix was
narrower than the sentence justifying it.
