import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';
import { RefRegistry, assignRefs } from './registry.js';
import {
  diffSnapshots,
  firstDifferingCell,
  indexByKey,
  retirePositionalRebinds,
} from './diff.js';
import { renderDiff, renderFull, renderUnchanged } from './render.js';
import {
  REDACTED,
  REDACTED_HREF,
  canonicalNeedle,
  collectTaintedValues,
  redactObserved,
  registrableNeedle,
  scrub,
  scrubUrlish,
} from './redact.js';
import { VolatilityTracker } from './volatility.js';
import type { Observation, RefEntry, Snapshot, SnapshotNode } from './types.js';
import type { FillChannelResult, FillRequest, FillTargetRequest } from '@shared/types.js';

/**
 * Per-tab snapshot state, and the decision of what to hand the agent.
 *
 * The important judgement lives in `observe()`: a diff is cheaper, but a diff
 * the model cannot apply correctly is worse than no diff at all. So there are
 * explicit conditions under which we give up and re-state the whole page.
 */

interface WalkPayload {
  ok: boolean;
  reason?: string;
  result?: {
    root: SnapshotNode;
    url: string;
    title: string;
    viewport: { top: number; height: number; docHeight: number };
    modalKey?: string;
  };
}

/** Diff budget before we resync. Even correct diffs accumulate model-side
 *  application error; periodic full snapshots cap the blast radius at one epoch. */
const MAX_DIFFS_PER_EPOCH = 12;
/** Above this share of the last full snapshot, a diff has stopped being a saving. */
const DIFF_SIZE_RATIO = 0.3;

export class TabSnapshotState {
  readonly registry = new RefRegistry();
  readonly volatility = new VolatilityTracker();
  last: Snapshot | null = null;
  epoch = 0;
  step = 0;
  diffsThisEpoch = 0;
  lastFullLines = 0;
  /**
   * Identity keys of fields filled with sensitive values.
   *
   * Filling a credential or a national ID agent-blind is only half the job:
   * the value is now in the DOM, and the agent has tools that read the DOM.
   * Without this set, a date of birth inserted through the blind path comes
   * straight back out in the next snapshot — which defeats the entire point.
   *
   * Cleared on navigation, when the node goes away, or when the human edits
   * the field themselves.
   */
  readonly tainted = new Set<string>();
  /** True when the next observation must be a full snapshot. */
  private forceFull = true;

  requireFull(): void {
    this.forceFull = true;
  }

  consumeForceFull(): boolean {
    const v = this.forceFull;
    this.forceFull = false;
    return v;
  }

  nextFullSeq(): string {
    this.epoch += 1;
    this.step = 0;
    this.diffsThisEpoch = 0;
    return `${this.epoch}.0`;
  }

  nextDiffSeq(): string {
    this.step += 1;
    this.diffsThisEpoch += 1;
    return `${this.epoch}.${this.step}`;
  }
}

const states = new Map<string, TabSnapshotState>();
const pending = new Map<string, (payload: WalkPayload) => void>();
let wired = false;

function wireOnce(): void {
  if (wired) return;
  wired = true;
  ipcMain.on('aperture:walk-result', (_e, requestId: string, payload: WalkPayload) => {
    pending.get(requestId)?.(payload);
    pending.delete(requestId);
  });
  ipcMain.on('aperture:fill-result', (_e, requestId: string, payload: unknown) => {
    pending.get(requestId)?.(payload as WalkPayload);
    pending.delete(requestId);
  });
  ipcMain.on('aperture:read-result', (_e, requestId: string, payload: unknown) => {
    pending.get(requestId)?.(payload as WalkPayload);
    pending.delete(requestId);
  });
  ipcMain.on('aperture:select-result', (_e, requestId: string, payload: unknown) => {
    pending.get(requestId)?.(payload as WalkPayload);
    pending.delete(requestId);
  });
}

export function stateFor(tabId: string): TabSnapshotState {
  let s = states.get(tabId);
  if (!s) {
    s = new TabSnapshotState();
    states.set(tabId, s);
  }
  return s;
}

/**
 * A navigation invalidates every ref, so the next observation must be full.
 *
 * `documentReplaced` distinguishes a real navigation from a same-document one
 * (pushState, hash change). Only the former means the tainted nodes are gone;
 * clearing taint on a pushState let a hostile page unmask a filled national ID
 * by calling `history.pushState` from an input handler.
 */
