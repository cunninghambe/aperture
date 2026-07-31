import type { Rect, RefEntry, Role, SnapshotNode } from './types.js';

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
    if (e) e.state = 'dead';
  }

  markEmitted(ref: string, seq: string): void {
    const e = this.byRef.get(ref);
    if (!e) return;
    e.emitted = true;
    e.lastSeenSeq = seq;
  }

  wasEmitted(ref: string): boolean {
    return this.byRef.get(ref)?.emitted ?? false;
  }

  /** Mark every ref not seen in this snapshot as dead. */
  reapExcept(liveKeys: Set<string>): string[] {
    const died: string[] = [];
    for (const [key, entry] of this.byKey) {
      if (entry.state === 'live' && !liveKeys.has(key)) {
        entry.state = 'dead';
        died.push(entry.ref);
      }
    }
    return died;
  }
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
