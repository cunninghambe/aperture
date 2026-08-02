/**
 * The page-size sweep — where does observing by DIFF stop paying?
 *
 * WHAT IT MEASURES, AND WHY IT IS NOT THE OBVIOUS THING
 *
 * Wave 1 (`bench/RESULTS.md`) found diffs cut observation bytes 34% and still
 * cost 5.2% MORE in dollars, on fixtures of 1.4-8.0 KB. The tempting reading is
 * "diffs lose below some page size and win above it, by byte arithmetic". That
 * reading is half-inverted, and this harness is built on the corrected one:
 *
 *   With turns held equal, the diff arm is strictly cheaper at EVERY size —
 *   same messages, smaller observations. The scripted (Tier A) numbers below
 *   prove that mechanically, for free, every run. The 5.2% inversion came
 *   entirely from +0.58 extra conversational turns per episode, and turns are
 *   BEHAVIOUR. So the crossover being located is:
 *
 *     the page size at which the diff arm's per-observation saving outgrows the
 *     cost of the extra turns diff-mode behaviour induces, measured with a real
 *     agent, end to end, in dollars.
 *
 * A sweep that only weighed bytes would "find" no crossover and answer nothing.
 * That is why Tier B exists and why it costs money.
 *
 * TWO OUTCOMES, BOTH PUBLISHABLE. Either a crossover band, or "no crossover in
 * the measured range — diffs cheaper everywhere >= s1". The band arithmetic
 * below is written so the second is a first-class result, not a failure, and so
 * is the third possibility (diffs never pay, even at Hacker-News size), which
 * would be product-threatening and is reported in exactly those words.
 *
 * HOW PAGE SIZE IS SEPARATED FROM TASK DIFFICULTY
 *
 * One task (`cart-adjust`), one solve, five fixtures. Everything the agent can
 * ACT on is byte-identical across all five: the task region of the HTML is
 * literally the same bytes, asserted by hash, and the padding below it is
 * headings and prose only. `heading` and text are not in the walker's
 * ADDRESSABLE set (`src/core/snapshot/walker.ts`), so padding contributes zero
 * refs — the agent's decision space does not change, only observation weight.
 * Padding is static, so it appears in zero diffs: the diff arm's observation
 * bytes stay flat across tiers while the re-dump arm's scale. That asymmetry is
 * not a bug, it is the independent variable.
 *
 * NOTHING ABOVE IS TRUSTED. Every clause of it is a preflight (P0-P5), and the
 * sharpest is P5: the scripted diff-arm observation stream at every tier must be
 * BYTE-IDENTICAL to s1's modulo state ids. If that holds, the only thing varying
 * across tiers is full-snapshot weight. If it does not, the fixtures are wrong
 * and the run aborts rather than producing numbers.
 *
 * WHAT THIS IS NOT
 *
 * - Not a cohort. Results are stamped with `codeVersion` for provenance and
 *   appended to `bench/size/results.jsonl`, but there is no integrity guard and
 *   no pooling across runs: this is a cost study, not the preregistered
 *   correctness experiment. `bench/task.mjs` owns that, and this file
 *   deliberately lives outside its watched set (asserted in --dry).
 * - Not a correctness verdict. Success is a VALIDITY GUARD only: if the arms'
 *   success rates at a tier differ by more than 10pp, that tier's cost
 *   comparison is flagged CONFOUNDED and excluded from the band, because a
 *   failing arm's episodes are not the same work.
 * - Not a measurement of the truncation regime (an agent on a page bigger than
 *   its budget). Deliberately excluded: its correctness effects would dominate
 *   its cost effects. Every observation here is issued with budgetTokens 20000
 *   precisely so truncation never happens.
 *
 * USAGE
 *   node bench/size.mjs --make-fixtures   regenerate bench/size/fixtures. No infra.
 *   node bench/size.mjs --dry             wiring self-test. No infra, no budget.
 *   node bench/size.mjs --selftest        P0-P5 + Tier A, live. NO API budget.
 *   node bench/size.mjs --sweep [--n 6]   the above plus Tier B. SPENDS MONEY.
 *
 * EXIT CODES — nonzero must never be read as "roughly green"
 *   0 OK · 3 INFRA · 5 PREFLIGHT FAILED · 7 ENABLER MISSING
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { startCollector, settle, COLLECTOR_PORT } from './lib/collector.mjs';
import { startProxy, PROXY_PORT, ARM_DEFINITION } from './lib/proxy.mjs';
import { mean, meanDiffCI, mulberry32 } from './lib/stats.mjs';
import { buildIdentity, SUITE_VERSION } from './lib/store.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SIZE_DIR = join(ROOT, 'bench', 'size');
const FIXTURE_DIR = join(SIZE_DIR, 'fixtures');
const SOURCE_FIXTURES = join(ROOT, 'bench', 'fixtures');
const MANIFEST = join(FIXTURE_DIR, 'manifest.json');
const RESULTS = join(SIZE_DIR, 'results.jsonl');
const SCRATCH = join(SIZE_DIR, '.agent-cwd');

const FIXTURE_PORT = 8899;
const APERTURE_PORT = 8817;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

export const EXIT = { OK: 0, INFRA: 3, PREFLIGHT: 5, ENABLER: 7 };

/**
 * Every observation in both arms is issued with this budget, injected at the
 * proxy so the agent never sees it and cannot behave differently around it.
 *
 * WHY: without it, `browser_act`'s act-embedded full snapshots in the re-dump
 * arm render under DEFAULT_BUDGET (2000 tokens = 8000 chars) and are truncated
 * from s3 up. G11's own reasoning in the task suite says why that would be
 * fatal here: truncation does not fall equally on the arms, so a truncated
 * re-dump arm would look artificially cheap at exactly the sizes the sweep
 * exists to measure.
 */
const OBS_BUDGET_TOKENS = 20000;

/**
 * Size = chars of the untruncated full snapshot, not file bytes. File bytes are
 * not what the agent pays for.
 *
 * s1 is the measured unpadded baseline (the wave-1 fixture class). s4 and s5
 * are anchored to real pages already measured on this engine, so the curve's
 * right-hand edge is reality rather than an arbitrary blob.
 */
const TIERS = [
  { id: 's1', target: null, anchor: 'unpadded baseline — wave-1 fixture class' },
  { id: 's2', target: 4000, anchor: '' },
  { id: 's3', target: 10000, anchor: '' },
  { id: 's4', target: 21000, anchor: 'GitHub repo page (measured 5,269 tok)' },
  { id: 's5', target: 38000, anchor: 'Hacker News front page (measured 9,519 tok)' },
];

/** Sanity band on the measured s1 baseline. Outside it, the fixture moved. */
const S1_SANITY = [800, 1800];

/** Preflight 1 tolerance on target snapshot chars. */
const SIZE_TOLERANCE = 0.1;

/**
 * The task, copied rather than imported.
 *
 * WHY NOT `import { taskById } from './tasks.mjs'`: item 3 of the tier-1b design
 * retires `cart-adjust` from `TASKS` into a `RETIRED` export, so the import
 * would break the moment that lands. The bytes are cross-checked against
 * bench/tasks.mjs at run time anyway (`checkTaskDrift`) — a WARNING, not an
 * abort, because the scored suite is allowed to move on without this sweep.
 */
const TASK = {
  id: 'cart-adjust',
  fixture: 'cart.html', // per tier: cart-s1.html … cart-s5.html
  prompt:
    "In this shopping cart, change the quantity of the Desk Lamp to 4, and remove the " +
    'Notebook from the cart entirely. Do not change anything else.',
  maxSteps: 12,
  allowed: ['inc:desk-lamp', 'dec:desk-lamp', 'rm:notebook'],
  success: (s) => {
    if (!s || !Array.isArray(s.lines)) return false;
    const by = Object.fromEntries(s.lines.map((l) => [l.name, l.qty]));
    return (
      s.lines.length === 3 &&
      by['Desk Lamp'] === 4 &&
      by['Notebook'] === undefined &&
      by['Blue Widget'] === 1 &&
      by['USB Hub'] === 1
    );
  },
  mustObserve: /Quantity: 4/,
  solve: [
    { act: 'click', label: 'Add one Desk Lamp' },
    { act: 'click', label: 'Add one Desk Lamp' },
    { act: 'click', label: 'Delete Notebook from cart' },
  ],
};

/**
 * Byte-identical to bench/task.mjs's SYSTEM_PROMPT, and asserted so in --dry.
 *
 * Copied because task.mjs runs main() on import and exports nothing but EXIT.
 * The assertion is what keeps the copy honest: if the scored suite's prompt
 * moves, this file says so out loud instead of quietly measuring a different
 * agent.
 */
const SYSTEM_PROMPT = [
  'You are operating a web browser to complete a task for a user.',
  '',
  'You have exactly three tools: browser_act, browser_snapshot and task_done.',
  'There is no filesystem, no shell and no other browser tool. The page is the',
  'only source of truth — nothing about this task can be looked up anywhere else.',
  '',
  'How to work:',
  '- Start by calling browser_snapshot to see the page.',
  '- Act on elements by their ref (the eN codes).',
  '- Read what each action reports back before choosing the next one.',
  '- When the task is genuinely complete, call task_done. Not before.',
  '',
  'Be precise. Acting on the wrong element counts against you, and so does',
  'guessing when you could look.',
].join('\n');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const sha16 = (s) => sha(s).slice(0, 16);
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    makeFixtures: false, dry: false, selftest: false, sweep: false,
    n: 6, model: 'claude-sonnet-5', keepAlive: false, forceBudget: false,
    tiers: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--make-fixtures') out.makeFixtures = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--sweep') out.sweep = true;
    else if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--tiers') out.tiers = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--keep-alive') out.keepAlive = true;
    else if (a === '--force-budget') out.forceBudget = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isInteger(out.n) || out.n < 1) throw new Error(`--n must be a positive integer`);
  return out;
}

// ---------------------------------------------------------------------------
// Fixture generation
//
// Fixtures are GENERATED and CHECKED IN. A run must never depend on
// regeneration — the generator is the audit trail, not a run-time step.
//
// It lives here rather than in its own file for one reason: this sweep's whole
// file ownership is `bench/size.mjs` plus `bench/size/fixtures/**`, and a
// generator that is a mode of the harness cannot drift away from the harness
// that validates its output.
// ---------------------------------------------------------------------------

const GENERATOR_VERSION = '1';

/**
 * The baseline the ladder is built on: measured chars of the s1 full snapshot.
 *
 * Recorded here as a constant so generation is deterministic and offline, and
 * checked against reality by preflight P1 every single run. If cart.html moves,
 * the source hash in the manifest catches it first and demands regeneration.
 */
const BASELINE_CHARS = 1116;

/**
 * The wrapper is `<div role="group">`, and the role attribute is load-bearing
 * rather than decorative. MEASURED, not assumed — the first version used a bare
 * `<div>` and preflight P1 caught it immediately: `renderNode` skips the own
 * line of a `generic` node at depth 0 AND keeps its children at depth 0
 * (`childDepth = depth + (role === 'generic' && depth === 0 ? 0 : 1)`), so every
 * `<p>` — also `generic`, also now at depth 0 — was skipped too. 392 paragraphs
 * of padding rendered as literally nothing, and the s5 fixture measured 3,854
 * chars against a 38,000 target.
 *
 * `group` is not `generic`, so the wrapper renders its own line and indents its
 * children to depth 1, where paragraphs render normally. It is also NOT in the
 * walker's ADDRESSABLE set, so it takes no ref — which is not taken on trust
 * either: P2's ref parity would fail loudly if it did.
 */
const WRAPPER_TAG = '<div role="group">';
/** `group` + newline. */
const WRAPPER_COST = 6;
/** `  h3 "TEXT"` = 2 indent + 2 + 1 + (len + 2 quotes) + newline. */
const HEADING_OVERHEAD = 8;
/** `  generic "TEXT"` = 2 indent + 7 + 1 + (len + 2 quotes) + newline. */
const PARAGRAPH_OVERHEAD = 13;

/** One heading per this many padding units. */
const HEADING_EVERY = 7;

