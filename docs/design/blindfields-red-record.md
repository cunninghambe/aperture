# The blindfields RED, recorded against the pre-fix build

Required evidence for tier2b F4: *"run `blindfields` against the CURRENT build
before landing the engine fix, and record the RED. An instrument change that has
never seen the defect it claims to catch is the false green all over again."*

This file is that record. Everything below is verbatim output, produced
2026-08-01, and none of it is reproducible again once tier2b Set B lands — which
is the point of writing it down.

---

## 1. The build under measurement, identified three ways

| | |
|---|---|
| git HEAD | `f3ee59b985d44a798075f5341e54d625b25e359f` (`f3ee59b`, tree dirty with Set A bench edits only) |
| `buildVersion` | **`afc408d7b0895342`** — byte-identical to the build wave 2 ran on (`docs/design/wave2-evaluation.md` §0) |
| `out/main/index.js` | sha256 `2c47ec0671ab7fe6…`, built 2026-08-01 12:00:25 local |
| rebuilt during this recording? | **no.** `electron-vite build` was never run; `out/` is untouched |

`out/` post-dates HEAD's `src/` timestamps, as a build of HEAD should. The
substantive check is not the timestamp but the shipped code, read out of the
bundle that actually ran:

```js
// out/main/index.js — the propDelta the recording ran against
function propDelta(o, n) {
  const d = {};
  let any = false;
  if ((o.name ?? "") !== (n.name ?? "")) { d.name = [o.name ?? "", n.name ?? ""]; any = true; }
  if ((o.value ?? "") !== (n.value ?? "")) { d.value = n.value ?? ""; any = true; }
  if ((o.text ?? "") !== (n.text ?? "")) { d.text = [o.text ?? "", n.text ?? ""]; any = true; }
  const mask = -513;
  const on = n.states & ~o.states & mask;
  const off = o.states & ~n.states & mask;
  if (on) { d.statesOn = on; any = true; }
  if (off) { d.statesOff = off; any = true; }
  return any ? d : null;
}
```

Four fields. No `href`, no `rows`. That is the defect, in the artifact, before
the fix.

Apparatus: fixtures served from `test/fixtures` on `:8899` with
`Cache-Control: no-store`; one `npx electron .` per run (MCP on `:8817`); token
read from `%APPDATA%/aperture/mcp.json`. Both were torn down afterwards.

---

## 2. The wire, before any bench interprets it

The most direct evidence, because it involves no reader, no comparison and no
verdict logic — just what Aperture said when the page changed under it. Each
click rewrites two cells of `<table id="shipments">`; the third rotates a link's
`href`.

```
==== initial full snapshot ====
FULL SNAPSHOT #3.0 — replaces all prior state for this page
page "Shipment roster" http://127.0.0.1:8899/roster.html?probe=1785615622425

main e1 "Roster"
  h1 "Roster"
  generic "Dispatch runs at 17:00 from the Southbank depot."
  table e2 "Shipments" 3x3
    "Order" | "Status" | "Stage"
    "#1001" | "PENDING" | "packing"
    "#1002" | "PENDING" | "packing"
  button e3 "Advance shipment"
  generic "Continue to checkout"
    link e4 "Continue to checkout" /checkout
  button e5 "Rotate link"
  button e6 "Follow"

==== click 1: Advance shipment (e3) ====        [#1001 -> SHIPPED / dispatched]
ok click e3
page #3.1 (diff from #3.0)
~ e3 +focused

==== click 2: Advance shipment AGAIN, focus already on it ====
                                                [#1002 -> CANCELLED / voided]
ok click e3
page #3.1 (unchanged — the action caused no visible change)

==== click 3: Rotate link (e5) ====             [href -> /checkout-v2]
ok click e5
page #3.2 (diff from #3.1)
~ e3 -focused
~ e5 +focused

==== click 4: Rotate link AGAIN (a true no-op) ====
ok click e5
page #3.2 (unchanged — the action caused no visible change)

==== fresh full snapshot (ground truth) ====
FULL SNAPSHOT #4.0 — replaces all prior state for this page
...
  table e2 "Shipments" 3x3
    "Order" | "Status" | "Stage"
    "#1001" | "SHIPPED" | "dispatched"
    "#1002" | "CANCELLED" | "voided"
  button e3 "Advance shipment"
  generic "Continue to checkout"
    link e4 "Continue to checkout" /checkout-v2
```

