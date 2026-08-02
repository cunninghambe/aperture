# G15 RED record — the silent rebinding, observed live on the pre-fix build

What this file is: the evidence that G15 discriminates. An instrument that has
never seen the defect it guards is the false green all over again
(`docs/design/tier4.md` §0, "Pre-landing evidence runs come first"; the F4
lesson, third application, after `blindfields-red-record.md` and
`g14-red-record.md`). G15 was authored and run BEFORE the P2 escalation landed,
against a build in which a positional family that GAINS a member emits one
`add` op. It FAILED, in exactly the shape tier4 §1.1 described from a
constructed-node probe — and this file adds what a probe cannot: the page's own
record of a held ref landing on the wrong row.

Post-fix G15 must pass, against the byte-identical fixture, guard and command
line. A G15 that has only ever been green would prove nothing.

## The build under test — provenance

| fact | value |
|---|---|
| repo | `C:\Users\cunni\dev\aperture` |
| HEAD | `15b633b21f1c5a2cd8a4f96abbdaff4d9ae8182a` ("docs: tier4 spec …", 2026-08-02 02:33:58 -0400) — a docs-only commit on top of `f37a5db`, so the SOURCE this bundle was built from is `f37a5db`'s, exactly as tier4 §1.6 requires |
| working tree at HEAD | clean (`git status --porcelain` empty) when this recording began |
| bundle | `out/` as built at **2026-08-01 18:25:47 -0400** — every file in `out/` carries that timestamp |
| `out/main/index.js` | sha256 `84d845203b0c6d1da034287f209df158c0430fc3b98ae5171b43f33ec255860d` (196062 bytes) |
| `out/preload/page.cjs` | sha256 `a1d308e83ee5b81ea6b400304902ae03d829860ecd9d51b44a1dd72594449e8b` (27425 bytes) |
| Electron | 43.2.0 · Node v22.14.0 (harness) |
| working tree at run time | Builder A's `bench/guards.mjs` (G15) + `test/fixtures/prepend.html`, harness-side only; Builder B's in-flight edits to `src/core/snapshot/diff.ts` (mtime 02:42:47), `walker.ts` (02:42:55) and `act.ts` (02:44:22) — **all later than the bundle, none built** |

**Why this bundle is the PRE-FIX one, checked rather than assumed:**

- `out/main/index.js` contains **2** occurrences of `positionalFamilyLostAMember`
  (the definition and its one call site) and **zero** occurrences of
  `positionalFamilyGainedAMember`. The P2 predicate is not in the bundle under
  any spelling.
- Every `out/` file is timestamped 2026-08-01 18:25:47, which predates HEAD, and
  predates the newest `src/` file at recording start (`act.ts`, 2026-08-01
  18:20:22) — i.e. the bundle is NEWER than the source it was built from and
  older than every edit made since.
- The two `out/` hashes above were taken twice: once before the guard run and
  once after both runs below completed, with Builder B's `diff.ts` edit already
  on disk in between. They are identical. **No rebuild was run at any point
  before, during, or after this recording**, which is the whole basis of the
  claim that what follows is the pre-fix engine's behaviour.

The engine under test is therefore `diff.ts`'s third escalation as landed by P1:
`positionalFamilyLostAMember(oldKids, newKids)` alone, which asks whether an OLD
family key is absent from the new tree — and on an insertion, no old key is.

## The fixture

`test/fixtures/prepend.html` (new, Builder A), built to `bench/fixtures/queue.html`'s
conventions rather than re-derived: content-identical rows, no `<a>` and no
`<h1>`–`<h4>` inside a row or beside a button, no ids/testids on rows or their
buttons, the divider-span-on-every-third-CURRENT-index rule to stay under
`COLLAPSE_RUN`, and a `replaceChildren` re-render.

Five rows, each `<li><span>Ticket</span><button>Take</button></li>`, in a
`<ul aria-label="Tickets">`. `<button id="add-urgent">Add urgent ticket</button>`
sits OUTSIDE the list with a distinct label and a non-generated id, so it keys
Tier-1 and can never join the family it mutates; clicking it does
`state.unshift({id:'u'+(++n)})` and re-renders.

