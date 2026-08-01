import { describe, expect, it } from 'vitest';
import {
  applyObservation,
  isDiff,
  isFullSnapshot,
  isNoChange,
  isTruncated,
  parseElementLine,
  splitRowLine,
} from '../bench/lib/streamModel.mjs';
import { labelsAgree } from '../bench/lib/proxy.mjs';
import { dedupeActions } from '../bench/lib/collector.mjs';
import { RefRegistry } from '../src/core/snapshot/registry.js';
import { diffSnapshots } from '../src/core/snapshot/diff.js';
import { renderDiff, renderLine } from '../src/core/snapshot/render.js';
import type { SnapshotNode } from '../src/core/snapshot/types.js';

/**
 * The shared stream reader.
 *
 * This module was lifted out of bench/fidelity.mjs so the task-success bench
 * could use the SAME parser as its shadow model. That is the point of these
 * tests: if the two benches ever disagreed about what a line means, the task
 * bench's failure attribution would be describing a parser disagreement while
 * printing the word "model_bookkeeping". One parser, tested once.
 */

describe('parseElementLine', () => {
  it('reads role, ref, label, value and trailing state words', () => {
    const el = parseElementLine('  checkbox e12 "Notify me" ="on" checked required');
    expect(el).toMatchObject({ role: 'checkbox', ref: 'e12', label: 'Notify me', value: 'on' });
    expect([...el!.states].sort()).toEqual(['checked', 'required']);
  });

  it('does not let quoted page text masquerade as a state word', () => {
    // A label may legitimately contain the word "checked". It must not become
    // a state flag — that is a page controlling the agent's model of itself.
    const el = parseElementLine('button e3 "Everything checked"');
    expect(el!.label).toBe('Everything checked');
    expect(el!.states.size).toBe(0);
  });

  it('survives escaped quotes in a label', () => {
    const el = parseElementLine('button e4 "He said \\"go\\"" disabled');
    expect(el!.label).toBe('He said "go"');
    expect([...el!.states]).toEqual(['disabled']);
  });

  it('returns null for lines that are not elements', () => {
    expect(parseElementLine('page "Title" http://x/')).toBeNull();
    expect(parseElementLine('  "some bare text"')).toBeNull();
  });
});

describe('applyObservation', () => {
  it('a FULL SNAPSHOT replaces the whole model', () => {
    const m = new Map();
    applyObservation(m, 'button e1 "Old"');
    applyObservation(m, 'FULL SNAPSHOT #3 — replaces all prior state for this page\nbutton e9 "New"');
    expect([...m.keys()]).toEqual(['e9']);
  });

  it('a removal kills the named ref and everything the gone list names', () => {
    const m = new Map();
    applyObservation(m, ['list e1 "L"', 'button e2 "A"', 'button e3 "B"'].join('\n'));
    applyObservation(m, '- e1 removed (was: list "L") (gone: e2 e3)');
    expect(m.size).toBe(0);
  });

  it('a bare gone line kills refs whose container was never addressable', () => {
    // A removed <div> has no ref of its own, so there is no `- eN removed`
    // line to hang the list on. The deaths still have to arrive.
    const m = new Map();
    applyObservation(m, ['button e2 "A"', 'button e3 "B"', 'button e4 "C"'].join('\n'));
    applyObservation(m, 'page #1.2 (diff from #1.1)\n- gone: e2 e3');
    expect([...m.keys()]).toEqual(['e4']);
  });

  it('tracks a native select\'s option count, and a restatement replaces it', () => {
    // `[N options]` is the agent's only discriminator between a native select
    // and a custom combobox, and its staleness was unmeasurable: the reader
    // dropped the marker on the floor, so no scenario could go red on it.
    const m = new Map();
    applyObservation(m, 'combobox e3 "State" ="Victoria" [3 options]');
    expect(m.get('e3').optionCount).toBe(3);
    applyObservation(
      m,
      ['! e3 replaced:', '  combobox e3 "State" ="State number 0" [51 options]'].join('\n'),
    );
    expect(m.get('e3').optionCount).toBe(51);
  });

  it('a replace kills the gone list, and the subtree lines that follow revive survivors', () => {
    const m = new Map();
    applyObservation(m, ['list e1 "L"', 'button e2 "A"', 'button e3 "B"'].join('\n'));
    applyObservation(m, ['! e1 replaced (gone: e2 e3):', '  button e4 "C"'].join('\n'));
    expect([...m.keys()].sort()).toEqual(['e1', 'e4']);
  });

  it('an update applies value, name and state deltas', () => {
    const m = new Map();
    applyObservation(m, 'checkbox e5 "Notify" ="off"');
    applyObservation(m, '~ e5 "Notify me" ="on" +checked');
    expect(m.get('e5')).toMatchObject({ label: 'Notify me', value: 'on' });
    expect(m.get('e5').states.has('checked')).toBe(true);
    applyObservation(m, '~ e5 -checked');
    expect(m.get('e5').states.has('checked')).toBe(false);
  });

  it('quoted text in an update cannot inject a state flag', () => {
    const m = new Map();
    applyObservation(m, 'text e7 "x"');
    applyObservation(m, '~ e7 "name" "body text +checked disabled"');
    expect(m.get('e7').states.size).toBe(0);
  });
});

