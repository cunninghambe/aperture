# Tier 5 — the removal-side rebinding fix: positional identity does not survive membership change

Status: SPEC, decision-complete. Written 2026-08-03 against `master` at
`ef098f4` (tree clean; the removal-side premise re-verified by throwaway
probe at THIS head — §1.2 — probe deleted, tree clean after). Companions:
`h2h-evaluation.md` (§2 is the evidence base; §2.3 is the fix cycle this spec
executes; §8.7 is the obligation it discharges), `tier4.md` (§1 closed the
growth half of this hole; §1.5's removal-behavior pins are deliberately
superseded here — §6.3), `tier3.md` (§3.1 recorded the hole),
`vaultfill-red-record.md` (the RED/sabotage form §7 follows). ONE builder
executes verbatim.

**The stage-C window.** The head-to-head cohort is complete, adjudicated, and
archived; nothing pins the watched set any longer. Every edit below touches
`src/core/snapshot/**`, so `codeVersion` and `buildVersion` move and every
existing bench store is severed — the integrity design working, paid once, in
the window h2h-evaluation §2.3 reserved for exactly this change. After the
battery goes green the engine is frozen again until the fresh cohort §9
preregisters has run.

**Verification is deliberately deferred.** The builder runs the free battery
only (§12): tsc, vitest, build, fidelity, guards, selftest. No scored wave, no
cohort, no sweep. §9 states — as a preregistration, before any number is seen
— what measurement is owed before any README/RESULTS claim may move, the
expected direction on both precision and economics, and what result means this
fix gets reverted.

---

## 1. The defect, verified at this head

### 1.1 What the store proved (h2h-evaluation §2, restated as mechanism)

Rows that are identical and id-stripped get ORDINAL identity keys
(`disambiguate`, walker.ts): the first occurrence keeps the bare key, the rest
take `|#1…|#N`. Identity IS the ordinal. Remove a middle row and the key SET
shrinks at the TAIL — the highest ordinal vanishes whatever row physically
left — so P1's restatement (`! e2 replaced (gone: e57 e58)`) retires only the
tail refs while every surviving key re-binds, by position, to whatever row now
occupies it. `e10` permanently means "4th row's Reject". A plan captured
before a removal executes one row off — silently, labels agreeing, no error.
The store's wrong rejects sit at q6/q11/q16, exactly the rows that slid into
the 5th/9th/13th positions, in identical sequences across three runs.
Playwright's per-snapshot refs make the same staleness ERROR OUT (75 dead-ref
refusals vs our 8 landed wrong actions). This cost the preregistered precision
primary: +0.173 wrong-el/run [0.018, 0.345] against a +0.2 bound — FAILS.

### 1.2 Probe record — the premise re-verified at `ef098f4`

Throwaway vitest against the unedited engine (constructed nodes in
`diff-rebinding.test.ts`'s style; 7-row emitted positional family, remove the
3rd row, re-walk, diff). Verbatim results, this session:

```
ops: [{"op":"replace","ref":"e1","gone":["e8"]}]
gone: [ 'e8' ] — tail button ref was e8
held ref e5 → entry e5 state live rect [200,180,60,20]
--- wire ---
page #1.1 (diff from #1.0)
! e1 replaced (gone: e8):
  list e1 "Tickets"
    listitem
      button e2 "Take"
    ...
```

Three facts, each load-bearing:

1. **`gone` names only the tail.** Seven refs were held; one is retired. The
   wire affirmatively implies the other six are fine.
2. **The held ref revives onto a different row.** `e5` was read as "the 4th
   row's Take" (rect y=160); after the removal it is `state: live`, same
   number, stamped on the row at y=180 — the row that slid into 4th. The
   restatement re-emits the SAME numbers, so the model's stale plan remains
   fully executable.
3. **Nothing on the act path can refuse it.** `keyForRef` (engine.ts:613) is
   `resolve(ref)?.key ?? null` — no liveness check — and the page-side index
   answers by KEY, i.e. for whoever holds that position now (page.ts:607
   answers `gone` only when the key is absent or disconnected). Even a ref the
   diff DID mark dead would refuse only because its key left the index; a
   surviving position's key never leaves the index. The defect has two halves:
   revival rebinds the key, and the act path has no concept of a ref that must
   not be trusted anymore.

### 1.3 Why the information channel is not the problem

The store rules this out twice. The restatement was delivered on every
removal (P1 fired every time; the diff streams show it), and the re-dump arm —
a FULL snapshot before every act, the strongest possible "re-read before
acting" — measured MORE landed wrong actions than the diff arm (38 vs 27;
home 0.760 vs 0.540/run). Forced re-observation does not fix rebinding when
the ref numbers stay stable, because the stale plan's tokens still name refs
that still resolve. The defect is not missing information; it is an affordance
— stable ref numbers let a plan skip integrating the restatement it was
handed. The fix must remove the affordance.

---

## 2. The ruling — A, implemented at the identity layer; B is rejected on the store's own evidence

### 2.1 Candidate B (family generation counter) — REJECTED

**B's obvious formulation is vacuous.** "Refuse an act whose ref was minted
(or last shown) before the family last mutated" never fires: the P1/P2
restatement re-emits every family ref in the same observation that reports the
mutation, so by the time the model can act again, every ref's last emission
postdates the mutation. The engine cannot distinguish "the model re-derived
from the restatement" from "the model is executing a stale plan" — both are
an act on a live, just-re-emitted ref. Plan staleness lives in the model's
context, where no engine counter can see it.

