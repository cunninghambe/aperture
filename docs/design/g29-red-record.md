# G29 RED record — the one-row-off landing, observed live on the pre-fix build

What this file is: the evidence that G29 discriminates. An instrument that has
never seen the defect it guards is the false green all over again
(`docs/design/tier4.md` §0; the F4 lesson, fourth application, after
`blindfields-red-record.md`, `g14-red-record.md` and `g15-red-record.md`). G29
and `test/fixtures/retire.html` were authored and run BEFORE any `src/` edit,
against a build in which a positional family's restatement re-emits the SAME ref
numbers. Three of its four legs FAILED, in exactly the shape
`docs/design/tier5.md` §7.3 predicted in advance — and this file adds what the
green guard can never show again: the page's own record of a held ref taking the
row BELOW the one the agent read.

Post-fix G29 must pass, against the byte-identical fixture, guard and command
line. A G29 that has only ever been green would prove nothing.

## The build under test — provenance

| fact | value |
|---|---|
| repo | `C:\Users\cunni\dev\aperture` |
| HEAD | `e9e460a5590463204b5f7d9ea8029c8e1e841d90` ("docs: tier5 spec — retire positional rebinds; generation-counter alternative ruled out", 2026-08-03 10:36:33 -0400) — a docs-only commit, so the SOURCE this bundle was built from is HEAD's `src/` |
| working tree at HEAD | `src/` untouched. Harness-side only: `bench/guards.mjs` (G29 appended), `test/fixtures/retire.html` (new) |
| bundle | `out/` **rebuilt from HEAD's source at 2026-08-03 10:40** before the run |
| `out/main/index.js` | sha256 `d0ff6c6c6ab58974526a8ab2cffb9d8c2e872c573f4090d83868ebb0ae032dc4` (229572 bytes) |
| `out/preload/page.cjs` | sha256 `7cda2dba0c6ebb7bc392dd7d85867af7b8a659298d0c749d7ef36fee28657b0e` (30506 bytes) |
| Electron | 43.2.0 · Node v22.14.0 (harness) |

**Why this bundle is provably the PRE-FIX one, and provably not stale.** The
`g15-red-record.md` predecessor was measured against a bundle that had not been
rebuilt from its own source, and the review caught it. That failure mode is
closed here by construction rather than by argument:

- `npx electron-vite build` was run against the unedited HEAD source **before**
  the RED run. It reproduced the bundle already on disk **byte for byte** (same
  two sha256s, before and after). So the artifact under test is a true build of
  `e9e460a`'s source — not a stale bundle that happens to sit in `out/`.
- `git show HEAD:src/core/snapshot/diff.ts | grep -c retirePositionalRebinds`
  → **0**, and the same for `retireKey` in `registry.ts` → **0**. Neither half
  of the fix exists in the source this bundle was built from, under any
  spelling.
- The same two commands were re-run after the fix landed: `out/main/index.js`
  moved to `c3970981617bc91e2974af7bf7c1260caa81b480960130a8707d8ef67130d237`
  (232407 bytes) and `retirePositionalRebinds` appears 3× in it.
  `out/preload/page.cjs` is UNCHANGED (`7cda2db…`), which is the mechanical
  statement that this change is main-process only — no preload, no walker
  behaviour, no page-side index change.