export function invalidate(tabId: string, documentReplaced: boolean): void {
  const st = states.get(tabId);
  if (!st) return;
  st.requireFull();
  if (documentReplaced) {
    st.tainted.clear();
    // NEEDLES ARE NO LONGER DROPPED HERE — 2026-08-05, and this is a security
    // fix rather than an omission.
    //
    // The old line was `clearNeedles(tabId)`, justified as "the document that
    // held the filled values is gone, so the needles have nothing left to
    // match". That reasoning is false in the one case that matters: the
    // navigation is how the value ARRIVES somewhere the agent reads. A filled
    // page that does `location.href = '/carry.html#' + value` replaces its own
    // document, this line dropped every needle, and the very next snapshot
    // rendered the password in clear on the header line, in the tree, in
    // `browser_read`, and in `browser_tabs list` — one assignment, one tab, no
    // popup (measured; the seventh sink, `docs/design/sink-closure-review.md`
    // §9 hunt). The mechanism that dropped the needles was the mechanism that
    // delivered the secret, which is the same shape as the `Snapshot.title`
    // finding one review earlier.
    //
    // Taint still clears, and correctly: taint names DOM FIELDS Aperture wrote
    // into, and those are genuinely gone with the document. Needles name a
    // VALUE, the value belongs to an origin, and the origin outlives the
    // document. Their lifetime is now the TTL and the vault lock, and
    // `docs/design/security.md` states that rather than implying an early drop
    // that a hostile page controls the timing of.
    //
    // KEEPING THE NEEDLES ALIVE IS ONLY HALF OF IT, and the other half is not
    // in this file. Keeping them armed does nothing for a navigation that
    // leaves the ORIGIN: the needles survive, and the tab is no longer scrubbed
    // against them because its scope followed it. `src/main/tabs.ts` records
    // the origin the tab is leaving on this same event, which is what makes
    // coverage follow the value (`docs/design/sink-closure-review-2.md` F-E).
  }
}

/**
 * Drop a tab's snapshot state.
 *
 * Deliberately does NOT touch needles any more: they are keyed by origin, and
 * another open tab on that origin may still be able to deliver the value into
 * agent context. (Still has no caller — a known-open item, unchanged.)
 */
export function forget(tabId: string): void {
  states.delete(tabId);
}

/** Ask the page for a fresh semantic tree. */
export async function requestWalk(
  wc: WebContents,
  timeoutMs = 5000,
): Promise<WalkPayload> {
  wireOnce();
  const requestId = randomUUID();
  return new Promise<WalkPayload>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      // A page can starve the walker with a busy loop. That degrades to a
      // timeout, never to forged output.
      resolve({ ok: false, reason: 'walk timed out' });
    }, timeoutMs);

    pending.set(requestId, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });

    wc.send('aperture:walk', { requestId });
  });
}

export interface ObserveOptions {
  /** Caller forces a full snapshot (agent asked, or context was compacted). */
  full?: boolean;
  budgetTokens?: number;
  /** True when this observation follows an agent action, so changes are signal. */
  afterAction?: boolean;
  /**
   * Identity key of the element the action targeted, when there was one.
   * The volatility tracker uses it to tell "the field I typed a time into"
   * (signal, never suppress) from "a clock that ticked while I was typing"
   * (noise, suppress on shape).
   */
  actedKey?: string;
  /** Render `… N more` runs in full. Only meaningful on a full snapshot. */
  expand?: boolean;
}

/**
 * Take an observation and decide whether the agent gets a diff or a full
 * restatement.
 */
