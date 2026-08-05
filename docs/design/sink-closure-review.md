# Independent security gate — the plaintext-sink closure, 2026-08-05

Reviewer: a fourth agent. Did not write `docs/design/security-review-2026-08.md`,
did not build this fix, did not write `security.md`'s amendments. Scope: the
**uncommitted working tree** over `18eaf6c` — seven modified files plus untracked
`src/core/snapshot/redact.ts`.

---

## VERDICT: **BLOCK**

The fix is correct about everything it names. It is not correct about the
property it claims: *"every page-controlled string the agent can be shown is a
redaction sink, wherever it lives"* (`redact.ts`, and the amended
`security.md` §"Redaction: what it covers"). Two constructions defeat the whole
needle mechanism on the shipped tree, both measured, both requiring nothing the
adversary the needles exist for does not already have:

| # | | severity |
|---|---|---|
| **F-A** | **A same-origin tab the filled page opens carries the credential in clear on every per-tab surface.** Needles are keyed per tab; `window.open` makes Aperture create *and activate* a new tab; that tab has no needles. `browser_snapshot` with **no arguments at all** returns the password. | **HIGH** |
| **F-B** | **One invisible character defeats the entire snapshot redaction.** `redactObserved` runs on the raw walk result; `render.ts` then puts every name / value / text / rows cell and the title through `quote()` → `sanitize()`, which **strips** control and bidi code points. A value split by one matches no needle when the scrub runs and is whole again in the text the model receives. | **HIGH** |

Plus one guard defect: **G19d does not discriminate the deviation it was written
to defend.** Replacing the cross-tab union with a per-tab scrub — the exact
design deviation 1 departs from — leaves the guard suite **46/46 GREEN**.

Everything else checked out. The three closed sinks are closed, the two
deviations are individually sound, the sabotage rows reproduce, `redact.ts` is a
genuine pure leaf, and every known-open item is still open and correctly
deferred rather than quietly dropped.

---

## 0. What was actually run

Nothing below is inferred from reading unless it says so. **The repository was
not modified** except for this file: `git status --porcelain` before and after
is the same seven `M` plus one `??`. Every probe fixture, driver and sabotage
build lives in the scratchpad. Sabotage was applied to a **throwaway copy of the
tree** (scratchpad, `node_modules` junctioned), never to the repo.

| # | Run | Result |
|---|---|---|
| 1 | `npx tsc --noEmit -p tsconfig.json` | clean |
| 2 | `npx vitest run` | **522 passed / 21 files** |
| 3 | `npx electron-vite build` | clean |
| 4 | Aperture `--seed-vault --e2e-consent=allow --e2e-consent-delay-ms=1500`, fixtures on `127.0.0.1:8899` **and** `127.0.0.2:8899` | up |
| 5 | `node bench/guards.mjs <token> … --phase=allow` | **46/46 GREEN** (G19, G19b, G19c, G19d, G19e all PASS) |
| 6 | Five probe drivers of my own, nine new sink candidates, one secret (`guard-pw-93a1`) | **F-A and F-B found** |
| 7 | Four sabotage builds (three the builder recorded, verbatim; two of my own) | see §5 |
| 8 | Four hypothetical-new-field experiments against `completeness.test.ts` | see §3 |

---

## 1. Is the load-bearing property true? — **no**

### F-A — a same-origin tab the page opens is outside every per-tab scrub (HIGH)

**Mechanism.** `needlesFor(tabId)` and `stateFor(tabId).tainted` are keyed per
tab (`engine.ts`). `observe()`, `redactFreeText()` and therefore `safeForAgent()`
all scrub against **that one tab's** needles. `browser_tabs list` was widened to
the union (deviation 1); nothing else was.

`src/main/tabs.ts` wires every page's window-open handler to
`this.create({ url, container: rec.container, activate: true })`. So a page can
create a new Aperture tab, in its own container, **and make it active** — and
that tab was never filled, so `needlesFor(it)` is empty and
`redactObserved` returns at its first line.

**Measured**, shipped build, after a successful `vault_request_fill apply`. The
page's click handler is one line:

```js
window.open('/carry.html#' + encodeURIComponent(p.value), '_blank');
```

The agent then issues `browser_snapshot` with **no `tabId`, no `mode`, nothing** —
the call it would make anyway:

```
FULL SNAPSHOT #1.0 — replaces all prior state for this page
page "CARRIER guard-pw-93a1" http://127.0.0.1:8899/carry.html?carried=guard-pw-93a1

h1 "Carrier tab"
link e1 "go guard-pw-93a1" /leak?pw=guard-pw-93a1
table e2 1x2
  "cell" | "guard-pw-93a1"
```

and `browser_read`, also with no arguments:

```
carried guard-pw-93a1
Carrier link
cellguard-pw-93a1
```

and `browser_navigate` on that tab:

```
loaded "http://127.0.0.1:8899/carry.html?carried=guard-pw-93a1"
<untrusted-page-content id=… origin=http://127.0.0.1:8899>
title: "CARRIER guard-pw-93a1"
```

Five surfaces, one secret, no misdirection of the agent whatsoever. Note the
shape: `Snapshot.url`, `Snapshot.title`, `SnapshotNode.name`, `.href` and `.rows`
— **the five fields this fix just closed**, all open again one tab over. The
carrier does not even need script: the value is in the URL `window.open` passed,
so `Snapshot.url` carries it before any page code runs.

**Why this is squarely in scope.** It is not a new threat model; it is *the*
threat model, written down by the builder himself as the justification for
deviation 1 (`engine.ts`, `everyNeedle`):

> A skimmer on the filled origin can `window.open` a same-origin page whose
> title or query string holds the value, and that new tab has no needles of its
> own — nothing was ever filled into it.

That sentence is true, and it is true of `browser_snapshot`, `browser_read`,
`browser_navigate` and every `browser_act` prose channel exactly as it is true of
`browser_tabs list`. The aggregate listing was closed; the direct read — which
returns the whole tree rather than one line — was not. If per-tab scope is
adequate, the union was unnecessary; if the union was necessary, per-tab scope is
inadequate everywhere. The tree cannot hold both positions, and it currently
holds the weaker one on the richer surface.

**Also measured:** the leak survives closing the filled tab (`forget` has no
caller, so the needles stay alive for the listing while the carrier's own
snapshot leaks anyway), and a **different**-origin tab carrying the same string
also leaks (`http://127.0.0.2:8899`) — the union covers the listing on both
origins but nothing covers the snapshot on either.

### F-B — a needle split by a character the RENDERER strips (HIGH)

**Mechanism.** `redactObserved(r, …)` runs on the raw walk result, in
`observe()`, before anything is rendered. The walker only whitespace-normalises
names, values and text (`.replace(/\s+/g,' ')`); it does **not** strip control
characters from them — `sanitizeHref` does that for `href` alone, at walk time.
The control-character strip for every other string happens in
`render.ts` → `quote()` → `sanitize()`, which **removes** `U+0000–1F`, `U+0085`,
`U+007F–9F`, `U+2028/9`, `U+202A–202E` and `U+2066–2069` rather than escaping
them — *after* the redaction has run.

So the redactor sees `guard-pw⁭-93a1` (no match) and the model receives
`guard-pw-93a1`.

**Measured**, shipped build, after a successful fill. The page inserts one
`U+202D` into the middle of the value it already holds and writes the result
into four ordinary places:

```
page "TITLE guard-pw-93a1" http://127.0.0.1:8899/p3.html?run=…
    textbox e4 "Search this site" ="value guard-pw-93a1"
button e7 "name guard-pw-93a1"
table e8 1x2
  "cell" | "guard-pw-93a1"
```

`Snapshot.title`, `SnapshotNode.value`, `.name` and `.rows`, all verbatim, all
inside the envelope where the agent is told the quoted strings are the page's own
text. `.text` takes the same `quote()` path in `renderLine` and behaves the same.
`browser_read` returns `guard-pw<U+202D>-93a1` — not byte-verbatim, but visually
identical and one strip away from verbatim. `href` **held**, and held for the
right reason: `sanitizeHref` strips at walk time, so the redactor and the
renderer see the same bytes — though it still emits the percent-encoded form
`/leak?pw=guard-pw%E2%80%AD-93a1`, which discloses the value to any reader
willing to decode it.

**The taint branch is immune** and that matters: taint is keyed on the element,
not the value, so the filled fields themselves stayed `(filled, value withheld)`
throughout. It is every **copy** the page makes that F-B unmasks — which is the
entire population the needles exist for.

**Why this is squarely in scope.** The builder identified this exact hazard and
fixed it in one place. `tools.ts`, `safeForAgent`:

> AFTER, because `sanitize()` STRIPS control characters rather than escaping
> them. A page that writes `guard-pw<U+0000>-93a1` presents bytes that match no
> needle until sanitize has removed the separator — at which point the secret is
> whole again, inside the quotes, on its way to the model.

That reasoning was applied to harness prose and not to the renderer, which is the
primary surface and the one carrying the whole tree. It is also **not** covered
by the residual `security.md` states — "transformation defeats substring
matching: reversed, base64'd, or one character per element … cannot be" — because
those transformations change what the model sees. This one does not: Aperture
itself removes the separator on the way out.

### Sinks I hunted and did **not** find leaking

Stated so the negatives are as checkable as the positives. All measured on the
shipped build after a fill, unless marked.

| candidate | result |
|---|---|
| `document.title`, `history.replaceState` URL, link `href`, echoed div text, table cells, filled field values — **same tab** | clean, markers present |
| `browser_tabs list` (cross-tab union) | clean |
| element tag name → `not-a-select` and `not-an-editable-field` prose | clean (`"x-(filled, value withheld)" element`) |
| obstructor `TAG#id` | clean |
| select success label, `previous` labels, `disabled` label, `no-match` suggestions, `ambiguous` candidates | clean |
| `browser_read` of a native `<select>`'s option list | clean |
| same-origin `<iframe>` content (snapshot and read) | clean — the frame's nodes are in the same tab's tree |
| `browser_navigate` `loaded …` line and `title:` line, same tab | clean |
| `browser_console` | **stub** — `'console capture not yet wired'`. It is a sink the day it is wired: console text is 100% page-chosen. It carries no ruling anywhere. |
| `browser_capture` | image is not returned to the agent; but it forwards `info.title` to Notion as the caption, so a page-written title leaves the machine unredacted. Out of *agent context*, in scope for disclosure. |

Two more `err.message` sites in the same class as `security.md`'s named
residual, neither of which is in the review's nine-site table and neither of
which is scrubbed:

- `engine.ts:773` → `browser_attach`'s `attach failed: ${res.reason}` — raw,
  unquoted, uncapped, **outside** the envelope.
- `engine.ts:211` → `could not read the page (${payload.reason})` — the walk
  failure, **inside** the envelope, unscrubbed. Consistent with what
  `security.md` says about the walk arm; noted because the file now claims all
  three outside-envelope reason arms go through the scrub, and these two are a
  fourth and fifth arm nobody counted.

---

## 2. The cross-tab union (deviation 1) — threat real, implementation covers it, **guard does not**

Three separate questions; three separate answers.

**Is the threat real? Yes — constructed and measured.** I built the carrier tab
the builder's comment describes and asked for the listing:

```
  t3 [default] complete "Probe sign-in"    http://127.0.0.1:8899/p1.html?run=…
* t4 [default] complete "CARRIER guard-pw-93a1" http://127.0.0.1:8899/carry.html?carried=guard-pw-93a1
```

— that is against a **sabotaged** build in which the listing scrubs each line
against *that tab's own* needles. The tab carrying the value (`t4`) was never
filled, so its own needles are empty and its line goes out in clear. Against the
shipped union build the same construction is clean. Deviation 1 is **correct and
necessary**, and per-tab scrubbing of the listing genuinely would have been "the
same hole with a loop around it".

**Does the implementation cover it? Yes.** `everyNeedle()` is not exposed;
`redactAcrossTabs` is the only way to reach it; both title and URL go through it,
the URL with the whitespace-free marker. Measured clean with the carrier open, on
both a same-origin and a foreign-origin carrier, and still clean after the filled
tab was closed.

**Does G19d guard it? No.** This is the defect. `browser_tabs list` takes no
`tabId` — the tool ignores the active tab entirely — so G19d's construction
("the listing is requested from a SECOND tab that has never held a credential")
changes nothing about what gets scrubbed. The value in G19d's listing sits in
`t1`'s own title, and `t1` **has** needles. I replaced the union with a per-tab
scrub and ran the suite:

```
PASS  G19d  the cross-tab listing does not carry another tab's filled credential…
46/46 guards hold
RESULT: GREEN
```

The guard's own comment claims "A per-tab scrub would pass this; only a scope at
least as wide as the surface closes it" — the first clause is right and it
contradicts the second. G19d discriminates *scrub vs no scrub* (the builder's own
sabotage row 2 turns it red, verified below); it does not discriminate *per-tab
vs union*, which is the property deviation 1 exists to hold. The discriminating
construction is a **carrier tab** — a tab whose own title or URL holds the value
and which has no needles — and it takes four lines of fixture.

