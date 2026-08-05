# Independent security gate, third pass — `3942ff8`

Reviewer: the same fourth agent. Did not write `security-review-2026-08.md`, did
not build any of the three fixes. F-A, F-B, F-C and F-E are mine. Scope: the
committed tree at `3942ff8`, working tree clean.

---

## VERDICT: **BLOCK** — on one finding, and it is the oldest one in the programme

F-C and F-E are dead. So is the two-hop chain, and so is everything else I could
reach through the credential path. The four fixes are good and two of them are
better than what I asked for.

Then I pointed the *first* attack in this whole sequence — sink 1, F9, "copy the
value into a `<div>` and have the agent read it" — at the **profile** path, and
it works. Completely, in the same tab, with no navigation, no carrier and no
invisible characters.

| # | | severity |
|---|---|---|
| **F-F** | **`browser_fill_form` registers no needles.** Three gates of machinery — origin-scoped needles, `carriedOrigins`, `redactUrl`, the walk-time alphabet — is wired to `vault_request_fill` only. A sensitive profile value (date of birth, national ID, tax ID, bank account, salary) copied anywhere by the page is delivered **verbatim**: same-tab snapshot, page title, link href, carrier tab, tab listing. Only `browser_read` is covered, and only by accident of a separate live-walk. The tool's own description says these values "are never returned to you". | **HIGH** |
| **F-G** | **`routeCapture`'s third page-influenced argument.** Sink 10 reconciled `title` and `sourceUrl` across the function's two call sites. `openUrls` — which *chooses the destination* — was not: `tools.ts` passes the active tab only and says in a comment that this is the defence; `ipc.ts` passes every tab. `test/urlsurfaces.test.ts` enumerates both call sites and asserts on two of the three arguments. | **LOW–MED** |

F-F blocks. F-G does not, but it belongs on the same fix list, and its real value
is as evidence for §5.

---

## 0. What was run

Repo unmodified except this file (`git status --porcelain` → one `??`). Probes,
drivers and a throwaway build copy live in the scratchpad.

| # | Run | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | clean |
| 2 | `npx vitest run` | **541 passed / 22 files** |
| 3 | `npx electron-vite build` | clean |
| 4 | `bench/guards.mjs --phase=allow`, fixtures on three loopback origins | **55/55 GREEN**, hash `9d4b1cf1…` in the header and the RESULT line |
| 5 | My F-C driver (`drive7`, 12 probes) and F-E driver (`drive9`) | **both dead** |
| 6 | New: the profile path, five surfaces | **F-F** |
| 7 | New: `carriedOrigins` over-redaction, measured on a live page | see §3 |
| 8 | New: `routeCapture`'s destination argument | **F-G** |

**One caution about my own harness, recorded because it produced a false RED.**
My fixture server served the scratchpad probe directory *ahead* of
`test/fixtures/`, and I had a file named `inert.html` there. The first guard run
came back `54/55 — RED G19k`, with the security half of the assertion passing
(`act result: false; snapshot: false; listing: false`) and the **non-vacuity**
half failing (`/INERTSINK/`). The guard was right and my harness was wrong: it
was reading my inert page, which lacks the marker. That is exactly what a
non-vacuity clause is for, and G19k earned its keep on a reviewer rather than on
the product. Precedence flipped, re-run: 55/55.

---

## 1. F-C and F-E are dead

**F-C**, unchanged driver, twelve probes:

```
ok  H1a  browser_tabs list — TITLE carrying a U+202D-split value
ok  H1b  browser_snapshot header after the encoded self-navigation
ok  H1c  browser_tabs list — URL carrying the percent-encoded split value   ← was LEAK*
ok  H1e  browser_navigate goto — `loaded …` + title line                    ← was LEAK*
ok  H2   the browser_act DIFF
ok  H4c  hop2 (foreign, opened BY hop1) — snapshot                          ← was LEAK
ok  H4d  hop2 — browser_read                                                ← was LEAK
```

**F-E**, unchanged driver, inert third party, fragment only:

```
ok click e6
page "An innocent page" http://127.0.0.3:8899/inert3.html#(filled,value-withheld)
   act result carries the password: false
   snapshot carries it: false
   listing carries it: false
```

The two-hop chain (F-D, which I filed as out-of-envelope and worth fixing anyway)
is closed as a side effect of seeding from the opener's whole scope. That was the
right call: it cost one line and removed a class rather than an instance.

