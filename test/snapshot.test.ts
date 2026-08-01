import { describe, expect, it } from 'vitest';
import {
  RefRegistry,
  assignRefs,
  fuzzyRescue,
  nameSimilarity,
} from '../src/core/snapshot/registry.js';
import {
  diffSnapshots,
  longestIncreasingSubsequence,
  propDelta,
} from '../src/core/snapshot/diff.js';
import {
  estimateTokens,
  renderDiff,
  renderFull,
  renderLine,
  renderUnchanged,
  quote,
} from '../src/core/snapshot/render.js';
import { VolatilityTracker } from '../src/core/snapshot/volatility.js';
import { looksGenerated } from '../src/core/snapshot/walker.js';
import type { Role, Snapshot, SnapshotNode } from '../src/core/snapshot/types.js';
import { State } from '../src/core/snapshot/types.js';

// -- helpers ----------------------------------------------------------------

let seq = 0;
function node(
  role: Role,
  name: string | undefined,
  children: SnapshotNode[] = [],
  extra: Partial<SnapshotNode> = {},
): SnapshotNode {
  const key = extra.key ?? `k${role}:${name ?? ''}:${++seq}`;
  return {
    role,
    name,
    key,
    states: 0,
    frameId: 0,
    rect: [0, 0, 10, 10],
    children,
    shape: children.map((c) => c.role).join(','),
    ...extra,
    // key must survive the spread when explicitly supplied
    ...(extra.key ? { key: extra.key } : {}),
  };
}

/** Stable-keyed node, so identity survives across "renders" in tests. */
function k(role: Role, key: string, name?: string, extra: Partial<SnapshotNode> = {}) {
  return node(role, name, extra.children ?? [], { ...extra, key });
}

function snapshot(root: SnapshotNode, s = '1.0'): Snapshot {
  return {
    seq: s,
    epoch: Number(s.split('.')[0]),
    url: 'https://example.com/',
    title: 'Example',
    root,
    viewport: { top: 0, height: 800, docHeight: 800 },
  };
}

// `assignRefs` is the REAL one from registry.ts — this file used to carry a
// third private copy of the addressable set, which is exactly how the
// engine/walker drift went unnoticed. Note that listitem is NOT addressable.

function refsIn(n: SnapshotNode, out: string[] = []): string[] {
  if (n.ref) out.push(n.ref);
  for (const c of n.children) refsIn(c, out);
  return out;
}

/** A product list: the shape that collapses, and the shape the bench drives. */
function catalogue(n: number, prefix: string): SnapshotNode {
  return listPage(Array.from({ length: n }, (_, i) => `${prefix}${i}`));
}

/** The same page, with the item order given explicitly by key stem. */
function listPage(stems: string[]): SnapshotNode {
  const items = stems.map((stem) =>
    k('listitem', stem, undefined, {
      children: [
        k('link', `${stem}l`, `Product ${stem}`, { href: `/p/${stem}` }),
        k('button', `${stem}b`, 'Add to cart'),
      ],
      shape: 'link,button',
    }),
  );
  return k('main', 'mroot', undefined, {
    children: [k('list', 'catalogue', 'results', { children: items, shape: 'listitem' })],
  });
}

function render(ops: ReturnType<typeof diffSnapshots>['ops'], reg: RefRegistry): string {
  return renderDiff(
    { seq: '1.1', baseSeq: '1.0', ops, suppressed: 0, unreadChanges: 0 },
    reg,
  );
}

/**
 * Verbatim output of `catalogue(8, 'g')` from the renderer as it stood before
 * `expand` existed (captured from git HEAD, not from the current code). The
 * production stream is not allowed to move.
 */
const GOLDEN_COLLAPSED = [
  'FULL SNAPSHOT #3.0 — replaces all prior state for this page',
  'page "Example" https://example.com/',
  '',
  'main e1',
  '  list e2 "results"',
  '    listitem',
  '      link e3 "Product g0" /p/g0',
  '      button e4 "Add to cart"',
  '    listitem',
  '      link e5 "Product g1" /p/g1',
  '      button e6 "Add to cart"',
  '    listitem',
  '      link e7 "Product g2" /p/g2',
  '      button e8 "Add to cart"',
  '    … 5 more listitems (link/button "Add to cart") — read e2',
].join('\n');

// -- ref identity -----------------------------------------------------------

describe('RefRegistry', () => {
  it('gives the same ref to the same key across re-renders', () => {
    const reg = new RefRegistry();
    const before = k('button', 'S|0|button|save||form', 'Save');
    const ref = reg.ensureRef(before);

    // Simulate React replacing the DOM node: brand new object, same identity.
    const after = k('button', 'S|0|button|save||form', 'Save');
    expect(reg.ensureRef(after)).toBe(ref);
  });

  it('allocates distinct refs to distinct keys', () => {
    const reg = new RefRegistry();
    const a = reg.ensureRef(k('button', 'a', 'Add to cart'));
    const b = reg.ensureRef(k('button', 'b', 'Add to cart'));
    expect(a).not.toBe(b);
  });

  it('never reuses a ref number after an element dies', () => {
    const reg = new RefRegistry();
    const a = reg.ensureRef(k('button', 'a', 'Old'));
    reg.markDead(a);
    const b = reg.ensureRef(k('button', 'b', 'New'));
    expect(b).not.toBe(a);
  });

  it('revives the original ref when a key reappears', () => {
    const reg = new RefRegistry();
    const first = reg.ensureRef(k('tab', 'tab:settings', 'Settings'));
    reg.markDead(first);
    // Agent switched tabs away and back; the same logical element returns.
    const revived = reg.ensureRef(k('tab', 'tab:settings', 'Settings'));
    expect(revived).toBe(first);
    expect(reg.resolve(revived)?.state).toBe('live');
  });
});