**The disclosed cost — ruling: accepted, with one correction.** Over-redaction
across tabs is real (measured: a `127.0.0.2` tab whose title genuinely contained
the string got the marker) and is the right trade by this module's own stated
position. The bound is the **10-minute TTL and only the TTL**. The builder writes
that it is "bounded twice over, because needles exist only for a tab that was
filled in the last ten minutes" — that is one bound stated twice, not two.
`forget(tabId)` having no caller means closing the tab does not shorten it
(measured: X7, the listing still scrubbed after the filled tab was closed). The
practical cost is a cosmetic marker on unrelated tabs for up to ten minutes, on
sessions where a fill happened. Accept it.

---

## 3. The executable congruence guard — **claim true as worded, weaker than it reads**

The builder claims three failure modes for a new page-controlled string. I added
a hypothetical `SnapshotNode.placeholder?: string`, rendered it verbatim in
`renderLine`, and ran the suite in the throwaway copy. All four cases measured:

| case | result |
|---|---|
| **A** — field added, **no ruling** | **RED**, on tsc only, but loudly: two errors (`Record<keyof SnapshotNode, Ruling>` and `Required<SnapshotNode>` on `SAMPLE`). `test/typecheck.test.ts` runs tsc inside vitest, so `npm test` catches it. |
| **B** — field ruled `sink: 'not-page-text'` with a plausible 60-character `whyNot`, still rendered verbatim | **GREEN. Full suite 522/522.** |
| **C** — ruled `redacted`, not planted | **RED** — `expected [ 'SnapshotNode.placeholder' ] to deeply equal []` |
| **D** — planted, not scrubbed | **RED**, two assertions (data and `renderFull` output) |

So the three modes are all real and modes 2 and 3 are genuinely executable — the
claim is **not** overstated as literally worded, and it is more than "tsc
totality". But case B is the one that matters, and it is the mistake that
actually happened: `Snapshot.title` was ruled correctly on the axis the table
had, and the ruling *read* as "not delivered". The new axis forces **a** ruling
and measures it only once the author has already chosen `redacted`. An author who
reaches the wrong conclusion — the failure this axis exists for — is not caught
by anything.

The sentence that **is** overstated is in `completeness.test.ts`'s own header:

> and a rendered field cannot be ruled anything but `redacted` — that check is
> the one that stops the NEXT `Snapshot.title`.

It stops the next `Snapshot.title` only for the seven field names hardcoded in
`no RENDERED page-controlled string is ruled anything but a sink`
(`name value text href rows` / `url title`). That list does not grow with the
type. A new rendered field can be ruled anything at all.

The fix is small and mechanical, and it would have caught case B: derive the
rendered set instead of listing it. Plant a distinct canary in **every**
string-typed field of `Required<SnapshotNode>` / `Required<Snapshot>`, call
`renderFull`, and require that any field whose canary appears in the output is
ruled `redacted`. That turns `never-emitted` and `not-page-text` from adjectives
into measurements for all fields rather than five.

---

## 4. `safeForAgent` on both sides of `quote()` (deviation 2) — **both reasons verified, no new failure**

**The BEFORE pass earns its place.** An overlay whose `id` straddles `quote()`'s
80-character cut, sabotaged to scrub only after `quote()`:

```
error: e4 is covered by "DIV#aaaaaaaa…aaaguard-pw-93a…" — likely a modal or cookie banner.
```

**twelve of the thirteen characters of the password**, in clear, outside the
envelope. The shipped build, same fixture:

```
error: e4 is covered by "DIV#aaaaaaaa…aaa(filled, val…"
```

**The AFTER pass earns its place.** An option label carrying the value split by
`U+0001`, on the already-`quote()`d suggestion path:

```
error: no option on e7 is called "zzz" (2 options). Nearest by name:
<untrusted-page-content …>
"(filled, value withheld)"
"plain-option"
```

The needle is unmatchable before `sanitize()` and matched after it. Both passes
are load-bearing and neither is redundant.

**No new failure from the double scrub**, with one cosmetic artifact. Executed
against the shipped `scrub` and `quote`:

| input | output |
|---|---|
| ordinary needle | `"x (filled, value withheld) y"` — idempotent |
| page text containing `"` | `"a\"b (filled, value withheld) c"` — quoting intact; the marker contains neither `"` nor `\`, so scrubbing inside an already-quoted string cannot break it |
| **needle that is a substring of the marker** (e.g. a password `withheld`) | `"id ovl-(filled, value (filled, value withheld)) end"` |

The last is marker-in-marker nesting. It is bounded at one extra nesting per
pass (`split`/`join` does not rescan its own output), it discloses nothing, and
it only occurs for passwords drawn from `filled, value withheld`. Cosmetic;
worth one sentence in `security.md`, not a fix.

---

## 5. Sabotage spot-check — all three recorded rows re-applied, verbatim

Applied to the throwaway copy, rebuilt, relaunched, guards re-run.

| row | change | expected | measured |
|---|---|---|---|
| 1 | `redact.ts`: drop the `t.title` / `t.url` scrub (back to `SnapshotNode` scope) | G19c red | **RED — G19, G19c**; and `completeness.test.ts` red on 2 assertions |
| 2 | `tools.ts`: listing back to `quote(tab.title)` / bare `tab.url` | G19d red | **RED — G19d** |
| 3 | `tools.ts`: `sel.tag` back to raw `<…>` | G19e red | **RED — G19e** |

All three reproduce. Two rows of my own:

| row | change | measured |
|---|---|---|
| 4 | listing scrubbed **per-tab** instead of by the union | **46/46 GREEN** — see §2; this is the guard defect |
| 5 | `safeForAgent` drops the pre-`quote()` scrub | 12/13 characters of the password in clear — see §4 |

---

## 6. `redact.ts` as a pure leaf — **holds**

- Imports exactly one thing, and it is a type: `import type { SnapshotNode }`. No
  Electron anywhere on the path, so the suite really can execute it.
- `test/completeness.test.ts` imports `../src/core/snapshot/redact.js` — **the
  shipped module**, not a copy. It executes the same `redactObserved` that
  `observe()` calls.
- **No divergent path.** `REDACTED`, `REDACTED_HREF` and `scrub` are each defined
  exactly once, in `redact.ts`. `engine.ts` imports them and re-exports the two
  markers so `tools.ts`'s import chain terminates at the same definition. Grep
  over `src/` finds no second literal of either marker string and no second
  `scrub` implementation.
- The one thing the unit test cannot reach is the **call site** —
  `redactObserved(r, st.tainted, needlesFor(tabId))` in `engine.ts`. Passing
  `r.root` instead of `r` there would be a tsc error (`RedactTarget` requires
  `url` and `title`), which is adequate.

---

## 7. Known-open — every item confirmed still open, none silently dropped

| item | verified |
|---|---|
| `forget(tabId)` has no caller | **CONFIRMED.** `grep -rn "forget("` over `src/ test/ bench/` returns the export and nothing else. Explicitly out of the builder's brief; correctly deferred. Measured consequence: closing the filled tab does not drop its needles. |
| E1 shell-window navigation allowlist | **UNCHANGED.** `src/main/index.ts` still denies only `file://`, on every `webContents`. |
| E2 `shell.openExternal` unvalidated | **UNCHANGED.** Still `void shell.openExternal(url)` with no scheme check. |
| profile values get no needles | **CONFIRMED.** `registerNeedles` still has exactly one call site (`tools.ts:1080`, the credential path). The profile path calls `markTainted` alone. |
| `agent:activity` never sent | **CONFIRMED.** Subscribed in `src/preload/shell.ts:60`; no sender anywhere in `src/`. |
| three pre-redaction bench logs | **STILL PRESENT**, all three, each still holding a live-format `Bearer` token. Gitignored, tokens dead. |
| `.gitignore` `*.vault` matches nothing | **CONFIRMED.** `git check-ignore` says `vault.aperture`, `profiles.dat`, `telemetry.json`, `mcp.json`, `notion.dat` are **all** not ignored. |

All correctly deferred. None is claimed fixed anywhere in the diff or in the
amended `security.md`.

---

## 8. What the builder overstated

Four things, in descending order of consequence.

1. **The rule as written is false.** `redact.ts` and `security.md` both state
   *"EVERY page-controlled string the agent can be shown is a redaction sink,
   wherever it lives."* F-A and F-B are both counterexamples reachable with a
   single line of page script. The rule is the right rule; the tree does not
   hold it.
2. **`security.md`'s coverage table reads as complete and is not.** Every row is
   true *of the tab that was filled*, and the table says nothing about scope. A
   reader takes "`SnapshotNode.name` / `.value` / `.text` / `.rows` → covered by
   `redactObserved`" as a statement about the mechanism; it is a statement about
   one tab, and it is defeated by an invisible character even there.
