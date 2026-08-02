/**
 * The §4.2 rule-2 linter — neutrality made MECHANICAL.
 *
 * Neutrality cannot rest on authorial intent: the author of headtohead.md knows
 * both tools. §4.2 therefore turns it into four auditable properties, and rule
 * 2 is the one a program can check. This is that program.
 *
 * Every rule below is a sentence from §4.2 and a reason a skeptic would accept:
 *
 *   R1 unique accessible names  the identical-sibling construction is the known
 *                               Aperture-specific trap (it forces the walker's
 *                               ordinal fallback). Banned here; it lives in the
 *                               home set where it is disclosed.
 *   R2 conventional form markup id / name / <label> as an ordinary site has.
 *   R3 headings and landmarks   present, because real pages have them and both
 *                               engines render them.
 *   R4 no data-testid           Tier-1 identity input for Aperture AND
 *                               Playwright's default --test-id-attribute.
 *                               Banned SYMMETRICALLY: it would advantage both,
 *                               unequally, and no one could say by how much.
 *   R5 data-bench only          the witness id, inert to both engines.
 *   R6 no native <select>       the sealed schema has no select action;
 *                               symmetric absence beats asymmetric presence.
 *   R7 no tool vocabulary       nothing from either product's internals in ids,
 *                               classes or comments.
 *   R8 witness identity         the h2h copy of bench.js is byte-identical to
 *                               bench/fixtures/bench.js. Two drifting witnesses
 *                               would be the worst possible bug in this suite.
 *   R9 tracer separation        no BULK_WORD appears in any task prompt, label,
 *                               allowed id or solve step — H5's "padding never
 *                               leaks into a diff" assert is only meaningful if
 *                               the tracer cannot legitimately appear.
 *
 * WHAT IT CANNOT SEE, STATED RATHER THAN IMPLIED: elements created by the
 * fixture's own JavaScript are not in the static markup. R1 over those is
 * checked LIVE by H5 against the untruncated Aperture full snapshot, which is
 * the only place they exist. A linter that quietly checked half a fixture and
 * printed GREEN would be worse than no linter.
 *
 *   node bench/headtohead/lint-fixtures.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEUTRAL_TASKS } from './neutralTasks.mjs';
import { BULK_WORDS } from './fixtures/make-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const ROOT = join(HERE, '..', '..');
const CANONICAL_WITNESS = join(ROOT, 'bench', 'fixtures', 'bench.js');

const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * R7's banned vocabulary. Deliberately includes this project's OWN words as
 * well as Playwright's: a fixture with `data-ordinal` or `class="diff-row"`
 * tells a reader which engine the author had in mind, and that is the thing
 * §4.2 is trying to make impossible to hide.
 */
const TOOL_VOCAB = [
  'aperture', 'playwright', 'chromium', 'electron', 'testid', 'test-id',
  'aria-ref', 'mcp', 'walker', 'redump', 're-dump', 'ordinal', 'shadow model',
  'diff', 'snapshot', 'observation', 'wrong-element', 'stale ref', 'stale-ref',
];

const INTERACTIVE_TAGS = /<(button|a|input|textarea|select)\b([^>]*)>/gi;

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : null;
};

