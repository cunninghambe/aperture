# Tier 3 — the pre-wave-3 bundle: W1 revision, wedge instrumentation, wave-3 suite

Status: SPEC, decision-complete. Written 2026-08-02 against `master` at
`3830a34`. Companions: `gate2-review.md` (the W1 HIGH this revises),
`wave2-evaluation.md` (§4 is the wave-3 outline this makes concrete, §6 is the
instrumentation ruling this builds), `tier2b.md` (the landed engine work wave 3
measures). Implementers execute verbatim.

**Why one bundle, restated as a constraint:** any edit to a watched src file
moves `codeVersion`/`buildVersion` and severs a running cohort, and wave 3 is
multi-hour. Therefore every src-touching item below — the W1 revision (§1), the
instrumentation (§2), and the harness/suite work (§3, §4) — lands in ONE change
set, is verified by ONE battery, and only then does wave 3 launch under
`--new-cohort`. Any sequencing that runs a scored episode between two src
landings is wrong by construction. The same fact works in our favor mid-wave:
**nothing in this file may be edited once the wave-3 pilot has run** — the
integrity guard enforces it mechanically (exit 6), and that is the point.

Two facts in this file were established by live probe during its writing; both
probes are recorded in §8 and their throwaway artifacts deleted.

---

## 1. Item 1 — the W1 revision (Gate-2 HIGH: page-suppressible witness)

### 1.1 The defect, precisely

The shipped W1 arms a one-shot capture-phase listener on the resolved target's
window AT ACT TIME (`src/preload/page.ts:204-251`). Gate 2 proved live that a
main-world `window.addEventListener('mousedown', e =>
e.stopImmediatePropagation(), true)` suppresses that listener on Electron 43 —
isolated worlds share the per-node listener list for dispatch purposes, and
`stopImmediatePropagation` kills every listener REGISTERED LATER on that node.
The page's handler was registered at page-parse time; W1's is registered at act
time; the page wins. Result: a click that LANDS (the fixture's counter
incremented) returns the terminal "input was dispatched but never reached the
page … needs the browser restarted" error. W1 currently converts a healthy
page — the drag/overlay/editor-library class that intercepts `mousedown` at
window capture — into a false browser-is-broken alarm.

### 1.2 The candidates, ruled on

- **CDP dispatch acknowledgment** — REJECTED, on wave 2's own evidence. During
  the wedge, `debugger.sendCommand('Input.dispatchMouseEvent', …)` RESOLVED for
  40 minutes while nothing reached the page (`wave2-evaluation.md` §6). CDP's
  completion is a statement about the browser process accepting the command,
  not about arrival in the DOM. One live occurrence already falsified it as a
  witness; no probe can rehabilitate it.
- **WebContents `input-event`** — REJECTED as a witness, kept as a note. Probed
  on Electron 43 (§8): the event EXISTS and fires for CDP-dispatched input
  (mouseMove/mouseDown/mouseUp/keyDown/keyUp observed). But the probe's event
  ordering shows it firing BEFORE the page-side listeners see the event — it is
  emitted on the browser-process side of the pipe, i.e. on SEND, not on
  arrival. A wedge that loses input between browser and DOM would very likely
  still fire it (unverifiable without a wedge repro — stated in §8). A witness
  that cannot distinguish the exact failure it exists to catch is not a
  witness.
- **`before-input-event`** — REJECTED: keyboard-only in Electron; no coverage
  for clicks, which are the wedge's proven surface.
- **DOM-effect heuristics** ("no diff after an ok act ⇒ suspect") — REJECTED as
  the primary signal: "the action caused no visible change" is a legitimate
  finding about the page (a click on a dead button), and recolouring it as an
  engine failure is precisely what W1's spec forbids.
- **Demoting `lost` to retry-then-advisory** — REJECTED alone: it keeps the
  false-positive class and merely softens the blast radius, and it weakens the
  true-positive (a real wedge would ack `ok` with an advisory nobody reads).
  A bounded retry is RETAINED as a component (§1.3, step 4) — as protection
  against a busy main thread delaying delivery, not as the fix.
- **A witness the page cannot preempt: a persistent, document_start-registered,
  isolated-world event recorder** — **CHOSEN**, and the premise was verified by
  probe on Electron 43 (§8): a capture-phase listener on `window` registered in
  the preload (which runs before any page script) STILL FIRES for every
  CDP-dispatched event even when the page registers `stopImmediatePropagation`
  capture handlers for ALL of pointerdown/mousedown/mouseup/click/keydown.
  Listener-list order is registration order; the preload registers first;
  `stopImmediatePropagation` only silences listeners AFTER the caller. The same
  probe reproduced the Gate-2 false alarm exactly (a listener registered after
  page load observed ZERO trusted events), and confirmed CDP-dispatched events
  carry `isTrusted: true` while page-synthesized events carry
  `isTrusted: false` — so the recorder cannot be fed by a hostile page
  dispatching fake events to mask a real wedge.

### 1.3 The design — exact

**Preload (`src/preload/page.ts`), Builder B:**

1. At preload top level (document_start, before any page script), install the
   **input recorder**: for `TYPES = ['pointerdown', 'mousedown', 'mouseup',
   'click', 'keydown', 'wheel', 'mousemove']`, register one capture-phase
   listener each on `window` (`{ capture: true, passive: true }`). Each
   handler does exactly: `if (e.isTrusted) counts[e.type]++`. No
   stopPropagation, no preventDefault, no per-event IPC. `counts` lives in the
   isolated world; the page holds no reference to it or to the listeners.
2. New IPC request `aperture:witness-poll` → reply on
   `aperture:witness-poll-result` with
   `{ ok: true, top: boolean, counts: { [type]: number } }`, where `top` is
   whether the polled key's element (when a `key` is supplied) satisfies
   `el.ownerDocument === document` — i.e. lives in the top document the
   recorder covers. With no `key` (scroll/key acts), `top: true`. A missing or
   disconnected element replies `{ ok: false, reason: 'gone' }` (fixed
   vocabulary, same rule as today — these strings land outside the envelope).
3. The existing one-shot `aperture:witness` arm/result protocol is KEPT, used
   ONLY for subframe targets (`top: false`) — see verdict rules below. Its
   listener target stays `el.ownerDocument.defaultView`.
