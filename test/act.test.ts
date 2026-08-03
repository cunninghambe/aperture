import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as z from 'zod';

/**
 * `browser_act` at the tool boundary, plus W1's witness against a fake preload.
 *
 * Two layers, deliberately:
 *
 *  1. The TOOL layer, with the engine stubbed. These are the claims no other
 *     test covers: that `observe` selects between a diff and a full snapshot by
 *     riding the SAME `opts.full` the engine already has, that a successful
 *     `select` produces a well-formed result at all, and that each dispatch
 *     verdict routes to the right answer.
 *
 *     The select case is not hypothetical politeness. The success path
 *     originally read a variable declared inside the failure branch — and it
 *     type-checked, because `origin` is a DOM global, so `tsc` bound it to
 *     `lib.dom` and said nothing while the main process would have thrown
 *     ReferenceError on every successful select. Green types, green units,
 *     broken product: exactly the failure this project keeps hitting.
 *
 *  2. The WITNESS layer (docs/design/tier3.md §1.6), against the real
 *     `witnessInput` with a scripted preload on a fake IPC bus. Gate 2 proved
 *     that the previous witness turned a healthy page into a browser-is-broken
 *     alarm, so the verdict machine itself now has to be exercised, not just
 *     the branch that consumes it.
 */

// --- a fake ipcMain, so the real act.ts can be driven end to end -------------

const { fakeIpcMain, ipcHandlers } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const handlers = new Map<string, Listener[]>();
  const ipc = {
    on(channel: string, fn: Listener) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), fn]);
      return ipc;
    },
    emit(channel: string, ...args: unknown[]) {
      for (const fn of handlers.get(channel) ?? []) fn(...args);
    },
  };
  return { fakeIpcMain: ipc, ipcHandlers: handlers };
});

// Every other named import from electron is already `undefined` under vitest
// (the package resolves to a CJS module exporting the binary's path), so this
// mock changes exactly one thing: `ipcMain` becomes drivable.
vi.mock('electron', () => ({ ipcMain: fakeIpcMain }));

// --- the engine, stubbed ----------------------------------------------------

const observeCalls: { id: string; opts: Record<string, unknown> | undefined }[] = [];
let selectReply: unknown = null;
const REACHABLE = {
  ok: true,
  x: 10,
  y: 10,
  editable: true,
  tag: 'BUTTON',
  obstructed: false,
  obstructor: null,
};
let resolveReply: unknown = REACHABLE;

const DIFF = 'page #1.1 (diff from #1.0)\n~ e1 ="Large"';
const FULL = 'FULL SNAPSHOT #1.2\ncombobox e1 "Size" ="Large" [4 options]';

vi.mock('@core/snapshot/engine.js', () => ({
  observe: vi.fn(async (id: string, _wc: unknown, opts?: Record<string, unknown>) => {
    observeCalls.push({ id, opts });
    return { text: opts?.full ? FULL : DIFF };
  }),
  keyForRef: (_id: string, ref: string) => (ref === 'e1' ? 'key-for-e1' : undefined),
  // tier5 §3.4: the act path resolves the whole registry entry rather than the
  // key alone, so it can tell a DEAD ref (refuse, with the current observation
  // attached — its key is still live in the page index and would resolve onto
  // whatever element holds that position now) from an UNKNOWN one (refuse
  // bare). Same contract as `keyForRef` above: `e1` is the one live element on
  // this stubbed page. Added here because the module is mocked with an explicit
  // factory, so a new engine import the tool calls has to be declared or every
  // act case throws — no behaviour of this file's assertions changes.
  refEntry: (_id: string, ref: string) =>
    ref === 'e1' ? { ref, key: 'key-for-e1', state: 'live' } : undefined,
  agentTouched: vi.fn(),
  requestSelect: vi.fn(async () => selectReply),
  markTainted: vi.fn(),
  attachFiles: vi.fn(),
  redactFreeText: (s: string) => s,
  requestRead: vi.fn(),
  taintedValues: () => [],
  requestFill: vi.fn(),
  stateFor: () => ({}),
}));

/**
 * The dispatch witness (W1), stubbed at the seam the product uses.
 *
 * `'landed'` is the healthy default. `'lost'` is the wave-2 wedge: CDP accepts
 * the command, the page never sees the event. `'unknown'` is "the witness could
 * not speak", which must behave exactly like no witness at all.
 *
 * `RELEVANT_COUNTERS` is duplicated rather than imported: the tool indexes it
 * by action, so a mock that omitted an action would fail as a crash rather than
 * as a wrong verdict, and the duplication is what makes the scroll/key entries
 * a thing this file asserts about.
 */
let dispatchVerdict: 'landed' | 'lost' | 'unknown' = 'landed';

vi.mock('@core/snapshot/act.js', () => ({
  resolveRef: vi.fn(async () => resolveReply),
  witnessInput: vi.fn(async () => ({ settle: async () => dispatchVerdict })),
  RELEVANT_COUNTERS: {
    click: ['pointerdown', 'mousedown', 'mouseup', 'click'],
    clear: ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown'],
    type: ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown'],
    hover: ['mousemove'],
    scroll: ['wheel'],
    key: ['keydown'],
  },
  click: vi.fn(),
  hover: vi.fn(),
  clearField: vi.fn(),
  typeText: vi.fn(),
  pressKey: vi.fn(),
  scroll: vi.fn(),
}));

