import type { RefEntry, Role, SnapshotNode } from './types.js';
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
// Label similarity
// ---------------------------------------------------------------------------

/*
 * `fuzzyRescue` lived here — a weighted guess (name similarity, href equality,
 * frame, geometry) at which live node a dead ref "really" meant, behind a 0.62
 * threshold. Deleted 2026-08-01, per docs/design/tier2b.md §2, for three
 * independent reasons:
 *
 *   1. It was never wired. Exported, doc-commented as the stale-ref rescue
 *      path, tested — and called from nowhere in src/. The act path already
 *      fails loudly on a dead ref, which is the behavior the doc comment
 *      claimed as the fallback's virtue.
 *   2. Its scoring provably could not serve its own motivating case. The
 *      metric was token-set Jaccard, which scores Follow→Following at 0.0, so
 *      a label morph could not clear 0.62 even with perfect geometry.
 *   3. The product's controlling failure class is wrong-element actions. A
 *      thresholded guess at which button the agent meant is a generator of
 *      exactly those, with a confidence knob on it.
 */

/**
 * Token-set Jaccard. Robust to reordered and partially-changed labels.
 *
 * TENURE, dated 2026-08-01: the sole intended consumer is tier2b P2's S-tier
 * reconciliation metric (docs/design/tier2b.md §3), which incorporates this as
 * one term. If P2's measurement (`bench/churn.mjs`) rules the fix unwarranted,
 * delete this and its tests in the same decision — do not leave a second
 * tested orphan behind the one just removed.
 */
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

export type { Role };