/**
 * Prose length cap. `MAX_TEXT`/`MAX_NAME` are both 80 in the product, and a
 * string at or under that renders verbatim — no ellipsis, no surprise. 76 keeps
 * a margin and keeps every padding line the same predictable width.
 */
const PROSE_LEN = 76;

const NOUN = [
  'station', 'gauge', 'sensor', 'mast', 'buoy', 'transect', 'basin', 'ridge',
  'plateau', 'estuary', 'moor', 'inlet', 'headland', 'valley', 'reservoir',
];
const ADJ = [
  'coastal', 'northern', 'inland', 'upland', 'seasonal', 'nightly', 'quiet',
  'shallow', 'exposed', 'sheltered', 'temperate', 'humid', 'arid', 'lowland',
];
const VERB = [
  'recorded', 'reported', 'logged', 'returned', 'sampled', 'confirmed',
  'registered', 'observed', 'transmitted', 'archived',
];
const TAIL = [
  'steady readings through the window',
  'no variance worth escalating',
  'values inside the agreed tolerance',
  'a slow drift matching the note',
  'figures close to the last quarter',
  'nothing the standing procedure omits',
  'a quiet period with no operator call',
  'measurements the review panel accepted',
];
const TOPIC = [
  'regional survey procedure', 'calibration and drift', 'operator handover',
  'seasonal reporting cycle', 'equipment maintenance', 'data retention policy',
  'field access arrangements', 'reference measurement notes',
];

/**
 * Deterministic prose. Every string is unique (the index is inside it), pure
 * ASCII, free of double quotes and backslashes (which would change the rendered
 * length through `sanitize`'s escaping) and free of every task label.
 */
function paragraphText(i) {
  const rnd = mulberry32(0x5a1e0000 + i);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  let s = `Note ${i}. The ${pick(ADJ)} ${pick(NOUN)} ${pick(VERB)} ${pick(TAIL)}`;
  // Trim to the cap on a WORD boundary. A mid-word cut ("…to the regiona.")
  // reads as a broken fixture to anyone auditing the padding, and the whole
  // point of prose padding is that it is ordinary prose the agent has no reason
  // to treat as anything else. Lengths vary a little as a result; that is fine,
  // because buildPadding prices each string as generated rather than assuming a
  // constant width.
  while (s.length > PROSE_LEN - 1) s = s.slice(0, s.lastIndexOf(' '));
  return `${s.replace(/[ ,]+$/, '')}.`;
}

function headingText(k) {
  const rnd = mulberry32(0x7ea70000 + k);
  const topic = TOPIC[Math.floor(rnd() * TOPIC.length)];
  return `Section ${k}: ${topic}`;
}

/** Chars this padding unit adds to the rendered full snapshot. */
const unitCost = (text, isHeading) =>
  text.length + (isHeading ? HEADING_OVERHEAD : PARAGRAPH_OVERHEAD);

/** Build the padding block for a target snapshot size. */
function buildPadding(targetChars, baselineChars) {
  const units = [];
  let predicted = baselineChars + WRAPPER_COST;
  let headings = 0;
  let paragraphs = 0;
  for (let n = 0; n < 20000; n++) {
    const isHeading = n % HEADING_EVERY === 0;
    const text = isHeading ? headingText(headings + 1) : paragraphText(paragraphs + 1);
    const cost = unitCost(text, isHeading);
    // Stop at whichever side of the target is closer. Overshooting by half a
    // line is as honest as undershooting by half a line; silently always
    // undershooting would bias every tier low.
    if (predicted >= targetChars) break;
    if (predicted + cost > targetChars && targetChars - predicted < predicted + cost - targetChars) break;
    units.push({ tag: isHeading ? 'h3' : 'p', text });
    predicted += cost;
    if (isHeading) headings++;
    else paragraphs++;
  }
  return { units, predicted, headings, paragraphs };
}

const PAD_BEGIN = '    <!-- PAD:BEGIN -->';
const PAD_END = '    <!-- PAD:END -->';

function renderPadBlock(units) {
  const lines = [PAD_BEGIN, `    ${WRAPPER_TAG}`];
  for (const u of units) lines.push(`      <${u.tag}>${u.text}</${u.tag}>`);
  lines.push('    </div>', PAD_END, '');
  return lines.join('\n');
}

/** Everything except the padding block — must be byte-identical across tiers. */
function taskRegionOf(html) {
  const i = html.indexOf(PAD_BEGIN);
  if (i < 0) return html;
  const j = html.indexOf(PAD_END);
  if (j < 0) throw new Error('PAD:BEGIN without PAD:END');
  return html.slice(0, i) + html.slice(j + PAD_END.length + 1);
}

function padUnitsOf(html) {
  const i = html.indexOf(PAD_BEGIN);
  if (i < 0) return [];
  const j = html.indexOf(PAD_END);
  const block = html.slice(i, j);
  const out = [];
  for (const m of block.matchAll(/<(h3|p)>([^<]*)<\/\1>/g)) {
    out.push({ tag: m[1], text: m[2] });
  }
  return out;
}

function makeFixtures() {
  const cartPath = join(SOURCE_FIXTURES, 'cart.html');
  const benchPath = join(SOURCE_FIXTURES, 'bench.js');
  const cart = readFileSync(cartPath, 'utf8');
  const benchJs = readFileSync(benchPath);
  mkdirSync(FIXTURE_DIR, { recursive: true });

  // The witness is copied verbatim. It is the ground truth for both suites and
  // a second, drifting copy of it would be the worst possible bug here.
  writeFileSync(join(FIXTURE_DIR, 'bench.js'), benchJs);

  const closing = cart.lastIndexOf('  </body>');
  if (closing < 0) throw new Error('cart.html has no "  </body>" to insert before');

  const manifest = {
    generator: GENERATOR_VERSION,
    generatedFrom: {
      'bench/fixtures/cart.html': sha16(cart),
      'bench/fixtures/bench.js': sha16(benchJs.toString('utf8')),
    },
    baselineChars: BASELINE_CHARS,
    headingOverhead: HEADING_OVERHEAD,
    paragraphOverhead: PARAGRAPH_OVERHEAD,
    tiers: [],
  };

  const lines = [];
  for (const tier of TIERS) {
    const file = `cart-${tier.id}.html`;
    let html;
    let pad = { units: [], predicted: BASELINE_CHARS, headings: 0, paragraphs: 0 };
    if (tier.target === null) {
      html = cart; // s1 is a byte-identical clone. Nothing is inserted at all.
    } else {
      pad = buildPadding(tier.target, BASELINE_CHARS);
      html = cart.slice(0, closing) + renderPadBlock(pad.units) + cart.slice(closing);
    }
    writeFileSync(join(FIXTURE_DIR, file), html, 'utf8');
    manifest.tiers.push({
      id: tier.id,
      file,
      target: tier.target,
      predictedChars: pad.predicted,
      headings: pad.headings,
      paragraphs: pad.paragraphs,
      htmlBytes: Buffer.byteLength(html, 'utf8'),
      sha: sha16(html),
    });
    lines.push(
      `  ${tier.id}  ${file.padEnd(16)} target ${String(tier.target ?? 'baseline').padStart(8)}  ` +
        `predicted ${String(pad.predicted).padStart(6)} chars  ` +
        `${String(pad.headings).padStart(3)}h/${String(pad.paragraphs).padStart(4)}p  ` +
        `${String(Buffer.byteLength(html, 'utf8')).padStart(6)} html bytes`,
    );
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`fixtures written to ${rel(FIXTURE_DIR)}\n`);
  for (const l of lines) console.log(l);
  console.log(`\nmanifest: ${rel(MANIFEST)}`);
  console.log('predicted chars are ANALYTIC. Preflight P1 measures them live and');
  console.log('aborts the sweep if reality disagrees by more than 10%.');
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// Offline checks — these need no Aperture, no ports and no budget
// ---------------------------------------------------------------------------

/** Tags a padding block may contain. Everything else risks a ref or a role. */
const PAD_ALLOWED_TAGS = new Set(['div', 'h3', 'p']);

/**
 * Roles in `ADDRESSABLE` are reachable through tags this list bans outright.
 * Attributes are banned too: `role`/`aria-*` can manufacture an addressable
 * role from a `<p>`, `data-testid`/`id`/`name` feed the identity key, and
 * `onclick`/`tabindex` make a node interactive (walker `isInteractive`).
 */
const PAD_BANNED_ATTRS = /\s(role|aria-[a-z-]+|data-[a-z-]+|id|name|onclick|tabindex|contenteditable|href|hidden)\s*=/i;

function checkFixturesOffline() {
  const problems = [];
  const notes = [];

  if (!existsSync(MANIFEST)) {
    problems.push(`no manifest at ${rel(MANIFEST)} — run: node bench/size.mjs --make-fixtures`);
    return { problems, notes, manifest: null, files: null };
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  // 1. The generator's inputs must not have moved under it.
  for (const [p, want] of Object.entries(manifest.generatedFrom)) {
    const abs = join(ROOT, p);
    const got = existsSync(abs) ? sha16(readFileSync(abs, 'utf8')) : 'MISSING';
    if (got !== want) {
      problems.push(
        `${p} has changed since the fixtures were generated (${want} -> ${got}). ` +
          'Regenerate: node bench/size.mjs --make-fixtures',
      );
    }
  }

  // 2. bench.js in the sweep's fixture dir must be the same witness the scored
  //    suite uses. Two copies of the ground truth is how one of them goes stale.
  const witness = join(FIXTURE_DIR, 'bench.js');
  if (!existsSync(witness)) problems.push(`${rel(witness)} is missing — the fixtures cannot report state`);
  else if (sha16(readFileSync(witness, 'utf8')) !== sha16(readFileSync(join(SOURCE_FIXTURES, 'bench.js'), 'utf8'))) {
    problems.push(`${rel(witness)} differs from bench/fixtures/bench.js — the witness has drifted`);
  }

  // 3. Files present, hashes as generated.
  const files = {};
  for (const t of manifest.tiers) {
    const abs = join(FIXTURE_DIR, t.file);
    if (!existsSync(abs)) {
      problems.push(`${t.file} is missing`);
      continue;
    }
    const html = readFileSync(abs, 'utf8');
    files[t.id] = html;
    if (sha16(html) !== t.sha) problems.push(`${t.file} does not match its manifest hash — hand-edited?`);
  }

  // 4. THE experimental design: the task region is byte-identical across tiers.
  //    If padding changed task difficulty the whole measurement is worthless,
  //    so this is a hash equality, not a similarity.
  const s1 = files['s1'];
  if (s1 !== undefined) {
    const want = sha(taskRegionOf(s1));
    for (const t of manifest.tiers) {
      const html = files[t.id];
      if (html === undefined) continue;
      if (sha(taskRegionOf(html)) !== want) {
        problems.push(`${t.file}: the TASK REGION is not byte-identical to s1's. The tiers are not the same task.`);
      }
    }
    notes.push(`  task region: ${sha16(taskRegionOf(s1))} — identical in all ${manifest.tiers.length} tiers`);
  }

  // 5. Padding is inert. Asserted, not trusted: the design's whole claim of
  //    "zero refs, zero interactive surface" rests on what is in this block.
  const labels = taskLabelsOf(s1 ?? '');
  let totalUnits = 0;
  for (const t of manifest.tiers) {
    const html = files[t.id];
    if (html === undefined) continue;
    // Uniqueness is a WITHIN-fixture property: two identical strings in one
    // page collide on the identity key and get positional `|#n` ordinals. The
    // tiers deliberately share prefixes with each other, which is what makes
    // the ladder nested rather than five unrelated pages.
    const seen = new Set();
    const i = html.indexOf(PAD_BEGIN);
    if (t.target === null) {
      if (i >= 0) problems.push('s1 must be an unpadded, byte-identical clone of cart.html');
      notes.push(`  ${t.id}  ${t.file.padEnd(16)}   0h/   0p  predicted ${String(t.predictedChars).padStart(6)} chars (unpadded baseline)  ${t.htmlBytes} html bytes`);
      continue;
    }
    if (i < 0) {
      problems.push(`${t.file}: no padding block found`);
      continue;
    }
    const block = html.slice(i, html.indexOf(PAD_END));
    for (const m of block.matchAll(/<\s*([a-zA-Z0-9]+)/g)) {
      if (!PAD_ALLOWED_TAGS.has(m[1].toLowerCase())) {
        problems.push(`${t.file}: padding contains <${m[1]}> — only div/h3/p are inert here`);
      }
    }
    // The wrapper's `role="group"` is the ONE permitted attribute in the whole
    // block (see WRAPPER_TAG for why it is there). It is excised before every
    // content check runs, so the checks still cover everything else — including
    // a second `role=`, or a quote, anywhere in the padding.
    if (block.split(WRAPPER_TAG).length !== 2) {
      problems.push(`${t.file}: expected exactly one ${WRAPPER_TAG} wrapper in the padding block`);
    }
    const body = block.split(WRAPPER_TAG).join('<div>');
    if (PAD_BANNED_ATTRS.test(body)) {
      problems.push(`${t.file}: padding carries an attribute that can create a role, an identity key or a handler`);
    }
    if (/[^\x00-\x7F]/.test(body)) problems.push(`${t.file}: padding contains non-ASCII text`);
    if (/["\\]/.test(body)) problems.push(`${t.file}: padding contains a quote or backslash (renders at a different width)`);

    const units = padUnitsOf(html);
    if (units.length !== t.headings + t.paragraphs) {
      problems.push(`${t.file}: ${units.length} padding elements parsed, manifest says ${t.headings + t.paragraphs}`);
    }
    const padText = units.map((u) => u.text).join(' ');
    if (padText.length <= 200) {
      // Under 200 chars the wrapper div would inherit its own textContent as an
      // accessible name (walker `accessibleName`) and render an extra line.
      problems.push(`${t.file}: padding text is only ${padText.length} chars — the wrapper would acquire a name`);
    }
    for (const u of units) {
      if (seen.has(u.text)) problems.push(`${t.file}: duplicate padding string "${u.text.slice(0, 40)}…" — identity keys would collide`);
      seen.add(u.text);
      for (const lab of labels) {
        if (lab.length >= 6 && u.text.includes(lab)) {
          problems.push(`${t.file}: padding text repeats a task label (${JSON.stringify(lab)})`);
        }
      }
      if (TASK.mustObserve.test(u.text)) {
        problems.push(`${t.file}: padding text matches mustObserve ${TASK.mustObserve} — the guard would pass vacuously`);
      }
      if (u.text.includes('$')) problems.push(`${t.file}: padding text contains a price-shaped token`);
    }
    totalUnits += units.length;
    notes.push(
      `  ${t.id}  ${t.file.padEnd(16)} ${String(t.headings).padStart(3)}h/${String(t.paragraphs).padStart(4)}p  ` +
        `predicted ${String(t.predictedChars).padStart(6)} chars (target ${t.target})  ${t.htmlBytes} html bytes`,
    );
  }
  notes.push(`  ${totalUnits} padding elements across the ladder, every string unique`);

  return { problems, notes, manifest, files };
}

/** Accessible names the fixture's own markup produces, for the label ban. */
function taskLabelsOf(html) {
  const out = new Set();
  for (const m of html.matchAll(/'([A-Z][^']{4,60})'/g)) out.add(m[1]);
  for (const m of html.matchAll(/>([A-Z][^<>{}]{4,60})</g)) out.add(m[1].trim());
  for (const name of ['Blue Widget', 'Desk Lamp', 'Notebook', 'USB Hub', 'Quantity', 'Your cart', 'Total']) {
    out.add(name);
  }
  return [...out];
}

/** The sweep must not be able to touch the scored suite's cohort. */
function checkUnwatched() {
  const identity = buildIdentity({
    root: ROOT,
    model: 'claude-sonnet-5',
    systemPrompt: SYSTEM_PROMPT,
    tasks: [TASK],
    verdictRule: {},
  });
  const leaked = identity.files.filter((f) => f.path.startsWith('bench/size'));
  return { identity, leaked };
}

/** The copied system prompt must still be the scored suite's system prompt. */
function checkPromptDrift() {
  const src = readFileSync(join(ROOT, 'bench', 'task.mjs'), 'utf8');
  const missing = SYSTEM_PROMPT.split('\n').filter((l) => l && !src.includes(l));
  return missing;
}

/** The task bytes should still match bench/tasks.mjs, but need not. */
function checkTaskDrift() {
  const src = readFileSync(join(ROOT, 'bench', 'tasks.mjs'), 'utf8');
  const warn = [];
  if (!src.includes("id: 'cart-adjust'")) {
    warn.push('bench/tasks.mjs no longer defines cart-adjust (expected once item 3 retires it)');
  }
  for (const frag of ['change the quantity of the Desk Lamp to 4', 'Do not change anything else.']) {
    if (!src.includes(frag)) warn.push(`the cart-adjust prompt fragment ${JSON.stringify(frag.slice(0, 30))} is no longer in bench/tasks.mjs`);
  }
  return warn;
}

// ---------------------------------------------------------------------------
// Infrastructure the sweep owns end to end
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = join(FIXTURE_DIR, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURE_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store, no-cache, must-revalidate',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(FIXTURE_PORT, '127.0.0.1', ok);
  });
  return { close: () => new Promise((r) => server.close(() => r())) };
}

async function portIsOpen(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(700) });
    return true;
  } catch (e) {
    return !/ECONNREFUSED|refused/i.test(String(e?.cause?.code ?? e?.message ?? ''));
  }
}