export async function observe(
  tabId: string,
  wc: WebContents,
  opts: ObserveOptions = {},
): Promise<{ observation: Observation; text: string }> {
  const st = stateFor(tabId);
  const payload = await requestWalk(wc);

  if (!payload.ok || !payload.result) {
    return {
      observation: { kind: 'unchanged', seq: st.last?.seq ?? '0.0' },
      text: `could not read the page (${payload.reason ?? 'unknown'})`,
    };
  }

  const r = payload.result;
  const forced = st.consumeForceFull() || opts.full === true;

  // Redact before anything else touches the observation, so no downstream path
  // — diffing, rendering, form matching, the `navigated` comparison — can
  // observe a sensitive value.
  //
  // `r` and not `r.root`: the walker's result carries `url` and `title`
  // alongside the tree, and those two are page-controlled strings the renderer
  // emits on the header line of every full snapshot. They were outside the
  // redaction until 2026-08-05 because the function took a `SnapshotNode`
  // (docs/design/security-review-2026-08.md F1). Redacting the whole result
  // HERE — above the `navigated` hoist and above the Snapshot construction —
  // is what makes the forced full snapshot render the scrubbed strings, and
  // keeps `r.url` and `st.last.url` in the same alphabet so a URL carrying a
  // needle does not read as a fresh navigation on every observation.
  redactObserved(r, st.tainted, needlesFor(tabId));

  // Positional families whose membership changed since the last walk lose
  // their refs BEFORE revival can rebind them — every delivery path, full or
  // diff (docs/design/tier5.md §2.3). First observation has nothing to compare.
  const retired = st.last
    ? retirePositionalRebinds(st.last.root, r.root, st.registry)
    : undefined;

  // Assign refs across the whole tree before diffing, so both sides speak the
  // same names. This also re-attaches refs to nodes the registry already
  // knows even when their role is not addressable — see registry.assignRefs
  // for why that matters (the wasEmitted deadlock).
  assignRefs(r.root, st.registry);

  if (forced || !st.last) {
    const snap: Snapshot = {
      seq: st.nextFullSeq(),
      epoch: st.epoch,
      url: r.url,
      title: r.title,
      root: r.root,
      viewport: r.viewport,
      modal: r.modalKey,
    };
    const text = renderFull(snap, {
      budgetTokens: opts.budgetTokens,
      registry: st.registry,
      expand: opts.expand,
    });
    st.last = snap;
    st.lastFullLines = text.split('\n').length;
    return { observation: { kind: 'full', snapshot: snap }, text };
  }

  const now = Date.now();
  const result = diffSnapshots(st.last.root, r.root, st.registry, {
    isVolatile: (key) => st.volatility.isVolatile(key),
    wasEmitted: (ref) => st.registry.wasEmitted(ref),
    retiredRef: retired ? (key) => retired.get(key) : undefined,
  });

  // A rows-carrying update has no `text` of its own, and a table that rewrites
  // itself every second is exactly as much of a live region as a ticking clock
  // — it must be able to earn suppression the same way. The old tree is
  // indexed lazily and only when a rows update is actually present, so an
  // ordinary diff pays nothing for this.
  let oldIndex: Map<string, SnapshotNode> | undefined;
  for (const op of result.ops) {
    if (op.op === 'update') {
      const key = refKey(st, op.ref) ?? op.ref;
      let text = op.delta.text?.[1] ?? op.delta.name?.[1] ?? op.delta.value;
      if (text === undefined && op.delta.rows) {
        oldIndex ??= indexByKey(st.last.root);
        text = firstDifferingCell(oldIndex.get(key)?.rows, op.delta.rows);
      }
      st.volatility.noteChange(key, now, opts.afterAction === true, text, opts.actedKey);
    }
  }
  // Unread changes never become ops, but the tracker must still hear about
  // them. Before this, a clock that lived behind the unread gate (never
  // rendered, so never emitted) could not be demoted and generated a
  // "changes in regions you have not read" note on every observation forever.
  for (const u of result.unread) {
    st.volatility.noteChange(u.key, now, opts.afterAction === true, u.text, opts.actedKey);
  }

  // Hoisted ABOVE the empty-ops return on purpose. A `pushState` that changes
  // the URL without an immediate DOM delta produces zero ops, and below the
  // return it silently updated `st.last.url` and told the agent nothing had
  // changed — a route change is news. Above it, a zero-op navigation falls
  // through to the full-snapshot branch exactly as it already does when ops
  // exist.
  const navigated = r.url !== st.last.url;

  if (result.ops.length === 0 && !navigated) {
    // Zero ops consume NEITHER a state id NOR one of the epoch's diff slots.
    // The id names a state, and there is no new state to name; the cap exists
    // to bound accumulated model-side application error, and applying zero ops
    // accumulates none of it. Before this, every "nothing changed" answer burnt
    // a slot and hastened a full resync the agent then paid for.
    st.last = { ...st.last, root: r.root, title: r.title };
    return {
      observation: { kind: 'unchanged', seq: st.last.seq },
      text: renderUnchanged(st.last.seq, {
        afterAction: opts.afterAction === true,
        suppressed: result.suppressed,
        unreadChanges: result.unreadChanges,
      }),
    };
  }

  const baseSeq = st.last.seq;
  const seq = st.nextDiffSeq();
  const diffPayload = {
    seq,
    baseSeq,
    ops: result.ops,
    suppressed: result.suppressed,
    unreadChanges: result.unreadChanges,
  };
  // Dry render: sizes the candidate WITHOUT marking anything emitted. If this
  // diff loses to a full resync below, its subtree refs were never shown to
  // the model, and marking them would poison the wasEmitted gate.
  const rendered = renderDiff(diffPayload, st.registry, false);

  // Past a certain size a diff stops saving anything and starts risking a
  // misapplied mental model. Restating the page is the cheaper failure.
  const tooBig =
    rendered.split('\n').length > Math.max(60, st.lastFullLines * DIFF_SIZE_RATIO);
  const tooMany = st.diffsThisEpoch > MAX_DIFFS_PER_EPOCH;

  if (tooBig || tooMany || navigated) {
    const snap: Snapshot = {
      seq: st.nextFullSeq(),
      epoch: st.epoch,
      url: r.url,
      title: r.title,
      root: r.root,
      viewport: r.viewport,
      modal: r.modalKey,
    };
    const text = renderFull(snap, {
      budgetTokens: opts.budgetTokens,
      registry: st.registry,
      expand: opts.expand,
    });
    st.last = snap;
    st.lastFullLines = text.split('\n').length;
    return { observation: { kind: 'full', snapshot: snap }, text };
  }

  st.last = { ...st.last, seq, root: r.root, url: r.url, title: r.title };
  return {
    observation: {
      kind: 'diff',
      diff: {
        seq,
        baseSeq,
        ops: result.ops,
        suppressed: result.suppressed,
        unreadChanges: result.unreadChanges,
      },
    },
    // Commit render: byte-identical to the dry pass, but this text is what
    // the model actually receives, so emission marks are applied.
    text: renderDiff(diffPayload, st.registry, true),
  };
}