The engine under test is therefore `diff.ts`'s P1 escalation as landed by
tier2b and left untouched by tier4: a positional family that lost a member is
restated as one `replace`, `gone` names the refs `byKeyLookup` can still find
(the tail ordinal, because every survivor's key survives), and `assignRefs`
revives every survivor's ref onto whatever row now occupies its position.

## The fixture

`test/fixtures/retire.html` (new), built to `test/fixtures/prepend.html`'s
conventions rather than re-derived — they are copied, because the construction
IS the fixture: content-identical rows, no `<a>` and no `<h1>`–`<h4>` inside a
row or beside a button, no ids/testids on rows or their buttons, the
divider-span-on-every-third-CURRENT-index rule to stay under `COLLAPSE_RUN`,
and a `replaceChildren` re-render.

**Six** rows (`r1`…`r6`), each `<li><span>Ticket</span><button>Take</button></li>`,
in a `<ul aria-label="Tickets">` — six so that the post-removal family of five
still defeats `COLLAPSE_RUN` under the divider rule and the guard can count rows
on both sides of the mutation. `<button id="dismiss-first">Dismiss first
ticket</button>` sits OUTSIDE the list with a distinct label and a non-generated
id, so it keys Tier-1 and can never join the family it mutates; clicking it does
`state.shift()` and re-renders.

The load-bearing part is `#log`. Clicking a Take button does not mutate the
list; it appends `took: <rowId>` resolved by the row's **current index** into the
state array. The row ids exist only in that JS array and are never written into
a DOM attribute, so nothing in the accessibility tree can leak them — the log is
the page's own independent record of which row an act actually hit, and it is
the only reason a silent one-row-off landing is observable from outside the
engine at all.

The fixture header states the construction, cites tier5 §7.1, and records that
the fixture is removal-mutating BY DESIGN and must therefore never be imported
by `bench/tasks.mjs`. It is a GUARD fixture, never a task.

## The run — exact commands

```
# fixture server (scratchpad, never inside the repo): test/fixtures on
# 127.0.0.1:8899 AND 127.0.0.2:8899, Cache-Control: no-store
node <scratchpad>/fixserve.mjs
#   fixtures on http://127.0.0.1:8899
#   fixtures on http://127.0.0.2:8899

# the pre-fix build
<repo>/node_modules/electron/dist/electron.exe <repo> \
    --seed-vault --e2e-consent=allow --e2e-consent-delay-ms=1500

node bench/guards.mjs <token> http://127.0.0.1:8899 --phase=allow
```

Identical fixture, guard file, flags and command line as the post-fix run below.

## The output — verbatim (the G29 section; G1–G28 elided, all 39 of them green)

```
FAIL  G29a  a removal from a positional family retires the whole prior generation, not just the tail ref
        held ref for the 4th row's Take before the removal: e30; replace block: present; gone: [e33] (contains e30: false); Take rows restated: 5 (need >= 5), of which fresh: 0
        pre-click Take refs: [e27 e28 e29 e30 e31 e33]; restated: [e27 e28 e29 e30 e31]
        page #23.1 (diff from #23.0)
        + after e34:
          generic "5 tickets waiting"
        ! e26 replaced (gone: e33):
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
            listitem
              generic "Ticket"
              button e31 "Take"
        ~ e52 +focused
FAIL  G29b  a ref held across the removal refuses, and the page confirms nothing landed
        clicked e30 (the ref read as the 4th row's Take); refused: false; page logged a take: YES
        reply: ok click e30
        generic "took: r5"   <-- LANDED ONE ROW OFF: the agent read this ref as r4
PASS  G29c  the refs the restatement hands over bind to the rows it says they do
        clicked e30 (the 4th Take in the replace block); page logged "took: r5": true
        generic e53 "took: r5took: r5"
FAIL  G29d  a membership change delivered as a FULL snapshot retires the refs too
        observation after the dismiss was a full snapshot: true; clicked e30 (the ref read as the 4th row's Take); refused: false; page logged a take: YES
        reply: ok click e30
        generic e53 "took: r5"   <-- LANDED ONE ROW OFF on the full-snapshot path

40/43 guards hold

RESULT: RED — G29a, G29b, G29d
```

Exit code 1. Every one of the pre-existing 39 checks (G1–G28, including G15 —
the insertion half — and the whole credential path) held on this build, so the
RED is one guard's finding and not a broken apparatus.

Read the detail lines together and the defect is complete in three facts:

1. **`gone: [e33]`** — one ref retired out of six held, and `e33` is the TAIL
   (the highest ordinal), not the row that physically left. The wire
   affirmatively implies `e27`–`e31` are fine.
2. **`restated: [e27 e28 e29 e30 e31]`, of which fresh: 0** — the restatement
   re-emits the SAME numbers the model already holds. A plan captured before
   the removal remains fully executable.
3. **`ok click e30` → `took: r5`** — the ref the agent read as r4's Take took
   r5, the row that slid into fourth place. Not an error, not a refusal: an
   acknowledged click on the wrong row, and the only reason anyone can see it
   is that retire.html keeps its own record.

## The hazard demonstration — the h2h defect reproduced on demand

G29b's green form can never show this again: post-fix the held ref refuses, so
the defect's cost becomes invisible to it. tier5 §7.3 requires it recorded here
instead. A one-off scratchpad probe (`t5hazard.mjs`, never part of the repo),
same build, same fixture, on a freshly launched Aperture so the ref numbers
start at `e1` and the whole sequence is legible:

```
=== 1. the page as the agent first reads it (full snapshot) ===
<untrusted-page-content id=185d5205 origin=http://127.0.0.1:8899>
FULL SNAPSHOT #1.0 — replaces all prior state for this page
page "Dispatch queue" http://127.0.0.1:8899/retire.html?hazard=1785768442165

main e1 "Dispatch queue"
  h1 "Dispatch queue"
  generic "6 tickets waiting"
  list e2 "Tickets"
    listitem
      generic "divider"
      generic "Ticket"
      button e3 "Take"
    listitem
      generic "Ticket"
      button e4 "Take"
    listitem
      generic "Ticket"
      button e5 "Take"
    listitem
      generic "divider"
      generic "Ticket"
      button e6 "Take"
    listitem
      generic "Ticket"
      button e7 "Take"
    listitem
      generic "Ticket"
      button e8 "Take"
  button e9 "Dismiss first ticket"
</untrusted-page-content id=185d5205>

=== 2. what the agent holds ===
Take buttons on the wire  : 6  [e3 e4 e5 e6 e7 e8]
heldRef (the 4th row's Take, i.e. r4's) : e6
"Dismiss first ticket"    : e9

=== 3. the observation the removal produced ===
ok click e9
<untrusted-page-content id=df67fed9 origin=http://127.0.0.1:8899>
page #1.1 (diff from #1.0)
+ after e10:
  generic "5 tickets waiting"
! e2 replaced (gone: e8):
  list e2 "Tickets"
    listitem
      generic "divider"
      generic "Ticket"
      button e3 "Take"
    listitem
      generic "Ticket"
      button e4 "Take"
    listitem
      generic "Ticket"
      button e5 "Take"
    listitem
      generic "divider"
      generic "Ticket"
      button e6 "Take"
    listitem
      generic "Ticket"
      button e7 "Take"
~ e9 +focused
</untrusted-page-content id=df67fed9>

=== 4. the agent now clicks e6 — the ref it read as the 4th row ===
ok click e6
<untrusted-page-content id=5c137a43 origin=http://127.0.0.1:8899>
page #1.2 (diff from #1.1)
~ e6 +focused
~ e9 -focused
+ after e9:
  generic "took: r5"
    generic "took: r5"
</untrusted-page-content id=5c137a43>

=== 5. the page's own record of which row was actually taken ===
  generic "took: r5"
    generic "took: r5"

log says "took: r5" (the row that SLID INTO 4th place): true
log says "took: r4" (the row the agent read)           : false
```

Exit code 0 (the probe reports, it does not judge).

**Read the three halves together.** Step 1 gives the agent six Take refs and
`e6` is the fourth. Step 3 says the list was replaced and retires exactly one
ref — `e8`, the sixth — while restating `e3`…`e7` under their original numbers,
so `e6` is affirmed live and is affirmed to be the fourth row's Take. Step 5 is
the page's answer, out of data the engine never had: the click on `e6` took
`r5`. The agent read `e6` from a snapshot in which it meant r4, was handed a
restatement that agreed it still meant the fourth row, acted once, and hit a
different ticket. This is `docs/design/h2h-evaluation.md` §2.2's wire evidence
reproduced end to end, on demand, in the page's own words.

## The unit half — `test/diff-retire.test.ts`, RED before the fix

Authored before any `src/` edit and run against the unedited source. The
command and both runs:

```
npx vitest run test/diff-retire.test.ts
```

**Run 1 — the file as it ships.** All 11 cases FAIL, every one with
`TypeError: (0 , retirePositionalRebinds) is not a function` (or
`reg.retireKey is not a function` for the two registry cases): the exports do
not exist on the unedited source.

```
      Tests  11 failed (11)
```

**A spec deviation, stated rather than buried.** tier5 §6.1 requires the
GREEN-stable set (cases 6-9) to be *run against unedited src and PASS*. That is
impossible as literally written for a file whose helper calls a function the
unedited source does not export — the helper mirrors `engine.ts`'s ordering, as
§6.1 also requires, so every case in the file goes through it. So run 1 is the
honest RED, and run 2 measures what §6.1 actually wanted:

**Run 2 — the same file with the pre-pass call stubbed to a no-op** (a
scratchpad copy, `test/zz-t5-greenstable.test.ts`, deleted immediately after;
the ONLY edit is `retirePositionalRebinds(...)` → a function returning an empty
`Map`, which is exactly what the post-fix pre-pass returns when it does not
fire). This puts the unedited ENGINE under every assertion:

```
   × 1. a 7 -> 6 removal retires every prior ref and mints fresh ones
     → expected [ 'e9' ] to deeply equal [ 'e3', 'e4', 'e5', 'e6', 'e7', …(2) ]
   × 2. the held ref is dead and its key now names a different ref
     → expected 'e6' not to be 'e6' // Object.is equality
   × 3. a prepend 6 -> 7 retires the prior generation too (the P2 path)
     → expected [] to deeply equal [ 'e3', 'e4', 'e5', 'e6', 'e7', 'e8' ]
   × 4. a family BORN around a held ref retires the bare key (1 -> 2)
     → expected 'live' to be 'dead' // Object.is equality
   × 5. a family that disappears and returns with new membership does not revive
     → expected [ 'e3', 'e4' ] to deeply equal []
   × retireKey severs the revival path > a retired key mints a fresh ref, …
     → reg.retireKey is not a function
   × retireKey severs the revival path > retiring an unknown key is a no-op
     → reg.retireKey is not a function
   ✓ 6. a content-keyed list loses one member and no sibling ref moves
   ✓ 7. a pure re-walk of a positional family retires nothing and revives every ref
   ✓ 8. equal-size same-walk churn is silent, and stays silent
   ✓ 9. gone omits refs the model was never shown

      Tests  7 failed | 4 passed (11)
```

Case 1's failure line is the defect in one assertion — `['e9']` where the whole
generation was owed. Case 2's is the same fact from the identity side: the 4th
row's key still answers `e6`, the very number the agent holds. Case 5 is
revival across absence: two refs from a walk three snapshots ago came back to
life on rows that are not theirs. **Cases 6-9 pass on the unedited engine** —
they are the pin that content-keyed identity, the re-snapshot survival property
(`bench/RESULTS.md` §B), the documented silence on equal-size same-walk churn
and the `wasEmitted` token discipline are not what this change is altering.

## Post-fix — the same guard, the same fixture, the same command line

```
PASS  G29a  a removal from a positional family retires the whole prior generation, not just the tail ref
        held ref for the 4th row's Take before the removal: e60; replace block: present; gone: [e57 e58 e59 e60 e61 e62] (contains e60: true); Take rows restated: 5 (need >= 5), of which fresh: 5
        pre-click Take refs: [e57 e58 e59 e60 e61 e62]; restated: [e64 e65 e66 e67 e68]
        page #23.1 (diff from #23.0)
        + after e39:
          generic "5 tickets waiting"
        ! e26 replaced (gone: e57 e58 e59 e60 e61 e62):
          list e26 "Tickets"
            listitem
              generic "divider"
              generic "Ticket"
              button e64 "Take"
            listitem
              generic "Ticket"
              button e65 "Take"
            listitem
              generic "Ticket"
              button e66 "Take"
            listitem
              generic "divider"
              generic "Ticket"
              button e67 "Take"
            listitem
              generic "Ticket"
              button e68 "Take"
        ~ e63 +focused
PASS  G29b  a ref held across the removal refuses, and the page confirms nothing landed
        clicked e60 (the ref read as the 4th row's Take); refused: true; page logged a take: no
        reply: error: e60 could not be acted on (gone).
        (no log line on the page — nothing landed)
PASS  G29c  the refs the restatement hands over bind to the rows it says they do
        clicked e67 (the 4th Take in the replace block); page logged "took: r5": true
        generic "took: r5"
PASS  G29d  a membership change delivered as a FULL snapshot retires the refs too
        observation after the dismiss was a full snapshot: true; clicked e72 (the ref read as the 4th row's Take); refused: true; page logged a take: no
        reply: error: e72 could not be acted on (gone).
        (no log line on the page — nothing landed)

43/43 guards hold

RESULT: GREEN
```

Exit code 0. `--phase=deny` 3/3 GREEN and `--phase=none` 2/2 GREEN on the same
build. The container's ref (`e26`) is unchanged across the mutation on both
builds, which is the scoping claim asserted on the wire: content-keyed identity
is not touched.

## What this proves, stated narrowly

1. **The defect is real on the shipped build, live, not by code reading.**
   h2h-evaluation §2 established it from an archived cohort's streams; tier5
   §1.2 re-established it by constructed-node probe. This is the same finding
   end to end through the walker, the registry, the diff, the renderer and the
   MCP surface, on a page built to the proven positional-family construction.
2. **The restatement was the lie, not the omission.** `gone: [e33]` is not
   merely thin: combined with a restatement carrying the original numbers, it
   is an affirmative statement that five refs still mean what they meant. Step
   5 of the hazard probe is the page saying otherwise.
3. **A held ref retargets in complete silence, on the page's own evidence.**
   The log line is produced from the row's current index into a state array the
   DOM never exposes, so it cannot have been contaminated by anything Aperture
   emitted.
4. **The two halves are independent and both are load-bearing.** G29a fails on
   the wire, G29b on the act path, G29d on the full-delivery path — and G29c
   PASSES pre-fix, which is what says the pre-fix restatement was already
   truthful about ROWS and false only about REFS. The sabotage appendix below
   turns that argument into three measurements.
5. **G29 discriminates.** It fails on the build with the defect, in three legs,
   and its failure detail carries the wrong row's id verbatim. Fixture, guard
   and command line are byte-identical across the two runs.

## Not proven here, and not claimed

- That the fix improves agent behaviour. That is `docs/design/tier5.md` §9's
  deferred cohort, and no free-battery item can speak to it.
- That the restatement is cheap. G29 says nothing about size; §2.2 owns the
  cost argument and §9.1.1's tripwire is the check on it — **which fired; see
  the tripwire note at the end of this file.**
- Anything about equal-size same-walk churn (tier4 §1.4 residual 1) or the
  degenerate cross-parent same-base construction (tier5 §4 residual 6). This
  fixture produces neither, by construction, and no fixture can produce the
  first.

---

# Appendix A — the sabotage battery (the discrimination proof)

tier5 §7.4. Each row is one exact one-line string replacement applied to the
**shipped** (post-fix, unlanded) source by a patcher that **refuses unless the
target text occurs exactly once**. Per row: apply, `npx electron-vite build`,
run the unit files against the sabotaged source, launch, run the full
allow-phase guard set, revert **by saved buffer** (never `git checkout` — the
working tree holds the whole unlanded change set), rebuild.

Every live run was
`electron.exe <repo> --seed-vault --e2e-consent=allow --e2e-consent-delay-ms=1500`
followed by `node bench/guards.mjs <token> http://127.0.0.1:8899 --phase=allow`,
with the fixture server on both `127.0.0.1:8899` and `127.0.0.2:8899` — the
byte-identical fixture, guard and command line as the green run above.

Clean-build baseline for the unit column: `npx vitest run test/diff-retire.test.ts
test/diff-rebinding.test.ts` → **19 passed (19)**; guards → **43/43 GREEN**,
`out/main/index.js` `c3970981617b…`.

| # | sabotage (as applied, to the shipped source) | must turn RED | observed, 2026-08-03 |
|---|---|---|---|
| S-T5-1 | `src/core/snapshot/engine.ts`: the pre-pass call `? retirePositionalRebinds(st.last.root, r.root, st.registry)` → `? undefined` (so `const retired = st.last ? undefined : undefined`) — identity retirement dead, wire code and act path untouched | G29a, G29b, G29d | **40/43 · RED — G29a, G29b, G29d**, and only those. Unit files **19/19 GREEN** — see the note below; this row cannot reach them. Build `b6eb59b7890c…` |
| S-T5-2 | `src/mcp/tools.ts`: the act branch's `if (entry.state === 'dead') {` → `if (false) {` — the wire stays honest, the dead ref resolves | G29b, G29d | **41/43 · RED — G29b, G29d**, and only those. G29a PASSES with `gone: [e57 e58 e59 e60 e61 e62]` and all five restated refs fresh, and the held ref STILL LANDS: `reply: ok click e60` / `generic "took: r5"`. Unit **19/19 GREEN**. Build `21ab700c4778…` |
| S-T5-3 | `src/core/snapshot/diff.ts`: `buryUnder`'s retired branch `if (retiredRef) {` → `if (false && retiredRef) {` — identity and refusal intact, the wire lies by omission | G29a; unit 1, 3 | **42/43 · RED — G29a**, and only it, with `gone: []` while the restated refs are all fresh. Unit **5 failed / 14 passed**: diff-retire 1 and 3, plus diff-rebinding 1, 7 and 8 (the re-pinned removal cases). Build `b6312028a0b3…` |

**The three rows are the argument, measured.** tier5's central claim is that
either half alone is cosmetic, and S-T5-2 is that claim as a number: with the
identity half fully intact — `gone` naming all six prior refs, every restated
ref fresh, the wire perfect — the held ref still lands and `retire.html` still
logs `took: r5`. S-T5-3 is the mirror: refusal and re-minting both work, and the
model is simply never told its refs died. S-T5-1 removes the identity half and
takes both other legs with it, which is what says the pre-pass is upstream of
everything.

**One expectation in §7.4's table did not hold, and it is a spec defect rather
than a build defect.** §7.4 predicts unit cases 1-5 RED for S-T5-1. They cannot
be: §6.1 mandates the constructed-node style, so `test/diff-retire.test.ts`'s
`observe` helper MIRRORS `engine.ts`'s ordering (pre-pass → `assignRefs` →
`diffSnapshots`) by calling `retirePositionalRebinds` itself. It never imports
`engine.ts` — no unit test in this repo does, because that module imports
`electron`. So a sabotage of the engine's CALL SITE is invisible to every unit
test, and the live guards are the only instrument that covers that wiring. The
three legs G29a/G29b/G29d are what caught it, which is the argument for G29
existing at all; but the table's unit column for S-T5-1 should read "none".

