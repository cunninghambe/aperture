# Independent security gate, second pass — `43440a1`

Reviewer: the same fourth agent. Did not write `security-review-2026-08.md`, did
not build either fix. The two constructions this commit exists to close (F-A,
F-B) are mine, from `docs/design/sink-closure-review.md`. Scope: the committed
tree at `43440a1`, working tree clean.

---

## VERDICT: **BLOCK**

The four fixes are real and my two constructions are dead. The seventh sink was a
good catch and the right repair. But the hunt found two more, and one of them is
the same shape as the finding this commit is named after — a page moving the
value somewhere the needle scope does not reach, with one line of script and
nothing leaving the machine.

| # | | severity |
|---|---|---|
| **F-C** | **`scrubUrlish` is called on two of the five agent-facing URL surfaces.** `browser_tabs list`, `browser_navigate`'s `loaded …` line and `browser_capture`'s `sourceUrl` use the plain scrub. Measured: the tab listing returns `?pw=guard-pw%E2%80%AD-93a1`. The wider class needs no trick at all — **any password containing a character the URL parser encodes** (a space, `#`, `&`, `%`, `+`, anything non-ASCII) leaks on those three. `scrubUrlish`'s own docblock states this exact case. | **HIGH** |
| **F-E** | **A cross-origin self-navigation with the value in the FRAGMENT.** One `location.href` assignment to an **inert** third party — no script, no fragment read, and the target's server never receives a fragment. Measured verbatim in the `browser_act` result, in `browser_snapshot` with no arguments, and in `browser_tabs list`. This is the residual the builder filed as unclosable "because that navigation hands the value to the target's server anyway". **It does not.** | **HIGH** |

Everything else holds, including several things I expected to break.

---

## 0. What was run

Repo not modified except this file: `git status --porcelain` shows one `??`.
Probes, drivers and the throwaway build copy live in the scratchpad.

| # | Run | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | clean |
| 2 | `npx vitest run` | **530 passed / 21 files** |
| 3 | `npx electron-vite build` | clean |
| 4 | `bench/guards.mjs --phase=allow`, fixtures on `127.0.0.1`, `127.0.0.2` **and** `127.0.0.3:8899` | **50/50 GREEN**, G19/b/c/d/e/f/g/h/i all PASS |
| 5 | My F-A and F-B drivers, unchanged, re-pointed at this build | **both dead** |
| 6 | Four new drivers, twelve probes, three loopback origins | **F-C and F-E found** |
| 7 | Case B (a new rendered page-controlled field, mis-ruled) re-applied in a throwaway copy | **now RED** |

---

## 1. The two constructions are dead

**F-A — the carrier tab.** Unchanged driver: fill on `127.0.0.1`, page runs
`window.open('/carry.html#' + password)`, agent calls `browser_snapshot` with no
arguments.

```
page "CARRIER (filled, value withheld)" http://127.0.0.1:8899/carry.html?carried=(filled,value-withheld)
link e1 "go (filled, value withheld)" /leak?pw=(filled,value-withheld)
  "cell" | "(filled, value withheld)"
```

`browser_read` with no arguments: same. Origin keying does what it says.

**F-B — one invisible character.** Unchanged driver: one `U+202D` inside the
value, written into title, name, value, rows and href.

```
page "TITLE (filled, value withheld)" …
button e7 "name (filled, value withheld)"
  "cell" | "(filled, value withheld)"
link e9 "Href sink" /leak?pw=(filled,value-withheld)
```

`browser_read` clean too, and clean **after** stripping — the `stripFormat(body)`
on the innerText path closes the "one strip away" residual I recorded. The href
that previously came back as `guard-pw%E2%80%AD-93a1` is now the marker, which is
`scrubUrlish` working exactly as documented.

Fixing at walk time rather than post-render was the right call and the stated
reason is sound: a post-render scrub would leave `st.last` in one alphabet and
the rendering in another, and every diff is computed against `st.last`.

**The seventh sink** reproduces as fixed: a same-origin `location.href` with the
value in the query no longer disarms anything (G19h, and my own drivers hit it
incidentally throughout — the p4 self-navigation at H1b came back
`?pw=(filled,value-withheld)`).

---

## 2. The eighth and ninth

### F-C — `scrubUrlish` covers two of five URL surfaces (HIGH)

