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
 * Usage: node bench/guards.mjs <token> [fixtureBase] [--phase=allow|deny|none]
 * Exit: 0 all guards hold · 1 a guard failed · 3 the probe could not run
 *
 * PHASES. G16-G28 exercise the credential fill path, whose consent gate is a
 * native dialog no script can click. `--e2e-consent` (main-process argv, dev
 * builds only — docs/design/vaultfill.md section 13) is the only way past it,
 * and its setting is a property of the LAUNCH, not of a call. So the credential
 * guards are split by which launch they need:
 *
 *   --phase=allow (default) — Aperture launched `--seed-vault --e2e-consent=allow
 *                             --e2e-consent-delay-ms=1500`. Runs G1-G15 and
 *                             G16-G27a.
 *   --phase=deny            — Aperture launched `--seed-vault --e2e-consent=deny`.
 *                             Runs G27b only.
 *   --phase=none            — Aperture launched `--seed-vault` and NOTHING else.
 *                             Runs G28 only: proves the flag's presence is
 *                             observable, so a green `allow` run cannot be a run
 *                             that quietly auto-approved.
 */

import { createHmac } from 'node:crypto';
import { applyObservation, parseElementLine } from './lib/streamModel.mjs';

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith('--'));
const TOKEN = ARGS[0];
const BASE = ARGS[1] ?? 'http://127.0.0.1:8899';
const PHASE = (FLAGS.find((f) => f.startsWith('--phase=')) ?? '--phase=allow').slice(8);
if (!TOKEN) {
  console.error('usage: node bench/guards.mjs <token> [fixtureBase] [--phase=allow|deny|none]');
  process.exit(3);
}
if (!['allow', 'deny', 'none'].includes(PHASE)) {
  console.error(`unknown phase "${PHASE}" — expected allow, deny or none`);
  process.exit(3);
}

/**
 * Returned by `call` when the request was abandoned rather than answered.
 * A sentinel object, not a string, so no page-authored or harness text can
 * ever be mistaken for it.
 */
const TIMEOUT_SENTINEL = Symbol('timeout');