const { registerBrowserTools } = await import('../src/mcp/tools.js');

// --- a server that only records ---------------------------------------------

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const tools = new Map<string, { schema: z.ZodType; run: Handler }>();

const fakeServer = {
  registerTool(
    name: string,
    def: { inputSchema: z.ZodType },
    run: Handler,
  ) {
    tools.set(name, { schema: def.inputSchema, run });
  },
} as never;

const fakeTabs = {
  active: 'tab1',
  webContents: () => ({ getURL: () => 'https://example.com/form' }),
  info: () => ({ url: 'https://example.com/form' }),
} as never;

registerBrowserTools(fakeServer, () => fakeTabs);

/** Parse through the registered schema, so zod defaults are under test too. */
async function act(args: Record<string, unknown>): Promise<string> {
  const tool = tools.get('browser_act')!;
  const parsed = tool.schema.parse(args) as Record<string, unknown>;
  const res = await tool.run(parsed);
  return res.content[0]!.text;
}

beforeEach(() => {
  observeCalls.length = 0;
  selectReply = null;
  resolveReply = REACHABLE;
  dispatchVerdict = 'landed';
  // Call history only — implementations survive, which is what the two stubs
  // above rely on.
  vi.clearAllMocks();
});

describe('browser_act observe parameter', () => {
  it('returns a diff by default', async () => {
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).toContain('page #1.1 (diff from #1.0)');
    expect(out).not.toContain('FULL SNAPSHOT');
    expect(observeCalls.at(-1)!.opts!.full).toBe(false);
  });

  it('returns a full snapshot on observe:"full"', async () => {
    const out = await act({ action: 'click', ref: 'e1', observe: 'full' });
    expect(out).toContain('FULL SNAPSHOT #');
    expect(out).not.toContain('(diff from');
    expect(observeCalls.at(-1)!.opts!.full).toBe(true);
  });

  it('rides opts.full rather than adding a second observation path', async () => {
    // The value the engine is asked for is the same flag browser_snapshot
    // mode:"full" sets. If a future change grows a parallel branch, this is
    // the assertion that notices.
    await act({ action: 'click', ref: 'e1', observe: 'full' });
    expect(observeCalls.at(-1)!.opts).toMatchObject({ afterAction: true, full: true });
  });

  it('applies to actions that target no element', async () => {
    const out = await act({ action: 'scroll', deltaY: 300, observe: 'full' });
    expect(out).toContain('FULL SNAPSHOT #');
    expect(observeCalls.at(-1)!.opts!.full).toBe(true);
  });

  it('defaults to diff on the untargeted actions too', async () => {
    const out = await act({ action: 'scroll', deltaY: 300 });
    expect(out).toContain('(diff from');
    expect(observeCalls.at(-1)!.opts!.full).toBe(false);
  });
});

/**
 * The exact sentence, written out rather than pattern-matched.
 *
 * The clause "input was dispatched but never reached the page" is a CROSS-REPO
 * CONTRACT (docs/design/tier3.md §1.5 and §5 seam 1): bench/lib/proxy.mjs keys
 * `engine_input_loss` attribution off it and task.mjs's G6b quarantine counts
 * it. A reword here silently refiles engine failures as agent errors in every
 * scored store, which is the sort of change that passes review and ruins a
 * wave. Copying the whole sentence is the point: it has to be edited in two
 * places on purpose.
 */
const INPUT_LOSS_CONTRACT = 'input was dispatched but never reached the page';
const LOST_CLICK =
  'error: input was dispatched but never reached the page. The click was sent ' +
  'and no trusted input event was observed in the page within 2.5s (checked ' +
  'twice). Aperture\'s input path to this tab is not working — retrying will ' +
  'not take effect. The page was not changed by this call. Tell the human; ' +
  'this needs the browser restarted.';

