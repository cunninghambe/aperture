import { describe, expect, it } from 'vitest';
import { RefRegistry } from '../src/core/snapshot/registry.js';
import { diffSnapshots, propDelta } from '../src/core/snapshot/diff.js';
import type { Snapshot, SnapshotNode } from '../src/core/snapshot/types.js';
import { State } from '../src/core/snapshot/types.js';

/**
 * THE CONGRUENCE CONTRACT.
 *
 * `propDelta` is what makes the product's central promise true — "a diff is
 * complete: anything it does not mention is unchanged". The promise is a
 * statement about a FIELD SET, and nothing ever tethered that field set to the
 * one the walker emits. `SnapshotNode` grew `href`, `rows`, `dims`, `scroll`,
 * `optionCount`; `propDelta` kept comparing the original five. No test failed,
 * because no test knew the two sets were supposed to agree.
 *
 * The cost of that gap, measured: a flattened data table whose every cell
 * changed produced ZERO ops, the agent was told "unchanged — the action caused
 * no visible change", and the zero-op path then absorbed the new tree into the
 * baseline, so the change became unreportable for the rest of the session
 * (docs/design/review-external-2026-08-01.md §1, probe-verified against
 * f4cd2e2). The href half of the same gap is a phishing primitive
 * (docs/design/security.md).
 *
 * So the guard is mechanical rather than a resolution to be careful. Every key
 * of `SnapshotNode` carries a ruling here; the table is typed as a total
 * mapping, so ADDING A FIELD FAILS THE TYPECHECK, and the sample node below
 * fails the test at runtime for the same reason. Every `diffed` ruling is then
 * probed against the real `propDelta`. Applied to the pre-fix engine this file
 * is RED on `href` and `rows` — it would have caught the original bug the day
 * `rows` was added.
 *
 * Adding a field to `SnapshotNode`? Record a ruling. If it is `excluded`, the
 * WHY is not optional: an exclusion nobody can defend in a sentence is a bug
 * wearing a ruling's clothes.
 */

type Ruling =
  /** `propDelta` must report a change in this field. */
  | { ruling: 'diffed' }
  /** Reported by the children/registry machinery instead. */
  | { ruling: 'structural'; by: string }
  /** Deliberately never reported. */
  | { ruling: 'excluded'; why: string };

// A total mapping: `keyof SnapshotNode` is the domain, so tsc rejects an
// unruled field before the test ever runs.
const NODE_RULINGS: Record<keyof SnapshotNode, Ruling> = {
  role: { ruling: 'structural', by: 'a role change changes the key, so it arrives as remove+add' },
  name: { ruling: 'diffed' },
  value: { ruling: 'diffed' },
  text: { ruling: 'diffed' },
  states: { ruling: 'diffed' },
  href: { ruling: 'diffed' },
  rows: { ruling: 'diffed' },

  optionCount: {
    ruling: 'structural',
    by: 'optionSetTurnedOver — covers the count AND same-count enumeration turnover; a propDelta copy would double-report',
  },
  children: { ruling: 'structural', by: 'reconcileChildren' },

  dims: {
    ruling: 'excluded',
    why: 'derived from rows (walker.ts computes one from the other), restated with them and never compared alone — rows equality implies dims equality',
  },
  scroll: {
    ruling: 'excluded',
    why: 'churns on every scroll by agent, user, or page; the agent\'s own scroll actions already return an observation, and the semantic consequence (Offscreen) is masked for the same reason',
  },
  rect: {
    ruling: 'excluded',
    why: 'geometry; agents act by ref, not coordinates, and it moves on every layout shift',
  },
  headingLevel: {
    ruling: 'excluded',
    why: 'presentation weight; the heading\'s text is the operative fact and IS diffed, and no failure class has been observed against the level',
  },
  autocomplete: {
    ruling: 'excluded',
    why: 'never rendered (types.ts) — the model never held it, so there is nothing to keep faithful',
  },
  inputType: {
    ruling: 'excluded',
    why: 'never rendered — same reasoning as autocomplete',
  },
  shape: { ruling: 'excluded', why: 'renderer-internal collapse hint, not a page fact' },
  ref: { ruling: 'excluded', why: 'identity plumbing; the registry owns ref lifetime' },
  key: { ruling: 'excluded', why: 'identity plumbing; never serialized to the model' },
  frameId: {
    ruling: 'excluded',
    why: 'identity plumbing; it is part of the key, so a node cannot change frame without changing identity',
  },
  synthetic: { ruling: 'excluded', why: 'identity plumbing; walker-manufactured nodes carry no ref' },
};