// Ref assignment lives in registry.assignRefs — one addressable set, shared
// with the walker. The engine used to carry a private copy of both, and the
// copies drifted: banner and contentinfo were addressable to the walker but
// never received refs here, and nodes the registry knew from diffing never
// got their refs re-attached (the wasEmitted deadlock).

function refKey(st: TabSnapshotState, ref: string): string | undefined {
  return st.registry.resolve(ref)?.key;
}

// The redaction itself — the marker constants, the tree walk, and the two
// header strings — lives in `./redact.js`. It is a pure leaf so the suite can
// execute it: this module imports `electron`, and no unit test in this repo can
// import a module that does (docs/design/g29-red-record.md, Appendix A).
export { REDACTED, REDACTED_HREF } from './redact.js';

// ---------------------------------------------------------------------------
// Needles — the F9 fix
//
// The existing free-text redaction reads live values back out of the page and
// uses them as search strings. It CANNOT see a password: the walker masks
// password values before they leave the page (`walker.ts`, `valueOf`), so the
// real value is never in the payload the redactor reads. The mechanism that
// exists for profile secrets is structurally blind to vault secrets, which is
// the row docs/design/security.md marks "designed, not yet implemented".
//
// So credential fills register their values directly, here, in main. **And
// profile fills do too, since 2026-08-05** — `registerNeedles` had exactly one
// call site for three gates, so every mechanism built on this store protected
// passwords and left a date of birth to be copied out of the page verbatim
// (F-F, `docs/design/sink-closure-review-3.md` §2). `test/fillpaths.test.ts` is
// what stops a third path shipping the same way.
//
// Three honest statements, none of which is hedging:
//
//   * It puts plaintext in main-process memory for up to ten minutes. Main
//     already holds it — the fill path receives the secret — so this extends a
//     lifetime rather than creating an exposure class. The out-of-envelope
//     adversary (local code execution as the same user) already wins against a
//     same-user process, and the in-envelope adversary cannot reach main's heap
//     at all.
//   * It is defeated by transformation. A page that prints the password
//     reversed, base64'd, or one character per element is not caught by
//     substring matching and cannot be. This is a mitigation against a careless
//     or late-compromised origin, not a boundary.
//   * It over-redacts, and "over-redaction is cosmetic" was too easy. This
//     comment used to say a six-digit one-time code would turn an unrelated
//     `123456` into the marker and that this was cosmetic. The third gate
//     measured it and it is not: the same URL then reads differently in two
//     tabs with nothing in the output saying so, and the marker asserts a claim
//     the agent may act on. Two things changed rather than one — an all-digit
//     value now needs nine characters (`registrableNeedle`, `redact.ts`), and
//     the marker no longer claims the value was filled HERE. What remains is
//     genuinely cosmetic and is stated as the residual it is.
//   * It is bounded by a TTL and by nothing else. `carriedOrigins` makes the
//     blast radius follow the tab across origins for those ten minutes, which
//     is what closes F-E — the cost is real and it is the trade this module
//     takes everywhere.
// ---------------------------------------------------------------------------

interface NeedleSet {
  values: Set<string>;
  timer: NodeJS.Timeout;
}