describe('W1 — browser_act must not ack input that never reached the page', () => {
  /**
   * Wave 2 (docs/design/wave2-evaluation.md §6): Aperture's input path wedged
   * mid-run and `browser_act` answered `ok` for forty minutes. CDP resolved,
   * the walker kept serving snapshots, the renderer kept loading pages, and
   * not one click reached the DOM. Nothing could distinguish "the click did
   * nothing" from "the click never happened" — so the agent was told the
   * first when the truth was the second, and kept planning on it.
   *
   * These assert the three verdicts, because the failure mode of a naive
   * implementation is not "misses the wedge" — it is inventing errors on a
   * healthy page. Gate 2 caught it doing exactly that.
   */
  it('returns the exact contract error, not ok, when the dispatch is lost', async () => {
    dispatchVerdict = 'lost';
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).toBe(LOST_CLICK);
    expect(out).toContain(INPUT_LOSS_CONTRACT);
    expect(out).not.toContain('ok click');
  });

  it('does not report a page observation for input that never landed', async () => {
    // The observation would be indistinguishable from a real "nothing
    // changed", which is precisely the confusion this closes.
    dispatchVerdict = 'lost';
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).not.toContain('page #1.1');
    expect(out).not.toContain('untrusted-page-content');
  });

  it('covers every element-targeted dispatch, not just click', async () => {
    dispatchVerdict = 'lost';
    for (const action of ['click', 'hover', 'clear', 'type']) {
      const out = await act({ action, ref: 'e1', text: 'hello' });
      expect(out, action).toMatch(/^error:/);
      expect(out, action).toContain(INPUT_LOSS_CONTRACT);
      expect(out, action).toContain(`The ${action} was sent`);
    }
  });

  it('covers scroll and key, which the shipped W1 did not', async () => {
    // Gate-2 open item, closed here. Wave 2's wedge acknowledged scroll acts
    // as freely as clicks (`queue-positional` run13) because nothing witnessed
    // an untargeted dispatch at all.
    dispatchVerdict = 'lost';
    const scrolled = await act({ action: 'scroll', deltaY: 300 });
    expect(scrolled).toContain(INPUT_LOSS_CONTRACT);
    expect(scrolled).toContain('The scroll was sent');
    expect(scrolled).not.toContain('ok scroll');

    const keyed = await act({ action: 'key', key: 'Enter' });
    expect(keyed).toContain(INPUT_LOSS_CONTRACT);
    expect(keyed).toContain('The key was sent');
    expect(keyed).not.toContain('ok key');
  });

  it('witnesses scroll on wheel and key on keydown, not on mousedown', async () => {
    const { witnessInput } = await import('@core/snapshot/act.js');
    await act({ action: 'scroll', deltaY: 300 });
    // [wc, key, kinds]: `null` for the key, because an untargeted act names no
    // element and the recorder speaks for the whole top document.
    expect(vi.mocked(witnessInput).mock.calls.at(-1)!.slice(1)).toEqual([null, ['wheel']]);
    await act({ action: 'key', key: 'Enter' });
    expect(vi.mocked(witnessInput).mock.calls.at(-1)!.slice(1)).toEqual([null, ['keydown']]);
  });

  it('witnesses a click on any of the four pointer counters', async () => {
    // Any-of, not all-of: a page that calls preventDefault on mousedown has
    // not stopped the event from being DELIVERED, and delivery is the question.
    const { witnessInput } = await import('@core/snapshot/act.js');
    await act({ action: 'click', ref: 'e1' });
    expect(vi.mocked(witnessInput).mock.calls.at(-1)![2]).toEqual([
      'pointerdown',
      'mousedown',
      'mouseup',
      'click',
    ]);
    await act({ action: 'hover', ref: 'e1' });
    expect(vi.mocked(witnessInput).mock.calls.at(-1)![2]).toEqual(['mousemove']);
  });

  it('still acks a click that landed on an element that did nothing', async () => {
    // "The action caused no visible change" is a finding about the PAGE. A
    // dispatch check that recoloured it as an engine failure would destroy
    // real signal, which is worse than the bug it fixes.
    dispatchVerdict = 'landed';
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).toContain('ok click e1');
  });

  it('changes nothing when the witness could not speak', async () => {
    dispatchVerdict = 'unknown';
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).toContain('ok click e1');
    expect(out).not.toContain('error:');

    const scrolled = await act({ action: 'scroll', deltaY: 300 });
    expect(scrolled).toContain('ok scroll');
    expect(scrolled).not.toContain('error:');
  });

  it('refuses an unusable target BEFORE any poll, so no false alarm is possible', async () => {
    // These return without dispatching anything. A witness established with no
    // dispatch behind it would report a dead input path for input that was
    // never sent.
    dispatchVerdict = 'lost';
    const { witnessInput } = await import('@core/snapshot/act.js');

    resolveReply = { ...REACHABLE, editable: false, tag: 'DIV' };
    const notEditable = await act({ action: 'type', ref: 'e1', text: 'hello' });
    expect(notEditable).toContain('not an editable field');
    expect(notEditable).not.toContain(INPUT_LOSS_CONTRACT);

    const noText = await act({ action: 'type', ref: 'e1' });
    expect(noText).toBe('error: text required for type');

    resolveReply = { ...REACHABLE, obstructed: true, obstructor: 'DIV#banner' };
    const covered = await act({ action: 'click', ref: 'e1' });
    expect(covered).toContain('covered by');
    expect(covered).not.toContain(INPUT_LOSS_CONTRACT);

    const noKey = await act({ action: 'key' });
    expect(noKey).toBe('error: key required');

    expect(witnessInput).not.toHaveBeenCalled();
  });
});

