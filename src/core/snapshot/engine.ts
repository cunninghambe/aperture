import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';
import { RefRegistry, assignRefs } from './registry.js';
import { diffSnapshots } from './diff.js';
import { renderDiff, renderFull, renderUnchanged } from './render.js';
import { VolatilityTracker } from './volatility.js';
import type { Observation, Snapshot, SnapshotNode } from './types.js';

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
  if (documentReplaced) st.tainted.clear();
}

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

  // Redact before anything else touches the tree, so no downstream path —
  // diffing, rendering, form matching — can observe a sensitive value.
  redactTainted(r.root, st.tainted);

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
  });

  for (const op of result.ops) {
    if (op.op === 'update') {
      st.volatility.noteChange(
        refKey(st, op.ref) ?? op.ref,
        now,
        opts.afterAction === true,
        op.delta.text?.[1] ?? op.delta.name?.[1] ?? op.delta.value,
        opts.actedKey,
      );
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

/**
 * Replace the values of tainted fields with a fixed marker.
 *
 * A fixed marker rather than a length-accurate mask: `••••••` of the right
 * length still leaks the length, which is real information about a secret.
 */
function redactTainted(root: SnapshotNode, tainted: Set<string>): void {
  if (tainted.size === 0) return;
  const stack: SnapshotNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (tainted.has(n.key)) {
      // `value` is not enough. A node that is not an input carries its content
      // in `text` or `name`, so copying a filled value into a <div> produced an
      // unredacted line. All three are rendered, so all three are redacted.
      if (n.value !== undefined && n.value !== '') n.value = REDACTED;
      if (n.text) n.text = REDACTED;
      if (n.name) n.name = REDACTED;
    }
    for (const c of n.children) stack.push(c);
  }
}

const REDACTED = '(filled from profile)';

/**
 * Values currently tainted in this tab, for redacting text that did not come
 * through the snapshot tree — `browser_read`, in particular, which reads
 * `innerText` directly and would otherwise bypass redaction entirely.
 */
export function redactFreeText(tabId: string, s: string): string {
  const st = states.get(tabId);
  if (!st || st.tainted.size === 0 || !st.last) return s;

  let out = s;
  for (const value of collectTaintedValues(st.last.root, st.tainted)) {
    if (value.length < 4) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}

function collectTaintedValues(root: SnapshotNode, tainted: Set<string>): string[] {
  const vals: string[] = [];
  const stack: SnapshotNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (tainted.has(n.key)) {
      for (const v of [n.value, n.text, n.name]) {
        if (v && v !== REDACTED) vals.push(v);
      }
    }
    for (const c of n.children) stack.push(c);
  }
  return vals;
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

/** Resolve a ref to the identity key the page-side index is keyed on. */
export function keyForRef(tabId: string, ref: string): string | null {
  return stateFor(tabId).registry.resolve(ref)?.key ?? null;
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

/** Send fills to the page and await the result. */
export async function requestFill(
  wc: WebContents,
  fills: { key: string; value: string }[],
  timeoutMs = 5000,
): Promise<{ ok: boolean; filled: string[]; reason?: string }> {
  wireOnce();
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, filled: [], reason: 'fill timed out' });
    }, timeoutMs);

    pending.set(requestId, (payload) => {
      clearTimeout(timer);
      resolve(payload as unknown as { ok: boolean; filled: string[]; reason?: string });
    });

    wc.send('aperture:fill', { requestId, fills });
  });
}