`redactFreeText` losing its `marker` parameter is the strongest thing in this
commit. It converts "the caller picked the right marker and the wrong function"
from a reviewable mistake into a compile error. That shape — **delete the
argument that made the wrong call spellable** — generalises further than this
one function, and it is the first fix in the sequence that makes a class of
mistake impossible rather than guarded.

---

## 2. The fourteenth

### F-F — the profile path has none of this (HIGH)

`registerNeedles` has exactly one call site: `tools.ts:1165`, in
`vault_request_fill`. `browser_fill_form` calls `markTainted` and nothing else.
So for profile values:

- `redactObserved`'s **needle branch never runs** — it is gated on
  `needles.length` — which is the branch that covers every *copy* of a value.
- The **tainted branch** masks only the fields Aperture wrote into.
- `invalidate(documentReplaced = true)` still clears taint, so the seventh
  sink's shape (navigation as the off switch) is open here, unfixed.
- Needles are what `carriedOrigins`, `redactUrl` and the walk-time alphabet all
  operate on. With no needles, none of the last three gates' work applies.

**Measured**, `--seed-profile`, sensitive field `dateOfBirth = 1980-01-01`,
filled through `browser_fill_form action:"apply"`:

```
P0  the filled field itself                       clean   ← taint works
P1  SAME TAB, value copied into text/href/title    LEAK
      page "PROFILESINK 1980-01-01" http://127.0.0.1:8899/pf.html?run=…
      link e1 "Continue" /leak?dob=1980-01-01
P2  SAME TAB, browser_read                         clean   ← the live-walk path only
P3  CARRIER TAB, browser_snapshot no arguments      LEAK
      page "CARRIER 1980-01-01" …/carry.html?carried=1980-01-01
      link e1 "go 1980-01-01" /leak?pw=1980-01-01
        "cell" | "1980-01-01"
P4  the tab listing                                LEAK
      * t3 … "CARRIER 1980-01-01" http://127.0.0.1:8899/carry.html?carried=1980-01-01
```

P1 is **sink 1**. The `href` on that line is the `c375415` finding. The header
line is F1. P3 is F-A. P4 is F2. Every one of them, re-opened, against the class
of data the product treats as *more* sensitive than a password — it refuses to
show these values in a plan at all, printing `(from profile — value not shown)`.

**This is a known-open item and it is no longer correctly deferred.** It has been
carried as "profile values still get no needles" since the 2026-08 review, when
it read as a gap in a young mechanism. It now reads differently, because two
sentences shipped in this tree are false as written:

- `tools.ts:1717` — *"Sensitive fields (date of birth, national ID, salary) show
  as 'from profile' and **their values are never returned to you** — the browser
  inserts them directly."* Measured: they are returned, on four surfaces, to any
  agent that snapshots the page after the fill.
- `security.md:66` — *"Copy value into a `<div>` and have the agent read it →
  Redaction while the fill is tainted — **implemented and measured** (G19)."*
  Implemented and measured for credentials. Not implemented for the profile
  path, and no guard covers it.

The fix is one line beside `markTainted`, using the `pageOrigin` the handler
already computes, filtered to the sensitive fields. The over-redaction trade is
the one this module already takes everywhere; `MIN_NEEDLE_LENGTH` already
excludes the short values. What it must not be is another round of instance
fixes: the guard to add is one that asserts **the profile path and the credential
path have the same coverage**, so this cannot be a per-path decision again.

### F-G — the third argument (LOW–MED, non-blocking)

Sink 10's lesson was "`routeCapture` has two call sites and one was hardened".
The reconciliation covered `title` and `sourceUrl`. It did not cover `openUrls`,
which is the argument that picks **where the screenshot goes**:

```ts
// src/mcp/tools.ts  — agent path
openUrls: [t.info(t.active ?? '')?.url ?? ''],
// "Destination comes from the active tab only, so opening a Notion tab
//  cannot redirect captures to an attacker-named page."

// src/main/ipc.ts:71 — human toolbar path
openUrls: t.list().map((tab) => tab.url),
```

`routeCapture` takes the **first** tab whose URL yields a Notion page id and
appends there. So on the human path the destination is chosen by whichever tab
got there first, and a page can create a tab: measured, a page's
`window.open('https://www.notion.so/<id>')` produced tab `t5` and it appears in
`t.list()`. `pageIdFromUrl` accepts that URL — I ran it against the shipped
function: `https://www.notion.so/deadbeef…` → `deadbeef-dead-beef-dead-…`;
`https://attacker.notion.site/…` → `null` (the host anchor is tighter than I
assumed); a non-Notion host → `null`.