4. **Comment rewrite (required by Gate 2):** delete the false claim that
   window-capture registration at act time is unsuppressable ("no page handler
   can `stopPropagation` its way out of being observed" — empirically false).
   The new comment states the true mechanism: registration ORDER is the
   guarantee; the recorder registers at document_start, before any page script
   can run, so no later-registered handler can suppress it
   (`stopImmediatePropagation` only silences later registrations); probed on
   Electron 43, 2026-08-02, hostile all-type suppressor fixture; and the
   `isTrusted` filter is what stops a page from forging arrivals.

**Main (`src/core/snapshot/act.ts`), Builder B:**

Replace `armInputWitness` with `witnessInput(wc, key, kinds)`:

1. **Baseline poll** before dispatch: send `aperture:witness-poll`; 1000ms
   timeout. No reply, or `ok: false` → the witness is in **unknown mode**:
   `settle()` returns `'unknown'` unconditionally. (A mechanism that turns its
   own unavailability into an error would invent failures — unchanged rule.)
2. If `top: false` → **subframe mode**: arm the one-shot listener exactly as
   today; `settle()` maps fired → `'landed'`, silent → `'unknown'`. NEVER
   `'lost'`: the recorder cannot corroborate across the frame boundary and the
   one-shot alone is page-suppressible — Gate 2 proved a suppressible witness
   must not be allowed to say `lost`. Residual: a wedge affecting only
   subframe input still acks `ok`. Accepted and stated; bounded by the bench
   liveness canary, whose fixture is a top-document page.
3. If `top: true` → **recorder mode**. `settle(ms = 500)`: wait `ms` after
   dispatch, re-poll, compare counts over the action's RELEVANT SET (below).
   Any relevant counter advanced → `'landed'`.
4. Nothing advanced → **one bounded retry**: wait a further 2000ms (2500ms
   total post-dispatch), re-poll. Advanced → `'landed'`. Still frozen →
   `'lost'`. WHY the retry: a page main thread blocked by a long task delivers
   the event late; 500ms of silence on a busy-but-alive page must not produce
   the terminal error. A wedge is not a latency phenomenon — wave 2's was
   absolute silence for 40 minutes — so 2.5s costs nothing in detection power.
   A re-poll that itself fails → `'unknown'` (the apparatus went away
   mid-settle; do not guess).

Relevant sets, by action:

| action | relevant counters |
|---|---|
| click | pointerdown, mousedown, mouseup, click |
| clear, type | pointerdown, mousedown, mouseup, click, keydown |
| hover | mousemove |
| scroll | wheel |
| key | keydown |

**Tools (`src/mcp/tools.ts`), Builder B:**

- The element-targeted branch swaps `armInputWitness` for `witnessInput`
  (refusal ordering unchanged: every refusal that dispatches nothing settles
  BEFORE the baseline poll — existing act.test.ts assertions preserved).
- **Scroll and key are now witnessed too** (recorder mode, no `key` supplied
  to the poll). This closes the Gate-2 open item "W1 does not cover
  scroll/key"; a wedge can no longer ack `ok` through scroll acts (wave 2's
  `queue-positional redump run13` scroll would have been witnessable).
- `'lost'` still errors; `'unknown'` and `'landed'` still fall through to
  `observe`. The error text is updated to claim exactly what is known:
  `error: input was dispatched but never reached the page. The ${action} was
  sent and no trusted input event was observed in the page within 2.5s
  (checked twice). Aperture's input path to this tab is not working —
  retrying will not take effect. The page was not changed by this call. Tell
  the human; this needs the browser restarted.`
  The substring `input was dispatched but never reached the page` is a
  CROSS-REPO CONTRACT with the bench proxy (§1.5) — Builder B must not reword
  that clause.

### 1.4 Detection semantics, stated as the contract

- `unknown` NEVER fails an act (poll dead, subframe-and-silent, arming failed,
  re-poll failed). Unchanged from the shipped W1.
- `lost` — and therefore the error — requires ALL of: top-document target (or
  targetless scroll/key), a live baseline poll, and zero advance across the
  relevant counters at 500ms AND at 2500ms, on counters only trusted events
  can move and only a wedge can freeze (first-registered listeners; probe §8).
  The genuinely dead input path — wave 2's wedge — still errors on the FIRST
  act, exactly as W1 intended.
- A suppressing-but-alive page CANNOT produce `lost`: its suppressors run
  after the recorder and cannot stop it from counting (probed, §8).
- Witnessing is still ARRIVAL, not effect: a click that reaches a dead button
  is `ok` with a `(unchanged` report. Unchanged.

### 1.5 Bench-side companion (Builder A, `bench/lib/proxy.mjs`)

The wedge error is an engine finding, not agent error. Today it would be
attributed `invalid_action` (it is an `^error:` that names no ref), polluting
the one category the wave-2 fix just cleaned. Add, in `doAct`'s attribution:

```js
const INPUT_LOSS = /input was dispatched but never reached the page/;
// order: input loss is checked FIRST — it is the engine's, categorically.
attribution = INPUT_LOSS.test(text) ? 'engine_input_loss'
  : !REF_ERROR.test(text) ? 'invalid_action'
  : shadowHad ? 'engine_ref_loss' : 'model_bookkeeping';
```

And extend the G6b evidence so the quarantine predicate is a LIVE forward
guard again (Gate-2 §3 noted W1 made `deadActs` retrospective — this
supersedes the suggested doc-note by removing the problem):

```js
// task.mjs — deadActsFrom: an acknowledged element action the witness never
// saw (pre-W1 stores) OR an act the engine itself reported as input loss
// (W1-era stores). Both are the same physical event: input that went nowhere.
export function deadActsFrom(acts) {
  return (acts ?? []).filter(
    (a) => ['click', 'type', 'clear'].includes(a.action) &&
      (a.attribution === 'no_page_effect' || a.attribution === 'engine_input_loss'),
  ).length;
}
```

`isWedged` is unchanged in shape. **Acceptance invariant:** recompute the G6b
predicate over the archived wave-2 store
(`bench/task/results/episodes.20260801T160431Z.jsonl`) — it must still
quarantine EXACTLY the terminal six, 3 per arm, 0 false positives on the 245
clean (the wave-2 store contains no `engine_input_loss` string, so the
extension is a no-op there; verify by running, not by this argument).

### 1.6 Test matrix (Item 1)

Unit (`test/act.test.ts` rewrite + additions, Builder B; fake IPC as today):

| # | case | expected |
|---|---|---|
| 1 | click, baseline {mousedown:5}, settle-poll {mousedown:6} | landed → ok |
| 2 | click, only `click` counter advances (mousedown frozen) | landed (any-of-set) |
| 3 | counters frozen at 500ms AND at 2500ms re-poll | lost → the exact error text, containing the §1.5 contract substring |
| 4 | counters frozen at 500ms, advanced at 2500ms re-poll | landed (busy-page rescue) |
| 5 | baseline poll unanswered (1s timeout) | unknown → ok path |
| 6 | settle re-poll unanswered | unknown → ok path |
| 7 | `top:false`, one-shot fires | landed |
| 8 | `top:false`, one-shot silent | unknown — never lost |
| 9 | type: only keydown advances | landed |
| 10 | scroll: wheel frozen twice | lost → error |
| 11 | key: keydown advances | landed |
| 12 | non-editable type / obstruction refusals | settle before any poll; no witness traffic (existing assertions kept) |

Live (Builder A owns the fixture and guard; run against BOTH builds — see
evidence requirement):