describe('G14 — the Gate-2 false alarm, permanently', () => {
  /**
   * THE DEFECT THIS BLOCK EXISTS FOR, stated so it cannot be re-argued.
   *
   * The shipped W1 armed its listener on the target's window AT ACT TIME.
   * Gate 2 proved live on Electron 43 that a page whose own script ran
   * `window.addEventListener('mousedown', e => e.stopImmediatePropagation(),
   * true)` at parse time silenced it: isolated worlds share the per-node
   * listener list for dispatch, and `stopImmediatePropagation` cuts the list at
   * the caller. The page registered first. So a click that LANDED — the
   * fixture's counter incremented — came back as "input was dispatched but
   * never reached the page … this needs the browser restarted". An entire
   * healthy class of pages (drag handlers, overlays, editor libraries) read as
   * a broken browser.
   *
   * The live half of G14 is Builder A's: `test/fixtures/suppressor.html` plus
   * the guard in `bench/guards.mjs`, recorded RED against the pre-fix build
   * before this landed. This is the half that runs on every `npm test`.
   */
  it('a click on a page that suppresses every listener it can is ok, not an error', async () => {
    // What the recorder sees on that fixture: the counters move anyway,
    // because registration order — not capture phase — is the guarantee, and
    // the preload registers at document_start before any page script exists.
    dispatchVerdict = 'landed';
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).toContain('ok click e1');
    expect(out).not.toContain(INPUT_LOSS_CONTRACT);
  });

  it('never dispatches before the baseline poll has answered', async () => {
    // The ordering is the mechanism: a baseline taken AFTER the click would
    // already include the click, every relevant counter would read "unchanged",
    // and every act would report the terminal error. Cheap to get backwards in
    // a refactor, so it is pinned rather than trusted.
    const { witnessInput, click: cdpClick } = await import('@core/snapshot/act.js');
    await act({ action: 'click', ref: 'e1' });
    expect(vi.mocked(witnessInput).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cdpClick).mock.invocationCallOrder[0]!,
    );
  });

  /**
   * NOT COVERED HERE, AND SAID SO. The `isTrusted` filter — the thing that
   * stops a hostile page masking a real wedge by flooding synthetic events —
   * cannot be exercised by this suite. It lives in a two-line preload handler
   * that needs a real renderer, and its failure mode needs a wedge repro that
   * does not exist. It is covered by the Electron 43 probe (synthetic flood
   * events observed `isTrusted: false` and filtered; CDP-dispatched events
   * observed `isTrusted: true`) plus review of the handler, and
   * docs/design/tier3.md §1.6 records exactly that. Claiming a test here would
   * be the false green this project keeps paying for.
   */
});

// --- the witness itself, against a scripted preload --------------------------

/**
 * §1.6's matrix, run against the REAL `witnessInput`.
 *
 * `vi.importActual` is what gets past the module mock above: the tool tests
 * need the seam stubbed, this block needs the machine.
 */
const realAct = await vi.importActual<typeof import('../src/core/snapshot/act.js')>(
  '@core/snapshot/act.js',
);

type Counts = Record<string, number>;
type PollReply =
  | { ok: true; top: boolean; docToken: string; counts: Counts }
  | { ok: false; reason: string };
/** A poll the preload never answers — the wedge that also kills IPC. */
const SILENT = 'silent' as const;
type Scripted = PollReply | typeof SILENT;

interface FakePreload {
  wc: import('electron').WebContents;
  sent: { channel: string; req: Record<string, unknown> }[];
}

/**
 * A preload that answers polls from a script, one reply per poll in order.
 *
 * Once the script runs out it REPEATS its last entry, which Amendment A.5
 * explicitly permits. That matters because the ladder (A.3) changed how many
 * polls a settle issues — baseline, rungs at 20% and 50%, the authoritative
 * poll, the retry — and a script that ran dry mid-settle would silently become
 * a different test. Cases where a rung's position is the point spell all five
 * replies out anyway.
 *
 * `oneShot` scripts the legacy `aperture:witness` channel for subframe mode:
 * `'fires'` acks the arm then reports a witnessed event, `'silent'` acks and
 * says nothing, `'gone'` refuses to arm at all.
 */
function fakePreload(
  script: Scripted[],
  oneShot?: 'fires' | 'silent' | 'gone',
): FakePreload {
  const sent: { channel: string; req: Record<string, unknown> }[] = [];
  const queue = [...script];

  const wc = {
    send(channel: string, req: Record<string, unknown>) {
      sent.push({ channel, req });
      const id = req.requestId as string;

      if (channel === 'aperture:witness-poll') {
        const reply = queue.length > 1 ? queue.shift() : queue[0];
        if (reply === undefined || reply === SILENT) return;
        queueMicrotask(() =>
          fakeIpcMain.emit('aperture:witness-poll-result', {}, id, reply),
        );
        return;
      }

      if (channel === 'aperture:witness') {
        if (oneShot === 'gone') {
          queueMicrotask(() =>
            fakeIpcMain.emit('aperture:witness-armed', {}, id, {
              ok: false,
              reason: 'gone',
            }),
          );
          return;
        }
        queueMicrotask(() => {
          fakeIpcMain.emit('aperture:witness-armed', {}, id, { ok: true });
          if (oneShot === 'fires') {
            fakeIpcMain.emit('aperture:witness-result', {}, id, {
              ok: true,
              witnessed: true,
              type: 'mousedown',
            });
          }
        });
      }
    },
  } as unknown as import('electron').WebContents;

  return { wc, sent };
}

/**
 * Compressed timings. The defaults are the spec's 500/2000/1000, and the
 * ladder's rungs are FRACTIONS of the settle window (20%/50%), so a compressed
 * window compresses the whole schedule proportionally rather than collapsing
 * the rungs onto each other.
 */
const FAST = { settleMs: 10, retryMs: 4, pollTimeoutMs: 40, armTimeoutMs: 40 };

/**
 * Document identity (Amendment A.2). `DOC_A` is "the document the baseline was
 * taken in"; `DOC_B` is what a poll answered by a NEW document returns after a
 * navigation commits mid-settle.
 */
const DOC_A = 'doc-a';
const DOC_B = 'doc-b';
const top = (counts: Counts, docToken = DOC_A): PollReply => ({
  ok: true,
  top: true,
  docToken,
  counts,
});
const sub = (counts: Counts, docToken = DOC_A): PollReply => ({
  ok: true,
  top: false,
  docToken,
  counts,
});
const pollsOf = (p: FakePreload): Record<string, unknown>[] =>
  p.sent.filter((s) => s.channel === 'aperture:witness-poll').map((s) => s.req);