---

# Appendix B — the §9.1.1 tripwire FIRED, and what it is

tier5 §9.1.1 preregisters a free, at-landing tripwire: run the h2h scripted
solver across the fixture set and require **zero retirement events on the six
neutral fixtures**, because §2.2's economics argument rests on the claim that
"the mechanism cannot fire where the claim lives". §9.3.3 makes a firing a
stop-ship, "not a cohort question". **It fired.** This appendix is the
diagnosis §9.1.1 demands, and no more: the ruling is the coordinator's.

## How it was measured

`node bench/headtohead/h2h.mjs --selftest --store <scratchpad>/…jsonl` — H0–H5
preflights, live infra, **$0 budget, no scored wave, no cohort**. `--store`
points at a scratchpad path so the archived cohort is neither read, extended
nor archived. Run twice: once on the pre-fix bundle `d0ff6c6c6ab5…` (rebuilt
from HEAD source, hash re-verified) and once on the shipped `c3970981617b…`.

Both runs report `PREFLIGHTS RED — 54 problem(s) across H1, H2, H2b, H3`, and
every one of the 54 is a **pw-arm** problem (`--snapshot-mode full is not live`,
`the fixture never reported to the collector … --allowed-origins`, pw-stock's
solver resolving 0 elements). Not one names an aperture arm. Re-running with
`--arms aperture-diff,aperture-redump` prints `PREFLIGHTS GREEN — H0-H5 (+H2b)
all pass`. The Playwright side of that harness is broken independently of
anything tier5 touches, on both builds identically.

