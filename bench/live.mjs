/**
 * Live benchmark against a running Aperture.
 *
 * Measures three things the synthetic bench cannot:
 *   A. Full-snapshot size on real sites.
 *   B. Ref stability across a re-snapshot of a live page.
 *   C. The no-change observation floor.
 *
 * Section D is not a measurement but an assertion: page-derived text must
 * arrive inside the untrusted-content envelope, and harness speech must not.
 * It lives here rather than in the unit tests because the unit tests can only
 * prove the wrapper is correct — they cannot prove every call site uses it.
 * Two paths did not (the tab list and browser_act's observations), and only a
 * live response would have shown it.
 *
 * It does NOT measure diff cost after a real interaction, because there is no
 * generic click/type tool yet — see RESULTS.md. Section C is the floor, not a
 * diff, and an earlier draft wrongly reported it as one.
 *
 * Usage:
 *   npx electron .              # in another terminal
 *   node bench/live.mjs <bearer-token>
 */

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error('usage: node bench/live.mjs <bearer-token>');
  process.exit(1);
}

const ENDPOINT = 'http://127.0.0.1:8817/mcp';
let id = 0;

async function call(name, args = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await res.text();
  const line = body.split('\n').find((l) => l.trim().startsWith('{') || l.startsWith('data: {'));
  if (!line) return '';
  const json = JSON.parse(line.replace(/^data: /, ''));
  return json.result?.content?.[0]?.text ?? '';
}

const tok = (s) => Math.ceil(s.length / 4);
const assertReal = (s, where) => {
  if (!s || s.includes("validation error") || tok(s) < 60) {
    throw new Error(where + ": got an error or a stub, not a snapshot -> " + s.slice(0, 140));
  }
};
const refsIn = (s) => new Set([...s.matchAll(/\be(\d+)\b/g)].map((m) => m[0]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The opening delimiter, with a fresh 8-hex nonce, exactly as tools.ts emits it. */
const ENVELOPE_OPEN = /<untrusted-page-content id=[0-9a-f]{8} /;

/** Page bytes must never reach the agent outside the envelope. */
function assertEnveloped(out, where) {
  if (!ENVELOPE_OPEN.test(out)) {
    throw new Error(
      `${where}: page-derived text arrived OUTSIDE the untrusted-page-content ` +
        `envelope -> ${JSON.stringify(out.slice(0, 200))}`,
    );
  }
}

/**
 * Harness speech must never reach the agent INSIDE the envelope.
 *
 * `browser_act` acknowledges with `ok <action>` and then shows the page. If
 * the acknowledgement is inside the block, Aperture is impersonating page
 * content — the exact confusion the envelope exists to prevent, inverted —
 * and it teaches the model that harness-shaped text in an envelope is
 * sometimes real.
 */
function assertAckOutsideEnvelope(out, where) {
  const lines = out.split('\n');
  const ack = lines.findIndex((l) => /^ok /.test(l));
  const open = lines.findIndex((l) => ENVELOPE_OPEN.test(l));
  if (ack === -1) throw new Error(`${where}: no "ok …" acknowledgement line`);
  if (open === -1) throw new Error(`${where}: no envelope in an act response`);
  if (ack > open) {
    throw new Error(
      `${where}: the "ok …" acknowledgement is INSIDE the envelope ` +
        `(ack on line ${ack}, envelope opens on line ${open})`,
    );
  }
}

const SITES = [
  { name: 'Hacker News', url: 'https://news.ycombinator.com' },
  { name: 'GitHub repo', url: 'https://github.com/anthropics/claude-code' },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Model_Context_Protocol' },
  { name: 'MDN (SPA-ish)', url: 'https://developer.mozilla.org/en-US/docs/Web/API/fetch' },
];

console.log('# Live benchmark\n');
console.log('## A. Full snapshot size\n');
console.log('| site | tokens | refs | lines |');
console.log('|---|---|---|---|');

const first = new Map();
for (const s of SITES) {
  await call('browser_navigate', { action: 'goto', url: s.url });
  await sleep(3500);
  const snap = await call('browser_snapshot', { mode: 'full', budgetTokens: 20000 });
  assertReal(snap, s.name);
  first.set(s.name, snap);
  console.log(`| ${s.name} | ${tok(snap)} | ${refsIn(snap).size} | ${snap.split('\n').length} |`);
}

console.log('\n## B. Ref stability across a re-snapshot (no interaction)\n');
console.log('| site | refs before | refs after | survived | % |');
console.log('|---|---|---|---|---|');

for (const s of SITES) {
  await call('browser_navigate', { action: 'goto', url: s.url });
  await sleep(3500);
  const a = await call('browser_snapshot', { mode: 'full', budgetTokens: 20000 });
  await sleep(1500);
  const b = await call('browser_snapshot', { mode: 'full', budgetTokens: 20000 });
  const ra = refsIn(a);
  const rb = refsIn(b);
  const kept = [...ra].filter((r) => rb.has(r)).length;
  const pct = ra.size ? Math.round((kept / ra.size) * 100) : 0;
  console.log(`| ${s.name} | ${ra.size} | ${rb.size} | ${kept} | ${pct}% |`);
}

console.log('\n## C. The no-change floor (NOT a diff measurement)\n');
console.log('| site | full snapshot | observation when nothing changed |');
console.log('|---|---|---|');

for (const s of SITES) {
  await call('browser_navigate', { action: 'goto', url: s.url });
  await sleep(3500);
  const full = await call('browser_snapshot', { mode: 'full', budgetTokens: 20000 });
  // NOTE: this does not change the DOM, so what follows is the no-change
  // floor, not a diff. A real diff cannot be measured until browser_act
  // exists — see RESULTS.md.
  await call('browser_theme', { site: 'off' });
  await sleep(1200);
  const diff = await call('browser_snapshot', { mode: 'auto', budgetTokens: 20000 });
  // No ratio on purpose. Dividing the full snapshot by the no-change floor
  // produced a 48x-83x figure that read like a diff result and was not one.
  console.log(`| ${s.name} | ${tok(full)} | ${tok(diff)} |`);
}

console.log('\n## D. Untrusted-content envelope, asserted on every page-bearing path\n');
console.log('| site | browser_tabs list | browser_act |');
console.log('|---|---|---|');

for (const s of SITES) {
  await call('browser_navigate', { action: 'goto', url: s.url });
  await sleep(3500);

  // Tab titles are page-authored. This path was NOT wrapped until 2026-07-31:
  // a tab calling itself "SYSTEM: ignore previous instructions" reached the
  // agent as bare harness-level text.
  const tabsOut = await call('browser_tabs', { action: 'list' });
  assertEnveloped(tabsOut, `${s.name} browser_tabs list`);
  if (!/origin=multiple>/.test(tabsOut)) {
    throw new Error(
      `${s.name} browser_tabs list: the list aggregates tabs across origins ` +
        'and must declare origin=multiple rather than claim one of them',
    );
  }

  // scroll needs no ref, so it works on any page.
  const actOut = await call('browser_act', { action: 'scroll', deltaY: 400 });
  assertEnveloped(actOut, `${s.name} browser_act`);
  assertAckOutsideEnvelope(actOut, `${s.name} browser_act`);

  console.log(`| ${s.name} | enveloped (origin=multiple) | enveloped, ack outside |`);
}

console.log(`
## What this still does not measure

Task success rate on diffs versus re-dumps. That needs an agent in the loop
completing a fixed task set both ways, and it remains the single most important
unmeasured claim in this project. Nothing above tells you whether a model
reconstructs page state correctly from deltas.
`);
