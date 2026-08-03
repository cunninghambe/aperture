import type { RefRegistry } from './registry.js';
import type { DiffOp, PropDelta, SnapshotNode } from './types.js';
import { State } from './types.js';
import { isPositionalKey } from './walker.js';

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
  /** Refs the pre-pass retired this observation, by key — see
   *  `retirePositionalRebinds`. A surviving key's old ref is dead but no longer
   *  reachable through `byKeyLookup`; `gone` reporting needs this map to stay
   *  truthful. */
  retiredRef?: (key: string) => string | undefined;
}

export interface DiffResult {
  ops: DiffOp[];
  suppressed: number;
  unreadChanges: number;
  /**
   * The changes behind the `unreadChanges` count, with key and new text.
   *
   * The engine needs these to feed the volatility tracker. Without them, a
   * clock that lives behind the unread gate (never rendered, so never
   * emitted) generated a "changes in regions you have not read" note on every
   * single observation forever — the tracker only ever heard about emitted
   * ops, so the clock could never be demoted to volatile.
   */
  unread: { key: string; text?: string }[];
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

/**
 * The key an ordinal-suffixed key is a positional variant of.
 *
 * `disambiguate` (walker.ts) leaves the FIRST occurrence bare and suffixes the
 * rest, so a family is the bare key plus its `|#N` siblings and they all fold
 * to the same base.
 */
function positionalBase(key: string): string {
  return key.replace(/\|#\d+$/, '');
}

/**
 * Retire every ref of every positional family whose membership changed
 * between two consecutive walks — the identity half of the P1/P2 escalation,
 * and the close of the removal-side hole the head-to-head measured
 * (docs/design/h2h-evaluation.md §2; docs/design/tier5.md).
 *
 * Runs BEFORE `assignRefs`, so the severed keys mint fresh refs and the
 * restatement the escalation emits carries the successors. Returns
 * key → retired ref, which `diffSnapshots` needs to keep the `gone` lists
 * truthful: a surviving key's OLD ref is dead even though the key lives on,
 * and `byKeyLookup` can no longer say so.
 *
 * The family here is GLOBAL (grouped by positionalBase over the whole tree),
 * matching how `disambiguate` actually assigns ordinals — `ctx.seen` is
 * walk-global. Retirement fires only when (a) the group's old and new key
 * sets differ, and (b) at least one new key is already known to the registry
 * — i.e. something is actually held that could rebind. A pure re-walk with
 * unchanged membership retires nothing (the RESULTS.md §B property), a brand
 * new family retires nothing, and a family that disappears retires at its
 * REAPPEARANCE (when its dead keys would otherwise revive by position).
 */
export function retirePositionalRebinds(
  oldRoot: SnapshotNode,
  newRoot: SnapshotNode,
  reg: RefRegistry,
): Map<string, string> {
  interface Group { old: Set<string>; nw: Set<string>; positional: boolean }
  const groups = new Map<string, Group>();
  const collect = (root: SnapshotNode, side: 'old' | 'nw'): void => {
    const stack: SnapshotNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      const base = positionalBase(n.key);
      let g = groups.get(base);
      if (!g) {
        g = { old: new Set(), nw: new Set(), positional: false };
        groups.set(base, g);
      }
      g[side].add(n.key);
      if (isPositionalKey(n.key)) g.positional = true;
      for (const c of n.children) stack.push(c);
    }
  };
  collect(oldRoot, 'old');
  collect(newRoot, 'nw');

  const retired = new Map<string, string>();
  for (const [, g] of groups) {
    if (!g.positional) continue;
    const union = new Set([...g.old, ...g.nw]);
    if (union.size < 2) continue;
    if (g.old.size === g.nw.size && [...g.old].every((k) => g.nw.has(k))) {
      continue; // membership unchanged — nothing rebinds
    }
    if (![...g.nw].some((k) => reg.byKeyLookup(k))) continue; // nothing held
    for (const k of union) {
      const ref = reg.retireKey(k);
      if (ref) retired.set(k, ref);
    }
  }
  return retired;
}

export function diffSnapshots(
  oldRoot: SnapshotNode,
  newRoot: SnapshotNode,
  reg: RefRegistry,
  opts: DiffOptions = {},
): DiffResult {
  const ops: DiffOp[] = [];
  let suppressed = 0;
  const unread: { key: string; text?: string }[] = [];

  const oldByKey = indexByKey(oldRoot);
  const newByKey = indexByKey(newRoot);

  const isVolatile = opts.isVolatile ?? (() => false);
  const wasEmitted = opts.wasEmitted ?? (() => true);

  walk(oldRoot, newRoot);
  return { ops, suppressed, unreadChanges: unread.length, unread };

  /**
   * A ref for this node, or null when it must never have one.
   *
   * `ensureRef` allocates on demand, so every call site in this file is a
   * place a synthetic node — a walker-manufactured `option` for a native
   * `<select>`, with no element behind it in the page-side index — could be
   * handed a ref that no action can ever resolve. There is no such thing as a
   * harmless one: the agent sees it in a diff and calls `browser_act` on it.
   */
  function refIfReal(n: SnapshotNode): string | null {
    return n.synthetic ? null : reg.ensureRef(n);
  }

  /**
   * Refs destroyed by turning `o` into `n`, marked dead and reported.
   *
   * The death is bookkeeping and happens for every destroyed ref. The REPORT
   * lists only refs the model was actually shown, because naming refs it never
   * held is pure token waste — on a first-step replace that was most of the
   * list.
   *
   * The retired branch comes FIRST, before the survivor skip, and that ordering
   * is the point: a SURVIVING positional key's old ref is dead too — the key
   * lives on, bound to whatever element occupies the position now — so `gone`
   * has to name it even though the key itself is a survivor
   * (docs/design/tier5.md §3.2). It does not call `markDead`: the pre-pass
   * already did, deliberately without `needsReannounce`, because a retired
   * entry can never be revived.
   */
  function buryUnder(o: SnapshotNode, survivors: Set<string>): string[] {
    const gone: string[] = [];
    for (const key of keysOf(o)) {
      const retiredRef = opts.retiredRef?.(key);
      if (retiredRef) {
        if (wasEmitted(retiredRef)) gone.push(retiredRef);
        continue;
      }
      if (survivors.has(key)) continue;
      const ref = reg.byKeyLookup(key)?.ref;
      if (!ref) continue;
      const known = wasEmitted(ref);
      reg.markDead(ref);
      if (known) gone.push(ref);
    }
    return gone;
  }

  function walk(o: SnapshotNode, n: SnapshotNode): void {
    // A native `<select>`'s options are a PROPERTY of the select, not children
    // the agent can address — they are synthetic, they never carry refs, and
    // the `[N options]` marker is not a field `propDelta` compares. So a
    // country -> state cascade (the commonest dependent-select pattern there
    // is) used to leave the model holding three option names that no longer
    // exist and a marker saying it need not read the list, when the list is
    // now fifty-one different entries. One restatement fixes both, and it is
    // cheap: a long select renders as a single line.
    //
    // `!n.synthetic` is belt-and-braces — only a real `<select>` ever carries
    // `optionCount`, so this cannot fire on a manufactured node. But this is a
    // new `ensureRef` call site, and the invariant worth being checkable by
    // inspection is that EVERY `ensureRef` in this file is synthetic-safe.
    //
    // The list of escalation sites, kept current rather than weakened: this
    // option-turnover replace; the match-ratio replace below; P1 (a positional
    // family that LOST a member); P2 (one that GAINED a member —
    // docs/design/tier4.md §1.3). The last three hold by one argument: each
    // runs only on a node whose children are under sibling analysis, and a
    // walker-manufactured `option` is a childless leaf, so none of them can
    // ever be handed one.
    if (!n.synthetic && optionSetTurnedOver(o, n)) {
      const survivors = new Set<string>();
      collectKeys(n, survivors);
      ops.push({
        op: 'replace',
        ref: reg.ensureRef(n),
        subtree: n,
        gone: buryUnder(o, survivors),
      });
      return;
    }

    const delta = propDelta(o, n);
    if (delta) {
      // A ticker or clock changing on its own is not news. Structural changes
      // still get reported — only content churn is suppressed.
      const contentOnly =
        delta.statesOn === undefined && delta.statesOff === undefined;
      if (n.synthetic) {
        // A synthetic option flipping `selected` is not lost information: it is
        // the same fact as the parent select's `="…"` value update, which is
        // emitted on a ref that resolves. Naming it separately would cost a ref
        // that cannot.
      } else if (contentOnly && isVolatile(n.key)) {
        suppressed++;
      } else {
        const ref = reg.ensureRef(n);
        if (!wasEmitted(ref)) {
          unread.push({
            key: n.key,
            text: delta.text?.[1] ?? delta.name?.[1] ?? delta.value,
          });
        } else ops.push({ op: 'update', ref, delta });
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
      ops.push({
        op: 'replace',
        ref: reg.ensureRef(n),
        subtree: n,
        gone: buryUnder(o, survivors),
      });
      return;
    }

    // Third escalation: a POSITIONAL FAMILY changed MEMBERSHIP — removal or
    // insertion (docs/design/tier4.md §1).
    //
    // `disambiguate` gives the first occurrence of a key the bare key and
    // suffixes the rest `|#1`, `|#2`… — so for elements distinguishable only
    // by document order, identity IS the ordinal. Remove one and every
    // survivor below it silently renumbers: `e12` still resolves, still points
    // at a live element, and points at a DIFFERENT row than the one the agent
    // read. Wave 2 measured the cost live — 6 wrong-element clicks in
    // `queue-positional`, every one a stale ordinal after a removal.
    //
    // Insertion does the same damage from the other end, and used to do it in
    // silence. A prepend re-binds every held ref one row down while the only
    // op emitted is an `add` naming the BOTTOM of the list, because the new
    // member always takes the highest ordinal wherever it physically landed.
    // Wave 3 vindicated the removal half live (110-vs-64 stale-ref acts, under
    // re-keying explicit restatement beats silence); the insertion half is the
    // same fact about ordinals, so it gets the same op.
    //
    // A per-child edit script cannot express this, because nothing in it is
    // false: the ops are individually correct and the model's ordinals are
    // collectively wrong. Restating the container is the one op that hands the
    // model fresh label→ref lines in the same observation, in vocabulary it
    // and the bench reader already speak. Cost is the container, paid only on
    // the membership-change event — which is precisely the event that
    // invalidated the ordinals.
    //
    // Since tier5 the restatement's refs are the NEXT GENERATION: the
    // pre-pass `retirePositionalRebinds` has already retired every prior
    // -generation ref of the family, `assignRefs` has minted fresh ones, and
    // `buryUnder` names every retired ref the model was shown in `(gone: …)` —
    // survivors included. Restating without retiring was the removal-side
    // defect the head-to-head measured: same numbers, one row off, in silence
    // (docs/design/tier5.md §1). The two are one design — retire without
    // restating and the model would hold zero live refs for this family.
    if (
      positionalFamilyLostAMember(oldKids, newKids) ||
      positionalFamilyGainedAMember(oldKids, newKids)
    ) {
      const survivors = new Set<string>();
      collectKeys(n, survivors);
      ops.push({
        op: 'replace',
        ref: reg.ensureRef(n),
        subtree: n,
        gone: buryUnder(o, survivors),
      });
      return;
    }

    reconcileChildren(o, n);
  }

  /**
   * Did a removal renumber the ordinals of surviving siblings?
   *
   * A positional family is a bare key plus its `|#N` suffixed siblings: ≥2 old
   * children sharing a `positionalBase`, at least one of which is actually
   * ordinal-suffixed. The family lost a member when one of its keys is absent
   * from both the new children AND the rest of the new tree (a key that turned
   * up elsewhere moved, it did not die) while at least one sibling survives in
   * place.
   *
   * This predicate decides the WIRE only. Since tier5 the IDENTITY decision
   * belongs to `retirePositionalRebinds`, which runs as an engine pre-pass on
   * every delivery path: the refs this restatement carries are a fresh
   * generation and every prior-generation ref is retired and named in `gone`
   * (docs/design/tier5.md §2.3). Not one byte of this predicate changed.
   */
  function positionalFamilyLostAMember(
    oldKids: SnapshotNode[],
    newKids: SnapshotNode[],
  ): boolean {
    const families = new Map<string, string[]>();
    for (const c of oldKids) {
      const base = positionalBase(c.key);
      const fam = families.get(base);
      if (fam) fam.push(c.key);
      else families.set(base, [c.key]);
    }

    const newKeys = new Set(newKids.map((c) => c.key));
    for (const [, keys] of families) {
      if (keys.length < 2) continue;
      if (!keys.some(isPositionalKey)) continue;
      let removed = false;
      let survived = false;
      for (const key of keys) {
        if (newKeys.has(key)) survived = true;
        else if (!newByKey.has(key)) removed = true;
      }
      if (removed && survived) return true;
    }
    return false;
  }

  /**
   * Did an insertion renumber the ordinals of surviving siblings?
   *
   * The mirror of `positionalFamilyLostAMember`, and the close of tier3 §3.1's
   * open hole: prepending an identical row into a positional family used to
   * emit ONE `add` op (claiming insertion at the END — the ordinal suffix is
   * always the highest) while every held ref silently rebound one row down.
   * The key SET cannot distinguish prepend from append, so this fires on ANY
   * genuine growth of a positional family: the append false-positive costs one
   * bounded restatement of a family that is by construction small-N identical
   * rows, and the prepend false-negative cost an agent acting on the wrong row
   * with no diff line saying so (docs/design/tier4.md §1).
   *
   * A positional family here is judged on the NEW side (≥2 new children
   * sharing a `positionalBase`, at least one ordinal-suffixed — which growth
   * guarantees). It gained a member when some member key is absent from the
   * whole OLD tree (a key that existed elsewhere moved, it was not born) while
   * at least one member key was already among this parent's old children — a
   * survivor whose binding the insertion may have shifted.
   *
   * What this does NOT see, stated rather than implied away: a removal and an
   * insertion of two indistinguishable rows between the same pair of walks.
   * The key set, the family size and every per-key property come out
   * unchanged, so nothing at this layer — or any other this engine owns — has
   * a signal for it (tier4 §1.4 residual 1). Nor a member that MOVED IN from
   * elsewhere in the old tree: its key already existed, so `added` stays false
   * (residual 2).
   *
   * Like P1, this predicate decides the WIRE only. The refs the restatement
   * carries are a fresh generation since tier5: `retirePositionalRebinds`
   * retires every prior-generation ref of the family before `assignRefs` can
   * revive one, and `gone` names each one the model was shown
   * (docs/design/tier5.md §2.3). Not one byte of this predicate changed.
   */
  function positionalFamilyGainedAMember(
    oldKids: SnapshotNode[],
    newKids: SnapshotNode[],
  ): boolean {
    const oldKidKeys = new Set(oldKids.map((c) => c.key));
    const families = new Map<string, string[]>();
    for (const c of newKids) {
      const base = positionalBase(c.key);
      const fam = families.get(base);
      if (fam) fam.push(c.key);
      else families.set(base, [c.key]);
    }

    for (const [, keys] of families) {
      if (keys.length < 2) continue;
      if (!keys.some(isPositionalKey)) continue;
      let added = false;
      let survived = false;
      for (const key of keys) {
        if (oldKidKeys.has(key)) survived = true;
        else if (!oldByKey.has(key)) added = true;
      }
      if (added && survived) return true;
    }
    return false;
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
    // An anchor is a ref the model is told to position against, so a synthetic
    // one is no anchor at all — `after: null` degrades to "under the parent",
    // which is true.
    const anchorRef = (): string | null =>
      anchor && !anchor.synthetic ? reg.refOf(anchor) : null;

    for (const nk of n.children) {
      const ok = remaining.get(nk.key);
      if (ok) {
        remaining.delete(nk.key);
        walk(ok, nk);
        // Only items outside the stable subsequence actually moved, so
        // "one row jumped to the top" is a single op, not twenty.
        const moved = !stable.has(nk.key) ? refIfReal(nk) : null;
        if (moved) {
          ops.push({
            op: 'move',
            ref: moved,
            parent: reg.ensureRef(n),
            after: anchorRef(),
          });
        }
        anchor = nk;
        continue;
      }

      const movedFromElsewhere = oldByKey.get(nk.key);
      if (movedFromElsewhere) {
        const ref = refIfReal(nk);
        if (ref) {
          ops.push({
            op: 'move',
            ref,
            parent: reg.ensureRef(n),
            after: anchorRef(),
          });
        }
        walk(movedFromElsewhere, nk);
      } else {
        ops.push({
          op: 'add',
          parent: reg.ensureRef(n),
          after: anchorRef(),
          subtree: nk,
        });
      }
      anchor = nk;
    }

    // Anything left unmatched is gone — unless it turned up elsewhere in the
    // new tree, in which case the move op was already emitted at its
    // destination and reporting a removal here would be a lie.
    for (const [key, removed] of remaining) {
      if (newByKey.has(key)) continue;
      const ref = removed.ref ?? reg.byKeyLookup(key)?.ref;

      // A removal destroys a SUBTREE, and this loop once reported only its
      // root. Every ref underneath stayed live in the registry and alive in
      // the model — phantom refs, the exact failure `replace`'s `gone` list
      // exists to prevent, reachable through the commonest interaction there
      // is: closing a dropdown or dismissing a dialog.
      //
      // The descendant walk runs BEFORE the `if (!ref)` bail, and that
      // ordering is the whole fix. Gating it on the removed root having a ref
      // covered only the shape the first fixture happened to use (a
      // `role="listbox"` <ul>, which is `list`, which is addressable). A plain
      // `<div>` panel is `generic` and an `<li>` row is `listitem`; neither is
      // in ADDRESSABLE, so neither ever holds a ref, and removing either
      // orphaned everything inside it in complete silence.
      //
      // Same discipline as `replace`: the death is bookkeeping and applies to
      // every destroyed ref, but the REPORT lists only refs the model was
      // actually shown, because naming refs it never held is pure token cost.
      // `newByKey` is the survivor set: a key that turned up elsewhere in the
      // new tree did not die here, and the move op at its destination already
      // said so.
      const gone: string[] = [];
      for (const k of keysOf(removed)) {
        if (k === key) continue;
        if (newByKey.has(k)) continue;
        // The retired fallback is belt-and-braces for the degenerate
        // cross-parent same-base family (docs/design/tier5.md §4 residual 6):
        // the pre-pass may have severed a key whose subtree is being removed
        // here, and `byKeyLookup` can no longer name the ref it took away.
        const r = reg.byKeyLookup(k)?.ref ?? opts.retiredRef?.(k);
        if (!r) continue;
        const known = wasEmitted(r);
        reg.markDead(r);
        if (known) gone.push(r);
      }

      if (!ref) {
        // Nothing to name at the top, so the deaths stand on their own rather
        // than going unreported. Silence here is what produced live refs for
        // elements that had been gone for the rest of the session.
        if (gone.length) ops.push({ op: 'gone', refs: gone });
        continue;
      }

      ops.push({
        op: 'remove',
        ref,
        role: removed.role,
        label: removed.name,
        ...(gone.length ? { gone } : {}),
      });
      reg.markDead(ref);
    }
  }
}

/**
 * Did a native `<select>`'s option LIST change (as opposed to its selection)?
 *
 * Two facts about a native select are invisible to `propDelta`: the
 * `[N options]` marker, which is not one of the properties it compares, and
 * the inline enumeration of a short list, which lives in synthetic children
 * that carry no refs and therefore emit nothing when they are added or
 * removed. Both are stale-able, and the marker is what `tier1.md` calls the
 * agent's only discriminator between a native select and a custom combobox.
 *
 * Deliberately blind to the `selected` state. A selection change is one `~`
 * line and is already reported through the parent's `="…"` value; restating a
 * 51-option select for it would make the commonest select interaction the most
 * expensive one, and it would fire on every scroll through the Offscreen bit.
 */
function optionSetTurnedOver(o: SnapshotNode, n: SnapshotNode): boolean {
  if (o.optionCount === undefined && n.optionCount === undefined) return false;
  if (o.optionCount !== n.optionCount) return true;
  // Same count. The enumeration is empty above the inline threshold, so this
  // loop compares nothing for long lists — which is correct: with an identical
  // count and no enumeration there is nothing the model could be holding.
  if (o.children.length !== n.children.length) return true;
  for (let i = 0; i < n.children.length; i++) {
    const a = o.children[i]!;
    const b = n.children[i]!;
    if (a.key !== b.key || (a.name ?? '') !== (b.name ?? '')) return true;
  }
  return false;
}

function countMatched(a: SnapshotNode[], b: SnapshotNode[]): number {
  const keys = new Set(a.map((c) => c.key));
  let n = 0;
  for (const c of b) if (keys.has(c.key)) n++;
  return n;
}

/**
 * Every property difference between two versions of the same node.
 *
 * THE FIELD CONTRACT. This function is what makes the product's completeness
 * doctrine true — "a diff is complete: anything it does not mention is
 * unchanged" (`src/mcp/tools.ts`). A field that `SnapshotNode` carries, the
 * renderer emits, and this function does not compare is a change the agent is
 * affirmatively told did not happen; the zero-op path then absorbs it into the
 * baseline and it becomes unreportable forever. That is not hypothetical — it
 * shipped, for `href` and `rows`, and an external review found it by probe
 * (docs/design/review-external-2026-08-01.md §1).
 *
 * The ruling for EVERY key of `SnapshotNode` lives in `test/completeness.test.ts`
 * as a literal table, and that test fails CI when a field is added without a
 * ruling. The exclusions, with their reasons, are:
 *
 *   - `scroll`   — churns on every scroll by agent, user, or page; the agent's
 *                  own scroll actions already return observations, and the
 *                  semantic consequence (Offscreen) is masked below for the
 *                  same reason.
 *   - `rect`     — geometry; agents act by ref, not coordinates, and it moves
 *                  on every layout shift.
 *   - `headingLevel` — presentation weight; the heading's text is the operative
 *                  fact and IS diffed.
 *   - `autocomplete`, `inputType` — never rendered, so the model never held
 *                  them and there is nothing to keep faithful.
 *   - `shape`    — renderer-internal collapse hint.
 *   - `ref`, `key`, `frameId`, `synthetic` — identity plumbing, not page facts.
 *   - `dims`     — derived from `rows`; restated with them, never compared
 *                  alone (walker.ts computes one from the other).
 *   - `optionCount`, `children` — structural, reported by
 *                  `optionSetTurnedOver` and `reconcileChildren`. Comparing
 *                  them here would double-report.
 *
 * Snapshot-level: `url` is the `navigated` hoist in engine.ts; `title` is
 * excluded (tab-badge counters make it a live region, and the meaningful
 * correlate is a route change); `viewport` is full-only; `modal` is reported by
 * its dialog subtree's add/remove.
 */
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
  // A link whose target moved under an unchanged label is the phishing
  // primitive this diff engine used to be blind to: the ref stays live, the
  // click lands on the CURRENT target, and nothing in the stream ever
  // contradicts the target the agent read.
  if ((o.href ?? '') !== (n.href ?? '')) {
    d.href = [o.href ?? '', n.href ?? ''];
    any = true;
  }

  // Flattened tables are pure content: the walker drops their children, so a
  // table whose every cell changed produces no structural ops at all. Compare
  // only when BOTH sides carry rows — when flattening flips (a table gains or
  // loses an interactive descendant) one side has `children` instead, and the
  // child reconciliation already restates the content through add/replace.
  // Emitting a rows delta on top of that would double-report.
  if (o.rows && n.rows) {
    if (!rowsEqual(o.rows, n.rows)) {
      d.rows = n.rows;
      d.dims = n.dims ?? { rows: n.rows.length, cols: n.rows[0]?.length ?? 0 };
      any = true;
    }
  } else if (o.rows && !n.rows && n.children.length === 0) {
    // The one asymmetric case that is NOT covered by child reconciliation: the
    // table emptied. Nothing on the new side would say so.
    d.rows = [];
    d.dims = { rows: 0, cols: 0 };
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

/**
 * Cell-by-cell equality, with an early exit.
 *
 * Bounded by the walker's own caps (50 rows, truncated cells), so the worst
 * case is small and the common case — one cell moved — exits on the first row.
 */
function rowsEqual(a: string[][], b: string[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i]!;
    const rb = b[i]!;
    if (ra.length !== rb.length) return false;
    for (let j = 0; j < ra.length; j++) if (ra[j] !== rb[j]) return false;
  }
  return true;
}

/**
 * The first cell that differs, as the volatility tracker's `text`.
 *
 * It is what a human would call "the change", it gives `TIMER_SHAPE` a shot at
 * a clock living in a cell, and it is O(cells) with an early exit. Falls back
 * to the first cell of the first row when the shapes differ, since then no
 * single cell is "the" change.
 */
export function firstDifferingCell(
  o: string[][] | undefined,
  n: string[][],
): string | undefined {
  if (o) {
    for (let i = 0; i < Math.min(o.length, n.length); i++) {
      const ra = o[i]!;
      const rb = n[i]!;
      if (ra.length !== rb.length) break;
      for (let j = 0; j < rb.length; j++) if (ra[j] !== rb[j]) return rb[j];
    }
  }
  return n[0]?.[0];
}

function collectKeys(n: SnapshotNode, out: Set<string>): void {
  out.add(n.key);
  for (const c of n.children) collectKeys(c, out);
}

/**
 * Every key in a subtree. Returns the Set itself: both call sites only iterate
 * it, and spreading to an array was a duplicate O(n) allocation per
 * removal/replace for nothing.
 */
function keysOf(n: SnapshotNode): Set<string> {
  const s = new Set<string>();
  collectKeys(n, s);
  return s;
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