describe('identity key generation', () => {
  it('rejects framework-generated ids', () => {
    expect(looksGenerated(':r1:')).toBe(true);          // React useId
    expect(looksGenerated('radix-abc')).toBe(true);
    expect(looksGenerated('btn_a8f3e21b')).toBe(true);  // hash suffix
    expect(looksGenerated('mui-4821')).toBe(true);
  });

  it('accepts author-written ids', () => {
    expect(looksGenerated('checkout-submit')).toBe(false);
    expect(looksGenerated('email')).toBe(false);
    expect(looksGenerated('nav-primary')).toBe(false);
  });
});

// -- fuzzy rescue -----------------------------------------------------------

describe('fuzzyRescue', () => {
  const lost = {
    ref: 'e1', key: 'x', frameId: 0, role: 'button' as Role,
    name: 'Apply coupon', href: undefined, rect: [10, 10, 100, 30] as [number, number, number, number],
    state: 'dead' as const, emitted: true, needsReannounce: true, lastSeenSeq: '1.0',
  };

  it('recovers an element whose label barely changed', () => {
    const found = fuzzyRescue(lost, [k('button', 'new', 'Apply coupon code')]);
    expect(found?.name).toBe('Apply coupon code');
  });

  it('refuses to guess when nothing is close', () => {
    // Guessing wrong here means clicking the wrong button, which can be
    // destructive — so below threshold it must fail rather than act.
    expect(fuzzyRescue(lost, [k('button', 'new', 'Delete account')])).toBeNull();
  });

  it('never crosses roles', () => {
    expect(fuzzyRescue(lost, [k('link', 'new', 'Apply coupon')])).toBeNull();
  });
});

describe('nameSimilarity', () => {
  it('is order-insensitive', () => {
    expect(nameSimilarity('add to cart', 'cart to add')).toBe(1);
  });
  it('scores disjoint labels at zero', () => {
    expect(nameSimilarity('save', 'delete')).toBe(0);
  });
});

// -- diffing ----------------------------------------------------------------

describe('diffSnapshots', () => {
  it('reports nothing when nothing changed', () => {
    const reg = new RefRegistry();
    const before = k('main', 'main', undefined, {
      children: [k('button', 'b1', 'Save')],
    });
    const after = k('main', 'main', undefined, {
      children: [k('button', 'b1', 'Save')],
    });
    expect(diffSnapshots(before, after, reg).ops).toHaveLength(0);
  });

  it('reports a state change as an update, not a replace', () => {
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, { children: [k('checkbox', 'c1', 'Anker')] });
    const after = k('main', 'm', undefined, {
      children: [k('checkbox', 'c1', 'Anker', { states: State.Checked })],
    });
    const { ops } = diffSnapshots(before, after, reg);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('update');
    expect((ops[0] as { delta: { statesOn?: number } }).delta.statesOn).toBe(State.Checked);
  });

  it('detects an added element', () => {
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, { children: [k('text', 't1', 'a')] });
    const after = k('main', 'm', undefined, {
      children: [k('text', 't1', 'a'), k('button', 'b2', 'Remove coupon')],
    });
    const { ops } = diffSnapshots(before, after, reg);
    expect(ops.map((o) => o.op)).toContain('add');
  });

  it('detects a removal and echoes the label', () => {
    const reg = new RefRegistry();
    const gone = k('button', 'b1', 'Apply coupon');
    const before = k('main', 'm', undefined, { children: [gone, k('text', 't', 'x')] });
    reg.ensureRef(gone);
    const after = k('main', 'm', undefined, { children: [k('text', 't', 'x')] });

    const { ops } = diffSnapshots(before, after, reg);
    const rm = ops.find((o) => o.op === 'remove');
    expect(rm).toBeDefined();
    // The label rides along so the agent never needs a lookup to know what it lost.
    expect((rm as { label?: string }).label).toBe('Apply coupon');
  });

  it('collapses a mostly-replaced container into one replace op', () => {
    const reg = new RefRegistry();
    const before = k('list', 'l', undefined, {
      children: Array.from({ length: 10 }, (_, i) => k('listitem', `old${i}`, `Old ${i}`)),
    });
    const after = k('list', 'l', undefined, {
      children: Array.from({ length: 10 }, (_, i) => k('listitem', `new${i}`, `New ${i}`)),
    });
    const { ops } = diffSnapshots(before, after, reg);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('replace');
  });

  it('reports a single move when one item jumps to the top', () => {
    const reg = new RefRegistry();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const before = k('list', 'l', undefined, {
      children: ids.map((i) => k('listitem', i, i)),
    });
    const reordered = ['e', 'a', 'b', 'c', 'd'];
    const after = k('list', 'l', undefined, {
      children: reordered.map((i) => k('listitem', i, i)),
    });

    const { ops } = diffSnapshots(before, after, reg);
    const moves = ops.filter((o) => o.op === 'move');
    // Without the LIS pass this would report four moves instead of one.
    expect(moves).toHaveLength(1);
  });

  it('suppresses churn on volatile nodes but keeps structural changes', () => {
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, { children: [k('text', 'clock', '12:04:37')] });
    const after = k('main', 'm', undefined, { children: [k('text', 'clock', '12:04:38')] });

    const { ops, suppressed } = diffSnapshots(before, after, reg, {
      isVolatile: (key) => key === 'clock',
    });
    expect(ops).toHaveLength(0);
    expect(suppressed).toBe(1);
  });

  it('does not report changes in regions the model has never seen', () => {
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, { children: [k('text', 'footer', 'a')] });
    const after = k('main', 'm', undefined, { children: [k('text', 'footer', 'b')] });

    const { ops, unreadChanges, unread } = diffSnapshots(before, after, reg, {
      wasEmitted: () => false,
    });
    expect(ops).toHaveLength(0);
    expect(unreadChanges).toBe(1);
    // The withheld change still carries key + new text, so the volatility
    // tracker can hear about it — otherwise a clock behind the unread gate
    // ticks out an "unread changes" note forever.
    expect(unread).toEqual([{ key: 'footer', text: 'b' }]);
  });
});