The load-bearing part is `#log`. Clicking a Take button does not mutate the
list; it appends `took: <rowId>` resolved by the row's **current index** into
the state array. The row ids (`r1`…`r5`, `u1`) exist only in that JS array and
are never written into a DOM attribute, so nothing in the accessibility tree can
leak them — the log is the page's own independent record of which row an act
actually hit, and it is the only reason a silent retarget is observable from
outside the engine at all.

The fixture header states the construction, cites tier4 §1.6, and records that
the fixture is insert-mutating BY DESIGN and must therefore never be imported by
`bench/tasks.mjs` (the `nth` solver constraint stands).

## The run — exact commands

```
# fixture server (scratchpad, not the repo): test/fixtures on 127.0.0.1:8899, no-store
node C:\Users\cunni\AppData\Local\...\scratchpad\fixserve.cjs
#   fixtures on 8899

# the pre-fix build, launched from out/
cd C:\Users\cunni\dev\aperture && npx electron .
#   [aperture] MCP server listening on http://127.0.0.1:8817/mcp

node bench/guards.mjs <token>
```

Both runs below are against that one Aperture instance, in the window
02:41–02:44 -0400 on 2026-08-02.

## The output — verbatim

```
# Live guard probe

initial full snapshot: 11 refs tracked

PASS  G1a  the diff retires refs inside a removed <div> (non-addressable root)
PASS  G1b  the mechanical reader drops them when it applies that diff
        e3: dropped, e4: dropped
PASS  G2  a country -> state cascade updates the [N options] marker
        model had [3], now holds [51]; page has [51]
PASS  G3  action:"select" refuses a <select disabled> and writes nothing
        reply: error: e7 is disabled — either directly or by an enclosing <fieldset disabled> — so a human could not change i
        witness: country=US
PASS  G4a  action:"select" refuses a select inside <fieldset disabled>
        reply: error: e8 is disabled — either directly or by an enclosing <fieldset disabled> — so a human could not change i
        witness: country=US
PASS  G4b  the snapshot line for that select SAYS disabled, so the agent can see why
        line: combobox e8 "Grouped field" ="Ex" [2 options] disabled
PASS  G5  a blank option query is refused, not resolved to <option value="">
        was ="Standard"; reply: error: an option name is required and "" is blank. Name the option you want; call browser_read with e9 to see 
        witness: country=US
PASS  G6a  a no-match error is smaller than a browser_read of the same element
        error 636 chars (~159 tokens); browser_read 20104 chars
PASS  G6b  candidate labels are escaped, so a page cannot forge an option in them
        escaped: true, bidi stripped: true
PASS  G7a  action:"select" behind an aria-modal overlay is refused, and writes nothing
        reply: error: e9 is covered by "DIV#banner" — likely a modal or cookie banner. Dismiss it first; acting here would reach the overlay, not the eleme
        witness: country=US
PASS  G7b  and the same select succeeds once the overlay is gone (not a blanket refusal)
        reply: ok select e9 → "Overnight"
        witness: country=US ship=ovn
PASS  G12a  a redundant snapshot says so in its own words, and does not advance the page state id
        first:  page #3.1 (unchanged — you already hold the current page)
        second: page #3.1 (unchanged — you already hold the current page)
PASS  G12b  13 unchanged observations do not spend the 12-diff budget: the next act still gets a diff
        13/13 snapshots reported unchanged; the act after them returned a diff
        page #3.2 (diff from #3.1)
PASS  G13a  a click that rewrites table cells reports the new cells, not "nothing changed"
        unchanged: false, carries "SHIPPED": true
        page #4.1 (diff from #4.0)
        ~ e18 3x3:
        ~ e19 +focused
PASS  G13b  a link whose href moves under a stable label reports the new target
        carries "/checkout-v2": true
        page #4.2 (diff from #4.1)
        ~ e19 -focused
        ~ e20 href=/checkout-v2
        ~ e21 +focused
PASS  G14  a page that suppresses input listeners is reported as ok, not as a dead input path
        reply: ok click e24
        begins "ok click": true; page shows "acknowledged 1 time": true
FAIL  G15a  a row prepended into a positional family restates the family, instead of whispering one add
        held ref for row 1's Take before the insert: e27; replace block: ABSENT; Take rows restated: 0 (need >= 6)
        page #7.1 (diff from #7.0)
        + after e34:
          generic "6 tickets waiting"
        + after e35:
          listitem
            generic "Ticket"
            button e33 "Take"
        ~ e32 +focused
FAIL  G15b  the top row of the restatement really is the row that was just inserted
        not reached: G15a found no replace block, so there is no restatement to read.

16/18 guards hold

RESULT: RED — G15a, G15b
```