/**
 * NEEDLE SCOPE — keyed by ORIGIN, not by tab (2026-08-05).
 *
 * This map was keyed by `tabId` and the scope was wrong in both directions.
 *
 * TOO NARROW, measured twice. A fill happens in a tab, so keying by tab reads
 * as the natural choice — but the value belongs to an ORIGIN, and the tab that
 * CARRIES it need not be the tab that was filled. `src/main/tabs.ts` wires
 * every page's window-open handler to create AND ACTIVATE a new tab, so one
 * line of page script (`window.open('/carry.html#' + value)`) produced a tab
 * with no needles of its own, and the agent's very next unqualified
 * `browser_snapshot` returned the whole tree in clear
 * (`docs/design/sink-closure-review.md` F-A). The same page could also just
 * navigate ITSELF there — see `invalidate`.
 *
 * TOO WIDE, in the one place it had been widened. `browser_tabs list` was
 * scrubbed against the union of EVERY tab's needles, which closed the listing
 * and disclosed a real cost: an unrelated tab whose title genuinely contained
 * another origin's secret got the marker. Origin scope closes the listing for
 * the same reason — a carrier is same-origin — while redacting strictly less.
 *
 * So the rule is now one rule instead of two, and it is the rule the value
 * itself implies: **a needle is scoped to the origin it was filled into, and a
 * tab is scrubbed against every origin whose content it can be showing.**
 * `everyNeedle` and `redactAcrossTabs` are gone; there is nothing left for
 * them to do.
 *
 * ON "STRICTLY LESS", AND ON THE CLAIM THIS COMMENT USED TO MAKE. The first
 * version of this argument said origin scope was strictly greater in coverage
 * than the union at less over-redaction. That was false on the one surface the
 * union actually lived on: the union scrubbed every line of `browser_tabs list`
 * against every needle in the browser, and it would have caught a filled tab
 * that had navigated ITSELF away, which origin-plus-opener did not (F-E). The
 * two were INCOMPARABLE on that listing. They are comparable now — a tab's
 * carried set includes the origins it has left, so the union has nothing left
 * that this does not — and the sentence is only true because that hole was
 * closed. Across every other surface origin scope was always vastly wider.
 *
 * WHAT A TAB'S SCOPE IS is not this module's business — it needs the tab list,
 * and this module must not import one. `OriginScope` is injected once by
 * `src/main/index.ts` and answers it: the origin the tab is on now, plus every
 * origin it CARRIES — who opened it (transitively, so a relay chain does not
 * break at depth 2), and every origin it has navigated away from. The second
 * part is the one that took two gates to get right, and the rule behind it is
 * one sentence: **coverage follows the value, not the tab's present location.**
 */
export interface OriginScope {
  /** Every origin whose filled values this tab's content could be carrying. */
  forTab(tabId: string): string[];
}

/** Fails closed to "no origins", so an unwired scope over-redacts nothing and
 *  under-redacts everything — which is why `index.ts` wires it before the MCP
 *  server can accept a call. */
let originScope: OriginScope = { forTab: () => [] };

export function setOriginScope(scope: OriginScope): void {
  originScope = scope;
}

const needles = new Map<string, NeedleSet>();
const NEEDLE_TTL_MS = 10 * 60 * 1000;

// WHICH VALUES ARE WORTH A NEEDLE is `registrableNeedle`, in `redact.ts`.
//
// It lives in the pure leaf rather than here so the suite can execute the
// shipped rule instead of a copy of it — the same reason `redactObserved` is
// there — and because it is redaction POLICY (how wide a net is worth casting)
// rather than bookkeeping about this store. It carries the length bar and the
// raised bar for all-digit values, and argues both at its own header.

/**
 * The forms of one filled value that have to be searched for.
 *
 * The raw value, plus its whitespace-canonical form when that differs. The
 * walker collapses every run of whitespace before the redactor ever sees a
 * string (`walker.ts`, `truncate`), so a password containing a tab or two
 * consecutive spaces could not match its own copy on the page: the text was
 * normalised and the needle was not. Same alphabet rule as the invisible
 * code points, coming from the other side.
 */
function needleForms(v: string): string[] {
  const canon = canonicalNeedle(v);
  return canon !== v ? [v, canon] : [v];
}

/**
 * Register a filled value against the ORIGIN it was written into.
 *
 * The origin is passed in rather than derived from the tab, because the caller
 * has the one that matters: the committed origin the human approved and the
 * preload compared against `location.origin` in the same task as the write.
 * Deriving it here from the tab's live URL would be a second source of truth
 * for the fact the whole fill path is organised around.
 */
