import { describe, expect, it } from 'vitest';
import { RefRegistry, assignRefs } from '../src/core/snapshot/registry.js';
import { diffSnapshots, retirePositionalRebinds } from '../src/core/snapshot/diff.js';
import { renderDiff } from '../src/core/snapshot/render.js';
import type { DiffOp, SnapshotNode } from '../src/core/snapshot/types.js';

/**
 * Tier 5 — a positional family whose MEMBERSHIP changed loses its refs.
 *
 * PROVENANCE. Origin: `docs/design/h2h-evaluation.md` §2.2, the head-to-head
 * cohort's wire-level evidence — P1's restatement retires only the TAIL ref
 * while every survivor's key re-binds by position, so a plan captured before a
 * removal executes one row off, silently, labels agreeing, no error. That cost
 * the preregistered precision primary (+0.173 wrong-el/run against a +0.2
 * bound). Re-verified by throwaway vitest against the unedited engine at
 * `ef098f4` (`docs/design/tier5.md` §1.2: `gone: [e8]` for seven held refs; the
 * held ref `e5` revived `state: live` onto the row that slid into its place).
 * The ruling and the exact change are `docs/design/tier5.md`; the live half is
 * G29 (`test/fixtures/retire.html` + `bench/guards.mjs`), recorded RED in
 * `docs/design/g29-red-record.md` — including the page's own `took: r5` for a
 * click the agent read as r4.
 *
 * THE RED/GREEN ORDERING IS PART OF THE EVIDENCE, not decoration:
 *
 *   - Cases 1-5 and the registry cases were authored and run against UNEDITED
 *     src FIRST, where they FAILED.
 *   - Cases 6-9 were authored and run against UNEDITED src FIRST, where they
 *     PASSED — which is what makes them evidence rather than tests of the new
 *     feature. They pin the properties this fix must NOT touch: content-keyed
 *     identity (`bench/RESULTS.md` §B's measured 100% ref survival across
 *     re-snapshots), the documented silence on equal-size same-walk churn, and
 *     the `wasEmitted` token discipline.
 *
 * THE TWO HALVES. Retirement alone is cosmetic and refusal alone is cosmetic:
 * the identity half (this file) severs the revival path so the key cannot hand
 * a stale ref to whatever row holds the position now, and the act half
 * (`src/mcp/tools.ts`, guarded by G29b/G29d) refuses a dead ref instead of
 * resolving it through the page-side index. Case 2 is the seam between them.
 *
 * Nothing here reads the DOM. Constructed nodes, in `diff-rebinding.test.ts`'s
 * style, with physical row identity tracked in `rect.y` exactly as the §1.2
 * probe did.
 */

// --- constructed nodes -------------------------------------------------------

/**
 * The S-tier keys `disambiguate` produces for content-identical rows: same
 * role, no accessible name, no sibling discriminator, so the ONLY separation
 * available is the document-order ordinal (walker.ts `disambiguate`).
 */
const ROW_BASE = 'S|0|listitem||list:tickets|list';
const BTN_BASE = 'S|0|button|take|list:tickets|list>listitem';
const LIST_KEY = 'I|0|list|tickets';

const ord = (base: string, i: number): string => (i === 0 ? base : `${base}|#${i}`);

/**
 * One `<li><span>Ticket</span><button>Take</button></li>`, keyed positionally.
 *
 * `rect.y` is the row's PHYSICAL position, which is the only thing in a
 * constructed tree that can tell "the same row" from "the row that slid into
 * its place" — the §1.2 probe's device, kept.
 */
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