**Bounded, and I am not overstating it.** The upload uses the human's own Notion
token, so the attacker's page must already be writable by that integration — in
practice a page inside the user's own workspace, not an arbitrary attacker's.
And the notion.so URL redirects to `app.notion.com`, so the window in which
`t.list()` still shows a matching URL is a load-time race. The realistic impact
is a screenshot **misfiled within the user's workspace at a page of the page's
choosing**, not exfiltration to a third party.

The reason it is in this document at all is §5: the guard written this round to
stop exactly this recurrence enumerates both call sites of `routeCapture` and
asserts on two of its three page-influenced arguments.

### Hunted, not found

| candidate | result |
|---|---|
| every F-C surface, every F-E surface, the two-hop chain | clean (§1) |
| `browser_act` diff after name/value/text/href/rows all change | clean |
| `wc.getTitle()` with a split value on the listing and `loaded …` | clean — the both-sides scrub does the work |
| downloads | **no `will-download` handler anywhere in `src/`**, so Electron's default save prompt applies. Human-gated; noted, not a finding. |
| `will-navigate` (a page navigating itself) | still `file://`-only, but Chromium resolves the target and there is no `normalizeUrl` search fallback on that path, so the eleventh sink's shape does not reach it |
| `browser_attach` paths | library ids only; unchanged |
| `capture` `location` / `fellBackBecause` | now scrubbed; `location` cannot carry page bytes |

---

## 3. `carriedOrigins` growth — right on size, and the cost is not cosmetic

**Unbounded is the right choice, and the builder's arithmetic is right.** One
short string per distinct origin; an origin with no live needles contributes
nothing to `needlesFor` beyond a map lookup; and any cap would have to evict,
at which point the mechanism can silently lose the one origin that mattered.
Losing coverage costs a credential; keeping a stale string costs bytes. Accept.

**But the over-redaction it carries is not cosmetic, and that is measurable.** I
filled a one-time code — the *shortest* thing the store accepts, six characters —
and then walked the same tab to an unrelated origin whose legitimate content
contained that string:

```
--- the unrelated page, as the agent now reads it ---
page "Order (filled, value withheld)" http://127.0.0.2:8899/numbers.html#(filled,value-withheld)
table e19 4x2
  "Order"   | "Total"
  "ORDER-A" | "100200"
  "ORDER-B" | "(filled, value withheld)"
  "ORDER-C" | "998877"

--- the SAME page in a tab that never visited the filled origin ---
  "ORDER-B" | "377350"
```

Three things follow, and only the first is the one usually meant by
"over-redaction":

1. **It is precise, not blanket** — the neighbouring order numbers survive.
2. **The same URL now reads differently in two tabs**, and the difference is the
   tab's history. Nothing in the output says so. An agent comparing two tabs, or
   re-reading after a tab switch, sees a page that changed when it did not.
3. **The marker asserts something false.** `(filled, value withheld)` does not
   say "redacted"; it says *Aperture filled this value into this page*. On the
   filled origin that is true. On a carried origin it can be false, and here it
   is: the agent is told a credential sits in ORDER-B's cell. That is worse than
   a missing value, because it is a claim the agent may act on.

`carriedOrigins` did not create this — a needle could always over-match — but it
is what makes the blast radius follow the tab across origins and grow
monotonically for the TTL. Two cheap mitigations, neither requiring eviction:

- **Do not register short all-digit values as needles, or give them the OTP's own
  lifetime.** A six-digit code is single-use, replay-blocked (`lastIssued`), and
  live for ~30 seconds; the needle costs ten minutes of false positives across
  every origin the tab later visits. The trade is bad in the one case where
  collisions are plausible at all.
- **Prune a carried origin when its needle set is gone.** No behaviour change —
  such an origin already contributes nothing — but it bounds the set to origins
  that currently matter and makes the growth argument true rather than merely
  affordable.

Neither is blocking. The third point above is worth one sentence in
`security.md`: the marker is a provenance claim, and off the filled origin it is
not guaranteed.

---

## 4. The window.open finding's class — **"exfiltration" is right, and it generalises**

The builder classifies it as exfiltration rather than disclosure. That is
correct and the distinction is load-bearing: every other finding in this
sequence moves a value from one place inside the browser to another place inside
the browser, and the mitigation is a scrub. This one made **Aperture originate a
network request containing page-chosen bytes to a host the page never named.**
No scrub applies to it; the only fix is not to do it. Different property,
different repair, and it belongs under a different heading in `security.md` than
the redaction table.