`grep -rn scrubUrlish src/` returns two call sites: `Snapshot.url` and
`SnapshotNode.href`, both inside `redact.ts`. The other three agent-facing URL
surfaces use the plain scrub, which does not decode:

| site | treatment |
|---|---|
| `redact.ts:231` `Snapshot.url` | `scrubUrlish` ✓ |
| `redact.ts:273` `SnapshotNode.href` | `scrubUrlish` ✓ |
| `tools.ts:553` `browser_tabs list` URL | `redactFreeText(tab.id, tab.url, REDACTED_HREF)` ✗ |
| `tools.ts:622` `browser_navigate` `loaded …` | `safeForAgent(id, info.url)` ✗ |
| `tools.ts:2014` `browser_capture` `sourceUrl` → **Notion** | `redactFreeText(id, …, REDACTED_HREF)` ✗ |

**Measured.** The page does `location.href = '/p4.html?landed=1&pw=' + split(v)`
where `split` inserts one `U+202D`. The browser percent-encodes it. Then:

```
H1b  browser_snapshot header   page "Probe 4" http://…/p4.html?landed=1&pw=(filled,value-withheld)   ← clean
H1c  browser_tabs list         * t2 … "Probe 4" http://…/p4.html?landed=1&pw=guard-pw%E2%80%AD-93a1  ← LEAKS
H1e  browser_navigate loaded   loaded "http://…/p4.html?landed=1&pw=guard-pw%E2%80%AD-93a1"          ← LEAKS
```

One tab, one origin, one assignment. The snapshot header — the surface that got
`scrubUrlish` — is clean; the two that did not are not.

`guard-pw%E2%80%AD-93a1` is the password to any reader willing to percent-decode
and drop an invisible character, and **both transformations are Aperture's own**:
the URL parser encoded it, and `sanitize()` is what deletes `U+202D` everywhere
else. That is precisely the standard `decodings()`'s docblock sets for itself.

**And the invisible character is not needed.** `scrubUrlish`'s own header states
the general case — *"a page that writes the value it holds straight into `a.href`
gets `?pw=my%20pass` back out, and the needle is `my pass`"*. Any password
containing a space, `#`, `&`, `%`, `+`, a quote or any non-ASCII character hits
these three surfaces with no adversarial construction whatsoever. The fix was
written for that sentence and then wired to two of the five places the sentence
applies.

`browser_capture` is the one that matters most per byte: it is the surface that
forwards the string **off the machine to Notion**, and it was hardened in this
same commit for exactly that reason.

### F-E — cross-origin self-navigation, fragment only (HIGH)

The filled page runs one line:

```js
location.href = 'http://127.0.0.3:8899/inert.html#' + password;
```

`inert.html` has no script, never reads its fragment, and **a fragment is never
sent to the server** — 127.0.0.3 received a request for `/inert.html` and nothing
else. Measured, on the shipped build:

```
2. one click; the page runs location.href = "http://127.0.0.3:8899/inert.html#" + password
   act result:
ok click e6
<untrusted-page-content id=… origin=http://127.0.0.3:8899>
FULL SNAPSHOT #3.0 — replaces all prior state for this page
page "An innocent page" http://127.0.0.3:8899/inert.html#guard-pw-93a1

3. browser_snapshot, NO arguments:
page "An innocent page" http://127.0.0.3:8899/inert.html#guard-pw-93a1
   carries guard-pw-93a1: true

4. browser_tabs list:
* t2 [default] complete "An innocent page" http://127.0.0.3:8899/inert.html#guard-pw-93a1
   carries guard-pw-93a1: true
```

The `browser_act` result is the same call that caused the navigation, so the
credential arrives in the agent's context on the turn the page chooses, with no
follow-up call needed.

**The residual's premise is false.** The builder filed this as unclosable because
"that navigation hands the value to the target's server anyway". A query string
does. A fragment does not, and the target does not have to be attacker-controlled
— any third-party origin works, because it is `Snapshot.url` doing the carrying,
not the page. Nothing was exfiltrated; the credential simply moved from a place
the redactor covers to a place it does not, inside one browser, in one line.

**It is closable, in the idiom the commit already introduced.** `openerOrigin`
records "who opened this tab" as a captured string and never widens it. The
missing sibling is "where this tab came from": capture the tab's previous origin
on a document-replacing navigation when that origin is in the needle store, and
include it in `originScope`. One more captured string, the same over-redaction
trade already accepted for `openerOrigin` (a tab that leaves a filled origin is
scrubbed against it until the TTL), and it closes F-E and the first leg of the
opener chain at once.