Exit code 1.

## The hazard demonstration — what the green guard cannot show

G15b's green form clicks the ref the RESTATEMENT puts at the top. Pre-fix there
is no restatement, so the defect's actual cost is invisible to it. tier4 §1.6
requires it recorded here instead: a one-off scratchpad probe
(`g15hazard.mjs`, never part of the repo) that clicks the ref the agent was
HOLDING for row 1 before the insertion, and asks the page which row that turned
out to be. Same Aperture instance, same fixture, immediately after the run
above.

```
=== 1. the page as the agent first reads it (full snapshot) ===
<untrusted-page-content id=6ae38a54 origin=http://127.0.0.1:8899>
FULL SNAPSHOT #8.0 — replaces all prior state for this page
page "Dispatch queue" http://127.0.0.1:8899/prepend.html?hazard=1785652999115

main e25 "Dispatch queue"
  h1 e34 "Dispatch queue"
  generic "5 tickets waiting"
  list e26 "Tickets"
    listitem
      generic "divider"
      generic "Ticket"
      button e27 "Take"
    listitem
      generic "Ticket"
      button e28 "Take"
    listitem
      generic "Ticket"
      button e29 "Take"
    listitem
      generic "divider"
      generic "Ticket"
      button e30 "Take"
    listitem e35
      generic "Ticket"
      button e31 "Take"
  button e32 "Add urgent ticket"
</untrusted-page-content id=6ae38a54>

=== 2. what the agent holds ===
Take buttons on the wire : 5
heldRef (row 1's Take)   : e27
"Add urgent ticket"      : e32

=== 3. the observation the prepend produced ===
ok click e32
<untrusted-page-content id=556f5c73 origin=http://127.0.0.1:8899>
page #8.1 (diff from #8.0)
+ after e34:
  generic "6 tickets waiting"
+ after e35:
  listitem
    generic "Ticket"
    button e33 "Take"
~ e32 +focused
</untrusted-page-content id=556f5c73>

=== 4. the agent now clicks e27 — the ref it read as row 1 ===
ok click e27
<untrusted-page-content id=1edbc544 origin=http://127.0.0.1:8899>
page #8.2 (diff from #8.1)
~ e27 +focused
~ e32 -focused
+ after e32:
  generic "took: u1"
    generic "took: u1"
</untrusted-page-content id=1edbc544>

=== 5. the page's own record of which row was actually taken ===
  generic "took: u1"
    generic "took: u1"

log says "took: u1" (the PREPENDED row): true
log says "took: r1" (the row the agent read): false
```

Exit code 0 (the probe reports, it does not judge).

**Read the two halves together.** Step 1 gives `e35` a name in the agent's own
snapshot: it is the LAST `listitem` in the list. Step 3 then says
`+ after e35:` — one row appeared at the BOTTOM. The page had put one at the
TOP. Step 5 is the page's answer, in its own words and out of data the engine
never had: the click on `e27` — the ref the agent read as row 1's Take button,
one act earlier, in a snapshot that is still current everywhere the diff did not
contradict it — took `u1`, the row that was inserted above it. Not `r1`. Nothing
in the observation between them said so.

## What this proves, stated narrowly

1. **The defect is real on the shipped build, live, not by code reading.** tier4
   §1.1 established it by throwaway probe against `diff.ts`. This is the same
   finding end-to-end through the walker, the registry, the diff, the renderer
   and the MCP surface, on a page built to the proven positional-family
   construction.
2. **The one op emitted is actively wrong-ended, not merely thin.** `e35` is the
   last row, named as such in the snapshot the agent holds. An agent reading
   `+ after e35:` learns that the list grew at the end. Every other row's ref
   silently changed owner in the same instant.