/**
 * The blind fields.
 *
 * `href`, `dims` and table `rows` were emitted by the renderer and dropped by
 * this reader, so BOTH sides of every fidelity comparison were blind in the same
 * way and a mutated table compared stale-against-fresh as EQUAL. Five green
 * scenarios could not have caught the propDelta bug however many fixtures were
 * added to them (docs/design/tier2b.md §0). These are the tests for the fields
 * that could not be seen.
 */
describe('parseElementLine — the bare tokens after the quoted ones', () => {
  it('reads a link\'s href', () => {
    const el = parseElementLine('  link e4 "Continue to checkout" /checkout');
    expect(el!.href).toBe('/checkout');
    expect(el!.label).toBe('Continue to checkout');
    expect(el!.states.size).toBe(0);
  });

  it('reads a flattened table\'s dims without mistaking them for an href', () => {
    const el = parseElementLine('  table e2 "Shipments" 3x3');
    expect(el!.dims).toEqual({ rows: 3, cols: 3 });
    expect(el!.href).toBeUndefined();
  });

  it('reads href and dims together, positionally, in emission order', () => {
    // Contrived — nothing emits both today — but the parse must not depend on
    // shape-guessing, because an href of "3x2" is a legal path.
    const el = parseElementLine('  link e5 "Odd" 3x2 5x9');
    expect(el!.href).toBe('3x2');
    expect(el!.dims).toEqual({ rows: 5, cols: 9 });
  });

  it('discards the scroll offset — an excluded field, not a forgotten one', () => {
    // tier2b §1: scroll churns on every scroll by agent, user or page, and the
    // agent's own scroll actions already return observations.
    const el = parseElementLine('  scrollable e9 "Log" (120/900px)');
    expect(el!.href).toBeUndefined();
    expect(el!.dims).toBeUndefined();
  });

  it('keeps the state tail separate from the bare tokens', () => {
    const el = parseElementLine('  link e7 "Home" /home focused disabled');
    expect(el!.href).toBe('/home');
    expect([...el!.states].sort()).toEqual(['disabled', 'focused']);
  });

  it('still reads the fields it always read, with a full tail present', () => {
    const el = parseElementLine('  combobox e8 "State" ="Vic" [51 options] disabled');
    expect(el).toMatchObject({ role: 'combobox', label: 'State', value: 'Vic', optionCount: 51 });
    expect(el!.href).toBeUndefined();
  });
});

describe('splitRowLine', () => {
  it('splits quoted cells on the pipe separator', () => {
    expect(splitRowLine('"Order" | "Status" | "Stage"')).toEqual(['Order', 'Status', 'Stage']);
  });

  it('does not split on a pipe INSIDE a cell', () => {
    // The separator is only a separator outside a quoted cell. `split(' | ')`
    // would turn one cell into two and silently reshape the table.
    expect(splitRowLine('"a | b" | "c"')).toEqual(['a | b', 'c']);
  });

  it('keeps an empty cell as an empty cell', () => {
    expect(splitRowLine('"a" | ')).toEqual(['a', '']);
  });

  it('unescapes a quoted cell', () => {
    expect(splitRowLine('"He said \\"go\\"" | "x"')).toEqual(['He said "go"', 'x']);
  });
});

