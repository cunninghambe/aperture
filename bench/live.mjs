/**
 * Live benchmark against a running Aperture.
 *
 * Measures three things the synthetic bench cannot:
 *   A. Full-snapshot size on real sites.
 *   B. Ref stability across a re-snapshot of a live page.
 *   C. The no-change observation floor.
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

console.log(`
## What this still does not measure

Task success rate on diffs versus re-dumps. That needs an agent in the loop
completing a fixed task set both ways, and it remains the single most important
unmeasured claim in this project. Nothing above tells you whether a model
reconstructs page state correctly from deltas.
`);
