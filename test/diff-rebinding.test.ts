import { describe, expect, it } from 'vitest';
import { RefRegistry, assignRefs } from '../src/core/snapshot/registry.js';
import { diffSnapshots, retirePositionalRebinds } from '../src/core/snapshot/diff.js';
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
 *
 * ---
 *
 * APPENDED 2026-08-03 — tier5 moved the removal-path pins, and this paragraph
 * is the record of why the literals above changed. `docs/design/tier5.md` §6.3
 * authorises it explicitly and it is the one place tier5 supersedes tier4: the
 * removal path is changed ON PURPOSE, so cases 1, 7 and 8 are RE-SPECIFIED
 * rather than repaired. Restating a family while re-emitting the same ref
 * numbers was the removal-side half of the positional hole — `gone` named only
 * the tail ordinal, every survivor's key silently re-bound to whatever row slid
 * into its position, and the head-to-head cohort measured the cost
 * (`docs/design/h2h-evaluation.md` §2). Since tier5 a membership change retires
 * the family's whole ref generation (`retirePositionalRebinds`) and the
 * restatement carries fresh numbers.
 *
 * Two honest notes about that re-pin, because leaving them out would make this
 * file read stronger than it is:
 *
 *   - The `observe` helper above did NOT call the pre-pass until this change,
 *     so cases 1/7/8 were still GREEN on the post-tier5 engine when the fix
 *     landed. Nothing forced the re-pin; it was made because a helper that
 *     skips the engine's own ordering pins a configuration the product never
 *     runs, and those three cases would have stayed green with the retirement
 *     deleted.
 *   - The historical RED/GREEN record above stands as history and is not
 *     rewritten. Cases 7-8 were authored against the pre-P2 build and passed
 *     there; that fact is still true and is still what they were for. What they
 *     pin from today is the post-tier5 removal wire.
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
 * Diff two trees the way `engine.ts` does: the positional pre-pass over the two
 * consecutive walks FIRST (engine.ts, before `assignRefs` — tier5 §2.3, and the
 * ordering IS the mechanism, because `assignRefs` revives by key), then refs
 * assigned across the fresh walk, then `diffSnapshots` with the default
 * `wasEmitted` — the model has been shown the page, which is the only state in
 * which a rebinding can hurt it.
 *
 * The pre-pass call was added by tier5 §6.3. Without it this helper measured
 * `diff.ts` in a configuration the product never runs, and cases 1/7/8 below
 * stayed green whether or not the retirement existed at all.
 */
function observe(
  before: SnapshotNode,
  after: SnapshotNode,
): { reg: RefRegistry; ops: DiffOp[]; wire: string } {
  const reg = new RefRegistry();
  assignRefs(before, reg);
  const retired = retirePositionalRebinds(before, after, reg);
  assignRefs(after, reg);
  const { ops } = diffSnapshots(before, after, reg, {
    retiredRef: (key) => retired.get(key),
  });
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
    // RE-PINNED BY TIER5 §6.3 (was: `gone` empty, no suffix on the wire).
    // Growth kills no ELEMENT, but it retires an entire ref GENERATION: the six
    // refs the model held all re-bound one row down, so all six are dead and the
    // seven restated rows carry fresh numbers. `gone` naming them is what makes
    // the restatement self-describing, and it is still the existing suffix
    // vocabulary — the "zero new wire vocabulary" property (tier4 §1.3.2) is
    // unchanged by the re-pin.
    expect(replace.gone).toEqual(['e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
    expect(wire.split('\n')[1]).toMatch(/^! e\d+ replaced \(gone: e3 e4 e5 e6 e7 e8\):$/);
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
describe('P1 — removal behaviour, re-pinned by tier5', () => {
  /**
   * RE-RECORDED FROM THE POST-TIER5 RUN (tier5 §6.3). The pre-tier5 literal is
   * kept one line down because the DELTA is the evidence: `(gone: e9)` — the
   * tail ordinal alone — with every survivor re-emitted under the SAME number
   * it already had. That wire is what the head-to-head measured as a precision
   * failure (h2h-evaluation §2): a plan captured before the removal stayed
   * fully executable and landed one row off.
   *
   * Pre-tier5 header line, for the comparison: `! e2 replaced (gone: e9):`
   * followed by `button e3` … `button e8`.
   */
  const P1_REMOVAL_WIRE = [
    'page #1.1 (diff from #1.0)',
    '! e2 replaced (gone: e3 e4 e5 e6 e7 e8 e9):',
    '  list e2 "Tickets"',
    '    listitem',
    '      button e10 "Take"',
    '    listitem',
    '      button e11 "Take"',
    '    listitem',
    '      button e12 "Take"',
    '    listitem',
    '      button e13 "Take"',
    '    listitem',
    '      button e14 "Take"',
    '    listitem',
    '      button e15 "Take"',
  ].join('\n');

  it('7. a 7 -> 6 removal retires the generation and restates it with fresh refs', () => {
    const { reg, ops, wire } = observe(page([list(7)]), page([list(6)]));

    // ONE replace, and the `gone` list naming the WHOLE prior generation —
    // every ref the model held for this family, not merely the ordinal that no
    // longer exists.
    expect(ops.map((o) => ({ ...o, subtree: undefined }))).toEqual([
      {
        op: 'replace',
        ref: 'e2',
        gone: ['e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'],
        subtree: undefined,
      },
    ]);
    // The container is content-keyed, so it is not in the family and keeps its
    // ref: retirement is scoped to the identity class with the defect.
    expect(reg.byKeyLookup('I|0|list|tickets')?.ref).toBe('e2');
    // The dead ordinal's key is gone from the index entirely, and the key that
    // SURVIVED the removal now answers a number the model has never seen —
    // which is the whole fix, in two lookups.
    expect(reg.byKeyLookup(ord(BTN_BASE, 6))).toBeUndefined();
    expect(reg.byKeyLookup(ord(BTN_BASE, 3))?.ref).toBe('e13');
    expect(reg.resolve('e6')?.state).toBe('dead');

    // And byte-equal on the wire, re-recorded from the post-fix run.
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
    const retired1 = retirePositionalRebinds(seven, six, reg);
    assignRefs(six, reg);
    const first = diffSnapshots(seven, six, reg, {
      retiredRef: (key) => retired1.get(key),
    });
    const retired2 = retirePositionalRebinds(six, five, reg);
    assignRefs(five, reg);
    const second = diffSnapshots(six, five, reg, {
      retiredRef: (key) => retired2.get(key),
    });

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

    // RE-PINNED BY TIER5 §6.3 (was: the dying ordinal alone, `['e9']` then
    // `['e8']`). Each restatement's `gone` now covers that GENERATION whole —
    // seven refs at the first removal, the six fresh ones at the second — and
    // no generation's refs survive into the next. Cardinality and disjointness
    // rather than literals, so this stays a statement about the mechanism
    // instead of about the allocator's counter.
    const g1 = (first.ops[0] as Replace).gone!;
    const g2 = (second.ops[0] as Replace).gone!;
    expect(g1).toHaveLength(7);
    expect(g2).toHaveLength(6);
    expect(g1.filter((r) => g2.includes(r))).toEqual([]);
  });
});