describe('longestIncreasingSubsequence', () => {
  it('finds the stable run', () => {
    expect(longestIncreasingSubsequence([0, 1, 2, 3]).length).toBe(4);
  });
  it('handles an empty sequence', () => {
    expect(longestIncreasingSubsequence([])).toEqual([]);
  });
  it('finds one element in a reversed sequence', () => {
    expect(longestIncreasingSubsequence([3, 2, 1, 0]).length).toBe(1);
  });
});

describe('propDelta', () => {
  it('ignores offscreen flapping caused by scrolling', () => {
    const a = k('button', 'b', 'Go');
    const b = k('button', 'b', 'Go', { states: State.Offscreen });
    expect(propDelta(a, b)).toBeNull();
  });
});

// -- rendering --------------------------------------------------------------

describe('renderFull', () => {
  it('emits the reset header so the model discards stale state', () => {
    const out = renderFull(snapshot(k('main', 'm', undefined, {})));
    expect(out).toContain('FULL SNAPSHOT #1.0');
    expect(out).toContain('replaces all prior state');
  });

  it('collapses long runs of same-shaped siblings', () => {
    const items = Array.from({ length: 24 }, (_, i) =>
      k('listitem', `i${i}`, undefined, {
        children: [k('link', `l${i}`, `Product ${i}`), k('button', `b${i}`, 'Add to cart')],
        shape: 'link,button',
      }),
    );
    const root = k('main', 'm', undefined, {
      children: [k('list', 'list', 'results', { children: items, shape: 'listitem' })],
    });
    const reg = new RefRegistry();
    reg.ensureRef(root.children[0]!);

    const out = renderFull(snapshot(root), { registry: reg });
    expect(out).toContain('21 more listitems');
    // The three shown, not all 24.
    expect(out).toContain('Product 0');
    expect(out).not.toContain('Product 12');
  });

  it('renders tables as pipe-joined rows', () => {
    const t = k('table', 't', undefined, {
      rows: [['USB-C Hub', '1', '$34.99'], ['Total', '', '$52.99']],
      dims: { rows: 2, cols: 3 },
    });
    const out = renderFull(snapshot(k('main', 'm', undefined, { children: [t] })));
    expect(out).toContain('"USB-C Hub" | "1" | "$34.99"');
  });

  it('shows only states that are set', () => {
    const b = k('button', 'b', 'Place order', { states: State.Disabled });
    const out = renderFull(snapshot(k('main', 'm', undefined, { children: [b] })));
    expect(out).toContain('disabled');
    expect(out).not.toContain('checked');
  });
});

describe('renderDiff', () => {
  it('renders a state flip compactly', () => {
    const out = renderDiff({
      seq: '4.1', baseSeq: '4.0', suppressed: 0, unreadChanges: 0,
      ops: [{ op: 'update', ref: 'e6', delta: { statesOn: State.Checked } }],
    });
    expect(out).toContain('page #4.1 (diff from #4.0)');
    expect(out).toContain('~ e6 +checked');
    // The whole diff must be small — that is the entire point of the design.
    expect(estimateTokens(out)).toBeLessThan(25);
  });

  it('says so plainly when nothing visible happened', () => {
    const out = renderDiff({ seq: '4.2', baseSeq: '4.1', ops: [], suppressed: 0, unreadChanges: 0 });
    // Asserted against the exact bytes, not a substring: this line is a wire
    // format the bench classifies with a regex, and "contains the word" would
    // stay green through a rewording that broke the classifier.
    expect(out).toBe('page #4.2 (unchanged — you already hold the current page)');
    expect(estimateTokens(out)).toBeLessThan(20);
  });

  it('names the base seq so a compacted model can notice it lost the base', () => {
    const out = renderDiff({
      seq: '7.5', baseSeq: '7.4', suppressed: 0, unreadChanges: 0,
      ops: [{ op: 'update', ref: 'e26', delta: { value: '94110' } }],
    });
    expect(out).toContain('diff from #7.4');
  });
});