### Not blocking, but measured

**F-D — the two-hop opener chain.** `openerOrigin` is the opener's *current
origin*, not the opener's *scope*, so inheritance survives exactly one hop.
Filled `127.0.0.1` → hop1 `127.0.0.2` (covered, `openerOrigin` = filled) → hop2
`127.0.0.3` (`openerOrigin` = `127.0.0.2`, which holds no needles):

```
H4c  hop2 snapshot   page "HOP2 guard-pw-93a1" http://127.0.0.3:8899/hop2.html?carried=guard-pw-93a1
                     link e1 "go guard-pw-93a1" /leak?pw=guard-pw-93a1
                       "cell" | "guard-pw-93a1"
H4d  hop2 read       hop2 holds guard-pw-93a1
H4a  tab listing     * t5 … "HOP2 guard-pw-93a1" http://127.0.0.3:8899/hop2.html?carried=guard-pw-93a1
```

Both hops were fragment-only, so nothing reached any server. **But the relay
needs attacker script on a second origin**, and an adversary who has that has
already won by `security.md`'s own exfiltration row. Out of envelope — filed, not
blocked. The repair is free and I would take it anyway: inherit the opener's
`originScope`, not its current origin, which makes the property transitive
instead of one-deep.

**Agent-opened tabs carry no opener scope** (measured: an agent-opened tab on the
same carrier URL leaks where the page-opened one does not). Not reachable by
page steering: for the agent to open a URL carrying the value it must first read
that URL, and every surface it could read it from is scrubbed. Circular, so it is
a note rather than a finding — but it is the reason the fix for F-E must be
`priorOrigin` on the tab and not "trust the agent not to be handed a URL".

### Surfaces I hunted and did not find leaking

| candidate | result |
|---|---|
| **the `browser_act` diff** — the one the builder checked and no G19 leg asserts on | **clean, verified by construction rather than by reading**: I mutated `name`, `value`, `text`, `href` and `rows` to the credential in one click. The diff came back `~ e10 href=/after?pw=(filled,value-withheld)`, `~ e11 "after (filled, value withheld)"`, `~ e12 1x2: "k" \| "(filled, value withheld)"`, `~ e13 ="(filled, value withheld)"`. The check was sound. |
| `browser_tabs list` TITLE with a `U+202D`-split value | clean — `safeTabLine`'s post-`quote()` pass catches what `sanitize` reassembles. The builder's stated reason for scrubbing both sides is doing real work on `wc.getTitle()`, which the walker never touches. |
| one-hop foreign carrier (`window.open` to another origin) | clean — `openerOrigin` covers it, snapshot and read, with no arguments |
| the same carrier **after the opener tab is closed** | clean — the origin is a captured string, not a live lookup. Correct design. |
| same-origin carrier, same-origin self-navigation | clean |
| `browser_read` after `stripFormat` | clean verbatim **and** clean after stripping |

---

## 3. Adjudicating opener-origin inheritance

**Is `[current, opener]` right?** The shape is right and it is the correct
abstraction — a needle names a value, the value belongs to an origin, a tab shows
content from at most those two. Three edges, all measured:

| edge | behaviour | ruling |
|---|---|---|
| opener never held a credential | `needles.get(origin)` is undefined; contributes nothing | **correct, free** |
| opener tab is closed | `openerOrigin` is a string captured at creation; coverage survives | **correct** — measured E1b |
| carrier later navigates itself elsewhere | `openerOrigin` is never widened, so coverage is *kept* | **correct**, deliberate over-coverage |
| **chain of openers** | breaks at depth 2 | **under-covers** — F-D |
| **the tab's own prior origin** | not recorded at all | **under-covers** — F-E, and this is the blocker |

**Over-coverage: negligible and correctly chosen.** A tab opened by a filled
origin is scrubbed against that origin until the TTL even if it goes somewhere
unrelated. That is cosmetic and it is the trade the module takes everywhere.

**The net-coverage claim is overstated.** The builder claims coverage "strictly
greater than the union's at less over-redaction". Less over-redaction: yes,
measured — a foreign tab whose title genuinely contains another origin's secret
no longer gets the marker. Strictly greater: **no, not on the surface the union
actually lived on.** The union scrubbed every line of `browser_tabs list` against
every needle in the browser. Holding the seventh-sink fix constant, it would have
caught this line, and origin scope does not:

```
E3b  * t5 [default] complete "CARRIER guard-pw-93a1" http://127.0.0.3:8899/carry.html?carried=guard-pw-93a1
```

That is the filled tab after it navigated itself away — F-E's shape. Across
*all* surfaces origin scope is vastly wider than a union that only ever touched
one listing, and that is the honest claim. On the listing alone the two are
**incomparable**, and F-E is the counterexample. Closing F-E with `priorOrigin`
makes the strictly-greater claim true; until then the sentence should not be in
the file.

---

## 4. The three flagged and not fixed

**`browser_fill_form`'s plan lines — safe transitively. Accept, with a note.**
`collectFields(st.last.root)` reads the retained baseline, which `observe()`
redacted moments earlier, so `quote(e.label)` cannot carry a needle today. The
fragility is provenance, not logic: the safety depends on a caller three
functions away having used `st.last` rather than a fresh walk, and nothing states
that at the print site. One `redactFreeText(id, …)` around the joined lines costs
nothing and makes the line safe by its own construction. **Not blocking.**

**`nameOf()` falling back to a raw identity key — unreachable, and it contradicts
a ruling. Fix it anyway.** `fieldOf` is built from `toFill`; `res.results` keys
come from `fills`, built from the same `toFill`; so `?? key` cannot fire. But
`key` is page-derived, and `completeness.test.ts` rules it `never-emitted` with
*"the sharpest of the never-emitted rulings: printing a key anywhere would put
page bytes in front of the model with no scrub on the path"*. Here is a shipped
line that would print one. The ruling is true of the renderer and false of the
product, which is the exact reading error that produced `Snapshot.title`.
Changing `?? key` to `?? 'an unnamed field'` is one word and makes the ruling
true everywhere. **Not blocking; do it in the same pass.**

**Self-navigation to a foreign origin — ruled wrong. Blocking.** See F-E. The
justification is false for the fragment case, the target need not be
attacker-controlled, and the fix is one captured string.

---

## 5. The stale-build question — **yes, and it should refuse**

Three occurrences now, and the third was caught by a guard that happened to be
new. The failure is silent by construction: a green run against a stale artifact
looks exactly like a green run.

**Minimum: `bench/guards.mjs` should refuse to start when `out/main/index.js` is
older than any file under `src/`.** Five lines, no build orchestration, no new
dependency, and it fails closed on the one condition that produced all three
incidents. A runner that *builds* is better in principle but adds a way for the
guard run to fail for reasons that are not about guards; a runner that *refuses*
cannot be forgotten and cannot mislead.

**Belt: print the artifact hash in the header and in the RESULT line**, so the
record names what it ran against. The commit message already claims "all against
hash-recorded builds" — that discipline should live in the tool, not in the
operator, for the same reason the congruence table exists.

This is not a security defect and it is the cheapest item on the list. It is also
the one that decides whether any of the other numbers in this document can be
believed six months from now.

---

## 6. Guard and CI strength

**Case B is genuinely closed.** I re-applied it: a new `SnapshotNode.placeholder`,
rendered verbatim by `renderLine`, ruled `sink: 'not-page-text'` with a plausible
sentence. On the previous build the full suite was 522/522 green. Now:

```
× which fields are RENDERED is measured, not listed
  > plants a canary in every string-bearing field of both types
  → expected [ 'SnapshotNode.placeholder' ] to deeply equal []
```

The replacement is real work, not a bigger list: `canaried()` plants a distinct
canary in every string-bearing field, `renderFull` runs, and membership of the
rendered set is *measured*. Four independent ways to fail, and the frozen
`RENDERED_NOT_REDACTED` list is the right shape — a new rendered non-sink lands
on it by name and the assertion breaks.

Residual, stated because the file states its own: the tether between `SAMPLE` and
`canaried()` is an assertion rather than a type, so the two literals are kept in
step by a test rather than by tsc. That is one level weaker than the ruling table
itself, and it is the level at which this guard now sits. Acceptable.

**G19d/f/g/h/i.** All five assert on constructions that can actually fail for the
reason they name — I checked G19d specifically, since its predecessor could not.
The carrier is a genuine carrier now.

---

## 7. Known-open — unchanged, still correctly deferred

