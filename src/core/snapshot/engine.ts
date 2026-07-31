import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';
import { RefRegistry } from './registry.js';
import { diffSnapshots } from './diff.js';
import { renderDiff, renderFull } from './render.js';
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
}

export function stateFor(tabId: string): TabSnapshotState {
  let s = states.get(tabId);
  if (!s) {
    s = new TabSnapshotState();
    states.set(tabId, s);
  }
  return s;
}

/** A navigation invalidates every ref, so the next observation must be full. */
export function invalidate(tabId: string): void {
  const st = states.get(tabId);
  if (!st) return;
  st.requireFull();
  // The old document is gone, so nothing in it is still tainted.
  st.tainted.clear();
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
  // same names.
  assignRefs(r.root, st);

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
        op.delta.text?.[1] ?? op.delta.value,
      );
    }
  }

  if (result.ops.length === 0) {
    const seq = st.nextDiffSeq();
    st.last = { ...st.last, seq, root: r.root, url: r.url, title: r.title };
    const diff = { tabId, seq, baseSeq: st.last.seq, ops: [], suppressed: result.suppressed, unreadChanges: 0 };
    return {
      observation: { kind: 'unchanged', seq },
      text: renderDiff({ ...diff, seq, baseSeq: seq }),
    };
  }

  const baseSeq = st.last.seq;
  const seq = st.nextDiffSeq();
  const rendered = renderDiff(
    {
      seq,
      baseSeq,
      ops: result.ops,
      suppressed: result.suppressed,
      unreadChanges: result.unreadChanges,
    },
    st.registry,
  );

  // Past a certain size a diff stops saving anything and starts risking a
  // misapplied mental model. Restating the page is the cheaper failure.
  const tooBig =
    rendered.split('\n').length > Math.max(60, st.lastFullLines * DIFF_SIZE_RATIO);
  const tooMany = st.diffsThisEpoch > MAX_DIFFS_PER_EPOCH;
  const navigated = r.url !== st.last.url;

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
    text: rendered,
  };
}

/**
 * Assign refs in document order, so e1 is the first thing on the page.
 *
 * Ref numbers are opaque, but an agent reading a form where the first field is
 * e17 and the submit button is e3 has to work harder than one reading e1..e17
 * top to bottom — and so does a human debugging a transcript.
 */
function assignRefs(root: SnapshotNode, st: TabSnapshotState): void {
  if (isAddressable(root)) st.registry.ensureRef(root);
  for (const c of root.children) assignRefs(c, st);
}

function isAddressable(n: SnapshotNode): boolean {
  switch (n.role) {
    case 'button': case 'link': case 'textbox': case 'searchbox':
    case 'combobox': case 'checkbox': case 'radio': case 'slider':
    case 'tab': case 'menuitem': case 'iframe': case 'scrollable':
    case 'dialog': case 'list': case 'table': case 'form':
    case 'region': case 'nav': case 'main':
      return true;
    default:
      return false;
  }
}

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
    if (tainted.has(n.key) && n.value !== undefined && n.value !== '') {
      n.value = '(filled from profile)';
    }
    for (const c of n.children) stack.push(c);
  }
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