- **G14 — the Gate-2 case, permanent.** New fixture
  `test/fixtures/suppressor.html`: first inline script registers
  `stopImmediatePropagation` capture handlers on `window` for pointerdown,
  mousedown, mouseup, click and keydown, AND a `setInterval` flooding
  untrusted synthetic `mousedown` every 100ms (the isTrusted mask case, live);
  below it, `<button id="s1">Acknowledge</button>` whose click handler
  appends a `<p>acknowledged 1 time</p>` line. Guard G14 (in
  `bench/guards.mjs`, after G13b): navigate, full snapshot, click the button
  by label through the model. PASS iff the reply begins `ok click` (not the
  input-loss error) AND a follow-up snapshot contains `acknowledged 1 time`.
- **Evidence requirement (the F4 lesson, again):** run G14 against the
  CURRENT build BEFORE Builder B lands — it must show the false alarm (error
  returned, click landed). Record that RED in the landing commit message. An
  instrument that has never seen the defect it guards is the false green all
  over again.
- **Canary sabotage** re-run in the battery: rename the canary fixture's
  `data-bench`, `--selftest` must exit 3 INFRA; revert. (Proves the
  true-positive path still fires end-to-end post-revision.)

Not testable and said so: the isTrusted filter's failure mode (a wedge masked
by counting synthetic events) cannot be exercised live without a wedge repro;
it is covered by the probe result (synthetic events observed `isTrusted:false`
and filtered) plus review of the two-line handler.

---

## 2. Item 2 — wedge instrumentation (wave2-evaluation §6, unbuilt until now)

### 2.1 Child-log persistence (Builder A)

Extract `startAperture()`/`killTree()` from `bench/task.mjs` into
`bench/lib/aperture.mjs` (task.mjs imports it; `fidelity.mjs`/other spawners
are explicitly NOT refactored in this bundle — smallest blast radius, and the
multi-hour path is the one that needs it). `startAperture()` gains: open a
write stream to `bench/task/results/aperture.<ISO-timestamp>.log` (directory
created if missing; results dir is gitignored by design) and pipe both stdout
and stderr to it AS WELL AS the in-memory tail used by the startup-failure
message. Print the log path once at startup. One file per Aperture start;
never truncated, never rotated (a wave writes one or two). This is the
artifact whose absence made the wave-2 root cause permanently undecidable —
Chromium logs GPU-process death/relaunch to stderr, and wave 2 discarded it.

### 2.2 `getAppMetrics` endpoint (Builder B) and sampling (Builder A)

- **Product side (`src/mcp/server.ts`):** `GET /metrics` on the existing MCP
  HTTP server, same bearer token, localhost-bound as today. Reply:
  `{ pid: process.pid, uptimeS: Math.round(process.uptime()), metrics:
  app.getAppMetrics() }` (the Electron array verbatim: per-process `type`,
  `pid`, `cpu`, `memory`). **Ships in the product path — decided.** WHY: it is
  read-only process metadata behind the existing auth, it costs nothing when
  unpolled, and the next wedge may happen under a human's use, not the
  bench's. Add a short entry to `docs/design/security.md` (new authenticated
  read-only endpoint; no page data crosses it).
- **Bench side (`bench/task.mjs`):** sample `GET /metrics` immediately after
  each pre-episode liveness canary (one localhost GET; ~ms — cheap and
  always-on, as §6 ruled). Two sinks: (a) the full JSON appended as one line
  to `bench/task/results/apparatus.<same-timestamp>.jsonl`; (b) a small stamp
  on the episode row: `apparatus.gpuPid` (the pid of the `type === 'GPU'`
  entry, or null) and `apparatus.procs` (count of entries). Sampling failure
  is recorded (`gpuPid: 'poll-failed'`) and NEVER blocks an episode — the
  canary, not the sampler, is the gate.
- **Report addition:** after the quarantine table, if `apparatus.gpuPid`
  changed between consecutive episodes anywhere in the store, print an
  apparatus note listing the transitions (a GPU pid change is a GPU process
  crash/relaunch — the leading wedge hypothesis). Advisory only; no verdict
  effect. Product-path child-log capture is ruled OUT (the product IS the
  child; a self-capture wrapper is its own project and `getAppMetrics` covers
  the diagnostic need).

Acceptance: after the pilot, `aperture.<ts>.log` exists and is non-empty,
`apparatus.<ts>.jsonl` has one line per scored episode, and every episode row
carries `apparatus.gpuPid`.

---

## 3. Item 3 — the wave-3 suite

### 3.1 Post-P1 prediction for `queue-positional`, and the insertion finding

**Prediction (stated before any wave-3 episode):** P1 changed the engine on
exactly this task's mechanism — a removal from a positional family now emits
ONE `replace` of the container with a full `gone` list (probe-verified at unit
level during this spec: 7→6 identical rows ⇒ `[{op:'replace', gone:4}]`).
Post-P1 the diff arm receives fresh label→ref lines after every removal, so
the diff-arm-specific stale-ordinal increment (wave 2: 8 wrong-el vs 4) should
shrink toward the re-dump arm's intrinsic rate — that was P1's design target
(6→~3 in tier2b's words). `queue-positional` therefore probably discriminates
LESS on wrong-element and success post-P1. It is RETAINED anyway: it is the
only proven discriminator, its post-P1 level is itself the measurement of
whether P1 worked (directional, cross-cohort, never pooled — different
engine), and the intrinsic ordinal difficulty (the re-dump arm's 3 wrong
clicks) is untouched by P1. But wave 3 must not rest on it alone, which is why
T2 and T4 below load the mechanisms P1 does NOT neutralize: cross-family
scoped restatement under interleaved positional work (T2) and positional work
across a forced epoch reset (T4).

**The insertion finding (probe, recorded here, deliberately NOT built into
wave 3).** The §4 outline proposed an interleaved insert+remove task. Probed
at unit level against the landed engine: PREPENDING an identical row into a
6-row positional family emits exactly ONE `add` op — the surviving keys
(`bare, |#1..|#5`) are the same STRINGS bound to different rows, key-based
reconciliation matches them silently, and P1 does not fire (it triggers on
membership LOSS only). Every ref the agent holds shifts one row down with no
notification; the key SET cannot even distinguish prepend from append, so no
diff-side rule can fix this — it needs walker-side rebinding detection, which
is new identity machinery, not a patch. Consequences, ruled:

1. **No insert-mutation task in wave 3.** On an inserting fixture the diff arm
   is wrong BY ENGINE CONSTRUCTION, not by model bookkeeping — the task would
   measure a known engine hole, not the variable under test, and G2 would
   (correctly) refuse it anyway: the scripted solver's `nth` targeting breaks
   and the witness sees the wrong row before any budget is spent.
2. **The hole is recorded as an open engine finding** — it is the same class
   as tier2b's href finding (a page, or an attacker's script, can silently
   retarget every ordinal ref an agent holds by inserting one identical row
   above them). Out of scope for this bundle; tracked for the next engine
   tier. All wave-3 fixtures remain REMOVALS-ONLY, and each new fixture's
   header comment states this constraint and cites this section.

### 3.2 The task set — five tasks, two strata

`bench/tasks.mjs` gains two fields on every task: `stratum:
'discriminative' | 'canary'` and `quota` (target N per arm for that task).
Wave-3 `TASKS`:

