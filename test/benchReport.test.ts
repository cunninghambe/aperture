import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EXIT,
  classifyGpuTransition,
  deadActsFrom,
  isWedged,
  metricsStamp,
  redumpImpurities,
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
  it('reads only what §2.2 and tier4 §3 name, and tolerates extra fields', () => {
    const reply = {
      pid: 4242,
      uptimeS: 91,
      somethingBuilderBAddedLater: true,
      witness: { landed: 30, unknown: 1, lost: 0 },
      metrics: [
        { type: 'Browser', pid: 4242, creationTime: 1754000000000, cpu: { percentCPUUsage: 0.1 }, memory: {} },
        { type: 'GPU', pid: 5150, cpu: {}, memory: {}, integrityLevel: 'untrusted' },
        { type: 'Tab', pid: 6001 },
      ],
    };
    expect(metricsStamp(reply)).toEqual({
      gpuPid: 5150,
      procs: 3,
      browserPid: 4242,
      browserCreated: 1754000000000,
      witness: { landed: 30, unknown: 1, lost: 0 },
    });
  });

  it('reports a null gpu pid rather than inventing one when no GPU process exists', () => {
    expect(metricsStamp({ pid: 1, uptimeS: 1, metrics: [{ type: 'Browser', pid: 1 }] })).toEqual({
      gpuPid: null,
      procs: 1,
      browserPid: 1,
      browserCreated: null,
      witness: null,
    });
  });

  it('null-tolerates a PRE-tier4 build: no Browser entry, no witness field', () => {
    // Builder B's /metrics gains `witness`, and the platform is expected to
    // type the main process 'Browser' — neither is assumed. Wave-2/wave-3
    // archives read back through this function must not throw, and must not
    // invent an instance identity they never had.
    expect(metricsStamp({ pid: 1, uptimeS: 1, metrics: [{ type: 'GPU', pid: 9 }] })).toEqual({
      gpuPid: 9,
      procs: 1,
      browserPid: null,
      browserCreated: null,
      witness: null,
    });
  });

  it('records a poll failure instead of throwing', () => {
    const failed = {
      gpuPid: 'poll-failed',
      procs: 0,
      browserPid: null,
      browserCreated: null,
      witness: null,
    };
    expect(metricsStamp(null)).toEqual(failed);
    expect(metricsStamp({ metrics: 'not an array' })).toEqual(failed);
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
    expect(metricsStamp(s.json)).toMatchObject({ gpuPid: 99, procs: 1 });
  });

  it('never throws when the endpoint is not there (the pre-B build, and any wedge)', async () => {
    const s = await sampleMetrics('tok', 'http://127.0.0.1:1/metrics');
    expect(s.ok).toBe(false);
    expect(metricsStamp(s.json)).toMatchObject({ gpuPid: 'poll-failed', procs: 0 });
  });
});

/**
 * The instance stamp (tier4 §3, from wave3-evaluation §0.1).
 *
 * Wave 3's apparatus note printed "a GPU process that crashed and relaunched"
 * over transitions that were phase boundaries — the run was executed in phases,
 * each with its own Aperture. The store had no way to tell an app restart from
 * a GPU crash inside one instance, so the note sent its reader hunting for a
 * crash the same rows already explained. The Browser process's pid and
 * creationTime are the instance's identity, and they were already crossing the
 * wire in `getAppMetrics()`.
 */