3. **A held ref retargets in complete silence, on the page's own evidence.** The
   log line is produced from the row's current index into a state array the DOM
   never exposes, so it cannot have been contaminated by anything Aperture
   emitted. `took: u1` is the page saying which row was hit.
4. **G15 discriminates.** It fails on the build with the defect, in both halves,
   and G15a's failure detail carries the wrong-end `add` verbatim. If it passes
   on the post-P2 build, the delta is attributable to the escalation and to
   nothing else — fixture, guard and command line are byte-identical across the
   two runs.
5. Everything else in the guard file (G1–G14, 16 checks) held on this build, so
   the RED is one guard's finding and not a broken apparatus. G14 in particular
   is now green, which is the tier3 fix staying fixed.

## Not proven here, and not claimed

- That the P2 escalation fixes it. That is the post-fix G15 run, in the tier4 §9
  battery, item 6.
- That the restatement is *cheap*. G15 says nothing about size; tier4 §1.4 owns
  the economics argument and the append false-positive it accepts.
- Anything about equal-size same-walk churn (tier4 §1.4 residual 1) or a member
  moved in from elsewhere (residual 2). This fixture produces neither, by
  construction, and no fixture can produce the first.
- Anything about the wave-3 task fixtures' behaviour. Those are removals-only, so
  P2 must be unreachable on them; the byte-level check of that claim is the
  appendix below and battery item 8, not this guard.

---

# Appendix — §1.7 pre-landing byte capture (G2 notes, all five wave-3 tasks)

tier4 §1.7 requires the live wire behaviour of the removals-only wave-3 fixtures
to be pinned BEFORE the bundle lands, so that "P2 is unreachable on them" is a
measured claim and not an argued one. This is that capture: the G2 notes table
from `npm run bench:task -- --selftest` on the same pre-fix `out/` bundle
recorded above, per task × arm, `obs F/D/N` counts and `obsChars`.

After the bundle lands and rebuilds, the same command must reproduce these
numbers EXACTLY. Any drift is a stop-ship finding, to be diagnosed before the
battery proceeds (tier4 §9 item 8).

## The capture — exact command

```
cd C:\Users\cunni\dev\aperture && node bench/task.mjs --selftest
```

Run 2026-08-02 02:44:11 -0400, on the same pre-fix `out/` bundle (the two `out/`
hashes in the provenance table were re-verified after this run and are
unchanged; `--selftest` starts and owns its own Aperture and its own fixture
server, so the guard-run instance and the scratchpad fixture server were both
torn down first and ports 8817/8899 were confirmed free).

Identity block as printed:

| field | value |
|---|---|
| suiteVersion | `2026-08-03.1` |
| codeVersion | `42b731b17b75fe45` |
| **buildVersion** | **`469784c4c2c2d98e`** — the pre-fix `out/`, and the thing this capture is a property of |
| git | `15b633b` · watched files DIRTY (uncommitted edits) · tree dirty |
| prompt | sha256 `e4ddb5e1b6f1df2d` |
| tool surface | sha256 `95e5cb6c40ebac78` |
| model | claude-sonnet-5 (scripted solver; no API budget spent) |
| aperture log | `bench/task/results/aperture.20260802T064411Z.log` |

`codeVersion` and the DIRTY marker are expected and are not a defect of the
capture: Builder B's `src/` edits were already on disk (see the provenance
table), and `codeVersion` hashes source. What the numbers below are a property
of is `buildVersion` — the bundle that actually ran — and that is the pre-fix
one, unchanged and unrebuilt.

## The numbers — the pin