describe('applyObservation — table rows', () => {
  const table = [
    'main e1 "Roster"',
    '  table e2 "Shipments" 3x3',
    '    "Order" | "Status" | "Stage"',
    '    "#1001" | "PENDING" | "packing"',
    '    "#1002" | "PENDING" | "packing"',
    '  button e3 "Advance shipment"',
  ].join('\n');

  it('attaches the indented row lines to their table', () => {
    const m = new Map();
    applyObservation(m, table);
    expect(m.get('e2').rows).toEqual([
      ['Order', 'Status', 'Stage'],
      ['#1001', 'PENDING', 'packing'],
      ['#1002', 'PENDING', 'packing'],
    ]);
  });

  it('stops at the table\'s own indentation, so the next sibling survives', () => {
    const m = new Map();
    applyObservation(m, table);
    expect(m.get('e3')).toMatchObject({ role: 'button', label: 'Advance shipment' });
    expect(m.size).toBe(3);
  });

  it('does NOT treat a layout table\'s children as rows', () => {
    // A table holding links or buttons is not flattened (walker.ts:277): its
    // subtree is rendered as element lines. Reading those as rows would invent a
    // row AND lose an element — the second is the one that kills an agent.
    const m = new Map();
    applyObservation(
      m,
      ['table e1 "Cart"', '  "a stray text line"', '  button e2 "Remove"', 'button e3 "Checkout"'].join('\n'),
    );
    expect(m.get('e1').rows).toBeUndefined();
    expect(m.has('e2')).toBe(true);
    expect(m.has('e3')).toBe(true);
  });

  it('attaches rows inside an add subtree', () => {
    const m = new Map();
    applyObservation(m, ['+ under e1:', '  table e4 "T" 1x2', '    "a" | "b"', 'button e5 "After"'].join('\n'));
    expect(m.get('e4').rows).toEqual([['a', 'b']]);
    expect(m.has('e5')).toBe(true);
  });

  it('a full snapshot restates rows outright, replacing the old ones', () => {
    const m = new Map();
    applyObservation(m, table);
    applyObservation(
      m,
      [
        'FULL SNAPSHOT #2 — replaces all prior state for this page',
        'table e2 "Shipments" 3x3',
        '  "Order" | "Status" | "Stage"',
        '  "#1001" | "SHIPPED" | "dispatched"',
        '  "#1002" | "CANCELLED" | "voided"',
      ].join('\n'),
    );
    expect(m.get('e2').rows[1]).toEqual(['#1001', 'SHIPPED', 'dispatched']);
  });
});

describe('applyObservation — the update-line wire form for the blind fields', () => {
  // The reader half of tier2b P0. It must land in the same change set as the
  // renderer that emits these lines; against a build that emits neither, none of
  // this can fire, which is why it was safe to write first.

  it('an update carries a new href without disturbing the label', () => {
    const m = new Map();
    applyObservation(m, 'link e4 "Continue to checkout" /checkout');
    applyObservation(m, 'page #1.2 (diff from #1.1)\n~ e4 href=/checkout-v2');
    expect(m.get('e4')).toMatchObject({ label: 'Continue to checkout', href: '/checkout-v2' });
  });

  it('an update restates a table\'s rows and dims', () => {
    const m = new Map();
    applyObservation(m, ['table e7 "T" 3x2', '  "Order" | "Status"', '  "#1001" | "PENDING"', '  "#1002" | "PENDING"'].join('\n'));
    applyObservation(
      m,
      [
        'page #1.2 (diff from #1.1)',
        '~ e7 3x2:',
        '  "Order" | "Status"',
        '  "#1001" | "SHIPPED"',
        '  "#1002" | "CANCELLED"',
      ].join('\n'),
    );
    expect(m.get('e7').rows).toEqual([
      ['Order', 'Status'],
      ['#1001', 'SHIPPED'],
      ['#1002', 'CANCELLED'],
    ]);
    expect(m.get('e7').dims).toEqual({ rows: 3, cols: 2 });
  });

  it('an op line after a rows tail is still an op, not a row', () => {
    const m = new Map();
    applyObservation(m, ['table e7 "T" 1x1', '  "old"', 'button e8 "B"'].join('\n'));
    applyObservation(
      m,
      ['page #1.2 (diff from #1.1)', '~ e7 1x1:', '  "new"', '- e8 removed (was: button "B")'].join('\n'),
    );
    expect(m.get('e7').rows).toEqual([['new']]);
    expect(m.has('e8')).toBe(false);
  });

  it('an href token cannot smuggle a state flag into the model', () => {
    const m = new Map();
    applyObservation(m, 'link e4 "L" /a');
    applyObservation(m, '~ e4 href=/b+checked');
    expect(m.get('e4').href).toBe('/b+checked');
    expect(m.get('e4').states.size).toBe(0);
  });
});

