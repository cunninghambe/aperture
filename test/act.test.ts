import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as z from 'zod';

/**
 * `browser_act` at the tool boundary, with the engine stubbed.
 *
 * These are the two claims the tool makes that no other test covers: that
 * `observe` selects between a diff and a full snapshot by riding the SAME
 * `opts.full` the engine already has, and that a successful `select` produces
 * a well-formed result at all.
 *
 * The second one is not hypothetical politeness. The success path originally
 * read a variable declared inside the failure branch — and it type-checked,
 * because `origin` is a DOM global, so `tsc` bound it to `lib.dom` and said
 * nothing while the main process would have thrown ReferenceError on every
 * successful select. Green types, green units, broken product: exactly the
 * failure this project keeps hitting. Calling the handler is what catches it.
 */

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
 * the command, the page never sees the event. `'unknown'` is "no witness could
 * be armed", which must behave exactly like today.
 */
let dispatchVerdict: 'landed' | 'lost' | 'unknown' = 'landed';

vi.mock('@core/snapshot/act.js', () => ({
  resolveRef: vi.fn(async () => resolveReply),
  armInputWitness: vi.fn(async () => ({ settle: async () => dispatchVerdict })),
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
   * healthy page.
   */
  it('returns an error, not ok, when the dispatch is never witnessed', async () => {
    dispatchVerdict = 'lost';
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).toMatch(/^error:/);
    expect(out).toContain('never reached the page');
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
      expect(out, action).toContain('never reached the page');
    }
  });

  it('still acks a click that landed on an element that did nothing', async () => {
    // "The action caused no visible change" is a finding about the PAGE. A
    // dispatch check that recoloured it as an engine failure would destroy
    // real signal, which is worse than the bug it fixes.
    dispatchVerdict = 'landed';
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).toContain('ok click e1');
  });

  it('changes nothing when no witness could be armed', async () => {
    dispatchVerdict = 'unknown';
    const out = await act({ action: 'click', ref: 'e1' });
    expect(out).toContain('ok click e1');
    expect(out).not.toContain('error:');
  });

  it('refuses an unusable target BEFORE arming, so no false alarm is possible', async () => {
    // These return without dispatching anything. An armed witness with no
    // dispatch behind it times out and reports a dead input path for input
    // that was never sent.
    dispatchVerdict = 'lost';
    resolveReply = { ...REACHABLE, editable: false, tag: 'DIV' };
    const out = await act({ action: 'type', ref: 'e1', text: 'hello' });
    expect(out).toContain('not an editable field');
    expect(out).not.toContain('never reached the page');

    const { armInputWitness } = await import('@core/snapshot/act.js');
    expect(armInputWitness).not.toHaveBeenCalled();
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
});