export function registerNeedles(origin: string, values: string[]): void {
  if (!origin) return;
  const usable = values
    .filter(registrableNeedle)
    .flatMap(needleForms);
  if (!usable.length) return;

  const existing = needles.get(origin);
  if (existing) clearTimeout(existing.timer);
  const set = existing?.values ?? new Set<string>();
  for (const v of usable) set.add(v);

  const timer = setTimeout(() => needles.delete(origin), NEEDLE_TTL_MS);
  // Never a reason to hold the process open; the values die with it anyway.
  timer.unref?.();
  needles.set(origin, { values: set, timer });
}

/**
 * Remove specific needles.
 *
 * The undo half of the pair that closes the redaction window in both
 * directions: register BEFORE the write, so no concurrent snapshot can read a
 * value that is already in the DOM, and remove only in the one case where the
 * value provably never landed — a global refusal, where the preload completes
 * validation before the first write.
 *
 * Named values rather than "everything for this tab", so a refused fill cannot
 * un-redact an earlier successful one. (Residual: if the same value were
 * registered twice and one of those fills were later refused, this drops it for
 * both. Reaching that needs a successful fill whose taint was then cleared,
 * because a second `apply` on a filled form answers `ALREADY_FILLED` before it
 * ever reaches this path.)
 */
export function dropNeedles(origin: string, values: string[]): void {
  const n = needles.get(origin);
  if (!n) return;
  for (const v of values.flatMap(needleForms)) n.values.delete(v);
  if (n.values.size === 0) clearNeedles(origin);
}

function clearNeedles(origin: string): void {
  const n = needles.get(origin);
  if (!n) return;
  clearTimeout(n.timer);
  needles.delete(origin);
}

/**
 * Drop every needle in every tab. Registered as a vault lock hook by
 * `src/main/index.ts` — a locked vault should not leave its plaintext lying in
 * main for the rest of the ten minutes.
 */
export function clearAllNeedles(): void {
  for (const n of needles.values()) clearTimeout(n.timer);
  needles.clear();
}

/**
 * Does this origin hold any live needle right now?
 *
 * The one question `TabManager.originScope` needs and cannot answer: a tab's
 * carried set is bookkeeping about where the tab has BEEN, and whether any of
 * those origins still matters is a fact about this store. Exported as a
 * BOOLEAN — a caller can learn that an origin is worth scrubbing against and
 * cannot obtain a single byte of what it holds, which is the same line
 * `needlesFor` draws by not being exported at all.
 *
 * Safe to prune on, and the reason is a fact about WHEN an origin joins a
 * carried set: at the moment the tab leaves it, or at the moment the tab is
 * created by an opener that was already there. A value registered AFTER that
 * moment cannot be in this tab's content — the tab's document was replaced on
 * the way out, and Aperture hands a page no window handle to write through
 * (`setWindowOpenHandler` denies and creates the tab itself). So an origin with
 * no live needles is not merely contributing nothing now; it cannot begin to
 * contribute later. If the tab navigates back, the origin is its CURRENT one
 * and enters scope that way instead.
 */
export function hasNeedles(origin: string): boolean {
  return (needles.get(origin)?.values.size ?? 0) > 0;
}

/**
 * Every needle that could appear in this tab's content.
 *
 * The union is over the tab's ORIGIN SCOPE — see `OriginScope` above — and not
 * over every tab in the browser. Deliberately not exported: a caller can scrub
 * a string, and cannot obtain the plaintext by asking politely.
 */
function needlesFor(tabId: string): string[] {
  const all = new Set<string>();
  for (const origin of originScope.forTab(tabId)) {
    const n = needles.get(origin);
    if (n) for (const v of n.values) all.add(v);
  }
  // Longest first, so a short needle that is a substring of a long one cannot
  // shred the long one into unmatchable pieces before it is tried.
  return [...all].sort((a, b) => b.length - a.length);
}

/**
 * Every string this tab could be asked to scrub against: the needles in its
 * origin scope, plus the live values of fields Aperture wrote into it.
 *
 * The second half is why `browser_read` works at all: the retained tree holds
 * the REDACTED copy, so a value that only ever appears in free text (a page
 * echoing it into a div) would not be matchable from the tree alone.
 */
function scrubbablesFor(tabId: string): string[] {
  const st = states.get(tabId);
  const live = needlesFor(tabId);
  if (!st?.last || st.tainted.size === 0) return live;
  return [
    ...live,
    ...collectTaintedValues(st.last.root, st.tainted).filter((v) => v.length >= 4),
  ];
}

