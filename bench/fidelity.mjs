/**
 * Diff fidelity.
 *
 * The precondition for the whole design. If a base snapshot plus the diff
 * stream does not describe the same page as a fresh full snapshot, then no
 * model can succeed on diffs regardless of how good it is — the information
 * simply is not there.
 *
 * Method: drive a real action sequence, accumulate what the agent was told,
 * then take a fresh full snapshot and check that every element the agent
 * believes exists really does, with the value it was told.
 *
 * This is mechanical and deterministic. It does not measure task success — it
 * measures whether task success is *possible*.
 *
 * Usage: node bench/fidelity.mjs <token>
 */

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error('usage: node bench/fidelity.mjs <token>');
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

/**
 * The agent's mental model: ref -> current value, built ONLY from what it was
 * told. A full snapshot resets it; a diff updates it.
 */
function applyObservation(model, text) {
  if (text.includes('FULL SNAPSHOT')) model.clear();

  for (const line of text.split('\n')) {
    // Full-snapshot / added-subtree line: `textbox e3 "Label" ="value"`
    const full = /^\s*\w+ (e\d+) "([^"]*)"(?: ="([^"]*)")?/.exec(line);
    if (full) {
      model.set(full[1], { label: full[2], value: full[3] ?? '' });
      continue;
    }
    // Diff update: `~ e3 ="Brad" +focused`
    const upd = /^~ (e\d+)(?: "([^"]*)")?(?: ="([^"]*)")?/.exec(line);
    if (upd) {
      const prev = model.get(upd[1]) ?? { label: '', value: '' };
      model.set(upd[1], {
        label: upd[2] ?? prev.label,
        value: upd[3] !== undefined ? upd[3] : prev.value,
      });
      continue;
    }
    // Replace destroys refs: `! e3 replaced (gone: e8 e9 e12):`
    const rep = /^! e\d+ replaced \(gone: ([^)]+)\)/.exec(line);
    if (rep) {
      for (const r of rep[1].trim().split(/\s+/)) model.delete(r);
      continue;
    }
    // Diff removal: `- e19 removed`
    const rm = /^- (e\d+) removed/.exec(line);
    if (rm) model.delete(rm[1]);
  }
  return model;
}

/**
 * Ground truth from a fresh full snapshot.
 *
 * The truth snapshot must be taken with `expand:true`. A default snapshot
 * collapses runs of same-shape siblings into `… 3 more listitems`, so the refs
 * behind the elision are absent from the truth map while being perfectly real
 * on the page — and every one of them is then reported as a phantom. That bug
 * cost a day and indicted an engine that was correct; the guard below is here
 * so it cannot happen twice.
 */
function truthFrom(text) {
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
    const m = /^\s*\w+ (e\d+) "([^"]*)"(?: ="([^"]*)")?/.exec(line);
    if (m) truth.set(m[1], { label: m[2], value: m[3] ?? '' });
  }
  return truth;
}

const SCENARIOS = {
  form: {
    url: 'http://127.0.0.1:8899/application.html',
    steps: [
      ['e3', 'Brad'], ['e4', 'Cunningham'], ['e5', 'brad@example.com'],
      ['e7', '1 Example Street'], ['e9', 'Melbourne'], ['e10', '3000'],
      ['e11', 'PlusLife'], ['e12', 'Director'],
    ],
  },
  // The hard case: every keystroke tears down and rebuilds the whole list.
  rerender: {
    url: 'http://127.0.0.1:8899/rerender.html',
    steps: [['e2', 'anker'], ['e2', 'dock'], ['e2', 'a']],
  },
};
const which = process.argv[3] ?? 'form';
const scenario = SCENARIOS[which];
if (!scenario) { console.error('unknown scenario: ' + which); process.exit(1); }
const FIELDS = scenario.steps;

console.log('# Diff fidelity\n');

await call('browser_navigate', { action: 'goto', url: scenario.url });
await sleep(2500);

const model = new Map();
applyObservation(model, await call('browser_snapshot', { mode: 'full' }));

let observedTokens = 0;
for (const [ref, value] of FIELDS) {
  const out = await call('browser_act', { action: 'type', ref, text: value });

  // A step that never ran must not be scored. Scenario refs are positional and
  // assume a FRESH browser session: ref numbers keep counting up per tab, so a
  // second scenario in the same session types into refs that no longer exist,
  // every action fails, no diffs are produced — and the run reports a perfect
  // GREEN off an empty model. A false green here is worse than any red.
  if (/could not be acted on|is not a known element/.test(out)) {
    console.error(
      `step "${ref}" did not run — the browser rejected the ref:\n${out.trim().slice(0, 200)}\n\n` +
        'Run ONE scenario per browser session, against a freshly started Aperture.',
    );
    process.exit(3);
  }

  observedTokens += Math.ceil(out.length / 4);
  applyObservation(model, out);
}

// Ground truth, never shown to the "agent" above. Expanded and generously
// budgeted: the model side above is the production stream being measured, this
// side only has to be complete.
const truth = truthFrom(
  await call('browser_snapshot', { mode: 'full', expand: true, budgetTokens: 20000 }),
);

let checked = 0;
let wrongValue = 0;
let phantom = 0;
const problems = [];

for (const [ref, believed] of model) {
  const actual = truth.get(ref);
  if (!actual) {
    // The agent believes an element exists that does not. This is what causes
    // a wrong-element action.
    phantom++;
    problems.push(`${ref}: agent believes it exists; it does not`);
    continue;
  }
  checked++;
  if (believed.value !== actual.value) {
    wrongValue++;
    problems.push(`${ref}: agent has "${believed.value}", page has "${actual.value}"`);
  }
}

const missed = [...truth.keys()].filter((r) => !model.has(r));

console.log(`refs the agent tracked      : ${model.size}`);
console.log(`refs verified against page  : ${checked}`);
console.log(`WRONG VALUES                : ${wrongValue}`);
console.log(`PHANTOM refs (do not exist) : ${phantom}`);
console.log(`refs on page agent never saw: ${missed.length}`);
console.log(`observation cost            : ${observedTokens} tokens for ${FIELDS.length} actions`);

if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems.slice(0, 12)) console.log(`  - ${p}`);
}

const green = wrongValue === 0 && phantom === 0;
console.log(`\nRESULT: ${green ? 'GREEN — the diff stream is faithful' : 'RED — diffs do not describe the real page'}`);
process.exit(green ? 0 : 1);