/** Static accessible name, by the same precedence the witness's `labelOf` uses. */
function staticName(html, tagName, attrs, after) {
  const aria = attr(attrs, 'aria-label');
  if (aria) return aria.trim();
  const id = attr(attrs, 'id');
  if (id) {
    const lab = new RegExp(`<label[^>]*\\sfor\\s*=\\s*"${id}"[^>]*>([\\s\\S]*?)</label>`, 'i').exec(html);
    if (lab) return lab[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
  if (tagName === 'button' || tagName === 'a') {
    const m = /^>?([\s\S]*?)<\//.exec('>' + after);
    if (m) return m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
  const ph = attr(attrs, 'placeholder');
  if (ph) return ph.trim();
  return '';
}

/** Regions the fixture marks as static padding. Excluded from R1's uniqueness
 *  scan only in the sense that they are reported separately — a duplicate name
 *  inside the bulk is still a finding, because a real page's nav does not repeat
 *  itself either and a duplicate there would be a generator bug. */
function bulkRanges(html) {
  const out = [];
  const re = /<!--\s*BULK:BEGIN\s*-->/g;
  let m;
  while ((m = re.exec(html))) {
    const end = html.indexOf('<!-- BULK:END -->', m.index);
    out.push([m.index, end < 0 ? html.length : end]);
  }
  return out;
}

export function lintFixture(file, html) {
  const problems = [];
  const notes = [];
  const bulk = bulkRanges(html);
  const inBulk = (i) => bulk.some(([a, b]) => i >= a && i < b);

  // R4 / R5 — attributes
  if (/data-testid/i.test(html)) {
    problems.push(`${file}: R4 — data-testid present. It is Tier-1 identity input for Aperture AND Playwright's default --test-id-attribute; banned symmetrically.`);
  }
  for (const m of html.matchAll(/\sdata-([a-z0-9-]+)\s*=/gi)) {
    if (m[1].toLowerCase() !== 'bench') {
      problems.push(`${file}: R5 — non-witness data attribute "data-${m[1]}". Only data-bench is inert to both engines.`);
    }
  }

  // R6 — no native select
  if (/<select\b/i.test(html)) {
    problems.push(`${file}: R6 — native <select>. The sealed 3-tool schema has no select action; symmetric absence is the rule.`);
  }

  // R3 — headings and landmarks
  if (!/<h1\b/i.test(html)) problems.push(`${file}: R3 — no <h1>.`);
  if (!/<(main|nav|header|footer|section)\b/i.test(html)) {
    problems.push(`${file}: R3 — no landmark element (main/nav/header/footer/section).`);
  }

  // R1 / R2 — interactive elements
  const names = new Map();
  let m;
  INTERACTIVE_TAGS.lastIndex = 0;
  while ((m = INTERACTIVE_TAGS.exec(html))) {
    const [, tagName, attrs] = m;
    const tag = tagName.toLowerCase();
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 400);
    // <input type=hidden> and the script-src <a>-less cases are not controls.
    const type = (attr(attrs, 'type') ?? '').toLowerCase();
    if (tag === 'input' && type === 'hidden') continue;

    const name = staticName(html, tag, attrs, after);
    const where = inBulk(m.index) ? 'bulk' : 'task region';

    if (!name) {
      problems.push(`${file}: R1 — an interactive <${tag}> (${where}) has no accessible name: ${m[0].slice(0, 110)}`);
    } else {
      const key = `${name}`;
      if (!names.has(key)) names.set(key, []);
      names.get(key).push({ tag, where, at: m.index });
    }

    // R2 — form fields carry id/name and a <label>
    if (tag === 'input' || tag === 'textarea') {
      const id = attr(attrs, 'id');
      const nm = attr(attrs, 'name');
      if (!id) problems.push(`${file}: R2 — form field without id: ${m[0].slice(0, 110)}`);
      if (!nm) problems.push(`${file}: R2 — form field without name: ${m[0].slice(0, 110)}`);
      if (id && !new RegExp(`<label[^>]*\\sfor\\s*=\\s*"${id}"`, 'i').test(html) && !attr(attrs, 'aria-label')) {
        problems.push(`${file}: R2 — form field #${id} has neither a <label for> nor an aria-label.`);
      }
    }
  }
  for (const [name, hits] of names) {
    if (hits.length > 1) {
      problems.push(
        `${file}: R1 — ${hits.length} interactive elements share the accessible name "${name}" ` +
          `(${hits.map((h) => `${h.tag}/${h.where}`).join(', ')}). The identical-sibling ` +
          'construction forces Aperture\'s ordinal fallback; §4.2 bans it in the neutral set.',
      );
    }
  }

  // R7 — tool vocabulary in ids, classes and comments
  const scanZones = [];
  for (const a of html.matchAll(/\sid\s*=\s*"([^"]*)"/gi)) scanZones.push(['id', a[1]]);
  for (const a of html.matchAll(/\sclass\s*=\s*"([^"]*)"/gi)) scanZones.push(['class', a[1]]);
  for (const a of html.matchAll(/<!--([\s\S]*?)-->/g)) scanZones.push(['comment', a[1]]);
  for (const [zone, text] of scanZones) {
    // The generator's own header comments explain what the fixture is FOR, and
    // that explanation necessarily names the mechanism. Comments that open with
    // the fixture id are the authoring header and are exempt; everything else
    // is not.
    if (zone === 'comment' && /^\s*\n?\s*T\d /.test(text)) continue;
    for (const w of TOOL_VOCAB) {
      if (text.toLowerCase().includes(w)) {
        problems.push(`${file}: R7 — tool vocabulary "${w}" in a ${zone}: ${text.slice(0, 90).trim()}`);
      }
    }
  }

  notes.push(
    `  ${file.padEnd(24)} ${String(Buffer.byteLength(html, 'utf8')).padStart(7)} bytes  ` +
      `${String(names.size).padStart(4)} named controls  ${bulk.length} bulk region(s)` +
      (names.size === 0 ? '   [ALL CONTROLS ARE DYNAMIC — R1 rests entirely on H5\'s live check]' : ''),
  );
  return { problems, notes, staticControls: names.size };
}

/** R8 — the witness must not fork. */
export function lintWitness() {
  const problems = [];
  const here = join(FIXTURES, 'bench.js');
  if (!existsSync(here)) return { problems: [`R8 — ${here} is missing.`], notes: [] };
  if (!existsSync(CANONICAL_WITNESS)) {
    return { problems: [`R8 — ${CANONICAL_WITNESS} is missing.`], notes: [] };
  }
  const a = readFileSync(here);
  const b = readFileSync(CANONICAL_WITNESS);
  if (sha(a) !== sha(b)) {
    problems.push(
      'R8 — bench/headtohead/fixtures/bench.js is NOT byte-identical to bench/fixtures/bench.js. ' +
        'Ground truth would differ between the two fixture classes and no cross-class comparison ' +
        'would mean anything.',
    );
  }
  return { problems, notes: [`  witness sha ${sha(a).slice(0, 16)} (matches bench/fixtures/bench.js)`] };
}

/** R9 — the tracer vocabulary must be unreachable through legitimate task text. */
export function lintTracerSeparation() {
  const problems = [];
  const surface = NEUTRAL_TASKS.map((t) =>
    [t.prompt, t.allowed.join(' '), (t.solve ?? []).map((s) => `${s.label} ${s.text ?? ''}`).join(' '), String(t.mustObserve)].join(' '),
  ).join(' ').toLowerCase();
  for (const w of BULK_WORDS) {
    if (surface.includes(w.toLowerCase())) {
      problems.push(
        `R9 — the tracer word "${w}" appears in a task's own text. H5's "padding never leaks into ` +
          'a diff" assert would then be unfalsifiable.',
      );
    }
  }
  return { problems, notes: [`  ${BULK_WORDS.length} tracer words, none reachable from task text`] };
}

export function lintAll() {
  const problems = [];
  const notes = [];
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.html')).sort();
  const expected = [...new Set(NEUTRAL_TASKS.map((t) => t.fixture))].sort();
  for (const want of expected) {
    if (!files.includes(want)) problems.push(`missing fixture: ${want}`);
  }
  for (const f of files) {
    const r = lintFixture(f, readFileSync(join(FIXTURES, f), 'utf8'));
    problems.push(...r.problems);
    notes.push(...r.notes);
  }
  for (const r of [lintWitness(), lintTracerSeparation()]) {
    problems.push(...r.problems);
    notes.push(...r.notes);
  }
  return { problems, notes };
}

const invokedDirectly = process.argv[1]?.endsWith('lint-fixtures.mjs');
if (invokedDirectly) {
  const { problems, notes } = lintAll();
  console.log('H5 — fixture neutrality lint (headtohead.md §4.2 rule 2)\n');
  for (const n of notes) console.log(n);
  if (problems.length) {
    console.log(`\n${problems.length} PROBLEM(S):\n`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log('\nRED. A fixture that fails this lint is not neutral ground, and a result on it');
    console.log('licenses nothing.');
    process.exit(1);
  }
  console.log('\nGREEN — every neutral fixture satisfies §4.2 rule 2.');
  process.exit(0);
}
