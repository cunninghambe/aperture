import type { RefRegistry } from './registry.js';
import type { DiffOp, PropDelta, SnapshotNode } from './types.js';
import { State } from './types.js';

/**
 * Diffing two snapshots.
 *
 * Classic tree-edit-distance (Zhang-Shasha and friends) solves an
 * identity-free matching problem at O(n^2) or worse. We don't have that
 * problem: the walker gives every node a stable identity key, so matching is
 * a hash lookup and reconciliation is O(n) — the same trick virtual-DOM
 * libraries use.
 */

export interface DiffOptions {
  /** Keys the volatility tracker says are noisy; content changes suppressed. */
  isVolatile?: (key: string) => boolean;
  /** Whether the model has ever been shown this ref. */
  wasEmitted?: (ref: string) => boolean;
}

export interface DiffResult {
  ops: DiffOp[];
  suppressed: number;
  unreadChanges: number;
}

/**
 * Below this ratio of matched children, a container is reported as one
 * `replace` rather than an interleaved add/remove script. Costs more tokens
 * than a minimal edit script, but a wholesale restatement is far less likely
 * to be misapplied by a model maintaining the page in its head — and model
 * reliability is worth more here than diff minimality.
 */
const REPLACE_MATCH_RATIO = 0.4;
const REPLACE_MIN_CHILDREN = 8;

export function diffSnapshots(
  oldRoot: SnapshotNode,
  newRoot: SnapshotNode,
  reg: RefRegistry,
  opts: DiffOptions = {},
): DiffResult {
  const ops: DiffOp[] = [];
  let suppressed = 0;
  let unreadChanges = 0;

  const oldByKey = indexByKey(oldRoot);
  const newByKey = indexByKey(newRoot);

  const isVolatile = opts.isVolatile ?? (() => false);
  const wasEmitted = opts.wasEmitted ?? (() => true);

  walk(oldRoot, newRoot);
  return { ops, suppressed, unreadChanges };

  function walk(o: SnapshotNode, n: SnapshotNode): void {
    const delta = propDelta(o, n);
    if (delta) {
      // A ticker or clock changing on its own is not news. Structural changes
      // still get reported — only content churn is suppressed.
      const contentOnly =
        delta.statesOn === undefined && delta.statesOff === undefined;
      if (contentOnly && isVolatile(n.key)) {
        suppressed++;
      } else {
        const ref = reg.ensureRef(n);
        if (!wasEmitted(ref)) unreadChanges++;
        else ops.push({ op: 'update', ref, delta });
      }
    }

    const oldKids = o.children;
    const newKids = n.children;
    if (oldKids.length === 0 && newKids.length === 0) return;

    const matched = countMatched(oldKids, newKids);
    const span = Math.max(oldKids.length, newKids.length);
    if (span >= REPLACE_MIN_CHILDREN && matched / span < REPLACE_MATCH_RATIO) {
      // A replace must say what it DESTROYED, not only what it created.
      //
      // Measured failure this fixes: emitting the new subtree alone left the
      // model holding refs for every element the replace removed, with no
      // mechanical way to learn they were gone. Fidelity check reported 8
      // phantom refs — elements the agent believed existed and did not — which
      // is precisely how a wrong-element click happens.
      const survivors = new Set<string>();
      collectKeys(n, survivors);
      const gone: string[] = [];
      for (const key of keysOf(o)) {
        if (survivors.has(key)) continue;
        const ref = reg.byKeyLookup(key)?.ref;
        if (ref) {
          gone.push(ref);
          reg.markDead(ref);
        }
      }

      ops.push({ op: 'replace', ref: reg.ensureRef(n), subtree: n, gone });
      return;
    }

    reconcileChildren(o, n);
  }

  function reconcileChildren(o: SnapshotNode, n: SnapshotNode): void {
    const remaining = new Map<string, SnapshotNode>();
    for (const c of o.children) remaining.set(c.key, c);

    // First pass: pair up survivors and note their old positions, so the LIS
    // below can tell "the list reordered" from "one item jumped to the top".
    const oldIndex = new Map<string, number>();
    o.children.forEach((c, i) => oldIndex.set(c.key, i));

    const survivorPositions: number[] = [];
    const survivors: SnapshotNode[] = [];
    for (const nk of n.children) {
      const pos = oldIndex.get(nk.key);
      if (pos !== undefined) {
        survivorPositions.push(pos);
        survivors.push(nk);
      }
    }
    const stable = new Set(
      longestIncreasingSubsequence(survivorPositions).map((i) => survivors[i]!.key),
    );

    let anchor: SnapshotNode | null = null;
    for (const nk of n.children) {
      const ok = remaining.get(nk.key);
      if (ok) {
        remaining.delete(nk.key);
        walk(ok, nk);
        // Only items outside the stable subsequence actually moved, so
        // "one row jumped to the top" is a single op, not twenty.
        if (!stable.has(nk.key)) {
          ops.push({
            op: 'move',
            ref: reg.ensureRef(nk),
            parent: reg.ensureRef(n),
            after: anchor ? reg.refOf(anchor) : null,
          });
        }
        anchor = nk;
        continue;
      }

      const movedFromElsewhere = oldByKey.get(nk.key);
      if (movedFromElsewhere) {
        ops.push({
          op: 'move',
          ref: reg.ensureRef(nk),
          parent: reg.ensureRef(n),
          after: anchor ? reg.refOf(anchor) : null,
        });
        walk(movedFromElsewhere, nk);
      } else {
        ops.push({
          op: 'add',
          parent: reg.ensureRef(n),
          after: anchor ? reg.refOf(anchor) : null,
          subtree: nk,
        });
      }
      anchor = nk;
    }

    // Anything left unmatched is gone — unless it turned up elsewhere in the
    // new tree, in which case the move op was already emitted at its
    // destination and reporting a removal here would be a lie.
    for (const [key, gone] of remaining) {
      if (newByKey.has(key)) continue;
      const ref = gone.ref ?? reg.byKeyLookup(key)?.ref;
      if (!ref) continue;
      ops.push({ op: 'remove', ref, role: gone.role, label: gone.name });
      reg.markDead(ref);
    }
  }
}