## The numbers — aperture-diff scripted stream, observation chars

| fixture | class | pre-fix | post-fix | Δ |
|---|---|---|---|---|
| booking-form | neutral-small | 3069 | 3087 | +18 |
| inventory-pick | neutral-small | 2078 | 2074 | −4 |
| account-prefs | neutral-small | 2624 | 2636 | +12 |
| **journal-comment** | **neutral-large** | **23276** (5 steps · 1F/4D) | **45607** (6 steps · 2F/4D) | **+22331 (+96%)** |
| console-quota | neutral-large | 24953 | 24965 | +12 |
| catalog-order | neutral-large | 24944 | 24947 | +3 |
| queue-positional | home | 5133 | 5385 | +252 |
| twin-queues | home | 7884 | 8184 | +300 |
| queue-resync | home | 19970 | 20906 | +936 |
| wizard-submit | home | 2782 | 2782 | 0 |
| ledger-balance | home | 1970 | 1970 | 0 |

The ±3-to-18-char rows are ref-number WIDTH, not mechanism: the registry counter
is per tab and shared across episodes in one run, so minting refs anywhere
pushes later refs from `eNN` to `eNNN`. The home rows are the designed churn
(§5). **`journal-comment` is the firing**, and it reproduces with the task run
alone (`--tasks journal-comment`): pre-fix 5 steps / 23192 chars, post-fix
6 steps / 45404 chars. The re-dump arm is unmoved (133133 → 133054), so this is
a diff-arm cost — i.e. it lands exactly on the ratio the economics claim is
made of.

