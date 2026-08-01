import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EXIT,
  deadActsFrom,
  isWedged,
  metricsStamp,
  report,
  sampleMetrics,
  targetsFor,
} from '../bench/task.mjs';
import { TASKS, QUOTA_TOTAL } from '../bench/tasks.mjs';

/**
 * The report's two non-negotiables, and the apparatus sampler's seam.
 *
 * WHY (docs/design/tier3.md §3.6, §6): the wave-3 stratified report is a
 * REWRITE of the function that carries the G6b quarantine — the guard that
 * turned wave 2 from "MISLABELLED ARMS" into "the browser was wedged". A
 * rewrite that quietly dropped the quarantine table or the per-arm symmetry
 * check would look exactly like a working report. §3.6 names this unit as an
 * acceptance item for that reason: feed `report()` a synthetic row set with
 * wedged episodes and assert the table and the symmetry guard still fire.
 *
 * The sampler tests pin ATOMICITY SEAM 2 from this side: Builder B serves
 * `{pid, uptimeS, metrics:[…]}` and this must read only what §2.2 names and
 * tolerate anything else in the payload.
 */

const capture = () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, restore: () => spy.mockRestore(), text: () => lines.join('\n') };
};

afterEach(() => vi.restoreAllMocks());

/** A scored episode row, in the shape the store holds. */
function row(o: Partial<Record<string, unknown>> = {}): any {
  return {
    task: 'queue-positional',
    arm: 'diff',
    runIndex: 0,
    loaded: true,
    success: true,
    wrongElement: 0,
    pageActions: 7,
    steps: 8,
    kinds: { full: 1, diff: 7, nochange: 0, other: 0 },
    truncatedObs: 0,
    obsChars: 5000,
    attributions: { ok: 7 },
    apparatus: { deadActs: 0, walkTimeouts: 0 },
    unclassified: [],
    obsSeq: [],
    postResyncFailures: 0,
    acts: [],
    costUsd: 0.24,
    modelKeys: [],
    turns: 9,
    durationMs: 60000,
    ...o,
  };
}

/** A re-dump row: full snapshots only, or G3 fires (correctly). */
function redump(o: Record<string, unknown> = {}): any {
  return row({
    arm: 'redump',
    obsChars: 20000,
    kinds: { full: 8, diff: 0, nochange: 0, other: 0 },
    ...o,
  });
}

/** A wedged one: two acknowledged clicks the witness never saw. */
const wedged = (o: Record<string, unknown> = {}) =>
  row({
    success: false,
    pageActions: 0,
    apparatus: { deadActs: 2, walkTimeouts: 0 },
    acts: [
      { action: 'click', attribution: 'no_page_effect' },
      { action: 'click', attribution: 'no_page_effect' },
    ],
    ...o,
  });

const TASKS_ARG = [
  { id: 'queue-positional', stratum: 'discriminative', quota: 45 },
  { id: 'wizard-submit', stratum: 'canary', quota: 5 },
] as any[];

const OPTS = { model: 'claude-sonnet-5' } as any;

describe('report — the G6b quarantine survives the stratified rewrite', () => {
  it('renders the quarantine table for a store containing wedged rows', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i })),
      wedged({ runIndex: 8 }),
      wedged({ runIndex: 8, arm: 'redump' }),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();

    const text = out.text();
    expect(text).toContain('G6b QUARANTINE — 2 episode(s) excluded as apparatus failures');
    expect(text).toContain('(diff 1, re-dump 1)');
    // The disclosure sentence is part of the guard, not decoration.
    expect(text).toContain('Any citation of this run must disclose the quarantine');
    // And the wedged rows are OUT of the arithmetic that follows.
    expect(text).toContain('success  diff    : 8/8');
  });

  it('fires the per-arm symmetry guard when the wedge fell on one arm', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i })),
      ...Array.from({ length: 4 }, (_, i) => wedged({ runIndex: 10 + i })),
    ];
    const out = capture();
    const code = report(rows, OPTS, TASKS_ARG);
    out.restore();

    expect(out.text()).toContain('G6b: the quarantine is asymmetric (diff 4, re-dump 0)');
    expect(code).toBe(EXIT.INFRA);
  });

  it('leaves the symmetry guard quiet at |delta| < 3, the preserved threshold', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i })),
      ...Array.from({ length: 2 }, (_, i) => wedged({ runIndex: 10 + i })),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();

    expect(out.text()).toContain('G6b QUARANTINE');
    expect(out.text()).not.toContain('the quarantine is asymmetric');
  });
});

describe('report — the strata', () => {
  it('keeps canary episodes out of the verdict arithmetic entirely', () => {
    const rows = [
      // 8 per arm of the discriminative task, all successful in re-dump and
      // half-failing in diff — a delta no canary should be able to soften.
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i, success: i < 4 })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i })),
      // 5 per arm of a canary, all successful.
      ...Array.from({ length: 5 }, (_, i) => row({ task: 'wizard-submit', runIndex: i })),
      ...Array.from({ length: 5 }, (_, i) =>
        redump({ task: 'wizard-submit', runIndex: i }),
      ),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();

    const text = out.text();
    expect(text).toContain('success  diff    : 4/8'); // NOT 9/13
    expect(text).toContain('success  re-dump : 8/8'); // NOT 13/13
    expect(text).toContain('CANARIES — apparatus health only');
    expect(text).toContain('the apparatus and easy-task floor held');
  });

  it('trips the canary gate at quota, as an INFRA stop', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i })),
      ...Array.from({ length: 5 }, (_, i) =>
        row({ task: 'wizard-submit', runIndex: i, success: i < 3 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        redump({ task: 'wizard-submit', runIndex: i }),
      ),
    ];
    const out = capture();
    const code = report(rows, OPTS, TASKS_ARG);
    out.restore();

    expect(out.text()).toContain('CANARY GATE: wizard-submit [diff] scored 3/5');
    expect(code).toBe(EXIT.INFRA);
  });
});