function countMatched(a: SnapshotNode[], b: SnapshotNode[]): number {
  const keys = new Set(a.map((c) => c.key));
  let n = 0;
  for (const c of b) if (keys.has(c.key)) n++;
  return n;
}

export function propDelta(o: SnapshotNode, n: SnapshotNode): PropDelta | null {
  const d: PropDelta = {};
  let any = false;

  if ((o.name ?? '') !== (n.name ?? '')) {
    d.name = [o.name ?? '', n.name ?? ''];
    any = true;
  }
  if ((o.value ?? '') !== (n.value ?? '')) {
    d.value = n.value ?? '';
    any = true;
  }
  if ((o.text ?? '') !== (n.text ?? '')) {
    d.text = [o.text ?? '', n.text ?? ''];
    any = true;
  }

  // Offscreen flips on every scroll and is not worth a diff line of its own.
  const mask = ~State.Offscreen;
  const on = (n.states & ~o.states) & mask;
  const off = (o.states & ~n.states) & mask;
  if (on) {
    d.statesOn = on;
    any = true;
  }
  if (off) {
    d.statesOff = off;
    any = true;
  }

  return any ? d : null;
}

function collectKeys(n: SnapshotNode, out: Set<string>): void {
  out.add(n.key);
  for (const c of n.children) collectKeys(c, out);
}

function keysOf(n: SnapshotNode): string[] {
  const s = new Set<string>();
  collectKeys(n, s);
  return [...s];
}

export function indexByKey(root: SnapshotNode): Map<string, SnapshotNode> {
  const m = new Map<string, SnapshotNode>();
  const stack: SnapshotNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    m.set(n.key, n);
    for (const c of n.children) stack.push(c);
  }
  return m;
}

/**
 * Indices of a longest increasing subsequence. Standard patience-sorting
 * implementation; used to find the largest set of children that did not move
 * relative to each other.
 */
export function longestIncreasingSubsequence(seq: number[]): number[] {
  if (seq.length === 0) return [];
  const piles: number[] = [];
  const back: number[] = new Array(seq.length).fill(-1);

  for (let i = 0; i < seq.length; i++) {
    const v = seq[i]!;
    let lo = 0;
    let hi = piles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[piles[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[i] = piles[lo - 1]!;
    piles[lo] = i;
    if (lo === piles.length - 1 && piles.length > 0) {
      // piles[lo] just set; nothing further needed
    }
  }

  const out: number[] = [];
  let k = piles[piles.length - 1] ?? -1;
  while (k >= 0) {
    out.push(k);
    k = back[k]!;
  }
  return out.reverse();
}
