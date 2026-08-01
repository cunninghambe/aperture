import { describe, expect, it } from 'vitest';
import { RefRegistry } from '../src/core/snapshot/registry.js';
import { diffSnapshots } from '../src/core/snapshot/diff.js';
import { renderDiff, renderLine } from '../src/core/snapshot/render.js';
import type { SnapshotNode } from '../src/core/snapshot/types.js';

/**
 * Origin: external-review probe, 2026-08-01
 * (docs/design/review-external-2026-08-01.md §1). These four cases executed
 * against f4cd2e2 with inverted expectations: rows-change and href-change
 * produced ZERO ops. They are the regression tests for that bug.
 *
 * The chain the probe established, link by link: the walker flattens a data
 * table with no interactive descendant to `rows` and empties its `children`
 * (walker.ts); `propDelta` compared five fields and never read `rows` or
 * `href`; the childless early return in `walk()` therefore ended the walk with
 * zero ops; the zero-op path in `observe()` answered "unchanged — the action
 * caused no visible change" AND replaced the baseline with the new tree — so
 * the next diff compared the updated tree against itself and the change was
 * unreportable for the rest of the session.
 *
 * Nothing here reads the DOM: the probe worked on constructed nodes, which is
 * what makes it a fast permanent regression test rather than a fixture.
 */

const reg = (): RefRegistry => new RefRegistry();

function table(rows: string[][]): SnapshotNode {
  return {
    role: 'table',
    name: 'Shipments',
    key: 'I|0|table|shipments',
    states: 0,
    frameId: 0,
    rect: [0, 0, 400, 120],
    rows,
    dims: { rows: rows.length, cols: rows[0]?.length ?? 0 },
    children: [],
  };
}

function link(href: string): SnapshotNode {
  return {
    role: 'link',
    name: 'Continue to checkout',
    key: 'I|0|link|checkout',
    states: 0,
    frameId: 0,
    rect: [0, 200, 160, 20],
    href,
    children: [],
  };
}

function page(kids: SnapshotNode[]): SnapshotNode {
  return {
    role: 'main',
    name: 'main',
    key: 'I|0|main|content',
    states: 0,
    frameId: 0,
    rect: [0, 0, 800, 600],
    children: kids,
  };
}

const PENDING = [
  ['Order', 'Status'],
  ['#1001', 'Pending'],
  ['#1002', 'Pending'],
];
const SETTLED = [
  ['Order', 'Status'],
  ['#1001', 'SHIPPED'],
  ['#1002', 'CANCELLED'],
];

// (a) ------------------------------------------------------------------------

describe('a flattened table whose cells changed', () => {
  it('is reported as one update carrying the new rows', () => {
    // Probed against f4cd2e2: ops: [], unreadChanges: 0, suppressed: 0. Zero
    // signal on every channel, including the caveat channels.
    const r = reg();
    const result = diffSnapshots(page([table(PENDING)]), page([table(SETTLED)]), r);

    expect(result.ops).toHaveLength(1);
    const op = result.ops[0]!;
    expect(op.op).toBe('update');
    expect((op as { delta: { rows?: string[][] } }).delta.rows).toEqual(SETTLED);
  });

  it('renders the restated rows in the row format a full snapshot uses', () => {
    const r = reg();
    const result = diffSnapshots(page([table(PENDING)]), page([table(SETTLED)]), r);
    const text = renderDiff(
      { seq: '1.1', baseSeq: '1.0', ops: result.ops, suppressed: 0, unreadChanges: 0 },
      r,
    );

    const lines = text.split('\n');
    expect(lines[1]).toMatch(/^~ e\d+ 3x2:$/);
    expect(lines.slice(2)).toEqual([
      '  "Order" | "Status"',
      '  "#1001" | "SHIPPED"',
      '  "#1002" | "CANCELLED"',
    ]);

    // The same rows, in the same spelling, as the table's own line in a full
    // snapshot — one `renderRows` serves both, so a reader parses one rule.
    const full = renderLine(table(SETTLED), 0)?.split('\n').slice(1);
    expect(full).toEqual(lines.slice(2));
  });

  it('reports a table that emptied', () => {
    // The one asymmetric case child reconciliation cannot cover: no rows and
    // no children on the new side means nothing else would say the data went.
    const r = reg();
    const gone: SnapshotNode = { ...table(PENDING) };
    delete gone.rows;
    delete gone.dims;
    const result = diffSnapshots(page([table(PENDING)]), page([gone]), r);
    expect(result.ops).toHaveLength(1);
    expect((result.ops[0] as { delta: { rows?: string[][] } }).delta.rows).toEqual([]);
  });

  it('says nothing when a change elsewhere on the page leaves the table alone', () => {
    // The economics guard. A restatement that fires on unrelated changes turns
    // every observation on a page containing a table into a 50-row re-dump.
    const r = reg();
    const heading = (t: string): SnapshotNode => ({
      role: 'heading', name: t, key: 'I|0|heading|h', states: 0, frameId: 0,
      rect: [0, 0, 100, 20], headingLevel: 1, children: [],
    });
    const result = diffSnapshots(
      page([heading('Shipments'), table(PENDING)]),
      page([heading('Shipments (2)'), table(PENDING)]),
      r,
    );
    expect(result.ops).toHaveLength(1);
    expect((result.ops[0] as { ref: string }).ref).toBe(r.byKeyLookup('I|0|heading|h')?.ref);
  });

  it('is suppressible like any other live region', () => {
    // A self-ticking table must be able to earn suppression the way a clock
    // does. This is why rows ride an `update` and not a `replace`: only
    // updates reach the volatility path, and a rows-only delta has no state
    // bits, so it is contentOnly and takes the same demotion route.
    const r = reg();
    const result = diffSnapshots(page([table(PENDING)]), page([table(SETTLED)]), r, {
      isVolatile: (key) => key === 'I|0|table|shipments',
    });
    expect(result.ops).toHaveLength(0);
    expect(result.suppressed).toBe(1);
  });
});

