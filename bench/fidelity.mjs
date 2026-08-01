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
 *   2. The comparison covers ref existence, role, label, value, and state
 *      flags. It does NOT cover containment structure or position — a diff
 *      stream that reordered the world would still pass. "Faithful" here
 *      means "every element the agent believes in exists, as described",
 *      not "the agent could redraw the page".
 *
 * Scenarios target elements BY LABEL, resolved against the agent-side model.
 * The old hardcoded e-numbers were how the historical false green happened
 * (a second scenario in one session typed into refs that no longer existed).
 * Label targeting also makes the run self-checking: if the diff stream fails
 * to deliver a label update, the next step cannot even resolve its target.
 *
 * Usage: node bench/fidelity.mjs <token> [form|rerender|widgets|biglist|selects]
 *
 * Exit codes — anything nonzero must never be read as "roughly green":
 *   0  GREEN
 *   1  RED: the stream is missing or wrong somewhere
 *   2  ground truth unusable (elided, budget-cut, or failed) — no verdict
 *   3  a step did not run — no verdict
 *   4  vacuous run: counts below the scenario's minimums — no verdict.
 *      An empty measurement scoring perfect is the failure mode this whole
 *      file exists to prevent.
 */

import {
  applyObservation,
  parseElementLine,
} from './lib/streamModel.mjs';

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
    console.error('ground truth is not a full snapshot — cannot judge anything.\n' + text.slice(0, 300));
    process.exit(2);
  }
  if (text.includes('more lines beyond budget') || /^\s*… \d+ more /m.test(text)) {
    console.error(
      'ground truth incomplete — cannot judge phantoms.\n' +
        'The reference snapshot was elided (collapsed run or budget cut), so\n' +
        'refs that exist on the page are missing from it. Raise budgetTokens\n' +
        'or fix expand:true; do NOT interpret the result as phantom refs.',
    );
    process.exit(2);
  }

  const truth = new Map();
  for (const line of text.split('\n')) {
    const el = parseElementLine(line);
    if (el) truth.set(el.ref, el);
  }
  if (truth.size < minRefs) {
    console.error(
      `ground truth holds only ${truth.size} refs (scenario expects >= ${minRefs}).\n` +
        'The reference snapshot is not credible — refusing to judge against it.',
    );
    process.exit(2);
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

function resolveTarget(model, step) {
  const wantTyped = step.do === 'type' || step.do === 'clear';
  const hits = [...model.entries()].filter(
    ([, e]) => e.label === step.label && (!wantTyped || TYPE_ROLES.has(e.role)),
  );
  if (hits.length !== 1) {
    console.error(
      `step "${step.label}" resolves to ${hits.length} elements in the agent model ` +
        `(need exactly 1). The model holds:\n` +
        [...model.entries()].map(([r, e]) => `  ${r} ${e.role} "${e.label}"`).join('\n'),
    );
    process.exit(3);
  }
  return hits[0][0];
}

/** Reasons a step must not be scored. Anything caught here is exit 3. */
function stepFailure(out) {
  if (!out || !out.trim()) return 'empty response from the server';
  if (/could not be acted on|is not a known element|^error:|\nerror:/m.test(out)) return out.trim().slice(0, 300);
  if (!/^ok (click|type|hover|scroll|key|clear|select)/m.test(out)) return 'no ok-acknowledgement in response';
  if (!/^(page #|FULL SNAPSHOT #)/m.test(out)) return 'no observation followed the action';
  if (/\(no visible change\)/.test(out)) {
    return 'action produced no observable change — this scenario expects every step to change the page';
  }
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
    console.error(`step ${i + 1} (${step.do} "${step.label}" -> ${ref}) did not run:\n${failure}`);
    process.exit(3);
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
      `${isFull ? 'FULL RESYNC' : isDiff ? 'diff' : '??'}  model=${model.size} refs`,
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
  console.error('\nVACUOUS RUN — refusing to print a verdict:');
  for (const v of vacuous) console.error('  - ' + v);
  process.exit(4);
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
const problems = [...initialProblems];

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
  phantom + wrongValue + wrongLabel + wrongRole + wrongState + wrongOptions > 0;
if (scenario.expect.suppression && !sawSuppression) {
  console.log('\nRED: the ticking clock was never suppressed — the volatility path did not fire.');
  red = true;
}

console.log(
  `\nRESULT: ${red ? 'RED — diffs do not describe the real page' : 'GREEN — the diff stream is faithful'}`,
);
process.exit(red ? 1 : 0);