const CLICK = realAct.RELEVANT_COUNTERS.click;

describe('witnessInput — the verdict machine (tier3 §1.6)', () => {
  it('1. counters advance in the settle window → landed', async () => {
    const { wc } = fakePreload([top({ mousedown: 5 }), top({ mousedown: 6 })]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
  });

  it('2. any counter in the relevant set is enough (mousedown frozen)', async () => {
    // A page that cancels mousedown still received it, and `click` arriving is
    // proof the input path is alive. Requiring all four would invent failures
    // on ordinary pages.
    const { wc } = fakePreload([
      top({ mousedown: 5, click: 2 }),
      top({ mousedown: 5, click: 3 }),
    ]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
  });

  it('3. frozen at the settle window AND at the retry → lost', async () => {
    const frozen = { mousedown: 5, pointerdown: 5, mouseup: 5, click: 5 };
    const p = fakePreload([
      top(frozen), // baseline
      top(frozen), // rung 1
      top(frozen), // rung 2
      top(frozen), // authoritative
      top(frozen), // retry
    ]);
    const w = await realAct.witnessInput(p.wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('lost');
    // Five polls under the ladder: baseline, two advance-only rungs, the
    // authoritative poll, the retry. "checked twice" in the error text is a
    // claim about the last two — the ones with `unknown`/`lost` authority —
    // and the sentence must not outrun the mechanism.
    expect(pollsOf(p)).toHaveLength(5);
  });

  it('4. frozen at the settle window, advanced at the retry → landed', async () => {
    // The busy-page rescue. A main thread blocked by a long task delivers the
    // event late; 500ms of silence on a page that is merely busy must not
    // produce the terminal error. A wedge is not a latency phenomenon — wave
    // 2's was absolute silence for forty minutes — so the retry costs nothing.
    const frozen = { mousedown: 5 };
    const { wc } = fakePreload([
      top(frozen), // baseline
      top(frozen), // rung 1
      top(frozen), // rung 2
      top(frozen), // authoritative
      top({ mousedown: 6 }), // retry — the late delivery
    ]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
  });

  it('5. baseline poll unanswered → unknown, and nothing is dispatched blind', async () => {
    const { wc } = fakePreload([SILENT]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('unknown');
  });

  it('5b. baseline poll refuses (element gone) → unknown, never lost', async () => {
    const { wc } = fakePreload([{ ok: false, reason: 'gone' }]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('unknown');
  });

  it('6. a settle re-poll that goes unanswered → unknown', async () => {
    // The apparatus went away mid-settle. Do not guess: `lost` here would
    // report a dead input path on the evidence of a dead poll channel.
    const { wc } = fakePreload([top({ mousedown: 5 }), SILENT]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('unknown');
  });

  it('6b. a retry re-poll that goes unanswered → unknown', async () => {
    const frozen = { mousedown: 5 };
    const { wc } = fakePreload([
      top(frozen), // baseline
      top(frozen), // rung 1
      top(frozen), // rung 2
      top(frozen), // authoritative
      SILENT, // retry — the apparatus went away before the verdict
    ]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('unknown');
  });

  it('7. subframe target, one-shot fires → landed', async () => {
    const { wc, sent } = fakePreload([sub({ mousedown: 5 })], 'fires');
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
    expect(sent.some((s) => s.channel === 'aperture:witness')).toBe(true);
  });

  it('8. subframe target, one-shot silent → unknown, NEVER lost', async () => {
    // Gate 2's whole lesson: a suppressible witness is not allowed to say the
    // input path is dead, because it cannot tell that from a page that merely
    // registered a `stopImmediatePropagation` handler before it. The residual
    // — a wedge affecting only subframe input still acks `ok` — is stated in
    // tier3 §1.3.2 and bounded by the bench liveness canary, whose fixture is
    // a top-document page.
    const { wc } = fakePreload([sub({ mousedown: 5 })], 'silent');
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('unknown');
  });

  it('8b. subframe target whose one-shot cannot even arm → unknown', async () => {
    const { wc } = fakePreload([sub({ mousedown: 5 })], 'gone');
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('unknown');
  });

  it('9. type: only keydown advances → landed', async () => {
    const { wc } = fakePreload([
      top({ mousedown: 1, keydown: 7 }),
      top({ mousedown: 1, keydown: 12 }),
    ]);
    const w = await realAct.witnessInput(wc, 'k', realAct.RELEVANT_COUNTERS.type, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
  });

  it('10. scroll: wheel frozen twice → lost, with no key on any poll', async () => {
    const frozen = top({ wheel: 3, mousedown: 99 });
    const p = fakePreload([frozen]);
    const w = await realAct.witnessInput(p.wc, null, realAct.RELEVANT_COUNTERS.scroll, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('lost');
    // An untargeted act has no element; sending one would make the poll answer
    // a question about an element the act never named.
    for (const req of pollsOf(p)) expect(req.key).toBeUndefined();
  });

  it('10b. an irrelevant counter moving does not rescue a lost act', async () => {
    // The whole page is being clicked by the user while our scroll goes
    // nowhere. Relevance is per-action for exactly this reason, and it has to
    // hold at every rung, not just at the authoritative poll.
    const { wc } = fakePreload([
      top({ wheel: 3, mousedown: 1 }),
      top({ wheel: 3, mousedown: 40 }),
      top({ wheel: 3, mousedown: 55 }),
      top({ wheel: 3, mousedown: 70 }),
      top({ wheel: 3, mousedown: 80 }),
    ]);
    const w = await realAct.witnessInput(wc, null, realAct.RELEVANT_COUNTERS.scroll, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('lost');
  });

  it('11. key: keydown advances → landed', async () => {
    const { wc } = fakePreload([top({ keydown: 0 }), top({ keydown: 1 })]);
    const w = await realAct.witnessInput(wc, null, realAct.RELEVANT_COUNTERS.key, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
  });

  it('a counter absent from the baseline still counts as advanced', async () => {
    // The recorder seeds every type at 0, but a poll that predates a type ever
    // firing must not be read as "already high".
    const { wc } = fakePreload([top({}), top({ click: 1 })]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
  });

  it('re-polls carry no key, so an act that removed its own target still counts', async () => {
    // Most acts an agent takes destroy their target — "Reject" deletes its
    // row. Re-keying the settle polls would answer `gone` and downgrade every
    // one of them to `unknown`, losing the witness on exactly the pages the
    // bench measures. It would buy nothing: under a real wedge nothing is
    // removed, because nothing happened.
    const { wc, sent } = fakePreload([top({ click: 1 }), top({ click: 2 })]);
    const w = await realAct.witnessInput(wc, 'key-for-e1', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
    const polls = sent.filter((s) => s.channel === 'aperture:witness-poll');
    expect(polls[0]!.req.key).toBe('key-for-e1');
    expect(polls[1]!.req.key).toBeUndefined();
  });

  // -- the short-circuit ladder and the document-continuity token (Amendment A)

  it('13. an advance at the first rung lands early — the ladder’s reason to exist', async () => {
    // Runs the SHIPPED constants: rungs at 100ms and 250ms, authoritative at
    // 500ms. Arrival on a healthy page is ~0-5ms, so waiting the full window
    // before asking cost ~500ms on every act — about an hour across wave 3's
    // ~7,000 acts, which is money AND an hour more exposure to the wedge this
    // exists to catch. Pinned by elapsed time so it cannot quietly regress to
    // a fixed wait.
    const { wc } = fakePreload([top({ mousedown: 5 }), top({ mousedown: 6 })]);
    const started = Date.now();
    const w = await realAct.witnessInput(wc, 'k', CLICK);
    expect(await w.settle()).toBe('landed');
    expect(Date.now() - started).toBeLessThan(400);
  }, 10_000);

  it('14. rungs unanswered but the authoritative poll advanced → landed, not unknown', async () => {
    // THE ADVANCE-ONLY RULE. An early rung has no `unknown` authority: it can
    // only ever say `landed`. Without this, a flaky-but-recovering IPC channel
    // would convert traces the unamended path scores `landed` or `lost` into
    // `unknown` — on exactly the apparatus-degradation traces G6b exists to
    // see, which would be the worst possible place to lose signal.
    const { wc } = fakePreload([
      top({ mousedown: 5 }), // baseline
      SILENT, // rung 1 — ignored
      SILENT, // rung 2 — ignored
      top({ mousedown: 6 }), // authoritative
    ]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
  });

  it('14b. an unhappy rung is ignored too, not just an unanswered one', async () => {
    const { wc } = fakePreload([
      top({ mousedown: 5 }),
      { ok: false, reason: 'poll-failed' },
      { ok: false, reason: 'poll-failed' },
      top({ mousedown: 6 }),
    ]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('landed');
  });

  it('15. a token change at the first rung → unknown, immediately', async () => {
    // Nothing is gained by waiting: witness continuity is unrecoverable and a
    // later poll can never re-match, so the ladder resolves on the spot.
    const { wc } = fakePreload([
      top({ mousedown: 5 }, DOC_A),
      top({ mousedown: 0 }, DOC_B),
    ]);
    const started = Date.now();
    const w = await realAct.witnessInput(wc, 'k', CLICK);
    expect(await w.settle()).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(400);
  }, 10_000);

  it('16. THE NAVIGATING CLICK: token differs, counters "frozen" → unknown, never lost', async () => {
    /**
     * The defect Amendment A.2 exists for, and the regression test for it.
     *
     * The recorder's counters are PER-DOCUMENT: they die with the document and
     * the new one starts at zero. So an act that CAUSES a navigation — a link
     * click, an Enter that submits a form — has its settle poll answered by a
     * different recorder with fresh counts, and a strict `>` comparison reads
     * that reset as FROZEN. Under the pre-amendment code this returned the
     * terminal restart-the-browser error on the commonest healthy action a
     * real page has. The old one-shot was immune only by accident, resolving
     * at ~0ms before teardown.
     *
     * The scripted trace is exactly that: renderer too busy committing the
     * navigation to answer the rungs, then the new document answers with its
     * own token and counters at zero — numerically LOWER than the baseline,
     * which is what makes "frozen" the wrong reading rather than a close call.
     */
    const { wc } = fakePreload([
      top({ mousedown: 5, click: 3 }, DOC_A), // baseline, old document
      SILENT, // rung 1 — renderer busy navigating
      SILENT, // rung 2
      top({ mousedown: 0, click: 0 }, DOC_B), // authoritative — NEW document
      top({ mousedown: 0, click: 0 }, DOC_B), // and it stays new
    ]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('unknown');
  });

  it('16b. a token change at the retry poll is also unknown, never lost', async () => {
    // The slow-navigation variant: same document through the authoritative
    // poll, turned over by the time the retry lands.
    const frozen = { mousedown: 5 };
    const { wc } = fakePreload([
      top(frozen, DOC_A),
      top(frozen, DOC_A),
      top(frozen, DOC_A),
      top(frozen, DOC_A),
      top({ mousedown: 0 }, DOC_B),
    ]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('unknown');
  });

  it('17. same token throughout, frozen everywhere → still lost (the wedge)', async () => {
    // A.2 must not have softened the true positive. It cannot: a wedged tab
    // delivers no input, so nothing navigates, so the token still matches and
    // the counters are still frozen at 2500ms. This is the re-pin.
    const frozen = { mousedown: 5, pointerdown: 5, mouseup: 5, click: 5 };
    const { wc } = fakePreload([
      top(frozen, DOC_A),
      top(frozen, DOC_A),
      top(frozen, DOC_A),
      top(frozen, DOC_A),
      top(frozen, DOC_A),
    ]);
    const w = await realAct.witnessInput(wc, 'k', CLICK, FAST);
    expect(await w.settle(FAST.settleMs)).toBe('lost');
  });

  it('takes the full 2.5s the error text claims before saying lost', async () => {
    // The sentence says "within 2.5s (checked twice)". This is the only test
    // that runs the shipped constants to a `lost`, and it exists so the claim
    // cannot drift away from the mechanism — a 500ms-only verdict would still
    // pass every other case in this file while making the error a lie.
    //
    // FIVE frozen replies, not three: the ladder added polls, not delay. The
    // total is still 500 + 2000, which is what this asserts.
    const frozen = { mousedown: 5 };
    const p = fakePreload([
      top(frozen), top(frozen), top(frozen), top(frozen), top(frozen),
    ]);
    const started = Date.now();
    const w = await realAct.witnessInput(p.wc, 'k', CLICK);
    expect(await w.settle()).toBe('lost');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2400);
    expect(pollsOf(p)).toHaveLength(5);
  }, 10_000);

  it('wires exactly one poll-result listener, however many witnesses ran', () => {
    // `wireOnce` is what keeps a long session from accumulating one ipcMain
    // listener per act until Node warns and then leaks. Last in the block on
    // purpose: by now every case above has been through `witnessInput`.
    expect(ipcHandlers.get('aperture:witness-poll-result')).toHaveLength(1);
  });
});

describe('the witness tally — W1 measuring its own health (tier4 §6.3)', () => {
  /**
   * WHY THIS EXISTS. `lost` became live attribution in tier3, but `unknown`
   * never did: an unknown verdict falls through to a normal observe, so a run
   * in which the witness silently degraded to unknown-mode — dead poll channel,
   * navigating pages, subframe targets — is indistinguishable from a healthy
   * one from outside the process. In that state W1's lost-detection is BLIND
   * and a recurrence of the wave-2 wedge would be acked `ok` unseen. The
   * head-to-head is the most external-facing comparison in the programme and
   * should not run with the witness's own health unmeasured.
   *
   * Deltas, not absolutes: the counters are process-global and cumulative by
   * design (a reader groups rows by instance and differences them), and every
   * case above this line has already run through them.
   */
  it('counts exactly one resolution per settle, at every resolution path', async () => {
    const before = realAct.witnessTally();

    // 1. recorder mode, counters advance → landed.
    const landed = fakePreload([top({ mousedown: 5 }), top({ mousedown: 6 })]);
    const wLanded = await realAct.witnessInput(landed.wc, 'k', CLICK, FAST);
    expect(await wLanded.settle(FAST.settleMs)).toBe('landed');

    // 2. recorder mode, frozen through the retry → lost.
    const frozen = { mousedown: 5 };
    const lost = fakePreload([top(frozen)]);
    const wLost = await realAct.witnessInput(lost.wc, 'k', CLICK, FAST);
    expect(await wLost.settle(FAST.settleMs)).toBe('lost');

    // 3. the baseline poll never answers → UNKNOWN_WITNESS, the constant.
    //    This is the path the counters exist for: no witness was ever
    //    established, and nothing downstream of the verdict would say so.
    const unknown = fakePreload([SILENT]);
    const wUnknown = await realAct.witnessInput(unknown.wc, 'k', CLICK, FAST);
    expect(await wUnknown.settle(FAST.settleMs)).toBe('unknown');

    // 4. subframe mode, the one-shot fires → landed, on the OTHER settle
    //    implementation. Two settle bodies plus the constant is three places a
    //    hand-maintained counter would eventually miss one of.
    const sub1 = fakePreload([sub({ mousedown: 5 })], 'fires');
    const wSub = await realAct.witnessInput(sub1.wc, 'k', CLICK, FAST);
    expect(await wSub.settle(FAST.settleMs)).toBe('landed');

    const after = realAct.witnessTally();
    expect({
      landed: after.landed - before.landed,
      unknown: after.unknown - before.unknown,
      lost: after.lost - before.lost,
    }).toEqual({ landed: 2, unknown: 1, lost: 1 });
  });

  it('hands out a copy, so no caller can edit the counters', () => {
    // The endpoint that serves these (`/metrics`, src/mcp/server.ts) hands the
    // object straight to JSON.stringify; returning the live one would make the
    // apparatus's own health mutable by anything holding a reference.
    const snap = realAct.witnessTally();
    const landed = snap.landed;
    snap.landed += 1000;
    expect(realAct.witnessTally().landed).toBe(landed);
  });
});

describe('browser_act select', () => {
  it('acknowledges the chosen option and appends the observation', async () => {
    selectReply = {
      ok: true,
      label: 'Large',
      value: 'l',
      tier: 1,
      multiple: false,
      total: 4,
      previous: ['Medium'],
    };
    const out = await act({ action: 'select', ref: 'e1', option: 'Large' });
    expect(out).toContain('ok select e1 → "Large"');
    expect(out).toContain('untrusted-page-content');
    expect(out).toContain('page #1.1 (diff from #1.0)');
  });

  it('says replace semantics aloud on a multi-select', async () => {
    selectReply = {
      ok: true,
      label: 'Olives',
      value: 'olives',
      tier: 1,
      multiple: true,
      total: 6,
      previous: ['Mushrooms', 'Onions'],
    };
    const out = await act({ action: 'select', ref: 'e1', option: 'Olives' });
    expect(out).toContain('REPLACED');
    expect(out).toContain('"Mushrooms"');
    expect(out).toContain('"Onions"');
  });

  it('refuses an ambiguous option with the candidates, and selects nothing', async () => {
    selectReply = {
      ok: false,
      reason: 'ambiguous',
      tier: 1,
      candidates: ['"Melbourne" (value "mel-au")', '"Melbourne" (value "mel-us")'],
      total: 12,
    };
    const out = await act({ action: 'select', ref: 'e1', option: 'Melbourne' });
    expect(out).toMatch(/^error:/);
    expect(out).toContain('matches 2 options');
    expect(out).toContain('mel-us');
    expect(out).not.toContain('ok select');
  });

  it('reports a wrong element as the native-vs-custom distinction', async () => {
    selectReply = { ok: false, reason: 'not-a-select', tag: 'DIV' };
    const out = await act({ action: 'select', ref: 'e1', option: 'Large' });
    expect(out).toContain('<div>');
    expect(out).toContain('[N options]');
  });

  it('requires an option', async () => {
    const out = await act({ action: 'select', ref: 'e1' });
    expect(out).toBe('error: option required for select');
  });

  it('refuses a select behind a modal, exactly as click does', async () => {
    // The hit-test is the ONLY thing in the codebase that refuses an action
    // because something covers the target. `select` needs no coordinates, but
    // it needs the same reachability answer — otherwise it is the one action
    // that can mutate form state behind a consent dialog and report `ok`.
    resolveReply = {
      ok: true,
      x: 10,
      y: 10,
      editable: false,
      tag: 'SELECT',
      obstructed: true,
      obstructor: 'DIV#banner',
    };
    selectReply = { ok: true, label: 'Overnight', value: 'ovn', tier: 1, multiple: false, total: 3, previous: [] };

    const out = await act({ action: 'select', ref: 'e1', option: 'Overnight' });
    expect(out).toMatch(/^error:/);
    expect(out).toContain('covered by');
    expect(out).not.toContain('ok select');

    // And nothing was written: the page must not be mutated by a refused call.
    const { requestSelect } = await import('@core/snapshot/engine.js');
    expect(requestSelect).not.toHaveBeenCalled();
  });

  it('refuses a disabled select rather than writing through it', async () => {
    // `matchOption` refuses a disabled OPTION on the rule "a human cannot
    // choose it, so neither can we". One level up was unguarded: a
    // <select disabled>, and a select inside a <fieldset disabled>, both took
    // the write and dispatched a real change event.
    selectReply = { ok: false, reason: 'select-disabled', total: 2 };
    const out = await act({ action: 'select', ref: 'e1', option: 'Beta' });
    expect(out).toMatch(/^error:/);
    // Named, not swallowed by the default branch — the fieldset half is the
    // one the agent cannot see in the snapshot, so the error has to say it.
    expect(out).toContain('<fieldset disabled>');
    expect(out).toContain('Nothing was written');
    expect(out).not.toContain('ok select');
  });

  it('refuses a blank option query', async () => {
    selectReply = { ok: false, reason: 'blank-query', total: 51 };
    const out = await act({ action: 'select', ref: 'e1', option: '   ' });
    expect(out).toMatch(/^error:/);
    expect(out).toContain('blank');
    expect(out).toContain('placeholder');
    expect(out).not.toContain('ok select');
  });

  it('reports the true match count when the candidate list was capped', async () => {
    selectReply = {
      ok: false,
      reason: 'ambiguous',
      tier: 5,
      candidates: Array.from({ length: 8 }, (_, i) => `"x option ${i}"`),
      matched: 800,
      total: 800,
    };
    const out = await act({ action: 'select', ref: 'e1', option: 'x' });
    expect(out).toContain('matches 800 options');
    expect(out).toContain('792 more not shown');
  });

  it('never establishes a witness — select dispatches no input', async () => {
    // `select` is a state mutation plus a notification on the IPC path. A
    // witness there would poll for input counters that nothing was ever going
    // to move, and 2.5s later call a working page broken.
    selectReply = { ok: true, label: 'Large', value: 'l', tier: 1, multiple: false, total: 4, previous: [] };
    await act({ action: 'select', ref: 'e1', option: 'Large' });
    const { witnessInput } = await import('@core/snapshot/act.js');
    expect(witnessInput).not.toHaveBeenCalled();
  });
});
