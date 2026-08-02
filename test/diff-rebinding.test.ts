import { describe, expect, it } from 'vitest';
import { RefRegistry, assignRefs } from '../src/core/snapshot/registry.js';
import { diffSnapshots } from '../src/core/snapshot/diff.js';
import { renderDiff } from '../src/core/snapshot/render.js';
import type { DiffOp, SnapshotNode } from '../src/core/snapshot/types.js';

/**
 * P2 — a positional family that GAINS a member must restate its container.
 *
 * PROVENANCE. Origin: docs/design/tier3.md §8 probe 2 (2026-08-02), the
 * evidence behind the no-insert-task ruling. Re-verified by throwaway vitest
 * against `diff.ts` at `f37a5db` for docs/design/tier4.md §1.1, and promoted to
 * a permanent regression here by wave3-evaluation.md §6 step 3. The RED/GREEN
 * ordering below is part of the evidence, not decoration:
 *
 *   - Cases 1-3 and 5 were authored and run against the UNEDITED `diff.ts`
 *     FIRST, where they FAILED with `op: 'add'` — case 1 with
 *     `{ op: 'add', parent: 'e2', after: 'e10' }` and the wire `+ after e10:`,
 *     `e10` being a row at the BOTTOM of the list while the page prepended at
 *     the TOP. Not merely silent: actively wrong-ended.
 *   - Cases 7-8 were authored and run against the UNEDITED `diff.ts` FIRST,
 *     where they PASSED — which is what makes them evidence. They encode the
 *     PRE-FIX removal behaviour (P1, tier2b), byte for byte, so that they can
 *     only stay green if the P2 addition left the removal path untouched.
 *     `positionalFamilyLostAMember` is not edited by this change; these are the
 *     assertion that says so mechanically rather than by review.
 *
 * THE DEFECT, in one sentence. `disambiguate` (walker.ts) leaves the first
 * occurrence of a key bare and suffixes the rest `|#1`, `|#2`… — so for rows
 * that are content-identical to the walker, identity IS the ordinal. Insert one
 * at the top and every held ref silently rebinds one row down: the key SET is
 * unchanged, every survivor still resolves, and the only op emitted claims an
 * insertion at the far end of the list.
 *
 * WHY THE KEY SET CANNOT DO BETTER (and why case 2 expects a "wrong" answer).
 * A prepend and an append produce the SAME key strings in the same order — the
 * suffix is a document-order ordinal recomputed each walk, so the new member is
 * always the highest ordinal wherever it physically landed. Case 2 asserts that
 * identity directly. So the choice is a bounded false positive on appends or a
 * silent rebinding on prepends, and tier4 §1.4 rules for the former.
 *
 * NOT COVERED, DELIBERATELY (tier4 §1.4 residual 1): equal-size same-walk churn
 * — one identical row removed and another inserted between two observations —
 * is undetectable in principle at the key layer, because the key set, the family
 * size and every per-key property are all unchanged. There is no assertion here
 * for it because there is no mechanism for it; it is stated rather than covered.
 *
 * Nothing here reads the DOM. Constructed nodes, in the style of
 * `diff-blindfields.test.ts`, so this is a fast permanent regression rather than
 * a fixture. The live half is Builder A's G15 (`test/fixtures/prepend.html` +
 * `bench/guards.mjs`), recorded RED in docs/design/g15-red-record.md.
 */

// --- constructed nodes -------------------------------------------------------

/**
 * The S-tier keys `disambiguate` produces for content-identical rows: same
 * role, no accessible name, no sibling discriminator, so the ONLY separation
 * available is the document-order ordinal (walker.ts:342-368, 375-398).
 */
const ROW_BASE = 'S|0|listitem||list:tickets|list';
const BTN_BASE = 'S|0|button|take|list:tickets|list>listitem';

const ord = (base: string, i: number): string => (i === 0 ? base : `${base}|#${i}`);