let id = 0;
async function call(name, args = {}, timeoutMs = 0) {
  const ctl = timeoutMs ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch('http://127.0.0.1:8817/mcp', {
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
      ...(ctl ? { signal: ctl.signal } : {}),
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (ctl?.signal.aborted) return TIMEOUT_SENTINEL;
    throw err;
  }
  if (timer) clearTimeout(timer);
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

function finish() {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} guards hold`);
  console.log(`\nRESULT: ${failed.length ? 'RED — ' + failed.map((f) => f.id).join(', ') : 'GREEN'}`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// The credential fill path (G16-G28). Shared helpers.
//
// EVERY assertion below is against login.html / signup.html's OWN witness line,
// never against Aperture's report of itself. Aperture saying "refused" is not
// evidence that nothing was written; `pw-match:false` on the page is.
// ---------------------------------------------------------------------------

const BASE_2 = BASE.replace('127.0.0.1', '127.0.0.2');
const BASE_LOCALHOST = BASE.replace('127.0.0.1', 'localhost');

/** Seeded by `--seed-vault`. Known here so the guard can assert ABSENCE. */
const SEEDED_PW = 'guard-pw-93a1';
const SEEDED_TOTP_SEED = 'JBSWY3DPEHPK3PXP';

/** The one-time code, computed here, so G19 can look for it and not find it. */
function totpAt(counter) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of SEEDED_TOTP_SEED.toUpperCase().replace(/[\s=-]/g, '')) {
    const i = alphabet.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) |
    ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

/** login.html / signup.html's booleans-only witness line. */
async function vwitness() {
  const t = await call('browser_read', {});
  const m = /vault-log: (.*)/.exec(t);
  return m ? m[1].trim() : '(no vault-log line)';
}

/** True when the page's own record says nothing at all was written into it. */
function nothingWritten(w) {
  return /pw-match:false/.test(w) && /user-match:false/.test(w) &&
    /visible-decoy-set:false/.test(w);
}

async function goFixture(base, file, query = '') {
  const sep = query ? '&' : '';
  await call('browser_navigate', {
    action: 'goto',
    url: `${base}/${file}?guardrun=${Date.now()}${sep}${query}`,
  });
  await sleep(1200);
}

/**
 * Start login.html's armed change, immediately before the `apply` that must
 * race it. See the fixture's own comment for why the clock starts from a click
 * rather than from page load.
 */
async function armPageChange() {
  const m = new Map();
  applyObservation(m, await call('browser_snapshot', { mode: 'full' }));
  const hits = [...m.entries()].filter(
    ([, e]) => e.label === 'Arm page change' && e.role === 'button',
  );
  if (hits.length !== 1) {
    console.error(`could not arm: "Arm page change" resolves to ${hits.length} buttons`);
    process.exit(3);
  }
  await call('browser_act', { action: 'click', ref: hits[0][0] });
}

/** The entry Aperture is willing to name on the page currently open. */
async function entryHere() {
  const t = await call('vault_entries_for_origin', {});
  const m = /^([0-9a-f]{8,})\s/m.exec(t);
  return m ? m[1] : null;
}

/**
 * The seeded entry, or a placeholder plus a recorded FAILURE.
 *
 * NOT `process.exit(3)`, and the reason is the RED record. Against a build
 * where `--seed-vault` does not exist yet — which is exactly the build section
 * 15.3 part 1 says to run these against — an exit here would collapse thirteen
 * guards into one "could not run" line and prove nothing about whether they
 * execute. Recording a failed guard and carrying on with a placeholder id runs
 * the whole apparatus and shows each guard failing on its own terms. A broken
 * seed on a shipped build therefore reads as thirteen loud REDs, never as a
 * vacuous green.
 */
async function seededEntry(where) {
  const e = await entryHere();
  check(
    'G16-seed',
    'the dev-seeded vault is reachable, so the credential guards test something',
    Boolean(e),
    e ? `entry ${e} nameable on ${where}` :
      `NO entry nameable on ${where}. Every credential guard below therefore ` +
      'fails on apparatus, not on discrimination.',
  );
  return e ?? '(no-seeded-entry)';
}

/**
 * Distinctive fragments of the fixed wire strings in vaultfill.md section 10.
 * The codes themselves are never on the wire — the agent gets prose — so the
 * guard matches the prose, which is the actual contract.
 */
const SAYS = {
  NO_MATCH: 'no saved sign-in with that id',
  INSECURE_TRANSPORT: 'is not a secure origin',
  ORIGIN_MISMATCH: 'does not belong to',
  AMBIGUOUS_FIELDS: 'will not guess between',
  FIELD_GONE: 'no longer on the page',
  FIELD_OBSTRUCTED: 'covered by another element',
  FIELD_NOT_EDITABLE: 'disabled or read-only',
  PASSWORD_FIELD_NOT_MASKED: 'showing its contents as plain text',
  ORIGIN_CHANGED: 'changed while the human was deciding',
  USER_DENIED: 'the human declined. Nothing was inserted',
  CONSENT_COOLDOWN: 'declined this fill less than a minute ago',
  TOTP_ALREADY_ISSUED: 'already inserted in the current 30-second window',
  FILL_REVERTED: 'the page did not keep them',
  FILL_INTERRUPTED: 'changed the sign-in form while Aperture was filling it',
  FILLED: 'value withheld',
};

if (PHASE !== 'allow') {
  console.log(`# Live guard probe — phase ${PHASE}\n`);

  await goFixture(BASE, 'login.html');
  const entry = await seededEntry(BASE);

  if (PHASE === 'deny') {
    const before = await vwitness();
    const denied = await call('vault_request_fill', { action: 'apply', entryId: entry });
    const afterDeny = await vwitness();
    check(
      'G27b-i',
      'with --e2e-consent=deny the fill is refused and the page is untouched',
      denied.includes(SAYS.USER_DENIED) && nothingWritten(afterDeny),
      `reply: ${denied.split('\n')[0].slice(0, 140)}\n        ` +
        `witness before: ${before}\n        witness after:  ${afterDeny}`,
    );

    const retry = await call('vault_request_fill', { action: 'apply', entryId: entry });
    const afterRetry = await vwitness();
    check(
      'G27b-ii',
      'an immediate retry is refused by the 60s cooldown, WITHOUT a second consent call',
      // The code itself is the proof of ordering: the cooldown is pipeline
      // step 5 and consent is step 8, so a CONSENT_COOLDOWN answer cannot have
      // gone through the dialog. Had it reached consent, `--e2e-consent=deny`
      // would have answered USER_DENIED again.
      retry.includes(SAYS.CONSENT_COOLDOWN) && !retry.includes(SAYS.USER_DENIED) &&
        nothingWritten(afterRetry),
      `reply: ${retry.split('\n')[0].slice(0, 160)}\n        witness: ${afterRetry}`,
    );
  }

  if (PHASE === 'none') {
    const before = await vwitness();
    // No --e2e-consent flag: a real native dialog is raised and nothing can
    // click it. The call must NOT complete on its own.
    const out = await call(
      'vault_request_fill',
      { action: 'apply', entryId: entry },
      8000,
    );
    const after = await vwitness();
    check(
      'G28',
      'with no --e2e-consent flag an apply does not complete on its own',
      out === TIMEOUT_SENTINEL && nothingWritten(after),
      `reply after 8s: ${out === TIMEOUT_SENTINEL ? '(none — still waiting on the dialog)' : out.split('\n')[0].slice(0, 160)}\n        ` +
        `witness before: ${before}\n        witness after:  ${after}`,
    );
  }

  finish();
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

// --- G16-G27a: the credential fill path -------------------------------------
//
// Requires Aperture launched with
//   --seed-vault --e2e-consent=allow --e2e-consent-delay-ms=1500
// and test/fixtures served on BOTH 127.0.0.1:8899 and 127.0.0.2:8899.
//
// The 1500ms consent delay is not padding. Three of these guards (G20, G21,
// G22) need the page to move WHILE the consent dialog is open, because that is
// the only window in which the preload's own re-checks — origin echo,
// isConnected, type==='password' — are the thing being measured. The fixture
// arms those changes at 800ms, comfortably inside it.

{
  await goFixture(BASE, 'login.html');
  const entry = await seededEntry(BASE);

  // --- G16a: an unknown id is refused before any page work ------------------
  {
    const bogus = '00000000deadbeef';
    const out = await call('vault_request_fill', { action: 'apply', entryId: bogus });
    const w = await vwitness();
    check(
      'G16a',
      'an id no saved sign-in has is refused, with no dialog and nothing written',
      out.includes(SAYS.NO_MATCH) && nothingWritten(w),
      `reply: ${out.split('\n')[0].slice(0, 140)}\n        witness: ${w}`,
    );
  }

  // --- G16b: a loopback address isLocalhost() does not exempt ---------------
  //
  // 127.0.0.2 is loopback, is not `localhost`, and is not `127.0.0.1`. The
  // vault's transport check exempts exactly the last two, so an entry saved
  // for 127.0.0.2 is refused over http. The second listener and the second
  // seeded record exist for this one line.
  {
    await goFixture(BASE_2, 'login.html');
    const other = (await entryHere()) ?? '(no-seeded-entry)';
    const out = await call('vault_request_fill', { action: 'apply', entryId: other });
    const w = await vwitness();
    check(
      'G16b',
      'a loopback address that is not localhost is refused INSECURE_TRANSPORT, before any page work',
      out.includes(SAYS.INSECURE_TRANSPORT) && nothingWritten(w),
      `reply: ${out.split('\n')[0].slice(0, 160)}\n        witness: ${w}`,
    );
  }

  // --- G17: origin binding is terminal, and unnameability is what backs it --
  {
    await goFixture(BASE_LOCALHOST, 'login.html');
    const listed = await call('vault_entries_for_origin', {});
    check(
      'G17b',
      'vault_entries_for_origin on localhost lists nothing — the entry is unnameable there',
      /no saved logins for this site/.test(listed),
      `reply: ${listed.split('\n')[0].slice(0, 140)}`,
    );

    // The id had to be learned on 127.0.0.1, which is exactly G17b's point:
    // an agent that had only ever seen this page could not have produced it.
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    const w = await vwitness();
    check(
      'G17a',
      'an entry saved for 127.0.0.1 is refused on localhost, names neither the stored origin nor an override',
      out.includes(SAYS.ORIGIN_MISMATCH) &&
        !out.includes('127.0.0.1') &&
        /no override/.test(out) && !/\bforce\s*[:=]/.test(out) &&
        nothingWritten(w),
      `reply: ${out.split('\n').join(' ').slice(0, 240)}\n        witness: ${w}`,
    );
  }

  // --- G18a: the password reached the masked field, and only it ------------
  {
    await goFixture(BASE, 'login.html');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(400);
    const w = await vwitness();
    check(
      'G18a',
      'the password lands in the masked field and nowhere else (no focus-following spill)',
      out.includes(SAYS.FILLED) && /pw-match:true/.test(w) &&
        /user-match:true/.test(w) && /visible-decoy-set:false/.test(w),
      `reply: ${out.split('\n')[0].slice(0, 140)}\n        witness: ${w}`,
    );
  }

  // --- G19: the value cannot be read back, including out of free text ------
  {
    const snap = await call('browser_snapshot', { mode: 'full' });
    // The page copies the value it legitimately holds into visible text. This
    // is the whole exfiltration shape: `browser_read` reads innerText, which
    // bypasses the snapshot tree entirely.
    const model19 = new Map();
    applyObservation(model19, snap);
    const echoHits = [...model19.entries()].filter(
      ([, e]) => e.label === 'Echo password to page' && e.role === 'button',
    );
    if (echoHits.length !== 1) {
      check('G19', 'a filled credential cannot be read back, even once the page echoes it into text',
        false, `"Echo password to page" resolves to ${echoHits.length} buttons`);
    } else {
      await call('browser_act', { action: 'click', ref: echoHits[0][0] });
      await sleep(300);
      const after = await call('browser_snapshot', { mode: 'full' });
      const read = await call('browser_read', {});
      const clean = !after.includes(SEEDED_PW) && !read.includes(SEEDED_PW);
      check(
        'G19',
        'a filled credential cannot be read back, even once the page echoes it into visible text',
        clean && /value withheld/.test(read),
        `snapshot carries the password: ${after.includes(SEEDED_PW)}; ` +
          `browser_read carries it: ${read.includes(SEEDED_PW)}; ` +
          `marker present in read: ${/value withheld/.test(read)}`,
      );

      // --- G19b: the href sink, named and asserted on its own ---------------
      //
      // Split from G19 rather than folded into it, because the two sinks fail
      // for different reasons and an aggregate `!includes(pw)` would say only
      // "something leaked". `href` is the field this codebase forgets: an
      // independent review at c375415 measured
      // `link e7 "Continue to checkout" /leak?pw=guard-pw-93a1` surviving the
      // needle scrub, because `redactTainted` covered value/text/name/rows and
      // not href. It is also the sink `browser_read` CANNOT see — a link target
      // is not innerText — so only the snapshot line can catch it.
      //
      // The assertion is on the link's OWN line, not on the whole snapshot, so
      // it stays about this field even if some other sink regresses.
      const leakLine =
        after.split('\n').find((l) => l.includes('/leak?pw=')) ??
        after.split('\n').find((l) => l.includes('Continue to checkout')) ??
        '';
      check(
        'G19b',
        'the same credential does not escape through a link href, which browser_read cannot see at all',
        leakLine !== '' && !leakLine.includes(SEEDED_PW) &&
          leakLine.includes('/leak?pw=') && /value-withheld/.test(leakLine),
        `link line: ${leakLine.trim().slice(0, 160) || '(no line carrying the echoed link)'}`,
      );
    }
  }

  // --- G18b: a page that snaps the value back is not a success -------------
  {
    await goFixture(BASE, 'login.html', 'mode=snapback');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(400);
    const w = await vwitness();
    check(
      'G18b',
      'a controlled field that reverts the write produces FILL_REVERTED, not a success line',
      out.includes(SAYS.FILL_REVERTED) && !out.includes(SAYS.FILLED) &&
        /pw-match:false/.test(w),
      `reply: ${out.split('\n')[0].slice(0, 180)}\n        witness: ${w}`,
    );
  }

  // --- G20: the origin changed while the human was deciding ----------------
  {
    await goFixture(BASE, 'login.html', 'nav=800');
    await armPageChange();
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(400);
    const wAfter = await vwitness();
    check(
      'G20',
      'a cross-origin navigation during the consent dialog aborts the write',
      out.includes(SAYS.ORIGIN_CHANGED) && nothingWritten(wAfter),
      `reply: ${out.split('\n')[0].slice(0, 180)}\n        ` +
        `witness on the document that arrived: ${wAfter}`,
    );
  }

  // --- G21: the chosen field left the page during the dialog ---------------
  {
    await goFixture(BASE, 'login.html', 'remove=800');
    await armPageChange();
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(400);
    const w = await vwitness();
    check(
      'G21',
      'a password field removed during the consent dialog produces FIELD_GONE and no partial fill',
      out.includes(SAYS.FIELD_GONE) && /pw-present:false/.test(w) &&
        /user-match:false/.test(w),
      `reply: ${out.split('\n')[0].slice(0, 180)}\n        witness: ${w}`,
    );
  }

  // --- G22: "show password" turned on during the dialog --------------------
  //
  // The toggle is armed at 800ms rather than set on load, and the reason is the
  // one that makes this guard mean anything. A field that is already
  // `type=text` at PLAN time is not a password candidate at all (section 5.2,
  // "nothing else, ever"), so a pre-toggled page answers NO_FIELDS and the
  // preload's masked check is never reached. Armed mid-dialog, this measures
  // exactly that check — which is what sabotage S2 removes.
  {
    await goFixture(BASE, 'login.html', 'showpw=800');
    await armPageChange();
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(400);
    const w = await vwitness();
    check(
      'G22',
      'a password field unmasked during the consent dialog is refused, and nothing is written',
      out.includes(SAYS.PASSWORD_FIELD_NOT_MASKED) && /pw-match:false/.test(w) &&
        /user-match:false/.test(w),
      `reply: ${out.split('\n')[0].slice(0, 180)}\n        witness: ${w}`,
    );
  }

  // --- G22b: the page unmasks the field INSIDE the write pass --------------
  //
  // The window G22 cannot reach, and the one an attacker would actually use.
  // Validation and the writes are one task, so no navigation can land between
  // them — but they are not one TURN: `focus()` and the dispatched
  // `input`/`change` run the page's own handlers synchronously, and the write
  // order is username → password, so the username's handlers always run first.
  // A handler doing `p.type = 'text'` there was measured at c375415 putting the
  // saved password into a plain-text field while Aperture answered
  // `filled username and password …`.
  //
  // The page's own witness is what makes this readable: `pw-masked:false`
  // proves the flip really happened (so the guard is not vacuous), and
  // `pw-match:false` proves the password did not go in anyway. `user-match:true`
  // is the honest part — atomic means "no writes if validation fails", not
  // rollback, and the username written before the refusal stays where it is.
  {
    await goFixture(BASE, 'login.html', 'mode=race');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(400);
    const w = await vwitness();
    check(
      'G22b',
      'a password field unmasked from the username field\'s own handler, mid-write, does not receive the password',
      out.includes(SAYS.FILL_INTERRUPTED) && !out.includes(SAYS.FILLED) &&
        /pw-match:false/.test(w) && /pw-masked:false/.test(w) &&
        /user-match:true/.test(w),
      `reply: ${out.split('\n')[0].slice(0, 200)}\n        witness: ${w}`,
    );
  }

  // --- G23: a sign-up form is a refusal, not a guess -----------------------
  {
    await goFixture(BASE, 'signup.html');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(300);
    const w = await vwitness();
    check(
      'G23',
      'password + confirm is AMBIGUOUS_FIELDS — no dialog, nothing written',
      out.includes(SAYS.AMBIGUOUS_FIELDS) && /any-password-set:false/.test(w) &&
        /user-set:false/.test(w),
      `reply: ${out.split('\n')[0].slice(0, 180)}\n        witness: ${w}`,
    );
  }

  // --- G24: an overlay over the form ---------------------------------------
  {
    await goFixture(BASE, 'login.html', 'mode=overlay');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(300);
    const w = await vwitness();
    check(
      'G24',
      'a password field behind an aria-modal overlay is refused, and nothing is written',
      out.includes(SAYS.FIELD_OBSTRUCTED) && nothingWritten(w),
      `reply: ${out.split('\n')[0].slice(0, 180)}\n        witness: ${w}`,
    );
  }

  // --- G25: readonly means a human could not type there either -------------
  {
    await goFixture(BASE, 'login.html', 'mode=readonly');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(300);
    const w = await vwitness();
    check(
      'G25',
      'a readonly password field is refused, and the username is not written either (atomic)',
      out.includes(SAYS.FIELD_NOT_EDITABLE) && nothingWritten(w),
      `reply: ${out.split('\n')[0].slice(0, 180)}\n        witness: ${w}`,
    );
  }

  // --- G25b: disabled by an ANCESTOR is still disabled ---------------------
  //
  // Not in the spec's guard table. It is here because implementing section
  // 6.2's `!el.disabled` literally reproduces a bug this codebase has already
  // paid for once: the IDL `disabled` property reflects the content attribute
  // only, so it is `false` for a control inside `<fieldset disabled>` — which
  // the `select` path fixed with `isDisabled` and the fill path never got.
  // Without the strengthening this guard is RED: the password lands in a field
  // no human could type into.
  {
    await goFixture(BASE, 'login.html', 'mode=fieldset');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(300);
    const w = await vwitness();
    check(
      'G25b',
      'a password field disabled by an ancestor <fieldset disabled> is refused too',
      out.includes(SAYS.FIELD_NOT_EDITABLE) && nothingWritten(w),
      `reply: ${out.split('\n')[0].slice(0, 180)}\n        witness: ${w}`,
    );
  }

  // --- G26: the one-time code, checked against the page's own arithmetic ---
  {
    await goFixture(BASE, 'login.html', 'mode=otp');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(500);
    const w = await vwitness();
    check(
      'G26a',
      'the inserted one-time code matches the one the fixture derived independently from the seed',
      out.includes(SAYS.FILLED) && /otp-valid:true/.test(w),
      `reply: ${out.split('\n')[0].slice(0, 160)}\n        witness: ${w}`,
    );

    // The code must not be readable back either — same class as G19, and the
    // needle is six characters, so this is the case section 11.2 calls out.
    const readOtp = await call('browser_read', {});
    const now = Math.floor(Date.now() / 1000 / 30);
    const codes = [totpAt(now), totpAt(now - 1)];
    check(
      'G26a-blind',
      'the inserted one-time code does not come back through browser_read',
      !codes.some((c) => readOtp.includes(c)),
      `codes checked: 2 windows; present in read: ${codes.filter((c) => readOtp.includes(c)).length}`,
    );

    const second = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(300);
    const w2 = await vwitness();
    check(
      'G26b',
      'a second fill inside the same 30s window is refused, and the field is unchanged',
      second.includes(SAYS.TOTP_ALREADY_ISSUED) && /otp-valid:true/.test(w2),
      `reply: ${second.split('\n')[0].slice(0, 200)}\n        witness: ${w2}`,
    );
  }

  // --- G27a: submit means exactly one submission, carrying the values ------
  {
    await goFixture(BASE, 'login.html');
    const out = await call('vault_request_fill', {
      action: 'apply', entryId: entry, submit: true,
    });
    await sleep(700);
    const w = await vwitness();
    check(
      'G27a',
      'submit:true produces exactly one submission, and the submitted form carries the values',
      /submits:1/.test(w) && /submitted-values-match:true/.test(w) &&
        out.includes(SAYS.FILLED),
      `reply: ${out.split('\n').slice(0, 2).join(' ').slice(0, 200)}\n        witness: ${w}`,
    );
  }
}

// --- G29: a removal retires the whole generation, and a stale ref refuses ----
//
// The REMOVAL half of positional identity, and the half the head-to-head cohort
// measured as a precision failure (docs/design/h2h-evaluation.md §2;
// docs/design/tier5.md). P1 has restated a family that LOST a member since
// tier2b — but the restatement re-emitted the SAME ref numbers, and the key set
// shrinks at the TAIL whatever row physically left, so every survivor's ref
// silently re-bound to whatever row slid into its position. `gone` named the
// tail ref only, which affirmatively implies the rest are fine. A plan captured
// before a removal executed one row off, labels agreeing, no error.
//
// The four legs are independent and none implies another:
//   - G29a is the WIRE: the restatement retires the whole prior generation.
//     `gone` must name the ref for a SURVIVING position (not merely the tail)
//     and every restated Take ref must be a number the agent has never seen.
//   - G29b is the ACT PATH, page-evidenced: the ref the agent held for the 4th
//     row must refuse, and retire.html's own log must show that nothing landed.
//     A build with G29a's honesty and no refusal still lands the wrong row.
//   - G29c is the green-stable control (the G15b analog): the successors the
//     restatement hands over are TRUE and usable with no re-read. It passes
//     PRE-fix as well as post — the restatement was already truthful; the refs
//     were the lie — so it is what says G29a/b are not passing by breaking the
//     wire.
//   - G29d is the DELIVERY-PATH claim: the same refusal on a FULL snapshot,
//     which never diffs at all. It fails on any build that implements
//     retirement inside the escalation instead of on `observe()`'s common path.
//
// Recorded RED against the pre-fix build before the tier5 fix landed:
// docs/design/g29-red-record.md — including the hazard the green guard can
// never show again, the held ref landing on the row below it and the page
// logging `took: r5` for a click the agent read as r4.

{
  const retireModel = new Map();
  await call('browser_navigate', {
    action: 'goto',
    url: `${BASE}/retire.html?guardrun=${Date.now()}`,
  });
  await sleep(2500);
  const retireInitial = await call('browser_snapshot', { mode: 'full' });
  if (!/^FULL SNAPSHOT #/m.test(retireInitial)) {
    console.error(
      'G29 could not run: retire.html did not produce a full snapshot.\n' +
        retireInitial.slice(0, 400),
    );
    process.exit(3);
  }
  applyObservation(retireModel, retireInitial);

  const takeEntries = [...retireModel.entries()].filter(
    ([, e]) => e.label === 'Take' && e.role === 'button',
  );
  if (takeEntries.length !== 6) {
    console.error(
      `G29 could not run: "Take" resolves to ${takeEntries.length} buttons on retire.html, expected 6.`,
    );
    process.exit(3);
  }
  const dismiss = [...retireModel.entries()].filter(
    ([, e]) => e.label === 'Dismiss first ticket' && e.role === 'button',
  );
  if (dismiss.length !== 1) {
    console.error(
      `G29 could not run: "Dismiss first ticket" resolves to ${dismiss.length} buttons on retire.html.`,
    );
    process.exit(3);
  }

  // Document order on the WIRE, not Map order. The ref an agent holds for
  // "the 4th row" is the fourth one it READ; the Map's iteration order is
  // registry allocation order, which is not the same claim.
  const TAKE_LINE = /^\s*button (e\d+) "Take"/;
  const takeRefsIn = (text) => {
    const out = [];
    for (const line of text.split('\n')) {
      const m = TAKE_LINE.exec(line);
      if (m) out.push(m[1]);
    }
    return out;
  };
  const takeRefs = takeRefsIn(retireInitial);
  if (takeRefs.length !== 6) {
    console.error(
      `G29 could not run: the full snapshot carried ${takeRefs.length} \`button eN "Take"\` lines, expected 6.`,
    );
    process.exit(3);
  }
  // r4's Take, as the model read it. r1 is about to be dismissed, so post-
  // removal this POSITION belongs to r5 — which is what makes a silent rebind
  // land one row off rather than nowhere.
  const heldRef = takeRefs[3];

  const reply = await call('browser_act', { action: 'click', ref: dismiss[0][0] });
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
  const restatedRefs = takeRefsIn(block.join('\n'));
  const goneRefs =
    at >= 0 ? (/\(gone: ([^)]*)\)/.exec(lines[at])?.[1] ?? '').split(/\s+/).filter(Boolean) : [];
  const fresh = restatedRefs.filter((r) => !takeRefs.includes(r));
  const opLines = lines
    .filter((l) => /^[~+\->!(]|^\s+\S|^page #|^FULL SNAPSHOT/.test(l))
    .join('\n        ')
    .slice(0, 900);

  check(
    'G29a',
    'a removal from a positional family retires the whole prior generation, not just the tail ref',
    at >= 0 &&
      goneRefs.includes(heldRef) &&
      restatedRefs.length >= 5 &&
      fresh.length === restatedRefs.length,
    `held ref for the 4th row's Take before the removal: ${heldRef}; ` +
      `replace block: ${at >= 0 ? 'present' : 'ABSENT'}; ` +
      `gone: [${goneRefs.join(' ')}] (contains ${heldRef}: ${goneRefs.includes(heldRef)}); ` +
      `Take rows restated: ${restatedRefs.length} (need >= 5), of which fresh: ${fresh.length}\n        ` +
      `pre-click Take refs: [${takeRefs.join(' ')}]; restated: [${restatedRefs.join(' ')}]\n        ${opLines}`,
  );

  if (at < 0) {
    check(
      'G29b',
      'a ref held across the removal refuses, and the page confirms nothing landed',
      false,
      'not reached: G29a found no replace block, so there is no restatement to act after.',
    );
    check(
      'G29c',
      'the refs the restatement hands over bind to the rows it says they do',
      false,
      'not reached: G29a found no replace block, so there is no restatement to read.',
    );
  } else {
    // The stale plan, executed. Pre-fix this returns `ok click` and the page
    // logs `took: r5` — the one-row-off landing, in the page's own words.
    const staleReply = await call('browser_act', { action: 'click', ref: heldRef });
    await sleep(300);
    const afterStale = await call('browser_snapshot', { mode: 'full' });
    const refused = new RegExp(`^error: ${heldRef} could not be acted on`).test(staleReply);
    const tookLine = afterStale.split('\n').find((l) => l.includes('took: '));
    check(
      'G29b',
      'a ref held across the removal refuses, and the page confirms nothing landed',
      refused && !tookLine,
      `clicked ${heldRef} (the ref read as the 4th row's Take); ` +
        `refused: ${refused}; page logged a take: ${tookLine ? 'YES' : 'no'}\n        ` +
        `reply: ${staleReply.split('\n')[0].slice(0, 160)}\n        ` +
        (tookLine
          ? `${tookLine.trim()}   <-- LANDED ONE ROW OFF: the agent read this ref as r4`
          : '(no log line on the page — nothing landed)'),
    );

    const fourth = restatedRefs[3];
    if (!fourth) {
      check(
        'G29c',
        'the refs the restatement hands over bind to the rows it says they do',
        false,
        `the replace block carried ${restatedRefs.length} \`button eN "Take"\` lines; need a 4th to read.`,
      );
    } else {
      await call('browser_act', { action: 'click', ref: fourth });
      await sleep(300);
      // The page's own record, read fresh and independently of anything the
      // act said about itself — the rule the rest of this file follows. r1 was
      // dismissed, so the current 4th row is r5.
      const afterTake = await call('browser_snapshot', { mode: 'full' });
      const tookR5 = afterTake.includes('took: r5');
      check(
        'G29c',
        'the refs the restatement hands over bind to the rows it says they do',
        tookR5,
        `clicked ${fourth} (the 4th Take in the replace block); ` +
          `page logged "took: r5": ${tookR5}\n        ` +
          (afterTake.split('\n').find((l) => l.includes('took: ')) ?? '(no log line on the page)').trim(),
      );
    }
  }
}

// --- G29d: the same refusal on the FULL-snapshot path -----------------------
//
// `observe()` runs `assignRefs` — which revives by key — BEFORE it decides
// between a diff and a full, and the forced-full path never diffs at all
// (tier5 §2.3). Retirement implemented inside the P1/P2 escalation would leave
// every membership change delivered as a full snapshot silently rebinding. This
// leg forces that delivery and asks the same question.

{
  const fullModel = new Map();
  await call('browser_navigate', {
    action: 'goto',
    url: `${BASE}/retire.html?guardrun=${Date.now()}-full`,
  });
  await sleep(2500);
  const initialFull = await call('browser_snapshot', { mode: 'full' });
  if (!/^FULL SNAPSHOT #/m.test(initialFull)) {
    console.error(
      'G29d could not run: retire.html did not produce a full snapshot.\n' +
        initialFull.slice(0, 400),
    );
    process.exit(3);
  }
  applyObservation(fullModel, initialFull);

  const TAKE_LINE_D = /^\s*button (e\d+) "Take"/;
  const takeRefsD = [];
  for (const line of initialFull.split('\n')) {
    const m = TAKE_LINE_D.exec(line);
    if (m) takeRefsD.push(m[1]);
  }
  const dismissD = [...fullModel.entries()].filter(
    ([, e]) => e.label === 'Dismiss first ticket' && e.role === 'button',
  );
  if (takeRefsD.length !== 6 || dismissD.length !== 1) {
    console.error(
      `G29d could not run: ${takeRefsD.length} Take lines and ${dismissD.length} dismiss buttons on the re-navigated page.`,
    );
    process.exit(3);
  }
  const heldRefD = takeRefsD[3];

  // The mutation, delivered as a FULL snapshot: no diff, no `replace`, no
  // `(gone: …)` vocabulary at all (tier5 §4 residual 5).
  const fullObs = await call('browser_act', {
    action: 'click',
    ref: dismissD[0][0],
    observe: 'full',
  });
  await sleep(300);
  const wasFull = /FULL SNAPSHOT #/.test(fullObs);

  const staleD = await call('browser_act', { action: 'click', ref: heldRefD });
  await sleep(300);
  const afterD = await call('browser_snapshot', { mode: 'full' });
  const refusedD = new RegExp(`^error: ${heldRefD} could not be acted on`).test(staleD);
  const tookLineD = afterD.split('\n').find((l) => l.includes('took: '));

  check(
    'G29d',
    'a membership change delivered as a FULL snapshot retires the refs too',
    wasFull && refusedD && !tookLineD,
    `observation after the dismiss was a full snapshot: ${wasFull}; ` +
      `clicked ${heldRefD} (the ref read as the 4th row's Take); refused: ${refusedD}; ` +
      `page logged a take: ${tookLineD ? 'YES' : 'no'}\n        ` +
      `reply: ${staleD.split('\n')[0].slice(0, 160)}\n        ` +
      (tookLineD
        ? `${tookLineD.trim()}   <-- LANDED ONE ROW OFF on the full-snapshot path`
        : '(no log line on the page — nothing landed)'),
  );
}

// ---------------------------------------------------------------------------

finish();