function readApertureToken() {
  const p = join(process.env.APPDATA ?? '', 'aperture', 'mcp.json');
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    return (cfg?.mcpServers?.aperture?.headers?.Authorization ?? '').replace(/^Bearer /, '') || null;
  } catch {
    return null;
  }
}

async function apertureToolList(token) {
  const res = await fetch(`http://127.0.0.1:${APERTURE_PORT}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.text();
  const line = body.split('\n').find((l) => l.trim().startsWith('{') || l.startsWith('data: {'));
  if (!line) return [];
  return JSON.parse(line.replace(/^data: /, '')).result?.tools ?? [];
}

async function startAperture() {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js is missing — run `npx electron-vite build` first');
  }
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const token = readApertureToken();
    if (token) {
      const tools = await apertureToolList(token).catch(() => []);
      if (tools.some((t) => t.name === 'browser_act')) return { child, token, tools, log: () => log };
    }
  }
  throw new Error(`Aperture did not come up on ${APERTURE_PORT} within 60s.\n${log.slice(-2000)}`);
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((done) => {
    try {
      if (process.platform !== 'win32') {
        child.kill('SIGTERM');
        done();
        return;
      }
      const t = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      t.on('exit', done);
      t.on('error', done);
      setTimeout(done, 10000).unref();
    } catch {
      done();
    }
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await portIsOpen(APERTURE_PORT))) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(
    `\nWARNING: Aperture is STILL listening on ${APERTURE_PORT} after teardown.\n` +
      '         Run: taskkill //F //IM electron.exe',
  );
}

// ---------------------------------------------------------------------------
// Episode machinery
// ---------------------------------------------------------------------------

const CLICK_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'slider']);
const TYPE_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * The scripted solver resolves against the SHADOW MODEL, never against
 * hardcoded refs — same rule as bench/task.mjs and bench/fidelity.mjs. A stream
 * that fails to deliver a label update cannot even be scripted through, so the
 * preflight fails loudly instead of quietly measuring nothing.
 */
function resolveLabel(model, step) {
  const roles = step.act === 'type' || step.act === 'clear' ? TYPE_ROLES : CLICK_ROLES;
  const hits = [...model.entries()].filter(([, e]) => e.label === step.label && roles.has(e.role));
  if (hits.length === 1) return { ref: hits[0][0] };
  return {
    error:
      `"${step.label}" resolves to ${hits.length} elements in the model (need exactly 1). Model holds:\n` +
      [...model.entries()].map(([r, e]) => `    ${r} ${e.role} "${e.label}"`).join('\n'),
  };
}

async function waitForLoad(collector, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (collector.loaded()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function navigate(proxy, fixture) {
  await proxy.upstream('browser_navigate', {
    action: 'goto',
    url: `${BASE}/${fixture}?benchrun=${Date.now()}`,
  });
}

/**
 * The observation-weighted conversation model.
 *
 * Every turn re-sends the system prefix plus the whole history, so what a run
 * actually pays for is the TRIANGULAR sum of message sizes, not their plain
 * sum. This function makes that explicit and measurable from the observation
 * stream alone; it is the regressor the Tier B cost model is fitted on, and the
 * quantity Tier A reports as the pure mechanism curve.
 *
 * P (the prefix) is the system prompt plus the tool surface the agent is shown.
 * It is measured, not guessed; the fitted model re-estimates it and the two are
 * printed side by side so a large disagreement is visible rather than hidden.
 */
const TOOL_USE_CHARS = 80; // one assistant tool_use block: name + small JSON args

function conversationInputChars(observationChars, prefixChars, promptChars) {
  let history = promptChars;
  let total = 0;
  for (const obs of observationChars) {
    total += prefixChars + history; // the turn that issues this call
    history += TOOL_USE_CHARS + obs;
  }
  total += prefixChars + history; // the final turn (task_done)
  return { convInputChars: total, turns: observationChars.length + 1, historyEnd: history };
}

async function runEpisode({ proxy, collector, tier, arm, driver, runIndex }) {
  collector.reset();
  const ep = proxy.newEpisode({
    arm,
    maxSteps: TASK.maxSteps,
    allowed: TASK.allowed,
    taskId: `${TASK.id}@${tier.id}`,
    // The product enabler. Spread into every forwarded act and snapshot by the
    // proxy so BOTH arms observe at the same budget and neither is truncated.
    inject: { budgetTokens: OBS_BUDGET_TOKENS },
  });
  await navigate(proxy, tier.file);
  const loaded = await waitForLoad(collector);

  const t0 = Date.now();
  let driverError = null;
  let sdk = null;
  try {
    sdk = await driver(ep);
  } catch (e) {
    driverError = e instanceof Error ? e.message : String(e);
  }
  await settle(collector, 300, 4000);

  const state = collector.lastState();
  const actions = collector.actions();
  let success = false;
  try {
    success = TASK.success(state) === true;
  } catch {
    success = false;
  }
  const wrongElement = actions.filter((a) => !TASK.allowed.includes(a.detail?.bench)).length;

  const kinds = { full: 0, diff: 0, nochange: 0, other: 0 };
  for (const o of ep.observations) kinds[o.kind]++;
  const obsCharSeq = ep.observations.map((o) => o.chars);
  const conv = conversationInputChars(obsCharSeq, PREFIX_CHARS, TASK.prompt.length);

  return {
    tier: tier.id,
    tierChars: tier.measuredChars ?? null,
    arm,
    runIndex,
    loaded,
    success,
    wrongElement,
    pageActions: actions.length,
    steps: ep.steps,
    capHits: ep.capHits,
    declaredDone: ep.done,
    driverError,
    kinds,
    truncatedObs: ep.observations.filter((o) => o.truncated).length,
    obsChars: obsCharSeq.reduce((a, b) => a + b, 0),
    obsCharSeq,
    obsSeq: ep.observations.map((o) => (o.tool === 'browser_act' ? 'a' : 's') + ':' + o.kind),
    // Voluntary = every observation that was not the initial snapshot and not
    // embedded in an act. This is the behavioural quantity the whole reframing
    // turns on, so it is computed here rather than inferred later.
    voluntaryObs: Math.max(0, ep.observations.length - actions.length - 1),
    convInputChars: conv.convInputChars,
    modelTurns: conv.turns,
    attributions: Object.fromEntries(
      Object.entries(ep.acts.reduce((a, x) => ((a[x.attribution] = (a[x.attribution] ?? 0) + 1), a), {})),
    ),
    diffStream: ep.observations.filter((o) => o.kind === 'diff' || o.kind === 'nochange').map((o) => o.text).join('\n'),
    fullSnapshotChars: ep.observations.filter((o) => o.kind === 'full').reduce((a, o) => a + o.chars, 0),
    costUsd: sdk?.costUsd ?? 0,
    sdkTurns: sdk?.turns ?? 0,
    sdkSubtype: sdk?.subtype ?? null,
    durationMs: Date.now() - t0,
  };
}

function scriptedDriver(proxy) {
  return async () => {
    await proxy.direct.snapshot({ mode: 'full', budgetTokens: OBS_BUDGET_TOKENS });
    for (const step of TASK.solve) {
      const r = resolveLabel(proxy.episode().model, step);
      if (r.error) throw new Error(`step ${step.act} "${step.label}": ${r.error}`);
      // budgetTokens is passed at the call site AS WELL as through the proxy's
      // `inject`. Identical value, so double injection is a no-op — but it keeps
      // Tier A runnable while only the product half of the enabler has landed.
      const args = { action: step.act, ref: r.ref, budgetTokens: OBS_BUDGET_TOKENS };
      if (step.act === 'type') args.text = step.text;
      const out = await proxy.direct.act(args);
      if (/^error:/m.test(out)) throw new Error(`step ${step.act} "${step.label}" errored: ${out.slice(0, 200)}`);
    }
    proxy.direct.done('scripted solver');
    return null;
  };
}

/**
 * The real agent. Same sealed surface as bench/task.mjs's runner, deliberately:
 * no filesystem tools at all. An agent that could Read() would find the fixture
 * HTML on disk and bypass observation entirely — which is the exact reason the
 * original design refused an unsealed runner, and it would make every number
 * below meaningless.
 */
function agentDriver(proxy, opts) {
  return async () => {
    if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
    writeFileSync(join(SCRATCH, '.gitignore'), '*\n');

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // measured: the SDK uses Claude Code's own auth

    const q = query({
      prompt: TASK.prompt,
      options: {
        model: opts.model,
        systemPrompt: SYSTEM_PROMPT, // plain string = full replacement
        settingSources: [], // no CLAUDE.md, no project memory
        allowedTools: [
          'mcp__aperture__browser_act',
          'mcp__aperture__browser_snapshot',
          'mcp__aperture__task_done',
        ],
        disallowedTools: [
          'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch',
          'WebSearch', 'NotebookEdit', 'TodoWrite', 'Task',
        ],
        permissionMode: 'dontAsk',
        maxTurns: TASK.maxSteps + 6,
        cwd: SCRATCH,
        env,
        mcpServers: {
          aperture: {
            type: 'http',
            url: proxy.url,
            headers: { Authorization: `Bearer ${proxy.token}` },
          },
        },
      },
    });

    let result = null;
    for await (const m of q) {
      if (m.type === 'result') result = m;
    }
    return {
      costUsd: result?.total_cost_usd ?? 0,
      turns: result?.num_turns ?? 0,
      subtype: result?.subtype ?? null,
    };
  };
}

/** Set once the proxy is up: system prompt + the exact tool bytes shown. */
let PREFIX_CHARS = SYSTEM_PROMPT.length;

// ---------------------------------------------------------------------------
// Preflight — free, and the run does not start without it
// ---------------------------------------------------------------------------

/** Element lines, as `eN -> role "label"`. Ref parity is checked over this. */
function refMapOf(snapshot) {
  const map = new Map();
  for (const line of snapshot.split('\n')) {
    const m = /^\s*(\w+) (e\d+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
    if (m) map.set(m[2], `${m[1]} ${m[3] ?? ''}`);
  }
  return map;
}

/**
 * State ids and the envelope nonce are the only things allowed to differ
 * between tiers. Both are per-response randomness, not page content:
 * `#E.S` names a snapshot state, and `id=<8 hex>` is the untrusted-content
 * envelope's per-call nonce (`src/mcp/envelope.ts`). Everything else — every
 * ref, every op, every quoted byte of page text — must match exactly, and P5
 * is worthless if this normaliser erases one character more than these two.
 */
const normaliseStream = (s) =>
  s.replace(/#\d+\.\d+/g, '#E.S').replace(/\bid=[0-9a-f]{8}\b/g, 'id=NONCE');

const COLLAPSE_MARKER = /… \d+ more \w+/;

/**
 * What a P0 probe result means, as a pure function of the two halves.
 *
 * Split out from `preflight` so the branch that decides whether the sweep is
 * ALLOWED TO SPEND MONEY is testable without an Aperture and without spending
 * any: `--dry` exercises all four combinations. A budget guard that can only be
 * checked by running the thing it guards is not a guard.
 */
export function p0Verdict({ productOk, proxyOk, needInject }) {
  const problems = [];
  const notes = [];
  if (!productOk) {
    problems.push(
      'P0 — browser_act has no `budgetTokens` parameter. The re-dump arm\'s act-embedded full ' +
        'snapshots would render under DEFAULT_BUDGET (2000 tokens = 8000 chars) and be TRUNCATED ' +
        'from s3 up, which is the exact unfairness G11 exists to refuse. This is the product ' +
        'enabler named in tier1b.md §2 and it is not this harness\'s to add.',
    );
    return { problems, notes, fatal: true };
  }
  if (!proxyOk) {
    const msg =
      'P0 — bench/lib/proxy.mjs\'s newEpisode() does not inject `budgetTokens` into forwarded ' +
      'calls, so the budget cannot reach the AGENT-driven arm: every re-dump observation Tier B ' +
      'makes above ~8000 chars would be truncated. Tier A injects at the call site and is ' +
      'unaffected. Named in tier1b.md §2 alongside the browser_act change, and not this ' +
      'harness\'s to add.';
    if (needInject) return { problems: [msg], notes, fatal: true };
    notes.push(`  WARNING: ${msg}\n           Tier A below is unaffected; --sweep will refuse until it lands.`);
  }
  return { problems, notes, fatal: false };
}

async function preflight({ proxy, collector, tiers, apertureTools, needInject }) {
  const problems = [];
  const notes = [];

  // ---- P0: the enabler ----------------------------------------------------
  //
  // Two halves, and they fail differently, so they are probed separately: the
  // product half (browser_act must accept budgetTokens) and the harness half
  // (the proxy must inject it into every forwarded call). Without both, the
  // re-dump arm is truncated from s3 up and every number the sweep prints is a
  // measurement of truncation.
  const actTool = apertureTools.find((t) => t.name === 'browser_act');
  const actProps = actTool?.inputSchema?.properties ?? {};
  const productOk = Object.prototype.hasOwnProperty.call(actProps, 'budgetTokens');
  notes.push(`  browser_act budgetTokens (src/mcp/tools.ts) : ${productOk ? 'present' : 'MISSING'}`);
  if (!productOk) {
    const v = p0Verdict({ productOk, proxyOk: false, needInject });
    return { problems: v.problems, notes };
  }

  // The proxy half is probed FUNCTIONALLY wherever the ladder allows it — by
  // asking for an observation with no explicit budget on a page that does not
  // fit in DEFAULT_BUDGET, and seeing whether it comes back truncated. A
  // structural probe (does `ep.inject` exist?) would pass or fail on how the
  // sibling change happens to be spelled rather than on whether it works.
  const big = [...tiers].reverse().find((t) => (t.predictedChars ?? 0) > 9000);
  const structural = proxy.newEpisode({
    arm: 'redump', maxSteps: 4, allowed: [], taskId: 'p0-probe',
    inject: { budgetTokens: OBS_BUDGET_TOKENS },
  }).inject !== undefined;
  let proxyOk = structural;
  let how = structural ? 'structural (ep.inject present)' : 'structural probe found no ep.inject';
  if (big) {
    collector.reset();
    proxy.newEpisode({
      arm: 'redump', maxSteps: 4, allowed: [], taskId: 'p0-probe',
      inject: { budgetTokens: OBS_BUDGET_TOKENS },
    });
    await navigate(proxy, big.file);
    await waitForLoad(collector);
    const probe = await proxy.direct.snapshot({ mode: 'auto' }); // no explicit budget
    proxyOk = !/more lines beyond budget/.test(probe);
    how = `functional on ${big.id} (${probe.length} chars, ${proxyOk ? 'untruncated' : 'TRUNCATED at DEFAULT_BUDGET'})`;
  }
  notes.push(`  proxy newEpisode inject (bench/lib/proxy.mjs): ${proxyOk ? 'present' : 'MISSING'} — ${how}`);
  const v = p0Verdict({ productOk, proxyOk, needInject });
  problems.push(...v.problems);
  notes.push(...v.notes);
  if (problems.length) return { problems, notes };

  // ---- P1..P3: one clean pass, BEFORE anything acts on any page -----------
  //
  // Two passes, not one, and the reason is a bug this file already shipped: the
  // ref registry is per-tab and outlives a navigation, so a scripted solve at s1
  // allocates refs for the rows it re-renders, and those refs then reattach when
  // s2 loads. Interleaving P4 with P2 therefore made P2 report eight phantom
  // "padding added refs" differences that were nothing but s1's own history.
  // Ref parity is only meaningful measured off pages that have only been loaded.
  let s1Refs = null;
  let s1Stream = null;
  const refCounts = {};

  for (const tier of tiers) {
    // -- P1: size, no truncation, no collapse, every padding line present ----
    collector.reset();
    proxy.newEpisode({ arm: 'diff', maxSteps: 4, allowed: TASK.allowed, taskId: `${TASK.id}@${tier.id}`, inject: { budgetTokens: OBS_BUDGET_TOKENS } });
    await navigate(proxy, tier.file);
    if (!(await waitForLoad(collector))) {
      problems.push(`${tier.id}: the fixture never reported to the collector — the witness is silent`);
      continue;
    }
    const snap = await proxy.direct.snapshot({ mode: 'full', budgetTokens: OBS_BUDGET_TOKENS });
    tier.measuredChars = snap.length;

    if (/more lines beyond budget/.test(snap)) {
      problems.push(`P1 — ${tier.id}: the full snapshot is budget-truncated even at ${OBS_BUDGET_TOKENS} tokens`);
    }
    if (COLLAPSE_MARKER.test(snap)) {
      problems.push(
        `P1 — ${tier.id}: the snapshot contains a run-collapse marker (${(snap.match(COLLAPSE_MARKER) ?? [''])[0]}). ` +
          'Collapse would eat padding unequally across tiers and the size axis would not mean what it says.',
      );
    }
    if (tier.target === null) {
      if (snap.length < S1_SANITY[0] || snap.length > S1_SANITY[1]) {
        problems.push(`P1 — s1 baseline is ${snap.length} chars, outside the sanity band ${S1_SANITY.join('-')}. cart.html has moved.`);
      }
    } else {
      const lo = tier.target * (1 - SIZE_TOLERANCE);
      const hi = tier.target * (1 + SIZE_TOLERANCE);
      if (snap.length < lo || snap.length > hi) {
        problems.push(
          `P1 — ${tier.id}: full snapshot is ${snap.length} chars, target ${tier.target} ` +
            `(allowed ${Math.round(lo)}-${Math.round(hi)}). Regenerate with BASELINE_CHARS = <measured s1>.`,
        );
      }
      // Every generated padding string must appear as its own rendered line,
      // verbatim. This is what actually proves nothing collapsed, nothing was
      // elided, and no prose was truncated by MAX_TEXT.
      const html = readFileSync(join(FIXTURE_DIR, tier.file), 'utf8');
      const units = padUnitsOf(html);
      const lines = new Set(snap.split('\n'));
      let missing = 0;
      let firstMissing = null;
      for (const u of units) {
        const want = u.tag === 'h3' ? `  h3 "${u.text}"` : `  generic "${u.text}"`;
        if (!lines.has(want)) {
          missing++;
          if (!firstMissing) firstMissing = want;
        }
      }
      if (missing) {
        problems.push(
          `P1 — ${tier.id}: ${missing}/${units.length} padding elements did not render as their own line. ` +
            `First missing: ${JSON.stringify(firstMissing)}. Padding is not inert on this walker.`,
        );
      }
    }

    // -- P2: ref parity -----------------------------------------------------
    const refs = refMapOf(snap);
    if (tier.target === null) {
      s1Refs = refs;
    } else if (s1Refs) {
      const differ = [];
      for (const [ref, desc] of s1Refs) {
        if (refs.get(ref) !== desc) differ.push(`${ref}: s1 ${JSON.stringify(desc)} vs ${tier.id} ${JSON.stringify(refs.get(ref) ?? null)}`);
      }
      for (const ref of refs.keys()) if (!s1Refs.has(ref)) differ.push(`${ref}: present at ${tier.id}, absent at s1`);
      if (differ.length) {
        problems.push(
          `P2 — ${tier.id}: ref parity broken (${differ.length} difference(s)). Padding changed the agent's ` +
            `decision space, so the tiers are not the same task.\n    ${differ.slice(0, 6).join('\n    ')}`,
        );
      }
    }

    // -- P3: G1, the null agent ---------------------------------------------
    let passesUntouched = false;
    try {
      passesUntouched = TASK.success(collector.lastState()) === true;
    } catch (e) {
      problems.push(`P3 — ${tier.id}: the predicate threw on the untouched page: ${e.message}`);
    }
    if (passesUntouched) {
      problems.push(`P3 — ${tier.id}: SUCCEEDS ON AN UNTOUCHED PAGE. The predicate does not measure the task.`);
    }
    refCounts[tier.id] = refs.size;
  }

  // A broken ladder makes P4/P5 meaningless and expensive to read, so stop here.
  if (problems.length) return { problems, notes };

  // ---- P4/P5: the scripted solve, per tier, per arm -----------------------
  //
  // One discarded warm-up episode first, and it is not a convenience.
  //
  // MEASURED: the ref registry outlives a navigation, and the FIRST episode to
  // act on the cart in a given Aperture sees a different stream from every one
  // after it — the total line has never been emitted, so its change arrives as
  // `(1 changes in regions you have not read)` instead of as a `~ eN` op. Run
  // cold, P5 reported that first-touch difference at every tier as "padding is
  // leaking into diffs", which it was not: s2, s3, s4 and s5 were byte-identical
  // to each other and only s1 — the tier that happened to go first — differed.
  //
  // The warm-up puts every tier on the same side of that transition, so what P5
  // can still see is padding and nothing else. If one episode does not saturate
  // the registry, P5 fails and says so; it is not silenced anywhere.
  await runEpisode({ proxy, collector, tier: tiers[0], arm: 'diff', runIndex: -1, driver: scriptedDriver(proxy) });

  for (const tier of tiers) {
    const scripted = {};
    for (const arm of ['diff', 'redump']) {
      const r = await runEpisode({ proxy, collector, tier, arm, runIndex: 0, driver: scriptedDriver(proxy) });
      scripted[arm] = r;
      if (r.driverError) {
        problems.push(`P4 — ${tier.id} [${arm}]: the scripted solver could not run: ${r.driverError}`);
        continue;
      }
      if (!r.success) {
        problems.push(`P4 — ${tier.id} [${arm}]: the scripted solver did NOT satisfy the predicate. State: ${JSON.stringify(collector.lastState())}`);
      }
      if (r.pageActions !== TASK.solve.length) {
        problems.push(`P4 — ${tier.id} [${arm}]: solver performed ${TASK.solve.length} actions, witness counted ${r.pageActions}. The apparatus is miscounting.`);
      }
      if (r.wrongElement > 0) {
        problems.push(`P4 — ${tier.id} [${arm}]: solver touched ${r.wrongElement} element(s) outside the allowed set`);
      }
      if (r.truncatedObs > 0) {
        problems.push(`P4 — ${tier.id} [${arm}]: ${r.truncatedObs} observation(s) were cut by the token budget. Truncation does not fall equally on the arms.`);
      }
      if (arm === 'diff') {
        if (!TASK.mustObserve.test(r.diffStream)) {
          problems.push(
            `P4 — ${tier.id}: mustObserve ${TASK.mustObserve} does NOT match the diff-only stream.\n` +
              '    ---- diff-only stream ----\n' +
              r.diffStream.split('\n').map((l) => '    ' + l).join('\n').slice(0, 2000),
          );
        }
        if (r.kinds.diff === 0) problems.push(`P4 — ${tier.id}: the diff arm produced no diffs at all.`);
      }
      if (arm === 'redump' && (r.kinds.diff > 0 || r.kinds.nochange > 0)) {
        problems.push(`P4 — ${tier.id}: the re-dump arm received ${r.kinds.diff + r.kinds.nochange} diff-shaped observation(s). The arms are not what they claim to be.`);
      }
    }
    const d = scripted.diff;
    const u = scripted.redump;
    if (d && u && d.obsChars >= u.obsChars) {
      problems.push(`P4 — ${tier.id}: identical scripted work observed ${d.obsChars} chars in the diff arm and ${u.obsChars} in the re-dump arm. The cheaper arm is not the diff arm.`);
    }

    // -- P5: diff-stream byte-invariance ------------------------------------
    //
    // THE sharpest check in the design. The padding is static, so it must appear
    // in exactly zero diffs; if the diff-arm stream is byte-identical across
    // tiers modulo state ids, the ONLY thing varying is full-snapshot weight,
    // and every dollar difference the sweep measures is attributable to that.
    if (d) {
      const norm = normaliseStream(d.diffStream);
      if (tier.target === null) {
        s1Stream = norm;
      } else if (s1Stream !== null && norm !== s1Stream) {
        const a = s1Stream.split('\n');
        const b = norm.split('\n');
        const k = a.findIndex((l, i) => l !== b[i]);
        problems.push(
          `P5 — ${tier.id}: the scripted diff stream is NOT byte-identical to ${tiers[0].id}'s. Padding is ` +
            `leaking into diffs, so the fixtures are wrong.\n    first difference at line ${k + 1}:\n` +
            `    ${tiers[0].id}: ${JSON.stringify(a[k] ?? null)}\n    ${tier.id}: ${JSON.stringify(b[k] ?? null)}\n` +
            `    ---- ${tiers[0].id} stream (normalised) ----\n` +
            a.map((l) => '    ' + l).join('\n').slice(0, 1200) +
            `\n    ---- ${tier.id} stream (normalised) ----\n` +
            b.map((l) => '    ' + l).join('\n').slice(0, 1200),
        );
      }
    }

    tier.scripted = scripted;
    notes.push(
      `  ${tier.id}  ${String(tier.measuredChars).padStart(6)} chars` +
        (tier.target ? ` (target ${String(tier.target).padStart(5)}, ${((tier.measuredChars / tier.target - 1) * 100).toFixed(1)}%)` : ' (baseline)') +
        `  refs ${refCounts[tier.id]}` +
        (d && u ? `  scripted obs ${String(d.obsChars).padStart(6)}D / ${String(u.obsChars).padStart(6)}R = ${(d.obsChars / u.obsChars).toFixed(2)}x` : ''),
    );
  }

  return { problems, notes };
}

// ---------------------------------------------------------------------------
// Tier A — mechanism. Scripted, deterministic, no API budget.
// ---------------------------------------------------------------------------

function tierATable(tiers) {
  const rows = [];
  console.log('\nTIER A — mechanism (scripted solver, identical work in both arms, no dollars claimed)');
  console.log('');
  console.log('  Both arms open every episode with one full snapshot — the agent has to see the page');
  console.log('  before it can act — so that snapshot scales with page size in BOTH arms and is shown');
  console.log('  separately. What the diff arm buys is everything AFTER it.');
  console.log('');
  console.log('  tier   snapshot   obs D total   of which full   diffs only   obs R total   D/R    conv-in D/R');
  console.log('  ' + '-'.repeat(98));
  for (const t of tiers) {
    const d = t.scripted?.diff;
    const u = t.scripted?.redump;
    if (!d || !u) continue;
    const row = {
      tier: t.id,
      snapshotChars: t.measuredChars,
      obsCharsDiff: d.obsChars,
      initialFullChars: d.fullSnapshotChars,
      diffOnlyChars: d.obsChars - d.fullSnapshotChars,
      obsCharsRedump: u.obsChars,
      obsRatio: d.obsChars / u.obsChars,
      convDiff: d.convInputChars,
      convRedump: u.convInputChars,
      convRatio: d.convInputChars / u.convInputChars,
      turns: d.modelTurns,
    };
    rows.push(row);
    console.log(
      `  ${row.tier.padEnd(5)} ${String(row.snapshotChars).padStart(8)}   ` +
        `${String(row.obsCharsDiff).padStart(11)}   ${String(row.initialFullChars).padStart(13)}   ` +
        `${String(row.diffOnlyChars).padStart(10)}   ${String(row.obsCharsRedump).padStart(11)}  ` +
        `${row.obsRatio.toFixed(2)}x   ${row.convRatio.toFixed(2)}x`,
    );
  }

  // Acceptance 2: diff-arm observation chars flat (+/-10%) across tiers while
  // the re-dump arm's scale with snapshot size.
  //
  // "Flat" is asserted on the DIFFS, not on the arm's total. Measured, and the
  // distinction is the whole mechanism: the diff arm's total grows almost
  // exactly one full snapshot's worth across the ladder (s1 2,171 -> s5 39,136
  // chars) because of the mandatory opening snapshot, while the diffs behind it
  // move 1,055 -> 1,062. Asserting flatness on the total would fail here for a
  // reason that is not a defect, and would have to be relaxed into uselessness.
  const problems = [];
  if (rows.length >= 2) {
    const ds = rows.map((r) => r.diffOnlyChars);
    const flat = (Math.max(...ds) - Math.min(...ds)) / mean(ds);
    console.log(
      `\n  diff bytes (excluding the opening full snapshot) vary by ${(flat * 100).toFixed(1)}% across the ` +
        `ladder — ${Math.min(...ds)} to ${Math.max(...ds)} chars (must be <= 10%)`,
    );
    if (flat > 0.1) {
      problems.push(
        `TIER A — diff bytes vary ${(flat * 100).toFixed(1)}% across tiers. They should be flat: the ` +
          'padding never changes, so it should never appear in a diff.',
      );
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    const sizeGrowth = last.snapshotChars / first.snapshotChars;
    const redumpGrowth = last.obsCharsRedump / first.obsCharsRedump;
    console.log(
      `  re-dump observation chars grew ${redumpGrowth.toFixed(1)}x while snapshot size grew ${sizeGrowth.toFixed(1)}x ` +
        `(must be >= 0.9x linear)`,
    );
    if (redumpGrowth < 0.9 * sizeGrowth) {
      problems.push(
        `TIER A — re-dump observation chars grew only ${redumpGrowth.toFixed(2)}x against a ${sizeGrowth.toFixed(2)}x ` +
          'size increase. Something is suppressing the re-dump weight the sweep is supposed to be varying.',
      );
    }
  }
  console.log(
    '\n  Read this as the equal-turn bound: with the SAME number of turns, the diff arm is\n' +
      '  cheaper at every measured size, and relatively cheaper as the page grows. Any dollar\n' +
      '  inversion Tier B finds is therefore behavioural — extra turns — not byte arithmetic.',
  );
  return { rows, problems };
}

// ---------------------------------------------------------------------------
// Tier B — behaviour. Real agent, real dollars.
// ---------------------------------------------------------------------------

/**
 * Ordinary least squares for cost ≈ c1·T + c2·ΣH + b.
 *
 * The spec's model is cost ≈ a·Σ_t(P + H_t) + b, which expands to
 * a·P·T + a·ΣH_t + b — linear in three parameters, with the prefix recoverable
 * as P = c1/c2. Fitted rather than assumed because the SDK's prompt caching
 * prices a re-sent prefix at a blend nobody can compute a priori; an a-priori
 * per-turn price would be a number with no foundation under it.
 */
function fitCostModel(rows) {
  const n = rows.length;
  if (n < 4) return { ok: false, reason: `only ${n} episode(s) — need at least 4 to fit 3 parameters` };
  const X = rows.map((r) => [r.modelTurns, r.convInputChars - r.modelTurns * PREFIX_CHARS, 1]);
  const y = rows.map((r) => r.costUsd);

  // Normal equations, 3x3, solved by Gaussian elimination with partial pivoting.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 3; i++) {
      b[i] += X[k][i] * y[k];
      for (let j = 0; j < 3; j++) A[i][j] += X[k][i] * X[k][j];
    }
  }
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return { ok: false, reason: 'the design matrix is singular (no size variation in the sample)' };
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j < 4; j++) M[r][j] -= f * M[c][j];
    }
  }
  const coef = [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  const yBar = mean(y);
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < n; k++) {
    const pred = coef[0] * X[k][0] + coef[1] * X[k][1] + coef[2] * X[k][2];
    ssRes += (y[k] - pred) ** 2;
    ssTot += (y[k] - yBar) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return {
    ok: true,
    perTurn: coef[0],
    perHistoryChar: coef[1],
    intercept: coef[2],
    prefixFitted: coef[1] === 0 ? null : coef[0] / coef[1],
    prefixMeasured: PREFIX_CHARS,
    r2,
    n,
  };
}