The sharpest part of the builder's argument is the one worth keeping: the
adversary the needles exist for is injected script on an *otherwise-honest*
origin, and such an origin's own CSP (`connect-src 'self'`) can forbid that
script's `fetch()` and forbade nothing here. Aperture was a CSP bypass. That is
the correct framing and it is stronger than "a page could search for something".

**Yes, it implies an audit, and the audit is small and enumerable** — which is
itself the most encouraging fact in this document. The class is *"an affordance
where a page-supplied string causes Aperture to act outside the page"*, and the
complete list is:

| affordance | page-supplied? | status |
|---|---|---|
| `setWindowOpenHandler` → `normalizeUrl` | yes | **fixed** (scheme check) |
| `will-navigate` on a tab | yes | Chromium-resolved, no search fallback; `file://` denied. OK |
| `shell.openExternal` (chrome renderer) | no — needs E1 first | known-open, unchanged |
| downloads | yes | **no handler at all**; Electron's save prompt is the gate. Audit it. |
| `routeCapture` destination (`openUrls`) | **yes** | **F-G**, above |
| `browser_attach` file paths | no — library ids | OK |
| container id / name | no — agent | OK |
| `browser_capture` destination (agent path) | no — active tab only | OK by construction, and it says so |

Two entries need work (downloads, F-G) and both are bounded. This is the first
class in the programme that can be **enumerated to exhaustion** rather than
probed, and it should be — as a list in `security.md`, with each row ruled.

---

## 5. The stopping question

**Not converged. But close enough to stop *probing* after one more targeted
round, and the stopping criterion should change from "no more findings" to
something measurable.** The evidence, both directions.

### Against convergence

**Preconditions are not getting more contrived — they got *less* so.** The
strongest counterexample is F-C: it needed no adversary at all. Any ordinary
password containing a space or a `#` defeated the plain scrub on three surfaces.
The eleventh sink needed no credential in the vault. F-F needs one click. If this
were converging, the newest findings would be the most elaborate; two of the last
four are the least elaborate in the whole sequence.

**The class boundary is still moving.** Round 3 produced the first finding that
is not about agent context at all. Round 4 (this one) produced the first finding
about a *data class* rather than a surface. Each time the boundary moved, it
moved because someone asked a question the previous rounds' framing could not
express — which is the signature of an audit whose scope is still being
discovered, not one being exhausted.

**Every round has found ≥2.** Read 0 → probe 4 → fix 5 → gate 7 → fix 9 →
gate 11 → fix 13 → gate 15. The slope has not bent.

### For convergence

**The mechanism count is small, and it is not growing the way the instance count
is.** Sorting all fifteen by *why* rather than by *where*:

| mechanism | instances | structural guard today |
|---|---|---|
| A. enumeration — a sink nobody listed | 1, href, title/url, tabs list, sel.tag, select labels, obstructor, navigate url, r.tag | `completeness.test.ts` canary measurement; `urlsurfaces.test.ts` call-site scan |
| B. scope — the redactor's reach does not follow the value | F-A, seventh sink, F-E, F-D | `carriedOrigins` + G19d/f/i/k/m |
| C. alphabet — redactor and renderer read different bytes | F-B, F-C | walk-time `stripFormat`, `scrubUrlish`, `canonicalNeedle`, `urlsurfaces` alphabet tests |
| D. parity — one function, two call sites, divergent treatment | sink 10, **F-G** | `urlsurfaces.test.ts` (partial — see F-G) |
| E. egress — Aperture acts on a page-supplied string | eleventh | none; enumerable (§4) |
| F. coverage — a data class the machinery was never wired to | **F-F** | none |

Four mechanisms, four gates. Instances are not evidence of an unbounded surface;
mechanisms are, and only two new ones appeared in the last two rounds — one of
which (E) is enumerable to exhaustion and one of which (F) has exactly one member
that I have named.

**The guards are now catching what probing used to.** S5 is the important
measurement in this commit and the builder is right to keep it: reverting the
opener fix left 54/54 green, which proves the guard set had a blind spot, and
G19m now covers it. That is the transition worth having — from "the reviewer
finds it" to "the suite finds it".

### The honest answer

The remaining residual class is nameable, and here it is:

- **R1 — coverage (F-F).** One member, known, one line. After it, assert
  path-parity in the suite so a third fill path cannot be added uncovered.