| id | fixture | stratum | quota | load |
|---|---|---|---|---|
| `queue-positional` | queue.html (unchanged) | discriminative | 45 | L1, post-P1 anchor |
| `twin-queues` | twinqueue.html (new) | discriminative | 45 | L1×2: two independent ordinal spaces, scoped restatement |
| `queue-resync` | queue16.html (new) | discriminative | 45 | L1×L2: positional work across a forced epoch reset |
| `wizard-submit` | wizard.html (unchanged, byte-identical) | canary | 5 | apparatus health: type+click path, L2 panel replacement |
| `ledger-balance` | ledger.html (unchanged, byte-identical) | canary | 5 | apparatus health: L4 accumulation — if THIS leaves 100%, investigate |

`inbox-archive`, `leaderboard-max`, `vault-code`, `catalog-revive` move to
`RETIRED` with a one-line note each (ceilinged 210/210 in wave 2; retirement
follows the wave-1 precedent already in the file). `taskById` keeps throwing
the retirement explanation.

**T2 — `twin-queues`, full spec.** Fixture `bench/fixtures/twinqueue.html`,
built to queue.html's conventions (bench.js witness, `data-bench` ids —
never data-testid, no ids on rows/buttons, `replaceChildren` re-render, no
randomness, removals-only, divider span on every 3rd CURRENT index per list to
stay under COLLAPSE_RUN):

- Two sections: `<section aria-label="Interviews">` with `<ul>` of 6 rows
  (ids `i1..i6`), `<section aria-label="Deliveries">` with `<ul>` of 5 rows
  (ids `d1..d5`). Status paragraphs (addressed by attribute, not id — the
  queue.html unread-route lesson): `N interviews pending` / `N deliveries
  pending`.
- Row content: span text `Interview slot` (A) / `Delivery run` (B); buttons
  `Approve interview` + `Reject interview` (A), `Approve delivery` + `Reject
  delivery` (B), carrying `data-bench="approve:iN"` etc. Rows within a family
  are content-identical; no `<a>`/`<h1-4>` inside rows (keeps
  `siblingDiscriminator` returning undefined — S-tier ordinals stay the
  identity).
- **The family-separation levers are load-bearing, and there are two of them
  on purpose:** distinct button labels put the name into the S-tier key
  (`identityKey` S-tier includes `norm(name)`) and the named sections put a
  distinct anchor into the ancestry — either alone should split the ordinal
  spaces (`disambiguate`'s `ctx.seen` is walk-global, so identically-keyed
  rows in both lists would otherwise share ONE ordinal family, and a removal
  in A would renumber B). Which lever the walker honors is verified LIVE by
  the streamAssert below at `--selftest`, not assumed here. If separation
  fails, adjust markup until the assert passes — the assert is the contract,
  the markup is the means.
- Handler semantics: exactly queue.html's (splice by id, push to
  approved/rejected per family, full re-render, counters updated).
