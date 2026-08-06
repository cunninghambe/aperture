/**
 * Header order and casing on the wire, captured server-side.
 *
 * THE QUESTION (docs/design/security.md verification queue #7). Registering an
 * `onBeforeSendHeaders` listener that returns the request's own header map is
 * claimed to be inert on the wire. That is a property of RETURNING ANYTHING AT
 * ALL, not of what is returned, so no amount of reading `webRequestMux.ts` can
 * settle it. Four launches, one server, `req.rawHeaders` recorded verbatim.
 *
 * IT IS A PROBE, NOT A GUARD. It does not judge; it records. The judging is the
 * diff mode below and the sentence a human writes from it.
 *
 * `req.rawHeaders` is the only reading that preserves both ORDER and ORIGINAL
 * CASING. `req.headers` lowercases and merges and must never be used for the
 * comparison — it would answer the casing question by erasing it.
 *
 * BINDS BOTH LOOPBACK FAMILIES. On Windows `localhost` resolves to `::1` first,
 * and a leg whose request never arrived is a vacuous result that looks like a
 * clean one. Same reason the G33 server does it.
 *
 * Usage:
 *   node bench/probes/webbotauth/headerorder.mjs --out <file.jsonl>
 *   node bench/probes/webbotauth/headerorder.mjs --diff <A.jsonl> <BC.jsonl> <D.jsonl>
 */
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const PORT = 8902;
const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const diffFlag = argv.indexOf('--diff');

// --- capture mode ----------------------------------------------------------

if (outFlag !== -1) {
  const OUT = argv[outFlag + 1];
  if (!OUT) {
    console.error('--out needs a file path');
    process.exit(3);
  }
  let seq = 0;

  const handler = (req, res) => {
    const raw = req.rawHeaders ?? [];
    const rawNames = raw.filter((_, i) => i % 2 === 0);
    const values = raw.filter((_, i) => i % 2 === 1);
    const lowerNames = rawNames.map((n) => n.toLowerCase());

    // Values are recorded for the SIGNATURE NAMES ONLY. Everything else is
    // compared by name, because a nonce and a fresh signature differ per
    // request by design and a cookie may differ across launches.
    const signatureHeaders = {};
    rawNames.forEach((n, i) => {
      if (/^signature(-input|-agent)?$/i.test(n)) signatureHeaders[n] = values[i] ?? '';
    });

    const rec = {
      seq: ++seq,
      authority: req.headers.host ?? '',
      url: req.url ?? '',
      method: req.method ?? '',
      httpVersion: req.httpVersion ?? '',
      rawNames,
      lowerNames,
      signatureHeaders,
    };
    appendFileSync(OUT, `${JSON.stringify(rec)}\n`);

    const leg = (req.url ?? '').split('/')[2] ?? '?';
    console.log(`seq=${rec.seq} leg=${leg} host=${rec.authority} http/${rec.httpVersion} names=${rawNames.length}`);

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
    });
    res.end(`<!doctype html><title>leg ${leg}</title><h1>header-order probe — leg ${leg}</h1>`);
  };

  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const s = createServer(handler);
    s.on('error', (e) => console.error(`bind ${host}: ${e.message}`));
    s.listen(PORT, host, () => console.log(`listening ${host}:${PORT}`));
    servers.push(s);
  }
  console.log(`recording to ${OUT}`);
  process.on('SIGINT', () => {
    for (const s of servers) s.close();
    process.exit(0);
  });
}

// --- diff mode -------------------------------------------------------------

if (diffFlag !== -1) {
  const files = argv.slice(diffFlag + 1).filter((a) => !a.startsWith('--'));
  const recs = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim()) recs.push(JSON.parse(line));
    }
  }
  // One record per leg: the MAIN-FRAME DOCUMENT request for /cap/<leg>/<ms>.
  const legOf = (r) => (/^\/cap\/([A-D])\//.exec(r.url) ?? [, null])[1];
  const byLeg = {};
  for (const r of recs) {
    const leg = legOf(r);
    if (leg && !byLeg[leg]) byLeg[leg] = r;
  }

  const show = (leg) => {
    const r = byLeg[leg];
    if (!r) return console.log(`\nleg ${leg}: NO RECORD — the leg did not run`);
    console.log(`\nleg ${leg}  host=${r.authority}  http/${r.httpVersion}  url=${r.url}`);
    console.log(`  lowerNames: ${JSON.stringify(r.lowerNames)}`);
    console.log(`  rawNames  : ${JSON.stringify(r.rawNames)}`);
    if (Object.keys(r.signatureHeaders).length) {
      console.log(`  signature names as sent: ${JSON.stringify(Object.keys(r.signatureHeaders))}`);
    }
  };
  for (const leg of ['A', 'B', 'C', 'D']) show(leg);

  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cmp = (x, y, field, label) => {
    const a = byLeg[x];
    const b = byLeg[y];
    if (!a || !b) return console.log(`${label}: SKIPPED (missing leg)`);
    const same = eq(a[field], b[field]);
    console.log(`${label}: ${same ? 'IDENTICAL' : 'DIFFER'}`);
    if (!same) {
      console.log(`    ${x}: ${JSON.stringify(a[field])}`);
      console.log(`    ${y}: ${JSON.stringify(b[field])}`);
      const setA = new Set(a[field]);
      const setB = new Set(b[field]);
      const onlyA = a[field].filter((n) => !setB.has(n));
      const onlyB = b[field].filter((n) => !setA.has(n));
      console.log(`    only in ${x}: ${JSON.stringify(onlyA)}`);
      console.log(`    only in ${y}: ${JSON.stringify(onlyB)}`);
      if (onlyA.length === 0 && onlyB.length === 0) {
        console.log('    SAME SET, DIFFERENT ORDER — this is the R2 reading.');
      }
    }
  };

  console.log('\n--- the three comparisons ---');
  cmp('A', 'B', 'lowerNames', 'order   A vs B (lowerNames)  -> R1/R2');
  cmp('A', 'B', 'rawNames', 'casing  A vs B (rawNames)    -> R1/R3');
  cmp('B', 'D', 'lowerNames', 'identity B vs D (lowerNames) -> R4');
  cmp('B', 'D', 'rawNames', 'identity B vs D (rawNames)   -> R4');

  if (byLeg.B && byLeg.C) {
    const setB = new Set(byLeg.B.lowerNames);
    const added = byLeg.C.lowerNames.filter((n) => !setB.has(n));
    console.log(`\nadded in C (lowerNames minus B): ${JSON.stringify(added)}`);
    console.log(`  expected exactly ["signature","signature-input","signature-agent"]`);
    const positions = added.map((n) => `${n}@${byLeg.C.lowerNames.indexOf(n)}`);
    console.log(`  positions in C: ${JSON.stringify(positions)} of ${byLeg.C.lowerNames.length}`);
    console.log(`  casing as sent: ${JSON.stringify(Object.keys(byLeg.C.signatureHeaders))}`);
  }

  console.log(
    '\nCONFOUNDER CHECK: if A and B differ by a name that is NOT a signature ' +
      'header (cookie, accept-encoding, if-none-match, priority, sec-fetch-*), ' +
      'the legs are not comparable and the run is VOID.',
  );
  console.log('BOUND: this is HTTP/1.1 cleartext only. On h2/h3 every name is lowercase by protocol.');
}

if (outFlag === -1 && diffFlag === -1) {
  console.error('usage: --out <file.jsonl>   |   --diff <A.jsonl> <BC.jsonl> <D.jsonl>');
  process.exit(3);
}