/**
 * The crossover, operationally.
 *
 * Δ$(s) = mean diff-arm $/ep − mean re-dump $/ep, with a seeded bootstrap 90%
 * CI per tier. The band runs from the largest tier whose CI is entirely ABOVE
 * zero (diffs still cost more) to the smallest tier whose CI is entirely BELOW
 * zero (diffs now cheaper). Degenerate cases are RESULTS, not failures — a
 * harness that could only report a crossover would be a machine for confirming
 * the hypothesis.
 *
 * SEVEN outcomes, not four (docs/design/sweep-evaluation.md §2A): the two
 * all-one-sign verdicts, the closed band, the two ONE-SIDED verdicts
 * (`no-crossover-upper-only` / `no-crossover-lower-only` — some tiers settled,
 * the rest are nulls, and the settled ones form a contiguous run), `none`, and
 * `open`. The one-sided pair was the hole: the ladder produced
 * `[straddle, straddle, below, below, below]`, no branch claimed it, and the
 * licensed sentence therefore said the sweep located nothing while three tiers
 * had in fact settled. `open` is now reserved for the shapes that genuinely
 * license no band statement — all-straddle, and non-monotone sign patterns.
 */
function crossoverBand(perTier) {
  const usable = perTier.filter((t) => !t.confounded && t.ci);
  const above = usable.filter((t) => t.ci.lo > 0);
  const below = usable.filter((t) => t.ci.hi < 0);
  if (!usable.length) return { kind: 'none', text: 'no tier produced a usable cost comparison' };
  if (below.length === usable.length) {
    return {
      kind: 'no-crossover-diffs-win',
      text: `NO CROSSOVER — diffs are cheaper at every measured size >= ${usable[0].tier}.`,
    };
  }
  if (above.length === usable.length) {
    return {
      kind: 'no-crossover-diffs-lose',
      text:
        `NO CROSSOVER — diffs never pay on this suite, even at ${usable[usable.length - 1].tier} ` +
        '(Hacker-News scale). This is a product-threatening finding and goes in RESULTS.md in ' +
        'exactly those words.',
    };
  }
  const lastAbove = above.length ? above[above.length - 1].tier : null;
  const firstBelow = below.length ? below[0].tier : null;
  if (lastAbove && firstBelow) {
    return { kind: 'band', text: `CROSSOVER BAND: between ${lastAbove} and ${firstBelow}.`, lo: lastAbove, hi: firstBelow };
  }

  // The ONE-SIDED outcomes (docs/design/sweep-evaluation.md §2A). These are the
  // shapes the ladder actually produced and the ones the verdict used to fall
  // through into `open`, which then said "the sweep does not locate a
  // crossover" about a run in which one side of the sign question WAS settled.
  // A partial answer stated as no answer is not conservatism, it is a wrong
  // sentence.
  const idx = (t) => usable.indexOf(t);
  const isContiguousSuffix = (g) =>
    g.length > 0 && idx(g[0]) + g.length === usable.length &&
    g.every((t, i) => idx(t) === idx(g[0]) + i);
  const isContiguousPrefix = (g) =>
    g.length > 0 && idx(g[0]) === 0 && g.every((t, i) => idx(t) === i);
  const nulls = (from, to) => usable.slice(from, to).map((t) => t.tier).join(', ');

  if (!above.length && isContiguousSuffix(below)) {
    return {
      kind: 'no-crossover-upper-only',
      text:
        'NO CROSSOVER IN THE MEASURED RANGE — diffs are never significantly dearer at any tier; ' +
        `significantly cheaper from ${below[0].tier} up; ${nulls(0, idx(below[0]))} ` +
        'are nulls at this N (CIs include zero).',
      from: below[0].tier,
    };
  }
  if (!below.length && isContiguousPrefix(above)) {
    return {
      kind: 'no-crossover-lower-only',
      text:
        'NO CROSSOVER IN THE MEASURED RANGE — diffs are never significantly cheaper at any tier; ' +
        `significantly dearer up to ${above[above.length - 1].tier}; ` +
        `${nulls(above.length, usable.length)} are nulls at this N (CIs include zero). ` +
        'This is the one-sided form of the product-threatening outcome and goes in RESULTS.md ' +
        'as such.',
      through: above[above.length - 1].tier,
    };
  }

  // `open` now means what it says: either nothing settled anywhere, or the
  // signs are scattered in a pattern no band statement can summarise.
  if (!above.length && !below.length) {
    return {
      kind: 'open',
      text:
        'NO CLOSED BAND — every tier\'s CI straddles zero. The sweep does not locate a crossover ' +
        'at this N; more episodes would narrow it.',
    };
  }
  return {
    kind: 'open',
    text:
      'NO CLOSED BAND — the sign pattern is non-monotone across the ladder; no band statement is ' +
      'licensed.',
  };
}