- Task definition:
  - prompt: `In the Interviews queue, reject the interviews that are
    currently 2nd and 4th from the top. In the Deliveries queue, reject the
    delivery that is currently 3rd from the top. Then approve every remaining
    interview and delivery.`
  - maxSteps: 18
  - allowed: `reject:i2, reject:i4, reject:d3, approve:i1, approve:i3,
    approve:i5, approve:i6, approve:d1, approve:d2, approve:d4, approve:d5`
  - success (witness state carries per-family arrays):
    interviews pending empty AND deliveries pending empty AND
    rejectedInterviews sorted-joined `=== 'i2,i4'` AND rejectedDeliveries
    `=== 'd3'` AND approvedInterviews sorted-joined `=== 'i1,i3,i5,i6'` AND
    approvedDeliveries sorted-joined `=== 'd1,d2,d4,d5'`.
  - mustObserve: `/4 interviews pending/` — reachable only after both
    interview rejections, and only via the stream (nothing on a surviving row
    changes; queue.html's argument verbatim).
  - streamAssert (new two-arg form, §3.3): over the FIRST block:
    `destructiveRefs(first).size >= 2` (positional keying live) AND
    `/interview/i.test(first)` AND `!/deliver/i.test(first)` — the first
    removal (solver acts in Interviews first) must restate the Interviews
    family and MUST NOT touch Deliveries. This is the scoped-restatement
    behavior the task exists to load: the diff arm must merge a restated A
    with a remembered B.
  - solve (descending within family, removals-only discipline):
    `clickNth('Reject interview', 4)`, `clickNth('Reject interview', 2)`,
    `clickNth('Reject delivery', 3)`, then `clickNth('Approve interview', 1)`
    ×4, then `clickNth('Approve delivery', 1)` ×4. (Family-distinct labels are
    also what keep `nth` valid here: post-P1 a family replace re-appends its
    entries at the END of the shadow model, so a shared label across families
    would break insertion-order = document-order across the union; within one
    restated family the order is the subtree's document order. This is stated
    in the fixture header.)
  - Note for the record: T2 is the first fixture where `identity_mismatch` is
    REACHABLE (wave2-evaluation §4.3): a stale ref crossing families lands on
    a differently-labelled button and `labelsAgree` fails. Expect it in the
    attribution table.

**T4 — `queue-resync`, full spec.** Fixture `bench/fixtures/queue16.html`:
queue.html scaled to 16 rows (`q1..q16`), byte-for-byte the same mechanics
(same labels `Approve`/`Reject`, same divider rule, same handler, counter
`N pending`). WHY 16: MAX_DIFFS_PER_EPOCH is 12, so a 16-act episode crosses
the epoch budget mid-task and the engine forcibly restates the page — the
model must carry "which ordinals I already handled" across its own state
reset, on a page of identical rows where nothing but its memory distinguishes
them. This is vault's L2 crossed with queue's L1, and unlike vault the
post-reset work is positional.

- prompt: `Reject the submissions currently 2nd, 5th, 9th and 13th from the
  top, then approve every remaining submission.`
- maxSteps: 24
- allowed: `reject:q2, reject:q5, reject:q9, reject:q13` plus `approve:qN`
  for the other twelve.
- success: pending empty AND rejected sorted-joined `=== 'q13,q2,q5,q9'` AND
  approved sorted-joined `===
  'q1,q10,q11,q12,q14,q15,q16,q3,q4,q6,q7,q8'` (lexicographic sort, spelled
  out so nobody re-derives it).
- mustObserve: `/12 pending/` — first reachable after the fourth rejection
  (16→15→14→13→12 under the solver's rejects-first order).
- streamAssert (two-arg): `destructiveRefs(first).size >= 2` AND
  `ep.obsSeq.includes('a:full')` AND
  `ep.obsSeq.lastIndexOf('a:diff') > ep.obsSeq.indexOf('a:full')` — the
  forced restatement actually engaged mid-episode (an act came back as a FULL
  SNAPSHOT) and diffing resumed after it. Failure text must say which half
  failed. (Whether the reset fires at act 13 or 14 is an engine detail the
  assert deliberately does not pin; crossing it at all is the claim.)
- solve: `clickNth('Reject', 13)`, `clickNth('Reject', 9)`,
  `clickNth('Reject', 5)`, `clickNth('Reject', 2)`, then
  `clickNth('Approve', 1)` ×12.

**Stale-comment repairs riding along (Builder A):** queue.html:56-59 and the
`queue-positional` streamAssert comment in tasks.mjs still describe the
pre-P1 wire ("the refs of the LAST row dying") — confirmed still stale at
`3830a34`; tier2b Set C specified the fix and it never landed. Rewrite both to
describe the P1 container-replace (the assert itself already passes on it:
replace + `gone` satisfies `destructiveRefs >= 2`).

### 3.3 Harness changes (Builder A, `bench/task.mjs` + `bench/lib/store.mjs`)

1. **Per-task quotas.** `targetsFor(tasks, arms, n)` emits `{task, arm,
   runIndex k}` for `k < Math.min(n, task.quota)`. `--n` becomes the phase
   cap; a task stops accruing at its quota no matter how large `--n` is. The
   wave-major order is preserved (all tasks at wave k before any at k+1;
   quota-exhausted tasks drop out of later waves). Resume arithmetic is
   UNTOUCHED: `episodeKey` already carries runIndex, and `splitByStore` works
   verbatim — a quota is just which keys are ever asked for. `WAVES = [1, 5,
   10, 25, 45]`; `N_PREREGISTERED` is retired in favor of the quota table (the
   plan printer sums `min(n, quota)` per phase; the coverage bars print
   against each task's own quota).
2. **`streamAssert` gains a second argument** — the G2 episode record —
   call site: `task.streamAssert(r.diffStream, r)`. Existing single-arg
   asserts are unaffected.
3. **Stratified report.** `report()` partitions scored rows by task stratum
   AFTER the G6b quarantine partition (which is preserved verbatim — table,
   per-arm counts, symmetry guard; §3.6):
   - Verdict arithmetic (success CI, wrong-el CI, G4 diff-share, G7 cost,
     G10 ceiling, MDE, interim rule) runs over the DISCRIMINATIVE stratum
     only.
   - Apparatus guards (G3, G5, G6, G6b, G9, G11) run over ALL scored rows —
     a wedge or arm-leak in a canary episode is still a wedge.
   - Canaries print their own table (per task per arm, n/success) plus the
     canary gate (§3.4). They enter NO CI anywhere — excluded by design, not
     by dilution; wave 2's 210-vs-35 pooling failure is the reason this
     partition exists and the report says so in one line.
   - A preregistered SENSITIVITY line: the stratum verdict recomputed
     excluding any task the §3.4 ceiling checkpoint retired. Printed as
     sensitivity, never the headline.
4. **`WAVE3_PREREGISTRATION`** replaces the printed block (WAVE2_… stays in
   the file as an archived constant, unprinted): tasks+quotas, model
   `claude-sonnet-5`, arms unchanged (ARM_DEFINITION), guards G1–G14, the
   §3.4 rules verbatim, the budget line (§3.5), and margin provenance —
   including, printed with every wave-3 verdict: the −10pp bound is the
   PRIMARY for wave 3; the wave-2 −5pp/"parity" vocabulary is retired
   (unreachable at any affordable n on off-ceiling tasks — wave 2 cleared it
   by 0.25pp only via a post-hoc quarantine); the +0.4/run wrong-element
   bound replaces the pooled +0.2 (retired with wave2-evaluation §4.2's
   arithmetic cited).
5. **`VERDICT_RULE`** becomes `{ successBound: -0.10, wrongBound: 0.40,
   perTaskWrongTrip: 1.0, stratumFloorPerArm: 30 }` — stamped and
   integrity-checked as today. `EXIT.PARITY` is renamed `EXIT.PASS` (exit 0
   semantics unchanged; task.mjs is its only consumer — verify by grep) and
   no wave-3 output ever prints the word "parity". `progressAdvisory` /
   `parityReachableAt` texts updated to the new bounds.
6. `SUITE_VERSION` bumps (e.g. `2026-08-03.1`).

### 3.4 Preregistered rules — written here, frozen before any wave-3 episode

**Primary (success), over the discriminative stratum, Newcombe 95% CI:**
- PASS (exit 0): CI lower ≥ −10pp AND the wrong-element co-primary holds.
- REGRESSION (exit 1): CI upper < −10pp, OR wrong-el CI lower > +0.40/run.
- Otherwise INCONCLUSIVE (exit 2). There is no secondary this time — the
  primary IS the bounded outcome, chosen for reachability and stated as such.

**Co-primary (wrong-element), stratum-pooled, bootstrap 95% CI:** holds iff
CI upper ≤ +0.40/run. **Per-task tripwire:** any discriminative task whose
own wrong-el delta CI lower > +1.0/run BLOCKS PASS (result becomes
INCONCLUSIVE with the task named), whatever the pooled CI says — the mirror
of wave 2's dilution lesson, applied to the metric where one task can hide
inside a pool of three.

**What each outcome licenses.** PASS licenses exactly: *"On this 3-task
positional-identity suite (post-P1 engine) with claude-sonnet-5, no
diff-bookkeeping penalty larger than 10pp in task success or +0.4
wrong-element actions per run was found."* — with the MDE sentence printed
beside it. It is not parity and not equivalence; it says nothing about other
models, real websites, insert-mutation pages (§3.1.2), larger pages, longer
tasks, or iframes. The CANARIES license only: "the apparatus and easy-task
floor held" — their numbers appear in no claim sentence, ever. Cross-cohort
statements about wave 2 (e.g. queue-positional's wrong-el ratio moving after
P1) are DIRECTIONAL NARRATIVE only, never pooled, never CI'd — different
engine, stated every time.

**Power, honestly, in advance:** at full quotas the stratum is 135/arm. At a
pooled success of ~85% the CI half-width is ~8.5pp — PASS is reachable with
~1.5pp of headroom if the true delta is ~0; at ~75% it is ~9.8pp and PASS is
knife-edge. That is accepted: the alternative was wave 2's guaranteed-vacuous
−5pp. A thin PASS is reported as thin (the margin-clearance is printed, the
wave-2 lesson).

**Interim rule (after `--n 5`, ~50 episodes; conditions ONLY on pooled
levels/costs, never the arm delta):**
- Both arms ≥98% pooled over the discriminative stratum → STOP; the suite
  failed to leave the ceiling; redesign harder tasks; do not spend the rest.
- Re-dump stratum success < 60% → STOP; tasks too hard or broken; fix and
  `--new-cohort`.
- Mean cost per discriminative episode > $0.35 → the remaining phases run
  `--n 35` instead of `--n 45` (a uniform cap under quota; identity
  untouched).
- Any canary task-arm below 4/5 → INFRA-grade stop: investigate the
  apparatus before continuing.
- Otherwise continue.

**Ceiling checkpoint (after `--n 10`):** any DISCRIMINATIVE task at 10/10 in
BOTH arms is declared ceilinged: subsequent phases exclude it via `--tasks`
(its slots simply are not asked for; the integrity guard is untouched). Its
episodes on record STAY in the stratum pool — no post-hoc exclusion; the
preregistered sensitivity line (§3.3.3) is where the no-ceiling reading
lives. Freed budget is savings, not reallocation: quotas cannot be raised
mid-cohort because editing `tasks.mjs` moves `codeVersion` and severs the
store — the integrity design makes reallocation impossible BY CONSTRUCTION,
so the rule does not pretend otherwise.

**G8/G10 restated for the stratum:** floor 30/arm stratum episodes (below →
pilot, INCONCLUSIVE); G10 fires on stratum rates only.

### 3.5 Budget — stated

Wave 2 spent $37.34 and got 35 informative episodes ($26.73 of it bought
ceiling). Wave 3 inverts: 270 discriminative episodes (3×45×2) at the
measured queue-class rate ($0.241/ep, wave 2) ≈ **$65**, plus 20 canary
episodes at ceiling-class rates ≈ $2.50, plus the pilot inside those quotas
(resume-idempotent, nothing double-paid). **Estimate $65–75; hard cap $85** —
if cumulative spend hits the cap before quotas complete, stop; the store
scores as-is (the stop conditions on cost, not on the delta, so it is
legitimate). Wall clock ~4–6h at wave-2 durations plus ~15min of canaries.
Signal per dollar: wave 2 bought 1 informative episode per $1.07; this design
buys ~4 per $1.

### 3.6 G6b / canary integration — confirmed, with the wave-3 obligations

Verified at `3830a34` by code read: the liveness canary runs before EVERY
episode and again after any episode with a dead-act/walk-timeout signal
(task.mjs:1552-1592); quarantine is stamped at write time and recomputed at
report time; `report()` opens with the quarantine partition — its own table,
per-arm counts, the |Δ|≥3 symmetry INFRA, and the disclosure sentence
(task.mjs:1614-1662, 1709-1714); G3's message points at the quarantine table.
The wave-3 path inherits all of it. The stratified-report rewrite (§3.3.3)
must PRESERVE these verbatim — named acceptance item: run `--report` against
a copy of the archived wave-2 store under the OLD code if needed for
comparison, and under the new code assert the quarantine table still renders
for a store containing wedged rows (unit: feed `report()` a synthetic row set
with two wedged episodes; assert the table and the symmetry guard fire).

---

## 4. Item 4 — the small Gate-2 items, each ruled

1. **`invalid_action` attribution test — FOLD IN (Builder A).** Extract the
   attribution decision from `doAct` into a pure exported
   `attributeAct({ errored, text, shadowHad, landedEvents, allowed, labelsAgreeFn })`
   in `bench/lib/proxy.mjs` (doAct calls it; behavior identical), and add
   `test/benchAttribution.test.ts` covering: `error: unsupported key: s` →
   invalid_action; `error: text required for type` → invalid_action; ref-gone
   error with shadowHad → engine_ref_loss; without → model_bookkeeping; the
   §1.5 input-loss string → engine_input_loss; no events → no_page_effect;
   wrong bench id → wrong_choice; label disagreement → identity_mismatch.
   This was the one attribution change wave 2 shipped untested — the exact
   class this project keeps getting bitten by.
2. **G6b deadActs-is-retrospective note — SUPERSEDED by §1.5.** With
   `engine_input_loss` counted in `deadActsFrom`, the predicate is a live
   forward guard again. The G6b comment is updated to name BOTH signals and
   their eras (pre-W1 stores: `no_page_effect`; W1-era: `engine_input_loss`)
   rather than apologizing for a gap that no longer exists.
3. **headingLevel residual — ACCEPT, with the sentence made honest (Builder
   B).** Ruling: a pure heading-weight change (h2→h3, same text) stays
   excluded from diffing — no observed failure class, and the operative fact
   (the text) IS diffed. But Gate 2 is right that it is the one RENDERED field
   the "everything rendered is tracked" sentence quietly overclaims. Fix the
   sentence, not the engine: `src/mcp/tools.ts` completeness clause becomes
   "(Scroll positions, pixel layout and heading weight are not tracked;
   everything rendered — text, values, labels, states, links, table content —
   is.)", and `test/completeness.test.ts`'s header note names headingLevel as
   the sole rendered-but-excluded field with this ruling cited. Cost: a few
   prompt bytes; the cohort is new anyway.
4. **Congruence tether's tsc dependency — vitest-visible guard (Builder B),
   not a CI workflow.** New `test/typecheck.test.ts`: one test that spawns
   `npx tsc --noEmit -p tsconfig.json` (120s timeout) and asserts exit 0,
   printing tsc's output on failure. WHY this over a GitHub workflow: the
   repo has a remote but no CI infrastructure, and the recurrence path Gate 2
   proved is "contributor runs `npm test` alone, gets green, propDelta
   silently ignores a new field" — the fix has to live where the green comes
   from. `npm test` becomes self-sufficient everywhere, including offline; a
   CI workflow, if ever added, just runs the same command and inherits the
   guard. The completeness test's header claim ("fails the typecheck") is now
   literally enforced by the suite it appears in. Accepted cost: ~10–20s per
   `npm test` run, stated in the test's comment.

---

## 5. File ownership — two parallel builders, seams named

**Builder A — bench/harness (never touches `src/**`):**
- `bench/tasks.mjs` (wave-3 TASKS with stratum/quota, T2/T4 definitions,
  retirements, comment repairs)
- `bench/task.mjs` (quota targeting, WAVES, streamAssert arity, stratified
  report, WAVE3_PREREGISTRATION, VERDICT_RULE/EXIT.PASS, deadActsFrom
  extension, metrics sampling, canary-gate, sensitivity line)
- `bench/lib/proxy.mjs` (`attributeAct` extraction, `engine_input_loss`)
- `bench/lib/aperture.mjs` (new: startAperture with log persistence, killTree)
- `bench/lib/store.mjs` (SUITE_VERSION bump only)
- `bench/guards.mjs` (G14), `bench/fixtures/twinqueue.html`,
  `bench/fixtures/queue16.html`, `bench/fixtures/queue.html` (comment only),
  `test/fixtures/suppressor.html`, `test/benchAttribution.test.ts`

**Builder B — src/engine+preload (never touches `bench/**`):**
- `src/preload/page.ts` (input recorder, witness-poll, comment rewrite)
- `src/core/snapshot/act.ts` (`witnessInput`, verdict logic)
- `src/mcp/tools.ts` (witness call sites incl. scroll/key, error text,
  heading-weight clause)
- `src/mcp/server.ts` (`GET /metrics`)
- `test/act.test.ts` (rewrite + §1.6 matrix), `test/typecheck.test.ts`,
  `test/completeness.test.ts` (header note only)
- `docs/design/security.md` (metrics endpoint entry)

**Atomicity seams (the contracts that cross the partition):**
1. The error clause `input was dispatched but never reached the page` —
   B's tools.ts emits it, A's proxy regex and the G6b extension consume it.
   Pinned on both sides by unit test (§1.6 case 3 asserts the substring; A's
   attribution test asserts the classification). Neither builder rewords it
   unilaterally.
2. `GET /metrics` reply shape `{pid, uptimeS, metrics:[…]}` — B serves, A
   samples. A's sampler must tolerate extra fields (read only what §2.2
   names).
3. `test/fixtures/suppressor.html` — A authors it, B's recorder is what makes
   G14 pass. The RED-first evidence run (§1.6) is A running its guard against
   the pre-B build; A therefore lands (or at minimum authors and runs) G14
   before B's src lands, and the RED goes in the landing commit message.
4. `streamAssert(stream, episode)` arity — A-internal (task.mjs ↔ tasks.mjs),
   listed because both files must move together.
Everything else is builder-local. One rebuild, one battery, then the store is
`--new-cohort` by construction.

---

## 6. Acceptance battery (run after both builders land, before any episode)

| check | expectation |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | green, incl. new act matrix (§1.6), benchAttribution, typecheck test |
| `npx electron-vite build` | clean; out/ hashes move (expected — new cohort) |
| fidelity, all six scenarios | GREEN (no fidelity change in this bundle; regression only) |
| guards G1–G14 live | 15+1 PASS; G14 recorded RED against pre-B build first |
| `npm run bench:task -- --selftest` | G1+G2 both arms all 5 tasks (T2/T4 streamAsserts prove family separation and forced resync LIVE) + canary PASS |
| canary sabotage | rename canary data-bench → exit 3 INFRA; revert |
| G6b recompute over archived wave-2 store | exactly 6 quarantined, 3/arm, 0 FP on 245 |
| synthetic wedged-store report unit | quarantine table + symmetry guard render under the stratified report |
| `--plan` | prints quota-aware phases summing to 290 episodes |

If T2's separation streamAssert fails at selftest, adjust the fixture levers
(§3.2) and re-run — no budget is at risk; that is what the assert is for.

---

## 7. Launch checklist — wave 3

1. Bundle landed (A+B), battery of §6 fully green, working tree clean,
   commit tagged (suggest `tier3-landed`).
2. `npm run bench:task -- --plan` — sanity: 290 episodes, quota table.
3. `npm run bench:task -- --new-cohort --n 5` — the pilot (~50 episodes,
   ~$11). Confirm as it runs: `aperture.<ts>.log` growing,
   `apparatus.<ts>.jsonl` one line per episode, canary cadence ~2-3s.
4. Apply the INTERIM RULE (§3.4) exactly as preregistered — pooled levels and
   cost only, blind to the arm delta. STOP/FIX/trim/continue per its text.
5. `--n 10`, then the CEILING CHECKPOINT (§3.4): retire any 10/10-both-arms
   discriminative task from later phases via `--tasks`.
6. `--n 25`, then `--n 45` (idempotent resume; interrupted phases re-run
   free). If the $85 cap trips, stop and score the store as-is.
7. `npm run bench:task -- --report` — the stratified verdict, quarantine
   partition, canary table, sensitivity line, MDE sentence, margin
   provenance.
8. Preserve: archive `episodes.jsonl` + cohort sidecar + `apparatus.*.jsonl`
   + `aperture.*.log` beside the wave-2 pair; append the wave-3 section to
   `bench/RESULTS.md` (headline = whichever §3.4 sentence is licensed, with
   clearances printed); tag `wave3-scored`.

**Budget line: $65–75 estimated, $85 hard cap, ~4–6h wall clock, ~$11 of it
the pilot.** (wave2-evaluation §7 guessed $30–40 for this step; the
difference is that discriminative episodes cost ~$0.24 against the $0.13
suite average it extrapolated from — the money goes where the signal was,
which is the point.)

---

## 8. What was verified by probe, and what was not

**Probed live for this spec (throwaways deleted, tree clean at `3830a34`):**

1. **Electron 43 listener-ordering probe** (scratchpad Electron app,
   `contextIsolation: true, sandbox: true`, mirroring tabs.ts): with a page
   registering `stopImmediatePropagation` window-capture handlers for ALL of
   pointerdown/mousedown/mouseup/click/keydown at parse time, a preload
   (document_start) isolated-world capture listener on `window` observed
   every CDP-dispatched event, all `isTrusted: true`; listeners registered
   AFTER page load (the shipped W1's shape) observed ZERO trusted events —
   the Gate-2 false alarm reproduced; page-synthesized flood events arrived
   `isTrusted: false` (filterable); `wc.on('input-event')` exists and fired
   5 times for the CDP dispatches, ordered before page-side delivery.
2. **Diff-engine insertion probe** (throwaway vitest against
   `src/core/snapshot/diff.ts`): prepend into a 6-row identical positional
   family → exactly one `add` op (silent rebinding of every surviving key);
   removal from a 7-row family → exactly one `replace` with `gone: 4` (P1
   working as landed). Basis for §3.1's no-insert-task ruling.

**Verified by code read at `3830a34`:** G6b canary cadence and the quarantine
partition in `report()` (§3.6); the attribution routing that misfiles the W1
error as `invalid_action` (§1.5); queue.html/tasks.mjs stale post-P1
comments; `disambiguate`'s walk-global `ctx.seen` (the T2 coupling hazard);
S-tier key composition (name + anchor in key); MAX_DIFFS_PER_EPOCH = 12;
COLLAPSE_RUN divider arithmetic for 16 rows.

**Asserted but NOT verified by probe — the residual risks, owned:**

- Whether `input-event` fires during a real wedge (no wedge repro exists);
  irrelevant to the chosen design, recorded for the next root-cause.
- Whether the T2 family-separation levers work on the real walker (the li
  accessible-name and anchor behavior): deliberately delegated to the
  `--selftest` streamAssert, which proves it on live bytes before any budget;
  the spec provides two independent levers and the adjust-and-rerun rule.
- Whether the forced resync in T4 lands at act 13 or 14 (nextDiffSeq
  increment ordering): the streamAssert pins "crossed mid-episode", not the
  act number, on purpose.
- Subframe wedges still ack `ok` (§1.3.2): accepted, stated, bounded by the
  canary.
- The isTrusted mask (§1.6, end): probe-verified behavior, not
  regression-testable without a wedge repro.
- `--selftest`/fidelity/guards were NOT run in this session (nothing was
  running and the bundle is unbuilt); Gate 2 ran them green at this HEAD, and
  §6 makes them the landing gate.

---

## Amendment A (spec author) — witness settle timing: the short-circuit ladder, APPROVED with two corrections

Builder B implemented §1.3's settle path verbatim and flagged its cost: the
old one-shot resolved on arrival (~0ms healthy); the specified path always
waits the full 500ms before its first poll, so every act gains ~500ms —
roughly an hour over wave 3's ~7,000 acts, which is both money and an hour of
added wedge-recurrence exposure. B proposed a poll ladder at ~100/250/500ms,
returning `landed` on the first advance, claiming verdict-identity. This
amendment is the ruling. It supersedes §1.3's settle text (main side, steps
3–4) and amends §1.3.2's poll reply shape and §1.6's matrix. Nothing else in
§1 moves.

### A.1 The verdict-identity claim — verified, and NOT airtight

**Within one document the claim holds**, by monotonicity: the recorder's
counters only increment, so `advanced(baseline, counts(t))` over a fixed
relevant set is monotone in t — an advance visible at 100ms or 250ms is
visible at 500ms, and a trace frozen through 500ms reaches the same 500ms
poll the unamended path reads. Early rungs can only convert would-be-`landed`
acts into earlier `landed`; the `lost`/`unknown` partition at 500/2500ms is
untouched. The coordinator's unrelated-trusted-event case (a human wiggling
the mouse mid-run) changes nothing: any event that advances a relevant
counter inside [0, 100ms) also shows at 500ms, so WHICH acts get `landed` is
identical — the false-landed exposure for a given act is a property of the
0–2500ms span, not of how often it is sampled. The RELEVANT_COUNTERS sets are
per-action constants; no set behaves differently at 100ms than at 500ms. Two
conditions are required for even this half of the claim, and they become
spec:

1. **Early rungs are advance-only.** An unanswered or unhappy poll at 100ms
   or 250ms is IGNORED — fall through to the next rung. Only the 500ms and
   2500ms polls carry `unknown` authority. Without this rule, a
   flaky-but-recovering IPC channel would turn traces the unamended path
   scores `landed`-or-`lost` into `unknown`, and the claim would be false on
   exactly the apparatus-degradation traces G6b cares about.
2. **`lost` still requires the frozen poll at 500ms AND the frozen re-poll at
   2500ms** — unchanged, as B proposed.

**Across a document reset the claim is FALSE — and the counterexample exposed
a real defect in §1.3 as written and as implemented.** The counters are
per-document: the recorder and its counts die with the document, and a settle
poll issued after a navigation commits is answered by the NEW document's
preload with fresh counts. `advanced` compares with strict `>`, so reset
counts read as frozen. Consequence in the implemented code: an act that
CAUSES a navigation — a link click, an Enter that submits — whose commit
beats the 500ms poll returns a false `lost`: the terminal restart-the-browser
error on the commonest healthy action a real page has. The old one-shot was
immune only by accident (it resolved at ~0ms, before teardown). The ladder is
therefore NOT verdict-identical: a click whose navigation commits between
100ms and 500ms is `landed` under the ladder and `lost` under §1.3 as
written. That divergence is in the safe direction, which is one more reason
to approve the ladder — but a fix that merely narrows a false-terminal-error
window is not a fix, so:

### A.2 Mandatory companion: the document-continuity token

- **Preload (`src/preload/page.ts`):** the recorder generates `docToken` once
  at init (any per-document random string; `crypto.randomUUID()` if available
  in the sandboxed preload, else two concatenated `Math.random().toString(36)`
  slices — uniqueness across two documents in one tab is the whole
  requirement; it is not security-bearing). Every happy poll reply gains it:
  `{ ok: true, top, docToken, counts }`. (§1.3.2's reply shape is amended
  accordingly.)
- **Main (`src/core/snapshot/act.ts`):** the baseline records `docToken`. Any
  ANSWERED settle poll — any rung — whose token differs from the baseline's
  returns `'unknown'` immediately: witness continuity is unrecoverable, a
  later poll can never re-match, and there is nothing left to wait for. The
  document changed under the act, which is the opposite of a dead input path.
- **Why `unknown` and not `landed`:** the token proves the document turned
  over, not that THIS act's input arrived. `unknown` never fails an act; the
  observe that follows reports the navigation. Correct and sufficient.
- **A wedge cannot escape through the token:** a wedged tab's act delivers no
  input, so nothing navigates; same document, same token, frozen counters —
  `lost` at 2500ms exactly as before. Residual, stated: a page that
  self-navigates on a timer during settle yields `unknown` per act, so a
  wedge on that page class is invisible to W1 — bounded by the bench liveness
  canary, whose fixture does not navigate. The §1.4 contract gains a sibling
  line: **a navigating act cannot produce `lost`.**