describe('renderUnchanged', () => {
  it('tells a no-effect ACTION apart from a redundant SNAPSHOT', () => {
    // Two different facts that used to render as the same bytes. After an
    // action, "nothing changed" is a finding about the page; after a voluntary
    // snapshot it is a receipt for a wasted turn.
    expect(renderUnchanged('4.2', { afterAction: true })).toBe(
      'page #4.2 (unchanged — the action caused no visible change)',
    );
    expect(renderUnchanged('4.2', { afterAction: false })).toBe(
      'page #4.2 (unchanged — you already hold the current page)',
    );
  });

  it('gives both variants the prefix the bench classifies on', () => {
    // The bench reads this with /^page #\d+\.\d+ \(unchanged/m. If a wording
    // change ever broke that, the observation would classify as `other` and
    // silently corrupt the arm-purity guards rather than fail anything here.
    const classify = /^page #\d+\.\d+ \(unchanged/m;
    expect(renderUnchanged('12.7', { afterAction: true })).toMatch(classify);
    expect(renderUnchanged('12.7', {})).toMatch(classify);
  });

  it('carries the notes the empty path used to throw away', () => {
    // `unreadChanges` was hardcoded to 0 on this path, so a page whose only
    // changes were in regions the model has never been shown reported nothing
    // changed, with no caveat at all.
    expect(
      renderUnchanged('2.3', { afterAction: true, suppressed: 2, unreadChanges: 1 }),
    ).toBe(
      'page #2.3 (unchanged — the action caused no visible change) ' +
        '(2 live-region updates suppressed; 1 changes in regions you have not read)',
    );
    expect(renderUnchanged('2.3', { unreadChanges: 1 })).toBe(
      'page #2.3 (unchanged — you already hold the current page) ' +
        '(1 changes in regions you have not read)',
    );
  });

  it('is the ONLY spelling: renderDiff\'s empty branch delegates to it', () => {
    // Two spellings of the same wire string drifted apart once already, in the
    // shape predicates. This pins the delegation rather than the wording.
    const empty = { seq: '9.1', baseSeq: '9.0', ops: [], suppressed: 3, unreadChanges: 2 };
    expect(renderDiff(empty)).toBe(
      renderUnchanged('9.1', { suppressed: 3, unreadChanges: 2 }),
    );
  });
});

// -- collapse, ground truth, and revival --------------------------------------

/**
 * These four cover the failure that made `bench:fidelity rerender` report six
 * phantom refs. The refs were real; the *ground truth* was lossy, because the
 * reference snapshot collapsed the run they lived in. Everything a checker
 * compares the diff stream against has to be complete, or it indicts a
 * faithful engine.
 */