/**
 * The round trip, against the real renderer.
 *
 * Everything above asserts the reader against hand-written lines, which proves
 * the reader self-consistent and nothing more. The wire is a contract between
 * two files nobody edits together: `src/core/snapshot/render.ts` writes it and
 * `bench/lib/streamModel.mjs` reads it, and the whole fidelity measurement is
 * void if they drift. These drive the ACTUAL diff engine and the ACTUAL
 * renderer and feed what comes out to the reader.
 *
 * tier2b P0 acceptance item 2. It lives in the bench reader's test file because
 * the claim under test is the reader's.
 */
describe('renderer → reader round trip', () => {
  const node = (over: Partial<SnapshotNode>): SnapshotNode =>
    ({
      role: 'generic',
      key: 'k',
      states: 0,
      frameId: 0,
      rect: [0, 0, 10, 10],
      children: [],
      ...over,
    }) as SnapshotNode;

  const table = (rows: string[][]) =>
    node({
      role: 'table',
      name: 'Shipments',
      key: 'I|0|table|shipments',
      rows,
      dims: { rows: rows.length, cols: rows[0]?.length ?? 0 },
    });

  const link = (href: string) =>
    node({ role: 'link', name: 'Continue to checkout', key: 'I|0|link|checkout', href });

  const page = (kids: SnapshotNode[]) =>
    node({ role: 'main', name: 'main', key: 'I|0|main|content', children: kids });

  const PENDING = [['Order', 'Status'], ['#1001', 'Pending'], ['#1002', 'Pending']];
  const SETTLED = [['Order', 'Status'], ['#1001', 'SHIPPED'], ['#1002', 'CANCELLED']];

  /**
   * A session in miniature: refs handed out over the base tree, the base tree
   * rendered into the model, then one diff applied on top. One registry
   * throughout, exactly as `observe()` keeps one.
   */
  function stream(before: SnapshotNode, after: SnapshotNode) {
    const reg = new RefRegistry();
    for (const n of [before, ...before.children]) reg.ensureRef(n);
    const model = new Map();
    applyObservation(
      model,
      [renderLine(before, 0), ...before.children.map((c) => renderLine(c, 1))]
        .filter(Boolean)
        .join('\n'),
    );
    const result = diffSnapshots(before, after, reg);
    const text = renderDiff(
      { seq: '1.1', baseSeq: '1.0', ops: result.ops, suppressed: 0, unreadChanges: 0 },
      reg,
    );
    return { model, text };
  }

  it('parses a rows restatement back to exactly the rows the engine sent', () => {
    const { model, text } = stream(page([table(PENDING)]), page([table(SETTLED)]));
    // Sanity: these really are the new wire bytes, not something else that
    // happens to make the assertion below pass.
    expect(text).toMatch(/^~ e\d+ 3x2:$/m);
    applyObservation(model, text);
    const t = [...model.values()].find((e: any) => e.role === 'table');
    expect(t.rows).toEqual(SETTLED);
    expect(t.dims).toEqual({ rows: 3, cols: 2 });
  });

  it('parses an href update back to the new target, label untouched', () => {
    const { model, text } = stream(page([link('/checkout')]), page([link('/checkout-v2')]));
    expect(text).toMatch(/href=\/checkout-v2/);
    applyObservation(model, text);
    const l = [...model.values()].find((e: any) => e.role === 'link');
    expect(l.href).toBe('/checkout-v2');
    expect(l.label).toBe('Continue to checkout');
  });

  it('reads the same rows whether they arrived by full snapshot or by update', () => {
    // One `renderRows` serves both spellings, so one reader rule serves both. If
    // they ever diverge, the reader holds a different table from the one the
    // agent was shown and no comparison can tell.
    const full = new Map();
    applyObservation(full, renderLine({ ...table(SETTLED), ref: 'e9' } as SnapshotNode, 0)!);
    const { model, text } = stream(page([table(PENDING)]), page([table(SETTLED)]));
    applyObservation(model, text);
    expect([...model.values()].find((e: any) => e.role === 'table').rows).toEqual(
      full.get('e9').rows,
    );
  });
});