// (b) ------------------------------------------------------------------------

describe('an href that moved under a stable label', () => {
  it('is reported as one update carrying the new target', () => {
    // Probed against f4cd2e2: ops: []. The ref stayed live and correct, the
    // page-side index resolved it to the element, and a click landed on the
    // element's CURRENT target while the agent's belief was the href it read
    // in the last full snapshot. Nothing in the stream ever contradicted it.
    const r = reg();
    const result = diffSnapshots(
      page([link('/checkout')]),
      page([link('/phish-target')]),
      r,
    );

    expect(result.ops).toHaveLength(1);
    const op = result.ops[0]!;
    expect(op.op).toBe('update');
    expect((op as { delta: { href?: [string, string] } }).delta.href).toEqual([
      '/checkout',
      '/phish-target',
    ]);
  });

  it('renders the new target as an unquoted href= token', () => {
    const r = reg();
    const result = diffSnapshots(page([link('/checkout')]), page([link('/checkout-v2')]), r);
    const text = renderDiff(
      { seq: '1.1', baseSeq: '1.0', ops: result.ops, suppressed: 0, unreadChanges: 0 },
      r,
    );
    // Unquoted is safe by construction: sanitizeHref has already stripped
    // whitespace, control characters and bidi overrides and capped the length,
    // so the token cannot break the line or the reader parsing it.
    expect(text.split('\n')[1]).toMatch(/^~ e\d+ href=\/checkout-v2$/);
  });

  it('is reported even when the label is byte-identical', () => {
    // The whole point. A label change would have been reported all along.
    const r = reg();
    const before = link('/checkout');
    const after = link('/phish-target');
    expect(before.name).toBe(after.name);
    expect(before.key).toBe(after.key);
    expect(diffSnapshots(page([before]), page([after]), r).ops).toHaveLength(1);
  });
});

// (c) ------------------------------------------------------------------------

describe('the baseline-replacement unreportability case', () => {
  it('is unreachable: the first diff is non-empty, so no baseline is absorbed', () => {
    // The probe simulated the engine's zero-op path: first diff [], then the
    // new tree became the baseline, then the second diff compared it against
    // itself — [] again, permanently. The chain begins with a false zero-op
    // diff, and there is no longer one to begin it.
    const r = reg();
    const first = diffSnapshots(page([table(PENDING)]), page([table(SETTLED)]), r);
    expect(first.ops.length).toBeGreaterThan(0);

    // And the change stays reported from the state that was actually delivered.
    const second = diffSnapshots(page([table(SETTLED)]), page([table(SETTLED)]), r);
    expect(second.ops).toHaveLength(0);
  });

  it('still produces zero ops for two identical trees', () => {
    // The complement, and the assertion that keeps the fix honest: "unchanged"
    // has to keep meaning unchanged, or the completeness sentence buys its
    // truth with noise.
    const r = reg();
    const tree = page([table(SETTLED), link('/checkout')]);
    const result = diffSnapshots(tree, page([table(SETTLED), link('/checkout')]), r);
    expect(result.ops).toHaveLength(0);
    expect(result.suppressed).toBe(0);
    expect(result.unreadChanges).toBe(0);
  });
});

// (d) ------------------------------------------------------------------------

describe('control: the blindness was field-specific, not a harness artifact', () => {
  it('reports the same change carried in text', () => {
    const r = reg();
    const cell = (t: string): SnapshotNode => ({
      role: 'text', text: t, key: 'S|0|text|status', states: 0, frameId: 0,
      rect: [0, 0, 80, 20], children: [],
    });
    const result = diffSnapshots(page([cell('Pending')]), page([cell('SHIPPED')]), r);
    expect(result.ops).toHaveLength(1);
    expect((result.ops[0] as { delta: { text?: [string, string] } }).delta.text).toEqual([
      'Pending',
      'SHIPPED',
    ]);
  });
});
