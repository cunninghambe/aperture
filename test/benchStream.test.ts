import { describe, expect, it } from 'vitest';
import {
  applyObservation,
  classifyObservation,
  isBareError,
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

  it('the reader can SEE the reachability words the walker now emits', () => {
    // Without an entry in STATE_WORDS this reader drops the word — and it
    // builds BOTH sides of every fidelity comparison, so a dropped state
    // compares stale-against-fresh as equal and no scenario could ever go red
    // on it. That is the propDelta blind-field failure exactly, one field
    // along, which is why tier6 §4.3 puts this row in the same change set as
    // the walker bits.
    const m = new Map();
    applyObservation(m, 'combobox e1 "Inert field"');
    applyObservation(m, '~ e1 +inert');
    expect(m.get('e1').states.has('inert')).toBe(true);
    applyObservation(m, '~ e1 -inert +no-pointer');
    expect(m.get('e1').states.has('inert')).toBe(false);
    expect(m.get('e1').states.has('no-pointer')).toBe(true);
    // And on a full-snapshot line, which is the other half of the wire.
    const f = new Map();
    applyObservation(f, 'button e2 "Ghost action" no-pointer');
    expect(f.get('e2').states.has('no-pointer')).toBe(true);
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
 * The update line, prefix-disambiguated (tier6 §3).
 *
 * WHAT WAS WRONG. `renderOp` pushed a name delta and a text delta as two BARE
 * quoted strings, and this reader resolved the ambiguity by convention — "first
 * remaining quoted string is the new name". That convention is not merely
 * unreadable, it is CORRUPTING: `<button aria-label="Close">×</button>` whose
 * text becomes `✕` emits `~ e1 "✕"`, and the reader — and, reading the same
 * legend, the model — overwrites the element's LABEL with `✕`. The element is
 * still called `Close`; the belief is now wrong, and nothing downstream ever
 * contradicts it. Name and text diverge whenever the accessible name comes from
 * aria-* or from descendants, which is most real buttons.
 *
 * THE RULE NOW. On a `~` line a bare quoted string is always and only the new
 * accessible NAME; the inner-text change is spelled `text "…"`. `=` keeps
 * value, `href=` keeps href, `RxC:` keeps rows — the grammar is fully
 * prefix-disambiguated, and the reader decides by the token BEFORE each quoted
 * string rather than by position.
 */
describe('applyObservation — a bare string is the name, `text` is the text', () => {
  it('a bare quoted string still updates the label', () => {
    // The kept behaviour. Green before and after — it is what says the rows
    // below are not passing by breaking the ordinary case.
    const m = new Map();
    applyObservation(m, 'button e1 "Save"');
    applyObservation(m, '~ e1 "Saved"');
    expect(m.get('e1').label).toBe('Saved');
  });

  it('a `text` delta on an aria-labelled button does NOT touch the label', () => {
    // THE CORRUPTION, pinned. The probe measured this misapply against HEAD.
    const m = new Map();
    applyObservation(m, 'button e1 "Close"');
    applyObservation(m, '~ e1 text "✕"');
    expect(m.get('e1').label).toBe('Close');
    expect(m.get('e1').text).toBe('✕');
  });

  it('a `text` delta on a text-role entry DOES update its label', () => {
    // The displayed string of a text line IS its text, so for role `text` the
    // two are the same fact. The renderer emits the uniform token either way;
    // the ROLE decides what it means, and the reader is where that lives.
    const m = new Map();
    applyObservation(m, 'text e2 "12 products"');
    expect(m.get('e2').role).toBe('text');
    applyObservation(m, '~ e2 text "7 products"');
    expect(m.get('e2').label).toBe('7 products');
  });

  it('a name whose own content ends in `text ` cannot be mistaken for the token', () => {
    // WHY A SCANNER AND NOT ANOTHER REGEX PASS. Excision is what made the
    // misparse possible in the first place, and no single-pass regex survives a
    // label that ENDS in the token's own spelling. The scanner reads quoted
    // strings as units and looks at the token immediately before each, which is
    // unambiguous by construction.
    const m = new Map();
    applyObservation(m, 'button e3 "x"');
    applyObservation(m, '~ e3 "x text " text "T"');
    expect(m.get('e3').label).toBe('x text ');
    expect(m.get('e3').text).toBe('T');
  });

  it('does NOT move the label of an entry whose role the model never learned', () => {
    // The role gate is `role === 'text'`, and the tempting widening is
    // `|| role === '?'` — "we do not know what it is, so treat the displayed
    // string as the label". That re-acquires exactly the default this fix
    // removed, on the entries LEAST able to survive it.
    //
    // `?` is not hypothetical: `applyObservation` manufactures it for any `~ eN`
    // naming a ref the model does not hold — after a `gone` it applied, after a
    // compaction, or on the first update for a ref allocated mid-diff. And
    // fidelity.mjs excuses href/rows for role `?` but still COMPARES the label,
    // so a misapply here reads as a wrong-element belief about a real page.
    const m = new Map();
    applyObservation(m, '~ e9 text "✕"');
    expect(m.get('e9').role).toBe('?');
    expect(m.get('e9').label).toBe('');
    expect(m.get('e9').text).toBe('✕');
  });

  it('quoted content in a `text` delta still injects no state flag', () => {
    // The state loop runs after ALL quoted content is consumed, so page text
    // reading `+checked disabled` cannot become a state. Unchanged contract,
    // re-asserted through the new scanner because the scanner is what enforces
    // it now.
    const m = new Map();
    applyObservation(m, 'button e4 "B"');
    applyObservation(m, '~ e4 text "body text +checked disabled"');
    expect(m.get('e4').states.size).toBe(0);
    expect(m.get('e4').label).toBe('B');
  });

  it('value, name and text on one line each land where they belong', () => {
    const m = new Map();
    applyObservation(m, 'textbox e5 "Email" ="a@b.c"');
    applyObservation(m, '~ e5 "Email address" ="x@y.z" text "hint" +focused');
    expect(m.get('e5')).toMatchObject({
      label: 'Email address', value: 'x@y.z', text: 'hint',
    });
    expect(m.get('e5').states.has('focused')).toBe(true);
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

  it('a text-only delta round-trips without touching the label', () => {
    // THE CORRUPTION, end to end through the real engine and the real renderer:
    // an aria-labelled button whose inner text alone changes. Against the old
    // wire this line was `~ eN "✕"` and the reader applied it as a rename. The
    // renderer and the reader are two ends of ONE wire and are edited by nobody
    // together, which is why this row drives both rather than a hand-written
    // line.
    const closer = (t: string) =>
      node({ role: 'button', name: 'Close', key: 'I|0|button|close', text: t });
    const { model, text } = stream(page([closer('×')]), page([closer('✕')]));
    expect(text).toMatch(/^~ e\d+ text "✕"$/m);
    applyObservation(model, text);
    const b = [...model.values()].find((e: any) => e.role === 'button');
    expect(b.label).toBe('Close');
    expect(b.text).toBe('✕');
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

/**
 * The G3 error kind (docs/design/wave3-evaluation.md §1.4, implemented by
 * tier4.md §2).
 *
 * F5 was recorded INFRA on wave 3: an agent pressed an unsupported key, the
 * engine answered with a one-line `error:` that carries no page bytes at all,
 * and the re-dump arm's purity guard counted it as an impurity — an apparatus
 * stop for a reply both arms can receive identically. The fix is a fifth kind,
 * and the reason it is SAFE is a tools.ts invariant (ATOMICITY SEAM 3): a
 * dispatch-free validation reply is one line; every page-embedding reply is
 * multi-line behind an `untrusted(...)` envelope. These tests are what pins
 * that invariant from the bench side.
 *
 * The whitelist property — anything unrecognised still trips G3 — is preserved
 * exactly where it matters, and the multi-line case below is the proof.
 */
describe('classifyObservation — the taxonomy, including the error kind', () => {
  it('classifies a single-line validation error as `error`', () => {
    expect(isBareError('error: unsupported key: F5')).toBe(true);
    expect(classifyObservation('error: unsupported key: F5')).toBe('error');
  });

  it('classifies a page-EMBEDDING error as `full`, whatever its first line says', () => {
    // Precedence is the whole design: page-shaped bytes win. An arm-purity
    // route that let a reply carrying a FULL SNAPSHOT through because it
    // started with "error:" would be the F5 fix creating a worse F5.
    const text =
      'error: e3 could not be acted on (gone).\n' +
      'The page as it stands now:\n' +
      'FULL SNAPSHOT #4 — replaces all prior state for this page\n' +
      'button e9 "Retry"';
    expect(isBareError(text)).toBe(false);
    expect(classifyObservation(text)).toBe('full');
  });

  it('leaves the walk-timeout reply as `other` — the G6b quarantine still owns it', () => {
    expect(classifyObservation('could not read the page (walk timed out)')).toBe('other');
  });

  it('leaves a MULTI-LINE bare error as `other`, so it still trips G3', () => {
    // The whitelist property, preserved exactly where it matters: if tools.ts
    // ever grows a multi-line validation reply, this classification is a
    // breaking change and the guard says so instead of waving it through.
    expect(classifyObservation('error: something\nsecond line')).toBe('other');
  });

  it('keeps the page-shape kinds unchanged', () => {
    expect(classifyObservation('FULL SNAPSHOT #2 — replaces all prior state for this page')).toBe('full');
    expect(classifyObservation('page #2.1 (diff from #2.0)')).toBe('diff');
    expect(classifyObservation('page #2.1 (unchanged — you already hold the current page)')).toBe('nochange');
  });

  it('does not treat a bare `error` without the colon-space as the error kind', () => {
    expect(isBareError('errors: 3 found')).toBe(false);
    expect(classifyObservation('errors: 3 found')).toBe('other');
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