describe('observation shape predicates', () => {
  it('classifies the three headers the engine emits', () => {
    expect(isFullSnapshot('FULL SNAPSHOT #2 — replaces all prior state for this page')).toBe(true);
    expect(isDiff('page #2.1 (diff from #2)')).toBe(true);
    // Both unchanged wordings, because one regex has to cover both: the engine
    // says which KIND of nothing happened, and the bench only cares that it was
    // nothing.
    expect(isNoChange('page #2.1 (unchanged — the action caused no visible change)')).toBe(true);
    expect(isNoChange('page #2.1 (unchanged — you already hold the current page)')).toBe(true);
    expect(isDiff('page #2.1 (unchanged — you already hold the current page)')).toBe(false);
  });

  it('and the notes an unchanged observation can carry do not defeat it', () => {
    expect(
      isNoChange(
        'page #2.1 (unchanged — you already hold the current page) ' +
          '(2 live-region updates suppressed; 1 changes in regions you have not read)',
      ),
    ).toBe(true);
  });

  it('does not classify the retired spelling, because nothing emits it now', () => {
    // Deliberately the retired spelling, written plainly. This file is out of
    // the release grep's scope precisely so this literal can stay readable:
    // the tripwire covers src/ and bench/, where a resurrection would matter,
    // and a stale *positive* assertion here would fail at runtime anyway,
    // because nothing emits this string any more.
    const retired = 'page #2.1 (no visible change)';
    expect(isNoChange(retired)).toBe(false);
    expect(isDiff(retired)).toBe(false);
    expect(isFullSnapshot(retired)).toBe(false);
  });

  it('spots a budget-truncated observation', () => {
    expect(isTruncated('…\n… 12 more lines beyond budget — use browser_find or browser_read to reach them')).toBe(true);
    expect(isTruncated('button e1 "Fine"')).toBe(false);
  });
});

describe('dedupeActions', () => {
  const ev = (at: number, bench: string, type: string, value?: string) => ({
    at, kind: 'action', detail: { bench, type, value },
  });

  it('folds the input event a click drags along with it', () => {
    // One click on a checkbox: the browser fires click AND input.
    const out = dedupeActions([ev(1000, 'digest', 'click'), ev(1008, 'digest', 'input', 'on')]);
    expect(out).toHaveLength(1);
    expect(out[0].detail.value).toBe('on'); // the later detail is kept
    expect(out[0].at).toBe(1000); // under the earlier timestamp
  });

  it('does NOT collapse repeated clicks on the same element', () => {
    // The bug this rule replaced: MCP round-trips land ~350ms apart, and a
    // plain same-element time window turned three deliberate clicks into one.
    const out = dedupeActions([
      ev(1000, 'up:alpha', 'click'),
      ev(1350, 'up:alpha', 'click'),
      ev(1700, 'up:alpha', 'click'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('keeps clicks on different elements apart however fast they arrive', () => {
    const out = dedupeActions([ev(1000, 'a', 'click'), ev(1005, 'b', 'input')]);
    expect(out).toHaveLength(2);
  });

  it('does not fold an input that arrives long after the click', () => {
    const out = dedupeActions([ev(1000, 'ref', 'click'), ev(4000, 'ref', 'input', 'x')]);
    expect(out).toHaveLength(2);
  });

  it('counts one `type` as one action however many input bursts it emits', () => {
    // Aperture clears the field before typing, so the witness sees a focus
    // click and then two separate debounced input bursts.
    const out = dedupeActions([
      ev(1000, 'email', 'click'),
      ev(1010, 'email', 'input', ''),
      ev(1600, 'email', 'input', 'dana@example.com'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].detail.value).toBe('dana@example.com');
  });

  it('folds a debounced input that arrived AFTER the next action', () => {
    // The real interleaving, copied from a verbose selftest run: the witness
    // debounces typing, so `input search` lands after `click add:...`.
    const out = dedupeActions([
      ev(1000, 'search', 'click'),
      ev(1226, 'add:usb-c-cable-1m', 'click'),
      ev(1226, 'search', 'input', 'cable'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.detail.bench)).toEqual(['search', 'add:usb-c-cable-1m']);
    expect(out[0].detail.value).toBe('cable');
  });

  it('a click after a typing burst is still its own action', () => {
    const out = dedupeActions([
      ev(1000, 'email', 'click'),
      ev(1010, 'email', 'input', 'x'),
      ev(1400, 'submit', 'click'),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('labelsAgree', () => {
  it('tolerates truncation and whitespace, and still catches a real mismatch', () => {
    expect(labelsAgree('Archive message from Priya Raman', 'Archive message from Priya…')).toBe(true);
    expect(labelsAgree('Select  Marcus   Webb', 'Select Marcus Webb')).toBe(true);
    expect(labelsAgree('Select Marcus Webb', 'Select Nina Holt')).toBe(false);
  });

  it('does not manufacture a mismatch when one side said nothing', () => {
    expect(labelsAgree('Archive', undefined)).toBe(true);
  });
});