/**
 * Values currently tainted in this tab, for redacting text that did not come
 * through the snapshot tree — `browser_read`, in particular, which reads
 * `innerText` directly and would otherwise bypass redaction entirely.
 *
 * NO `marker` PARAMETER, deliberately. It used to take one so that
 * `browser_tabs`'s title and URL could share a code path, and that is exactly
 * how the URL came to be scrubbed with the text scrubber: the caller picked the
 * right marker and the wrong function, and nothing could tell it apart from a
 * correct call. A URL now has its own function; there is no argument left to
 * get wrong, and tsc rejects the old spelling rather than accepting it.
 */
export function redactFreeText(tabId: string, s: string): string {
  const all = scrubbablesFor(tabId);
  return all.length ? scrub(s, all, REDACTED) : s;
}

/**
 * THE ONE TREATMENT FOR A URL. Every agent-facing or machine-leaving URL goes
 * through here, and no call site chooses between this and `redactFreeText`.
 *
 * `scrubUrlish` was written for one sentence in its own header — *"a page that
 * writes the value it holds straight into `a.href` gets `?pw=my%20pass` back
 * out, and the needle is `my pass`"* — and was then wired to two of the five
 * places that sentence applies: `Snapshot.url` and `SnapshotNode.href`. The
 * other three used the plain scrub, which does not decode. Measured on the
 * shipped build (`docs/design/sink-closure-review-2.md` F-C): one same-origin
 * self-navigation with one `U+202D` inside the value put
 * `?pw=guard-pw%E2%80%AD-93a1` into `browser_tabs list` and into
 * `browser_navigate`'s `loaded …` line while the snapshot header — the surface
 * that HAD `scrubUrlish` — came back clean.
 *
 * And the invisible character is not needed. Any password containing a space,
 * `#`, `&`, `%`, `+`, a quote or any non-ASCII character is percent-encoded by
 * the URL parser on those surfaces, so the plain scrub misses it with no
 * adversarial construction at all. That is an ORDINARY user's password, not an
 * attacker's.
 *
 * So the shape is a function rather than a marker argument: a call site cannot
 * pick the wrong one by passing `REDACTED_HREF` to the text scrubber, because
 * the two jobs are now two names. The marker is not a parameter here for the
 * same reason — a URL is rendered UNQUOTED and read as one whitespace-free
 * token wherever it appears.
 */
export function redactUrl(tabId: string, s: string): string {
  const all = scrubbablesFor(tabId);
  return all.length ? scrubUrlish(s, all, REDACTED_HREF) : s;
}

/**
 * The live values of tainted fields, read fresh from the page.
 *
 * Needed because the retained tree holds the redacted copy, so a value that
 * only ever appears in free text (a page echoing it into a div) would not be
 * matchable. Kept in the main process and never returned upward.
 */
export async function taintedValues(
  tabId: string,
  wc: WebContents,
): Promise<string[]> {
  const st = states.get(tabId);
  if (!st || st.tainted.size === 0) return [];
  const payload = await requestWalk(wc);
  if (!payload.ok || !payload.result) return [];
  return collectTaintedValues(payload.result.root, st.tainted);
}

/** Mark fields as holding sensitive values, so snapshots redact them. */
export function markTainted(tabId: string, keys: string[]): void {
  const st = stateFor(tabId);
  for (const k of keys) st.tainted.add(k);
}

/**
 * Undo a taint.
 *
 * Called on exactly one path: a fill that was refused GLOBALLY, where the
 * preload completes validation before the first write and so is known to have
 * written nothing. Taint goes on before the write (so no concurrent snapshot
 * can read a value that is already in the DOM) and comes off only in the case
 * where it provably never landed. Any partial or uncertain outcome keeps it.
 */
export function unmarkTainted(tabId: string, keys: string[]): void {
  const st = states.get(tabId);
  if (!st) return;
  for (const k of keys) st.tainted.delete(k);
}

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

/**
 * The agent explicitly acted on this element. Suppression must never hide
 * something the agent is paying attention to — caring is expressed through
 * the tools, and this is where the engine hears it.
 */
export function agentTouched(tabId: string, key: string): void {
  states.get(tabId)?.volatility.onAgentTouch(key);
}

/**
 * Read the rendered text of one element, resolved through the isolated-world
 * index. This is what makes `browser_read`'s `ref` parameter real: the scoped
 * read happens against the same identity keys acting uses, in a world the
 * page cannot tamper with.
 */
export async function requestRead(
  wc: WebContents,
  key: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; text?: string; reason?: string }> {
  wireOnce();
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, reason: 'read timed out' });
    }, timeoutMs);

    pending.set(requestId, (payload) => {
      clearTimeout(timer);
      resolve(payload as unknown as { ok: boolean; text?: string; reason?: string });
    });

    wc.send('aperture:read', { requestId, key });
  });
}

