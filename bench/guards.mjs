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

// --- G12: an unchanged observation is honest, and costs nothing -------------
//
// Both halves are unit-untestable by construction: they are claims about state
// the engine keeps ACROSS calls (the page state id, and the epoch's diff
// budget), and `observe()` needs a live WebContents. So they are measured here,
// end to end, against the ids the agent actually receives.

{
  // A fresh full snapshot opens a new epoch, so the 12-diff budget G12b
  // reasons about starts from a known zero rather than from whatever the guards
  // above happened to spend on this page.
  applyObservation(model, await call('browser_snapshot', { mode: 'full' }));
  const shipRef = refFor('Shipping', 'combobox');

  // A select, not a click: this fixture's selects change one value and one
  // witness line, so the act's own diff is small and deterministic, and no
  // modal or hit-test is involved.
  const acted = await call('browser_act', {
    action: 'select', ref: shipRef, option: 'Standard',
  });
  applyObservation(model, acted);
  if (!/^page #\d+\.\d+ \(diff from/m.test(acted)) {
    console.error(
      'G12 could not run: the act that seeds the epoch did not return a diff.\n' +
        acted.slice(0, 400),
    );
    process.exit(3);
  }

  const seqOf = (t) => (/^page #(\d+\.\d+) \(unchanged/m.exec(t) ?? [])[1];
  const headOf = (t) =>
    (t.split('\n').find((l) => /^(page #|FULL SNAPSHOT #)/.test(l)) ?? t.slice(0, 120)).slice(0, 120);

  const first = await call('browser_snapshot', { mode: 'auto' });
  const second = await call('browser_snapshot', { mode: 'auto' });
  check(
    'G12a',
    'a redundant snapshot says so in its own words, and does not advance the page state id',
    /\(unchanged — you already hold/.test(second) &&
      Boolean(seqOf(first)) &&
      seqOf(first) === seqOf(second),
    `first:  ${headOf(first)}\n        second: ${headOf(second)}`,
  );

  // Thirteen unchanged observations in total (the two above plus eleven more),
  // one MORE than MAX_DIFFS_PER_EPOCH. On the old accounting each of them took
  // a slot, so the act that follows was forced to resync. Nothing on the page
  // changed across any of them.
  let unchangedSeen = /^page #\d+\.\d+ \(unchanged/m.test(first) ? 1 : 0;
  if (/^page #\d+\.\d+ \(unchanged/m.test(second)) unchangedSeen++;
  for (let i = 0; i < 11; i++) {
    const t = await call('browser_snapshot', { mode: 'auto' });
    if (/^page #\d+\.\d+ \(unchanged/m.test(t)) unchangedSeen++;
  }

  const after = await call('browser_act', {
    action: 'select', ref: shipRef, option: 'Overnight',
  });
  applyObservation(model, after);
  check(
    'G12b',
    '13 unchanged observations do not spend the 12-diff budget: the next act still gets a diff',
    // `unchangedSeen === 13` is not decoration. Without it the guard passes
    // vacuously if the probes come back as fulls — each full resets the budget,
    // so the final act would get its diff having never exercised the unchanged
    // path at all. The guard must prove it observed the thing it is about.
    unchangedSeen === 13 &&
      /^page #\d+\.\d+ \(diff from/m.test(after) &&
      !/^FULL SNAPSHOT #/m.test(after),
    `${unchangedSeen}/13 snapshots reported unchanged; the act after them returned ` +
      `${/^FULL SNAPSHOT #/m.test(after) ? 'a FULL SNAPSHOT — the budget was consumed' : 'a diff'}` +
      `\n        ${headOf(after)}`,
  );
}

// --- G13: the blind fields, on the fast tripwire ----------------------------
//
// `blindfields` (bench/fidelity.mjs) is the thorough measurement of this class,
// and it costs one freshly started Aperture and a couple of minutes. This is the
// cheap end-to-end version that runs against every live build: two clicks, two
// string checks, no model bookkeeping at all.
//
// Recorded because the obvious spelling of G13a is weaker than it looks: a click
// FOCUSES its target, and a focus flip is a state delta propDelta always
// reported — so against the pre-fix build the first click on "Advance shipment"
// answered `page #3.1 (diff from #3.0)` / `~ e3 +focused`, a diff that is busy
// and empty. The `(unchanged` clause below is therefore NOT the load-bearing
// half; `SHIPPED` is. Both are kept: the first proves the observation is a real
// report, the second proves the report contains the page.
// (docs/design/blindfields-red-record.md §2.)

{
  const rosterModel = new Map();
  await call('browser_navigate', {
    action: 'goto',
    url: `${BASE}/roster.html?guardrun=${Date.now()}`,
  });
  await sleep(2500);
  const rosterInitial = await call('browser_snapshot', { mode: 'full' });
  if (!/^FULL SNAPSHOT #/m.test(rosterInitial)) {
    console.error('G13 could not run: roster.html did not produce a full snapshot.\n' + rosterInitial.slice(0, 400));
    process.exit(3);
  }
  applyObservation(rosterModel, rosterInitial);

  const one = (label) => {
    const hits = [...rosterModel.entries()].filter(([, e]) => e.label === label && e.role === 'button');
    if (hits.length !== 1) {
      console.error(`G13 could not run: "${label}" resolves to ${hits.length} buttons on roster.html`);
      process.exit(3);
    }
    return hits[0][0];
  };

  const advanced = await call('browser_act', { action: 'click', ref: one('Advance shipment') });
  check(
    'G13a',
    'a click that rewrites table cells reports the new cells, not "nothing changed"',
    !/\(unchanged/.test(advanced) && advanced.includes('SHIPPED'),
    `unchanged: ${/\(unchanged/.test(advanced)}, carries "SHIPPED": ${advanced.includes('SHIPPED')}\n        ` +
      advanced.split('\n').filter((l) => /^[~+\->!(]|^page #|^FULL SNAPSHOT/.test(l)).join('\n        ').slice(0, 600),
  );
  await sleep(300);

  const rotated = await call('browser_act', { action: 'click', ref: one('Rotate link') });
  check(
    'G13b',
    'a link whose href moves under a stable label reports the new target',
    rotated.includes('/checkout-v2'),
    `carries "/checkout-v2": ${rotated.includes('/checkout-v2')}\n        ` +
      rotated.split('\n').filter((l) => /^[~+\->!(]|^page #|^FULL SNAPSHOT/.test(l)).join('\n        ').slice(0, 600),
  );
}

// --- G14: a page that suppresses input listeners is not a broken browser ----
//
// The Gate-2 HIGH, made permanent (docs/design/tier3.md §1.1, §1.6). The
// shipped W1 arms its witness on `window` at ACT TIME; a page that registered
// `stopImmediatePropagation` capture handlers at parse time silences it,
// because listener order on a node is registration order. The click LANDS —
// suppressor.html's acknowledgement line grows — and W1 answers with the
// terminal "the browser is broken, tell the human" error. That is a healthy
// page (the drag/overlay/editor-library class) converted into a false alarm.
//
// The two halves are BOTH load-bearing and neither implies the other:
//   - `ok click` alone would pass on a build whose witness was simply deleted.
//   - "acknowledged 1 time" alone proves the click landed, which is exactly
//     what is true in the RED case too — it is what makes the alarm FALSE.
// Together they say: the input arrived AND the engine agreed it arrived.
//
// Recorded RED against the pre-fix build before the revision landed:
// docs/design/g14-red-record.md.

{
  const supModel = new Map();
  await call('browser_navigate', {
    action: 'goto',
    url: `${BASE}/suppressor.html?guardrun=${Date.now()}`,
  });
  await sleep(2500);
  const supInitial = await call('browser_snapshot', { mode: 'full' });
  if (!/^FULL SNAPSHOT #/m.test(supInitial)) {
    console.error(
      'G14 could not run: suppressor.html did not produce a full snapshot.\n' +
        supInitial.slice(0, 400),
    );
    process.exit(3);
  }
  applyObservation(supModel, supInitial);

  const hits = [...supModel.entries()].filter(
    ([, e]) => e.label === 'Acknowledge' && e.role === 'button',
  );
  if (hits.length !== 1) {
    console.error(
      `G14 could not run: "Acknowledge" resolves to ${hits.length} buttons on suppressor.html`,
    );
    process.exit(3);
  }

  const acted = await call('browser_act', { action: 'click', ref: hits[0][0] });
  await sleep(300);
  // The page's own evidence, read fresh and independently of what the act
  // said about itself — the same rule the rest of this file follows.
  const after = await call('browser_snapshot', { mode: 'full' });
  const okClick = /^ok click/.test(acted);
  const landed = after.includes('acknowledged 1 time');
  check(
    'G14',
    'a page that suppresses input listeners is reported as ok, not as a dead input path',
    okClick && landed,
    `reply: ${acted.split('\n')[0].slice(0, 200)}\n        ` +
      `begins "ok click": ${okClick}; page shows "acknowledged 1 time": ${landed}` +
      (!okClick && landed
        ? '\n        FALSE ALARM: the click landed and the engine called the input path dead.'
        : ''),
  );
}

// --- G15: a row prepended into a positional family is restated, not whispered
//
// The INSERTION half of the positional-identity hole (docs/design/tier4.md §1,
// closing tier3.md §3.1's open residual). P1 escalates a family that LOST a
// member to one `replace` of the container; a family that GAINS one used to
// emit a single `add` — and worse, an `add` claiming `after <the LAST row's
// ref>`, because the ordinal suffix a prepend creates is always the highest.
// So the wire said "one row appeared at the bottom" while the page had put one
// at the top, and every ref the agent held silently rebound one row down.
//
// The two halves are BOTH load-bearing and neither implies the other:
//   - G15a alone would pass on a build that restates the family with anything
//     at all in it. It says only that the escalation FIRED.
//   - G15b is the page's own evidence that the restatement is TRUE: it clicks
//     the ref the restatement puts at the top of the list and asks the page
//     which row that was. `took: u1` is prepend.html's independent record —
//     the row ids live in a JS array and never in the DOM, so nothing the
//     engine emitted could have leaked the answer.
//
// Recorded RED against the pre-fix build before Builder B landed the fix:
// docs/design/g15-red-record.md — including the hazard the green guard cannot
// show, a held ref landing on the prepended row in complete silence.

{
  const prependModel = new Map();
  await call('browser_navigate', {
    action: 'goto',
    url: `${BASE}/prepend.html?guardrun=${Date.now()}`,
  });
  await sleep(2500);
  const prependInitial = await call('browser_snapshot', { mode: 'full' });
  if (!/^FULL SNAPSHOT #/m.test(prependInitial)) {
    console.error(
      'G15 could not run: prepend.html did not produce a full snapshot.\n' +
        prependInitial.slice(0, 400),
    );
    process.exit(3);
  }
  applyObservation(prependModel, prependInitial);

  const takes = [...prependModel.entries()].filter(
    ([, e]) => e.label === 'Take' && e.role === 'button',
  );
  if (takes.length !== 5) {
    console.error(
      `G15 could not run: "Take" resolves to ${takes.length} buttons on prepend.html, expected 5.`,
    );
    process.exit(3);
  }
  const adds = [...prependModel.entries()].filter(
    ([, e]) => e.label === 'Add urgent ticket' && e.role === 'button',
  );
  if (adds.length !== 1) {
    console.error(
      `G15 could not run: "Add urgent ticket" resolves to ${adds.length} buttons on prepend.html.`,
    );
    process.exit(3);
  }

  // Document order on the WIRE, not Map order. The ref an agent holds for
  // "row 1" is the first one it READ, and the Map's iteration order is
  // registry allocation order, which is not the same claim.
  const TAKE_LINE = /^\s*button (e\d+) "Take"/;
  const firstTakeIn = (text) => {
    for (const line of text.split('\n')) {
      const m = TAKE_LINE.exec(line);
      if (m) return m[1];
    }
    return null;
  };
  const heldRef = firstTakeIn(prependInitial);

  const reply = await call('browser_act', { action: 'click', ref: adds[0][0] });
  await sleep(300);

  const lines = reply.split('\n');
  const at = lines.findIndex((l) => /^! e\d+ replaced/.test(l));
  // A replace renders its subtree indented beneath the header line
  // (render.ts:431-440), so the block ends at the next unindented line.
  const block = [];
  if (at >= 0) {
    for (let i = at + 1; i < lines.length; i++) {
      if (!/^\s+\S/.test(lines[i])) break;
      block.push(lines[i]);
    }
  }
  const restated = block.filter((l) => TAKE_LINE.test(l)).length;
  const opLines = lines
    .filter((l) => /^[~+\->!(]|^\s+\S|^page #|^FULL SNAPSHOT/.test(l))
    .join('\n        ')
    .slice(0, 900);

  check(
    'G15a',
    'a row prepended into a positional family restates the family, instead of whispering one add',
    at >= 0 && restated >= 6,
    `held ref for row 1's Take before the insert: ${heldRef}; ` +
      `replace block: ${at >= 0 ? 'present' : 'ABSENT'}; ` +
      `Take rows restated: ${restated} (need >= 6)\n        ${opLines}`,
  );

  if (at < 0) {
    check(
      'G15b',
      'the top row of the restatement really is the row that was just inserted',
      false,
      'not reached: G15a found no replace block, so there is no restatement to read.',
    );
  } else {
    const topRef = firstTakeIn(block.join('\n'));
    if (!topRef) {
      check(
        'G15b',
        'the top row of the restatement really is the row that was just inserted',
        false,
        'the replace block carried no `button eN "Take"` line to read a ref out of.',
      );
    } else {
      await call('browser_act', { action: 'click', ref: topRef });
      await sleep(300);
      // The page's own record, read fresh and independently of anything the
      // act said about itself — the rule the rest of this file follows.
      const afterTake = await call('browser_snapshot', { mode: 'full' });
      const tookUrgent = afterTake.includes('took: u1');
      check(
        'G15b',
        'the top row of the restatement really is the row that was just inserted',
        tookUrgent,
        `clicked ${topRef} (the first Take in the replace block); ` +
          `page logged "took: u1": ${tookUrgent}\n        ` +
          (afterTake.split('\n').find((l) => l.includes('took: ')) ?? '(no log line on the page)').trim(),
      );
    }
  }
}

// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} guards hold`);
console.log(`\nRESULT: ${failed.length ? 'RED — ' + failed.map((f) => f.id).join(', ') : 'GREEN'}`);
process.exit(failed.length ? 1 : 0);