const SNAPSHOT_RULINGS: Record<keyof Snapshot, Ruling> = {
  url: { ruling: 'structural', by: 'the `navigated` hoist in engine.ts, which forces a full snapshot' },
  root: { ruling: 'structural', by: 'the tree walk itself' },
  modal: { ruling: 'structural', by: 'the dialog subtree\'s own add/remove' },
  seq: { ruling: 'excluded', why: 'the diff names the state it applies to; the id is framing, not a page fact' },
  epoch: { ruling: 'excluded', why: 'same — bookkeeping for the resync cap' },
  viewport: { ruling: 'excluded', why: 'full-only by design; scroll position is the excluded field family' },
  title: {
    ruling: 'excluded',
    why: 'tab-badge counters make the title a live region ("(3) Inbox" ticking) and the meaningful correlate — a route change — is the navigated check. Considered and rejected: diffing title',
  },
};

/**
 * Every optional field populated, so `Object.keys` enumerates the real domain.
 *
 * `Required<SnapshotNode>` is the point: a new field cannot be added to the
 * type without appearing here, and it cannot appear here without a ruling.
 */
const SAMPLE: Required<SnapshotNode> = {
  role: 'table',
  name: 'Shipments',
  ref: 'e7',
  key: 'I|0|table|shipments',
  value: 'v',
  href: '/checkout',
  text: 'some text',
  states: State.Selected,
  headingLevel: 2,
  frameId: 0,
  rect: [0, 0, 10, 10],
  scroll: { top: 0, height: 100 },
  dims: { rows: 1, cols: 2 },
  rows: [['Order', 'Status']],
  optionCount: 3,
  synthetic: false,
  autocomplete: 'email',
  inputType: 'text',
  shape: 'text',
  children: [],
};

const SAMPLE_SNAPSHOT: Required<Snapshot> = {
  seq: '1.0',
  epoch: 1,
  url: 'https://example.com/',
  title: 'Example',
  root: SAMPLE,
  viewport: { top: 0, height: 800, docHeight: 800 },
  modal: 'e9',
};

// -- helpers ----------------------------------------------------------------

function base(extra: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    role: 'table',
    name: 'Shipments',
    key: 'I|0|table|shipments',
    states: 0,
    frameId: 0,
    rect: [0, 0, 100, 40],
    children: [],
    ...extra,
  };
}

/** A pair differing in exactly one field, and nothing else. */
function pair(field: Partial<SnapshotNode>, changed: Partial<SnapshotNode>) {
  return [base(field), base(changed)] as const;
}

// -- the ruling table is total ----------------------------------------------

describe('every SnapshotNode field carries a ruling', () => {
  it('rules on every own key of a fully-populated node', () => {
    const unruled = Object.keys(SAMPLE).filter((k) => !(k in NODE_RULINGS));
    // If this fails you added a field to SnapshotNode. Decide what it means for
    // completeness and record it in NODE_RULINGS — see the header.
    expect(unruled).toEqual([]);
  });

  it('rules on every own key of a snapshot', () => {
    expect(Object.keys(SAMPLE_SNAPSHOT).filter((k) => !(k in SNAPSHOT_RULINGS))).toEqual([]);
  });

  it('gives every exclusion a defensible reason', () => {
    for (const [field, r] of Object.entries({ ...NODE_RULINGS, ...SNAPSHOT_RULINGS })) {
      if (r.ruling === 'excluded') expect(r.why.length, field).toBeGreaterThan(20);
      if (r.ruling === 'structural') expect(r.by.length, field).toBeGreaterThan(5);
    }
  });

  it('names the four exclusions the tool description promises', () => {
    // The shipped sentence is "Scroll positions and pixel layout are not
    // tracked; everything rendered … is." That is only honest while the
    // excluded set stays inside what the sentence admits to.
    const excluded = Object.entries(NODE_RULINGS)
      .filter(([, r]) => r.ruling === 'excluded')
      .map(([f]) => f);
    expect(excluded).toContain('scroll');
    expect(excluded).toContain('rect');
    // …and nothing RENDERED may join them. These are the rendered fields; if a
    // future change excludes one, the tool description becomes a lie.
    for (const rendered of ['name', 'value', 'text', 'states', 'href', 'rows']) {
      expect(NODE_RULINGS[rendered as keyof SnapshotNode].ruling, rendered).toBe('diffed');
    }
  });
});

