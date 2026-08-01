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
 * Usage: node bench/fidelity.mjs <token> [form|rerender|widgets|biglist]
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
// ---------------------------------------------------------------------------

const STATE_WORDS = new Set([
  'checked', 'disabled', 'expanded', 'selected', 'required',
  'focused', 'modal', 'readonly', 'invalid', 'live',
]);

const unesc = (s) => s.replace(/\\(.)/g, '$1');

/** Full-snapshot / subtree line: `role eN "label" ="value" … states`. */
function parseElementLine(line) {
  const m = /^\s*(\w+) (e\d+)(.*)$/.exec(line);
  if (!m) return null;
  const [, role, ref, restRaw] = m;
  let rest = restRaw;
  let label = '';
  let value = '';

  const nm = /^ "((?:[^"\\]|\\.)*)"/.exec(rest);
  if (nm) {
    label = unesc(nm[1]);
    rest = rest.slice(nm[0].length);
  }
  const vm = / ="((?:[^"\\]|\\.)*)"/.exec(rest);
  if (vm) {
    value = unesc(vm[1]);
    rest = rest.slice(0, vm.index) + rest.slice(vm.index + vm[0].length);
  }

  const states = new Set();
  const words = rest.trim().split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if (STATE_WORDS.has(words[i])) states.add(words[i]);
    else break;
  }
  return { role, ref, label, value, states };
}

/**
 * The agent's mental model, built ONLY from what it was told.
 * ref -> { role, label, value, states:Set }.
 */
function applyObservation(model, text) {
  for (const line of text.split('\n')) {
    if (/^FULL SNAPSHOT #/.test(line)) {
      model.clear();
      continue;
    }

    // Replace destroys refs: `! e3 replaced (gone: e8 e9):` — subtree lines
    // that follow re-add the survivors and newcomers.
    const rep = /^! (e\d+) replaced(?: \(gone: ([^)]*)\))?:/.exec(line);
    if (rep) {
      if (rep[2]) for (const r of rep[2].trim().split(/\s+/)) model.delete(r);
      continue;
    }

    const rm = /^- (e\d+) removed/.exec(line);
    if (rm) {
      model.delete(rm[1]);
      continue;
    }

    if (/^> e\d+ moved/.test(line)) continue; // position is not tracked

    // Diff update: `~ e3 "name" ="value" "text" +focused -checked`
    const upd = /^~ (e\d+)(.*)$/.exec(line);
    if (upd) {
      const entry = model.get(upd[1]) ?? { role: '?', label: '', value: '', states: new Set() };
      let rest = upd[2];

      const vm = / ="((?:[^"\\]|\\.)*)"/.exec(rest);
      if (vm) {
        entry.value = unesc(vm[1]);
        rest = rest.slice(0, vm.index) + rest.slice(vm.index + vm[0].length);
      }
      // First remaining quoted string is the new name; a second is the text
      // delta, which a full snapshot cannot verify and is ignored here.
      const nm = / "((?:[^"\\]|\\.)*)"/.exec(rest);
      if (nm) {
        entry.label = unesc(nm[1]);
        rest = rest.slice(0, nm.index) + rest.slice(nm.index + nm[0].length);
      }
      // Strip any remaining quoted segments (the text delta) BEFORE the state
      // token loop — quoted page text containing "+... checked" must not be
      // able to inject state flags into the model.
      rest = rest.replace(/ "((?:[^"\\]|\\.)*)"/g, '');
      let mode = null;
      for (const tok of rest.trim().split(/\s+/)) {
        if (!tok) continue;
        if (tok.startsWith('+')) mode = 'on';
        else if (tok.startsWith('-')) mode = 'off';
        const word = tok.replace(/^[+-]/, '');
        if (mode && STATE_WORDS.has(word)) {
          if (mode === 'on') entry.states.add(word);
          else entry.states.delete(word);
        }
      }
      model.set(upd[1], entry);
      continue;
    }

    // Anything else that looks like an element line (full snapshots, add and
    // replace subtrees) restates the element outright.
    const el = parseElementLine(line);
    if (el) model.set(el.ref, el);
  }
  return model;
}

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
  if (!/^ok (click|type|hover|scroll|key|clear)/m.test(out)) return 'no ok-acknowledgement in response';
  if (!/^(page #|FULL SNAPSHOT #)/m.test(out)) return 'no observation followed the action';
  if (/\(no visible change\)/.test(out)) {
    return 'action produced no observable change — this scenario expects every step to change the page';
  }
  return null;
}

console.log(`# Diff fidelity — scenario "${which}"\n`);

await call('browser_navigate', { action: 'goto', url: scenario.url });
await sleep(2500);

const model = new Map();
const initial = await call('browser_snapshot', { mode: 'full' });
if (!/^FULL SNAPSHOT #/m.test(initial)) {
  console.error('initial snapshot failed:\n' + initial.slice(0, 300));
  process.exit(3);
}
applyObservation(model, initial);
console.log(`initial full snapshot: ${model.size} refs tracked`);

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
  if (step.expectState) stateChecks.push([ref, step.expectState[0], step.expectState[1], step.label]);

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
const problems = [];

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
    problems.push(`${ref}: bench typed "${want}" but the diff stream delivered value "${got ?? '(nothing)'}"`);
  }
}
for (const [ref, state, expected, label] of stateChecks) {
  const has = model.get(ref)?.states.has(state) ?? false;
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
console.log(`refs on page agent never saw: ${missed.length} (elision/budget — reported, not scored)`);
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

let red = phantom + wrongValue + wrongLabel + wrongRole + wrongState > 0;
if (scenario.expect.suppression && !sawSuppression) {
  console.log('\nRED: the ticking clock was never suppressed — the volatility path did not fire.');
  red = true;
}

console.log(
  `\nRESULT: ${red ? 'RED — diffs do not describe the real page' : 'GREEN — the diff stream is faithful'}`,
);
process.exit(red ? 1 : 0);