function list(count: number, key = LIST_KEY): SnapshotNode {
  return {
    role: 'list',
    name: 'Tickets',
    key,
    states: 0,
    frameId: 0,
    rect: [0, 0, 300, 20 * count],
    children: Array.from({ length: count }, (_, i) => row(i)),
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

/** Refs carried by a walk tree, in document order. */
function refsOf(n: SnapshotNode, out: string[] = []): string[] {
  if (n.ref) out.push(n.ref);
  for (const c of n.children) refsOf(c, out);
  return out;
}

/** The button refs of a subtree, in document order. */
function buttonRefsOf(n: SnapshotNode, out: string[] = []): string[] {
  if (n.role === 'button' && n.ref) out.push(n.ref);
  for (const c of n.children) buttonRefsOf(c, out);
  return out;
}

/**
 * Observe twice, the way `engine.ts` does it.
 *
 * The ordering is the whole mechanism (tier5 §2.3): refs are assigned across
 * the fresh walk BEFORE the diff, and `assignRefs` REVIVES by key — so the
 * pre-pass has to run before it, on every observation with a predecessor,
 * rather than inside the escalation. `wasEmitted` is the registry's real one
 * (engine.ts:239), so `gone` reporting is under the same token discipline the
 * product ships with.
 *
 * `emit` decides which refs the model was shown; the default is all of them,
 * which is the only state in which a rebinding can hurt it.
 */
function observe(
  before: SnapshotNode,
  after: SnapshotNode,
  emit: (ref: string, n: SnapshotNode) => boolean = () => true,
): {
  reg: RefRegistry;
  retired: Map<string, string>;
  ops: DiffOp[];
  wire: string;
  held: string[];
} {
  const reg = new RefRegistry();
  assignRefs(before, reg);
  markEmitted(before, reg, emit);
  const held = refsOf(before);

  const retired = retirePositionalRebinds(before, after, reg);
  assignRefs(after, reg);
  const { ops } = diffSnapshots(before, after, reg, {
    wasEmitted: (ref) => reg.wasEmitted(ref),
    retiredRef: (key) => retired.get(key),
  });
  // `commit: false` — the recorded bytes stay a pure function of the diff
  // rather than of how many times a test rendered it.
  const wire = renderDiff(
    { seq: '1.1', baseSeq: '1.0', ops, suppressed: 0, unreadChanges: 0 },
    reg,
    false,
  );
  return { reg, retired, ops, wire, held };
}

function markEmitted(
  n: SnapshotNode,
  reg: RefRegistry,
  emit: (ref: string, n: SnapshotNode) => boolean,
): void {
  if (n.ref && emit(n.ref, n)) reg.markEmitted(n.ref, '1.0');
  for (const c of n.children) markEmitted(c, reg, emit);
}

const shapeOf = (ops: DiffOp[]): string[] => ops.map((o) => o.op);

type Replace = { op: 'replace'; ref: string; subtree: SnapshotNode; gone?: string[] };

// --- 1-5: the identity half (RED against the unedited src) -------------------

describe('tier5 — a membership change retires the family generation', () => {
  it('1. a 7 -> 6 removal retires every prior ref and mints fresh ones', () => {
    // RED, pre-fix: one `replace` whose `gone` was `['e9']` — the TAIL ref
    // alone — while all six restated buttons carried the SAME numbers the
    // model already held, re-bound one row up. The wire affirmatively implied
    // the six survivors were fine.
    const before = page([list(7)]);
    const after = page([list(6)]);
    const { reg, ops, wire, retired } = observe(before, after);

    expect(shapeOf(ops)).toEqual(['replace']);
    const replace = ops[0] as Replace;

    // The container is content-keyed, so it is NOT in a positional family and
    // its ref survives: retirement is scoped to the identity class that has
    // the defect.
    expect(replace.ref).toBe(reg.byKeyLookup(LIST_KEY)?.ref);
    expect(replace.ref).toBe(refsOf(before)[1]);

    // Every one of the seven prior button refs is named, in document order —
    // not just the ordinal that vanished.
    const priorButtons = buttonRefsOf(before);
    expect(priorButtons).toHaveLength(7);
    expect(replace.gone).toEqual(priorButtons);

    // And every restated button ref is a number the model has never seen.
    const restated = buttonRefsOf(replace.subtree);
    expect(restated).toHaveLength(6);
    expect(restated.filter((r) => priorButtons.includes(r))).toEqual([]);

    // The rows themselves are positional too and were retired, but they carry
    // no refs (listitem is not addressable), so they cost the wire nothing.
    expect(retired.get(ord(ROW_BASE, 0))).toBeUndefined();

    expect(wire).toContain(`! ${replace.ref} replaced (gone: ${priorButtons.join(' ')}):`);
  });

  it('2. the held ref is dead and its key now names a different ref', () => {
    // The seam between the two halves. Pre-fix, `byKeyLookup` answered the
    // SAME ref for the 4th row's key and `resolve` said `state: live` — so the
    // act path resolved it through the page-side index onto whatever row now
    // occupies the position. This asserts both sides of the severance.
    const before = page([list(7)]);
    const after = page([list(6)]);
    const { reg } = observe(before, after);
    // `before`'s nodes keep the refs the FIRST `assignRefs` gave them, so this
    // is the number the agent read, recovered after the fact.
    const held = buttonRefsOf(before)[3]!; // the 4th row's Take, as read

    const nowAtThatPosition = reg.byKeyLookup(ord(BTN_BASE, 3));
    expect(nowAtThatPosition).toBeDefined();
    expect(nowAtThatPosition!.ref).not.toBe(held);

    // Resolvable, so the act path can tell a retired ref from an unknown one
    // and attach recovery — but dead, so it can never resolve to a key.
    const entry = reg.resolve(held);
    expect(entry).toBeDefined();
    expect(entry!.state).toBe('dead');

    // `keyForRef`'s body (engine.ts), at the level this file can reach: dead
    // resolves to null rather than to the key the page index would answer for.
    const keyForRef = (ref: string): string | null => {
      const e = reg.resolve(ref);
      if (!e || e.state === 'dead') return null;
      return e.key;
    };
    expect(keyForRef(held)).toBeNull();
    expect(keyForRef(nowAtThatPosition!.ref)).toBe(ord(BTN_BASE, 3));
  });

  it('3. a prepend 6 -> 7 retires the prior generation too (the P2 path)', () => {
    // Growth re-binds every held ref one row DOWN. tier4 §1 closed the wire
    // half (the family is restated); this closes the identity half, through
    // the same mechanism and the same op.
    const before = page([list(6)]);
    const after = page([list(7)]);
    const { ops } = observe(before, after);

    expect(shapeOf(ops)).toEqual(['replace']);
    const replace = ops[0] as Replace;
    const priorButtons = buttonRefsOf(before);
    expect(priorButtons).toHaveLength(6);
    expect(replace.gone).toEqual(priorButtons);

    const restated = buttonRefsOf(replace.subtree);
    expect(restated).toHaveLength(7);
    expect(restated.filter((r) => priorButtons.includes(r))).toEqual([]);
  });

  it('4. a family BORN around a held ref retires the bare key (1 -> 2)', () => {
    // The hole was never confined to pre-existing families: the single element
    // the model read is now the FIRST OF TWO indistinguishable ones, and the
    // bare key is a claim about position from the moment the second appears.
    const before = page([list(1)]);
    const after = page([list(2)]);
    const { reg, ops } = observe(before, after);
    const bare = buttonRefsOf(before)[0]!;

    expect(shapeOf(ops)).toEqual(['replace']);
    expect(reg.resolve(bare)!.state).toBe('dead');

    const restated = buttonRefsOf((ops[0] as Replace).subtree);
    expect(restated).toHaveLength(2);
    expect(restated).not.toContain(bare);
  });

  it('5. a family that disappears and returns with new membership does not revive', () => {
    // Revival across ABSENCE is the case an escalation-site fix cannot see at
    // all: nothing is diffed between the family being there and not, so the
    // return is a pure `assignRefs` revival by position (tier5 §2.3).
    const reg = new RefRegistry();
    const walkA = page([list(3)]);
    const walkB = page([]);
    const walkC = page([list(2)]);

    assignRefs(walkA, reg);
    markEmitted(walkA, reg, () => true);
    const aButtons = buttonRefsOf(walkA);
    expect(aButtons).toHaveLength(3);

    // A -> B: the family leaves. Nothing is held at a position any more, so
    // nothing is retired here; the diff kills the refs as removals.
    const retiredB = retirePositionalRebinds(walkA, walkB, reg);
    assignRefs(walkB, reg);
    diffSnapshots(walkA, walkB, reg, {
      wasEmitted: (ref) => reg.wasEmitted(ref),
      retiredRef: (key) => retiredB.get(key),
    });
    expect(retiredB.size).toBe(0);

    // B -> C: the family returns, two members where there were three. THIS is
    // where the dead keys would otherwise revive by position.
    const retiredC = retirePositionalRebinds(walkB, walkC, reg);
    assignRefs(walkC, reg);
    diffSnapshots(walkB, walkC, reg, {
      wasEmitted: (ref) => reg.wasEmitted(ref),
      retiredRef: (key) => retiredC.get(key),
    });

    const cButtons = buttonRefsOf(walkC);
    expect(cButtons).toHaveLength(2);
    expect(cButtons.filter((r) => aButtons.includes(r))).toEqual([]);
    for (const r of aButtons) expect(reg.resolve(r)!.state).toBe('dead');
  });
});

// --- the registry primitive --------------------------------------------------

describe('tier5 — retireKey severs the revival path', () => {
  const node = (key: string): SnapshotNode => ({
    role: 'button',
    name: 'Take',
    key,
    states: 0,
    frameId: 0,
    rect: [0, 0, 60, 20],
    children: [],
  });

  it('a retired key mints a fresh ref, and the old one stays resolvable-and-dead', () => {
    const reg = new RefRegistry();
    const n = node(ord(BTN_BASE, 1));
    const first = reg.ensureRef(n);
    reg.markEmitted(first, '1.0');

    expect(reg.retireKey(ord(BTN_BASE, 1))).toBe(first);
    expect(reg.byKeyLookup(ord(BTN_BASE, 1))).toBeUndefined();

    const second = reg.ensureRef(node(ord(BTN_BASE, 1)));
    expect(second).not.toBe(first);

    // Resolvable — the act path needs the distinction between a retired ref
    // (refuse WITH the current observation attached) and an unknown one
    // (refuse bare) — but never live again.
    const old = reg.resolve(first);
    expect(old).toBeDefined();
    expect(old!.state).toBe('dead');
    // A ref that can never come back owes no re-announcement (tier5 §3.1).
    expect(reg.needsReannounce(first)).toBe(false);
    // `wasEmitted` is unaffected, so `gone` reporting stays under the token
    // discipline: `buryUnder` still names only refs the model was shown.
    expect(reg.wasEmitted(first)).toBe(true);
  });

  it('retiring an unknown key is a no-op', () => {
    const reg = new RefRegistry();
    expect(reg.retireKey('S|0|button|nobody')).toBeUndefined();
  });
});

// --- 6-9: the GREEN-STABLE set — what must NOT change ------------------------

/**
 * These four ran GREEN against the UNEDITED src before the fix was written, and
 * they must still be green after. They are not tests of the new feature: they
 * are the pin that says the new feature changed nothing on the paths that were
 * already right — content-keyed identity above all, because `bench/RESULTS.md`
 * §B publishes 100% ref survival across re-snapshots as a measured claim.
 */
describe('tier5 — what must NOT be retired', () => {
  it('6. a content-keyed list loses one member and no sibling ref moves', () => {
    // Distinct names, so `disambiguate` never reaches for an ordinal and no key
    // carries `|#`. Tier-1/2 keyed elements can never enter a positional group,
    // so retirement is unreachable here by construction.
    const named = (n: string): SnapshotNode => ({
      role: 'button',
      name: `Take ${n}`,
      key: `S|0|button|take ${n}|list:tickets|list`,
      states: 0,
      frameId: 0,
      rect: [0, 0, 60, 20],
      children: [],
    });
    const container = (names: string[]): SnapshotNode => ({
      role: 'list',
      name: 'Tickets',
      key: LIST_KEY,
      states: 0,
      frameId: 0,
      rect: [0, 0, 300, 20 * names.length],
      children: names.map(named),
    });

    const before = container(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    const after = container(['alpha', 'bravo', 'delta', 'echo']);
    const { reg, ops, retired } = observe(page([before]), page([after]));

    expect(retired.size).toBe(0);
    expect(shapeOf(ops)).toEqual(['remove']);
    for (const n of ['alpha', 'bravo', 'delta', 'echo']) {
      expect(
        reg.byKeyLookup(`S|0|button|take ${n}|list:tickets|list`)?.ref,
        `${n}'s ref must survive a sibling's removal (bench/RESULTS.md §B)`,
      ).toBe(refsOf(before)[['alpha', 'bravo', 'charlie', 'delta', 'echo'].indexOf(n) + 1]);
    }
  });

  it('7. a pure re-walk of a positional family retires nothing and revives every ref', () => {
    // `bench/RESULTS.md` §B's re-snapshot property, at unit level and for the
    // identity class this fix touches. Retirement is gated on a membership
    // DELTA, not on positionality, so re-reading a page costs no ref churn.
    const before = page([list(7)]);
    const after = page([list(7)]);
    const { ops, retired, held } = observe(before, after);

    expect(retired.size).toBe(0);
    expect(ops).toEqual([]);
    expect(refsOf(after)).toEqual(held);
  });

  it('8. equal-size same-walk churn is silent, and stays silent', () => {
    // tier4 §1.4 residual 1, unchanged by this fix and neither detected nor
    // worsened by it: one indistinguishable row removed and another inserted
    // between two walks leaves the key set, the family size and every per-key
    // property identical, so no layer this engine owns has a signal for it.
    const before = page([list(7)]);
    const churned = page([list(7)]);
    const keysOf = (n: SnapshotNode): string[] => [n.key, ...n.children.flatMap(keysOf)];
    expect(keysOf(before), 'the two walks are indistinguishable by key').toEqual(
      keysOf(churned),
    );

    const { ops, retired } = observe(before, churned);
    expect(
      retired.size,
      'undetectable in principle at the key layer — tier4 §1.4 residual 1',
    ).toBe(0);
    expect(ops).toEqual([]);
  });

  it('9. gone omits refs the model was never shown', () => {
    // The `wasEmitted` filter is unchanged, so churn scales with EMITTED lines
    // rather than family size (tier5 §2.2's cost argument). A collapsed list
    // retires cheaply.
    const before = page([list(7)]);
    const after = page([list(6)]);
    const shown = buttonRefsOf(before).slice(0, 3);
    const { ops } = observe(before, after, (ref) => shown.includes(ref));

    expect(shapeOf(ops)).toEqual(['replace']);
    expect((ops[0] as Replace).gone).toEqual(shown);
  });
});