### A.3 The amended settle text (replaces §1.3 main-side steps 3–4)

`settle()` in recorder mode, all times measured from dispatch:

1. Rung at **100ms**: poll (no key). Answered ∧ token matches ∧ relevant
   counter advanced → `landed`. Answered ∧ token differs → `unknown`.
   Unanswered or unhappy → ignore.
2. Rung at **250ms**: same rules.
3. Rung at **500ms** — authoritative: unanswered or unhappy → `unknown`;
   token differs → `unknown`; advanced → `landed`; else continue.
4. Re-poll at **2500ms** total: unanswered or unhappy → `unknown`; token
   differs → `unknown`; advanced → `landed`; frozen → `lost`.

Healthy-page cost: ~100ms per act (first rung; arrival is ~0–5ms), restoring
the §3.5/§7 wall-clock estimate (~12 minutes of witness overhead across the
wave, not ~an hour). Subframe and unknown modes are untouched by this
amendment (verified in the working tree: the kept one-shot already maps
timeout and not-witnessed to `unknown`).

### A.4 Harness-side verification (no 500ms floor dependence)

Checked in Builder A's working tree, read-only: nothing assumes the 500ms
floor. The proxy's attribution window (`settle(collector, 260, 1500)`) and
the canary's (`settle(collector, 200, 500)`) anchor on act RETURN and on
collector quiet, not on witness timing — witness events arrive during the act
call and are sliced from a pre-call index, so faster acts change nothing (the
260ms quiet window still clears bench.js's 100ms input debounce).
`deadActsFrom`/G6b are attribution-based. The preregistered rules condition
on pooled levels and cost only. The G14 guard asserts reply text and page
state, not latency. No amendment needed on the bench side; the ladder also
shortens canary cadence slightly, in the safe direction.

### A.5 Test amendments

- **The 2.5s elapsed test stands as asserted** (`>= 2400ms` before `lost`):
  the rungs add polls, not delay, on a frozen trace — total is still
  500 + 2000. Its fake-preload reply queue must grow from three frozen
  replies to FIVE (baseline + rungs at 100/250 + 500 + 2500), or the fake
  must repeat its last reply; either is fine, the assertion is not.
- **New cases, added to the §1.6 matrix:**
  - 13. advance visible at the 100ms rung → `landed`, elapsed < 400ms (the
    ladder's reason to exist, pinned so it cannot regress to a fixed wait).
  - 14. rungs at 100/250 unanswered, 500ms poll advanced → `landed`, not
    `unknown` (the advance-only rule).
  - 15. token differs at the 100ms rung → `unknown` immediately, elapsed
    < 400ms.
  - 16. token differs at the 500ms poll, counters "frozen" → `unknown`,
    never `lost` (the navigating-click regression test for A.2).
  - 17. same token throughout, frozen at every rung and at 2500ms → `lost`
    (the wedge still errors; A.2 did not soften the true positive).
- G14 and the live battery are unaffected (suppressor.html does not
  navigate).

Approved with the above as binding spec; Builder B implements A.2/A.3/A.5.
The error text's "within 2.5s (checked twice)" sentence remains accurate as
written.