/**
 * The shape the page-side select handler replies with.
 *
 * Failure carries the material for a useful error — how many options there
 * are, which ones were candidates, which ones are near — because "no such
 * option" on a 51-option list the agent cannot see is a dead end.
 */
export type SelectResult =
  | {
      ok: true;
      label: string;
      value: string;
      tier: number;
      multiple: boolean;
      total: number;
      previous: string[];
    }
  | {
      ok: false;
      reason: string;
      tag?: string;
      total?: number;
      multiple?: boolean;
      tier?: number;
      /** Capped list; `matched` carries the true count it was cut from. */
      candidates?: string[];
      matched?: number;
      suggestions?: string[];
      label?: string;
    };

/**
 * Choose an option in a native `<select>`, in the page's isolated world.
 *
 * Deliberately NOT on the CDP input path in `act.ts`: there is no trusted
 * input path to a native dropdown, because its popup is an OS window outside
 * the WebContents. See the handler in `src/preload/page.ts` for the full
 * argument, including why the option's prototype setter is what makes React
 * accept the change.
 */
export async function requestSelect(
  wc: WebContents,
  key: string,
  option: string,
  timeoutMs = 5000,
): Promise<SelectResult> {
  wireOnce();
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, reason: 'select timed out' });
    }, timeoutMs);

    pending.set(requestId, (payload) => {
      clearTimeout(timer);
      resolve(payload as unknown as SelectResult);
    });

    wc.send('aperture:select', { requestId, key, option });
  });
}

/**
 * Attach files to a file input.
 *
 * This must go through CDP `DOM.setFileInputFiles`. A page's `input.files` is
 * deliberately not settable from JavaScript — that restriction is what stops a
 * website silently uploading your disk — so the isolated-world setter trick
 * used for text fields does not apply here.
 *
 * The caller is responsible for ensuring `paths` came from the human's
 * attachment library. Nothing here should ever receive an agent-chosen path:
 * "upload my CV" and "read any file on this machine and POST it somewhere"
 * are the same primitive if the path is not constrained.
 */
export async function attachFiles(
  wc: WebContents,
  refKeyToFind: string,
  paths: string[],
): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch (err) {
    return { ok: false, reason: `could not attach debugger: ${String(err)}` };
  }

  try {
    // Resolve the element via the isolated world's index, then convert the
    // remote object into a node id CDP can act on.
    const { root } = (await wc.debugger.sendCommand('DOM.getDocument', {
      depth: -1,
    })) as { root: { nodeId: number } };

    const { nodeIds } = (await wc.debugger.sendCommand('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: 'input[type=file]',
    })) as { nodeIds: number[] };

    if (!nodeIds.length) return { ok: false, reason: 'no file input on the page' };

    // Without a stable mapping from ref to backendNodeId we take the first
    // file input, which is right for the single-upload case that covers job
    // applications. Multi-upload forms need the ref->node bridge; flagged
    // rather than silently guessing.
    const target = nodeIds[0]!;
    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
      nodeId: target,
      files: paths,
    });
    void refKeyToFind;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** What `requestFill` answers when the page never replies at all. */
export type FillOutcome = FillChannelResult | { ok: false; reason: 'timeout' };

/**
 * Send fills to the page and await the result.
 *
 * ONE MECHANISM, NOT TWO. The profile path and the credential path share this
 * function, one preload handler and one channel. Targets are kind-tagged and
 * the checks that differ, differ by kind. Two mechanisms would drift, and the
 * drift would be silent: the credential path would grow the origin echo and the
 * profile path would keep the TOCTOU. This codebase has already paid for
 * exactly that inconsistency once (`consent.ts`'s opening comment).
 *
 * THE TIMEOUT IS 5000ms AND THE PRELOAD REPLIES AT T+250ms. The gap is
 * deliberate slack, not an accident: the deferred verification is a
 * `setTimeout` inside the page's own task queue, and a page busy for 200ms
 * would otherwise turn a landed fill into a timeout.
 */
export async function requestFill(
  wc: WebContents,
  req: { expectedOrigin: string; atomic: boolean; targets: FillTargetRequest[] },
  timeoutMs = 5000,
): Promise<FillOutcome> {
  wireOnce();
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    pending.set(requestId, (payload) => {
      clearTimeout(timer);
      resolve(payload as unknown as FillChannelResult);
    });

    const message: FillRequest = {
      requestId,
      expectedOrigin: req.expectedOrigin,
      atomic: req.atomic,
      targets: req.targets,
    };
    wc.send('aperture:fill', message);
  });
}