// ---------------------------------------------------------------------------
// The dry wiring self-test — no ports, no Aperture, no budget
// ---------------------------------------------------------------------------

function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

function dryRun() {
  const problems = [];
  console.log('# Page-size sweep — DRY wiring self-test (no infra, no API budget)\n');

  // ---- fixtures ----------------------------------------------------------
  const fx = checkFixturesOffline();
  console.log('fixtures');
  for (const n of fx.notes) console.log(n);
  problems.push(...fx.problems);

  // ---- the sweep cannot touch the scored cohort --------------------------
  const { identity, leaked } = checkUnwatched();
  console.log('\nintegrity separation');
  console.log(`  codeVersion   : ${identity.codeVersion}   (${identity.files.length} watched files)`);
  console.log(`  suiteVersion  : ${SUITE_VERSION}`);
  console.log(`  bench/size/** inside the watched set: ${leaked.length === 0 ? 'NO — the sweep cannot move codeVersion' : 'YES'}`);
  if (leaked.length) {
    problems.push(`bench/size is inside the task suite's watched set (${leaked.map((f) => f.path).join(', ')}) — adding fixtures here would invalidate every cohort`);
  }
  if (identity.files.some((f) => f.path.startsWith('bench/fixtures/cart-s'))) {
    problems.push('a size fixture has been placed in bench/fixtures/ — that is inside the scored suite\'s content hash');
  }

  // ---- the prompt the agent will actually be given -----------------------
  const missing = checkPromptDrift();
  console.log('\nagent surface');
  console.log(`  systemPrompt  : sha256 ${sha16(SYSTEM_PROMPT)} · ${SYSTEM_PROMPT.length} chars`);
  console.log(`  matches bench/task.mjs: ${missing.length === 0 ? 'yes (all lines found verbatim)' : 'NO'}`);
  if (missing.length) {
    problems.push(`the system prompt has drifted from bench/task.mjs. Lines not found there:\n    ${missing.join('\n    ')}`);
  }
  for (const w of checkTaskDrift()) console.log(`  WARNING: ${w}`);

  // ---- the arithmetic ----------------------------------------------------
  console.log('\narithmetic self-test');

  // conversationInputChars: the triangular sum, checked by hand.
  // obs [10, 20], prefix 100, prompt 5, TOOL_USE_CHARS 80:
  //   t1: 100 + 5                     = 105
  //   t2: 100 + 5 + 80 + 10           = 195
  //   t3: 100 + 5 + 80 + 10 + 80 + 20 = 295
  const conv = conversationInputChars([10, 20], 100, 5);
  const wantConv = 105 + 195 + 295;
  console.log(`  conversationInputChars([10,20],100,5) = ${conv.convInputChars} (expect ${wantConv}, ${conv.turns} turns)`);
  if (conv.convInputChars !== wantConv || conv.turns !== 3) problems.push('conversationInputChars is wrong — the cost regressor would be wrong');

  // The OLS fit must recover known coefficients from noiseless synthetic data.
  const rnd = mulberry32(11);
  const synth = [];
  for (let i = 0; i < 30; i++) {
    const turns = 4 + Math.floor(rnd() * 8);
    const hist = 5000 + rnd() * 200000;
    const conv2 = turns * PREFIX_CHARS + hist;
    synth.push({ modelTurns: turns, convInputChars: conv2, costUsd: 0.002 * turns + 0.0000004 * hist + 0.01 });
  }
  const fit = fitCostModel(synth);
  console.log(
    `  fitCostModel on noiseless synthetic: perTurn ${fit.perTurn?.toExponential(3)} (expect 2.000e-3), ` +
      `perChar ${fit.perHistoryChar?.toExponential(3)} (expect 4.000e-7), R2 ${fit.r2?.toFixed(6)}`,
  );
  if (!fit.ok || !approx(fit.perTurn, 0.002, 1e-9) || !approx(fit.perHistoryChar, 4e-7, 1e-12) || fit.r2 < 0.999999) {
    problems.push('the cost model does not recover known coefficients — the fitted dollars would be fiction');
  }
  const singular = fitCostModel(synth.map((s) => ({ ...s, modelTurns: 5, convInputChars: 5 * PREFIX_CHARS + 1000 })));
  console.log(`  fitCostModel on a degenerate sample: ${singular.ok ? 'ACCEPTED (bad)' : 'refused — ' + singular.reason}`);
  if (singular.ok) problems.push('the cost model accepted a singular design matrix');

  // The band logic must produce EVERY outcome, including the ones that say "no
  // crossover". A harness that can only report a crossover is a machine for
  // confirming its own hypothesis.
  //
  // The one-sided pair is here because the defect shipped for exactly the
  // reason this list is the guard: the only shape reality produced —
  // [straddle, straddle, below, below, below] — was the only shape `--dry` did
  // not enumerate (sweep-evaluation.md §2C).
  const mk = (tier, lo, hi, confounded = false) => ({ tier, ci: { lo, hi, delta: (lo + hi) / 2 }, confounded });
  const cases = [
    ['all CIs below zero', [mk('s1', -0.2, -0.1), mk('s2', -0.3, -0.1)], 'no-crossover-diffs-win'],
    ['all CIs above zero', [mk('s1', 0.1, 0.2), mk('s2', 0.1, 0.3)], 'no-crossover-diffs-lose'],
    ['sign flips at s3', [mk('s1', 0.05, 0.2), mk('s2', 0.01, 0.3), mk('s3', -0.3, -0.01)], 'band'],
    ['everything straddles', [mk('s1', -0.1, 0.1), mk('s2', -0.2, 0.2)], 'open'],
    [
      'nulls then below (Tier B)',
      [mk('s1', -0.1, 0.1), mk('s2', -0.2, 0.2), mk('s3', -0.3, -0.01), mk('s4', -0.4, -0.02), mk('s5', -0.5, -0.03)],
      'no-crossover-upper-only',
    ],
    [
      'above then nulls (mirror)',
      [mk('s1', 0.01, 0.3), mk('s2', 0.02, 0.4), mk('s3', -0.3, 0.3), mk('s4', -0.4, 0.4), mk('s5', -0.5, 0.5)],
      'no-crossover-lower-only',
    ],
    [
      'non-monotone signs',
      [mk('s1', -0.3, -0.01), mk('s2', -0.2, 0.2), mk('s3', -0.4, -0.02), mk('s4', -0.1, 0.1)],
      'open',
    ],
  ];
  for (const [name, tiers, want] of cases) {
    const got = crossoverBand(tiers);
    console.log(`  band(${name.padEnd(20)}) -> ${got.kind}`);
    if (got.kind !== want) problems.push(`crossoverBand(${name}) returned ${got.kind}, expected ${want}`);
  }
  // The confounding guard must actually exclude a tier.
  const withConfound = crossoverBand([mk('s1', -0.2, -0.1), mk('s2', 0.1, 0.2, true)]);
  console.log(`  band(one tier CONFOUNDED)          -> ${withConfound.kind} (the excluded tier must not create a band)`);
  if (withConfound.kind !== 'no-crossover-diffs-win') problems.push('the confounding guard does not exclude a tier from the band');

  // The bootstrap must be seeded and reproducible.
  const xs = [0.11, 0.13, 0.09, 0.12, 0.10, 0.14];
  const ys = [0.21, 0.19, 0.25, 0.22, 0.20, 0.23];
  const c1 = meanDiffCI(xs, ys, { alpha: 0.1, seed: 20260801 });
  const c2 = meanDiffCI(xs, ys, { alpha: 0.1, seed: 20260801 });
  console.log(`  bootstrap 90% CI [${c1.lo.toFixed(4)}, ${c1.hi.toFixed(4)}] · reproducible: ${c1.lo === c2.lo && c1.hi === c2.hi}`);
  if (c1.lo !== c2.lo || c1.hi !== c2.hi) problems.push('the bootstrap is not reproducible on identical input');
  if (!(c1.hi < 0)) problems.push('the bootstrap CI sign convention is not (diff - redump)');

  // The stream normaliser must erase state ids and the envelope nonce, and
  // NOTHING else. Too greedy and P5 can never fire; too shy and it always does.
  const env = (id, seq, ref, text) =>
    `<untrusted-page-content id=${id} origin=http://127.0.0.1:8899>\npage #${seq} (diff from #1.1)\n~ ${ref} "${text}"\n</untrusted-page-content id=${id}>`;
  const a = env('cf0b0d07', '1.2', 'e5', 'Quantity: 3');
  const b = env('4e15f4b9', '4.9', 'e5', 'Quantity: 3');
  const c = env('4e15f4b9', '4.9', 'e6', 'Quantity: 3');
  const d2 = env('4e15f4b9', '4.9', 'e5', 'Quantity: 4');
  const idsErased = normaliseStream(a) === normaliseStream(b);
  const refsKept = normaliseStream(b) !== normaliseStream(c);
  const textKept = normaliseStream(b) !== normaliseStream(d2);
  console.log(`  normaliseStream: ids+nonce erased ${idsErased} · refs preserved ${refsKept} · page text preserved ${textKept}`);
  if (!idsErased || !refsKept || !textKept) {
    problems.push('normaliseStream is wrong — P5 would either never fire or always fire');
  }

  // The budget guard: --sweep must REFUSE when the enabler is missing, and
  // --selftest must not. Tested here because the only other way to test it is
  // to run the mode that spends money.
  const p0cases = [
    ['product missing, --sweep   ', { productOk: false, proxyOk: true, needInject: true }, true],
    ['product missing, --selftest', { productOk: false, proxyOk: true, needInject: false }, true],
    ['proxy missing,   --sweep   ', { productOk: true, proxyOk: false, needInject: true }, true],
    ['proxy missing,   --selftest', { productOk: true, proxyOk: false, needInject: false }, false],
    ['both present,    --sweep   ', { productOk: true, proxyOk: true, needInject: true }, false],
  ];
  for (const [name, args, wantFatal] of p0cases) {
    const v = p0Verdict(args);
    console.log(`  p0Verdict(${name}) -> ${v.fatal ? 'REFUSE' : 'proceed'}${v.notes.length ? ' (with warning)' : ''}`);
    if (v.fatal !== wantFatal) problems.push(`p0Verdict(${name}) returned fatal=${v.fatal}, expected ${wantFatal}`);
    if (v.fatal && !v.problems.length) problems.push(`p0Verdict(${name}) refuses without saying why`);
    if (v.fatal && !v.problems[0].startsWith('P0')) problems.push('a P0 refusal must be tagged P0 so main() can exit 7 rather than 5');
  }

  // The task-region extractor must actually remove only the padding.
  const fake = `<body>\n<main>X</main>\n${PAD_BEGIN}\n    <div><p>y</p></div>\n${PAD_END}\n</body>`;
  console.log(`  taskRegionOf strips exactly the pad block: ${taskRegionOf(fake) === '<body>\n<main>X</main>\n</body>'}`);
  if (taskRegionOf(fake) !== '<body>\n<main>X</main>\n</body>') problems.push('taskRegionOf does not strip the padding cleanly');

  // ---- budget projection -------------------------------------------------
  console.log('\nbudget model (the rule is preregistered in tier1b.md §2, applied automatically)');
  if (fx.manifest) {
    const sizes = fx.manifest.tiers.map((t) => t.predictedChars);
    for (const perEp of [0.09, 0.11, 0.15]) {
      const p = projectSpend(sizes, 6, perEp);
      console.log(
        `  at $${perEp.toFixed(2)}/ep measured at s1: projected $${p.before.toFixed(2)} for N=6 -> ` +
          (p.adjusted ? `ADJUSTED (s4 N=5, s5 N=4) -> $${p.after.toFixed(2)}` : 'no adjustment needed'),
      );
    }
  }

  console.log('');
  if (problems.length) {
    console.log('DRY SELF-TEST FAILED:');
    for (const p of problems) console.log(`  - ${p}`);
    return EXIT.PREFLIGHT;
  }
  console.log('DRY SELF-TEST PASS — fixtures, separation, prompt, arithmetic and band logic all check out.');
  console.log('It proves the wiring only. P0-P5 and Tier A need a live Aperture: --selftest.');
  return EXIT.OK;
}