- **R2 — egress (§4).** Two open entries, both bounded, both enumerable.
- **R3 — parity (F-G).** One member; the guard exists and needs its third
  argument.
- **R4 — over-redaction correctness (§3).** Not a leak; a truthfulness problem in
  the marker. Bounded by TTL.
- **R5 — transformations the *page* performs** (base64, reversal, one character
  per element). Genuinely unclosable by substring matching, correctly documented,
  and unchanged since the first review.

**So: one more round, targeted, then stop probing.** It should target R1, R2 and
R3 — all three are enumerable rather than exploratory — and it should not be
another open-ended hunt, because the last two hunts found things by *reading the
fix's own sentences*, not by exploring. That technique has now been used four
times (twice by me, twice by the builder) and it is not a search strategy; it is
a proof that the fixes keep being narrower than the sentences justifying them.
It will keep working until the sentences and the wiring are generated from the
same place.

**And change the stopping criterion.** "No more findings" is unfalsifiable and
has been wrong four times. The criterion that can actually be met: *every
mechanism in the table above has a guard that fails when that mechanism
regresses, and each guard has been shown to fail by sabotage.* Three of six do
today (A, B, C — with sabotage records). D is partial. E and F have none. Get to
six of six with a sabotage row each, and the next reviewer's job becomes
verifying six guards rather than inventing a fifteenth attack — which is a job
that terminates.

---

## 6. Known-open — unchanged

`forget(tabId)` still has no caller; E1/E2 shell navigation and `openExternal`
unchanged; `agent:activity` still never sent; the three pre-redaction bench logs
still present; `.gitignore`'s `*.vault` still matches nothing (`git check-ignore
vault.aperture` → not ignored). All still correctly deferred. **`profile values
get no needles` leaves this list and becomes F-F.**

---

## 7. Blocking fix list — minimal

**D1. `registerNeedles` on the profile path.** One call beside `markTainted` in
`browser_fill_form`, against `pageOrigin`, for the sensitive values.
*Guard:* a leg that fills a profile, echoes the value into text, an `href` and
the title, opens a carrier tab, and asserts on the snapshot, the read and the
listing — i.e. G19/G19b/G19d re-pointed at the profile path.
*Structural:* a test that asserts both fill paths reach `registerNeedles`, so a
third one cannot ship uncovered. That is the fix; D1's one line is the instance.

**D2. Correct the two false sentences.** `tools.ts:1717`'s "never returned to
you" and `security.md:66`'s unqualified "implemented and measured" — both must
say which path they are true of, or become true of both (D1 makes them true).

### Recommended, same pass, not blocking

- **F-G:** make `openUrls` the active tab on both `routeCapture` call sites, and
  extend `urlsurfaces.test.ts` to assert on all three page-influenced arguments
  rather than two.
- **Audit downloads** and add the egress table from §4 to `security.md` — the
  first class here that can be closed by enumeration.
- **Short all-digit needles**: exclude them, or give them the OTP's lifetime (§3).
- **Prune carried origins whose needles are gone** — no behaviour change, makes
  the unboundedness argument true rather than merely affordable.
- **One sentence in `security.md`** that the marker is a provenance claim and is
  only guaranteed on the filled origin.

---

## 8. The plain answer

**Yes — and this time it is not a clever construction, it is the first attack in
the sequence pointed at the other fill path.**

```js
// after browser_fill_form has filled a date of birth / national ID / tax ID
document.title = 'x ' + dobField.value;
someLink.href = '/leak?dob=' + dobField.value;
```

The next `browser_snapshot` returns both, verbatim, and so does the tab listing,
and so does a carrier tab. Nothing about the last three gates applies, because
all of it hangs off a needle store that the profile path never writes to.

Everything reachable through the **credential** path is closed as far as I can
construct: the carrier, the invisible character, the navigation off-switch, the
percent-encoded URL, the fragment hop, the two-hop relay. The boundaries below
containment still hold and I re-checked them — no agent-facing response type can
carry a secret, origin binding is decided before the page is consulted, consent
is a native dialog with no agent-reachable parameter, and `src/preload/page.ts`
exposes nothing to page script.

The programme is close to done and the thing that will finish it is not another
hunt. It is wiring the profile path into the machinery, enumerating the egress
class, and getting a sabotage-verified guard onto each of the six mechanisms in
§5 — at which point the question "is it safe" stops being answered by whether the
last reviewer ran out of ideas.