describe('classifyGpuTransition — why the GPU pid changed', () => {
  const inst = (browserPid: number, created: number, gpuPid: unknown) => ({
    gpuPid, procs: 3, browserPid, browserCreated: created, witness: null,
  });

  it('calls a changed GPU pid with a changed instance a restart', () => {
    expect(classifyGpuTransition(inst(100, 1, 200), inst(300, 2, 400))).toBe('restart');
  });

  it('calls a changed GPU pid INSIDE one instance a crash candidate', () => {
    // Same browser pid AND same creationTime: one app, two GPU processes. The
    // only shape that is evidence for the wave-2 wedge hypothesis.
    expect(classifyGpuTransition(inst(100, 1, 200), inst(100, 1, 400))).toBe('crash');
  });

  it('refuses to classify across a failed poll', () => {
    expect(classifyGpuTransition(inst(100, 1, 'poll-failed'), inst(100, 1, 400))).toBe('unmeasured');
    expect(classifyGpuTransition(inst(100, 1, 200), inst(100, 1, 'poll-failed'))).toBe('unmeasured');
  });

  it('refuses to classify a pre-tier4 row, rather than guessing restart', () => {
    const old = { gpuPid: 200, procs: 3 };
    expect(classifyGpuTransition(old as any, inst(100, 1, 400))).toBe('unknown-instance');
    expect(classifyGpuTransition(inst(100, 1, 200), old as any)).toBe('unknown-instance');
  });

  it('treats a recycled pid with a different creationTime as a new instance', () => {
    // The OS reuses pids. creationTime is what makes the identity honest.
    expect(classifyGpuTransition(inst(100, 1, 200), inst(100, 2, 400))).toBe('restart');
  });
});

const withApparatus = (o: Record<string, unknown>) => ({
  deadActs: 0, walkTimeouts: 0, procs: 3, witness: null, ...o,
});

describe('report — the apparatus note reads the instance stamp', () => {
  it('names a phase boundary as an app restart and does NOT print the crash paragraph', () => {
    const A = withApparatus({ gpuPid: 200, browserPid: 100, browserCreated: 1 });
    const B = withApparatus({ gpuPid: 400, browserPid: 300, browserCreated: 2 });
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i, apparatus: A })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i, apparatus: B })),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();

    const text = out.text();
    expect(text).toContain('APPARATUS NOTE — the GPU process pid changed 1 time(s)');
    expect(text).toContain('[app restart — expected]');
    expect(text).toContain('(browser pid 100 -> 300)');
    expect(text).toContain('All GPU pid transitions coincide with a new Aperture instance');
    // The load-bearing negative: the crash hypothesis is NOT asserted over a
    // store that already explains every transition it contains.
    expect(text).not.toContain('crashed and relaunched');
  });

  it('still prints the crash paragraph when the GPU relaunched inside one instance', () => {
    const A = withApparatus({ gpuPid: 200, browserPid: 100, browserCreated: 1 });
    const A2 = withApparatus({ gpuPid: 999, browserPid: 100, browserCreated: 1 });
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i, apparatus: A })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i, apparatus: A2 })),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();

    expect(out.text()).toContain('[SAME-INSTANCE GPU RELAUNCH — crash candidate]');
    expect(out.text()).toContain('crashed and relaunched');
  });
});

/**
 * The W1 unknown-rate telemetry (tier4 §6.3).
 *
 * `lost` became a live attribution in tier3; `unknown` did not, and a witness
 * degraded to unknown-mode is indistinguishable in the store from a healthy one
 * — while W1's lost-detection is blind for exactly that share. The head-to-head
 * is the most external-facing comparison in the programme and should not run
 * with the witness's own health unmeasured.
 */
