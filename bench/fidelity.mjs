/**
 * Diff fidelity.
 *
 * The precondition for the whole design. If a base snapshot plus the diff
 * stream does not describe the same page as a fresh full snapshot, then no
 * model can succeed on diffs regardless of how good it is — the information
 * simply is not there.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * `applyObservation` below is a mechanical rule-follower, not a language
 * model. A green here proves the stream is COMPLETE and UNAMBIGUOUS: a reader
 * that applies every line by the documented rules ends up holding the page.
 * It does NOT prove an LLM will do that bookkeeping correctly — that is the
 * task-success benchmark, which does not exist yet. What a green here licenses
 * is exactly this claim: "if an agent's model drifts from the page, the fault
 * is the agent's application of the stream, not missing or wrong information
 * in the stream."
 *
 * Two caveats on the ground truth, stated because both have burned us:
 *
 *   1. The truth is a fresh full snapshot from the SAME walker and renderer
 *      as the diff stream. A walker bug affects both sides identically and is
 *      invisible here. The independent checks (typed values must round-trip,
 *      clicked checkboxes must read checked) exist to pierce that: they
 *      compare against what the bench itself did to the page, not against
 *      anything the engine reported.
 *   2. The comparison covers ref existence, role, label, value, state flags,
 *      the `[N options]` marker, href, and flattened table rows. It does NOT
 *      cover containment structure or position — a diff stream that reordered
 *      the world would still pass. "Faithful" here means "every element the
 *      agent believes in exists, as described", not "the agent could redraw
 *      the page".
 *
 *      THIS LIST IS THE MEASUREMENT'S CEILING, and it went stale once with
 *      consequences: for as long as the shared reader dropped `href` and table
 *      `rows`, BOTH SIDES of every comparison below were blind in the same way,
 *      so a mutated table or a rotated link compared stale-against-fresh as
 *      EQUAL. Five green scenarios could not have caught the propDelta
 *      blind-field bug however many fixtures were added (tier2b §0). The field
 *      set is now tethered to the walker's emission set by
 *      `test/completeness.test.ts`; scroll offset, geometry, heading weight and
 *      page title are excluded BY RULING there, not by omission here.
 *
 * Scenarios target elements BY LABEL, resolved against the agent-side model.
 * The old hardcoded e-numbers were how the historical false green happened
 * (a second scenario in one session typed into refs that no longer existed).
 * Label targeting also makes the run self-checking: if the diff stream fails
 * to deliver a label update, the next step cannot even resolve its target.
 *
 * Usage:
 *   node bench/fidelity.mjs <token> [form|rerender|widgets|biglist|selects|blindfields]
 *
 * Exit codes — anything nonzero must never be read as "roughly green":
 *   0  GREEN
 *   1  RED: the stream is missing or wrong somewhere
 *   2  ground truth unusable (elided, budget-cut, or failed) — no verdict
 *   3  a step did not run — no verdict
 *   4  vacuous run: counts below the scenario's minimums — no verdict.
 *      An empty measurement scoring perfect is the failure mode this whole
 *      file exists to prevent.
 *
 * EXIT CODES ARE POLICY, and one of them was wrong. An `(unchanged` response to
 * a step the bench KNOWS mutated the page used to be exit 3 — "a step did not
 * run", which reads as "fix your scenario" and invites editing the fixture until
 * the complaint goes away. That is the propDelta blind-field signature exactly,
 * and it is a measurement that DID run and DID find the defect. It is now a RED
 * (tier2b F3). Two consequences of that ruling are implemented below and are not
 * incidental:
 *
 *   - a recorded RED outranks a later no-verdict: once the stream has been shown
 *     to be missing information, a step that then fails to resolve its target is
 *     a CONSEQUENCE of that hole, not a scenario-design problem, and the run
 *     still exits 1.
 *   - a recorded RED outranks the vacuity guards: when the engine answers
 *     "nothing changed" instead of emitting a diff, the diff COUNT collapses as
 *     well. Reporting that as "your scenario measures nothing" (exit 4, no
 *     verdict) would launder the same defect through a different exit code.
 */

import { applyObservation } from './lib/streamModel.mjs';

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error('usage: node bench/fidelity.mjs <token> [scenario]');
  process.exit(1);
}