describe('collapsed runs', () => {
  it('hides refs behind the elision by default and reveals every one on expand', () => {
    const reg = new RefRegistry();
    const root = catalogue(6, 'c');
    assignRefs(root, reg);

    const plain = renderFull(snapshot(root), { registry: reg });
    expect(plain).toMatch(/… 3 more listitems/);

    // Every ref in the tree is live in the registry; expand must account for
    // all of them, or a checker built on this output invents phantoms.
    const expanded = renderFull(snapshot(root), { expand: true, registry: reg });
    for (const ref of refsIn(root)) {
      expect(expanded).toMatch(new RegExp(`\\b${ref}\\b`));
    }
    expect(expanded).not.toMatch(/… \d+ more/);
  });

  it('never names a ref as gone and renders it in the same op', () => {
    const reg = new RefRegistry();
    const before = catalogue(10, 'old');
    const after = catalogue(10, 'new');
    assignRefs(before, reg);
    renderFull(snapshot(before), { registry: reg });
    assignRefs(after, reg);

    const { ops } = diffSnapshots(before, after, reg, {
      wasEmitted: (r) => reg.wasEmitted(r),
    });
    const out = render(ops, reg);

    const head = /^! e\d+ replaced \(gone: ([^)]+)\):$/m.exec(out);
    expect(head).not.toBeNull();
    const gone = new Set(head![1]!.trim().split(/\s+/));
    expect(gone.size).toBeGreaterThan(0);

    const lines = out.split('\n');
    const subtree = lines.slice(lines.findIndex((l) => l.startsWith('! ')) + 1);
    const rendered = new Set<string>();
    for (const line of subtree) {
      for (const m of line.matchAll(/\b(e\d+)\b/g)) rendered.add(m[1]!);
    }
    for (const g of gone) expect(rendered.has(g)).toBe(false);
  });

  it('re-announces a revived ref rather than burying it in a collapsed run', () => {
    // Fails before the needsReannounce fix: r comes back inside the elided
    // tail, so the model — which deleted r when it was told `gone: r` — is
    // never given a line to restore it from, and the next `~ r` names an
    // element it does not hold.
    const reg = new RefRegistry();

    const a = catalogue(12, 'p');
    assignRefs(a, reg);
    renderFull(snapshot(a, '1.0'), { registry: reg });
    const r = reg.byKeyLookup('p0l')!.ref;
    expect(reg.wasEmitted(r)).toBe(true); // p0 is among the three shown

    // The list rebuilds with two unrelated items: a replace that kills r.
    const b = listPage(['q0', 'q1']);
    assignRefs(b, reg);
    const bOut = render(
      diffSnapshots(a, b, reg, { wasEmitted: (x) => reg.wasEmitted(x) }).ops,
      reg,
    );
    expect(bOut).toMatch(new RegExp(`gone:[^)]*\\b${r}\\b`));
    expect(reg.needsReannounce(r)).toBe(true);

    // The list comes back, with r's item at index 4 — inside the elided tail.
    const c = listPage(['q0', 'q1', 'p2', 'p3', 'p0', 'p1', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    assignRefs(c, reg);
    const cOut = render(
      diffSnapshots(b, c, reg, { wasEmitted: (x) => reg.wasEmitted(x) }).ops,
      reg,
    );

    expect(cOut).toMatch(new RegExp(`^\\s*link ${r} `, 'm'));
    expect(cOut).not.toMatch(/… \d+ more/);
    expect(reg.needsReannounce(r)).toBe(false);
  });

  it('renders a collapsing list byte-identically to the pre-fix output', () => {
    // Guards the whole point of the change: `expand` is opt-in, so the
    // production stream must not have moved a single character.
    const reg = new RefRegistry();
    const root = catalogue(8, 'g');
    assignRefs(root, reg);
    expect(renderFull(snapshot(root, '3.0'), { registry: reg })).toBe(GOLDEN_COLLAPSED);
  });
});

describe('quote', () => {
  it('strips bidi overrides used to make text read differently than it is', () => {
    expect(quote('safe‮evil')).toBe('"safeevil"');
  });

  it('flattens newlines so page text cannot forge snapshot structure', () => {
    const out = quote('hello\nFULL SNAPSHOT #9.0');
    expect(out.startsWith('"')).toBe(true);
    expect(out).not.toContain('\n');
  });

  it('caps runaway text', () => {
    expect(quote('x'.repeat(500)).length).toBeLessThan(90);
  });
});

// -- volatility -------------------------------------------------------------

describe('VolatilityTracker', () => {
  it('demotes a node that keeps changing unprompted', () => {
    const v = new VolatilityTracker();
    for (let i = 0; i < 4; i++) v.noteChange('clock', 1000 + i * 100, false);
    expect(v.isVolatile('clock')).toBe(true);
  });

  it('never demotes changes the agent caused', () => {
    const v = new VolatilityTracker();
    for (let i = 0; i < 10; i++) v.noteChange('total', 1000 + i * 100, true);
    expect(v.isVolatile('total')).toBe(false);
  });

  it('promotes a clock immediately on shape', () => {
    const v = new VolatilityTracker();
    v.noteChange('c', 1000, false, '12:04:37');
    v.noteChange('c', 1100, false, '12:04:38');
    expect(v.isVolatile('c')).toBe(true);
  });

  it('re-promotes anything the agent touches', () => {
    const v = new VolatilityTracker();
    for (let i = 0; i < 5; i++) v.noteChange('price', 1000 + i * 100, false);
    expect(v.isVolatile('price')).toBe(true);
    v.onAgentTouch('price');
    expect(v.isVolatile('price')).toBe(false);
  });

  it('suppresses a clock even when every observation follows an action', () => {
    // In a pure act-observe loop every observation has afterAction=true, so
    // the statistical path can never demote anything — the shape path must
    // work regardless, or a ticking clock rides along in every action diff.
    const v = new VolatilityTracker();
    v.noteChange('clock', 1000, true, '12:04:37', 'search-field');
    expect(v.isVolatile('clock')).toBe(true);
  });

  it('never shape-suppresses the element the action targeted', () => {
    // Typing "10:30" into a time field looks like a clock by shape. The acted
    // element is signal by definition and must stay unsuppressed.
    const v = new VolatilityTracker();
    v.noteChange('field', 1000, true, '10:30', 'field');
    expect(v.isVolatile('field')).toBe(false);
  });
});

// -- what the model was actually told ----------------------------------------

describe('emission bookkeeping', () => {
  it('heals the wasEmitted deadlock: a mid-diff ref is announced by the next full', () => {
    const reg = new RefRegistry();
    const page = (label: string) =>
      k('main', 'm', undefined, {
        children: [k('textbox', 'q', 'Search'), k('generic', 'count', label)],
      });

    const a = page('12 products');
    assignRefs(a, reg);
    renderFull(snapshot(a, '1.0'), { registry: reg });
    // Not addressable, never changed: no ref exists yet.
    expect(reg.byKeyLookup('count')).toBeUndefined();

    // Its content changes during a diff: a ref is allocated, but the change
    // is (correctly) gated as unread — the model has never seen this ref.
    const b = page('7 products');
    assignRefs(b, reg);
    const r1 = diffSnapshots(a, b, reg, { wasEmitted: (x) => reg.wasEmitted(x) });
    expect(r1.ops).toHaveLength(0);
    expect(r1.unreadChanges).toBe(1);
    const ref = reg.byKeyLookup('count')!.ref;
    expect(reg.wasEmitted(ref)).toBe(false);

    // A fresh walk arrives ref-less; assignRefs must re-attach the known ref
    // so the full snapshot renders it and marks it emitted. Before the fix
    // this never happened and the node's changes were suppressed forever.
    const b2 = page('7 products');
    assignRefs(b2, reg);
    const full = renderFull(snapshot(b2, '2.0'), { registry: reg });
    expect(full).toContain(`generic ${ref} "7 products"`);
    expect(reg.wasEmitted(ref)).toBe(true);

    // From now on its changes flow as ordinary updates.
    const c = page('3 products');
    assignRefs(c, reg);
    const r2 = diffSnapshots(b2, c, reg, { wasEmitted: (x) => reg.wasEmitted(x) });
    expect(r2.ops).toHaveLength(1);
    expect(r2.ops[0]).toMatchObject({ op: 'update', ref });
  });

  it('does not mark refs emitted for lines the budget cut dropped', () => {
    const reg = new RefRegistry();
    const root = catalogue(30, 'x');
    assignRefs(root, reg);
    const out = renderFull(snapshot(root), {
      registry: reg,
      budgetTokens: 200,
      expand: true,
    });
    expect(out).toContain('more lines beyond budget');

    const first = reg.byKeyLookup('x0l')!.ref;
    const last = reg.byKeyLookup('x29l')!.ref;
    expect(reg.wasEmitted(first)).toBe(true);
    // The last item's line fell to the budget: the model never received it,
    // so it must not be marked as shown.
    expect(out).not.toContain(`${last} `);
    expect(reg.wasEmitted(last)).toBe(false);
  });

  it('a dry-rendered diff marks nothing; the commit render marks everything', () => {
    const reg = new RefRegistry();
    const before = catalogue(10, 'a');
    const after = catalogue(10, 'b');
    assignRefs(before, reg);
    renderFull(snapshot(before), { registry: reg });
    assignRefs(after, reg);
    const { ops } = diffSnapshots(before, after, reg, {
      wasEmitted: (x) => reg.wasEmitted(x),
    });
    const newRef = reg.byKeyLookup('b0l')!.ref;

    const d = { seq: '1.1', baseSeq: '1.0', ops, suppressed: 0, unreadChanges: 0 };
    const dry = renderDiff(d, reg, false);
    expect(reg.wasEmitted(newRef)).toBe(false);

    const committed = renderDiff(d, reg, true);
    expect(committed).toBe(dry); // byte-identical, only the bookkeeping differs
    expect(reg.wasEmitted(newRef)).toBe(true);
  });

  it('shows the ref on a text line once the node has one', () => {
    // Without this, a text node that earned a ref mid-diff gets `~ eN` updates
    // the model can never anchor: the full snapshot shows its text bare.
    const plain = k('text', 't1', undefined, { text: 'hello' });
    expect(renderLine(plain, 1)).toBe('  "hello"');
    const withRef = k('text', 't2', undefined, { text: 'hello', ref: 'e9' });
    expect(renderLine(withRef, 1)).toBe('  text e9 "hello"');
  });
});

describe('one addressable set (drift regression)', () => {
  it('assigns refs to banner and contentinfo landmarks', () => {
    const reg = new RefRegistry();
    const root = k('generic', 'root', undefined, {
      children: [k('banner', 'hdr', 'Site header'), k('contentinfo', 'ftr', 'Footer')],
    });
    assignRefs(root, reg);
    expect(root.children[0]!.ref).toBeDefined();
    expect(root.children[1]!.ref).toBeDefined();
  });

  it('gives a REAL option a ref, because a click can use one', () => {
    // The `role="option"` of a custom ARIA listbox is an ordinary visible
    // element. It was collateral damage of excluding `option` wholesale.
    const reg = new RefRegistry();
    const root = k('list', 'listbox', 'Colours', {
      children: [k('option', 'o1', 'Red')],
    });
    assignRefs(root, reg);
    expect(root.ref).toBeDefined();
    expect(root.children[0]!.ref).toBeDefined();
  });

  it('never gives a SYNTHETIC option a ref, because no action can resolve one', () => {
    // The walker manufactures these to enumerate a short native <select>.
    // There is no element behind them in the page-side index, so a ref would
    // be bait: the agent would see it and act on it, and the act would always
    // fail. This is the trap that re-adding `option` to ADDRESSABLE creates.
    const reg = new RefRegistry();
    const root = k('combobox', 'sel', 'State', {
      optionCount: 2,
      children: [
        k('option', 'o1', 'VIC', { synthetic: true }),
        k('option', 'o2', 'NSW', { synthetic: true }),
      ],
    });
    assignRefs(root, reg);
    expect(root.ref).toBeDefined();
    expect(refsIn(root)).toEqual([root.ref]);
  });

  it('does not resurrect a synthetic ref even when the registry knows the key', () => {
    // assignRefs re-attaches refs for keys the registry has seen (the
    // wasEmitted-deadlock fix). Synthetic nodes must be excluded from THAT
    // branch too, or a key that was once real comes back as a live ref.
    const reg = new RefRegistry();
    const real = k('option', 'o1', 'Red');
    assignRefs(k('list', 'lb', 'Colours', { children: [real] }), reg);
    expect(real.ref).toBeDefined();

    const again = k('option', 'o1', 'Red', { synthetic: true });
    assignRefs(k('combobox', 'sel', 'Size', { children: [again] }), reg);
    expect(again.ref).toBeUndefined();
  });
});

describe('synthetic option nodes in diffs', () => {
  const select = (selectedIndex: number, syn = true) =>
    k('combobox', 'sel', 'Size', {
      optionCount: 2,
      value: selectedIndex === 0 ? 'Small' : 'Large',
      children: [
        k('option', 'o1', 'Small', { synthetic: syn, states: selectedIndex === 0 ? State.Selected : 0 }),
        k('option', 'o2', 'Large', { synthetic: syn, states: selectedIndex === 1 ? State.Selected : 0 }),
      ],
    });

  it('reports the select value change without minting a ref for the option', () => {
    // `ensureRef` allocates on demand, so every call site in diff.ts is a
    // place a synthetic node could be handed a ref. The flag has to be
    // honoured at all of them, not just in assignRefs.
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, { children: [select(0)] });
    assignRefs(before, reg);
    const after = k('main', 'm', undefined, { children: [select(1)] });

    const { ops } = diffSnapshots(before, after, reg);
    const out = render(ops, reg);

    expect(out).toContain('="Large"');
    // Two refs exist on this page: main and the select. Not four — and the
    // registry must not know the option keys at all, since `ensureRef` is
    // what would have created them.
    expect(refsIn(after)).toEqual([reg.byKeyLookup('sel')!.ref]);
    expect(reg.byKeyLookup('o1')).toBeUndefined();
    expect(reg.byKeyLookup('o2')).toBeUndefined();
    for (const op of ops) {
      if (op.op === 'update' || op.op === 'move' || op.op === 'remove') {
        expect(['e1', 'e2']).toContain(op.ref);
      }
    }
  });

  it('does not name a synthetic node as a move anchor', () => {
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, {
      children: [
        k('option', 'a', 'A', { synthetic: true }),
        k('button', 'b', 'B'),
        k('button', 'c', 'C'),
      ],
    });
    assignRefs(before, reg);
    const after = k('main', 'm', undefined, {
      children: [
        k('option', 'a', 'A', { synthetic: true }),
        k('button', 'c', 'C'),
        k('button', 'b', 'B'),
      ],
    });

    const { ops } = diffSnapshots(before, after, reg);
    for (const op of ops) {
      if (op.op === 'move' || op.op === 'add') {
        expect(op.after === null || op.after?.startsWith('e')).toBe(true);
      }
    }
    // The synthetic node still holds no ref after a diff that walked past it.
    expect(reg.byKeyLookup('a')).toBeUndefined();
  });
});

