# G14 RED record — the W1 false alarm, observed live on the pre-fix build

What this file is: the evidence that G14 discriminates. An instrument that has
never seen the defect it guards is the false green all over again
(`docs/design/tier3.md` §1.6, "Evidence requirement"; the F4 lesson, and the
precedent set by `blindfields-red-record.md`). G14 was authored and run BEFORE
the W1 revision landed, against a build that still contains the shipped,
page-suppressible witness. It FAILED, in exactly the shape Gate 2 described.
Post-fix it must pass; a G14 that has only ever been green would prove nothing.

## The build under test — provenance

| fact | value |
|---|---|
| repo | `C:\Users\cunni\dev\aperture` |
| HEAD | `daf66f14f11087410051fc608cf1fc33fc33939f` ("docs: tier3 spec …", 2026-08-01 17:45:20 -0400) |
| bundle | `out/` as built at **2026-08-01 16:43:55** — every file in `out/` carries that timestamp |
| `out/main/index.js` | sha256 `80a6041b8db8f1c7a8939058…` |
| `out/preload/page.cjs` | sha256 `a1c20a6848dbbe7b987dd05c…` |
| Electron | 43.2.0 · Node v22.14.0 (harness) |
| working tree at run time | Builder A's `bench/guards.mjs` + `test/fixtures/suppressor.html` (this guard, harness-side only); Builder B's in-flight edits to `src/preload/page.ts` (mtime 17:49:58) and `src/core/snapshot/act.ts` (mtime 17:50:15) — **both later than the bundle, neither built** |

**Why this bundle is the PRE-FIX one, checked rather than assumed:**

- `out/preload/page.cjs` contains only the shipped one-shot protocol —
  `aperture:witness`, `aperture:witness-armed`, `aperture:witness-result` — and
  **zero** occurrences of `witness-poll` in either `out/preload/page.cjs` or
  `out/main/index.js`. The revised design's polling channel is not in it.
- `out/main/index.js` carries the OLD error text, verbatim: `input was
  dispatched but never reached the page. The ${action} on ${ref} was sent and
  no matching event arrived in the page…` — not the revised §1.3 wording.
- Every `out/` file is timestamped 16:43:55, which predates HEAD and predates
  Builder B's first src edit by ~66 minutes. No rebuild was run at any point
  before, during, or after this recording.

The witness under test is therefore `armInputWitness` (`src/core/snapshot/act.ts`)
armed by `src/mcp/tools.ts` with `['mousedown']` for a click, at act time, on
the resolved element's `defaultView` — the exact shape Gate 2 falsified.

## The fixture

`test/fixtures/suppressor.html` (new, Builder A). Its first inline script, in
order: (1) a delegated `click` handler on `window` in the capture phase that
appends `<p>acknowledged N time(s)</p>`; (2) `stopImmediatePropagation` capture
handlers on `window` for `pointerdown`, `mousedown`, `mouseup`, `click`,
`keydown`; (3) a `setInterval` dispatching an untrusted synthetic `mousedown`
at the button every 100ms. Below the script: `<button id="s1">Acknowledge</button>`.

The acknowledgement handler is delegated-and-first rather than attached to the
button because `click` is in the suppressed set: a window-capture
`stopImmediatePropagation` stops the event dead, so no handler further down the
path — the button's own included — can run. Registering ahead of the
suppressors is the only construction in which the page stays FUNCTIONAL while
suppressing everything registered after it, and it is the same registration-order
mechanism the revised W1 recorder depends on. (Recorded as a spec-letter
departure in the fixture header; §1.6's own words, "whose click handler appends
a `<p>acknowledged 1 time</p>` line", are satisfied in effect — the guard's
observable is that line, and it appears.)

## The run — exact commands

```
# fixture server (scratchpad, not the repo): test/fixtures on 127.0.0.1:8899, no-store
node C:\Users\cunni\AppData\Local\...\scratchpad\fixserve.cjs

# the pre-fix build, launched from out/
cd C:\Users\cunni\dev\aperture && npx electron .
#   [aperture] MCP server listening on http://127.0.0.1:8817/mcp

node bench/guards.mjs <token>
```

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
FAIL  G14  a page that suppresses input listeners is reported as ok, not as a dead input path
        reply: error: input was dispatched but never reached the page. The click on e24 was sent and no matching event arrived in the page, so Aperture's input path to this tab is not working — retrying this or any 
        begins "ok click": false; page shows "acknowledged 1 time": true
        FALSE ALARM: the click landed and the engine called the input path dead.

15/16 guards hold

RESULT: RED — G14
```

Exit code 1.

## What this proves, stated narrowly

1. **The defect is real on the shipped build, live, not by code reading.** A
   healthy page that intercepts input at window capture gets the terminal
   "Aperture's input path to this tab is not working … needs the browser
   restarted" error.
2. **The alarm is FALSE, on the page's own evidence.** The follow-up full
   snapshot — taken independently of anything the act said about itself —
   contains `acknowledged 1 time`. The click reached the button, the handler
   ran, the DOM changed. Both halves of G14 are load-bearing precisely here:
   the landing half is TRUE in the RED, which is what makes the alarm false.
3. **G14 discriminates.** It fails on the build with the defect. If it passes
   on the post-revision build, the delta is attributable to the revision and to
   nothing else — the fixture, the guard, and the command line are byte-identical
   across the two runs.
4. Everything else in the guard file (G1–G13b, 15 checks) held on this build, so
   the RED is one guard's finding and not a broken apparatus.

## Not proven here, and not claimed

- That the revision fixes it. That is the post-fix G14 run, in the §6 battery.
- That the `isTrusted` filter defeats a real mask. The fixture's synthetic
  `mousedown` flood is itself swallowed by the page's own suppressors on THIS
  build, so pre-fix it exercises nothing; post-fix it arrives at the recorder
  ahead of the suppressors and the filter is what must reject it. Masking a
  genuine wedge remains untestable without a wedge repro (`tier3.md` §1.6, end).
- Anything about subframe targets. G14's page is a top document.
