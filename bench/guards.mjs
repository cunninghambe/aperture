/**
 * Live guard probe — the refusals and retractions, measured end to end.
 *
 * `fidelity.mjs` asks whether the diff stream describes the page. This asks a
 * different question: whether the things Aperture says it REFUSES, it actually
 * refuses, and whether the retractions it says it emits actually arrive. Those
 * are not diff-fidelity claims, so they do not belong in a fidelity scenario —
 * but they are exactly the claims that were false the last time anyone
 * measured them instead of reading the code.
 *
 * Every check is against the page's OWN evidence where one exists. Aperture
 * reporting `error:` is not proof that nothing was written; the fixture's
 * change-event log is. Three of the seven checks below failed against the
 * build this file was written for.
 *
 * Usage: node bench/guards.mjs <token> [fixtureBase]
 * Exit: 0 all guards hold · 1 a guard failed · 3 the probe could not run
 */

import { applyObservation, parseElementLine } from './lib/streamModel.mjs';

const TOKEN = process.argv[2];
const BASE = process.argv[3] ?? 'http://127.0.0.1:8899';
if (!TOKEN) {
  console.error('usage: node bench/guards.mjs <token> [fixtureBase]');
  process.exit(3);
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

const model = new Map();
const checks = [];
function check(id, claim, ok, detail = '') {
  checks.push({ id, claim, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}${detail ? `\n        ${detail}` : ''}`);
}

function refFor(label, role) {
  const hits = [...model.entries()].filter(
    ([, e]) => e.label === label && (!role || e.role === role),
  );
  if (hits.length !== 1) {
    console.error(
      `cannot resolve "${label}"${role ? ` (${role})` : ''}: ${hits.length} matches.\n` +
        [...model.entries()].map(([r, e]) => `  ${r} ${e.role} "${e.label}"`).join('\n'),
    );
    process.exit(3);
  }
  return hits[0][0];
}

/** The page's own record of what actually happened to it. */
async function witness() {
  const t = await call('browser_read', {});
  const m = /events: (.*)/.exec(t);
  return m ? m[1].trim() : '(no witness line)';
}

// ---------------------------------------------------------------------------

console.log('# Live guard probe\n');

await call('browser_navigate', {
  action: 'goto',
  url: `${BASE}/guards.html?guardrun=${Date.now()}`,
});
await sleep(2500);

const initial = await call('browser_snapshot', { mode: 'full' });
if (!/^FULL SNAPSHOT #/m.test(initial)) {
  console.error('initial snapshot failed:\n' + initial.slice(0, 400));
  process.exit(3);
}
applyObservation(model, initial);
console.log(`initial full snapshot: ${model.size} refs tracked\n`);

// --- G1: a removed NON-ADDRESSABLE container retires the refs inside it -----

const alpha = refFor('Alpha action', 'button');
const beta = refFor('Beta action', 'button');
{
  const out = await call('browser_act', { action: 'click', ref: refFor('Drop the panel', 'button') });
  applyObservation(model, out);
  const named = new RegExp(`gone[:)][^\\n]*\\b${alpha}\\b`).test(out) &&
    new RegExp(`gone[:)][^\\n]*\\b${beta}\\b`).test(out);
  check(
    'G1a',
    'the diff retires refs inside a removed <div> (non-addressable root)',
    named,
    named ? '' : `neither ${alpha} nor ${beta} was retired. Diff was:\n        ` +
      out.split('\n').filter((l) => /^[~+\->!(]/.test(l)).join('\n        '),
  );
  check(
    'G1b',
    'the mechanical reader drops them when it applies that diff',
    !model.has(alpha) && !model.has(beta),
    `${alpha}: ${model.has(alpha) ? 'still held' : 'dropped'}, ` +
      `${beta}: ${model.has(beta) ? 'still held' : 'dropped'}`,
  );
}

// --- G2: a dependent select's option list is retracted, not left stale ------

{
  const stateRef = refFor('State', 'combobox');
  const before = model.get(stateRef).optionCount;
  const out = await call('browser_act', {
    action: 'select',
    ref: refFor('Country', 'combobox'),
    option: 'United States',
  });
  applyObservation(model, out);
  await sleep(300);
  const after = model.get(stateRef)?.optionCount;

  // Truth, from a fresh full snapshot, never shown to the model above.
  const truthText = await call('browser_snapshot', { mode: 'full', expand: true, budgetTokens: 20000 });
  let truthCount;
  for (const line of truthText.split('\n')) {
    const el = parseElementLine(line);
    if (el && el.ref === stateRef) truthCount = el.optionCount;
  }

  check(
    'G2',
    'a country -> state cascade updates the [N options] marker',
    after === truthCount && after !== before,
    `model had [${before}], now holds [${after}]; page has [${truthCount}]`,
  );
}

// --- G3/G4: a disabled select refuses, and writes nothing -------------------

{
  const before = await witness();
  const out = await call('browser_act', {
    action: 'select',
    ref: refFor('Locked field', 'combobox'),
    option: 'Beta',
  });
  const after = await witness();
  check(
    'G3',
    'action:"select" refuses a <select disabled> and writes nothing',
    /^error:/.test(out) && !after.includes('locked=') && after === before,
    `reply: ${out.split('\n')[0].slice(0, 110)}\n        witness: ${after}`,
  );
}

{
  const line = initial.split('\n').find((l) => l.includes('"Grouped field"')) ?? '';
  const before = await witness();
  const out = await call('browser_act', {
    action: 'select',
    ref: refFor('Grouped field', 'combobox'),
    option: 'Why',
  });
  const after = await witness();
  check(
    'G4a',
    'action:"select" refuses a select inside <fieldset disabled>',
    /^error:/.test(out) && !after.includes('grouped=') && after === before,
    `reply: ${out.split('\n')[0].slice(0, 110)}\n        witness: ${after}`,
  );
  check(
    'G4b',
    'the snapshot line for that select SAYS disabled, so the agent can see why',
    /\bdisabled\b/.test(line),
    `line: ${line.trim() || '(not found)'}`,
  );
}

// --- G5: a blank option query does not select the placeholder ---------------

{
  const shipRef = refFor('Shipping', 'combobox');
  const valueBefore = model.get(shipRef).value;
  const before = await witness();
  const out = await call('browser_act', { action: 'select', ref: shipRef, option: '   ' });
  const after = await witness();
  check(
    'G5',
    'a blank option query is refused, not resolved to <option value="">',
    /^error:/.test(out) && !after.includes('ship=') && after === before,
    `was ="${valueBefore}"; reply: ${out.split('\n')[0].slice(0, 110)}\n        witness: ${after}`,
  );
}

// --- G6: error text from a hostile select is bounded and neutralized --------

{
  const out = await call('browser_act', {
    action: 'select',
    ref: refFor('Hostile labels', 'combobox'),
    option: 'zzzzz',
  });
  const read = await call('browser_read', { ref: refFor('Hostile labels', 'combobox') });
  const RLO = String.fromCharCode(0x202e);
  const PDF = String.fromCharCode(0x202c);
  check(
    'G6a',
    'a no-match error is smaller than a browser_read of the same element',
    out.length < 3000 && out.length < read.length,
    `error ${out.length} chars (~${Math.ceil(out.length / 4)} tokens); ` +
      `browser_read ${read.length} chars`,
  );
  check(
    'G6b',
    'candidate labels are escaped, so a page cannot forge an option in them',
    out.includes('Beta\\" [disabled] and \\"Gamma') &&
      !out.includes(RLO) && !out.includes(PDF),
    `escaped: ${out.includes('Beta\\" [disabled] and \\"Gamma')}, ` +
      `bidi stripped: ${!out.includes(RLO) && !out.includes(PDF)}`,
  );
}

// --- G7: the obstruction gate applies to select, and is not a blanket no ----

{
  const shipRef = refFor('Shipping', 'combobox');
  applyObservation(
    model,
    await call('browser_act', { action: 'click', ref: refFor('Show cookie notice', 'button') }),
  );
  await sleep(300);

  const before = await witness();
  const blocked = await call('browser_act', {
    action: 'select', ref: shipRef, option: 'Overnight',
  });
  const after = await witness();
  check(
    'G7a',
    'action:"select" behind an aria-modal overlay is refused, and writes nothing',
    /^error:/.test(blocked) && /covered by/.test(blocked) && !after.includes('ship=') &&
      after === before,
    `reply: ${blocked.split('\n')[0].slice(0, 140)}\n        witness: ${after}`,
  );

  applyObservation(
    model,
    await call('browser_act', { action: 'click', ref: refFor('Dismiss', 'button') }),
  );
  await sleep(300);
  const allowed = await call('browser_act', {
    action: 'select', ref: shipRef, option: 'Overnight',
  });
  const finalWitness = await witness();
  check(
    'G7b',
    'and the same select succeeds once the overlay is gone (not a blanket refusal)',
    /^ok select/m.test(allowed) && finalWitness.includes('ship=ovn'),
    `reply: ${allowed.split('\n')[0].slice(0, 110)}\n        witness: ${finalWitness}`,
  );
}

// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} guards hold`);
console.log(`\nRESULT: ${failed.length ? 'RED — ' + failed.map((f) => f.id).join(', ') : 'GREEN'}`);
process.exit(failed.length ? 1 : 0);