Read that against the full snapshots either side of it. Six cells and one link
target changed; the diff stream reported **one focus bit, one focus swap, and
"nothing changed"**. The walker saw all of it — the truth snapshot is correct and
complete — so the loss is entirely in `propDelta`'s field set, exactly as the
external review found.

**Note the shape of the two failure modes, because they are not the same
failure.** Click 1 answers with a diff that is *busy and empty*: the agent is
told something happened and told nothing about what. Click 2 answers `(unchanged`
— sincerely, since nothing propDelta looks at moved. The first is worse for a
model and invisible to any tripwire keyed on the word "unchanged"; the second is
the signature tier2b F3 reclassifies.

---

## 3. The scenario: RED, exit 1

`node bench/fidelity.mjs <token> blindfields` — verbatim, `EXIT=1`:

```
# Diff fidelity — scenario "blindfields"

initial full snapshot: 6 refs tracked
step  1 click "Advance shipment" -> e3  diff  model=6 refs

RED: the engine reported "unchanged" for an action the bench knows mutated the page — information is missing from the stream
     step 2: click "Advance shipment" -> e3
     page #1.1 (unchanged — the action caused no visible change)

step  2 click "Advance shipment" -> e3  UNCHANGED  model=6 refs
step  3 click "Rotate link" -> e5  diff  model=6 refs
step  4 click "Follow" -> e6  diff  model=6 refs

refs the agent tracked      : 6
refs verified against page  : 6
PHANTOM refs (do not exist) : 0
WRONG VALUES                : 0
WRONG LABELS                : 0
WRONG ROLES                 : 0
WRONG STATE FLAGS           : 0
WRONG [N options] MARKERS   : 0
WRONG HREF                  : 1
WRONG TABLE CONTENT         : 1
FAILED INDEPENDENT CHECKS   : 3 of 4
refs on page agent never saw: 0 (elision/budget — reported, not scored)
steps: 4 (3 diffs, 0 full resyncs)
observation cost            : 185 tokens for 4 actions

Problems:
  - e2 ("Shipments"): the agent's table content is not the page's.
      agent believes: "Order|Status|Stage\n#1001|PENDING|packing\n#1002|PENDING|packing"
      page holds    : "Order|Status|Stage\n#1001|SHIPPED|dispatched\n#1002|CANCELLED|voided"
  - e4 ("Continue to checkout"): agent has href /checkout, page has /checkout-v2
  - e2: the bench put "SHIPPED" in this table and the stream never delivered it. Model holds: "Order|Status|Stage\n#1001|PENDING|packing\n#1002|PENDING|packing"
  - e2: the bench put "CANCELLED" in this table and the stream never delivered it. Model holds: "Order|Status|Stage\n#1001|PENDING|packing\n#1002|PENDING|packing"
  - e4 ("Continue to checkout"): the bench set this link's target to /checkout-v2 and the stream delivered /checkout — a stable label over a mutated target is precisely the wrong-element action an agent cannot detect

RED: the engine reported "unchanged" for an action the bench knows mutated the page — information is missing from the stream
  - step 2 (click "Advance shipment" -> e3) was answered "unchanged"

RESULT: RED — diffs do not describe the real page
EXIT=1
```

Three independent parts of the instrument fired, and it is worth separating them
because they fail for different reasons and could regress independently:

1. **F2, against the truth snapshot** — `WRONG TABLE CONTENT` and `WRONG HREF`.
   Only possible because F1 taught the shared reader to carry `rows` and `href`.
   Before F1 both sides of this comparison were blind in the same way and
   compared stale-against-fresh as EQUAL.
2. **F4's independent checks** — 3 of 4 failed. These consult no snapshot at all:
   the bench put `SHIPPED`, `CANCELLED` and `/checkout-v2` on the page itself and
   asserts the believed model holds them. They pierce the same-walker caveat,
   and they would have failed even if the walker were wrong too.
3. **F3, the reclassification** — step 2's `(unchanged` is now a RED at exit 1.
   Under the code this bundle replaces it was exit 3, "a step did not run… this
   scenario expects every step to change the page": a no-verdict complaint about
   the scenario, pointing the author at the fixture instead of at the engine.