describe('report — the input witness summary', () => {
  const instRow = (created: number, w: Record<string, number>, o: Record<string, unknown> = {}) =>
    row({
      apparatus: withApparatus({
        gpuPid: 200, browserPid: created * 100, browserCreated: created, witness: w,
      }),
      ...o,
    });
  const asRedump = (o: Record<string, unknown>) => ({
    arm: 'redump',
    obsChars: 20000,
    kinds: { full: 8, diff: 0, nochange: 0, other: 0, error: 0 },
    ...o,
  });

  it('sums the FINAL row of each instance, because the counters are cumulative', () => {
    const rows = [
      // Instance 1: the counters climb across its episodes. Summing every row
      // would count the same settles once per episode.
      instRow(1, { landed: 10, unknown: 0, lost: 0 }, { runIndex: 0 }),
      instRow(1, { landed: 25, unknown: 0, lost: 0 }, { runIndex: 1 }),
      ...Array.from({ length: 6 }, (_, i) =>
        instRow(1, { landed: 40, unknown: 0, lost: 0 }, { runIndex: 2 + i }),
      ),
      // Instance 2, a separate process, with its own cumulative totals.
      ...Array.from({ length: 8 }, (_, i) =>
        instRow(2, { landed: 20, unknown: 0, lost: 0 }, asRedump({ runIndex: i })),
      ),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();

    expect(out.text()).toContain(
      'Input witness (cumulative across 2 instance(s)): landed 60 · unknown 0 · lost 0',
    );
    expect(out.text()).not.toContain('ADVISORY: the input witness');
  });

  it('raises the advisory above a 10% unknown rate, and not below it', () => {
    const loud = [
      ...Array.from({ length: 8 }, (_, i) => instRow(1, { landed: 80, unknown: 20, lost: 0 }, { runIndex: i })),
      ...Array.from({ length: 8 }, (_, i) =>
        instRow(1, { landed: 80, unknown: 20, lost: 0 }, asRedump({ runIndex: i })),
      ),
    ];
    const a = capture();
    report(loud, OPTS, TASKS_ARG);
    a.restore();
    expect(a.text()).toContain('ADVISORY: the input witness answered `unknown` for >10% of settles');

    const quiet = [
      ...Array.from({ length: 8 }, (_, i) => instRow(1, { landed: 95, unknown: 5, lost: 0 }, { runIndex: i })),
      ...Array.from({ length: 8 }, (_, i) =>
        instRow(1, { landed: 95, unknown: 5, lost: 0 }, asRedump({ runIndex: i })),
      ),
    ];
    const b = capture();
    report(quiet, OPTS, TASKS_ARG);
    b.restore();
    expect(b.text()).toContain(
      'Input witness (cumulative across 1 instance(s)): landed 95 · unknown 5 · lost 0',
    );
    expect(b.text()).not.toContain('ADVISORY: the input witness');
  });

  it('prints nothing at all for a pre-tier4 store', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i })),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();
    expect(out.text()).not.toContain('Input witness');
  });
});

/**
 * Arm purity and the G3 whitelist (tier4 §2.3, wave3-evaluation §1.4).
 *
 * F5 was recorded INFRA on wave 3 because an agent pressed an unsupported key:
 * a one-line `error:` with no page bytes in it counted as an arm impurity.
 */
describe('redumpImpurities — what actually violates arm purity', () => {
  it('counts diffs, no-changes and unclassified observations', () => {
    expect(redumpImpurities({ full: 8, diff: 1, nochange: 0, other: 0, error: 0 })).toBe(1);
    expect(redumpImpurities({ full: 8, diff: 0, nochange: 2, other: 0, error: 0 })).toBe(2);
    // The G2 pre-flight used to test diff|nochange only, so an `other` was
    // caught by the scored-run G3 and missed by the free one. One definition.
    expect(redumpImpurities({ other: 1 })).toBeGreaterThan(0);
  });

  it('excludes the error kind — both arms can receive it identically', () => {
    expect(redumpImpurities({ full: 8, diff: 0, nochange: 0, other: 0, error: 3 })).toBe(0);
  });

  it('tolerates a pre-tier4 kinds object with no error key', () => {
    expect(redumpImpurities({ full: 8, diff: 0, nochange: 0, other: 0 })).toBe(0);
  });
});

