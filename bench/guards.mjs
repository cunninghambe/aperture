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
 *   --phase=allow (default) — Aperture launched `--seed-vault --seed-profile
 *                             --e2e-consent=allow --e2e-consent-delay-ms=1500`.
 *                             Runs G1-G15, G16-G27a, and G30-G32.
 *                             `--seed-profile` is not optional since 2026-08-05:
 *                             the G30 block exercises the PROFILE fill path,
 *                             which had none of the credential path's redaction
 *                             machinery wired to it for three gates (F-F).
 *                             G30-seed fails loudly when the flag is missing, so
 *                             a forgotten flag reads as a RED rather than as a
 *                             block of vacuous passes.
 *   --phase=deny            — Aperture launched `--seed-vault --e2e-consent=deny`.
 *                             Runs G27b only.
 *   --phase=none            — Aperture launched `--seed-vault` and NOTHING else.
 *                             Runs G28 only: proves the flag's presence is
 *                             observable, so a green `allow` run cannot be a run
 *                             that quietly auto-approved.
 */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ---------------------------------------------------------------------------
// THE ARTIFACT THIS RUN IS ABOUT — refuse a stale one, and name it.
//
// Three separate incidents in this project were a green guard run against a
// build that predated the fix it was meant to measure, and the third was caught
// only because the guard that noticed happened to be new. The failure is silent
// BY CONSTRUCTION: a green run against a stale artifact is byte-identical to a
// green run against the right one, so nothing in the output can be read as
// evidence either way.
//
// Two mechanisms, and they answer different questions:
//
//   REFUSE (below) answers "is this run about the tree I am looking at?" It
//   fails closed on the one condition behind all three incidents — `out/` older
//   than `src/` — and it cannot be forgotten, because forgetting it is exactly
//   the mistake. A runner that BUILDS would be better in principle and is worse
//   here: it adds ways for a guard run to fail for reasons that are not about
//   guards. This one only ever refuses.
//
//   HASH answers "which bytes were these numbers produced from?" six months
//   later, when the record is all that is left. It prints in the header and in
//   the RESULT line, so a pasted tail is self-describing. Commit messages in
//   this repo have claimed "all against hash-recorded builds"; that discipline
//   belongs in the tool, not in the operator, for the same reason the congruence
//   table exists (docs/design/sink-closure-review-2.md §5).
//
// The comparison is mtime, not content: the question is "did somebody edit
// source after the last build", and mtime is exactly that question. A rebuild
// that produces identical bytes still moves the artifact's mtime forward, so
// the check has no false positives from a no-op rebuild.
// ---------------------------------------------------------------------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = join(ROOT, 'out', 'main', 'index.js');

/** The most recently modified file under `dir`, recursively. */
function newestUnder(dir) {
  let newest = { path: dir, mtimeMs: 0 };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const hit = e.isDirectory() ? newestUnder(p) : { path: p, mtimeMs: statSync(p).mtimeMs };
    if (hit.mtimeMs > newest.mtimeMs) newest = hit;
  }
  return newest;
}