/**
 * The budget rule, decided before any episode: run s1 at N=2/arm, project total
 * spend assuming per-episode cost scales linearly with page size (deliberately
 * pessimistic — the diff arm's observations do not scale at all). If the
 * projection exceeds $60, drop s5 to N=4 and s4 to N=5. Never drop tiers.
 */
function projectSpend(sizes, n, perEpisodeAtS1) {
  const s1 = sizes[0];
  const ratio = sizes.map((s) => s / s1);
  const total = (ns) => 2 * perEpisodeAtS1 * ratio.reduce((a, r, i) => a + r * ns[i], 0);
  const flat = sizes.map(() => n);
  const before = total(flat);
  if (before <= 60) return { before, after: before, adjusted: false, plan: flat };
  const adj = flat.slice();
  if (adj.length >= 5) {
    adj[4] = Math.min(adj[4], 4);
    adj[3] = Math.min(adj[3], 5);
  }
  return { before, after: total(adj), adjusted: true, plan: adj };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usage() {
  console.log('# Page-size sweep — where does observing by DIFF stop paying?\n');
  console.log('This script never runs by accident, because Tier B spends real money.');
  console.log('Pick a mode:\n');
  console.log('  --make-fixtures   regenerate bench/size/fixtures. No infra, no budget.');
  console.log('  --dry             wiring self-test. No infra, no budget.');
  console.log('  --selftest        P0-P5 preflight + Tier A, live. NO API budget.');
  console.log('  --sweep [--n 6]   the above plus Tier B. SPENDS REAL MONEY.\n');
  console.log('  --tiers s1,s2     restrict the ladder (diagnosis only)');
  console.log('  --force-budget    proceed past the $60 projection rule');
  console.log('  --keep-alive      leave Aperture running after the run');
  return EXIT.INFRA;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.makeFixtures) return makeFixtures();
  if (opts.dry) return dryRun();
  if (!opts.selftest && !opts.sweep) return usage();

  console.log('# Page-size sweep — where does observing by DIFF stop paying?\n');
  console.log(`mode    : ${opts.sweep ? `SWEEP (Tier A + Tier B, N=${opts.n}/arm/tier — SPENDS MONEY)` : 'SELFTEST (preflight + Tier A, no API budget)'}`);
  console.log(`model   : ${opts.model}`);

  // Offline checks first: they are free and they catch the failures that would
  // otherwise be discovered sixty seconds into an Electron boot.
  const fx = checkFixturesOffline();
  if (fx.problems.length) {
    console.log('\nFIXTURES REJECTED:');
    for (const p of fx.problems) console.log(`  - ${p}`);
    return EXIT.PREFLIGHT;
  }
  for (const w of checkTaskDrift()) console.log(`WARNING : ${w}`);
  const promptDrift = checkPromptDrift();
  if (promptDrift.length) {
    console.log('\nSYSTEM PROMPT DRIFT — this sweep would not be measuring the scored suite\'s agent:');
    for (const l of promptDrift) console.log(`  ${JSON.stringify(l)}`);
    return EXIT.PREFLIGHT;
  }

  const { identity, leaked } = checkUnwatched();
  if (leaked.length) {
    console.log('\nbench/size is inside the task suite\'s watched set — refusing to run.');
    return EXIT.PREFLIGHT;
  }
  console.log(`stamp   : codeVersion ${identity.codeVersion} · buildVersion ${identity.buildVersion} · suite ${SUITE_VERSION}`);
  console.log('          (provenance only — this sweep is not a poolable cohort and has no integrity guard)');
  console.log('');
  for (const n of fx.notes) console.log(n);

  let tiers = fx.manifest.tiers.map((t) => ({ ...t }));
  if (opts.tiers) tiers = tiers.filter((t) => opts.tiers.includes(t.id));
  if (!tiers.length) return usage();

  if (await portIsOpen(APERTURE_PORT)) {
    console.log(`\nPORT ${APERTURE_PORT} IS ALREADY IN USE. This sweep starts and owns its own Aperture.`);
    console.log('Run: taskkill //F //IM electron.exe   then try again.');
    return EXIT.INFRA;
  }
  if (await portIsOpen(FIXTURE_PORT)) {
    console.log(`\nPORT ${FIXTURE_PORT} IS ALREADY IN USE — another fixture server (bench/task.mjs?) is running.`);
    return EXIT.INFRA;
  }

  const collector = await startCollector(COLLECTOR_PORT);
  const fixtures = await startFixtureServer();
  let aperture = null;
  let proxy = null;
  let code = EXIT.INFRA;

  try {
    console.log('\nstarting Aperture…');
    aperture = await startAperture();
    console.log(`Aperture up on ${APERTURE_PORT}`);
    proxy = await startProxy({
      apertureUrl: `http://127.0.0.1:${APERTURE_PORT}/mcp`,
      apertureToken: aperture.token,
      collector,
      port: PROXY_PORT,
    });
    const toolSurface = proxy.toolSurfaceFingerprint();
    PREFIX_CHARS = SYSTEM_PROMPT.length + toolSurface.length;
    console.log(`tool surface: sha256 ${sha16(toolSurface)} · prefix ${PREFIX_CHARS} chars (system prompt + tool bytes)\n`);

    console.log('PREFLIGHT — P0 enabler · P1 size · P2 ref parity · P3 null agent · P4 scripted solve · P5 diff invariance');
    const pf = await preflight({ proxy, collector, tiers, apertureTools: aperture.tools, needInject: opts.sweep });
    for (const n of pf.notes) console.log(n);
    if (pf.problems.length) {
      console.log('\nPREFLIGHT FAILED — no numbers will be produced:');
      for (const p of pf.problems) console.log(`  - ${p}`);
      const enabler = pf.problems.some((p) => p.startsWith('P0'));
      return (code = enabler ? EXIT.ENABLER : EXIT.PREFLIGHT);
    }
    console.log('PREFLIGHT PASS — the only thing varying across tiers is full-snapshot weight.');

    const tierA = tierATable(tiers);
    if (tierA.problems.length) {
      console.log('\nTIER A FAILED:');
      for (const p of tierA.problems) console.log(`  - ${p}`);
      return (code = EXIT.PREFLIGHT);
    }

    if (!opts.sweep) {
      console.log('\nSELFTEST PASS — preflight green, Tier A produced, no API budget spent.');
      console.log('Measured snapshot sizes per tier:');
      for (const t of tiers) console.log(`  ${t.id}  ${String(t.measuredChars).padStart(6)} chars  (~${Math.ceil(t.measuredChars / 4)} tok)  ${t.file}`);
      return (code = EXIT.OK);
    }

    code = await tierB({ proxy, collector, tiers, opts, identity, tierA });
    return code;
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    await fixtures.close().catch(() => {});
    await collector.close().catch(() => {});
    if (aperture && !opts.keepAlive) await killTree(aperture.child);
  }
}