describe('report — G3 over the new taxonomy', () => {
  const diffRows = () => Array.from({ length: 8 }, (_, i) => row({ runIndex: i }));

  it('does not fire on a re-dump arm whose only non-full replies were bare errors', () => {
    const rows = [
      ...diffRows(),
      ...Array.from({ length: 8 }, (_, i) =>
        redump({ runIndex: i, kinds: { full: 8, diff: 0, nochange: 0, other: 0, error: 2 } }),
      ),
    ];
    const out = capture();
    const code = report(rows, OPTS, TASKS_ARG);
    out.restore();

    expect(out.text()).not.toContain('G3: ');
    expect(code).not.toBe(EXIT.INFRA);
  });

  it('still fires on an unclassified observation, which is where a diff would hide', () => {
    const rows = [
      ...diffRows(),
      ...Array.from({ length: 8 }, (_, i) =>
        redump({ runIndex: i, kinds: { full: 8, diff: 0, nochange: 0, other: 1, error: 0 } }),
      ),
    ];
    const out = capture();
    const code = report(rows, OPTS, TASKS_ARG);
    out.restore();

    expect(out.text()).toContain('G3: 8 re-dump episodes received an observation that was not a FULL SNAPSHOT');
    expect(out.text()).toContain('does not bear on arm purity');
    expect(code).toBe(EXIT.INFRA);
  });
});

/**
 * The post-resync metric, restricted rather than deleted (tier4 §4, from
 * wave3-evaluation §0.2).
 *
 * The old line printed a post_resync failure count per arm, side by side, and
 * the side-by-side was read as a comparison — 65 vs 236. It is not one: the arm
 * forcing routes every re-dump observation through `opts.full`, so every
 * re-dump act tags post_resync and its "count" degenerates to "all non-ok
 * acts". The proxy tag stays arm-blind; the report is where the honesty goes.
 */
describe('report — resync-window fragility is diff-arm only, and says so', () => {
  const act = (tags: string[], attribution: string) => ({ action: 'click', tags, attribution });

  it('prints diff-arm rates only, with the exclusion note', () => {
    const diffActs = [
      act(['post_resync'], 'wrong_element'),
      act(['post_resync'], 'ok'),
      act([], 'ok'),
      act([], 'ok'),
    ];
    // Every re-dump act tags post_resync, which IS the vacuity. If any of these
    // reached the block, the restriction would not be real.
    const redumpActs = [
      act(['post_resync'], 'wrong_element'),
      act(['post_resync'], 'wrong_element'),
      act(['post_resync'], 'wrong_element'),
    ];
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i, acts: diffActs })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i, acts: redumpActs })),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();

    const text = out.text();
    expect(text).toContain('Resync-window fragility (diff arm ONLY — see note):');
    // 8 rows × 1 non-ok of 2 tagged acts; and 0 non-ok of 16 untagged.
    expect(text).toContain('within 2 observations of a FULL SNAPSHOT: 8/16 acts non-ok (50.0%)');
    expect(text).toContain('all other acts:                           0/16 acts non-ok (0.0%)');
    expect(text).toContain('the re-dump arm is excluded BY CONSTRUCTION');
    expect(text).toContain('No cross-arm reading of this block is');
    // The re-dump arm's 24 non-ok tagged acts appear NOWHERE in the block.
    const start = text.indexOf('Resync-window fragility');
    const block = text.slice(start, text.indexOf('licensed.', start) + 'licensed.'.length);
    expect(block).not.toContain('24');
    expect(block).not.toContain('re-dump arm:');
    // And the old side-by-side line is gone, not merely relabelled.
    expect(text).not.toContain('(of those, within 2 steps of a FULL SNAPSHOT)');
  });

  it('prints an em dash rather than dividing by zero', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row({ runIndex: i, acts: [] })),
      ...Array.from({ length: 8 }, (_, i) => redump({ runIndex: i, acts: [] })),
    ];
    const out = capture();
    report(rows, OPTS, TASKS_ARG);
    out.restore();
    expect(out.text()).toContain('within 2 observations of a FULL SNAPSHOT: —');
    expect(out.text()).toContain('all other acts:                           —');
  });
});