## What actually fires, reproduced directly on both builds

`journal-comment.html`'s rating control is five `<li>`-like wrappers each
containing one radio. Every INTERACTIVE element has a unique accessible name
("1 star" … "5 stars"), so headtohead §4.2 rule 2 holds and the H5 lint is
green. But the wrappers are `generic` with no explicit name and no `<a>`/`<h*>`
discriminator, so they are content-identical TO THE WALKER, `disambiguate`
gives them ordinals, and **they are a positional family.** Aperture renders the
group as `… 2 more generics (radio)` — `COLLAPSE_RUN` is 5 and the group is
exactly 5.

The trigger is tier5 §4's revival-across-absence case (unit case 5): posting the
comment runs `document.getElementById("c-panel").replaceChildren(h, p)`, so the
whole rating group LEAVES the page; a later visit brings it back. A scratchpad
probe drives exactly that sequence — fresh page, fill, expand, click 4 stars,
submit, re-navigate, snapshot — on each bundle:

```
### PRE-FIX d0ff6c6
[1] fresh page      : … | radio e127 "3 stars" | … 2 more generics (radio)
    star4=e128 (via expand)
[2] after submit    : panel replaced: true
[3] after re-visit  : … | generic "4 stars" | radio e128 "4 stars" | generic "5 stars" | radio e129 "5 stars"
    collapsed: false

### POST-FIX c397098
[1] fresh page      : … | radio e127 "3 stars" | … 2 more generics (radio)
    star4=e128 (via expand)
[2] after submit    : panel replaced: true
[3] after re-visit  : … | radio e156 "3 stars" | … 2 more generics (radio)
    collapsed: true
```