let id = 0;
async function call(name, args = {}) {
  const res = await fetch('http://127.0.0.1:8817/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: ++id, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.text();
  const line = body.split('\n').find((l) => l.trim().startsWith('{') || l.startsWith('data: {'));
  if (!line) return '';
  return JSON.parse(line.replace(/^data: /, '')).result?.content?.[0]?.text ?? '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Parsing the rendered stream — shared by the model side and the truth side,
// deliberately: the comparison must be apples-to-apples. The escaped-quote
// handling matters; the previous parser broke identically on both sides for
// labels containing quotes, which hid the breakage completely.
//
// The parser itself now lives in bench/lib/streamModel.mjs and is imported at
// the top of this file. The task-success bench imports the SAME module as its
// shadow model, so a failure it attributes to the agent cannot be a parser
// disagreement between the two benches.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/**
 * The truth snapshot must be complete. A default snapshot collapses runs of
 * same-shape siblings into `… 3 more listitems`, so refs behind the elision
 * were absent from the truth while being perfectly real on the page — and
 * every one was reported as a phantom. That bug cost a day and indicted an
 * engine that was correct; the guard is here so it cannot happen twice.
 */
function truthFrom(text, minRefs) {
  if (!/^FULL SNAPSHOT #/m.test(text)) {
    noVerdict(2, 'ground truth is not a full snapshot — cannot judge anything.\n' + text.slice(0, 300));
  }
  if (text.includes('more lines beyond budget') || /^\s*… \d+ more /m.test(text)) {
    noVerdict(
      2,
      'ground truth incomplete — cannot judge phantoms.\n' +
        'The reference snapshot was elided (collapsed run or budget cut), so\n' +
        'refs that exist on the page are missing from it. Raise budgetTokens\n' +
        'or fix expand:true; do NOT interpret the result as phantom refs.',
    );
  }

  // The truth is built by the SAME reader as the believed model — deliberately,
  // so the comparison is apples to apples. Table rows ride along on the element
  // lines beneath their table, which is why `applyObservation` (not a bare line
  // loop) does the parsing here.
  const truth = applyObservation(new Map(), text);
  if (truth.size < minRefs) {
    noVerdict(
      2,
      `ground truth holds only ${truth.size} refs (scenario expects >= ${minRefs}).\n` +
        'The reference snapshot is not credible — refusing to judge against it.',
    );
  }
  return truth;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const BASE = 'http://127.0.0.1:8899';

const SCENARIOS = {
  // 14 typed fields on a static page. Crossing 12 diffs forces the
  // MAX_DIFFS_PER_EPOCH resync mid-run, so the model must survive a full
  // restatement between diffs — a path no scenario exercised before.
  form: {
    url: `${BASE}/application.html`,
    steps: [
      { do: 'type', label: 'First name', text: 'Brad' },
      { do: 'type', label: 'Last name', text: 'Cunningham' },
      { do: 'type', label: 'Email address', text: 'brad@example.com' },
      { do: 'type', label: 'Mobile number', text: '0400 000 000' },
      { do: 'type', label: 'Street address', text: '1 Example Street' },
      { do: 'type', label: 'Apartment, suite, etc.', text: 'Unit 2' },
      { do: 'type', label: 'Town / City', text: 'Melbourne' },
      { do: 'type', label: 'Postcode', text: '3000' },
      { do: 'type', label: 'Current company', text: 'PlusLife' },
      { do: 'type', label: 'Job title', text: 'Director' },
      { do: 'type', label: 'LinkedIn profile', text: 'linkedin.com/in/example' },
      { do: 'type', label: 'Why do you want this role?', text: 'Because.' },
      { do: 'type', label: 'How did you hear about us?', text: 'A friend' },
      { do: 'type', label: 'Date of birth', text: '1990-01-05' },
    ],
    expect: { minRefs: 15, minDiffs: 12, resync: true },
  },

  // The hard case: every keystroke tears down and rebuilds the whole list.
  rerender: {
    url: `${BASE}/rerender.html`,
    steps: [
      { do: 'type', label: 'Search', text: 'anker' },
      { do: 'type', label: 'Search', text: 'dock' },
      { do: 'type', label: 'Search', text: 'a' },
    ],
    expect: { minRefs: 8, minDiffs: 3 },
  },

  // Clicks, state flips, a revealed subtree, a shadow-DOM element, and a
  // ticking clock that must end up SUPPRESSED even though every observation
  // here follows an action.
  widgets: {
    url: `${BASE}/widgets.html`,
    stepDelayMs: 1400,
    steps: [
      { do: 'click', label: 'Count: 0' },
      { do: 'click', label: 'Count: 1' }, // only resolvable if the diff delivered the label update
      { do: 'click', label: 'Notify me', expectState: ['checked', true] },
      { do: 'click', label: 'Show details', expectState: ['expanded', true] },
      { do: 'click', label: 'Shadow count: 0' },
    ],
    expect: { minRefs: 5, minDiffs: 5, suppression: true },
  },

  // 40 varied-shape rows. Filtering to nothing and clearing back exercises
  // mass ref death, mass revival, and the "diff too big → full resync"
  // fallback (DIFF_SIZE_RATIO / 60-line cap), never exercised before.
  biglist: {
    url: `${BASE}/biglist.html`,
    steps: [
      { do: 'type', label: 'Search', text: 'zzz' },
      { do: 'clear', label: 'Search' },
    ],
    expect: { minRefs: 60, minDiffs: 1, resync: true },
  },

  // Dropdowns, both kinds. Four native <select>s driven by `select`, then a
  // custom ARIA combobox driven by clicks — the distinction the `[N options]`
  // marker exists to make, exercised on one page.
  //
  // Two steps carry the mechanism argument, and it is worth knowing which
  // carries what, because the obvious answer is wrong:
  //
  //   "Delivery slot" has two options with the SAME value and different
  //   labels. `el.value = 'am'` can only ever select the first of them, so
  //   naming the second is the step that fails RED on a regression to the
  //   naive write. This is the discriminating case.
  //
  //   "Order status" is instrumented the way React instruments a controlled
  //   select and reasserts its state every 150ms. It does NOT discriminate the
  //   two mechanisms — measured: Aperture writes from an isolated world, where
  //   the page's instance-level instrumentation is not on the object it
  //   touches, so both mechanisms commit and its write counter stays 0. What
  //   it does catch is a mechanism that fails to make a controlled component
  //   commit at all: the step delay is longer than the interval, so anything
  //   uncommitted is visibly snapped back before the next step.
  //
  // Closing the custom combobox removes a subtree holding four live refs.
  // Without the `gone` list on the remove op they stay alive in the model —
  // four phantoms, from the commonest interaction on the web.
  selects: {
    url: `${BASE}/selects.html`,
    stepDelayMs: 400,
    steps: [
      { do: 'select', label: 'Size', option: 'Large' },
      // Tier 1 must win outright. "United States Minor Outlying Islands" is on
      // this list, and a prefix-first matcher makes "United States"
      // permanently ambiguous.
      { do: 'select', label: 'Country', option: 'United States' },
      // Both "Morning" options carry value "am"; only the option setter can
      // reach the second one.
      { do: 'select', label: 'Delivery slot', option: 'Morning Wednesday' },
      { do: 'select', label: 'Order status', option: 'Committed' },
      // Replace semantics: two options were selected, one is now.
      { do: 'select', label: 'Toppings', option: 'Olives' },
      { do: 'click', label: 'Colour: none', expectState: ['expanded', true] },
      { do: 'click', label: 'Red', expectState: ['selected', true] },
      { do: 'click', label: 'Colour: Red' },
    ],
    expect: { minRefs: 7, minDiffs: 7 },
    // The marker contract, checked against the stream itself rather than
    // inferred: every native select says how many options it has, and the
    // custom combobox — which looks like a dropdown in every other respect —
    // must not, because that marker is the agent's only discriminator.
    checkInitial(text) {
      const problems = [];
      for (const want of ['[4 options]', '[51 options]', '[3 options]', '[6 options]']) {
        // "[3 options]" appears twice on this page (Delivery slot, Order
        // status); one occurrence is enough to prove the marker is emitted.
        if (!text.includes(want)) {
          problems.push(`native select marker ${want} missing from the initial snapshot`);
        }
      }
      const custom = text.split('\n').find((l) => l.includes('"Colour: none"'));
      if (!custom) problems.push('the custom ARIA combobox is not in the initial snapshot');
      else if (/\[\d+ options\]/.test(custom)) {
        problems.push(`the custom combobox claims to be native: ${custom.trim()}`);
      }
      // Synthetic option nodes must be listed and must NOT carry refs.
      const synthetic = text.split('\n').filter((l) => /^\s*option (?!e\d)/.test(l));
      if (synthetic.length < 4) {
        problems.push('the 4-option select did not enumerate its options');
      }
      for (const l of text.split('\n')) {
        if (/^\s*option e\d+ "(Small|Medium|Large|Extra large)"/.test(l)) {
          problems.push(`a synthetic option was given a ref no action can resolve: ${l.trim()}`);
        }
      }
      return problems;
    },
  },

  // The fields nothing measured. Every mutation on this page lands in a field
  // `propDelta` did not compare and the shared reader did not parse: flattened
  // table cells, and an href under a label that never moves. Against a build
  // with that blindness the FIRST step returns `(unchanged` — the engine
  // sincerely reporting that nothing it looks at changed — which is the RED
  // this scenario exists to produce (tier2b F4).
  //
  // The fourth step is a different animal and is here on purpose: a bare
  // `<button>Follow</button>` whose label morph changes its own S-tier identity
  // key, so it dies and is reborn. The assertion is that the new label ARRIVES,
  // never which ops carried it — tier2b P2 may reconcile that pair into a single
  // update, and this scenario must stay green across that change.
  // ONE DEVIATION FROM THE SPEC'S STEP LIST, and it is the difference between
  // F3 being exercised and F3 being decoration. tier2b F4 orders the steps
  // advance / rotate / advance / follow and states that step 1 returns
  // `(unchanged`. Measured against the pre-fix build, it does not:
  //
  //     ==== click 1: Advance shipment (e3) ====
  //     page #3.1 (diff from #3.0)
  //     ~ e3 +focused
  //
  // A click FOCUSES its target, and a focus flip is a state delta propDelta
  // does report — so the observation is a diff carrying one state bit and
  // saying nothing whatever about the two table cells the click just rewrote.
  // The blindness is total and the wire still looks busy. `(unchanged` appears
  // only when the click moves no focus either, i.e. on a SECOND click of the
  // element that already has it:
  //
  //     ==== click 2: Advance shipment AGAIN, focus already on it ====
  //     page #3.1 (unchanged — the action caused no visible change)
  //
  // So steps 1 and 2 are the two Advance clicks, back to back, and the rotate
  // moves to step 3. Every assertion in the spec's list survives verbatim; what
  // changes is that the scenario now trips F3 as well as F2 against the pre-fix
  // build, which is what F4's evidence requirement actually asks for.
  blindfields: {
    url: `${BASE}/roster.html`,
    steps: [
      { do: 'click', label: 'Advance shipment' }, // table cells -> SHIPPED
      { do: 'click', label: 'Advance shipment' }, // table cells -> CANCELLED, and no focus move
      { do: 'click', label: 'Rotate link' }, // href -> /checkout-v2
      { do: 'click', label: 'Follow' }, // S-tier label morph
    ],
    expect: { minRefs: 5, minDiffs: 3 },
    // The same-walker pierce, in the established shape of `typed`/`stateChecks`:
    // the bench knows what its own clicks did to its own fixture, so it asserts
    // the believed model — built from the stream and nothing else — holds the
    // literals, without consulting the truth snapshot at all.
    independent: [
      { ref: 'byLabelTable', rowsInclude: 'SHIPPED' },
      { ref: 'byLabelTable', rowsInclude: 'CANCELLED' },
      { link: 'Continue to checkout', href: '/checkout-v2' },
      { anyLabel: 'Following' },
    ],
  },
};

const which = process.argv[3] ?? 'form';
const scenario = SCENARIOS[which];
if (!scenario) {
  console.error('unknown scenario: ' + which);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const TYPE_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * REDs recorded mid-run, before the comparison could be reached.
 *
 * Only one thing writes to it today: an `(unchanged` answer to a step the
 * scenario declares mutating (F3). It exists as a list rather than a flag so
 * that `noVerdict` below can tell "the measurement could not run" from "the
 * measurement already established a RED and then could not continue".
 */
const midRunReds = [];

/**
 * Exit with a no-verdict code — unless a RED is already on the record, in which
 * case the run exits 1 with the RED it found.
 *
 * A step that cannot resolve its target AFTER the stream has been shown to be
 * withholding information is a downstream symptom of that hole. Reporting it as
 * "no verdict, fix your scenario" is the exact misrouting F3 exists to end.
 */
function noVerdict(code, message) {
  console.error(message);
  if (!midRunReds.length) process.exit(code);
  console.error(
    '\nA RED was already established before this happened, so the run does NOT exit ' +
      `${code} (no verdict). The stream was already known to be missing information:`,
  );
  for (const r of midRunReds) console.error('  - ' + r);
  console.log('\nRESULT: RED — diffs do not describe the real page');
  process.exit(1);
}

function resolveTarget(model, step) {
  const wantTyped = step.do === 'type' || step.do === 'clear';
  const hits = [...model.entries()].filter(
    ([, e]) => e.label === step.label && (!wantTyped || TYPE_ROLES.has(e.role)),
  );
  if (hits.length !== 1) {
    noVerdict(
      3,
      `step "${step.label}" resolves to ${hits.length} elements in the agent model ` +
        `(need exactly 1). The model holds:\n` +
        [...model.entries()].map(([r, e]) => `  ${r} ${e.role} "${e.label}"`).join('\n'),
    );
  }
  return hits[0][0];
}

/**
 * Reasons a step must not be scored. Anything caught here is exit 3.
 *
 * `(unchanged` is deliberately NOT one of them any more — see the exit-code
 * ruling in the file header and F3 in docs/design/tier2b.md.
 */
function stepFailure(out) {
  if (!out || !out.trim()) return 'empty response from the server';
  if (/could not be acted on|is not a known element|^error:|\nerror:/m.test(out)) return out.trim().slice(0, 300);
  if (!/^ok (click|type|hover|scroll|key|clear|select)/m.test(out)) return 'no ok-acknowledgement in response';
  if (!/^(page #|FULL SNAPSHOT #)/m.test(out)) return 'no observation followed the action';
  return null;
}

console.log(`# Diff fidelity — scenario "${which}"\n`);

// The cache-buster is not decoration. Electron caches fixture responses (the
// dev server sends max-age), and a run against a STALE fixture measures a page
// nobody is looking at while printing a verdict about the one on disk. Caught
// live: an edited fixture's new element was absent from every snapshot until
// the URL changed.
await call('browser_navigate', {
  action: 'goto',
  url: `${scenario.url}?benchrun=${Date.now()}`,
});
await sleep(2500);

const model = new Map();
const initial = await call('browser_snapshot', { mode: 'full' });
if (!/^FULL SNAPSHOT #/m.test(initial)) {
  console.error('initial snapshot failed:\n' + initial.slice(0, 300));
  process.exit(3);
}
applyObservation(model, initial);
console.log(`initial full snapshot: ${model.size} refs tracked`);

// Claims about the stream that are true of the FIRST snapshot or of nothing —
// the native-vs-custom marker among them. Collected as problems so they land
// in the same RED as everything else.
const initialProblems = scenario.checkInitial ? scenario.checkInitial(initial) : [];

let observedTokens = 0;
let diffSteps = 0;
let fullSteps = 0;
let sawSuppression = false;
const typed = new Map(); // ref -> last text the bench itself typed
const stateChecks = []; // [ref, state, expected, label]

for (const [i, step] of scenario.steps.entries()) {
  const ref = resolveTarget(model, step);
  const args =
    step.do === 'type'
      ? { action: 'type', ref, text: step.text }
      : step.do === 'select'
        ? { action: 'select', ref, option: step.option }
        : { action: step.do, ref };
  const out = await call('browser_act', args);

  const failure = stepFailure(out);
  if (failure) {
    // A step that never ran must not be scored. The historical false green:
    // every action failed, no diffs were produced, and an empty model scored
    // perfectly. Run ONE scenario per freshly started Aperture.
    noVerdict(3, `step ${i + 1} (${step.do} "${step.label}" -> ${ref}) did not run:\n${failure}`);
  }

  // F3 — the defect signature, reclassified. `mutates` defaults true; a future
  // scenario may set `mutates: false` for a deliberate no-op step. The run
  // CONTINUES so the comparison below can name which fields went stale — the
  // verdict is already decided, and the evidence is worth more than the two
  // seconds saved by aborting here.
  if ((step.mutates ?? true) && /\(unchanged\b/.test(out)) {
    const line = out.split('\n').find((l) => /\(unchanged/.test(l)) ?? '';
    console.error(
      '\nRED: the engine reported "unchanged" for an action the bench knows mutated ' +
        'the page — information is missing from the stream',
    );
    console.error(`     step ${i + 1}: ${step.do} "${step.label}" -> ${ref}`);
    console.error(`     ${line.trim()}\n`);
    midRunReds.push(
      `step ${i + 1} (${step.do} "${step.label}" -> ${ref}) was answered "unchanged"`,
    );
  }

  const isDiff = /^page #\d+\.\d+ \(diff from/m.test(out);
  const isFull = /^FULL SNAPSHOT #/m.test(out);
  if (isDiff) diffSteps++;
  if (isFull) fullSteps++;
  if (/live-region updates? suppressed/.test(out)) sawSuppression = true;

  observedTokens += Math.ceil(out.length / 4);
  applyObservation(model, out);

  if (step.do === 'type') typed.set(ref, step.text);
  if (step.do === 'clear') typed.set(ref, '');
  // Same independent check as typing, and it is the one that decides the
  // select mechanism: the bench asked for this option, so the field must read
  // it back — in the model AND, via the comparison below, on the real page
  // after the controlled component has had time to reassert itself.
  if (step.do === 'select') typed.set(ref, step.option);
  // Evaluated NOW, against the model as it stood one step after the action —
  // not at the end of the run. A scenario that flips a state and then flips it
  // back (opening a dropdown, then closing it) is a legitimate thing to
  // measure, and an end-of-run assertion would call the correct final state a
  // failure while silently accepting a stream that never delivered the flip.
  if (step.expectState) {
    const [want, expected] = step.expectState;
    stateChecks.push([
      ref,
      want,
      expected,
      step.label,
      model.get(ref)?.states.has(want) ?? false,
    ]);
  }

  console.log(
    `step ${String(i + 1).padStart(2)} ${step.do.padEnd(5)} "${step.label}" -> ${ref}  ` +
      `${isFull ? 'FULL RESYNC' : isDiff ? 'diff' : /\(unchanged\b/.test(out) ? 'UNCHANGED' : '??'}  ` +
      `model=${model.size} refs`,
  );
  if (scenario.stepDelayMs) await sleep(scenario.stepDelayMs);
}

// Ground truth, never shown to the "agent" above. Expanded and generously
// budgeted: the model side above is the production stream being measured,
// this side only has to be complete.
const truth = truthFrom(
  await call('browser_snapshot', { mode: 'full', expand: true, budgetTokens: 20000 }),
  scenario.expect.minRefs,
);

// ---------------------------------------------------------------------------
// Vacuity guards — BEFORE any verdict. A perfect score over an empty or
// diff-free run means nothing and must not print as green.
// ---------------------------------------------------------------------------

const vacuous = [];
if (model.size < scenario.expect.minRefs) {
  vacuous.push(`agent model tracks ${model.size} refs; scenario requires >= ${scenario.expect.minRefs}`);
}
if (diffSteps < scenario.expect.minDiffs) {
  vacuous.push(
    `only ${diffSteps} steps produced a diff; scenario requires >= ${scenario.expect.minDiffs}. ` +
      'A run of full restatements is trivially consistent and measures nothing about diffs.',
  );
}
if (scenario.expect.resync && fullSteps === 0) {
  vacuous.push('scenario expects at least one mid-run full resync and none happened — the fallback path went unexercised');
}
if (vacuous.length) {
  // A RED outranks the vacuity guards, and the reason is the whole of F3: when
  // the engine answers "nothing changed" instead of emitting a diff, the diff
  // COUNT collapses with it. Exiting 4 here would report the defect's own
  // symptom as "your scenario measures nothing" — the same laundering, one exit
  // code along. The guards still print, because they are true.
  console.error(
    midRunReds.length
      ? '\nCounts below the scenario minimums (a CONSEQUENCE of the RED below, not a scenario fault):'
      : '\nVACUOUS RUN — refusing to print a verdict:',
  );
  for (const v of vacuous) console.error('  - ' + v);
  if (!midRunReds.length) process.exit(4);
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

let checked = 0;
let phantom = 0;
let wrongValue = 0;
let wrongLabel = 0;
let wrongRole = 0;
let wrongState = 0;
let wrongOptions = 0;
let wrongHref = 0;
let wrongRows = 0;
let wrongIndependent = 0;
const problems = [...initialProblems];

/** Rows as one comparable string. dims is derived from rows on both sides. */
const rowsText = (e) => (e.rows ? e.rows.map((r) => r.join('|')).join('\n') : null);

for (const [ref, believed] of model) {
  const actual = truth.get(ref);
  if (!actual) {
    // The agent believes an element exists that does not. This is what causes
    // a wrong-element action.
    phantom++;
    problems.push(`${ref}: agent believes it exists (${believed.role} "${believed.label}"); it does not`);
    continue;
  }
  checked++;
  if (believed.value !== actual.value) {
    wrongValue++;
    problems.push(`${ref}: agent has value "${believed.value}", page has "${actual.value}"`);
  }
  if (believed.label !== actual.label) {
    wrongLabel++;
    problems.push(`${ref}: agent has label "${believed.label}", page has "${actual.label}"`);
  }
  if (believed.role !== '?' && believed.role !== actual.role) {
    wrongRole++;
    problems.push(`${ref}: agent thinks it is a ${believed.role}, page says ${actual.role}`);
  }
  // `[N options]` is the agent's only discriminator between a native select
  // and a custom combobox, and it also tells the agent whether it can answer
  // from the inline enumeration or must call browser_read. A stale one is a
  // wrong belief about the page like any other, and it used to be unmeasurable
  // because the reader dropped the marker.
  if ((believed.optionCount ?? null) !== (actual.optionCount ?? null)) {
    wrongOptions++;
    problems.push(
      `${ref}: agent has [${believed.optionCount ?? 'no'} options], page has ` +
        `[${actual.optionCount ?? 'no'} options]`,
    );
  }
  // href and rows are compared for EVERY scenario, not just the one built for
  // them. Most fixtures already carry links, so a stale href anywhere is now
  // visible for free — and a stale link target under a live, correct-looking
  // ref is a wrong-element action the agent has no way to detect.
  //
  // Both are skipped when the model only ever heard about this ref through a
  // `~` update (role '?'): it was never told the element's shape at all, which
  // is the hole the role check above already excuses, and reporting it twice
  // more would bury the real ones.
  if (believed.role !== '?') {
    if ((believed.href ?? '') !== (actual.href ?? '')) {
      wrongHref++;
      problems.push(
        `${ref} ("${actual.label}"): agent has href ${believed.href ?? '(none)'}, ` +
          `page has ${actual.href ?? '(none)'}`,
      );
    }
    const bRows = rowsText(believed);
    const aRows = rowsText(actual);
    if (bRows !== aRows) {
      wrongRows++;
      problems.push(
        `${ref} ("${actual.label}"): the agent's table content is not the page's.\n` +
          `      agent believes: ${bRows === null ? '(no rows at all)' : JSON.stringify(bRows)}\n` +
          `      page holds    : ${aRows === null ? '(no rows at all)' : JSON.stringify(aRows)}`,
      );
    }
  }
  for (const s of new Set([...believed.states, ...actual.states])) {
    if (believed.states.has(s) !== actual.states.has(s)) {
      wrongState++;
      problems.push(
        `${ref}: state "${s}" — agent ${believed.states.has(s) ? 'has' : 'lacks'} it, page ${actual.states.has(s) ? 'has' : 'lacks'} it`,
      );
    }
  }
}

// Independent checks — these do NOT trust the truth snapshot. The bench knows
// what it typed and what a click on a checkbox must do; if the diff stream
// never delivered that, both sides of the snapshot comparison can agree and
// still be wrong (same walker, same renderer).
for (const [ref, want] of typed) {
  const got = model.get(ref)?.value;
  if (got !== want) {
    wrongValue++;
    problems.push(`${ref}: bench set "${want}" but the diff stream delivered value "${got ?? '(nothing)'}"`);
  }
  // No separate "and the page agrees" check is needed: this one pins the
  // model to what the bench asked for, and the comparison above pins the model
  // to the page. A write that was reported and then undone — the controlled
  // select snapping back — fails one of the two whichever way the stream
  // reports it.
}
for (const [ref, state, expected, label, has] of stateChecks) {
  if (has !== expected) {
    wrongState++;
    problems.push(`${ref} ("${label}"): bench made "${state}" ${expected} but the stream delivered ${has}`);
  }
}

// The same pierce again, for content the bench put on the page itself. The
// fixture is ours, so the literals a click produces are known in advance and
// can be asserted against the believed model alone — no truth snapshot, no
// walker, nothing that could agree with itself.
for (const ind of scenario.independent ?? []) {
  // `byLabelTable`: the one flattened table in the model. Resolved by role
  // rather than by ref, because a ref number is exactly the thing a scenario
  // must never hardcode (see the header).
  if (ind.ref === 'byLabelTable') {
    const tables = [...model.entries()].filter(([, e]) => e.role === 'table');
    if (tables.length !== 1) {
      wrongIndependent++;
      problems.push(
        `independent check: the model holds ${tables.length} tables (need exactly 1) — ` +
          `cannot check rowsInclude "${ind.rowsInclude}"`,
      );
      continue;
    }
    const [tref, table] = tables[0];
    const text = rowsText(table);
    if (text === null || !text.includes(ind.rowsInclude)) {
      wrongIndependent++;
      problems.push(
        `${tref}: the bench put "${ind.rowsInclude}" in this table and the stream never ` +
          `delivered it. Model holds: ${text === null ? '(no rows at all)' : JSON.stringify(text)}`,
      );
    }
    continue;
  }
  if (ind.link !== undefined) {
    const hits = [...model.entries()].filter(([, e]) => e.label === ind.link && e.role === 'link');
    if (hits.length !== 1) {
      wrongIndependent++;
      problems.push(`independent check: "${ind.link}" resolves to ${hits.length} links (need exactly 1)`);
      continue;
    }
    const [lref, link] = hits[0];
    if (link.href !== ind.href) {
      wrongIndependent++;
      problems.push(
        `${lref} ("${ind.link}"): the bench set this link's target to ${ind.href} and the ` +
          `stream delivered ${link.href ?? '(no href at all)'} — a stable label over a ` +
          'mutated target is precisely the wrong-element action an agent cannot detect',
      );
    }
    continue;
  }
  if (ind.anyLabel !== undefined) {
    const hits = [...model.values()].filter((e) => e.label === ind.anyLabel);
    if (!hits.length) {
      wrongIndependent++;
      problems.push(
        `independent check: no element in the model is labelled "${ind.anyLabel}", but the ` +
          'bench made the page say so',
      );
    }
    continue;
  }
  wrongIndependent++;
  problems.push(`independent check not understood by this bench: ${JSON.stringify(ind)}`);
}

const missed = [...truth.keys()].filter((r) => !model.has(r));

console.log('');
console.log(`refs the agent tracked      : ${model.size}`);
console.log(`refs verified against page  : ${checked}`);
console.log(`PHANTOM refs (do not exist) : ${phantom}`);
console.log(`WRONG VALUES                : ${wrongValue}`);
console.log(`WRONG LABELS                : ${wrongLabel}`);
console.log(`WRONG ROLES                 : ${wrongRole}`);
console.log(`WRONG STATE FLAGS           : ${wrongState}`);
console.log(`WRONG [N options] MARKERS   : ${wrongOptions}`);
console.log(`WRONG HREF                  : ${wrongHref}`);
console.log(`WRONG TABLE CONTENT         : ${wrongRows}`);
if (scenario.independent) {
  console.log(`FAILED INDEPENDENT CHECKS   : ${wrongIndependent} of ${scenario.independent.length}`);
}
console.log(`refs on page agent never saw: ${missed.length} (elision/budget — reported, not scored)`);
// Named, not just counted. "2 refs you never saw" is unactionable; knowing
// they are two paragraphs of text is the difference between a shrug and a
// diagnosis.
for (const r of missed.slice(0, 8)) {
  const e = truth.get(r);
  console.log(`    ${r} ${e.role} "${e.label}"${e.value ? ` ="${e.value}"` : ''}`);
}
console.log(`steps: ${scenario.steps.length} (${diffSteps} diffs, ${fullSteps} full resyncs)`);
if (scenario.expect.suppression) {
  console.log(`volatility suppression note : ${sawSuppression ? 'seen' : 'NOT SEEN'}`);
}
console.log(`observation cost            : ${observedTokens} tokens for ${scenario.steps.length} actions`);

if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems.slice(0, 20)) console.log(`  - ${p}`);
  if (problems.length > 20) console.log(`  … and ${problems.length - 20} more`);
}

let red =
  phantom + wrongValue + wrongLabel + wrongRole + wrongState + wrongOptions +
    wrongHref + wrongRows + wrongIndependent >
  0;
if (scenario.expect.suppression && !sawSuppression) {
  console.log('\nRED: the ticking clock was never suppressed — the volatility path did not fire.');
  red = true;
}
if (midRunReds.length) {
  console.log(
    '\nRED: the engine reported "unchanged" for an action the bench knows mutated the ' +
      'page — information is missing from the stream',
  );
  for (const r of midRunReds) console.log(`  - ${r}`);
  red = true;
}

console.log(
  `\nRESULT: ${red ? 'RED — diffs do not describe the real page' : 'GREEN — the diff stream is faithful'}`,
);
process.exit(red ? 1 : 0);
