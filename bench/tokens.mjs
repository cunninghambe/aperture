/**
 * Token benchmark: diff-mode versus re-dump-mode.
 *
 * Measures the observation cost of an N-action task two ways against the same
 * page and the same action sequence:
 *
 *   re-dump : a full snapshot after every action, which is what playwright-mcp,
 *             browser-use and chrome-devtools-mcp all do.
 *   diff    : one full snapshot, then a delta per action, with Aperture's
 *             fallback rules deciding when to re-sync.
 *
 * This measures ONE half of the claim. It says nothing about whether an agent
 * completes the task as reliably on deltas — which matters more, and needs a
 * task suite rather than a token counter. Do not quote this as vindication of
 * the design.
 *
 * Run: npm run bench
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// Same estimator the renderer uses, so the two are comparable.
const CHARS_PER_TOKEN = 4;
const tok = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);

/**
 * A synthetic page of the shape that actually costs tokens: a results list of
 * repeated items plus a form. Built here rather than driven through Electron so
 * the benchmark runs in CI without a display.
 */
function buildPage(itemCount) {
  const lines = ['banner "Example Store"', 'main e1', '  form e2'];
  let ref = 3;
  for (const label of ['First name', 'Last name', 'Email', 'Postcode']) {
    lines.push(`    textbox e${ref++} "${label}" ="" required`);
  }
  lines.push(`  list e${ref++} "results"`);
  for (let i = 0; i < itemCount; i++) {
    lines.push(`    listitem`);
    lines.push(`      link e${ref++} "Product ${i} — a reasonably long product title" /p/${i}`);
    lines.push(`      "$${(19 + i).toFixed(2)} · ★4.${i % 9} (${100 + i * 7} reviews)"`);
    lines.push(`      button e${ref++} "Add to cart"`);
  }
  return lines.join('\n');
}

/** What a diff costs: only the lines that changed. */
function diffFor(action) {
  return `page #1.${action.step} (diff from #1.${action.step - 1})\n${action.ops.join('\n')}`;
}

function run({ items, actions }) {
  const full = buildPage(items);
  const fullCost = tok(full);

  // Re-dump mode: full snapshot after every action.
  const redump = fullCost * (actions.length + 1);

  // Diff mode: one full, then deltas, with a forced re-sync every 12 diffs.
  let diff = fullCost;
  let sinceFull = 0;
  let resyncs = 0;
  for (const a of actions) {
    if (sinceFull >= 12) {
      diff += fullCost;
      sinceFull = 0;
      resyncs++;
      continue;
    }
    diff += tok(diffFor(a));
    sinceFull++;
  }

  return { fullCost, redump, diff, resyncs };
}

// A realistic 20-action sequence: fill four fields, then interact with the list.
const actions = Array.from({ length: 20 }, (_, i) => ({
  step: i + 1,
  ops:
    i < 4
      ? [`~ e${3 + i} ="value ${i}"`]
      : [`~ e${10 + i} +checked`, `~ e2 "Results (${120 - i})"`],
}));

console.log('Observation cost for a 20-action task\n');
console.log('items   full     re-dump      diff    ratio  resyncs');
console.log('-----   ------   ---------   ------   ------  -------');

for (const items of [5, 24, 60, 150]) {
  const r = run({ items, actions });
  const ratio = (r.redump / r.diff).toFixed(1);
  console.log(
    String(items).padEnd(8) +
      String(r.fullCost).padEnd(9) +
      String(r.redump).padEnd(12) +
      String(r.diff).padEnd(9) +
      `${ratio}x`.padEnd(8) +
      r.resyncs,
  );
}

console.log(`
Caveats, because this number is easy to over-read:
  - Synthetic page, not a real site. Real pages have more noise and more
    churn, both of which favour re-dump.
  - Assumes every action produces a small delta. An action that replaces a
    results list produces a large one, and Aperture falls back to a full
    snapshot when a diff exceeds 30% of the last full.
  - Measures tokens only. If agents complete fewer tasks on deltas, this
    saving is worth nothing. That experiment is not written yet.
`);

void readFileSync;
void join;
void here;