```
G2 scripted solver — must pass in BOTH arms, and each task's winning
   information must be shown to arrive through a diff
  queue-positional     diff    SOLVED  8 steps · 7 page actions · obs 1F/7D/0N · 4870 chars
  queue-positional     redump  SOLVED  8 steps · 7 page actions · obs 8F/0D/0N · 5786 chars
  twin-queues          diff    SOLVED  12 steps · 11 page actions · obs 1F/11D/0N · 7629 chars
  twin-queues          redump  SOLVED  12 steps · 11 page actions · obs 12F/0D/0N · 14793 chars
  queue-resync         diff    SOLVED  17 steps · 16 page actions · obs 5F/12D/0N · 19089 chars
  queue-resync         redump  SOLVED  17 steps · 16 page actions · obs 17F/0D/0N · 20601 chars
  wizard-submit        diff    SOLVED  7 steps · 6 page actions · obs 1F/6D/0N · 2674 chars
  wizard-submit        redump  SOLVED  7 steps · 6 page actions · obs 7F/0D/0N · 4273 chars
  ledger-balance       diff    SOLVED  7 steps · 6 page actions · obs 1F/6D/0N · 1620 chars
  ledger-balance       redump  SOLVED  7 steps · 6 page actions · obs 7F/0D/0N · 3583 chars
G2 PASS
```

The same, as the table battery item 8 compares against:

| task | arm | steps | page actions | obs F/D/N | obsChars |
|---|---|---|---|---|---|
| queue-positional | diff | 8 | 7 | 1F/7D/0N | 4870 |
| queue-positional | redump | 8 | 7 | 8F/0D/0N | 5786 |
| twin-queues | diff | 12 | 11 | 1F/11D/0N | 7629 |
| twin-queues | redump | 12 | 11 | 12F/0D/0N | 14793 |
| queue-resync | diff | 17 | 16 | 5F/12D/0N | 19089 |
| queue-resync | redump | 17 | 16 | 17F/0D/0N | 20601 |
| wizard-submit | diff | 7 | 6 | 1F/6D/0N | 2674 |
| wizard-submit | redump | 7 | 6 | 7F/0D/0N | 4273 |
| ledger-balance | diff | 7 | 6 | 1F/6D/0N | 1620 |
| ledger-balance | redump | 7 | 6 | 7F/0D/0N | 3583 |

G1 (null-agent) snapshot sizes from the same run, pinned for the same reason —
they are the fixtures' resting wire size and P2 must not move them either:

| task | fixture | snapshot chars |
|---|---|---|
| queue-positional | queue.html | 1092 |
| twin-queues | twinqueue.html | 1932 |
| queue-resync | queue16.html | 2067 |
| wizard-submit | wizard.html | 459 |
| ledger-balance | ledger.html | 369 |

Result: `SELFTEST PASS — G1, G2 and the liveness canary green, no API budget
spent.` Exit code 0. The T2 (twin-queues interview/deliveries scoping) and T4
(`a:full` resync crossing) streamAsserts ran unmodified inside this run and
passed; the G6b liveness canary passed.

**A control, run because the pin would otherwise be ambiguous.** Builder A's
own items (§2's classifier, §3's stamp, §4's report block, §6.3's summary) edit
`bench/task.mjs`, `bench/lib/proxy.mjs` and `bench/lib/streamModel.mjs` — all of
them WATCH_FILES, all of them on the path every one of these numbers travels.
So the command was run a SECOND time, 2026-08-02 02:59:59 -0400, with every
Builder A edit in place and the same pre-fix `out/` bundle
(`out/main/index.js` sha256 re-verified `84d8452…`, unchanged):

- all ten `obs F/D/N` triples — IDENTICAL
- all ten `obsChars` values — IDENTICAL
- all five G1 snapshot sizes — IDENTICAL
- `SELFTEST PASS`, exit 0

The pin is therefore a property of the BUILD and not of the harness edits that
land beside it, which is what makes battery item 8 a test of the engine change.
If the post-rebuild run drifts, the harness is already excluded as the cause.

**What this appendix licenses.** One thing: an EXACT comparison after the
rebuild. Every one of the ten `obs F/D/N` triples and ten `obsChars` values
above must reproduce identically, and the five G1 snapshot sizes with them.
Equality means P2 never fired on the removals-only wave-3 fixtures and their
wire is byte-stable across the escalation — the §1.7 claim, measured. Any drift,
in any cell, stops the line until it is diagnosed; it would mean either that a
wave-3 fixture is not removals-only after all, or that the escalation reaches
further than §1.3 says. It does not license any cross-build cost comparison:
these are scripted-solver streams, not agent behaviour.