**B's only implementable formulation is a family lock** — membership change
locks the family; acts refuse ("this list changed, re-read it") until an
explicit re-read clears it. Three independent disqualifications:

1. **It does not close the hole.** After the unlock the refs are unchanged and
   still rebound; the stale plan executes on attempt two. B converts "silent
   wrong action" into "wrong action after a refusal ritual". The re-dump arm
   is the natural experiment for exactly this mechanism (an observation forced
   before every act) and it measured WORSE precision (§1.3). Merely-less-likely
   fails the brief's own correctness test.
2. **It forces a redundant read of information already delivered in-band** —
   the restatement — which is the defensive-observation behavior the tier1b
   teaching fix spent a wave suppressing (voluntary observations 0.80 →
   0.58/ep, `bench/RESULTS.md:1086`). B re-teaches distrust structurally.
3. **It is incoherent with the P1/P2 design.** The escalation's whole,
   wave-3-vindicated premise is that in-band restatement beats forced
   re-observation. A lock makes the restatement pointless and charges for
   both.

### 2.2 Candidate A (fresh refs on restatement) — CHOSEN, subsuming B as one mechanism

On any positional-family membership change: every ref the family's previous
generation held is retired — dead, never revived — and the restated members
mint fresh refs, delivered by the SAME P1/P2 `replace` in the same
observation. A stale plan's next act names a dead ref and refuses loudly; the
successor refs are already in the model's context.

**This IS the generation counter, with no new state:** the ref allocator is
the generation counter (each generation's refs are new numbers), the dead-ref
error is the refusal, and the restatement-already-in-context is the re-read.
One mechanism, all existing vocabulary — `replace`, `(gone: …)`, the
`could not be acted on (gone)` act error, all of which readers and the model
already speak. There is no hybrid to bolt together because A delivers
everything B wanted through machinery that already exists.

**Correctness.** The rebind route — the engine's half of the failure, the
half redump − sealed measured at +0.27 [0.08, 0.49] — becomes impossible: a
pre-mutation ref cannot resolve, so a stale plan cannot land. What remains is
the model's half: mis-deriving ordinals from a correct restatement (the
re-dump arm's intrinsic ~3 wrong clicks in wave 2; pw-stock's 2 in the h2h).
No engine can fix model arithmetic; both products share that floor.

**Where the churn lands, priced.** The `replace` subtree is already restated
whole today, so the marginal wire cost is the widened `(gone: …)` list plus
recovery turns when an agent actually goes stale:

- The gone list names only refs the model was SHOWN (`wasEmitted` filter,
  unchanged), so churn scales with emitted lines, not family size — a
  collapsed 50-row list retires cheaply. Worst case (all rows rendered):
  remove row 1 of 50 ≈ 49 ref tokens ≈ ~60 tokens, against the restatement
  that was already being paid.
- On the queue-class fixtures (every act removes a row, two button families):
  order +15–20% observation bytes on the heaviest fixture, home stratum
  overall single-digit percent.
- The stratum arithmetic is decisive: the economics CLAIM lives on
  neutral-large (0.313× [0.271, 0.364]), whose fixtures BAN identical-sibling
  interactive elements (headtohead.md §4.2 rule 2) — no button/link family
  can form, so the mechanism cannot fire where the claim lives (tier4 §7.3's
  argument, now with a §9 tripwire instead of trust). The churn lands
  entirely on the home stratum, where economics is already conceded DEARER
  (1.295×) and where the FAILED primary lives. A is a trade of marginal cost
  on a conceded stratum against the one lost primary.
- Recovery is cheaper than Playwright's: our dead-ref error embeds the
  current observation in the same reply (tools.ts:1268-1272), where pw's
  "Try capturing new snapshot" costs a separate ~90K-char turn.