describe('targetsFor — per-task quotas (§3.3.1)', () => {
  const ARMS = ['diff', 'redump'];

  it('asks for exactly the quota table at the last wave', () => {
    expect(targetsFor(TASKS, ARMS, 45).length).toBe(QUOTA_TOTAL);
    expect(QUOTA_TOTAL).toBe(290);
  });

  it('stops a task at its own quota however large the phase cap gets', () => {
    const targets = targetsFor(TASKS, ARMS, 1000);
    for (const t of TASKS) {
      const mine = targets.filter((x: any) => x.task.id === t.id);
      expect(mine.length).toBe(t.quota * 2);
      expect(Math.max(...mine.map((x: any) => x.runIndex))).toBe(t.quota - 1);
    }
  });

  it('treats --n as a cap below the quota, not a target', () => {
    // (10 + 10 + 10 + 5 + 5) x 2 arms = 80: the canaries are already done.
    expect(targetsFor(TASKS, ARMS, 10).length).toBe(80);
    const canaries = targetsFor(TASKS, ARMS, 10).filter(
      (x: any) => x.task.stratum === 'canary',
    );
    expect(canaries.length).toBe(20);
  });

  it('keeps the wave-major order, so an interrupted phase leaves even coverage', () => {
    const targets = targetsFor(TASKS, ARMS, 45);
    const runs = targets.map((x: any) => x.runIndex);
    expect(runs).toEqual([...runs].sort((a, b) => a - b));
    // …and a quota-exhausted task simply drops out of the later waves.
    const lateCanaries = targets.filter(
      (x: any) => x.runIndex >= 5 && x.task.stratum === 'canary',
    );
    expect(lateCanaries).toEqual([]);
  });
});

describe('deadActsFrom — both eras of the same physical event', () => {
  it('counts the pre-W1 signal', () => {
    expect(deadActsFrom([{ action: 'click', attribution: 'no_page_effect' }] as any)).toBe(1);
  });

  it('counts the W1-era signal — the engine\'s own input-loss report', () => {
    expect(deadActsFrom([{ action: 'click', attribution: 'engine_input_loss' }] as any)).toBe(1);
  });

  it('still ignores scroll and key, which legitimately witness nothing', () => {
    expect(
      deadActsFrom([
        { action: 'scroll', attribution: 'no_page_effect' },
        { action: 'key', attribution: 'no_page_effect' },
      ] as any),
    ).toBe(0);
  });

  it('quarantines on two input-loss acts, so the guard is forward-looking again', () => {
    const r = {
      acts: [
        { action: 'click', attribution: 'engine_input_loss' },
        { action: 'type', attribution: 'engine_input_loss' },
      ],
    };
    expect(isWedged(r as any)).toBe(true);
  });
});

describe('metricsStamp / sampleMetrics — apparatus seam', () => {
  it('reads only what §2.2 names, and tolerates extra fields', () => {
    const reply = {
      pid: 4242,
      uptimeS: 91,
      somethingBuilderBAddedLater: true,
      metrics: [
        { type: 'Browser', pid: 4242, cpu: { percentCPUUsage: 0.1 }, memory: {} },
        { type: 'GPU', pid: 5150, cpu: {}, memory: {}, integrityLevel: 'untrusted' },
        { type: 'Tab', pid: 6001 },
      ],
    };
    expect(metricsStamp(reply)).toEqual({ gpuPid: 5150, procs: 3 });
  });

  it('reports a null gpu pid rather than inventing one when no GPU process exists', () => {
    expect(metricsStamp({ pid: 1, uptimeS: 1, metrics: [{ type: 'Browser', pid: 1 }] })).toEqual({
      gpuPid: null,
      procs: 1,
    });
  });

  it('records a poll failure instead of throwing', () => {
    expect(metricsStamp(null)).toEqual({ gpuPid: 'poll-failed', procs: 0 });
    expect(metricsStamp({ metrics: 'not an array' })).toEqual({ gpuPid: 'poll-failed', procs: 0 });
  });

  it('fetches the endpoint with the bearer token', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pid: 7, uptimeS: 2, metrics: [{ type: 'GPU', pid: 99 }] }));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;

    const s = await sampleMetrics('tok-123', `http://127.0.0.1:${port}/metrics`);
    await new Promise<void>((ok) => server.close(() => ok()));

    expect(seen[0]).toBe('GET /metrics Bearer tok-123');
    expect(s.ok).toBe(true);
    expect(metricsStamp(s.json)).toEqual({ gpuPid: 99, procs: 1 });
  });

  it('never throws when the endpoint is not there (the pre-B build, and any wedge)', async () => {
    const s = await sampleMetrics('tok', 'http://127.0.0.1:1/metrics');
    expect(s.ok).toBe(false);
    expect(metricsStamp(s.json)).toEqual({ gpuPid: 'poll-failed', procs: 0 });
  });
});