async function tierB({ proxy, collector, tiers, opts, identity, tierA }) {
  mkdirSync(SIZE_DIR, { recursive: true });
  const runId = new Date().toISOString();
  const rows = [];

  const record = (row) => {
    rows.push(row);
    appendFileSync(
      RESULTS,
      JSON.stringify({
        runId,
        codeVersion: identity.codeVersion,
        buildVersion: identity.buildVersion,
        suiteVersion: SUITE_VERSION,
        model: opts.model,
        armDefinition: ARM_DEFINITION[row.arm],
        ...row,
        // The full stream is diagnostic weight, not a result. Kept short.
        diffStream: row.diffStream.slice(0, 400),
      }) + '\n',
    );
  };

  console.log('\nTIER B — behaviour (real agent, real dollars). Intention-to-treat: a diff-arm episode');
  console.log('   that rescues itself with voluntary full snapshots still scores as diff arm, and its');
  console.log('   cost includes the rescues.\n');

  // ---- the budget rule, applied before the bulk of the spend --------------
  const pilotN = 2;
  console.log(`budget pilot: ${tiers[0].id} at N=${pilotN}/arm`);
  for (const arm of ['diff', 'redump']) {
    for (let i = 0; i < pilotN; i++) {
      const r = await runEpisode({ proxy, collector, tier: tiers[0], arm, runIndex: i, driver: agentDriver(proxy, opts) });
      record(r);
      console.log(logLine(tiers[0], arm, i, r));
    }
  }
  const perEp = mean(rows.map((r) => r.costUsd));
  const proj = projectSpend(tiers.map((t) => t.measuredChars), opts.n, perEp);
  console.log(
    `\n  measured $${perEp.toFixed(4)}/episode at ${tiers[0].id}. Projected total for N=${opts.n}: $${proj.before.toFixed(2)} ` +
      '(assumes cost scales linearly with page size — pessimistic for the diff arm).',
  );
  let plan = proj.plan;
  if (proj.adjusted) {
    console.log(`  OVER $60 — applying the preregistered adjustment: s4 -> N=${plan[3]}, s5 -> N=${plan[4]}. New projection $${proj.after.toFixed(2)}.`);
    if (proj.after > 60 && !opts.forceBudget) {
      console.log('\n  STILL over $60 after the one adjustment the design permits, and the design says');
      console.log('  never drop tiers. Stopping here rather than quietly spending more than the rule.');
      console.log('  Re-run with --force-budget to proceed deliberately.');
      return EXIT.INFRA;
    }
  }
  console.log(`  plan: ${tiers.map((t, i) => `${t.id}=${plan[i] ?? opts.n}`).join(' · ')}\n`);

  // ---- the sweep proper ---------------------------------------------------
  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    const want = plan[ti] ?? opts.n;
    for (const arm of ['diff', 'redump']) {
      const have = rows.filter((r) => r.tier === tier.id && r.arm === arm).length;
      for (let i = have; i < want; i++) {
        const r = await runEpisode({ proxy, collector, tier, arm, runIndex: i, driver: agentDriver(proxy, opts) });
        record(r);
        console.log(logLine(tier, arm, i, r));
      }
    }
  }

  return reportTierB({ rows, tiers, tierA, opts, identity });
}