describe('a removed subtree names the refs that died inside it', () => {
  it('lists descendants the model was shown, so a closed dropdown leaves no phantoms', () => {
    // Reporting only the top of a removed subtree leaves every ref underneath
    // alive in the model — the phantom-ref failure, reachable by the commonest
    // interaction there is: closing a dropdown.
    const reg = new RefRegistry();
    const open = k('main', 'm', undefined, {
      children: [
        k('button', 'btn', 'Colour: none'),
        k('list', 'lb', 'Colours', {
          children: [k('option', 'red', 'Red'), k('option', 'blue', 'Blue')],
        }),
      ],
    });
    assignRefs(open, reg);
    const shown = new Set(refsIn(open));

    const closed = k('main', 'm', undefined, {
      children: [k('button', 'btn', 'Colour: Red')],
    });

    const { ops } = diffSnapshots(open, closed, reg, {
      wasEmitted: (r) => shown.has(r),
    });
    const removal = ops.find((o) => o.op === 'remove');
    expect(removal).toBeDefined();
    if (removal?.op !== 'remove') throw new Error('unreachable');
    expect(removal.gone).toEqual([reg.byKeyLookup('red')?.ref, reg.byKeyLookup('blue')?.ref]);

    const line = render(ops, reg);
    expect(line).toMatch(/- e\d+ removed \(was: list "Colours"\) \(gone: e\d+ e\d+\)/);
  });

  it('does not name refs the model was never shown', () => {
    const reg = new RefRegistry();
    const open = k('main', 'm', undefined, {
      children: [k('list', 'lb', 'Colours', { children: [k('option', 'red', 'Red')] })],
    });
    assignRefs(open, reg);
    const closed = k('main', 'm', undefined, { children: [] });

    const { ops } = diffSnapshots(open, closed, reg, { wasEmitted: () => false });
    const removal = ops.find((o) => o.op === 'remove');
    if (removal?.op !== 'remove') throw new Error('unreachable');
    expect(removal.gone).toBeUndefined();
  });

  it('does not declare a ref dead when it moved out of the removed subtree', () => {
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, {
      children: [
        k('list', 'lb', 'Colours', { children: [k('option', 'red', 'Red')] }),
        k('region', 'side', 'Chosen'),
      ],
    });
    assignRefs(before, reg);
    const shown = new Set(refsIn(before));
    const redRef = reg.byKeyLookup('red')!.ref;

    const after = k('main', 'm', undefined, {
      children: [k('region', 'side', 'Chosen', { children: [k('option', 'red', 'Red')] })],
    });

    const { ops } = diffSnapshots(before, after, reg, { wasEmitted: (r) => shown.has(r) });
    const removal = ops.find((o) => o.op === 'remove');
    if (removal?.op !== 'remove') throw new Error('unreachable');
    expect(removal.gone ?? []).not.toContain(redRef);
  });

  it('retires refs inside a removed subtree whose ROOT is not addressable', () => {
    // The removed root decided whether the descendant walk ran at all, so a
    // plain <div> wrapper — `generic`, never addressable, never given a ref —
    // orphaned every ref beneath it. `<li>` rows holding buttons are the same
    // shape, and both are commoner than the addressable-rooted case the
    // original fix happened to cover.
    const reg = new RefRegistry();
    const open = k('main', 'm', undefined, {
      children: [
        k('generic', 'panel', undefined, {
          children: [k('button', 'a', 'Alpha action'), k('button', 'b', 'Beta action')],
        }),
      ],
    });
    assignRefs(open, reg);
    const shown = new Set(refsIn(open));
    const aRef = reg.byKeyLookup('a')!.ref;
    const bRef = reg.byKeyLookup('b')!.ref;
    expect(reg.byKeyLookup('panel')).toBeUndefined(); // the premise: no ref on the root

    const closed = k('main', 'm', undefined, { children: [] });
    const { ops } = diffSnapshots(open, closed, reg, { wasEmitted: (r) => shown.has(r) });

    // Bookkeeping: the registry must not still call them live.
    expect(reg.resolve(aRef)?.state).toBe('dead');
    expect(reg.resolve(bRef)?.state).toBe('dead');

    // Report: the model has no other way to learn they died.
    const out = render(ops, reg);
    expect(out).toMatch(new RegExp(`gone:[^\\n]*\\b${aRef}\\b`));
    expect(out).toMatch(new RegExp(`gone:[^\\n]*\\b${bRef}\\b`));
  });

  it('says nothing when a ref-less subtree held no refs either', () => {
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, {
      children: [k('generic', 'panel', undefined, { children: [k('text', 't', 'hello')] })],
    });
    assignRefs(before, reg);
    const after = k('main', 'm', undefined, { children: [] });
    const { ops } = diffSnapshots(before, after, reg, { wasEmitted: () => true });
    expect(ops).toHaveLength(0);
  });
});