3. **G19d's comment claims a discrimination the guard does not make.** "A per-tab
   scrub would pass this; only a scope at least as wide as the surface closes it"
   — measured: a per-tab scrub passes it, and the suite stays 46/46.
4. **"a rendered field cannot be ruled anything but `redacted`"** is true of seven
   named fields and of no future one. Measured: a new rendered page-controlled
   string ruled `not-page-text` is 522/522 green.

Two smaller ones, for the record: "bounded twice over" is one bound stated twice
(§2); and the residual list's "transformation defeats substring matching …
cannot be [caught]" does not cover F-B, which can be caught and by the builder's
own stated method.

---

## 9. Blocking fix list — minimal

**B1. Close F-B.** Make the bytes the redactor sees the bytes the model gets.
Either (preferred, and it is what `href` already does) move the control/bidi
strip into the walker so `name`, `value`, `text` and `rows` arrive sanitised
before `redactObserved` runs; or scrub `renderFull` / `renderDiff`'s **output**
before it leaves `observe()`, which is the same "both sides of the neutralizer"
rule `safeForAgent` already applies. Guard: extend the login fixture's echo
handler to insert one `U+202D` into the value, and assert the existing
whole-snapshot predicate. `Snapshot.title` needs the same treatment — it is
`quote()`d in `renderFull` and is not sanitised anywhere earlier.

**B2. Close F-A.** Give the needle scope the same reach as the surface, and the
tree already argues which reach that is. Preferred: **key needles by origin
rather than by tab.** The value belongs to an origin, same-origin tabs are
exactly the carriers, and it is *narrower* than the global union — so it closes
F-A while reducing the over-redaction deviation 1 disclosed. Cheap fallback:
use `everyNeedle()` in `observe`, `redactFreeText` and the act-prose helpers too,
i.e. apply deviation 1's own rule uniformly. Guard: a new G19f that fills tab A,
clicks a button whose handler is `window.open('/carry.html#'+value)`, and asserts
the full snapshot of the resulting **active** tab.

**B3. Make G19d discriminate.** Rebuild it around a carrier tab — a tab whose
*own* title and URL hold the value and which has no needles — rather than around
which tab the listing is "asked from". As written it cannot fail for the reason
it names. (B2's guard and this one share a fixture.)

**B4. Correct the four overstatements in §8** in `security.md`,
`redact.ts`'s header, `engine.ts`'s `everyNeedle` comment and
`completeness.test.ts`'s header — including scope, which none of them currently
states.

### Recommended, not blocking

- Derive the rendered-field set in `completeness.test.ts` instead of hardcoding
  seven names (§3). This is the structural fix; it is worth more than B1 and B2
  together over time, for exactly the reason the 2026-08 review's §10 gives.
- Rule on `browser_console` before it is wired.
- Scrub `browser_attach`'s failure reason and `observe()`'s walk-failure reason,
  or fold them into the counted residual list.
- One sentence on marker-in-marker nesting (§4).
- `browser_capture` forwards a page-written title to Notion unredacted.

---

## 10. The plain answer

**Yes. Two ways, both of which I constructed and measured on the shipped build,
neither of which needs anything the adversary these needles exist for does not
already have.**

The page inserts one invisible character into the value before copying it
anywhere — the redactor sees a non-match, the renderer removes the separator, and
the model reads the password in clear inside the envelope. Or the page calls
`window.open` on itself: Aperture creates and activates a tab that was never
filled, and the agent's very next unqualified `browser_snapshot` returns the
whole tree in clear.

The narrower claim the design actually rests on is untouched and I re-checked it:
**no agent-facing response type has a field that can carry a secret**, origin
binding is still decided before the page is consulted, consent is still a native
dialog with no agent-reachable parameter, and `src/preload/page.ts` still exposes
nothing to page script. Every finding here is in the containment layer, and the
adversary for both is the same one the needles were built for — a late-injected
skimmer on an origin that already holds the credential and cannot phone home.
That is a narrow adversary. It is also the only one this mechanism was ever for,
which is why these block rather than merely annoy.

The method note is the same one the last two reviews ended on, and it is getting
expensive. This fix was the third pass on the same class. It was read carefully,
guarded with five live checks and a new executable CI axis, and it took forty
minutes of probing to find two complete bypasses — one of which the builder had
already written down as a hazard, in a comment, four files away from where it
still applies.