function logLine(tier, arm, i, r) {
  return (
    `  ${tier.id} ${arm.padEnd(7)} run${String(i).padStart(2)}  ${r.success ? 'PASS' : 'fail'}  ` +
    `wrong=${r.wrongElement} steps=${r.steps} turns=${r.sdkTurns} vol=${r.voluntaryObs} ` +
    `obs=${r.kinds.full}F/${r.kinds.diff}D/${r.kinds.nochange}N/${r.kinds.other}? · ${String(r.obsChars).padStart(6)}ch · ` +
    `$${r.costUsd.toFixed(4)} · ${(r.durationMs / 1000).toFixed(0)}s` +
    (r.driverError ? `  ERROR: ${r.driverError.slice(0, 70)}` : '')
  );
}

function reportTierB({ rows, tiers, tierA, opts, identity }) {
  console.log('\n' + '='.repeat(78));
  console.log('TIER B RESULT');
  console.log('='.repeat(78));

  const perTier = [];
  console.log('\n  tier   n(D/R)   $/ep D    $/ep R     Δ$        90% CI              success D/R   turns D/R');
  console.log('  ' + '-'.repeat(94));
  for (const tier of tiers) {
    const d = rows.filter((r) => r.tier === tier.id && r.arm === 'diff');
    const u = rows.filter((r) => r.tier === tier.id && r.arm === 'redump');
    if (!d.length || !u.length) continue;
    const sd = d.filter((r) => r.success).length / d.length;
    const su = u.filter((r) => r.success).length / u.length;
    // Validity guard: a failing arm's episodes are not the same work, so their
    // dollars are not comparable. Excluded from the band, not silently averaged.
    const confounded = Math.abs(sd - su) > 0.1;
    const ci = meanDiffCI(d.map((r) => r.costUsd), u.map((r) => r.costUsd), { alpha: 0.1, seed: 20260801 });
    perTier.push({
      tier: tier.id,
      chars: tier.measuredChars,
      nDiff: d.length,
      nRedump: u.length,
      costDiff: mean(d.map((r) => r.costUsd)),
      costRedump: mean(u.map((r) => r.costUsd)),
      turnsDiff: mean(d.map((r) => r.sdkTurns)),
      turnsRedump: mean(u.map((r) => r.sdkTurns)),
      volDiff: mean(d.map((r) => r.voluntaryObs)),
      volRedump: mean(u.map((r) => r.voluntaryObs)),
      successDiff: sd,
      successRedump: su,
      ci,
      confounded,
    });
    const t = perTier[perTier.length - 1];
    console.log(
      `  ${t.tier.padEnd(5)} ${String(t.nDiff)}/${String(t.nRedump).padEnd(5)} ` +
        `$${t.costDiff.toFixed(4)}  $${t.costRedump.toFixed(4)}  ${t.ci.delta >= 0 ? '+' : ''}$${t.ci.delta.toFixed(4)}  ` +
        `[${t.ci.lo >= 0 ? '+' : ''}${t.ci.lo.toFixed(4)}, ${t.ci.hi >= 0 ? '+' : ''}${t.ci.hi.toFixed(4)}]  ` +
        `${(t.successDiff * 100).toFixed(0)}%/${(t.successRedump * 100).toFixed(0)}%${t.confounded ? ' CONFOUNDED' : '        '}   ` +
        `${t.turnsDiff.toFixed(1)}/${t.turnsRedump.toFixed(1)}`,
    );
  }

  const confounded = perTier.filter((t) => t.confounded);
  if (confounded.length) {
    console.log(
      `\n  CONFOUNDED (excluded from the band): ${confounded.map((t) => t.tier).join(', ')} — the arms' success rates\n` +
        '  differ by more than 10pp there, so their episodes are not the same work.',
    );
  }

  // ---- the crossover ------------------------------------------------------
  const band = crossoverBand(perTier);
  console.log(`\n  ${band.text}`);

  // ---- the fitted cost model ---------------------------------------------
  const fit = fitCostModel(rows.filter((r) => r.costUsd > 0));
  console.log('\n  Cost model — fitted, never assumed (SDK prompt caching prices a re-sent prefix at a');
  console.log('  blend that cannot be computed a priori, so an a-priori per-turn price would be fiction).');
  if (!fit.ok) {
    console.log(`    NOT FITTED: ${fit.reason}. Raw dollars above stand on their own.`);
  } else if (fit.r2 >= 0.9) {
    console.log(
      `    cost ≈ ${fit.perHistoryChar.toExponential(3)}·Σ(P + H_t) + ${fit.intercept.toFixed(4)}   ` +
        `R² = ${fit.r2.toFixed(3)} over n=${fit.n}`,
    );
    console.log(`    fitted prefix P = ${Math.round(fit.prefixFitted)} chars vs measured ${fit.prefixMeasured} chars`);
  } else {
    console.log(`    R² = ${fit.r2.toFixed(3)} < 0.90 — THE MODEL FAILED. Raw dollars only; the model is not cited.`);
  }

  // ---- the behavioural secondary -----------------------------------------
  console.log('\n  Voluntary observations per episode (the behavioural input the reframing turns on):');
  for (const t of perTier) {
    console.log(`    ${t.tier}  diff ${t.volDiff.toFixed(2)} · re-dump ${t.volRedump.toFixed(2)}   (turns ${t.turnsDiff.toFixed(1)} vs ${t.turnsRedump.toFixed(1)})`);
  }

  // ---- what this licenses (sweep-evaluation.md §2B) -----------------------
  //
  // The claim is assembled from the PER-TIER intervals, because those are the
  // result; the band verdict is a summary of them and rides as a subordinate
  // clause. Interpolating `band.text` alone was the defect: one sentence
  // carrying the whole claim inherits every hole in the band's case analysis,
  // and it inherited one. tier2 §4.2's "band statement verbatim from
  // crossoverBand" stays satisfied — verbatim as a clause, not as the claim.
  const usableTiers = perTier.filter((t) => !t.confounded && t.ci);
  const signOf = (t) => (t.ci.lo > 0 ? 'dearer' : t.ci.hi < 0 ? 'cheaper' : 'null');
  const cheaper = usableTiers.filter((t) => signOf(t) === 'cheaper');
  const dearer = usableTiers.filter((t) => signOf(t) === 'dearer');
  const nullTiers = usableTiers.filter((t) => signOf(t) === 'null');
  const names = (g) => (g.length ? g.map((t) => t.tier).join(', ') : 'none');

  console.log('\n  What this licenses, and nothing more:');
  console.log(`    "On cart-adjust with ${opts.model}, over full-snapshot sizes ${perTier[0]?.chars}-${perTier[perTier.length - 1]?.chars} chars,`);
  console.log('     per tier, Δ$ per episode (diff − re-dump) with a 90% CI and N:');
  for (const t of usableTiers) {
    console.log(
      `       ${t.tier.padEnd(4)} ${t.chars}ch  ${t.ci.delta >= 0 ? '+' : ''}$${t.ci.delta.toFixed(4)}  ` +
        `[${t.ci.lo >= 0 ? '+' : ''}${t.ci.lo.toFixed(4)}, ${t.ci.hi >= 0 ? '+' : ''}${t.ci.hi.toFixed(4)}]  ` +
        `n=${t.nDiff}/${t.nRedump}  ${signOf(t) === 'null' ? 'null (CI includes zero)' : `diffs ${signOf(t)}`}`,
    );
  }
  console.log(`     significantly cheaper at: ${names(cheaper)}; significantly dearer at: ${names(dearer)};`);
  console.log(`     null at this N at: ${names(nullTiers)};`);
  console.log(`     in summary — ${band.text.replace(/\n/g, ' ')}"`);
  console.log('    It says nothing about other tasks, other models, real websites, the truncation');
  console.log('    regime, or page sizes beyond the measured ladder.');
  console.log(`\n  ${rows.length} episode(s) written to ${rel(RESULTS)} (codeVersion ${identity.codeVersion})`);
  console.log(`  Tier A mechanism curve: ${tierA.rows.map((r) => `${r.tier} ${r.obsRatio.toFixed(2)}x`).join(' · ')}`);
  return EXIT.OK;
}

main()
  .then((c) => process.exit(c ?? EXIT.INFRA))
  .catch((e) => {
    console.error('\nSWEEP FAILED:', e?.stack ?? e);
    process.exit(EXIT.INFRA);
  });