describe('a native select restates its options when they turn over', () => {
  /** A walker-manufactured option node: enumerated inline, never given a ref. */
  const synth = (key: string, name: string, selected = false): SnapshotNode => ({
    role: 'option',
    name,
    key,
    synthetic: true,
    states: selected ? State.Selected : 0,
    frameId: 0,
    rect: [0, 0, 10, 10],
    children: [],
  });

  const stateSelect = (
    optionCount: number,
    value: string,
    children: SnapshotNode[],
  ): SnapshotNode =>
    k('combobox', 'sel-state', 'State', { optionCount, value, children });

  it('retracts a stale [N options] marker and the inline enumeration', () => {
    // The country -> state cascade, the commonest dependent-select pattern
    // there is. Three named options become fifty-one different ones; without a
    // restatement the agent still believes in "Victoria" and still believes it
    // needs no browser_read because the list is only three long.
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, {
      children: [
        stateSelect(3, 'Victoria', [
          synth('sel-state|opt0|vic', 'Victoria', true),
          synth('sel-state|opt1|nsw', 'New South Wales'),
          synth('sel-state|opt2|qld', 'Queensland'),
        ]),
      ],
    });
    assignRefs(before, reg);
    const after = k('main', 'm', undefined, {
      children: [stateSelect(51, 'State number 0', [])],
    });
    assignRefs(after, reg);

    const { ops } = diffSnapshots(before, after, reg, { wasEmitted: () => true });
    const out = render(ops, reg);
    expect(out).toContain('[51 options]');
    expect(out).not.toContain('[3 options]');
    expect(out).not.toContain('Victoria');
  });

  it('restates when the count is unchanged but the options are different', () => {
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, {
      children: [
        stateSelect(2, 'Victoria', [
          synth('sel-state|opt0|vic', 'Victoria', true),
          synth('sel-state|opt1|nsw', 'New South Wales'),
        ]),
      ],
    });
    assignRefs(before, reg);
    const after = k('main', 'm', undefined, {
      children: [
        stateSelect(2, 'Alabama', [
          synth('sel-state|opt0|al', 'Alabama', true),
          synth('sel-state|opt1|ak', 'Alaska'),
        ]),
      ],
    });
    assignRefs(after, reg);

    const { ops } = diffSnapshots(before, after, reg, { wasEmitted: () => true });
    // ONE restatement, not an add/remove script over nodes the agent cannot
    // address. The add/remove form happens to deliver the new labels, but it
    // never retracts the old ones — synthetic options carry no ref, so their
    // removal emits nothing at all.
    expect(ops.map((o) => o.op)).toEqual(['replace']);
    const out = render(ops, reg);
    expect(out).toContain('Alabama');
    expect(out).not.toContain('New South Wales');
  });

  it('does NOT restate when only the selection moved', () => {
    // A value change is one `~` line. Restating a 51-option select for it
    // would make the commonest select interaction the most expensive one.
    const reg = new RefRegistry();
    const before = k('main', 'm', undefined, {
      children: [
        stateSelect(2, 'Victoria', [
          synth('sel-state|opt0|vic', 'Victoria', true),
          synth('sel-state|opt1|nsw', 'New South Wales'),
        ]),
      ],
    });
    assignRefs(before, reg);
    const after = k('main', 'm', undefined, {
      children: [
        stateSelect(2, 'New South Wales', [
          synth('sel-state|opt0|vic', 'Victoria'),
          synth('sel-state|opt1|nsw', 'New South Wales', true),
        ]),
      ],
    });
    assignRefs(after, reg);

    const { ops } = diffSnapshots(before, after, reg, { wasEmitted: () => true });
    expect(ops.map((o) => o.op)).toEqual(['update']);
    expect(render(ops, reg)).toContain('="New South Wales"');
  });
});