let ARTIFACT_HASH = '(unhashed)';
{
  let built;
  try {
    built = statSync(ARTIFACT);
  } catch {
    console.error(
      `REFUSING TO RUN: ${relative(ROOT, ARTIFACT)} does not exist.\n` +
        'Run `npx electron-vite build` first — there is nothing to measure.',
    );
    process.exit(3);
  }
  const newest = newestUnder(join(ROOT, 'src'));
  if (newest.mtimeMs > built.mtimeMs) {
    console.error(
      'REFUSING TO RUN: the built artifact is older than the source.\n' +
        `  ${relative(ROOT, ARTIFACT)}  built ${new Date(built.mtimeMs).toISOString()}\n` +
        `  ${relative(ROOT, newest.path)}  edited ${new Date(newest.mtimeMs).toISOString()}\n` +
        'Every guard below would have been measured against code that is not on ' +
        'disk any more. Run `npx electron-vite build`, restart Aperture, and ' +
        'run this again.',
    );
    process.exit(3);
  }
  ARTIFACT_HASH = createHash('sha256').update(readFileSync(ARTIFACT)).digest('hex');
  console.log(
    `artifact  ${relative(ROOT, ARTIFACT).replace(/\\/g, '/')}  ` +
      `sha256 ${ARTIFACT_HASH}  built ${new Date(built.mtimeMs).toISOString()}\n` +
      `phase     ${PHASE}\n`,
  );
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

/**
 * A ref resolved out of ONE observation, without touching the shared model.
 *
 * `refFor` reads the running model and exits the process when a label is
 * ambiguous, which is right for setup and wrong inside a security check: a
 * guard that cannot find its button must FAIL and say so, not take the suite
 * down. Returns null rather than throwing, and null rather than guessing when
 * a label matches more than once.
 */
function refIn(observation, label, role) {
  const m = new Map();
  applyObservation(m, observation);
  const hits = [...m.entries()].filter(
    ([, e]) => e.label === label && (!role || e.role === role),
  );
  return hits.length === 1 ? hits[0][0] : null;
}

/**
 * The code points `src/core/snapshot/text.ts` removes, removed here too.
 *
 * A guard asserting `!text.includes(pw)` is not enough for the split-value
 * sinks: the whole finding was that the bytes on the wire carry a separator
 * Aperture itself deletes on the way to the model, so the check has to be made
 * in the alphabet the MODEL reads as well as the one the transport carries.
 * Deliberately a copy of the predicate and not an import — the bench must be
 * able to fail when the product's copy changes.
 */
function stripFormat(s) {
  return [...s]
    .filter((ch) => {
      const c = ch.codePointAt(0);
      if (c === 0x09 || c === 0x0a || c === 0x0d) return true;
      return !(
        c <= 0x1f || c === 0x85 || (c >= 0x7f && c <= 0x9f) ||
        c === 0x2028 || c === 0x2029 ||
        (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
      );
    })
    .join('');
}

/**
 * Every reading of a string Aperture itself could produce from the value.
 *
 * `!text.includes(pw)` is not the whole assertion for the split-value sinks.
 * The finding is that the bytes on the wire carry separators and escapes that
 * APERTURE removes or introduces, so absence has to be checked in each
 * alphabet the model can arrive at without doing anything the browser would
 * not: the raw text, the text with the invisible code points gone, and both of
 * those percent-decoded (a `new URL(...)` on the way out is what encoded them).
 */
function readings(s) {
  const out = [s, stripFormat(s)];
  for (const c of [s, s.replace(/\+/g, ' ')]) {
    try {
      const d = decodeURIComponent(c);
      out.push(d, stripFormat(d));
    } catch {
      /* a lone % is not an escape */
    }
  }
  return out;
}

/** True when the value is absent from every reading of the text. */
function absentEverywhere(text, value) {
  return !readings(text).some((r) => r.includes(value));
}

function finish() {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} guards hold`);
  // The hash rides the RESULT line as well as the header: a pasted tail is the
  // part that survives into a document, and a verdict with no artifact named is
  // the thing three stale-build incidents made unfalsifiable.
  console.log(
    `\nRESULT: ${failed.length ? 'RED — ' + failed.map((f) => f.id).join(', ') : 'GREEN'}` +
      `  [out/main/index.js sha256 ${ARTIFACT_HASH.slice(0, 16)}…]`,
  );
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
/** The same record's username. Registered as a needle like every other filled
 *  value, which is what makes it G31's control: it must STILL be redacted on
 *  the page where the six-digit code must not be. */
const SEEDED_USER = 'guard@example.com';

/**
 * Seeded by `--seed-profile` — the demo profile's `dateOfBirth`.
 *
 * The G30 block asserts its ABSENCE on the profile path's surfaces, exactly as
 * SEEDED_PW is asserted absent on the credential path's. It is the class of
 * value this product treats as MORE sensitive than a password: it refuses to
 * print one in a plan at all, answering `(from profile — value not shown)`.
 */
const SEEDED_DOB = '1980-01-01';

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
  // The marker's wording changed on 2026-08-05 (third gate): it used to say
  // `(filled, value withheld)`, which asserts a PROVENANCE the mechanism cannot
  // know off the filled origin. `redact.ts` argues it; this is the substring the
  // fill-success prose carries now.
  FILLED: 'matches a filled value',
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
// THREE ORIGINS, TWO BINDINGS. G20's cross-origin navigation and G19m's second
// hop both use `http://localhost:8899`, which is a different origin and a
// different registrable domain from `http://127.0.0.1:8899` while being the
// same server — so a server bound to 127.0.0.1 already answers it and no third
// binding is needed. A server bound with an explicit host allowlist must let
// `localhost` through, or those two guards measure a failed load.
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
        clean && /matches a filled value/.test(read),
        `snapshot carries the password: ${after.includes(SEEDED_PW)}; ` +
          `browser_read carries it: ${read.includes(SEEDED_PW)}; ` +
          `marker present in read: ${/matches a filled value/.test(read)}`,
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
          leakLine.includes('/leak?pw=') && /matches-a-filled-value/.test(leakLine),
        `link line: ${leakLine.trim().slice(0, 160) || '(no line carrying the echoed link)'}`,
      );

      // --- G19c: the snapshot HEADER line — Snapshot.title and Snapshot.url --
      //
      // Split from G19 for the reason G19b was: an aggregate `!includes(pw)`
      // says only "something leaked". These two sinks fail for a reason of
      // their own — they are page-controlled strings that live on `Snapshot`
      // rather than on `SnapshotNode`, and `redactTainted` walked the node
      // tree only, so the needles never covered them at all
      // (docs/design/security-review-2026-08.md F1).
      //
      // The delivery is automatic and unavoidable: a URL change forces a full
      // snapshot (`navigated`, engine.ts), and a full snapshot is exactly what
      // prints this line. The mechanism guaranteeing the agent hears about a
      // route change was the one carrying the secret.
      //
      // Both halves of the assertion matter. `!includes(SEEDED_PW)` is the
      // security claim; `TITLESINK` and `urlsink=` still being present is what
      // makes the guard non-vacuous — a fixture that failed to arm the sink
      // would otherwise pass by writing nothing.
      const headerLine = after.split('\n').find((l) => l.startsWith('page "')) ?? '';
      check(
        'G19c',
        'the full-snapshot header carries neither a page-written title nor a page-written URL in clear',
        headerLine !== '' && !headerLine.includes(SEEDED_PW) &&
          /TITLESINK/.test(headerLine) && /urlsink=/.test(headerLine) &&
          /withheld/.test(headerLine),
        `header line: ${headerLine.trim().slice(0, 200) || '(no page header line in the full snapshot)'}`,
      );

      // --- G19g: ONE INVISIBLE CHARACTER, four sinks at once -----------------
      //
      // `redactObserved` ran on the raw walk result; `render.ts` then put every
      // name / value / text / cell and the title through quote() -> sanitize(),
      // which STRIPS U+202A-202E rather than escaping them. A value split by
      // one matched no needle when the scrub ran and was whole again in the
      // text the model received — `Snapshot.title`, `SnapshotNode.value`,
      // `.name` and `.rows`, all four measured at once
      // (docs/design/sink-closure-review.md F-B).
      //
      // Asserted on the WHOLE snapshot rather than a line, because the finding
      // is precisely that four unrelated fields failed for one shared reason.
      // Both alphabets are checked: verbatim, and again once the separator is
      // removed, since removing it is what Aperture does on the way out.
      // The SPLITSINK count is the non-vacuity half — a fixture that failed to
      // arm would otherwise pass by writing nothing at all.
      const splitRef = refIn(after, 'Split password into page', 'button');
      if (!splitRef) {
        check('G19g', 'a credential split by one invisible character does not come back whole',
          false, '"Split password into page" did not resolve to exactly one button');
      } else {
        await call('browser_act', { action: 'click', ref: splitRef });
        await sleep(400);
        const splitSnap = await call('browser_snapshot', { mode: 'full' });
        const splitRead = await call('browser_read', {});
        const armed = (splitSnap.match(/SPLITSINK/g) ?? []).length;
        check(
          'G19g',
          'a credential split by one invisible character does not come back whole — title, value, name, rows and href',
          absentEverywhere(splitSnap, SEEDED_PW) &&
            absentEverywhere(splitRead, SEEDED_PW) &&
            armed >= 5 && /withheld/.test(splitSnap),
          `SPLITSINK sinks armed in the snapshot: ${armed} (need >= 5); ` +
            `snapshot verbatim: ${splitSnap.includes(SEEDED_PW)}, once stripped: ${stripFormat(splitSnap).includes(SEEDED_PW)}, in any reading: ${!absentEverywhere(splitSnap, SEEDED_PW)}; ` +
            `read verbatim: ${splitRead.includes(SEEDED_PW)}, in any reading: ${!absentEverywhere(splitRead, SEEDED_PW)}\n        ` +
            splitSnap.split('\n').filter((l) => /SPLITSINK/.test(l)).join(' ⏎ ').slice(0, 340),
        );
      }

      // --- G19d / G19f / G19i: THE CARRIER TAB -------------------------------
      //
      // G19d used to open `about:blank` and ask for the listing "from a second
      // tab that has never held a credential". That construction cannot fail
      // for the reason it names: `browser_tabs list` takes no tabId, so which
      // tab asks changes nothing about what is scrubbed, and the value in the
      // listing sat in the FILLED tab's own title. An independent gate swapped
      // the cross-tab union for a per-tab scrub and the whole suite stayed
      // green (docs/design/sink-closure-review.md §2).
      //
      // The construction that discriminates is a CARRIER: a tab whose OWN title
      // and URL hold the value and which was never filled. The page opens it
      // with window.open, which makes Aperture create AND ACTIVATE it. Three
      // legs share the fixture, because they fail for three different reasons:
      //
      //   G19d  the aggregate listing        — what the union closed
      //   G19f  the DIRECT read of that tab  — what it did not, and the richer
      //         surface: browser_snapshot with NO arguments returns the whole
      //         tree, and that is the call an agent makes anyway
      //   G19i  the same carrier on a FOREIGN origin — reachable only through
      //         the opener origin Aperture records when it creates the tab
      const filledTab = /^\*\s*(\S+)/m.exec(
        (await call('browser_tabs', { action: 'list' }))
          .split('\n').find((l) => l.trim().startsWith('*')) ?? '',
      )?.[1] ?? '';

      const popRef = refIn(after, 'Open carrier tab', 'button');
      if (!popRef || !filledTab) {
        for (const g of ['G19d', 'G19f', 'G19i']) {
          check(g, 'the carrier tab a filled page opens carries no credential', false,
            `carrier button: ${popRef ?? '(unresolved)'}; filled tab: ${filledTab || '(unknown)'}`);
        }
      } else {
        await call('browser_act', { action: 'click', ref: popRef });
        await sleep(1600);

        // Asked with NO ARGUMENTS AT ALL. The carrier is the active tab because
        // Aperture activated it, so this is the agent's ordinary next call.
        const carrierSnap = await call('browser_snapshot', {});
        const carrierRead = await call('browser_read', {});
        const listing = await call('browser_tabs', { action: 'list' });

        check(
          'G19d',
          'the cross-tab listing does not carry a credential held by a CARRIER tab that was never filled',
          !listing.includes(SEEDED_PW) &&
            /CARRIERSINK/.test(listing) && /carried=/.test(listing) &&
            /withheld/.test(listing),
          `listing: ${listing.split('\n').filter((l) => /CARRIERSINK|carried=|withheld/.test(l)).join(' ⏎ ').slice(0, 260) || listing.slice(0, 260)}`,
        );

        check(
          'G19f',
          'browser_snapshot and browser_read with no arguments do not carry the credential out of the carrier tab',
          !carrierSnap.includes(SEEDED_PW) && !carrierRead.includes(SEEDED_PW) &&
            /CARRIERSINK/.test(carrierSnap) && /withheld/.test(carrierSnap),
          `snapshot carries it: ${carrierSnap.includes(SEEDED_PW)}; read carries it: ${carrierRead.includes(SEEDED_PW)}\n        ` +
            carrierSnap.split('\n').filter((l) => /CARRIERSINK|page "/.test(l)).join(' ⏎ ').slice(0, 300),
        );

        await call('browser_tabs', { action: 'focus', tabId: filledTab });
        await sleep(400);
        const foreignRef = refIn(
          await call('browser_snapshot', { mode: 'full' }),
          'Open foreign carrier tab',
          'button',
        );
        if (!foreignRef) {
          check('G19i', 'a carrier the filled page opens on ANOTHER origin carries no credential either',
            false, '"Open foreign carrier tab" did not resolve to exactly one button');
        } else {
          await call('browser_act', { action: 'click', ref: foreignRef });
          await sleep(1800);
          const fSnap = await call('browser_snapshot', {});
          const fList = await call('browser_tabs', { action: 'list' });
          check(
            'G19i',
            'a carrier the filled page opens on ANOTHER origin carries no credential either',
            !fSnap.includes(SEEDED_PW) && !fList.includes(SEEDED_PW) &&
              /CARRIERSINK/.test(fSnap) && /127\.0\.0\.2/.test(fSnap) &&
              /withheld/.test(fSnap),
            `snapshot carries it: ${fSnap.includes(SEEDED_PW)}; listing carries it: ${fList.includes(SEEDED_PW)}\n        ` +
              fSnap.split('\n').filter((l) => /CARRIERSINK|page "/.test(l)).join(' ⏎ ').slice(0, 300),
          );
        }

        // Leave exactly the filled tab behind, so G19e and G19h read the page
        // they think they are reading.
        for (const line of (await call('browser_tabs', { action: 'list' })).split('\n')) {
          const m = /^[* ]\s*(\S+)\s+\[/.exec(line);
          if (m && m[1] !== filledTab && /carrier\.html/.test(line)) {
            await call('browser_tabs', { action: 'close', tabId: m[1] });
          }
        }
        await call('browser_tabs', { action: 'focus', tabId: filledTab });
        await sleep(500);
      }

      // --- G19e: the element's TAG NAME in browser_act's refusal prose -------
      //
      // Both a needle leak and an injection surface: page-chosen bytes,
      // unquoted, uncapped, interpolated into a sentence that sits
      // deliberately OUTSIDE the untrusted envelope, in Aperture's own voice.
      // Every other page-authored string on this path goes through `quote()`;
      // this one did not.
      const modelTag = new Map();
      applyObservation(modelTag, after);
      const tagHits = [...modelTag.entries()].filter(([, e]) => e.label === 'Tag sink');
      if (tagHits.length !== 1) {
        check('G19e', 'a page-chosen element tag name cannot carry the credential into harness prose',
          false, `"Tag sink" resolves to ${tagHits.length} elements`);
      } else {
        const notSelect = await call('browser_act', {
          action: 'select', ref: tagHits[0][0], option: 'anything',
        });
        check(
          'G19e',
          'a page-chosen element tag name cannot carry the credential into harness prose',
          !notSelect.includes(SEEDED_PW) && /not a native <select>/.test(notSelect) &&
            /withheld/.test(notSelect),
          `reply: ${notSelect.split('\n')[0].slice(0, 220)}`,
        );
      }

      // --- G19h: THE NAVIGATION THAT USED TO DISARM THE REDACTION -----------
      //
      // No second tab, no popup, no script beyond one assignment. The filled
      // page navigates ITSELF, document-replacing, to a same-origin URL holding
      // the value. `invalidate(tabId, true)` called `clearNeedles(tabId)` on
      // exactly that event, so the navigation that DELIVERED the secret was the
      // navigation that disarmed the mechanism, and the next snapshot rendered
      // it in clear on the header line, in the tree, in browser_read AND in
      // browser_tabs list — the cross-tab union included, because with every
      // needle gone the union is empty too.
      //
      // Runs LAST in this block: it destroys the page every other G19 leg
      // reads. Guards after it call goFixture and start clean.
      const goRef = refIn(after, 'Navigate away carrying the value', 'button');
      if (!goRef) {
        check('G19h', 'a document-replacing navigation does not disarm the credential redaction',
          false, '"Navigate away carrying the value" did not resolve to exactly one button');
      } else {
        await call('browser_act', { action: 'click', ref: goRef });
        await sleep(1800);
        const navSnap = await call('browser_snapshot', { mode: 'full' });
        const navRead = await call('browser_read', {});
        const navList = await call('browser_tabs', { action: 'list' });
        check(
          'G19h',
          'a document-replacing navigation to a URL carrying the credential does not disarm the redaction',
          !navSnap.includes(SEEDED_PW) && !navRead.includes(SEEDED_PW) &&
            !navList.includes(SEEDED_PW) &&
            /CARRIERSINK/.test(navSnap) && /carried=/.test(navSnap) &&
            /withheld/.test(navSnap),
          `snapshot: ${navSnap.includes(SEEDED_PW)}; read: ${navRead.includes(SEEDED_PW)}; listing: ${navList.includes(SEEDED_PW)}\n        ` +
            (navSnap.split('\n').find((l) => l.startsWith('page "')) ?? '(no header line)').slice(0, 220),
        );
      }
    }
  }

  // --- G19j: THE URL SURFACES `scrubUrlish` WAS NOT WIRED TO ---------------
  //
  // `scrubUrlish` was written for one sentence in its own header — "a page that
  // writes the value it holds straight into a.href gets ?pw=my%20pass back out,
  // and the needle is `my pass`" — and was then wired to two of the five places
  // that sentence applies. The three that were not: `browser_tabs list`,
  // `browser_navigate`'s `loaded …` line, and `browser_capture`'s sourceUrl,
  // which leaves the machine. Measured on 43440a1: one same-origin
  // self-navigation with one U+202D inside the value, and the snapshot header
  // (which HAD scrubUrlish) came back clean while the other two carried
  // `?pw=guard-pw%E2%80%AD-93a1` (sink-closure-review-2.md F-C).
  //
  // Two legs, because the two surfaces are reached by two different calls and a
  // single aggregate assertion would say only "something leaked":
  //
  //   G19j   the tab LISTING, right after the page navigated itself
  //   G19j2  browser_navigate's `loaded …` line, on a navigation the guard
  //          issues to a URL with NO secret in it — settle.html puts the
  //          carried value into its own URL during load settle
  //
  // `absentEverywhere` is the assertion, not `!includes`: the finding is
  // precisely that the bytes arrive in an alphabet Aperture itself would
  // decode, so absence is checked in every reading — raw, stripped,
  // percent-decoded, and both.
  {
    await goFixture(BASE, 'login.html');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(500);
    const snap = await call('browser_snapshot', { mode: 'full' });
    const navRef = refIn(snap, 'Self-navigate with the value split in the query', 'button');
    if (!out.includes(SAYS.FILLED) || !navRef) {
      for (const g of ['G19j', 'G19j2']) {
        check(g, 'a URL-bearing surface does not hand back a percent-encoded credential', false,
          `fill: ${out.split('\n')[0].slice(0, 120)}; button: ${navRef ?? '(unresolved)'}`);
      }
    } else {
      await call('browser_act', { action: 'click', ref: navRef });
      await sleep(1800);

      const listing = await call('browser_tabs', { action: 'list' });
      const header = await call('browser_snapshot', { mode: 'full' });
      check(
        'G19j',
        'the tab listing does not hand back a credential the URL parser percent-encoded',
        absentEverywhere(listing, SEEDED_PW) && absentEverywhere(header, SEEDED_PW) &&
          /SETTLESINK/.test(listing) && /landed=1/.test(listing) &&
          /withheld/.test(listing),
        `listing verbatim: ${listing.includes(SEEDED_PW)}, in any reading: ${!absentEverywhere(listing, SEEDED_PW)}; ` +
          `header in any reading: ${!absentEverywhere(header, SEEDED_PW)}\n        ` +
          (listing.split('\n').find((l) => /settle\.html/.test(l)) ?? '(no settle line)').trim().slice(0, 240),
      );

      // No secret in the URL the guard asks for. settle.html reads what the
      // filled page stashed for its own origin and rewrites its URL during the
      // settle, which is exactly the surface `loaded …` reads.
      const nav = await call('browser_navigate', { action: 'goto', url: `${BASE}/settle.html` });
      await sleep(500);
      check(
        'G19j2',
        "browser_navigate's `loaded …` line does not hand back a percent-encoded credential",
        absentEverywhere(nav, SEEDED_PW) && /loaded/.test(nav) && /withheld/.test(nav),
        `verbatim: ${nav.includes(SEEDED_PW)}, in any reading: ${!absentEverywhere(nav, SEEDED_PW)}\n        ` +
          nav.split('\n')[0].slice(0, 240),
      );
    }
  }

  // --- G19k: CROSS-ORIGIN SELF-NAVIGATION, FRAGMENT ONLY -------------------
  //
  // The construction the previous pass filed as unclosable, on a premise that
  // is false: "that navigation hands the value to the target origin's server
  // anyway". A QUERY STRING does. A FRAGMENT DOES NOT — it is never sent — so
  // nothing is exfiltrated and the target need not be hostile, scripted, or
  // even awake. `inert.html` has no script at all, on purpose.
  //
  // What moved was the value's position relative to the redactor. Needle scope
  // was the tab's PRESENT origin plus its opener's; a tab that walks itself out
  // of the filled origin took the value somewhere neither covers, and
  // `Snapshot.url` carried it verbatim (sink-closure-review-2.md F-E).
  //
  // Three surfaces asserted, because the finding is that one line reaches all
  // three, and the first arrives WITHOUT A FOLLOW-UP CALL: the `browser_act`
  // result is the same call that caused the navigation, so the credential lands
  // in the agent's context on the turn the page chooses.
  {
    await goFixture(BASE, 'login.html');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(500);
    const snap = await call('browser_snapshot', { mode: 'full' });
    const fragRef = refIn(snap, 'Self-navigate to a third origin, value in the fragment', 'button');
    if (!out.includes(SAYS.FILLED) || !fragRef) {
      check('G19k', 'a cross-origin self-navigation with the value in the FRAGMENT carries nothing back',
        false, `fill: ${out.split('\n')[0].slice(0, 120)}; button: ${fragRef ?? '(unresolved)'}`);
    } else {
      const act = await call('browser_act', { action: 'click', ref: fragRef });
      await sleep(1800);
      const after = await call('browser_snapshot', { mode: 'full' });
      const listing = await call('browser_tabs', { action: 'list' });
      check(
        'G19k',
        'a cross-origin self-navigation with the value in the FRAGMENT carries it into none of the act result, the snapshot, or the listing',
        absentEverywhere(act, SEEDED_PW) && absentEverywhere(after, SEEDED_PW) &&
          absentEverywhere(listing, SEEDED_PW) &&
          /INERTSINK/.test(after) && /127\.0\.0\.2/.test(after) && /withheld/.test(after),
        `act result: ${act.includes(SEEDED_PW)}; snapshot: ${after.includes(SEEDED_PW)}; ` +
          `listing: ${listing.includes(SEEDED_PW)}\n        ` +
          (after.split('\n').find((l) => l.startsWith('page "')) ?? '(no header line)').slice(0, 240),
      );
    }
  }

  // --- G19l: A PAGE-CHOSEN STRING ON THE NETWORK ---------------------------
  //
  // The one finding in this family that is not about agent context at all.
  // `normalizeUrl` turns a disallowed scheme into `duckduckgo.com/?q=<the whole
  // string>`, which is the right answer for a human typing "weather" into the
  // address bar. `setWindowOpenHandler` fed it whatever a PAGE passed to
  // window.open, so one line of page script made Aperture send page-chosen
  // bytes to a third-party server the page never named — and an origin whose
  // own CSP forbids its `fetch()` from phoning home is exactly the adversary
  // the whole needle mechanism exists for.
  //
  // Asserted with a MARKER, never the credential: the guard must not be the
  // thing that mails the seeded password to a search engine. The assertion is
  // on the tab set, not on the network, so it holds on a machine with no
  // internet — before the fix the tab exists carrying that URL whether or not
  // the load succeeds; after it, no tab is created at all.
  {
    await goFixture(BASE, 'login.html');
    const snap = await call('browser_snapshot', { mode: 'full' });
    const schemeRef = refIn(snap, 'Open a non-web scheme', 'button');
    if (!schemeRef) {
      check('G19l', 'a page cannot make Aperture put its bytes on the network via window.open',
        false, '"Open a non-web scheme" did not resolve to exactly one button');
    } else {
      await call('browser_act', { action: 'click', ref: schemeRef });
      await sleep(2500);
      const listing = await call('browser_tabs', { action: 'list' });
      const searched = listing
        .split('\n')
        .filter((l) => /duckduckgo\.com\/\?q=/.test(l) || /SCHEMESINK93a1/i.test(l));
      check(
        'G19l',
        'a window.open target with a non-web scheme is refused, not turned into a third-party search carrying the page\'s bytes',
        searched.length === 0,
        searched.length
          ? `Aperture navigated to:\n        ${searched.join('\n        ').slice(0, 320)}`
          : 'no tab was created for the refused scheme, and nothing left the machine',
      );
    }
  }

  // --- G19m: THE TWO-HOP OPENER CHAIN --------------------------------------
  //
  // Opener inheritance has to be TRANSITIVE, and it was one-deep: `openerOrigin`
  // recorded the opener's CURRENT ORIGIN, so a chain
  // `filled → 127.0.0.2 → localhost` left the second hop with an opener that
  // holds no needles, and hop 2 came back
  // `page "HOP2 guard-pw-93a1" …?carried=guard-pw-93a1`
  // (docs/design/sink-closure-review-2.md F-D).
  //
  // This leg exists because a fix nobody can break is a fix nobody will notice
  // breaking. It is the one property in this family a sabotage row proved the
  // suite could NOT see: reverting the inheritance to the opener's current
  // origin left all fifty-four other checks green.
  //
  // Three distinct ORIGINS on two host bindings — `localhost:8899` and
  // `127.0.0.1:8899` are different origins and different registrable domains
  // even though they are the same server, which is the same fact G20's `nav=`
  // mode turns on. No fixture host beyond the two this file already requires.
  {
    await goFixture(BASE, 'login.html');
    const out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    await sleep(500);
    const snap = await call('browser_snapshot', { mode: 'full' });
    const relayRef = refIn(snap, 'Open a two-hop relay', 'button');
    if (!out.includes(SAYS.FILLED) || !relayRef) {
      check('G19m', 'opener inheritance survives a second hop', false,
        `fill: ${out.split('\n')[0].slice(0, 120)}; button: ${relayRef ?? '(unresolved)'}`);
    } else {
      await call('browser_act', { action: 'click', ref: relayRef });
      // Two window.opens and two loads, and the second is issued by the first
      // page's own script after it lands.
      await sleep(3200);
      // Hop 2 is the ACTIVE tab, because Aperture activates what a page opens.
      const hop2 = await call('browser_snapshot', { mode: 'full' });
      const hop2Read = await call('browser_read', {});
      const listing = await call('browser_tabs', { action: 'list' });
      check(
        'G19m',
        'a credential relayed through TWO page-opened tabs is covered at the second hop, not only the first',
        absentEverywhere(hop2, SEEDED_PW) && absentEverywhere(hop2Read, SEEDED_PW) &&
          absentEverywhere(listing, SEEDED_PW) &&
          /CARRIERSINK/.test(hop2) && /localhost/.test(hop2) &&
          /RELAYSINK/.test(listing) && /withheld/.test(hop2),
        `hop2 snapshot: ${hop2.includes(SEEDED_PW)}; hop2 read: ${hop2Read.includes(SEEDED_PW)}; ` +
          `listing: ${listing.includes(SEEDED_PW)}\n        ` +
          (hop2.split('\n').find((l) => l.startsWith('page "')) ?? '(no header line)').slice(0, 240) +
          '\n        ' +
          (listing.split('\n').find((l) => /relay\.html/.test(l)) ?? '(no relay line)').trim().slice(0, 200),
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

    // --- G32: the origin bound, measured where the value BELONGS ------------
    //
    // G26a-blind asserts the code is absent from `browser_read`, and it passes
    // for a reason that does not generalise: `browser_read` takes a live
    // `taintedValues` walk, so it sees the FIELD. An href is not innerText, so
    // `browser_read` cannot see one at all — the G19b argument, re-opened for
    // this value class. Nothing asserted the code was absent from a SNAPSHOT,
    // and the fourth gate measured it leaking there:
    //
    //     link e1 "Continue to checkout" /leak?pw=&c=108140
    //
    // The cause was a SHAPE rule — `registrableNeedle` refused an all-digit
    // value shorter than nine outright — introduced to stop an over-redaction
    // the third gate measured on a CARRIED origin. Wrong instrument for a scope
    // problem: it paid for one origin's false positives with every origin's
    // coverage, and it unneedled a 6-to-8 digit nationalId, bankAccount or
    // salary along with the one-time code. The rule is scope now
    // (`redact.ts`, `originBoundNeedle`): registered like any other needle,
    // matched only on the origin it was filled into.
    //
    // G31 and G32 are the two directions of that one bound and neither is
    // sufficient alone. G31 fails if the bound stops existing; G32 fails if the
    // bound is a refusal to register rather than a limit on reach.
    {
      const snapOtp = await call('browser_snapshot', { mode: 'full' });
      const echoRef = refIn(snapOtp, 'Echo password to page', 'button');
      if (!echoRef) {
        check('G32', 'a short all-digit value is redacted in a copy the page makes on the FILLED origin',
          false, '"Echo password to page" did not resolve to exactly one button');
      } else {
        await call('browser_act', { action: 'click', ref: echoRef });
        await sleep(300);
        const afterOtp = await call('browser_snapshot', { mode: 'full' });
        // The link's OWN line, so this stays about the href even if some other
        // sink regresses — the same reason G19b asserts on one line.
        const leakLine =
          afterOtp.split('\n').find((l) => l.includes('/leak?pw=')) ??
          afterOtp.split('\n').find((l) => l.includes('Continue to checkout')) ??
          '';
        const carries = codes.filter((c) => leakLine.includes(c));
        check(
          'G32',
          'a short all-digit value does not escape through a link href on the origin it was filled into',
          leakLine !== '' && carries.length === 0 &&
            leakLine.includes('/leak?pw=') && /matches-a-filled-value/.test(leakLine),
          `link line: ${leakLine.trim().slice(0, 180) || '(no line carrying the echoed link)'}\n        ` +
            `codes checked: ${codes.length} windows; present in the href: ${carries.length}`,
        );
      }
    }

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

  // ==========================================================================
  // G30: THE PROFILE PATH — the same sinks, the other fill path
  // ==========================================================================
  //
  // THE FOURTEENTH FINDING, AND IT IS THE FIRST ONE AGAIN. `registerNeedles`
  // had exactly ONE call site for three gates — `vault_request_fill` — so every
  // mechanism above (origin-keyed needles, `carriedOrigins`, `redactUrl`, the
  // walk-time alphabet) protected credentials and nothing else.
  // `browser_fill_form` called `markTainted` alone, which masks the FIELDS
  // Aperture wrote into and no copy of them, and which a document-replacing
  // navigation clears. So the third gate pointed sink 1 — "copy the value into a
  // div and have the agent read it", the first attack of the whole programme —
  // at a filled `dateOfBirth` and it walked out through the same-tab snapshot,
  // a link href, the page title, a carrier tab and the tab listing
  // (docs/design/sink-closure-review-3.md §2).
  //
  // These legs are DELIBERATELY the credential legs re-pointed, one for one:
  //
  //   G30a ← G19  + G19c   the echoed value, the read, and the header line
  //   G30b ← G19b          the href, which browser_read cannot see at all
  //   G30c ← G19d + G19f   the carrier tab: the listing AND the direct read
  //   G30d ← G19i          the same carrier on a FOREIGN origin
  //   G30e ← G19h          the document-replacing self-navigation
  //
  // If these needed new shapes, the parity claim would be about something other
  // than parity. What stops a THIRD fill path shipping uncovered is not here at
  // all — it is `test/fillpaths.test.ts`, which enumerates every `requestFill`
  // call site and requires each to arm both halves. These legs prove the
  // instance; that file guards the mechanism.
  //
  // Needs `--seed-profile` on the launch. G30-seed fails loudly rather than
  // letting the rest pass vacuously on an empty form.
  {
    await goFixture(BASE, 'profile.html');
    const planned = await call('browser_fill_form', { action: 'plan' });
    check(
      'G30-seed',
      'the dev-seeded profile is reachable, so the profile guards test something',
      /dateOfBirth/.test(planned) && /value not shown/.test(planned),
      /no identity profile saved/.test(planned)
        ? 'NO PROFILE SEEDED. Relaunch with --seed-profile; every G30 leg below ' +
          'fails on apparatus, not on discrimination.'
        : `plan: ${planned.split('\n').filter((l) => /→/.test(l)).join(' ⏎ ').slice(0, 220)}`,
    );

    const applied = await call('browser_fill_form', { action: 'apply' });
    await sleep(700);
    const filledLog = await call('browser_read', {});
    check(
      'G30-fill',
      'the profile fill lands the sensitive value in the page, so the sinks below have something to carry',
      /filled \d+ of/.test(applied) && /dateOfBirth/.test(applied) &&
        /dob-set:true/.test(filledLog),
      `reply: ${applied.split('\n')[0].slice(0, 180)}\n        ` +
        `page witness: ${(/profile-log: (.*)/.exec(filledLog) ?? [, '(none)'])[1]}`,
    );

    const base = await call('browser_snapshot', { mode: 'full' });
    const echoRef = refIn(base, 'Echo profile value to page', 'button');
    if (!echoRef) {
      for (const g of ['G30a', 'G30b']) {
        check(g, 'the filled profile value does not come back out of the page', false,
          '"Echo profile value to page" did not resolve to exactly one button');
      }
    } else {
      await call('browser_act', { action: 'click', ref: echoRef });
      await sleep(400);
      const after = await call('browser_snapshot', { mode: 'full' });
      const read = await call('browser_read', {});
      const headerLine = after.split('\n').find((l) => l.startsWith('page "')) ?? '';

      // G19 + G19c, re-pointed. The whole snapshot, browser_read, and the
      // header line — which carries Snapshot.title and Snapshot.url, the two
      // strings that are page-controlled without a navigation. Non-vacuity is
      // the PROFILESINK / dobsink= half: a fixture that failed to arm would
      // otherwise pass by writing nothing at all.
      check(
        'G30a',
        'a filled PROFILE value does not come back through the snapshot, browser_read, or the header line',
        absentEverywhere(after, SEEDED_DOB) && absentEverywhere(read, SEEDED_DOB) &&
          /PROFILESINK/.test(after) && /dobsink=/.test(headerLine) &&
          /withheld/.test(after) && /withheld/.test(read),
        `snapshot carries it: ${!absentEverywhere(after, SEEDED_DOB)}; ` +
          `read carries it: ${!absentEverywhere(read, SEEDED_DOB)}\n        ` +
          `header: ${headerLine.trim().slice(0, 200) || '(no header line)'}`,
      );

      // G19b, re-pointed. Split out for the reason G19b was: a link target is
      // not innerText, so browser_read cannot see it and only the snapshot line
      // can catch it. It is also the field this codebase forgets.
      const leakLine =
        after.split('\n').find((l) => l.includes('/leak?dob=')) ??
        after.split('\n').find((l) => l.includes('Continue')) ?? '';
      check(
        'G30b',
        'the profile value does not escape through a link href either',
        leakLine !== '' && absentEverywhere(leakLine, SEEDED_DOB) &&
          leakLine.includes('/leak?dob=') && /matches-a-filled-value/.test(leakLine),
        `link line: ${leakLine.trim().slice(0, 180) || '(no line carrying the echoed link)'}`,
      );

      // G19d + G19f + G19i, re-pointed. The carrier is a tab that was NEVER
      // filled, on a page Aperture created and activated because the page asked
      // — so `browser_snapshot` with no arguments at all is the agent's
      // ordinary next call and it returns the whole tree.
      const filledTab = /^\*\s*(\S+)/m.exec(
        (await call('browser_tabs', { action: 'list' }))
          .split('\n').find((l) => l.trim().startsWith('*')) ?? '',
      )?.[1] ?? '';
      const popRef = refIn(after, 'Open profile carrier tab', 'button');
      if (!popRef || !filledTab) {
        for (const g of ['G30c', 'G30d']) {
          check(g, 'the carrier tab a filled profile page opens carries no profile value', false,
            `carrier button: ${popRef ?? '(unresolved)'}; filled tab: ${filledTab || '(unknown)'}`);
        }
      } else {
        await call('browser_act', { action: 'click', ref: popRef });
        await sleep(1600);
        const carrierSnap = await call('browser_snapshot', {});
        const carrierRead = await call('browser_read', {});
        const listing = await call('browser_tabs', { action: 'list' });
        check(
          'G30c',
          'a carrier tab the filled profile page opens carries the value on no surface — snapshot, read or listing',
          absentEverywhere(carrierSnap, SEEDED_DOB) &&
            absentEverywhere(carrierRead, SEEDED_DOB) &&
            absentEverywhere(listing, SEEDED_DOB) &&
            /CARRIERSINK/.test(carrierSnap) && /withheld/.test(carrierSnap),
          `snapshot: ${!absentEverywhere(carrierSnap, SEEDED_DOB)}; read: ${!absentEverywhere(carrierRead, SEEDED_DOB)}; ` +
            `listing: ${!absentEverywhere(listing, SEEDED_DOB)}\n        ` +
            carrierSnap.split('\n').filter((l) => /CARRIERSINK|page "/.test(l)).join(' ⏎ ').slice(0, 300),
        );

        await call('browser_tabs', { action: 'focus', tabId: filledTab });
        await sleep(400);
        const foreignRef = refIn(
          await call('browser_snapshot', { mode: 'full' }),
          'Open foreign profile carrier tab',
          'button',
        );
        if (!foreignRef) {
          check('G30d', 'a foreign-origin carrier the filled profile page opens carries nothing either',
            false, '"Open foreign profile carrier tab" did not resolve to exactly one button');
        } else {
          await call('browser_act', { action: 'click', ref: foreignRef });
          await sleep(1800);
          const fSnap = await call('browser_snapshot', {});
          const fList = await call('browser_tabs', { action: 'list' });
          check(
            'G30d',
            'a carrier the filled profile page opens on ANOTHER origin carries nothing either',
            absentEverywhere(fSnap, SEEDED_DOB) && absentEverywhere(fList, SEEDED_DOB) &&
              /CARRIERSINK/.test(fSnap) && /127\.0\.0\.2/.test(fSnap) && /withheld/.test(fSnap),
            `snapshot: ${!absentEverywhere(fSnap, SEEDED_DOB)}; listing: ${!absentEverywhere(fList, SEEDED_DOB)}\n        ` +
              fSnap.split('\n').filter((l) => /CARRIERSINK|page "/.test(l)).join(' ⏎ ').slice(0, 300),
          );
        }

        for (const line of (await call('browser_tabs', { action: 'list' })).split('\n')) {
          const m = /^[* ]\s*(\S+)\s+\[/.exec(line);
          if (m && m[1] !== filledTab && /carrier\.html/.test(line)) {
            await call('browser_tabs', { action: 'close', tabId: m[1] });
          }
        }
        await call('browser_tabs', { action: 'focus', tabId: filledTab });
        await sleep(500);
      }

      // G19h, re-pointed, and the leg that most needed the profile path to have
      // needles at all. `invalidate(documentReplaced = true)` CLEARS TAINT — the
      // fields really are gone with the document — so before this fix the
      // profile path had nothing left on the other side of a navigation. Runs
      // last in this block: it destroys the page every leg above reads.
      const goRef = refIn(
        await call('browser_snapshot', { mode: 'full' }),
        'Navigate away carrying the profile value',
        'button',
      );
      if (!goRef) {
        check('G30e', 'a document-replacing navigation does not disarm the profile redaction',
          false, '"Navigate away carrying the profile value" did not resolve to exactly one button');
      } else {
        await call('browser_act', { action: 'click', ref: goRef });
        await sleep(1800);
        const navSnap = await call('browser_snapshot', { mode: 'full' });
        const navRead = await call('browser_read', {});
        const navList = await call('browser_tabs', { action: 'list' });
        check(
          'G30e',
          'a document-replacing navigation carrying the profile value does not disarm the redaction',
          absentEverywhere(navSnap, SEEDED_DOB) && absentEverywhere(navRead, SEEDED_DOB) &&
            absentEverywhere(navList, SEEDED_DOB) &&
            /CARRIERSINK/.test(navSnap) && /carried=/.test(navSnap) && /withheld/.test(navSnap),
          `snapshot: ${!absentEverywhere(navSnap, SEEDED_DOB)}; read: ${!absentEverywhere(navRead, SEEDED_DOB)}; ` +
            `listing: ${!absentEverywhere(navList, SEEDED_DOB)}\n        ` +
            (navSnap.split('\n').find((l) => l.startsWith('page "')) ?? '(no header line)').slice(0, 220),
        );
      }
    }
  }

  // --- G31: OVER-redaction, which is the only guard here pointing that way ---
  //
  // Every other check in this file fails when something LEAKS. This one fails
  // when something is redacted that should not be, and it exists because the
  // third gate measured a cost that is not cosmetic (sink-closure-review-3 §3).
  //
  // A six-digit one-time code was the shortest value the store accepted. Filled
  // on one origin, it then rewrote a legitimate order number on an UNRELATED
  // origin the same tab visited — precisely (the neighbours survived), and
  // wrongly in three ways: the same URL read differently in two tabs with
  // nothing saying so, and the marker asserted `(filled, value withheld)` where
  // nothing had been filled, which is a claim the agent may act on rather than
  // merely a gap.
  //
  // WHAT HOLDS THIS GREEN CHANGED, AND THE LEG DID NOT — 2026-08-05, fourth
  // gate. Between the third and fourth gates the code was not registered at
  // all, so this leg passed because there was no needle. Now it IS registered
  // and is refused only on origins the tab CARRIES (`redact.ts`,
  // `originBoundNeedle`; `engine.ts`, `needlesFor`). That is a better reason
  // for the same observation, and it is why G32 exists: without it, reverting
  // to the refusal would look identical from here.
  //
  // THE SECOND ROW IS WHAT MAKES THIS DISCRIMINATE. `ORDER-D` carries the
  // USERNAME from the same fill — a needle by every rule — on the same page, in
  // the same snapshot. Without it a green here is indistinguishable from
  // redaction being switched off, from a tab that never carried the filled
  // origin, and from a fixture that failed to arm. With it, one observation
  // shows the mechanism live and the all-digit bar doing exactly one thing.
  {
    await goFixture(BASE, 'login.html', 'mode=otp');
    let out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    // G26 already issued a code in whatever 30-second window it ran in, and the
    // vault refuses a second one inside the same window — correctly, that is
    // G26b's whole claim. So this leg waits for the next counter rather than
    // measuring a refusal: an over-redaction guard whose fill never landed is
    // vacuous in the direction that is hardest to notice, because "nothing was
    // rewritten" is exactly what it asserts.
    if (out.includes(SAYS.TOTP_ALREADY_ISSUED)) {
      await sleep(30_000 - (Date.now() % 30_000) + 800);
      out = await call('vault_request_fill', { action: 'apply', entryId: entry });
    }
    await sleep(600);
    const now = Math.floor(Date.now() / 1000 / 30);
    const codes = [totpAt(now), totpAt(now - 1)];
    await call('browser_navigate', {
      action: 'goto',
      url: `${BASE_2}/numbers.html#${codes[0]}|${SEEDED_USER}`,
    });
    await sleep(1200);
    const snap = await call('browser_snapshot', { mode: 'full' });
    const codeSurvives = codes.some((c) => snap.includes(c));
    const controlsSurvive = snap.includes('100200') && snap.includes('998877');
    const needleRedacted = !snap.includes(SEEDED_USER) && /withheld/.test(snap);
    check(
      'G31',
      'an origin-bound value does not rewrite an unrelated origin, while a real needle on the same page still does',
      out.includes(SAYS.FILLED) && /NUMBERSINK/.test(snap) &&
        codeSurvives && controlsSurvive && needleRedacted,
      `fill: ${out.split('\n')[0].slice(0, 120)}\n        ` +
        `six-digit code survived: ${codeSurvives}; controls survived: ${controlsSurvive}; ` +
        `the co-filled username on the same page WAS redacted: ${needleRedacted}\n        ` +
        snap.split('\n').filter((l) => /ORDER-|page "/.test(l)).join(' ⏎ ').slice(0, 320),
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