/** One `<li><span>Ticket</span><button>Take</button></li>`, keyed positionally. */
function row(i: number, rowBase = ROW_BASE, btnBase = BTN_BASE): SnapshotNode {
  return {
    role: 'listitem',
    key: ord(rowBase, i),
    states: 0,
    frameId: 0,
    rect: [0, 20 * i, 300, 20],
    text: 'Ticket',
    children: [
      {
        role: 'button',
        name: 'Take',
        key: ord(btnBase, i),
        states: 0,
        frameId: 0,
        rect: [220, 20 * i, 60, 20],
        children: [],
      },
    ],
  };
}

function list(
  count: number,
  opts: { key?: string; name?: string; rowBase?: string; btnBase?: string } = {},
): SnapshotNode {
  return {
    role: 'list',
    name: opts.name ?? 'Tickets',
    key: opts.key ?? 'I|0|list|tickets',
    states: 0,
    frameId: 0,
    rect: [0, 0, 300, 20 * count],
    children: Array.from({ length: count }, (_, i) =>
      row(i, opts.rowBase ?? ROW_BASE, opts.btnBase ?? BTN_BASE),
    ),
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

/**
 * Diff two trees the way `engine.ts` does: refs assigned across each fresh walk
 * before it is diffed (engine.ts:206), then `diffSnapshots` with the default
 * `wasEmitted` — the model has been shown the page, which is the only state in
 * which a rebinding can hurt it.
 */
function observe(
  before: SnapshotNode,
  after: SnapshotNode,
): { reg: RefRegistry; ops: DiffOp[]; wire: string } {
  const reg = new RefRegistry();
  assignRefs(before, reg);
  assignRefs(after, reg);
  const { ops } = diffSnapshots(before, after, reg);
  // `commit: false` — the recorded bytes stay a pure function of the diff
  // rather than of how many times a test rendered it.
  const wire = renderDiff(
    { seq: '1.1', baseSeq: '1.0', ops, suppressed: 0, unreadChanges: 0 },
    reg,
    false,
  );
  return { reg, ops, wire };
}

/**
 * Op shape with the anchor kept and the subtree dropped.
 *
 * The anchor is kept ON PURPOSE: it is what makes the pre-fix failure output
 * name the wrong end of the list instead of merely saying "add, expected
 * replace". That failure text is the RED record.
 */
const shapeOf = (ops: DiffOp[]): Record<string, unknown>[] =>
  ops.map((o) => ({
    op: o.op,
    ...('after' in o ? { after: o.after } : {}),
  }));

type Replace = { op: 'replace'; ref: string; subtree: SnapshotNode; gone?: string[] };

// --- 1-3, 5: growth (RED against the unedited diff.ts) -----------------------

describe('P2 — growth of a positional family escalates to one replace', () => {
  it('1. prepending into a 6-row identical family restates the family', () => {
    // RED, pre-fix: ops === [{ op: 'add', parent: 'e2', after: 'e10' }] and the
    // wire read `+ after e10:` — one op, pointing at the BOTTOM of a list that
    // grew at the TOP, while all six held refs quietly moved down a row.
    const { reg, ops, wire } = observe(page([list(6)]), page([list(7)]));

    expect(shapeOf(ops)).toEqual([{ op: 'replace' }]);

    const replace = ops[0] as Replace;
    expect(replace.ref).toBe(reg.byKeyLookup('I|0|list|tickets')?.ref);
    // All seven rows restated, so every ordinal the model holds is re-derivable
    // from this one observation.
    expect(replace.subtree.children).toHaveLength(7);
    // Pure growth kills nothing, so the `gone` suffix is empty and the existing
    // renderer already spells that as no suffix at all (render.ts:438-440).
    // This is the "zero new wire vocabulary" property, asserted (tier4 §1.3.2).
    expect(replace.gone ?? []).toEqual([]);
    expect(wire.split('\n')[1]).toMatch(/^! e\d+ replaced:$/);
    expect(wire).not.toContain('gone:');
    expect(wire).not.toContain('+ after');
  });

  it('2. an append is indistinguishable from a prepend, and is restated too', () => {
    // THE POINT, and the accepted cost. The ordinal is recomputed in document
    // order on every walk, so the new member is the highest suffix wherever it
    // physically landed: the two trees are the same tree.
    const prepended = page([list(7)]);
    const appended = page([list(7)]);
    const keysOf = (n: SnapshotNode): string[] => [
      n.key,
      ...n.children.flatMap(keysOf),
    ];
    expect(keysOf(prepended)).toEqual(keysOf(appended));

    const { ops } = observe(page([list(6)]), appended);
    expect(shapeOf(ops)).toEqual([{ op: 'replace' }]);
    expect((ops[0] as Replace).subtree.children).toHaveLength(7);
  });

  it('3. a family BORN around a held ref escalates too (1 -> 2 growth)', () => {
    // RED, pre-fix: one `add`. The bare key silently changed owner — the single
    // element the model read is now the SECOND of two, and nothing said so. The
    // hole was never confined to pre-existing families.
    const { reg, ops } = observe(page([list(1)]), page([list(2)]));

    expect(shapeOf(ops)).toEqual([{ op: 'replace' }]);
    expect((ops[0] as Replace).ref).toBe(reg.byKeyLookup('I|0|list|tickets')?.ref);
    expect((ops[0] as Replace).subtree.children).toHaveLength(2);
  });

  it('5. growth of one family leaves an untouched sibling family alone', () => {
    // The economics guard, and the scoping claim. Escalating both containers
    // would turn any page with two identical-row lists into a double re-dump on
    // every insert.
    const alpha = (n: number): SnapshotNode =>
      list(n, {
        key: 'I|0|list|alpha',
        name: 'Alpha',
        rowBase: 'S|0|listitem||list:alpha|list',
        btnBase: 'S|0|button|take|list:alpha|list>listitem',
      });
    const beta = (n: number): SnapshotNode =>
      list(n, {
        key: 'I|0|list|beta',
        name: 'Beta',
        rowBase: 'S|0|listitem||list:beta|list',
        btnBase: 'S|0|button|take|list:beta|list>listitem',
      });

    const { reg, ops } = observe(
      page([alpha(2), beta(2)]),
      page([alpha(3), beta(2)]),
    );

    expect(shapeOf(ops)).toEqual([{ op: 'replace' }]);
    expect((ops[0] as Replace).ref).toBe(reg.byKeyLookup('I|0|list|alpha')?.ref);
    expect((ops[0] as Replace).ref).not.toBe(reg.byKeyLookup('I|0|list|beta')?.ref);
  });
});

// --- 4, 6: the negatives (green before and after) ----------------------------

describe('P2 — what must NOT escalate', () => {
  it('4. a family born where nothing was held is a plain add', () => {
    // No survivor means no ref whose binding could have shifted: the model was
    // never shown a member of this family, so there is nothing to restate. A
    // predicate that fired here would restate a container every time an empty
    // list first filled — the commonest page event there is.
    const { ops } = observe(page([list(0)]), page([list(2)]));

    expect(ops.every((o) => o.op === 'add')).toBe(true);
    expect(ops.some((o) => o.op === 'replace')).toBe(false);
    expect(ops).toHaveLength(2);
  });

  it('6. an add to a family-free container is a plain add', () => {
    // Distinct names, so `disambiguate` never reaches for an ordinal and no key
    // carries `|#`. A feed of distinctly-titled items pays one `add`, exactly as
    // it did before this change (tier4 §1.4).
    const named = (n: string): SnapshotNode => ({
      role: 'listitem',
      key: `S|0|listitem|${n}|list:tickets|list`,
      states: 0,
      frameId: 0,
      rect: [0, 0, 300, 20],
      text: n,
      children: [],
    });
    const container = (kids: SnapshotNode[]): SnapshotNode => ({
      role: 'list',
      name: 'Tickets',
      key: 'I|0|list|tickets',
      states: 0,
      frameId: 0,
      rect: [0, 0, 300, 60],
      children: kids,
    });

    const { ops } = observe(
      page([container([named('alpha'), named('bravo')])]),
      page([container([named('alpha'), named('bravo'), named('charlie')])]),
    );

    expect(shapeOf(ops).map((o) => o.op)).toEqual(['add']);
  });
});

// --- 7, 8: the GREEN-STABLE set — removal behaviour, pinned ------------------

/**
 * These two ran GREEN against the UNEDITED `diff.ts` before P2 was written, and
 * the literals below were captured from that run. They are not "tests of the new
 * feature": they are the pin that says the new feature changed nothing on the
 * path that was already working. tier4 §1.3 constraint 1 —
 * `positionalFamilyLostAMember` is not edited, not one byte — is checkable by
 * inspection; this is the half that is checkable by execution.
 */
describe('P1 — removal behaviour is byte-identical, before and after P2', () => {
  /** Captured verbatim from the pre-P2 run (tier3 §8 probe 2's second half). */
  const P1_REMOVAL_WIRE = [
    'page #1.1 (diff from #1.0)',
    '! e2 replaced (gone: e9):',
    '  list e2 "Tickets"',
    '    listitem',
    '      button e3 "Take"',
    '    listitem',
    '      button e4 "Take"',
    '    listitem',
    '      button e5 "Take"',
    '    listitem',
    '      button e6 "Take"',
    '    listitem',
    '      button e7 "Take"',
    '    listitem',
    '      button e8 "Take"',
  ].join('\n');

  it('7. a 7 -> 6 removal produces the recorded ops and the recorded wire', () => {
    const { reg, ops, wire } = observe(page([list(7)]), page([list(6)]));

    // Deep-equal to the recorded P1 baseline: ONE replace, and the `gone` list
    // naming exactly the ordinal that no longer exists.
    expect(ops.map((o) => ({ ...o, subtree: undefined }))).toEqual([
      { op: 'replace', ref: 'e2', gone: ['e9'], subtree: undefined },
    ]);
    expect(reg.byKeyLookup('I|0|list|tickets')?.ref).toBe('e2');
    expect(reg.byKeyLookup(ord(BTN_BASE, 6))?.ref).toBe('e9');

    // And byte-equal on the wire. The wave-3 fixtures are removals-only by
    // construction (queue.html's header, tier3 §3.1.2), so this is the unit
    // half of tier4 §1.7's three-way byte-identity check — the half that runs
    // on every `npm test` rather than only under `--selftest`.
    expect(wire).toBe(P1_REMOVAL_WIRE);
  });

  it('8. two successive removals fire P1 each time, with no P2 contribution', () => {
    // A removals-only sequence is what every wave-3 fixture is. If P2 could
    // reach a removal at all, a second consecutive removal is where a survivor
    // -plus-new-key misreading would surface; the op count and shape are flat.
    const reg = new RefRegistry();
    const seven = page([list(7)]);
    const six = page([list(6)]);
    const five = page([list(5)]);
    assignRefs(seven, reg);
    assignRefs(six, reg);
    const first = diffSnapshots(seven, six, reg);
    assignRefs(five, reg);
    const second = diffSnapshots(six, five, reg);

    for (const [label, r] of [
      ['first', first],
      ['second', second],
    ] as const) {
      expect(r.ops, label).toHaveLength(1);
      expect(r.ops[0]!.op, label).toBe('replace');
      expect((r.ops[0] as Replace).ref, label).toBe('e2');
      // No add anywhere: a P2 that leaked onto the removal path would not add
      // ops here, it would change which predicate fired — so the assertion that
      // matters is that the op count never moves off one.
      expect(r.ops.some((o) => o.op === 'add'), label).toBe(false);
    }

    // The dying ordinal, named each time: |#6 then |#5.
    expect((first.ops[0] as Replace).gone).toEqual(['e9']);
    expect((second.ops[0] as Replace).gone).toEqual(['e8']);
  });
});