The fourth independent check (`anyLabel: 'Following'`) passed. It should: the
label morph changes the button's S-tier identity key, so the pre-fix engine
already reports it as a remove plus an add. It is in the scenario as tier2b P2's
validation case, and it is the one thing on this page the pre-fix stream got
right.

---

## 4. One deviation from F4's step list, and why

tier2b F4 orders the steps `advance / rotate / advance / follow` and predicts
"step 1 returns `(unchanged`, F3 fires". **Measured, it does not** — §2 shows
step 1 returning `~ e3 +focused`. A click focuses its target, and a focus flip is
a state delta `propDelta` *does* report, so every step in the specified order
carries one and no step is ever `(unchanged`. Run in the specified order, the
scenario is still RED (exit 1) on F2 and the independent checks alone:

```
step  1 click "Advance shipment" -> e3  diff  model=6 refs
step  2 click "Rotate link" -> e5  diff  model=6 refs
step  3 click "Advance shipment" -> e3  diff  model=6 refs
step  4 click "Follow" -> e6  diff  model=6 refs
...
WRONG HREF                  : 1
WRONG TABLE CONTENT         : 1
FAILED INDEPENDENT CHECKS   : 3 of 4
RESULT: RED — diffs do not describe the real page     (EXIT=1)
```

— but **F3 never fires**, so the tripwire ships having never once seen the defect
it exists to catch, which is the failure mode F4's own evidence requirement
exists to prevent. The two Advance clicks are therefore adjacent (steps 1 and 2)
and the rotate moves to step 3: with no focus move between them, the second click
is a pure content mutation and the engine answers `(unchanged`. Every assertion
in the spec's list is unchanged; only the order moved. Flagged for the spec
author rather than fixed silently.

---

## 5. The extended reader did not break what worked

F1 changes the parser both sides of every fidelity comparison are built from, so
the five existing scenarios were re-run against this same pre-fix build, one per
freshly started Aperture:

| scenario | exit | WRONG HREF | WRONG TABLE CONTENT | verdict |
|---|---|---|---|---|
| form | 0 | 0 | 0 | GREEN (18 refs, 13 diffs, 1 resync) |
| rerender | 0 | 0 | 0 | GREEN (17 refs, 3 diffs) |
| widgets | 0 | 0 | 0 | GREEN (6 refs, 5 diffs, suppression seen) |
| biglist | 0 | 0 | 0 | GREEN (71 refs, 1 diff, 1 resync) |
| selects | 0 | 0 | 0 | GREEN (7 refs, 8 diffs) |

No existing scenario turned RED under the extended reader, and no scenario's ref
counts, diff counts or problem lists moved. The two new counters read zero
everywhere except `blindfields` — including on `rerender` and `selects`, which do
carry links.

`bench/guards.mjs` was run against the same build for the same reason. G1–G12
all hold; the two new guards fail, which is what a tripwire aimed at an unfixed
defect must do:

```
FAIL  G13a  a click that rewrites table cells reports the new cells, not "nothing changed"
        unchanged: false, carries "SHIPPED": false
        page #4.1 (diff from #4.0)
        ~ e19 +focused
FAIL  G13b  a link whose href moves under a stable label reports the new target
        carries "/checkout-v2": false
        page #4.2 (diff from #4.1)
        ~ e19 -focused
        ~ e21 +focused

13/15 guards hold
RESULT: RED — G13a, G13b
```

Note `unchanged: false` on G13a. The guard's `(unchanged` clause passes against
the broken build; only `SHIPPED` catches it. A tripwire written to look for the
word "unchanged" alone would have shipped green over this defect.

---

## 6. What must happen after Set B

The same command, same fixture, GREEN:

```
node bench/fidelity.mjs <token> blindfields      # expect EXIT=0
```

Post-fix, step 2 should carry the rows restatement (`~ e2 3x3:` plus three
indented row lines) and step 3 the `~ e4 href=/checkout-v2` token; the reader in
`bench/lib/streamModel.mjs` already parses both. If `blindfields` goes green
while `WRONG TABLE CONTENT` or `WRONG HREF` cannot be made to fail by reverting
either propDelta comparison, the instrument has regressed and this record is the
thing to re-derive it from.