Pre-fix, the returning wrappers REVIVE their old refs, those refs carry
`needsReannounce` (they were emitted and then buried by the panel replace), and
`render.ts`'s `runOwesReannounce` therefore refuses to collapse the run — so
`star-4` is directly addressable and the scripted solver never pays the expand
round-trip. Post-fix the pre-pass retires that family at the re-visit (the key
set went from absent to present), the wrappers get FRESH refs (`e125…` →
`e154…`), a never-emitted ref owes no re-announcement, and the run collapses as
`COLLAPSE_RUN` says it should — costing one `browser_snapshot {expand:true}`,
which on a neutral-LARGE page is ~22K chars.

## The honest reading, both ways

**Against the fix.** §2.2's stratum argument is wrong as written. It reasons
from rule 2 — no identical-sibling INTERACTIVE elements — to "no family can
form"; but positional families form from any node class, and a neutral-large
fixture contains one built out of non-interactive wrappers. The tripwire was
written to catch exactly this inference, and it caught it. The measured cost
lands on the diff arm of the class that carries the licensed economics claim.

**For the fix.** The post-fix behaviour is what the rest of the system already
says is correct. `runOwesReannounce` exists to stop a *silent revival* — a run
that brings a previously-emitted, previously-dead ref back to life owes the
model a line it can restore the ref from. After retirement there is no revival:
the refs are new, were never emitted, and nothing is being taken away silently,
so the run is an ordinary collapsed run and `expand` is its documented
affordance. h2h.mjs's own scripted-solver comment pre-ruled on this fixture:
"a 1-to-5 star rating group is exactly five, so `star-4` and `star-5` are behind
`… 2 more` … the scripted solver therefore pays it the way an agent would have
to", citing headtohead §4.3's "if it costs an expand round-trip, that cost is
real and belongs in the number". By that ruling the PRE-fix stream was the
anomaly — it skipped a round-trip the spec says the agent must pay, and it did
so because of a re-announcement obligation attached to a revival that tier5
rules out.

**What is NOT claimed.** That the ~22K is what an agent would pay: this is a
scripted solver, and an agent that reads the collapsed line may act differently.
That the neutral-large ratio moves by any particular amount in a scored cohort —
no scored benchmark was run, per instruction. That any other neutral fixture is
affected: `console-quota` and `catalog-order` moved by 12 and 3 chars, which is
ref width alone.

**What this appendix owes the coordinator.** A ruling on §9.1.1, before §9.1.2's
cohort: either the tripwire's terms are met after re-scoping (the firing is one
fixture, one construction, and arguably a correction), or §2.2's cost argument
is re-derived with non-interactive families included. The builder has not
assumed either.