| item | verified at `43440a1` |
|---|---|
| `forget(tabId)` has no caller | **CONFIRMED**, and it no longer touches needles, which is right now that they are origin-keyed |
| E1 shell navigation allowlist / E2 `shell.openExternal` | **UNCHANGED**, still `file://`-only and still unvalidated |
| profile values get no needles | **CONFIRMED** — `registerNeedles` still has one call site, the credential path |
| `agent:activity` never sent | **CONFIRMED** — no sender in `src/` |
| three pre-redaction bench logs | **STILL PRESENT** |
| `.gitignore` `*.vault` matches nothing | **CONFIRMED** — `vault.aperture` still not ignored |

---

## 8. Blocking fix list — minimal

**C1. Route every URL surface through `scrubUrlish`.** Three call sites:
`tools.ts:553` (tab listing), `tools.ts:622` (`browser_navigate`), `tools.ts:2014`
(`browser_capture` → Notion). The cleanest shape is a `redactUrl(tabId, s)` in
`engine.ts` that composes `scrubUrlish` with the same needle list `redactFreeText`
uses, so no call site can pick the wrong one. Guard: extend G19g's fixture to
self-navigate with the split value in the query and assert on the tab listing and
the `loaded …` line, not only on the snapshot header.

**C2. Record the tab's prior origin and include it in `originScope`.** Capture it
on a document-replacing navigation, exactly as `openerOrigin` is captured at
window-open, and never widen it afterwards. This closes F-E and restores the
"strictly greater than the union" claim. Guard: a new leg that fills, navigates
itself to a third origin with the value in the **fragment**, and asserts on the
`browser_act` result, the no-argument snapshot and the listing.

**C3. Correct the residual.** `security.md` and the code comment must stop saying
a cross-origin self-navigation "hands the value to the target's server anyway".
It does not when the value is in a fragment, and the target need not be hostile.

### Recommended, same pass, not blocking

- Inherit the opener's **scope** rather than its current origin (F-D). One line,
  makes the property transitive.
- `nameOf()` → `?? 'an unnamed field'`.
- `redactFreeText` around `browser_fill_form`'s plan lines, so they are safe by
  construction rather than by provenance.
- `guards.mjs` refuses a stale artifact; prints the hash.
- Note that `registerNeedles` keys on `safeOrigin()` output while `originScope`
  keys on `tabs.ts`'s own `originOf()`. They agree on every fill-eligible origin
  today (https and loopback), but they are two implementations of the one fact
  the whole store is keyed by, and a disagreement is a silent total failure of
  redaction rather than a visible error. One function.

---

## 9. The plain answer

**Yes — one way, and it is a single line of page script with nothing leaving the
machine.**

```js
location.href = 'https://any-third-party.example/#' + password;
```

The credential comes back verbatim on the `browser_act` result that triggered the
navigation, on the next `browser_snapshot`, and in `browser_tabs list`. The
third party is inert; its server never receives the fragment. A second way, less
clean but needing no cross-origin hop at all, is any password containing a
character the URL parser encodes: put it in your own query string and the tab
listing and `browser_navigate` hand it over percent-encoded.

Both are the same failure the last four passes have been about, in its fifth
costume: **the redaction is keyed to a scope, and the page chooses where the
value goes.** Origin keying was the right abstraction and it is a large
improvement — the carrier tab, the invisible character, and the navigation
off-switch are all genuinely dead. What is left is that the scope follows the
*tab's* origin and the page can move the value across an origin boundary the tab
takes with it.

The boundaries below all still hold, and I re-checked them: no agent-facing
response type has a field that can carry a secret; origin binding is decided from
the vault and the committed URL before the page is consulted; consent is a native
dialog with no agent-reachable parameter; `src/preload/page.ts` exposes nothing to
page script. Every finding here is containment, against the same narrow adversary
— a late-injected skimmer on an origin that already holds the credential and
cannot phone home. F-E is squarely inside that adversary's reach and F-C is
inside an *ordinary user's* reach, because it fires on any password with a space
in it.

One process note, since it is the fourth pass. The base rate the coordinator
quoted is right and it is still not falling: read found 0, probe found 4, fixing
found 5, gate 1 found 7, this pass found 9. The two found here were reached by
taking two sentences the builder had already written — `scrubUrlish`'s
`?pw=my%20pass` and `openerOrigin`'s "never widened by a later navigation" — and
asking where else they applied. That is not a hunt technique. It is what a
checklist derived from the fix's own comments would have done, and it is probably
the cheapest instrument still unbuilt.
