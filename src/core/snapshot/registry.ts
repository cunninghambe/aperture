import type { Rect, RefEntry, Role, SnapshotNode } from './types.js';
import { isAddressableRole } from './walker.js';

/**
 * Allocates and resolves agent-facing element refs.
 *
 * A ref names a *logical element*, not a DOM node. That distinction is the
 * whole point: a React re-render can replace every node on the page and the
 * agent's `e42` must still mean the same button. Identity comes from the key
 * computed in the walker (see walker.ts `identityKey`), so matching here is a
 * hash lookup rather than a tree-edit-distance search.
 *
 * Refs are never reused within a page session. A dead ref stays dead —
 * or gets *revived* if its key reappears, which is what makes tabbed UIs
 * behave sanely when the agent switches away and back.
 */
export class RefRegistry {
  private byRef = new Map<string, RefEntry>();
  private byKey = new Map<string, RefEntry>();
  private counter = 0;

  /** Allocate a ref for this node, or revive the one its key already owns. */
  ensureRef(n: SnapshotNode): string {
    const existing = this.byKey.get(n.key);
    if (existing) {
      existing.state = 'live';
      existing.role = n.role;
      if (n.name !== undefined) existing.name = n.name;
      if (n.href !== undefined) existing.href = n.href;
      existing.rect = n.rect;
      n.ref = existing.ref;
      return existing.ref;
    }

    const ref = `e${++this.counter}`;
    const entry: RefEntry = {
      ref,
      key: n.key,
      frameId: n.frameId,
      role: n.role,
      name: n.name,
      href: n.href,
      rect: n.rect,
      state: 'live',
      emitted: false,
      needsReannounce: false,
      lastSeenSeq: '0.0',
    };
    this.byRef.set(ref, entry);
    this.byKey.set(n.key, entry);
    n.ref = ref;
    return ref;
  }

  refOf(n: SnapshotNode): string {
    return n.ref ?? this.ensureRef(n);
  }

  resolve(ref: string): RefEntry | undefined {
    return this.byRef.get(ref);
  }

  byKeyLookup(key: string): RefEntry | undefined {
    return this.byKey.get(key);
  }

  markDead(ref: string): void {
    const e = this.byRef.get(ref);
    if (!e) return;
    e.state = 'dead';
    // A ref the model was never shown owes it nothing on the way back. One it
    // *was* shown, and has since deleted, must be re-stated in full if the key
    // ever reappears — otherwise the revival is invisible and every later
    // mention of the ref refers to something the model no longer holds.
    if (e.emitted) e.needsReannounce = true;
  }

  markEmitted(ref: string, seq: string): void {
    const e = this.byRef.get(ref);
    if (!e) return;
    e.emitted = true;
    // Rendering the full line IS the re-announcement.
    e.needsReannounce = false;
    e.lastSeenSeq = seq;
  }

  wasEmitted(ref: string): boolean {
    return this.byRef.get(ref)?.emitted ?? false;
  }

  /** True while a revived ref still owes the model a full line. */
  needsReannounce(ref: string): boolean {
    return this.byRef.get(ref)?.needsReannounce ?? false;
  }

  // `reapExcept(liveKeys)` used to live here, never called from anywhere in
  // the repo, and it read as a second net under the diff's bookkeeping. It was
  // not one, and it must not become one: a full snapshot's rendered lines are
  // subject to run collapsing and the budget cut, so "not in this snapshot"
  // does not mean "not on the page". Reaping on that basis would kill refs the
  // agent can still legitimately act on. The diff is the only place that knows
  // a node actually went away — which is why the descendant walk in
  // `diff.ts`'s removal loop has to be right rather than backstopped.
}

/**
 * Assign refs across a fresh walk tree, in document order.
 *
 * Two classes of node get a ref re-attached:
 *   1. Addressable roles — the normal case.
 *   2. Any node whose identity key the registry already knows.
 *
 * Case 2 is the fix for the `wasEmitted` deadlock. A non-addressable node (a
 * product-count paragraph, say) can be *given* a ref mid-diff when its content
 * changes — but on every later walk it arrived here ref-less, so the renderer
 * never showed its ref, `markEmitted` never ran, and the `wasEmitted` gate in
 * diff.ts suppressed its changes permanently, even after a full re-read.
 * Re-attaching the ref means the next full snapshot renders it, marks it
 * emitted, and unlocks its diff channel — a full re-read now actually heals
 * the blind spot instead of leaving it.
 *
 * Synthetic nodes are excluded from BOTH cases. `option` became an addressable
 * role when the `select` action landed, which is right for a custom ARIA
 * listbox — those options are real elements — and would otherwise hand out
 * refs for the option nodes the walker manufactures to enumerate a native
 * `<select>`. Those have no entry in the page-side index, so every action on
 * one would fail: exactly the guaranteed-failing bait that keeping `option`
 * out of the addressable set used to prevent.
 */
export function assignRefs(root: SnapshotNode, reg: RefRegistry): void {
  if (!root.synthetic && (isAddressableRole(root.role) || reg.byKeyLookup(root.key))) {
    reg.ensureRef(root);
  }
  for (const c of root.children) assignRefs(c, reg);
}

// ---------------------------------------------------------------------------
// Stale-ref rescue
// ---------------------------------------------------------------------------

/**
 * When an agent acts on a ref whose node is gone, guessing wrong is worse than
 * failing — clicking the wrong button can be destructive. So the threshold is
 * deliberately high, and anything below it fails with a micro-snapshot instead
 * of acting.
 */
const RESCUE_THRESHOLD = 0.62;

export function fuzzyRescue(
  lost: RefEntry,
  candidates: SnapshotNode[],
): SnapshotNode | null {
  let best: SnapshotNode | null = null;
  let bestScore = 0;

  for (const c of candidates) {
    if (c.role !== lost.role) continue;
    const score =
      0.45 * nameSimilarity(lost.name ?? '', c.name ?? '') +
      0.2 * (eqIdent(lost.href, c.href) ? 1 : 0) +
      0.2 * (c.frameId === lost.frameId ? 1 : 0) +
      0.15 * geomProximity(lost.rect, c.rect);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= RESCUE_THRESHOLD ? best : null;
}

function eqIdent(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a === b;
}

/** Token-set Jaccard. Robust to reordered and partially-changed labels. */
export function nameSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** Decays to zero over ~400px of centre-to-centre distance. */
function geomProximity(a: Rect, b: Rect): number {
  const ax = a[0] + a[2] / 2;
  const ay = a[1] + a[3] / 2;
  const bx = b[0] + b[2] / 2;
  const by = b[1] + b[3] / 2;
  const d = Math.hypot(ax - bx, ay - by);
  return Math.max(0, 1 - d / 400);
}

export type { Role };