**Interaction with P1/P2** (the brief's question): the escalation still fires
and becomes MORE load-bearing, not redundant — it is the delivery vehicle for
the successor refs. Retire without restating and the model would hold zero
live refs for the family; restate without retiring and you have today's
defect. The two are one design. P1/P2's detection predicates are not edited.

**Fail-safe posture.** Where the family signal is ambiguous the design falls
loud or falls silent-but-stated, never silent-and-new: equal-size same-walk
churn stays undetectable in principle (tier4 §1.4 residual 1 — no layer owns
a signal; unchanged by this fix; stated in §4); the degenerate cross-parent
same-base construction degrades to dead-refs-without-a-gone-note (loud on
use, §4.3) where today it is silently wrong.

### 2.3 Placement — engine pre-pass, not escalation-site (the third sub-ruling)

Retirement implemented INSIDE the P1/P2 escalation alone would miss every
membership change delivered as a FULL snapshot: `observe()` runs
`assignRefs` — which revives by key — BEFORE diffing (engine.ts:214), and the
forced-full path (agent-requested `full`, post-navigation, the bench's
re-dump arm forcing) never diffs at all. A mutation delivered through any of
those re-binds silently, fix or no fix. It would also miss revival across
absence: a family that disappears (tab away) and reappears with different
membership revives dead refs by position.

So the mechanism lives where revival is decided: a pre-pass over consecutive
walk trees, run on EVERY observation that has a predecessor, before
`assignRefs` — one rule, all delivery paths, both bench arms. The rule:

> **A positional family's refs are valid only while its membership is
> unchanged between consecutive walks. Any membership delta retires the whole
> family — bare member included — and the next walk mints fresh.**

The per-parent P1/P2 predicates still decide the WIRE (when a container is
restated); the pre-pass decides IDENTITY. They agree on every fixture class
this project owns (same-base keys share the ancestry path, so a family's
parents escalate whenever the pre-pass fires — §4.3 has the one degenerate
exception).

---

## 3. The change — exact

### 3.1 `src/core/snapshot/registry.ts` — `retireKey`

Add to `RefRegistry`, beside `markDead`:

```ts
/**
 * Sever a key's revival path. The entry stays in `byRef` — dead, resolvable,
 * refusable — so an act on its ref fails loudly instead of resolving through
 * the page-side index to whatever element holds the key NOW. The key's next
 * `ensureRef` mints a fresh entry.
 *
 * Exists for exactly one caller: `retirePositionalRebinds` (diff.ts). For a
 * positional key, "the key reappeared" is a claim about a POSITION, not an
 * element, so the revival contract in this class's header does not apply —
 * reviving it is how a stale plan lands one row off (docs/design/tier5.md §1).
 * `needsReannounce` is deliberately not set: this entry can never be revived,
 * so it owes no re-announcement.
 */
retireKey(key: string): string | undefined {
  const e = this.byKey.get(key);
  if (!e) return undefined;
  e.state = 'dead';
  this.byKey.delete(key);
  return e.ref;
}
```

Amend the class doc comment ("Refs are never reused… or gets *revived* if its
key reappears, which is what makes tabbed UIs behave sanely"): append one
sentence — revival is for content-derived keys; positional-family keys are
exempt on membership change (`retireKey`, tier5 §2.3) because their key
encodes a position, not an identity.

### 3.2 `src/core/snapshot/diff.ts` — the pre-pass, exported

Add at module level (it shares `positionalBase`/`isPositionalKey` — this file
owns family semantics):

```ts
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
```

`DiffOptions` gains one member:

```ts
/** Refs the pre-pass retired this observation, by key — see
 *  `retirePositionalRebinds`. A surviving key's old ref is dead but no longer
 *  reachable through `byKeyLookup`; `gone` reporting needs this map to stay
 *  truthful. */
retiredRef?: (key: string) => string | undefined;
```

`buryUnder` gains the retired branch, FIRST, before the survivor skip — a
survivor key's old ref must be buried even though its key survives:

```ts
function buryUnder(o: SnapshotNode, survivors: Set<string>): string[] {
  const gone: string[] = [];
  for (const key of keysOf(o)) {
    const retiredRef = opts.retiredRef?.(key);
    if (retiredRef) {
      if (wasEmitted(retiredRef)) gone.push(retiredRef);
      continue;
    }
    if (survivors.has(key)) continue;
    // …existing body, byte-identical…
  }
  return gone;
}
```

(`keysOf` walks in document order, so gone lists stay deterministic. The
retired branch does not call `markDead` — the pre-pass already did.)

In `reconcileChildren`'s removal loop, the descendant gone lookup gains the
same fallback (belt-and-braces for the §4.3 degenerate case):

```ts
const r = reg.byKeyLookup(k)?.ref ?? opts.retiredRef?.(k);
```

Comment repairs riding along, this file: the escalation comment
(diff.ts:196-221) and the P1/P2 doc comments gain one sentence each — the
restatement's refs are now the NEXT generation; every prior-generation family
ref is retired by `retirePositionalRebinds` and named in `gone` — citing this
spec. The `ensureRef` synthetic-safety invariant list is untouched (the
pre-pass calls `retireKey`, never `ensureRef`).

### 3.3 `src/core/snapshot/engine.ts` — wiring

In `observe()`, between `redactTainted` and `assignRefs` (currently lines
~208-214):

```ts
// Positional families whose membership changed since the last walk lose
// their refs BEFORE revival can rebind them — every delivery path, full or
// diff (docs/design/tier5.md §2.3). First observation has nothing to compare.
const retired = st.last
  ? retirePositionalRebinds(st.last.root, r.root, st.registry)
  : undefined;

assignRefs(r.root, st.registry);
```

Thread it into the diff call (line ~237):

```ts
const result = diffSnapshots(st.last.root, r.root, st.registry, {
  isVolatile: (key) => st.volatility.isVolatile(key),
  wasEmitted: (ref) => st.registry.wasEmitted(ref),
  retiredRef: retired ? (key) => retired.get(key) : undefined,
});
```

Two accessor changes at the bottom of the file:

```ts
/** Resolve a ref to the identity key the page-side index is keyed on.
 *  Dead refs resolve to null: a retired positional ref's KEY is still live in
 *  the page index — held by whatever row occupies the position now — and
 *  resolving it is exactly the silent one-row-off landing (tier5 §1.2). */
export function keyForRef(tabId: string, ref: string): string | null {
  const e = stateFor(tabId).registry.resolve(ref);
  if (!e || e.state === 'dead') return null;
  return e.key;
}

/** The full registry entry, dead or alive. The act path needs the
 *  distinction: a DEAD ref refuses with recovery attached, an UNKNOWN ref
 *  refuses bare (tier5 §3.4). */
export function refEntry(tabId: string, ref: string): RefEntry | undefined {
  return stateFor(tabId).registry.resolve(ref);
}
```

(`RefEntry` joins the type imports from `./types.js`.)

### 3.4 `src/mcp/tools.ts` — the act path refuses dead refs, with recovery

In the `browser_act` handler, replace lines 1231-1240 (`if (!ref) …` through
`agentTouched`) with:

```ts
if (!ref) return text(`error: ref required for ${action}`);
const entry = refEntry(id, ref);
if (!entry) {
  return text(
    `error: ${ref} is not a known element. Call browser_snapshot to re-read the page.`,
  );
}
if (entry.state === 'dead') {
  // A retired or destroyed ref. Its KEY may still be live in the page index
  // — held by a different element than the one the agent read — so resolving
  // it would land the act on the wrong element in silence (tier5 §1.2). Same
  // reply shape as every other could-not-act: the observation IS the
  // recovery, and the restatement that retired this ref already named its
  // successors.
  const { text: obs } = await observe(id, wc, { full: wantFull, budgetTokens });
  return text(
    `error: ${ref} could not be acted on (gone).\n` +
      'The page as it stands now:\n' +
      untrusted(safeOrigin(t.info(id)?.url ?? ''), obs),
  );
}
const key2 = entry.key;
agentTouched(id, key2);
```

`refEntry` joins the engine imports; `keyForRef` stays imported for
`browser_read` (line 636), whose dead-ref behavior changes only in FIRING
CONDITION: a dead ref now returns the existing
`error: ${ref} is not a known element on this page` instead of reading
whatever element holds the key now — the read-side twin of the same hazard.
No reply text anywhere is new or reworded:

- `could not be acted on (gone)` — byte-identical to the existing page-side
  gone shape; matches the bench's `REF_ERROR` (proxy.mjs:179-180); the reply
  is multi-line and page-embedding, so `classifyObservation` types it by its
  embedded snapshot exactly as today.
- Attribution after this fix is automatic and correct: the shadow model
  processed the widened `gone` list (streamModel.mjs:167-171 parses
  arbitrary-length lists), so `shadowHad` is false and a stale act attributes
  `model_bookkeeping` — the model was told and acted anyway.
- **No tool-description or prompt changes.** The shipped sentence "If a ref
  has gone stale you get a targeted error naming what is there now" (tools.ts
  ACT_DESCRIPTION, proxy.mjs:104) already describes the new behavior
  precisely. ARM_DEFINITION, SYSTEM_PROMPT: untouched.

### 3.5 `src/core/snapshot/walker.ts` — comment repair only

The `disambiguate` comment block (walker.ts:308-337, "The renumbering half IS
handled, on the diff side…") gains the identity half: on any membership
change the family's refs are RETIRED and re-minted (`retirePositionalRebinds`,
tier5), so a stale plan refuses instead of landing one row off; the residual-1
sentence (equal-size same-walk churn undetectable) stands verbatim. No code
change in this file.

### 3.6 What is deliberately NOT changed

- **No wire vocabulary, no renderer, no reader changes.** `replace`,
  `(gone: …)`, `- eN removed`, the act error — all existing forms. render.ts,
  types.ts (beyond the `DiffOptions` member), streamModel.mjs, proxy.mjs,
  task.mjs, tasks.mjs: zero edits.
- **P1/P2 predicates untouched.** `positionalFamilyLostAMember` /
  `positionalFamilyGainedAMember`: not one byte.
- **No thresholds retuned.** MAX_DIFFS_PER_EPOCH, DIFF_SIZE_RATIO,
  REPLACE_MATCH_RATIO/MIN_CHILDREN, COLLAPSE_RUN, every preregistered bound.
- **No SUITE_VERSION bump.** guards.mjs is outside the watched set (verified,
  tier4 §11) and G29 changes no episode semantics; severance comes from the
  src edits, as designed.
- **No RESULTS.md / README edits** — frozen by §9 until the cohort.

---

## 4. Semantics, stated as the contract

1. **A stale positional ref cannot land.** Any act (or scoped read) naming a
   ref from a retired family generation refuses — `could not be acted on
   (gone)` with the current observation attached — on every delivery path:
   diff, size/count resync, forced full, re-dump arm.
2. **The successors arrive in the same observation that retires them** (diff
   path): the P1/P2 replace carries fresh label→ref lines; `gone` names every
   previously-emitted ref of the prior generation. An attentive model never
   hits the error at all.
3. **Content-keyed elements are untouched.** Retirement requires a group of
   ≥2 same-base keys with ≥1 ordinal suffix AND a membership delta. A pure
   re-walk (RESULTS.md §B's measured property — 100% ref survival across
   re-snapshots) retires nothing: sets equal. Tier-1/2 keyed singletons can
   never enter a group. Pinned by unit case 7 and guard G29's setup
   invariants (§6, §7).
4. **Residual, unchanged, owned:** equal-size same-walk churn of
   indistinguishable rows (one removed + one inserted between walks) has no
   signal at any layer this engine owns (tier4 §1.4 residual 1). The fix
   neither detects nor worsens it.
5. **Residual, new, bounded — the full-delivery gone note.** A membership
   change delivered as a FULL snapshot (forced full, resync fallback, re-dump
   arm) retires refs with no `(gone: …)` note — a full snapshot has no such
   vocabulary. The model learns on first use, loudly, with recovery attached;
   the doctrine "refs persist across fulls" acquires a stated exception that
   can only ever surface as a refusal, never as a landed wrong action.
   Accepted; G29d proves the refusal fires on this path.
6. **Residual, degenerate — cross-parent same-base families** (§4.3 detail):
   twin unlabeled identical lists of identical rows share one global ordinal
   family; a removal in one can renumber keys in a middle parent whose own
   per-parent diff emits moves rather than an escalation. The pre-pass
   retires the refs (correct) but no gone note names them and no restated
   line carries the middle parent's successors — the model's refs for that
   parent die and it must re-read on first refusal. Previously this
   construction was SILENTLY WRONG; now it is loud-and-degraded. Outside the
   solver envelope, no fixture produces it (tier4 §1.4 residual 2's
   territory); stated, not built for.
7. **Taint is key-scoped and unchanged.** Positional keys' taint follows the
   position exactly as before this fix; ref identity changed, key identity
   did not. Considered, out of scope.

---

## 5. Bench-side consequences (no bench code changes; expectations stated)

- **Shadow model:** parses widened gone lists as-is; retired refs leave the
  model; restated fresh refs enter in document order — which makes the
  scripted solver's `clickNth` ordering argument (tier3 §3.2) STRONGER: after
  a restatement the family's model entries are all-new, appended in subtree
  document order.
- **Attribution:** stale acts flip from `wrong_choice` (landed!) to
  `model_bookkeeping` refusals. `identity_mismatch` stays unreachable on
  identical labels (h2h §0.6) — and no longer matters there: the landing
  channel is closed.
- **G2/selftest scripted streams WILL move bytes** on the queue-class tasks
  (wider gone lists, renumbered refs). This is the designed severance, not
  drift: tier4 §1.7's byte-equality was tier4's landing gate, not a permanent
  pin. The T2/T4 streamAsserts (`destructiveRefs(first).size >= 2`, the
  `a:full` crossing) run UNMODIFIED and must pass — more gone refs satisfies
  ≥2 trivially; battery item 7 records the new G2 notes table as the new
  baseline.
- **Fidelity, all six scenarios: expected GREEN unchanged.** The sensitive
  ones argued, not assumed: `rerender`'s Add-to-cart buttons key by sibling
  discriminator (walker.ts:348-367; RESULTS.md's re-render section) — content
  keys, no family, no retirement; `biglist`'s items are distinctly named —
  revival preserved. The harness follows the stream, so even a firing
  retirement would be tracked. ANY fidelity drift is a stop-the-line finding
  to be diagnosed before the battery proceeds (battery item 5).
- **G15 stays green as-is:** its legs read refs out of the replace block by
  regex, never comparing against pre-click numbers, and prepend.html's
  restatement now carries fresh refs that still satisfy both legs (G15b's
  `took: u1` truth-check is ref-number-agnostic).

---

## 6. Unit tests

### 6.1 New file `test/diff-retire.test.ts` (constructed-node style, `diff-rebinding.test.ts` the pattern; header provenance mandatory: origin h2h-evaluation §2.2 wire evidence + the §1.2 probe at `ef098f4`, this spec)

Uses a 7-row family with buttons (addressable → real refs), refs emitted via
`assignRefs` + `markEmitted`, physical row identity tracked in `rect.y`
exactly as the §1.2 probe did.

**RED-first set — authored and run against UNEDITED src FIRST; each must
fail; the failure output goes in the landing commit message (G14/G15/tier4
precedent):**

| # | case | expected (post-fix) |
|---|---|---|
| 1 | removal 7→6, all buttons emitted | exactly one `replace`; `gone` lists ALL SEVEN prior button refs in document order (not just the tail); every restated button ref is fresh (disjoint from the prior seven); the container's ref is UNCHANGED (content-keyed, revives) |
| 2 | the held-key rebind is dead | after the diff: `byKeyLookup(<4th-row key>)` returns a FRESH ref; `resolve(<old held ref>)` still returns an entry with `state === 'dead'` (resolvable, refusable); `keyForRef`-equivalent check: dead ⇒ null |
| 3 | prepend 6→7 (P2 path, same mechanism) | one `replace`; `gone` = all six prior emitted refs; seven fresh |
| 4 | 1→2 growth (born family) | bare key's old ref dead; both members fresh |
| 5 | reappearance with changed membership (walk A: family of 3, emitted → walk B: family absent → walk C: family of 2 returns) | pre-pass at walk C retires; neither walk-A ref revives; both walk-C refs fresh |

**GREEN-stable set — authored and run against UNEDITED src FIRST, where each
must PASS, and must still pass after (both runs named in the commit
message):**

| # | case | expected (both builds) |
|---|---|---|
| 6 | content-keyed list (distinct names), one removed | one `remove` op; every sibling's ref unchanged — the §B survival property at unit level |
| 7 | pure re-walk of a positional family, no mutation | zero ops; zero retirement; every ref revives with the SAME number — §B's re-snapshot property holds for positional families too |
| 8 | equal-size same-walk churn | no ops, no retirement — the documented silence, tier4 §1.4 residual 1 cited in the assertion message |
| 9 | never-emitted family members | `gone` omits refs the model was never shown (token discipline preserved) |

Registry-level (same file or `test/` sibling): `retireKey` severs
(`ensureRef` after ⇒ new ref; `resolve(old)` dead), returns `undefined` for
unknown keys; `keyForRef` and `refEntry` behavior over dead entries (engine
accessors are thin — test through the registry plus one type-level check).

`browser_read` twin: one test asserting `keyForRef` returns null for a dead
entry (the scoped-read protection), at whatever level the existing
tools-adjacent tests exercise it; if none exists, the registry-level dead⇒null
of §3.3's `keyForRef` body is the pin and G29b's read-refusal is not required
(act-side coverage suffices — read is protected by the same clause, stated).

### 6.2 `test/act.test.ts`, `test/completeness.test.ts` — untouched

No witness, no field-contract change.

### 6.3 `test/diff-rebinding.test.ts` — re-pinned, EXPLICITLY AUTHORIZED

Tier4 §1.5 pinned cases 7-8 (and case 1's `gone empty or absent`) to the
PRE-tier5 removal behavior as proof that P2 left the removal path untouched.
Tier5 changes the removal path ON PURPOSE, so those pins move — this is the
one place this spec supersedes tier4, and the builder must treat it as a
re-specification, not a broken test to appease:

- Case 1 (prepend): expectation becomes "one `replace`; `gone` lists the
  prior generation's emitted refs" (was: empty/absent).
- Case 7 (removal 7→6): expectation becomes the NEW baseline — one `replace`
  whose `gone` deep-equals the full prior-generation emitted ref list and
  whose rendered wire carries fresh refs; re-record the expected bytes from
  the post-fix run and pin those.
- Case 8 (two successive removals): P1 fires each time; each restatement's
  `gone` covers that generation; assert via op shape and gone cardinality.
- The file's provenance header is APPENDED to, never rewritten: one dated
  paragraph stating tier5 moved the removal-path pins and citing this
  section. The historical RED/GREEN record above it stands as history.

---

## 7. The live guard — G29, RED-first, with sabotage rows

### 7.1 Fixture `test/fixtures/retire.html`

The removal mirror of `prepend.html` — copy its conventions verbatim (they
are the fixture; do not re-derive): content-identical rows, no `<a>`/`<h1>`-
`<h4>` inside rows, no ids/testids on rows or buttons, divider span on every
3rd CURRENT index, `replaceChildren` re-render, row identity in a JS array
only, delegated Take handler logging `took: <rowId>` by CURRENT index,
`<p data-status>` addressed by attribute. Differences:

- **Six** rows, ids `r1..r6` (six, so the post-removal family of five still
  defeats COLLAPSE_RUN under the divider rule and the guard can count rows).
- `<button id="dismiss-first">Dismiss first ticket</button>` OUTSIDE the
  list (Tier-1 key): `state.shift()`, full re-render, status update — the
  removal that renumbers every survivor.
- Header comment: removal-mutating BY DESIGN, guard fixture never a task,
  never imported by `bench/tasks.mjs`; cites this section.

### 7.2 Guard G29 (`bench/guards.mjs`, appended after the G28 block, own model map per the established pattern)

Setup: navigate with cache-buster, settle, full snapshot into a local model;
require exactly 6 `Take` buttons and 1 `Dismiss first ticket` (else exit 3
INFRA). From the snapshot TEXT in document order: `takeRefs[0..5]`;
`heldRef = takeRefs[3]` (the 4th row — r4's Take, as the model read it).
Click `Dismiss first ticket`; `reply` is the observation.

- **G29a — the restatement retires the whole generation:**
  `/^! e\d+ replaced/m` block present; its `(gone: …)` list CONTAINS
  `heldRef` (a surviving position's ref, not merely the tail); ≥5 `Take`
  lines restated inside the block; EVERY restated Take ref is absent from the
  pre-click `takeRefs` set (all fresh). FAIL detail prints the reply's op
  lines verbatim (G13/G15 style).
- **G29b — a stale plan fails loudly, page-evidenced:** click `heldRef`; the
  reply must match `^error: ${heldRef} could not be acted on`; then a full
  snapshot must contain NO `took:` line — the page's own record that nothing
  landed. (Runs only if G29a found a block; otherwise recorded FAIL alongside,
  the G15b convention.)
- **G29c — the successors bind truthfully (green-stable, the G15b analog):**
  take the FOURTH `Take` ref from inside the replace block (document order),
  click it, full snapshot ⇒ contains `took: r5` (r1 dismissed, the current
  4th row is r5). Proves the restatement is usable without any re-read.
- **G29d — the full-delivery path retires too:** re-navigate (fresh
  cache-buster), full snapshot, re-derive `heldRef` (4th Take), click
  `Dismiss first ticket` with `observe: 'full'`, then click `heldRef` ⇒ must
  refuse with `could not be acted on`, and a follow-up full snapshot shows no
  `took:` line. Proves the pre-pass sits on `observe()`'s common path, not
  inside the diff branch.

### 7.3 RED record — `docs/design/g29-red-record.md`, authored and run BEFORE any src edit lands

The `g14-red-record.md` / `g15-red-record.md` form: build provenance table
(`out/` hashes, sizes, mtimes at `ef098f4`), exact commands, verbatim output,
"what this proves / what is not claimed". Expected RED shape against the
current build, stated in advance: G29a FAILS (gone carries only the tail ref;
restated refs identical to the held ones), G29b FAILS with the hazard the
green guard can never show again — the held ref's click returns `ok click`
and the page logs `took: r5`: the one-row-off landing in the page's own
words, the h2h defect reproduced on demand — G29d FAILS the same way; G29c
PASSES pre-fix (the restatement was already truthful; the refs were the lie)
and is recorded as the green-stable leg.

### 7.4 Sabotage battery (the discrimination proof — one row per clause, `vaultfill-red-record.md` §2's form: exact one-line string replacement that refuses unless the target occurs exactly once; rebuild, run guards + the unit file, revert by saved buffer, rebuild)

| row | one-line sabotage (shipped source) | expected reds | expected greens |
|---|---|---|---|
| S-T5-1 | engine.ts: the pre-pass call becomes `const retired = undefined;` | G29a, G29b, G29d; unit cases 1-5 | G29c; unit 6-9 |
| S-T5-2 | tools.ts: the act branch's `entry.state === 'dead'` becomes `false` | G29b, G29d (held ref LANDS — page logs `took: r5`) | G29a (wire honesty intact), G29c |
| S-T5-3 | diff.ts: `buryUnder`'s retired branch condition becomes `false && retiredRef` | G29a (gone lacks heldRef); unit 1, 3 | G29b, G29d (refusal intact), G29c |

Recorded in the g29-red-record appendix with verbatim per-row output. The
three rows prove the three clauses fail independently — identity retirement,
act refusal, wire honesty — which is what makes the guard a guard rather
than a ceremony.

---

## 8. Verified / not verified, for this spec

**Probed live at `ef098f4` (throwaway vitest, deleted, tree clean after):**
the removal-side premise of §1.2, quoted verbatim — tail-only `gone`,
same-number revival onto a shifted row, live registry state on the held ref,
`renderDiff` wire captured. These are the RED premises for unit cases 1-2 and
guard legs G29a/b.

**Verified by code read at `ef098f4`:** `assignRefs` runs before diffing and
the forced-full branch never diffs (engine.ts:214, 216-234, 237);
`keyForRef`'s lack of a liveness check and both its consumers (engine.ts:613;
tools.ts:636, 1232); the page-side index answers `gone` only for absent/
disconnected keys (page.ts:607, 766); the act error shape and its embedded
observation (tools.ts:1268-1272); `REF_ERROR` matches `could not be acted on`
(proxy.mjs:179-180) and the shadow model parses arbitrary-length gone lists
and clears on FULL (streamModel.mjs:156-193) — so zero bench edits;
`buryUnder`/`keysOf` document-order determinism (diff.ts:100-111, 649-653);
RESULTS.md §B is a no-interaction re-snapshot property and the re-render
section already records positional non-survival as a known hazard
(RESULTS.md:41-56, 190-224); rerender.html's buttons key by sibling
discriminator (walker.ts:348-367), so fidelity's sensitive scenario is
content-keyed; guard numbering G16-G28 is taken (guards.mjs, vaultfill) —
next is G29; tier1b's voluntary-observation numbers (RESULTS.md:1086).

**Asserted but NOT verified — owned, with the check named:** (a) fidelity's
six scenarios were not run this session — argued green in §5, battery item 5
is the check and any drift stops the line; (b) the selftest byte-drift
magnitude on queue-class tasks — expected and designed, battery item 7
records the new baseline; (c) fresh-ref behavior under COLLAPSE_RUN elision
on real pages — argued from the `wasEmitted` discipline, covered by fidelity
plus G29; (d) whether the preload's key→element index accumulates across
walks — bears only on WHICH refusal a long-dead ref gets, and both paths
refuse; not load-bearing; (e) **agent-behavioral response to the new refusals
— the entire point of §9's deferred cohort; no free battery can verify it,
and this spec does not pretend otherwise.**

---

## 9. Preregistration — what is owed before any claim moves

Written before any post-fix number exists; cheaper to commit to now.

### 9.1 The measurement owed

1. **Pre-budget tripwire (free, at landing):** run the h2h H3 scripted-solver
   streams (or `--selftest` equivalents) across the fixture set. **Zero
   retirement events on the six neutral fixtures** — no `replace` op on any
   neutral solve path that was not there before, no gone-list growth in the
   neutral scripted streams. A single firing is a stop-ship spec failure
   (§2.2's stratum argument was wrong), diagnosed before anything else runs.
2. **The claim-moving measurement: one fresh head-to-head cohort** on the
   UNCHANGED 13-task set, unchanged arms, model, seal, and preregistered
   bounds (headtohead.md as amended by tier4 §7), H0 pinning the post-tier5
   build. Nothing less retires the precision sentence: h2h-evaluation §2.3
   says "measured by a fresh cohort on an unchanged task set", and this spec
   inherits that ruling verbatim. The archived `dfa962c3` store is never
   re-scored and never pooled with the new one.

### 9.2 Expected directions (both primaries, stated in advance)

- **Precision (the failed primary):** pooled wrong-el delta (diff −
  pw-sealed) falls from +0.173 [0.018, 0.345] to a CI whose UPPER bound is
  ≤ +0.2 — the bound HOLDS. Mechanism-level predictions that make the claim
  falsifiable: diff-arm home `wrong_choice` (was 27) at least halves;
  aperture-arm refused-stale acts RISE from 8 toward pw-sealed's order of
  magnitude (75); the redump arm improves in step (the fix is engine-level,
  both arms inherit it), so redump − sealed (was +0.27 [0.08, 0.49]) is
  expected to include 0.
- **Reliability:** the pooled −10pp bound must still HOLD; home-set success
  expected flat-to-improved (the loud currency scored 82% vs our 76% in the
  archived store).
- **Economics:** neutral-large — the licensed claim, 0.313× [0.271, 0.364] —
  expected UNCHANGED within CI overlap, because the mechanism cannot fire
  there (9.1.1 is the mechanical check, not trust). Home expected to worsen
  modestly (gone-list tax + refusal-recovery turns; order +5-20% observation
  bytes on queue-class fixtures) — home carries no cost claim, so no bound is
  set, but the number is REPORTED beside the neutral one, every time.

### 9.3 Revert conditions (any one suffices)

1. The precision primary still FAILS on the fresh cohort AND diff-arm home
   `wrong_choice` has not at least halved — the mechanism attribution was
   wrong; revert, re-open tier3 §3.1 with the new store as evidence.
2. The pooled success bound FAILS (CI upper < −10pp) with the regression
   attributable to aperture-arm refusal loops (repeated `could not be acted
   on` without recovery in the streams) — the loud currency cost more than it
   bought; revert; the next candidate is a restate-and-alias design (fresh
   refs plus a one-observation-window alias from retired ref to its
   successor), recorded here so it is not re-derived from scratch.
3. Tripwire 9.1.1 fires — stop-ship before any budget; not a cohort question.

### 9.4 The claims freeze

Until the fresh cohort is adjudicated: the RESULTS.md precision sentence and
the README precision paragraph do not move, except that either may gain the
suffix "a fix has landed (tier5, build `<hash>`), unmeasured" — nothing
stronger, nothing softer. RESULTS.md §B is untouched (its property is
preserved by construction and pinned by unit case 7). If the cohort passes
§9.2, the precision sentence is retired and replaced by the new cohort's
numbers with this spec cited; economics claims update only from the same
store.

---

## 10. What this spec deliberately does NOT include

- No walker-side element-identity detection (re-ruled out; tier4 §1.2's
  `replaceChildren` false-positive argument is unchanged).
- No detection of equal-size same-walk churn (undetectable in principle;
  §4.4).
- No ref-alias or grace-window mechanism (recorded as the revert-path
  candidate in §9.3.2, not built — it reintroduces a guess about what the
  model meant, which is the `fuzzyRescue` failure class the registry already
  buried once).
- No new wire vocabulary, renderer, reader, prompt, or threshold changes
  (§3.6).
- No bench harness changes, no new tasks, no fixture changes under
  `bench/fixtures/` — retire.html is a GUARD fixture in `test/fixtures/`.
- No h2h re-scoring, no pooling with archived stores, no README/RESULTS
  claim movement (§9.4).

---

## 11. File / ownership partition

**One builder owns, exhaustively:**

- `src/core/snapshot/registry.ts` — `retireKey` + class-comment amendment
  (§3.1)
- `src/core/snapshot/diff.ts` — `retirePositionalRebinds`, `DiffOptions.
  retiredRef`, `buryUnder` retired branch, reconcile fallback, comment
  repairs (§3.2)
- `src/core/snapshot/engine.ts` — pre-pass wiring, `keyForRef` dead-clause,
  `refEntry` export (§3.3)
- `src/mcp/tools.ts` — the act-branch replacement of §3.4 and NOTHING else
  in the file
- `src/core/snapshot/walker.ts` — comment repair only (§3.5)
- `test/diff-retire.test.ts` (new, §6.1); `test/diff-rebinding.test.ts`
  (re-pins of §6.3 only, header appended)
- `test/fixtures/retire.html` (new, §7.1)
- `bench/guards.mjs` — G29 appended after G28; no other guard touched (§7.2)
- `docs/design/g29-red-record.md` (new, §7.3 + §7.4 appendix)

**Must NOT touch:** `render.ts`, `types.ts` (beyond the one `DiffOptions`
member, which lives in diff.ts if that is where `DiffOptions` is declared —
it is), `act.ts`, `page.ts`, `server.ts`, `bench/lib/**`, `bench/task.mjs`,
`bench/tasks.mjs`, `bench/size.mjs`, `bench/lib/store.mjs`, anything under
`bench/fixtures/`, `bench/RESULTS.md`, `README`, any adjudication or design
record other than the two files this spec creates. If implementing §3 seems
to require touching any of these, STOP — the spec is wrong; do not improvise
across the boundary.

**RED-first ordering, binding:** (1) author `retire.html` + G29, run against
the CURRENT build, record `g29-red-record.md` including the `took: r5` hazard
demonstration — before any src edit; (2) author unit cases 1-5, run against
unedited src, failures recorded for the landing commit message; run cases 6-9
against unedited src, passes recorded; (3) land the src change set as ONE
commit; (4) the battery; (5) the sabotage battery (§7.4), appended to the RED
record; revert-by-saved-buffer, never `git checkout`.

---

## 12. Acceptance battery — run after landing, before the build is trusted

| # | check | expectation |
|---|---|---|
| 1 | pre-landing recordings exist | `g29-red-record.md` (G29a/b/d RED + hazard demo + G29c green-stable noted); commit message carries §6.1's RED and GREEN-stable runs |
| 2 | `npx tsc --noEmit` | clean |
| 3 | `npx vitest run` | green — incl. diff-retire (all 9 + registry cases), the re-pinned diff-rebinding, and every pre-existing test untouched-and-green (act, completeness, benchStream, benchReport, benchAttribution, typecheck) |
| 4 | `npx electron-vite build` | clean; ONE rebuild; `out/` hashes move (severance is the design) |
| 5 | fidelity, all six scenarios | GREEN, no expectation change; ANY drift stops the line for diagnosis before proceeding (§5) |
| 6 | live guards G1–G29 | all PASS on the post-fix build; G29 green against the byte-identical fixture/guard/command that recorded RED; G15 green unmodified |
| 7 | `npm run bench:task -- --selftest` | G1+G2 both arms, all five wave-3 tasks + canaries PASS with streamAsserts UNMODIFIED; the G2 notes table (obs F/D/N + obsChars) is RE-CAPTURED and recorded as the new baseline — byte drift from tier4's capture on queue-class tasks is EXPECTED and noted, not a failure |
| 8 | neutral-stream tripwire (§9.1.1) | zero retirement signatures on neutral-fixture scripted streams; any firing = stop-ship |
| 9 | canary sabotage | rename the canary fixture's `data-bench` → `--selftest` exits 3 INFRA; revert (true-positive path intact) |
| 10 | sabotage battery S-T5-1..3 | each row's expected reds/greens exactly as §7.4's table; recorded in the RED-record appendix |
| 11 | severance behaves | `--plan` prints under the new codeVersion; the runner refuses to extend any archived store |
| 12 | tree + tag | working tree clean; commit tagged `tier5-landed` |

**Launch gate:** items 1-12 green → the engine is frozen; the next scored
work is §9.1.2's fresh cohort on THIS build, and nothing in the watched set
moves until that cohort is complete and adjudicated. The precision sentence
moves then, or the fix does (§9.3) — nothing in between.