// -- every 'diffed' field is actually diffed ---------------------------------

describe('propDelta reports every field ruled diffed', () => {
  it('name', () => {
    const [o, n] = pair({ name: 'Save' }, { name: 'Saved' });
    expect(propDelta(o, n)?.name).toEqual(['Save', 'Saved']);
  });

  it('value', () => {
    const [o, n] = pair({ value: 'a' }, { value: 'b' });
    expect(propDelta(o, n)?.value).toBe('b');
  });

  it('text', () => {
    const [o, n] = pair({ text: 'one' }, { text: 'two' });
    expect(propDelta(o, n)?.text).toEqual(['one', 'two']);
  });

  it('states', () => {
    const [o, n] = pair({ states: 0 }, { states: State.Checked });
    expect(propDelta(o, n)?.statesOn).toBe(State.Checked);
  });

  it('href — RED against the pre-fix engine', () => {
    const [o, n] = pair({ href: '/checkout' }, { href: '/checkout-v2' });
    expect(propDelta(o, n)?.href).toEqual(['/checkout', '/checkout-v2']);
  });

  it('rows — RED against the pre-fix engine', () => {
    const [o, n] = pair(
      { rows: [['#1001', 'Pending']], dims: { rows: 1, cols: 2 } },
      { rows: [['#1001', 'SHIPPED']], dims: { rows: 1, cols: 2 } },
    );
    const d = propDelta(o, n);
    expect(d?.rows).toEqual([['#1001', 'SHIPPED']]);
    // dims rides with rows and is never emitted alone.
    expect(d?.dims).toEqual({ rows: 1, cols: 2 });
  });
});

describe('the structural rulings are honoured by diffSnapshots', () => {
  const parent = (kids: SnapshotNode[]): SnapshotNode => ({
    role: 'main', name: 'main', key: 'I|0|main|m', states: 0, frameId: 0,
    rect: [0, 0, 100, 100], children: kids,
  });
  const kid = (key: string, name: string): SnapshotNode => ({
    role: 'button', name, key, states: 0, frameId: 0, rect: [0, 0, 10, 10], children: [],
  });

  it('children', () => {
    const reg = new RefRegistry();
    const before = parent([kid('I|0|button|a', 'A')]);
    const after = parent([kid('I|0|button|a', 'A'), kid('I|0|button|b', 'B')]);
    expect(diffSnapshots(before, after, reg).ops.length).toBeGreaterThan(0);
  });

  it('optionCount', () => {
    const reg = new RefRegistry();
    const sel = (count: number): SnapshotNode => ({
      role: 'combobox', name: 'State', key: 'N|0|combobox|state', states: 0,
      frameId: 0, rect: [0, 0, 10, 10], optionCount: count, children: [],
    });
    expect(diffSnapshots(parent([sel(3)]), parent([sel(51)]), reg).ops.length).toBeGreaterThan(0);
  });
});

// -- the exclusions are exclusions, not accidents ----------------------------

describe('the excluded fields stay excluded', () => {
  it('a scroll offset alone is not a diff', () => {
    const [o, n] = pair({ scroll: { top: 0, height: 900 } }, { scroll: { top: 400, height: 900 } });
    expect(propDelta(o, n)).toBeNull();
  });

  it('Offscreen alone is not a diff', () => {
    const [o, n] = pair({ states: 0 }, { states: State.Offscreen });
    expect(propDelta(o, n)).toBeNull();
  });

  it('geometry alone is not a diff', () => {
    const [o, n] = pair({ rect: [0, 0, 10, 10] }, { rect: [0, 700, 10, 10] });
    expect(propDelta(o, n)).toBeNull();
  });

  it('a heading level alone is not a diff', () => {
    const [o, n] = pair({ headingLevel: 2 }, { headingLevel: 3 });
    expect(propDelta(o, n)).toBeNull();
  });

  it('identical nodes produce nothing at all', () => {
    // The complement of every assertion above: completeness is worthless if
    // bought with false positives, because a diff that fires on nothing is a
    // diff the agent learns to discount.
    expect(propDelta(base({ rows: [['a', 'b']], href: '/x' }), base({ rows: [['a', 'b']], href: '/x' }))).toBeNull();
  });
});
