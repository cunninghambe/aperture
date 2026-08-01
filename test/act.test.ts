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

vi.mock('@core/snapshot/act.js', () => ({
  resolveRef: vi.fn(async () => ({
    ok: true,
    x: 10,
    y: 10,
    editable: true,
    tag: 'BUTTON',
    obstructed: false,
  })),
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
});
