/**
 * Task-success benchmark — the claim everything else rests on.
 *
 * WHAT IT MEASURES
 *
 * Whether a language model completes the same fixed task set as often, with no
 * more wrong-element actions, observing the page via DIFFS versus via full
 * RE-DUMPS — everything else byte-identical. `bench/fidelity.mjs` already
 * proved the diff stream is information-complete for a MECHANICAL reader. This
 * asks the only question that was left: does a language model actually do the
 * bookkeeping?
 *
 * WHY IT IS BUILT THE WAY IT IS
 *
 * - Ground truth is the FIXTURE'S OWN JAVASCRIPT, reporting to a loopback
 *   collector. Not the snapshot pipeline: half of that pipeline is the variable
 *   under test, and this suite has twice printed a green that came from asking
 *   the thing under test whether it worked.
 * - The arm is applied at the MCP proxy, never in the prompt. The prompt bytes
 *   are hashed and compared across arms (G11), because "everything else
 *   byte-identical" is the whole experiment and is exactly the kind of claim
 *   that quietly stops being true.
 * - Scoring is INTENTION-TO-TREAT. A diff-arm episode that rescues itself with
 *   voluntary full snapshots still scores as diff-arm, and its cost includes
 *   the rescues. That is production reality, and the alternative — excluding
 *   the rescues — would flatter the diff arm by discarding its failures.
 * - Two guards run BEFORE any API budget is spent, and they catch the two worst
 *   vectors: a task that succeeds by accident (G1) and an experiment where the
 *   winning information never travels through a diff at all (G2).
 * - A LIVENESS CANARY runs before every episode, and an episode whose
 *   acknowledged clicks never reached the page is quarantined rather than
 *   scored (G6b). Wave 2 spent 46 minutes and $2.16 measuring a browser whose
 *   act path answered `ok` against a page nothing could reach, and the shipped
 *   suite diagnosed it as MISLABELLED ARMS. An apparatus failure must never be
 *   able to present as a result about the variable under test.
 *
 * KNOWN LIMITATIONS, stated rather than papered over:
 * - The SDK exposes no temperature control (only `effort`), so runs are
 *   stochastic. That is acceptable because it affects both arms identically,
 *   but it means a single episode is noise and only the pooled CIs are evidence.
 * - The model is Sonnet, not Opus, and that is a SENSITIVITY choice: if the
 *   model scores ~100% in both arms the suite cannot detect a bookkeeping
 *   penalty even if one exists. G10 refuses to call that a PASS.
 * - `browser_read` is withheld. innerText re-reads would let the agent route
 *   around diff bookkeeping and dilute the variable under test.
 *
 * RUNNING IT IN PHASES
 *
 * 290 episodes is hours, not minutes, so the suite is resumable. Every scored
 * episode is appended to `bench/task/results/episodes.jsonl` as it completes,
 * keyed by (task, arm, runIndex, codeVersion, model); a later invocation skips
 * every combination already on record and runs only what is missing. The
 * verdict is computed over the WHOLE accumulated store, not over one phase —
 * five partial runs that each score their own rows give five underpowered
 * verdicts and no result.
 *
 * PER-TASK QUOTAS AND THE TWO STRATA (wave 3, docs/design/tier3.md §3.2-3.3)
 *
 * `--n` is a PHASE CAP, not a target: each task stops accruing at its own
 * `quota`, so the three discriminative tasks run to 45/arm while the two
 * canaries stop at 5/arm however large `--n` gets. The report partitions on
 * `stratum`: verdict arithmetic over the discriminative stratum only, apparatus
 * guards over every scored row, canaries in no interval anywhere. Wave 2 pooled
 * 210 ceilinged episodes with 35 informative ones and diluted the only signal
 * it had; that is the failure this partition exists to make impossible.
 *
 * That is only sound if the thing under test did not change between phases, so
 * every episode is stamped with a content hash of the product source, the built
 * artifacts, the fixtures, the task definitions, the arm-forcing rule, the
 * prompts and the verdict thresholds. A run that finds a stamp it does not
 * recognise REFUSES to aggregate (exit 6) and names what moved. There is no
 * override; `--new-cohort` archives the old store and starts a fresh one.
 *
 * USAGE
 *   npm run bench:task -- --plan              what to run, in what order. No infra.
 *   npm run bench:task -- --selftest          G1+G2 only. Spends NO API budget.
 *   npm run bench:task -- --tasks a,b --n 2   a small scored pilot
 *   npm run bench:task -- --n 5               phase 1: 5 runs of every task
 *   npm run bench:task -- --n 45              the last phase: only what is missing
 *   npm run bench:task -- --report            score the store, run nothing
 *   npm run bench:task -- --new-cohort --n 5  archive the store, start again
 *
 * EXIT CODES — nonzero must never be read as "roughly green"
 *   0 PASS · 1 REGRESSION · 2 INCONCLUSIVE · 3 INFRA · 4 VACUOUS · 5 SELFTEST
 *   6 INTEGRITY — the store holds episodes from a different experiment
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { TASKS, FIXTURES, QUOTA_TOTAL, taskById } from './tasks.mjs';
import { startCollector, settle, COLLECTOR_PORT } from './lib/collector.mjs';
import { startProxy, PROXY_PORT, ARM_DEFINITION } from './lib/proxy.mjs';
import { APERTURE_PORT, killTree, portIsOpen, runStamp, startAperture } from './lib/aperture.mjs';
import { propDiffCI, meanDiffCI, mean, wilson, smallestDetectableDrop, fmtPct, fmtSigned } from './lib/stats.mjs';
import {
  SUITE_VERSION,
  appendEpisode,
  archiveStore,
  buildIdentity,
  checkIntegrity,
  cohortPathFor,
  defaultStorePath,
  episodeKey,
  loadCohort,
  loadStore,
  stampEpisode,
  writeCohort,
} from './lib/store.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE_DIR = join(ROOT, 'bench', 'fixtures');
const FIXTURE_PORT = 8899;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

export const EXIT = {
  // Renamed from PARITY for wave 3 (tier3.md §3.3.5). Exit-0 semantics are
  // unchanged; the WORD is retired, because wave 2's -5pp "parity" rule was
  // unreachable at any affordable N on an off-ceiling suite and cleared only
  // by 0.25pp after a post-hoc quarantine. No wave-3 output prints it.
  PASS: 0,
  REGRESSION: 1,
  INCONCLUSIVE: 2,
  INFRA: 3,
  VACUOUS: 4,
  SELFTEST: 5,
  INTEGRITY: 6,
};

/**
 * THE WAVE-3 VERDICT RULE, frozen before any wave-3 episode (tier3.md §3.4).
 *
 * `successBound` is the PRIMARY and the only success bound there is: -10pp,
 * chosen for REACHABILITY at the quota (135 discriminative episodes per arm, a
 * CI half-width of ~8.5pp at 85% pooled success) and stated as such rather
 * than discovered afterwards. `wrongBound` replaces wave 2's pooled +0.2/run,
 * which wave2-evaluation §4.2 retired with its arithmetic.
 * `perTaskWrongTrip` is the mirror of wave 2's dilution lesson applied to the
 * metric where one task can hide inside a pool of three. `stratumFloorPerArm`
 * is G8, restated for the stratum.
 */
const SUCCESS_BOUND = -0.1; // stratum success-delta CI lower bound >= this
const WRONG_BOUND = 0.4; // stratum wrong-element-delta CI upper bound <= this
const PER_TASK_WRONG_TRIP = 1.0; // any discriminative task's own CI lower > this BLOCKS pass
const STRATUM_FLOOR = 30; // per arm, discriminative stratum

// The interim rule's thresholds (§3.4). They condition ONLY on pooled levels
// and cost, never on the delta between the arms — that is what keeps the peek
// legitimate.
const INTERIM_PILOT_N = 5;
const INTERIM_CEILING = 0.98;
const INTERIM_REDUMP_FLOOR = 0.6;
const INTERIM_COST_TRIM = 0.35; // $/discriminative episode above which later phases run --n 35
const CANARY_GATE = 0.8; // a canary task-arm below 4/5 is an INFRA-grade stop

/**
 * Stamped onto every episode and compared on resume. The thresholds are the
 * verdict; an episode scored under different ones is not poolable with these,
 * and this is the field that says so out loud.
 */
const VERDICT_RULE = {
  successBound: SUCCESS_BOUND,
  wrongBound: WRONG_BOUND,
  perTaskWrongTrip: PER_TASK_WRONG_TRIP,
  stratumFloorPerArm: STRATUM_FLOOR,
};

/** Stratum lookup by task id. Unknown ids cannot survive the integrity guard. */
const stratumOf = (taskId) =>
  TASKS.find((t) => t.id === taskId)?.stratum ?? 'discriminative';
const isDiscriminative = (r) => stratumOf(r.task) === 'discriminative';
const isCanary = (r) => stratumOf(r.task) === 'canary';

/**
 * WAVE-2 PREREGISTRATION — ARCHIVED. Kept in the file, no longer printed.
 *
 * It is the record of what wave 2 committed to before its first episode, and
 * `bench/RESULTS.md` cites it, so deleting it would delete the provenance of a
 * scored cohort. Its numbers are frozen as literal text: a preregistration
 * that moves when a constant moves is not a preregistration.
 * WAVE3_PREREGISTRATION below is what this invocation prints.
 *
 * ---------------------------------------------------------------------------
 * Written before a single wave-2 episode was run, and before the fixtures it
 * describes had ever been driven by a language model.
 *
 * Wave 1 (ten tasks, N=5, 100 episodes) exited INCONCLUSIVE on G10: both arms
 * scored 50/50 on every task with zero wrong-element actions. This is the
 * design that replaces it, committed in advance so that what it licenses cannot
 * be decided after the numbers are in.
 *
 * THE POWER TRAP, STATED BEFORE THE DATA
 *
 * At 140 episodes per arm and success rates around 85%, the half-width of the
 * success-delta interval is about 8pp. The PARITY margin is -5pp. So once the
 * tasks are hard enough to leave the ceiling — which is the entire point of
 * wave 2 — **the interval cannot fit inside the parity margin at the
 * preregistered N**, no matter what the truth is. A design with only
 * PARITY/REGRESSION/INCONCLUSIVE therefore guarantees "INCONCLUSIVE, licenses
 * nothing" in advance, and spends about $32 finding that out.
 *
 * That is why the secondary outcome below exists, why its bound is -10pp (above
 * the ~8pp minimum detectable effect, so it is actually reachable), and why it
 * is written here rather than proposed in the write-up afterwards. It does NOT
 * change the verdict or the exit code: INCONCLUSIVE stays INCONCLUSIVE. It
 * adds one sentence the run is allowed to say when the bound holds.
 */
export const WAVE2_PREREGISTRATION = {
  tasks: [
    'inbox-archive', 'wizard-submit', 'leaderboard-max',
    'queue-positional', 'vault-code', 'catalog-revive', 'ledger-balance',
  ],
  n: 20, // per task, per arm — 140/arm, 280 episodes
  model: 'claude-sonnet-5',
  armsAndForcing: 'unchanged from wave 1 (ARM_DEFINITION in bench/lib/proxy.mjs)',
  guards: 'G1-G11 unchanged, G10 (ceiling) unchanged',
  primary:
    'PARITY iff success-delta CI lower >= -5pp AND wrong-element-delta CI upper <= +0.2/run',
  secondary:
    'If the verdict is INCONCLUSIVE but the success-delta CI lower bound is >= -10pp ' +
    'and the wrong-element bound holds, the licensed sentence is: "On this 7-task ' +
    'bookkeeping-hard suite with claude-sonnet-5, no diff-bookkeeping penalty larger ' +
    'than 10pp was found." Nothing stronger, and no exit code changes.',
  interimRule:
    'After the --n 5 wave, conditioning ONLY on pooled success levels and blind ' +
    'to the arm delta: both arms >= 98% -> stop and invoke the Haiku ' +
    'sensitivity contingency; re-dump arm < 70% -> the tasks are too hard or ' +
    'broken, fix them and --new-cohort; otherwise continue to N=20 and pool.',
  haikuContingency:
    'Same 7 tasks, --model claude-haiku-4-5, into its own store ' +
    '(--store bench/task/results/episodes-haiku.jsonl; required anyway, since model is ' +
    'in the episode identity). It licenses a sensitivity sentence only, never the ' +
    'headline claim, and there is no flag that pools across models.',
  estimatedCost: '280 episodes ~ $32 at wave-1 rates (the pilot wave ~ $8)',
};

/**
 * WAVE-3 PREREGISTRATION — frozen before any wave-3 episode is run, and
 * mechanically un-editable once the pilot has run: every field below is inside
 * `bench/task.mjs`, which is inside `codeVersion`, so touching it severs the
 * cohort and the integrity guard refuses to pool (exit 6). That is the point.
 *
 * The rules are tier3.md §3.4 verbatim. What is new relative to wave 2, and
 * printed with every verdict, is in `marginProvenance`.
 */
export const WAVE3_PREREGISTRATION = {
  tasks: TASKS.map((t) => `${t.id} [${t.stratum}, quota ${t.quota}]`),
  design:
    'per-task quotas, not a uniform N: 3 discriminative tasks x 45/arm = 135/arm, ' +
    '2 canaries x 5/arm. 290 episodes total. --n is a phase cap.',
  model: 'claude-sonnet-5',
  armsAndForcing: 'unchanged (ARM_DEFINITION in bench/lib/proxy.mjs)',
  guards: 'G1-G14 (G14 is the live suppressor guard; its pre-fix RED is in docs/design/g14-red-record.md)',
  strata:
    'Verdict arithmetic (success CI, wrong-el CI, G4, G7, G10, MDE, interim rule) runs over ' +
    'the DISCRIMINATIVE stratum ONLY. Apparatus guards (G3, G5, G6, G6b, G9, G11) run over ' +
    'ALL scored rows. Canaries enter no CI anywhere and license only "the apparatus and ' +
    'easy-task floor held".',
  primary:
    'PASS iff the stratum success-delta CI lower >= -10pp AND the wrong-element co-primary ' +
    'holds. REGRESSION iff CI upper < -10pp OR wrong-el CI lower > +0.40/run. Otherwise ' +
    'INCONCLUSIVE. There is no secondary: the primary IS the bounded outcome.',
  coPrimary:
    'wrong-element, stratum-pooled, bootstrap 95% CI: holds iff CI upper <= +0.40/run. ' +
    'PER-TASK TRIPWIRE: any discriminative task whose own wrong-el delta CI lower > +1.0/run ' +
    'BLOCKS PASS (INCONCLUSIVE, task named), whatever the pooled CI says.',
  floors: `G8: ${STRATUM_FLOOR}/arm stratum episodes. G10: ceiling on STRATUM rates only.`,
  interimRule:
    'After --n 5 (~50 episodes), conditioning ONLY on pooled levels and cost, never on the ' +
    'arm delta: both arms >= 98% over the discriminative stratum -> STOP, the suite failed to ' +
    'leave the ceiling; re-dump stratum < 60% -> STOP, tasks too hard or broken, fix and ' +
    '--new-cohort; mean cost per discriminative episode > $0.35 -> remaining phases run --n 35; ' +
    'any canary task-arm below 4/5 -> INFRA-grade stop; otherwise continue.',
  ceilingCheckpoint:
    'After --n 10: any DISCRIMINATIVE task at 10/10 in BOTH arms is ceilinged and excluded ' +
    'from later phases via --tasks. Its episodes STAY in the pool — no post-hoc exclusion; ' +
    'the preregistered sensitivity line is where the no-ceiling reading lives. Freed budget ' +
    'is savings, not reallocation: raising a quota mid-cohort would move codeVersion and ' +
    'sever the store, so reallocation is impossible BY CONSTRUCTION.',
  budget:
    '$65-75 estimated, $85 HARD CAP (~270 discriminative episodes at the measured $0.241/ep ' +
    'queue-class rate, plus ~$2.50 of canaries), ~4-6h wall clock, ~$11 of it the pilot. If ' +
    'the cap trips before quotas complete, stop and score the store as-is — the stop ' +
    'conditions on cost, not on the delta.',
  marginProvenance: [
    'The -10pp bound is the PRIMARY for wave 3, and it is the same number wave 2 carried as',
    'a SECONDARY. Nothing was loosened after seeing wave-3 data — there is no wave-3 data yet',
    'as this is printed, and this file cannot be edited once the pilot has run without',
    'severing the cohort.',
    'The wave-2 -5pp / "parity" vocabulary is RETIRED: unreachable at any affordable n on',
    'off-ceiling tasks, and wave 2 cleared it by 0.25pp only via a post-hoc quarantine. No',
    'wave-3 output prints the word.',
    'The +0.4/run wrong-element bound replaces the pooled +0.2/run, retired with the',
    "arithmetic in wave2-evaluation.md §4.2 (a bound set against a 7-task pool that was",
    'two-thirds ceiling is not a bound on a 3-task discriminative stratum).',
    'Power, in advance: at full quotas the stratum is 135/arm; at ~85% pooled success the CI',
    'half-width is ~8.5pp, so PASS has ~1.5pp of headroom if the true delta is ~0. At ~75% it',
    'is ~9.8pp and PASS is knife-edge. Accepted, and a thin PASS is reported as thin.',
  ],
};

function printPreregistration() {
  const p = WAVE3_PREREGISTRATION;
  const wrap = (label, text, width = 84) => {
    const words = text.split(' ');
    let line = '';
    const out = [];
    for (const w of words) {
      if ((line + ' ' + w).trim().length > width) {
        out.push(line.trim());
        line = w;
      } else line += ' ' + w;
    }
    if (line.trim()) out.push(line.trim());
    out.forEach((l, i) => console.log(`  ${(i === 0 ? label : '').padEnd(10)}${i === 0 ? ': ' : '  '}${l}`));
  };

  console.log('='.repeat(72));
  console.log('WAVE-3 PREREGISTRATION — fixed before any wave-3 episode was run');
  console.log('='.repeat(72));
  console.log('  tasks     :');
  for (const t of p.tasks) console.log(`      ${t}`);
  wrap('design', p.design);
  console.log(`  model     : ${p.model}`);
  console.log(`  arms      : ${p.armsAndForcing}`);
  console.log(`  guards    : ${p.guards}`);
  wrap('strata', p.strata);
  wrap('primary', p.primary);
  wrap('co-primary', p.coPrimary);
  console.log(`  floors    : ${p.floors}`);
  wrap('interim', p.interimRule);
  wrap('ceiling', p.ceilingCheckpoint);
  wrap('budget', p.budget);
  console.log('');
  // Printed with EVERY wave-3 verdict, whatever the outcome. A margin that
  // moved has to be visible to the reader, not buried in a design doc —
  // otherwise the only people who know the rule moved are the people who moved
  // it.
  console.log('  MARGIN PROVENANCE (printed with every wave-3 verdict, always):');
  for (const l of p.marginProvenance) console.log(`    ${l}`);
  console.log('');
}

// The pilot's measured per-episode figures, used only to estimate how long a
// phase will take before there is enough of a store to measure it from.
const PILOT_USD_PER_EPISODE = 0.0925;
const PILOT_SEC_PER_EPISODE = 20;

/** A catastrophe is worth saying out loud early. It changes NO verdict. */
const CATASTROPHE_THRESHOLD = -0.25;

const SYSTEM_PROMPT = [
  'You are operating a web browser to complete a task for a user.',
  '',
  'You have exactly three tools: browser_act, browser_snapshot and task_done.',
  'There is no filesystem, no shell and no other browser tool. The page is the',
  'only source of truth — nothing about this task can be looked up anywhere else.',
  '',
  'How to work:',
  '- Start by calling browser_snapshot to see the page.',
  '- Act on elements by their ref (the eN codes).',
  '- Read what each action reports back before choosing the next one.',
  '- When the task is genuinely complete, call task_done. Not before.',
  '',
  'Be precise. Acting on the wrong element counts against you, and so does',
  'guessing when you could look.',
].join('\n');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    // The default phase cap is the largest quota; every task still stops at
    // its own. `--n` below that runs a smaller wave of everything.
    selftest: false, n: Math.max(...WAVES), tasks: null, arms: ['diff', 'redump'],
    model: 'claude-sonnet-5', keepAlive: false, verbose: false,
    report: false, plan: false, newCohort: false, store: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') out.selftest = true;
    else if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--tasks') out.tasks = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--arms') out.arms = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--keep-alive') out.keepAlive = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--report') out.report = true;
    else if (a === '--plan') out.plan = true;
    else if (a === '--new-cohort') out.newCohort = true;
    else if (a === '--store') out.store = resolve(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
  if (out.report && out.selftest) throw new Error('--report and --selftest do nothing together');
  if (out.report && out.plan) throw new Error('--report and --plan do nothing together');
  // Scoping the report would be cherry-picking: the pooled verdict is over the
  // whole cohort or it is not the preregistered verdict. Refused rather than
  // supported-with-a-caveat, because caveats get screenshotted off.
  if (out.report && out.tasks) {
    throw new Error(
      '--report scores the whole store — that is the point of it. Drop --tasks.',
    );
  }
  if (!Number.isInteger(out.n) || out.n < 1) throw new Error(`--n must be a positive integer, got ${out.n}`);
  return out;
}

// ---------------------------------------------------------------------------
// Infrastructure the runner owns end to end
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/**
 * The fixture server, written here rather than shelled out to http-server for
 * one reason: `Cache-Control: no-store`. A cached fixture is not a hypothetical
 * hazard — the previous pass measured an edited fixture in its OLD form and
 * printed a verdict about the one on disk. The cache-buster on the URL is kept
 * as well; neither is load-bearing alone.
 */
async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = join(FIXTURE_DIR, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURE_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store, no-cache, must-revalidate',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(FIXTURE_PORT, '127.0.0.1', ok);
  });
  return { close: () => new Promise((r) => server.close(() => r())) };
}

// `startAperture`, `killTree`, `portIsOpen` and the token helpers now live in
// bench/lib/aperture.mjs — the extraction that gave the child a PERSISTENT LOG
// (tier3.md §2.1). The wave-2 wedge's root cause is undecidable because that
// output was held in a string and thrown away.

// ---------------------------------------------------------------------------
// The apparatus sampler (tier3.md §2.2)
// ---------------------------------------------------------------------------

/**
 * Pull the fields §2.2 and tier4 §3 name out of a `GET /metrics` reply, and
 * NOTHING else.
 *
 * ATOMICITY SEAM 2: Builder B serves `{pid, uptimeS, metrics: [...], witness:
 * {landed, unknown, lost}}` with the Electron `getAppMetrics()` array
 * verbatim; this reads only named fields — `metrics[].type`, `metrics[].pid`,
 * `metrics[].creationTime`, the array's length, and `witness`. Extra fields —
 * now or later, top level or per process — are tolerated by construction,
 * because nothing here enumerates the shape. Every new read is null-tolerant,
 * so wave-2 and wave-3 stores written before these fields existed stay
 * readable.
 */
export function metricsStamp(json) {
  const procs = Array.isArray(json?.metrics) ? json.metrics : null;
  if (!procs) {
    return {
      gpuPid: 'poll-failed',
      procs: 0,
      browserPid: null,
      browserCreated: null,
      witness: null,
    };
  }
  const gpu = procs.find((p) => p?.type === 'GPU');
  // The BROWSER process is the INSTANCE's identity (tier4 §3). Without it a
  // changed GPU pid is unreadable: an app restart between phases and a GPU
  // crash inside one instance look identical in the store, and only one of
  // them is the wave-2 wedge's signature.
  const browser = procs.find((p) => p?.type === 'Browser');
  return {
    gpuPid: gpu?.pid ?? null,
    procs: procs.length,
    browserPid: browser?.pid ?? null,
    browserCreated: browser?.creationTime ?? null,
    witness: json?.witness ?? null,          // §6.3; null on older builds
  };
}

/**
 * Why did the GPU pid change between two consecutive episodes?
 *  - 'restart':  browser identity ALSO changed (pid or creationTime) —
 *                a new Aperture instance; expected between phases.
 *  - 'crash':    browser identity present on both rows and IDENTICAL —
 *                the GPU process relaunched inside one instance; the
 *                wedge hypothesis's signature.
 *  - 'unmeasured': either side is 'poll-failed'.
 *  - 'unknown-instance': browser identity missing on either row
 *                (pre-tier4 store).
 */
export function classifyGpuTransition(a, b) {
  if (a?.gpuPid === 'poll-failed' || b?.gpuPid === 'poll-failed') return 'unmeasured';
  const aHas = a?.browserPid != null || a?.browserCreated != null;
  const bHas = b?.browserPid != null || b?.browserCreated != null;
  if (!aHas || !bHas) return 'unknown-instance';
  if (a.browserPid !== b.browserPid || a.browserCreated !== b.browserCreated) {
    return 'restart';
  }
  return 'crash';
}

/**
 * One localhost GET, ~ms, immediately after each pre-episode canary.
 *
 * A GPU-process crash-and-relaunch shows up as a CHANGED gpu pid between two
 * consecutive episodes, which is the leading hypothesis for the wave-2 wedge
 * and the one thing the store could not answer afterwards. Sampling failure is
 * RECORDED and never blocks an episode: the canary is the gate, this is the
 * flight recorder.
 */
export async function sampleMetrics(token, url = `http://127.0.0.1:${APERTURE_PORT}/metrics`) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// Episode machinery
// ---------------------------------------------------------------------------

const CLICK_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'slider']);
const TYPE_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * The scripted solver resolves its targets against the SHADOW MODEL, exactly
 * as bench/fidelity.mjs does — not against hardcoded refs. That is not a
 * convenience: the historical false green in this suite came from a script
 * acting on ref numbers that no longer existed. Resolving against the model
 * means a stream that fails to deliver a label update cannot even be scripted
 * through, so G2 fails loudly instead of quietly measuring nothing.
 *
 * `step.nth` (1-based) selects among several identically-labelled elements —
 * `queue-positional` needs it, because seven rows with the same button label is
 * the entire point of that fixture.
 *
 * ---------------------------------------------------------------------------
 * CONSTRAINT, and it is not a style note: `nth` counts in MODEL INSERTION
 * ORDER, which equals document order ONLY on a page that mutates by REMOVAL.
 *
 * The shadow model is a Map keyed by ref. A full snapshot inserts refs in
 * document order, and `Map#delete` on the rows that die leaves the survivors in
 * that order — so under removals-only mutation, "the 5th Approve in the model"
 * is "the 5th Approve on the page". `applyObservation`, however, applies an
 * `add` or a `replace` subtree by calling `model.set()`, which appends at the
 * END regardless of where the element actually landed in the DOM. On a page
 * that inserts or reorders rows, insertion order and document order diverge and
 * `nth` silently starts naming the wrong element.
 *
 * This is not backstopped by a runtime check, because it cannot be: the stream
 * carries no absolute positions to check against. It is backstopped by the
 * experiment instead — the witness reports which element the page actually saw
 * clicked, so a solver that targets the wrong row fails G2 loudly rather than
 * quietly measuring nothing. Any future fixture that uses `nth` must be
 * removals-only; queue.html says so in its own header comment.
 * ---------------------------------------------------------------------------
 */
function resolveLabel(model, step) {
  const roles = step.act === 'type' || step.act === 'clear' ? TYPE_ROLES : CLICK_ROLES;
  const hits = [...model.entries()].filter(([, e]) => e.label === step.label && roles.has(e.role));
  const held = () =>
    [...model.entries()].map(([r, e]) => `    ${r} ${e.role} "${e.label}"`).join('\n');
  if (step.nth) {
    if (hits.length >= step.nth) return { ref: hits[step.nth - 1][0] };
    return {
      error:
        `"${step.label}" nth:${step.nth} — the model holds only ${hits.length} of them. Model holds:\n` +
        held(),
    };
  }
  if (hits.length === 1) return { ref: hits[0][0] };
  return {
    error:
      `"${step.label}" resolves to ${hits.length} elements in the model (need exactly 1). Model holds:\n` +
      held(),
  };
}

// ---------------------------------------------------------------------------
// G6b — the apparatus wedge: predicate, stamp, and liveness canary
// ---------------------------------------------------------------------------

/**
 * Acknowledged element actions that went nowhere — BOTH signals, and their
 * eras (tier3.md §1.5, §4.2).
 *
 *   `no_page_effect`     PRE-W1 STORES: the act was acknowledged `ok`, and the
 *                        fixture's own witness never saw it. Retrospective by
 *                        construction — it can only be seen after the fact.
 *   `engine_input_loss`  W1-ERA STORES: the engine itself reported that input
 *                        was dispatched and never arrived (the §1.5 error
 *                        clause, classified in bench/lib/proxy.mjs).
 *
 * They are the same physical event — input that went nowhere — seen from two
 * sides, so counting both is what makes the G6b predicate a LIVE FORWARD GUARD
 * again rather than the retrospective one Gate 2 flagged: post-W1 a wedged act
 * announces itself in the reply, in the turn it happens.
 *
 * Scroll, hover and key are excluded from the element-action list, and that
 * exclusion is measured rather than assumed: across wave 2's 245 clean
 * episodes the number of `click`/`type`/`clear` acts attributed
 * `no_page_effect` is ZERO, while the single clean `no_page_effect` of any kind
 * is a `scroll` in `queue-positional redump run13`. Scroll, hover and key
 * legitimately produce no witness event, which is why the raw `no_page_effect`
 * RATE is the wrong predicate and this one is right. (W1 now witnesses scroll
 * and key too, but through `engine_input_loss`, which is an ENGINE report and
 * carries no such ambiguity — so the action filter stays as it is.)
 *
 * Recomputable from `acts` alone, so it applies to stores recorded before the
 * `apparatus` stamp existed — including wave 2's, where it fires on exactly the
 * six wedged episodes and on nothing else. The wave-2 store contains no
 * `engine_input_loss` string, so this extension is a no-op there; that is
 * verified by running the recompute, not by this sentence.
 */
export function deadActsFrom(acts) {
  return (acts ?? []).filter(
    (a) =>
      ['click', 'type', 'clear'].includes(a.action) &&
      (a.attribution === 'no_page_effect' || a.attribution === 'engine_input_loss'),
  ).length;
}

/**
 * G6b — apparatus-wedge quarantine. An episode whose acknowledged clicks or
 * types produced no witness event TWICE or more, or that contains a
 * walk-timeout observation, measured a wedged browser, not an arm. One dead act
 * is tolerated and counted: the known ~1-in-450 ok-click flake (wave-1
 * limitations) must not quarantine a real episode.
 *
 * Nothing in it references success, the arm, or the delta — which is what makes
 * it a predicate that could have been written blind, and the reason wave 2's
 * post-hoc application of it is defensible at all (wave2-evaluation §2).
 */
export function isWedged(r) {
  return (
    (r.apparatus?.deadActs ?? deadActsFrom(r.acts)) >= 2 || (r.apparatus?.walkTimeouts ?? 0) > 0
  );
}

/**
 * One scripted click on a fixture nothing is scored on, asked of the WITNESS.
 *
 * Spends no API budget. Costs ~2-3s, so ~12 minutes across a 280-episode run;
 * the wave-2 wedge burned $2.16 and 46 minutes producing episodes that contained
 * zero bits about the variable under test, and this bounds a recurrence to one.
 *
 * It asks the page, never Aperture. `browser_act` answering `ok` for 40 minutes
 * against a dead page is precisely the failure being guarded against, so an
 * apparatus check that believed `ok` would be checking nothing.
 */
async function livenessCanary({ proxy, collector }) {
  collector.reset();
  const ep = proxy.newEpisode({
    arm: 'diff',
    maxSteps: 4,
    allowed: ['canary'],
    taskId: '__canary',
  });
  await navigate(proxy, 'canary.html');
  if (!(await waitForLoad(collector, 5000))) {
    return { ok: false, why: 'the canary fixture never reported to the collector' };
  }
  const snap = await proxy.direct.snapshot({ mode: 'full' });
  const r = resolveLabel(ep.model, { act: 'click', label: 'Canary' });
  if (r.error) {
    return { ok: false, why: `the canary button is not in the snapshot:\n    ${r.error}`, out: snap };
  }

  const out = await proxy.direct.act({ action: 'click', ref: r.ref });
  // doAct already waited for the collector to go quiet; this second, shorter
  // wait is what makes the window the specified 2s rather than doAct's 1.5s.
  await settle(collector, 200, 500);
  const seen = collector.actions().some((e) => e.detail?.bench === 'canary');
  if (seen) return { ok: true };
  const act = ep.acts[ep.acts.length - 1];
  return {
    ok: false,
    why:
      'a scripted click on the canary button was acknowledged by Aperture and never ' +
      `reached the page (attribution: ${act?.attribution ?? 'none'})`,
    out,
  };
}

function canaryFailed(where, canary) {
  return bail(EXIT.INFRA, `LIVENESS CANARY FAILED ${where} — the apparatus is wedged:`, [
    canary.why,
    '',
    'This is NOT a statement about the arms, the tasks, or the model. The browser',
    'stopped delivering input to the page while its act path kept answering ok —',
    'the wave-2 wedge (docs/design/wave2-evaluation.md §6), whose root cause is',
    'undecidable after the fact and whose episodes contain no information about',
    'anything under test.',
    '',
    'The store is intact and every completed episode is on disk. Restart Aperture',
    'and resume; the quarantined slots re-run only under --new-cohort.',
    ...(canary.out ? ['', `last reply: ${String(canary.out).slice(0, 300)}`] : []),
  ]);
}

async function waitForLoad(collector, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (collector.loaded()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function navigate(proxy, fixture) {
  await proxy.upstream('browser_navigate', {
    action: 'goto',
    url: `${BASE}/${fixture}?benchrun=${Date.now()}`,
  });
}

/** One episode: navigate, run a driver, then judge from the witness alone. */
async function runEpisode({ proxy, collector, task, arm, driver, runIndex }) {
  collector.reset();
  const ep = proxy.newEpisode({ arm, maxSteps: task.maxSteps, allowed: task.allowed, taskId: task.id });
  await navigate(proxy, task.fixture);
  const loaded = await waitForLoad(collector);

  const t0 = Date.now();
  let driverError = null;
  let sdk = null;
  try {
    sdk = await driver(ep);
  } catch (e) {
    driverError = e instanceof Error ? e.message : String(e);
  }
  await settle(collector, 300, 4000);

  const state = collector.lastState();
  const actions = collector.actions();
  let success = false;
  try {
    success = task.success(state) === true;
  } catch {
    success = false;
  }
  const wrongElement = actions.filter((a) => !task.allowed.includes(a.detail?.bench)).length;

  const kinds = { full: 0, diff: 0, nochange: 0, other: 0, error: 0 };
  for (const o of ep.observations) kinds[o.kind]++;
  // G6b's evidence, stamped onto the episode rather than left to be recomputed:
  // how many acknowledged element actions the witness never saw, and whether the
  // walker itself timed out. See `isWedged` for what is done with them.
  const apparatus = {
    deadActs: deadActsFrom(ep.acts),
    walkTimeouts: ep.observations.filter((o) =>
      /could not read the page \(walk timed out\)/.test(o.text),
    ).length,
  };
  const attributions = {};
  for (const a of ep.acts) attributions[a.attribution] = (attributions[a.attribution] ?? 0) + 1;
  const postResync = ep.acts.filter((a) => a.tags.includes('post_resync') && a.attribution !== 'ok').length;

  return {
    task: task.id,
    arm,
    // Half of the resume key. An episode is identified by which repetition it
    // is, so a phase that asks for N=20 can tell runs 0-4 (already on record)
    // from runs 5-19 (not yet).
    runIndex,
    loaded,
    success,
    wrongElement,
    pageActions: actions.length,
    steps: ep.steps,
    capHits: ep.capHits,
    declaredDone: ep.done,
    driverError,
    kinds,
    truncatedObs: ep.observations.filter((o) => o.truncated).length,
    obsChars: ep.observations.reduce((a, o) => a + o.chars, 0),
    attributions,
    apparatus,
    // Any observation the shape predicates could not classify. An unclassified
    // observation is the hole a diff could slip through unnoticed in the
    // re-dump arm, so they are surfaced rather than bucketed and forgotten.
    unclassified: ep.observations.filter((o) => o.kind === 'other').map((o) => ({ tool: o.tool, head: o.text.slice(0, 240) })),
    // WHERE in the episode each observation happened, not just how many of
    // each kind there were. `a:` is an act-embedded observation, `s:` a
    // browser_snapshot the agent chose to spend a turn on.
    //
    // Wave 1 stored kind TOTALS only, so it could say the diff arm made 0.80
    // voluntary observations per episode and could not say whether they were
    // end-of-task verification or mid-task confusion — which is the difference
    // between "the completeness guarantee was not believed" and "the model lost
    // the page". Those want different fixes. A few bytes per episode closes it.
    obsSeq: ep.observations.map((o) => (o.tool === 'browser_act' ? 'a' : 's') + ':' + o.kind),
    postResyncFailures: postResync,
    acts: ep.acts,
    diffStream: ep.observations.filter((o) => o.kind === 'diff' || o.kind === 'nochange').map((o) => o.text).join('\n'),
    costUsd: sdk?.costUsd ?? 0,
    modelKeys: sdk?.modelKeys ?? [],
    turns: sdk?.turns ?? 0,
    sdkSubtype: sdk?.subtype ?? null,
    durationMs: Date.now() - t0,
  };
}

function scriptedDriver(proxy, task) {
  return async () => {
    await proxy.direct.snapshot({ mode: 'full' });
    for (const step of task.solve) {
      const r = resolveLabel(proxy.episode().model, step);
      if (r.error) throw new Error(`step ${step.act} "${step.label}": ${r.error}`);
      const args =
        step.act === 'type'
          ? { action: 'type', ref: r.ref, text: step.text }
          : { action: step.act, ref: r.ref };
      const out = await proxy.direct.act(args);
      if (/^error:/m.test(out)) throw new Error(`step ${step.act} "${step.label}" errored: ${out.slice(0, 200)}`);
    }
    proxy.direct.done('scripted solver');
    return null;
  };
}

const SCRATCH = join(ROOT, 'bench', '.agent-cwd');

function agentDriver(proxy, task, opts) {
  return async () => {
    if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
    // The agent's cwd is an empty directory. It has no filesystem tools, but a
    // sealed surface that also has nothing to reach is cheaper to believe.
    writeFileSync(join(SCRATCH, '.gitignore'), '*\n');

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // measured: the SDK uses Claude Code's own auth

    const q = query({
      prompt: task.prompt,
      options: {
        model: opts.model,
        systemPrompt: SYSTEM_PROMPT, // plain string = full replacement
        settingSources: [], // no CLAUDE.md, no project memory
        allowedTools: [
          'mcp__aperture__browser_act',
          'mcp__aperture__browser_snapshot',
          'mcp__aperture__task_done',
        ],
        disallowedTools: [
          'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch',
          'WebSearch', 'NotebookEdit', 'TodoWrite', 'Task',
        ],
        permissionMode: 'dontAsk',
        maxTurns: task.maxSteps + 6,
        cwd: SCRATCH,
        env,
        mcpServers: {
          aperture: {
            type: 'http',
            url: proxy.url,
            headers: { Authorization: `Bearer ${proxy.token}` },
          },
        },
      },
    });

    let result = null;
    for await (const m of q) {
      if (m.type === 'result') result = m;
    }
    return {
      costUsd: result?.total_cost_usd ?? 0,
      modelKeys: Object.keys(result?.modelUsage ?? {}),
      turns: result?.num_turns ?? 0,
      subtype: result?.subtype ?? null,
    };
  };
}

// ---------------------------------------------------------------------------
// G1 and G2 — the pre-flights. They spend no API budget.
// ---------------------------------------------------------------------------

async function guardG1({ proxy, collector, tasks }) {
  const problems = [];
  const notes = [];
  for (const task of tasks) {
    collector.reset();
    proxy.newEpisode({ arm: 'diff', maxSteps: 4, allowed: task.allowed, taskId: task.id });
    await navigate(proxy, task.fixture);
    if (!(await waitForLoad(collector))) {
      problems.push(`${task.id}: the fixture never reported to the collector — the witness is silent`);
      continue;
    }
    const state = collector.lastState();
    let passes = false;
    try {
      passes = task.success(state) === true;
    } catch (e) {
      problems.push(`${task.id}: predicate threw on the untouched page: ${e.message}`);
      continue;
    }
    if (passes) {
      problems.push(
        `${task.id}: SUCCEEDS ON AN UNTOUCHED PAGE. The predicate does not measure the task.`,
      );
    }
    // The apparatus check that belongs here rather than after the money is
    // spent: a fixture whose full snapshot is budget-cut would hand the re-dump
    // arm a truncated page and quietly bias every episode on it.
    const snap = await proxy.direct.snapshot({ mode: 'full' });
    if (/more lines beyond budget/.test(snap)) {
      problems.push(`${task.id}: the fixture's own full snapshot is budget-truncated (${task.fixture})`);
    }
    const collapse = (snap.match(/… \d+ more \w+/g) ?? []).join(', ');
    // The note reports what was measured, not what was expected. It said
    // "predicate FALSE" unconditionally until a sabotage run printed that line
    // directly above the failure saying the predicate was TRUE.
    notes.push(
      `  ${task.id.padEnd(20)} ${task.fixture.padEnd(18)} predicate ${passes ? 'TRUE  <-- BAD' : 'FALSE'}  ` +
        `snapshot ${snap.length} chars${collapse ? `  [collapsed: ${collapse}]` : ''}`,
    );
  }
  return { problems, notes };
}

/** Observations that violate re-dump arm purity. Kind `error` is
 *  excluded: a single-line `error:` reply carries no page
 *  representation and both arms can receive it identically
 *  (wave3-evaluation §1.4). `other` is INCLUDED: unclassified is
 *  where a diff would hide. */
export const redumpImpurities = (kinds) =>
  (kinds.diff ?? 0) + (kinds.nochange ?? 0) + (kinds.other ?? 0);

async function guardG2({ proxy, collector, tasks, arms, verbose = false }) {
  const problems = [];
  const notes = [];
  /** @type {Record<string, Record<string, any>>} */
  const byTask = {};
  for (const task of tasks) {
    byTask[task.id] = {};
    for (const arm of arms) {
      const r = await runEpisode({
        proxy, collector, task, arm, runIndex: 0, driver: scriptedDriver(proxy, task),
      });
      byTask[task.id][arm] = r;
      if (r.driverError) {
        problems.push(`${task.id} [${arm}]: the scripted solver could not run: ${r.driverError}`);
        continue;
      }
      if (!r.success) {
        problems.push(
          `${task.id} [${arm}]: the scripted solver did NOT satisfy the predicate. ` +
            `State: ${JSON.stringify(collector.lastState())}`,
        );
      }
      // G5 — the witness must see exactly the work that was done, no more and
      // no less. The scripted solver performs a known number of actions, so
      // this is an exact equality, not a range. It is the only check in the
      // suite that can catch the witness itself miscounting, and it has already
      // caught two: a deduplication rule that swallowed repeated clicks, and
      // debounced input events arriving after the following action.
      if (r.pageActions !== task.solve.length) {
        problems.push(
          `G5 — ${task.id} [${arm}]: the solver performed ${task.solve.length} actions but the ` +
            `witness counted ${r.pageActions}. The apparatus is miscounting, so nothing it ` +
            'reports about wrong-element actions can be believed.',
        );
      }
      if (r.wrongElement > 0) {
        problems.push(
          `${task.id} [${arm}]: the scripted solver touched ${r.wrongElement} element(s) outside ` +
            `the allowed set — the allowed set is wrong, not the solver.`,
        );
      }
      if (arm === 'diff') {
        if (!task.mustObserve.test(r.diffStream)) {
          // Printed with the stream, not just the verdict. "Your regex did not
          // match" is unactionable; the bytes the agent actually read are the
          // difference between a shrug and a diagnosis — and half the time the
          // honest fix is the regex, not the fixture.
          problems.push(
            `${task.id}: mustObserve ${task.mustObserve} does NOT match the diff-only stream. ` +
              'The information that decides this task does not arrive via a diff, so the task ' +
              'cannot distinguish the arms.\n    ---- diff-only stream ----\n' +
              r.diffStream.split('\n').map((l) => '    ' + l).join('\n').slice(0, 2500),
          );
        }
        // The companion to mustObserve, and a different question.
        //
        // mustObserve asks whether the winning CONTENT reached the agent
        // through a diff. streamAssert asks whether the engine BEHAVIOUR the
        // task claims to load actually engaged — `queue-positional` is built on
        // the walker falling through to document-order ordinals on identical
        // rows, and if it does not (a stray heading, a sibling the
        // discriminator likes, an id that stopped looking generated) the
        // fixture still solves, still matches its regex, and tests nothing.
        // That is precisely the shape of failure this project keeps hitting:
        // the unit tests and the assumption agree, and only the real output
        // disagrees.
        // Two arguments since wave 3: the stream, and the episode record.
        // `queue-resync`'s claim — that the forced restatement actually
        // engaged mid-episode — is about `obsSeq`, which is not in the bytes.
        // Single-argument asserts ignore the second and are unaffected.
        if (task.streamAssert) {
          const why = task.streamAssert(r.diffStream, r);
          if (why) {
            problems.push(
              `${task.id}: streamAssert FAILED — ${why}\n` +
                '    The task does not exercise the engine behaviour it claims to.\n' +
                '    ---- diff-only stream ----\n' +
                r.diffStream.split('\n').map((l) => '    ' + l).join('\n').slice(0, 2500),
            );
          }
        }
        if (r.kinds.diff === 0) {
          problems.push(`${task.id}: the diff arm produced no diffs at all.`);
        }
      }
      // G3 and G7, run here rather than only after the scored run. Arm purity
      // is checkable for FREE with the scripted solver, and an experiment whose
      // two arms are secretly the same arm is the single worst thing this suite
      // could print — it would come out as a confident PASS.
      if (arm === 'redump' && redumpImpurities(r.kinds) > 0) {
        problems.push(
          `G3 — ${task.id}: the re-dump arm received ${redumpImpurities(r.kinds)} ` +
            'observation(s) that were not FULL SNAPSHOTs. The arms are not what they claim to be. ' +
            'A single-line `error:` reply carries no page representation and both arms can ' +
            'receive it identically; it is recorded as kind `error` and does not bear on arm purity.',
        );
      }
      if (r.truncatedObs > 0) {
        problems.push(
          `G11 — ${task.id} [${arm}]: ${r.truncatedObs} observation(s) were cut by the token ` +
            'budget. A truncated page is not the same page, and truncation does not fall ' +
            'equally on the arms.',
        );
      }
      notes.push(
        `  ${task.id.padEnd(20)} ${arm.padEnd(7)} ${r.success ? 'SOLVED' : 'FAILED'}  ` +
          `${r.steps} steps · ${r.pageActions} page actions · ` +
          `obs ${r.kinds.full}F/${r.kinds.diff}D/${r.kinds.nochange}N · ${r.obsChars} chars`,
      );
      if (verbose) {
        const raw = collector.rawActions();
        notes.push(`      raw witness events (${raw.length}), before deduplication:`);
        for (const e of raw) {
          notes.push(
            `        +${String(e.at - raw[0].at).padStart(5)}ms ${String(e.detail?.type).padEnd(6)} ` +
              `${String(e.detail?.bench).padEnd(22)} value=${JSON.stringify(e.detail?.value ?? null)}`,
          );
        }
      }
    }

    // G7 at the task level: on identical work, the diff arm must observe fewer
    // bytes. If it does not, the labels are on the wrong arms and nothing
    // downstream of this point means anything.
    const d = byTask[task.id].diff;
    const u = byTask[task.id].redump;
    if (d && u && d.obsChars >= u.obsChars) {
      problems.push(
        `G7 — ${task.id}: identical scripted work observed ${d.obsChars} chars in the diff arm ` +
          `and ${u.obsChars} in the re-dump arm. The cheaper arm is not the diff arm.`,
      );
    }
  }
  return { problems, notes };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function summarise(rows, arm) {
  const a = rows.filter((r) => r.arm === arm);
  return {
    n: a.length,
    successes: a.filter((r) => r.success).length,
    wrong: a.map((r) => r.wrongElement),
    obsChars: a.map((r) => r.obsChars),
    cost: a.reduce((x, r) => x + r.costUsd, 0),
    rows: a,
  };
}

function tally(rows, key) {
  const out = {};
  for (const r of rows) for (const [k, v] of Object.entries(r[key])) out[k] = (out[k] ?? 0) + v;
  return out;
}

function bail(code, title, lines) {
  console.log(`\n${title}`);
  for (const l of lines) console.log(`  - ${l}`);
  console.log(`\nRESULT: ${Object.keys(EXIT).find((k) => EXIT[k] === code)} (exit ${code})`);
  return code;
}

// ---------------------------------------------------------------------------
// Phases — the plan, the resume arithmetic, and the progress advisory
// ---------------------------------------------------------------------------

const rel = (p) => {
  const r = relative(ROOT, p).replace(/\\/g, '/');
  return r.startsWith('..') ? p.replace(/\\/g, '/') : r;
};

function fmtDuration(sec) {
  if (sec < 90) return `${Math.round(sec)}s`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * What one episode costs, measured from the store once there is enough of it to
 * measure from and taken from the pilot before that. An estimate that says
 * where it came from is one a human can discount correctly.
 */
function perEpisode(rows) {
  const scored = rows.filter((r) => r.costUsd > 0 && r.durationMs > 0);
  if (scored.length < 10) {
    return { usd: PILOT_USD_PER_EPISODE, sec: PILOT_SEC_PER_EPISODE, source: 'the pilot' };
  }
  return {
    usd: scored.reduce((a, r) => a + r.costUsd, 0) / scored.length,
    sec: scored.reduce((a, r) => a + r.durationMs, 0) / scored.length / 1000,
    source: `${scored.length} episodes on record`,
  };
}

/**
 * The episode list a phase is asking for, WAVE-MAJOR: run 3 of every task
 * before run 4 of any — and QUOTA-CAPPED per task (tier3.md §3.3.1).
 *
 * The order is the whole point. A phase that dies halfway through — a laptop
 * sleeping, a rate limit, a Ctrl-C — leaves even coverage across the task set
 * rather than four finished tasks and six untouched ones, and the per-task
 * table stays comparable at every point on the way up.
 *
 * `--n` is a PHASE CAP, not a target: a task stops accruing at `task.quota`
 * however large `--n` gets, so a quota-exhausted task simply drops out of
 * later waves (the canaries stop at 5 while the discriminative tasks run to
 * 45). Resume arithmetic is UNTOUCHED by this: `episodeKey` already carries
 * runIndex and `splitByStore` works verbatim — a quota is only ever a
 * statement about which keys are asked for.
 */
export function targetsFor(tasks, arms, n) {
  const out = [];
  const cap = Math.max(...tasks.map((t) => Math.min(n, quotaOf(t))), 0);
  for (let k = 0; k < cap; k++) {
    for (const task of tasks) {
      if (k >= Math.min(n, quotaOf(task))) continue;
      for (const arm of arms) out.push({ task, arm, runIndex: k });
    }
  }
  return out;
}

/** A task with no quota field is asked for `--n` times, as before wave 3. */
const quotaOf = (task) => (Number.isInteger(task.quota) ? task.quota : Infinity);

/** What a phase at cap `n` asks for in total, both arms. */
const phaseTotal = (tasks, n, arms = 2) =>
  tasks.reduce((a, t) => a + Math.min(n, quotaOf(t)), 0) * arms;

function splitByStore(targets, storedKeys, identity) {
  const todo = [];
  const done = [];
  for (const t of targets) {
    const key = episodeKey({
      task: t.task.id,
      arm: t.arm,
      runIndex: t.runIndex,
      codeVersion: identity.codeVersion,
      model: identity.model,
    });
    (storedKeys.has(key) ? done : todo).push(t);
  }
  return { todo, done };
}

const WAVES = [1, 5, 10, 25, 45];

function printPlan({ rows, storePath, identity, opts }) {
  const est = perEpisode(rows);
  const total = QUOTA_TOTAL;

  console.log('='.repeat(72));
  console.log('SUGGESTED PHASE PLAN');
  console.log('='.repeat(72));
  console.log(
    `\nThe full preregistered suite is ${TASKS.length} tasks at their own quotas x 2 arms = ${total} episodes,\n` +
      `about ${fmtDuration((total * est.sec)).padEnd(1)} and $${(total * est.usd).toFixed(2)} at ${est.sec.toFixed(0)}s and $${est.usd.toFixed(4)} per episode (from ${est.source}).`,
  );

  console.log('\nquota table (episodes per arm; --n is a phase cap, never a target):');
  for (const t of TASKS) {
    console.log(
      `  ${t.id.padEnd(20)} ${String(t.stratum ?? 'discriminative').padEnd(15)} quota ${String(t.quota ?? '—').padStart(3)}/arm  ` +
        `${String(2 * (t.quota ?? 0)).padStart(4)} episodes`,
    );
  }
  console.log(
    `  ${'TOTAL'.padEnd(20)} ${''.padEnd(15)}             ${String(total).padStart(4)} episodes`,
  );

  console.log('\nSplit it by N in waves, not by task:');
  console.log(`  A partial run across ALL ${TASKS.length} tasks is far more informative than a complete`);
  console.log(`  run of two. ${TASKS.length} tasks at N=5 already shows you which tasks separate the arms`);
  console.log('  and whether the whole thing is heading for the G10 ceiling; two tasks at N=45');
  console.log('  tells you a great deal about two tasks. The runner iterates wave-major for');
  console.log('  the same reason, so an interrupted phase also leaves even coverage.');
  console.log('  Quota-exhausted tasks simply drop out of the later waves.');

  const row = (phase, cmd, add, cum, sec, usd) =>
    console.log(
      `  ${phase.padEnd(7)} ${cmd.padEnd(38)} ${String(add).padStart(5)} ${String(cum).padStart(6)} ` +
        `${fmtDuration(sec).padStart(8)} ${('$' + usd.toFixed(2)).padStart(8)}`,
    );
  console.log('');
  console.log(`  ${'phase'.padEnd(7)} ${'command'.padEnd(38)} ${'new'.padStart(5)} ${'total'.padStart(6)} ${'time'.padStart(8)} ${'cost'.padStart(8)}`);
  console.log('  ' + '-'.repeat(76));
  let prev = 0;
  WAVES.forEach((n, i) => {
    const cum = phaseTotal(TASKS, n);
    const add = cum - prev;
    prev = cum;
    row(String(i + 1), `npm run bench:task -- --n ${n}`, add, cum, add * est.sec, add * est.usd);
  });
  row('final', 'npm run bench:task -- --report', 0, prev, 0, 0);

  console.log('\nEach phase is idempotent: it runs only what the store is missing, so re-running');
  console.log('one costs nothing, and an interrupted one resumes exactly where it stopped.');
  console.log('The verdict is computed over the whole accumulated store every time — the');
  console.log('phases are how the episodes are gathered, not how they are scored.');

  console.log('\nBefore any of it, and it spends nothing:');
  console.log('  npm run bench:task -- --selftest');
  console.log('\nIf the engine, a fixture, a prompt or the arm rule changes part-way through,');
  console.log('the next phase will refuse to pool (exit 6) rather than average two systems.');
  console.log('Starting over after a deliberate change:');
  console.log('  npm run bench:task -- --new-cohort --n 1');

  console.log(`\nStore: ${rel(storePath)}`);
  if (!rows.length) {
    console.log('  empty — nothing has been run yet.');
  } else {
    const matching = rows.filter(
      (r) => r.codeVersion === identity.codeVersion && r.model === identity.model,
    ).length;
    console.log(`  ${rows.length} episode(s) on record, ${matching} of them under the current codeVersion.`);
    const present = new Set(rows.map((r) => r.task));
    const perTaskArm = {};
    for (const r of rows) perTaskArm[`${r.task}|${r.arm}`] = (perTaskArm[`${r.task}|${r.arm}`] ?? 0) + 1;
    const haveFor = (t) =>
      Math.min(perTaskArm[`${t.id}|diff`] ?? 0, perTaskArm[`${t.id}|redump`] ?? 0);
    const minRuns = Math.min(...TASKS.map(haveFor));
    console.log(`  ${present.size}/${TASKS.length} tasks touched; every task has at least ${minRuns} run(s) in both arms.`);
    // Quota-aware: a task sitting at its own quota does not hold a wave open,
    // which is the whole reason the canaries cost 5 and not 45.
    const nextWave = WAVES.find((n) => TASKS.some((t) => haveFor(t) < Math.min(n, quotaOf(t))));
    if (nextWave) console.log(`  Next suggested phase: npm run bench:task -- --n ${nextWave}`);
    else console.log('  The preregistered sample is complete. Next: npm run bench:task -- --report');
  }
  if (opts.tasks) {
    console.log(`\n(--tasks was given; the plan above is for the full suite regardless, because a`);
    console.log(' verdict over a subset is not the preregistered verdict.)');
  }
  return 0;
}

/**
 * The smallest per-arm sample at which the success interval would clear the
 * -10pp bound, IF the observed rates held. Advice about how much further there
 * is to go, not a stopping rule.
 *
 * Returns null for "not inside the cap", which is NOT the same as "never" — a
 * true delta of −9.0pp against a −10.0pp bound needs an interval half-width
 * under 1pp and so needs thousands of episodes per arm. Reporting that as
 * "impossible" would be a different claim from the true one, so the caller
 * distinguishes the two.
 */
const BOUND_SEARCH_CAP = 5000;

function boundReachableAt(pd, pu, cap = BOUND_SEARCH_CAP) {
  for (let n = 5; n <= cap; n += 5) {
    if (propDiffCI(Math.round(pd * n), n, Math.round(pu * n), n).lo >= SUCCESS_BOUND) return n;
  }
  return null;
}

/**
 * Printed after every phase. Two jobs: say where the sample is, and say plainly
 * what it can and cannot support yet — because "5/5 in both arms" reads like a
 * result to everyone who has not thought about the interval.
 *
 * It is ADVISORY. It computes nothing the verdict uses and changes no
 * threshold. The PASS/REGRESSION/INCONCLUSIVE rule below runs exactly as it
 * did before this block existed.
 */
function progressAdvisory(allRows, phaseRows, opts) {
  // Everything below the coverage table is about the DISCRIMINATIVE stratum,
  // because that is what the verdict is computed over. Pooling the canaries in
  // here would reproduce, in the advisory, exactly the dilution the strata
  // exist to prevent — and the advisory is what a human reads mid-wave.
  const stratumRows = allRows.filter(isDiscriminative);
  const canaryRows = allRows.filter(isCanary);
  const diff = summarise(stratumRows, 'diff');
  const redump = summarise(stratumRows, 'redump');
  const present = [...new Set(stratumRows.map((r) => r.task))];
  const stratumTasks = TASKS.filter((t) => t.stratum !== 'canary');

  console.log('\n' + '='.repeat(72));
  console.log('PROGRESS — advisory. Nothing in this block changes the verdict rule.');
  console.log('='.repeat(72));

  if (phaseRows && phaseRows.length) {
    const pd = summarise(phaseRows, 'diff');
    const pu = summarise(phaseRows, 'redump');
    console.log(
      `\nthis phase : ${phaseRows.length} episode(s) · diff ${pd.successes}/${pd.n} · ` +
        `re-dump ${pu.successes}/${pu.n} · $${(pd.cost + pu.cost).toFixed(4)}`,
    );
  }

  const line = (name, s) =>
    `  ${name.padEnd(8)} ${String(s.successes).padStart(4)}/${String(s.n).padEnd(5)} success ${fmtPct(s.n ? s.successes / s.n : 0).padStart(6)}   ` +
    `${mean(s.wrong).toFixed(3)} wrong-el/run   $${s.cost.toFixed(2)}`;
  console.log('\non record, DISCRIMINATIVE stratum, pooled across every phase:');
  console.log(line('diff', diff));
  console.log(line('re-dump', redump));
  console.log(
    `  ${present.length}/${stratumTasks.length} discriminative tasks touched · ` +
      `${(diff.n / Math.max(1, present.length)).toFixed(1)} runs per task per arm`,
  );
  if (canaryRows.length) {
    const cd = summarise(canaryRows, 'diff');
    const cu = summarise(canaryRows, 'redump');
    console.log(
      `  canaries (in NO interval, ever): diff ${cd.successes}/${cd.n} · re-dump ${cu.successes}/${cu.n}`,
    );
  }

  console.log("\ncoverage (runs on record, diff / re-dump, against each task's OWN quota):");
  for (const t of TASKS) {
    const d = allRows.filter((r) => r.task === t.id && r.arm === 'diff').length;
    const u = allRows.filter((r) => r.task === t.id && r.arm === 'redump').length;
    const q = Number.isFinite(quotaOf(t)) ? quotaOf(t) : Math.max(d, u, 1);
    const width = Math.min(q, 45);
    const filled = Math.round((Math.min(q, Math.min(d, u)) / q) * width);
    const bar = '#'.repeat(filled).padEnd(width, '.');
    console.log(
      `  ${t.id.padEnd(20)} ${(t.stratum ?? '').padEnd(15)} ${String(d).padStart(3)} / ${String(u).padEnd(3)} of ${String(q).padEnd(3)} ${bar}`,
    );
  }

  const sD = wilson(diff.successes, diff.n);
  const sU = wilson(redump.successes, redump.n);
  const perTask = diff.n / Math.max(1, present.length);

  console.log('\nCan this sample support a verdict yet?');
  if (diff.n < STRATUM_FLOOR || redump.n < STRATUM_FLOOR) {
    console.log(
      `  No. ${diff.n}/${redump.n} stratum episodes per arm is below the floor of ${STRATUM_FLOOR} (G8). This`,
    );
    console.log('  exercises the loop; it is not a measurement, and the run will exit INCONCLUSIVE.');
  } else {
    const mde = smallestDetectableDrop(diff.n, redump.n, sU.p, SUCCESS_BOUND);
    console.log(
      `  At ${diff.n}/${redump.n} stratum episodes per arm — about N=${perTask.toFixed(1)}/task/arm over ${present.length}/${stratumTasks.length}`,
    );
    console.log(
      `  discriminative tasks — and an observed re-dump rate of ${fmtPct(sU.p)}, the smallest true drop`,
    );
    console.log(
      `  this sample can distinguish from the ${fmtSigned(SUCCESS_BOUND)} bound is about ${fmtPct(mde)}. Anything smaller`,
    );
    console.log('  than that is inside the noise, however clean the percentages look.');
    const need = boundReachableAt(sD.p, sU.p);
    const gap = sD.p - sU.p;
    if (gap <= SUCCESS_BOUND) {
      console.log(
        `  The observed delta itself, ${fmtSigned(gap)}, is already at or past the ${fmtSigned(SUCCESS_BOUND)} bound. At`,
      );
      console.log('  these rates no sample size produces a PASS; more episodes buy precision about');
      console.log('  a gap, not a pass.');
    } else if (need === null) {
      console.log(
        `  The observed gap of ${fmtSigned(gap)} sits close enough to the ${fmtSigned(SUCCESS_BOUND)} bound that the interval`,
      );
      console.log(
        `  would not fit inside it within ${BOUND_SEARCH_CAP} episodes per arm at these rates. A PASS`,
      );
      console.log('  here is not a matter of finishing the planned phases.');
    } else if (need > diff.n) {
      console.log(
        `  If these rates hold, the success interval would clear the bound at about ${need}`,
      );
      console.log(`  episodes per arm. You have ${diff.n}.`);
    } else {
      console.log('  The success interval already clears the bound at this sample size.');
    }
  }
  console.log(
    `  The preregistered design is per-task quotas: ${stratumTasks.map((t) => `${t.id} ${t.quota}`).join(', ')} ` +
      `= ${stratumTasks.reduce((a, t) => a + t.quota, 0)} stratum episodes per arm (plus canaries at 5).`,
  );

  // Early stopping, stated as advice and nothing else. If the diff arm has
  // already fallen off a cliff, six more hours buys a tighter interval around a
  // disaster that is already unambiguous.
  if (diff.n >= STRATUM_FLOOR && redump.n >= STRATUM_FLOOR) {
    const sCI = propDiffCI(diff.successes, diff.n, redump.successes, redump.n);
    if (sCI.hi < CATASTROPHE_THRESHOLD) {
      console.log('\n' + '!'.repeat(72));
      console.log('! CATASTROPHIC REGRESSION IS ALREADY UNAMBIGUOUS AT THIS SAMPLE SIZE.');
      console.log('!'.repeat(72));
      console.log(
        `  success delta ${fmtSigned(sCI.delta)}, 95% CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}] — the ENTIRE interval is`,
      );
      console.log(
        `  below ${fmtSigned(CATASTROPHE_THRESHOLD)}. More episodes will tighten that interval, not move it.`,
      );
      console.log('  Finishing the remaining phases would spend hours and dollars confirming a');
      console.log('  result you already have. Stopping here is a legitimate choice.');
      console.log('');
      console.log('  This is ADVICE ONLY. The verdict printed below is still computed by the');
      console.log('  preregistered rule over whatever is on record, unchanged.');
    }
  }
}

function bailIntegrity(integrity, storePath) {
  console.log('\n' + '='.repeat(72));
  console.log('INTEGRITY GUARD — REFUSING TO POOL THESE EPISODES');
  console.log('='.repeat(72));
  console.log('\nThe store holds episodes produced under a different experiment from the one');
  console.log('this invocation describes. Pooling them would average two systems into a single');
  console.log('number with a tight interval that looks exactly like a result and is not one.');
  for (const b of integrity.blocks) {
    console.log(`\n  ${b.title}`);
    for (const l of b.lines) console.log(l);
  }
  console.log('\nNothing has been run, nothing has been changed, and nothing has been discarded.');
  console.log('\nWhat to do, in order of preference:');
  console.log('  1. Put the code back the way it was and run again.');
  console.log(`     ${rel(cohortPathFor(storePath))}`);
  console.log('     records the exact file table the episodes on record were produced from.');
  console.log('  2. If the change is meant to stand, start a fresh cohort:');
  console.log('       npm run bench:task -- --new-cohort --n <N>');
  console.log(`     which renames ${rel(storePath)} with a timestamp — the old`);
  console.log('     episodes are kept, they just stop being pooled with the new ones.');
  console.log('\nThere is deliberately no flag that pools them anyway.');
  // And the sentence that stops "severed" from reading as "faulted"
  // (harness-debt.md WO-B5). Every scored cohort in this programme is closed and
  // severed at every post-programme tree, which means this refusal is the NORMAL
  // state of a finished experiment, not a symptom of one. Without this line a
  // reader meets a wall of red about a store that is perfectly sound.
  console.log('\nA refused store is not a faulted store. If its cohort is closed and adjudicated');
  console.log('(wave2/wave3-evaluation.md), the adjudication is its verdict of record; this refusal');
  console.log('only says the CURRENT tree cannot re-score it.');
  console.log(`\nRESULT: INTEGRITY (exit ${EXIT.INTEGRITY})`);
  return EXIT.INTEGRITY;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasks = opts.tasks ? opts.tasks.map(taskById) : TASKS;
  const storePath = opts.store ?? defaultStorePath(ROOT);

  // Computed before anything is started, because it is what decides whether
  // this invocation may touch the store at all.
  const identity = buildIdentity({
    root: ROOT,
    model: opts.model,
    systemPrompt: SYSTEM_PROMPT,
    tasks: TASKS,
    verdictRule: VERDICT_RULE,
  });

  const mode = opts.plan
    ? 'PLAN (prints the phase plan, starts nothing)'
    : opts.report
      ? 'REPORT ONLY (scores the store, runs no episodes)'
      : opts.selftest
        ? 'SELFTEST (G1+G2 only, no API budget)'
        : `scored, target N=${opts.n}/task/arm, arms=${opts.arms.join('+')}`;

  console.log('# Task-success benchmark — diffs vs full re-dumps\n');
  console.log(`tasks   : ${tasks.length} (${tasks.map((t) => t.id).join(', ')})`);
  console.log(`fixtures: ${FIXTURES.length}`);
  console.log(`mode    : ${mode}`);
  console.log(`model   : ${opts.model}`);
  console.log(`prompt  : sha256 ${createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 16)}`);
  console.log('\nidentity — stamped on every stored episode; a mismatch refuses to pool:');
  console.log(`  suiteVersion : ${identity.suiteVersion}`);
  console.log(`  codeVersion  : ${identity.codeVersion}   (content hash over ${identity.files.length} files: src/core/snapshot, src/mcp, src/preload, fixtures, bench libs)`);
  console.log(`  buildVersion : ${identity.buildVersion}   (out/main, out/preload — the code that actually runs)`);
  console.log(
    `  git          : ${identity.gitSha ?? 'not a git tree'} · watched files ${identity.dirtyWatched ? 'DIRTY (uncommitted edits)' : 'clean'} · tree ${identity.treeDirty ? 'dirty' : 'clean'}`,
  );
  console.log(`  verdictRule  : ${JSON.stringify(identity.verdictRule)}`);
  console.log('');

  // Printed on every invocation that could produce or score a number. The
  // selftest is exempt because it scores nothing and is run mid-edit, when
  // reprinting the frozen design would suggest it had been re-examined.
  if (!opts.selftest) printPreregistration();

  if (opts.plan) {
    const { rows } = loadStore(storePath);
    return printPlan({ rows, storePath, identity, opts });
  }

  // ---- the store, and the guard over it ---------------------------------
  if (opts.newCohort) {
    const moved = archiveStore(storePath);
    if (moved.length) {
      console.log('--new-cohort: the previous cohort has been ARCHIVED, not deleted —');
      for (const m of moved) console.log(`  ${rel(m)}`);
    } else {
      console.log('--new-cohort: there was no existing store to archive.');
    }
    console.log('');
  }

  const { rows: stored, malformed } = loadStore(storePath);
  const cohort = loadCohort(storePath);
  console.log(`store   : ${rel(storePath)} — ${stored.length} episode(s) on record`);

  if (opts.selftest) {
    // Deliberately exempt: the selftest scores nothing, writes nothing, and has
    // to stay usable precisely when the engine is mid-edit — which is exactly
    // when the integrity guard would be firing.
    console.log('          (--selftest neither reads nor writes the store, so the integrity');
    console.log('           guard is not applied to it)');
  } else {
    const integrity = checkIntegrity({
      rows: stored,
      malformed,
      cohort,
      identity,
      armDefinitions: ARM_DEFINITION,
    });
    if (!integrity.ok) return bailIntegrity(integrity, storePath);
    if (stored.length) {
      console.log('          integrity OK — every episode on record was produced by THIS experiment');
    }
  }
  console.log('');

  // ---- report only: no ports, no Aperture, no budget ---------------------
  if (opts.report) {
    if (!stored.length) {
      return bail(EXIT.INCONCLUSIVE, 'THE STORE IS EMPTY — there is nothing to report.', [
        `No episodes at ${rel(storePath)}.`,
        'Run a phase first: npm run bench:task -- --n 1',
      ]);
    }
    const present = TASKS.filter((t) => stored.some((r) => r.task === t.id));
    progressAdvisory(stored, null, opts);
    return report(stored, opts, present);
  }

  // ---- what this phase is actually going to run --------------------------
  const targets = targetsFor(tasks, opts.arms, opts.n);
  const storedKeys = new Set(stored.map(episodeKey));
  const { todo, done } = splitByStore(targets, storedKeys, identity);

  if (!opts.selftest) {
    const est = perEpisode(stored);
    const capped = tasks.filter((t) => quotaOf(t) < opts.n).map((t) => `${t.id} at ${t.quota}`);
    console.log(
      `this phase asks for ${targets.length} episode(s) — ${tasks.length} task(s) x ${opts.arms.length} arm(s), ` +
        `phase cap N=${opts.n}, each task capped at its own quota` +
        (capped.length ? `
  quota-capped below the phase cap: ${capped.join(', ')}` : ''),
    );
    console.log(`  already on record, SKIPPING : ${done.length}`);
    console.log(
      `  to run now                  : ${todo.length}` +
        (todo.length
          ? `   (est. ${fmtDuration(todo.length * est.sec)}, $${(todo.length * est.usd).toFixed(2)} — from ${est.source})`
          : ''),
    );
    if (todo.length) {
      const byTask = {};
      for (const t of todo) byTask[t.task.id] = (byTask[t.task.id] ?? 0) + 1;
      console.log('  per task (to run / already on record, both arms):');
      for (const t of tasks) {
        const have = done.filter((d) => d.task.id === t.id).length;
        console.log(`    ${t.id.padEnd(20)} ${String(byTask[t.id] ?? 0).padStart(4)} to run · ${String(have).padStart(4)} on record`);
      }
      console.log(`  order: wave-major — run k of every task before run k+1 of any.`);
    }
    console.log('');

    if (todo.length === 0) {
      console.log('NOTHING TO RUN. Every combination this phase asks for is already on record.');
      console.log('Aperture was not started; no API budget was spent.');
      const present = TASKS.filter((t) => stored.some((r) => r.task === t.id));
      progressAdvisory(stored, [], opts);
      return report(stored, opts, present);
    }
  }

  if (await portIsOpen(APERTURE_PORT)) {
    return bail(EXIT.INFRA, 'PORT 8817 IS ALREADY IN USE.', [
      'Another Aperture is running. This bench starts and owns its own instance,',
      'and one scenario per freshly started Aperture is the rule here.',
      'Run: taskkill //F //IM electron.exe   then try again.',
    ]);
  }
  if (await portIsOpen(FIXTURE_PORT)) {
    return bail(EXIT.INFRA, 'PORT 8899 IS ALREADY IN USE.', ['Another fixture server is running.']);
  }

  const collector = await startCollector(COLLECTOR_PORT);
  const fixtures = await startFixtureServer();
  let aperture = null;
  let proxy = null;
  let code = EXIT.INFRA;

  try {
    console.log('starting Aperture…');
    // One stamp for this run's two artifacts: the child log and the apparatus
    // samples. Same timestamp, so nobody has to correlate them by mtime.
    const stamp = runStamp();
    aperture = await startAperture({ root: ROOT, stamp });
    console.log(`Aperture up on ${APERTURE_PORT}\n`);
    proxy = await startProxy({
      apertureUrl: `http://127.0.0.1:${APERTURE_PORT}/mcp`,
      apertureToken: aperture.token,
      collector,
      port: PROXY_PORT,
    });

    // The exact bytes of the three tool descriptions the agent is shown. Two of
    // them are written in the proxy (covered by codeVersion), but
    // browser_snapshot's is FORWARDED VERBATIM from the running Aperture — so
    // it can change without a single watched file changing, and it carries the
    // snapshot format legend the whole experiment runs on. Checked here, which
    // is the first moment it can be known and still before any budget is spent.
    const toolsHash = createHash('sha256')
      .update(proxy.toolSurfaceFingerprint())
      .digest('hex')
      .slice(0, 16);
    console.log(`tool surface: sha256 ${toolsHash}\n`);
    if (!opts.selftest) {
      const live = checkIntegrity({
        rows: stored,
        malformed: [],
        cohort,
        identity,
        armDefinitions: ARM_DEFINITION,
        toolsHash,
      });
      if (!live.ok) return (code = bailIntegrity(live, storePath));
    }

    // ---- G1 -------------------------------------------------------------
    console.log('G1 null-agent — every predicate must be FALSE on an untouched page');
    const g1 = await guardG1({ proxy, collector, tasks });
    for (const n of g1.notes) console.log(n);
    if (g1.problems.length) {
      return (code = bail(EXIT.SELFTEST, 'G1 FAILED — a task can succeed by accident:', g1.problems));
    }
    console.log('G1 PASS\n');

    // ---- G2 -------------------------------------------------------------
    console.log('G2 scripted solver — must pass in BOTH arms, and each task\'s winning');
    console.log('   information must be shown to arrive through a diff');
    const g2 = await guardG2({ proxy, collector, tasks, arms: ['diff', 'redump'], verbose: opts.verbose });
    for (const n of g2.notes) console.log(n);
    if (g2.problems.length) {
      return (code = bail(EXIT.SELFTEST, 'G2 FAILED:', g2.problems));
    }
    console.log('G2 PASS\n');

    // ---- G6b liveness canary, once before anything is scored ---------------
    //
    // Run in the selftest too, deliberately. A guard whose first execution is
    // during a $40 wave is a guard nobody has tested; `--selftest` is where the
    // apparatus proves it can see itself.
    console.log('G6b canary — an acknowledged click must reach the page');
    const preflight = await livenessCanary({ proxy, collector });
    if (!preflight.ok) return (code = canaryFailed('before the first episode', preflight));
    console.log('G6b canary PASS\n');

    if (opts.selftest) {
      console.log('SELFTEST PASS — G1, G2 and the liveness canary green, no API budget spent.');
      return (code = EXIT.PASS);
    }

    // ---- scored run -----------------------------------------------------
    //
    // Each episode is appended to the store the moment it finishes, before the
    // next one starts. A phase that dies at episode 197 has 196 episodes on
    // disk and resumes from 197; buffering to the end would throw away hours to
    // a laptop going to sleep.
    const cohortFile = writeCohort(storePath, identity, {
      toolsHash,
      armDefinitions: ARM_DEFINITION,
    });
    const apparatusPath = join(ROOT, 'bench', 'task', 'results', `apparatus.${stamp}.jsonl`);
    console.log(`cohort   : ${rel(cohortFile)}`);
    console.log(`writing  : ${rel(storePath)}  (one line per episode, as it completes)`);
    console.log(`apparatus: ${rel(apparatusPath)}  (one /metrics sample per episode)\n`);

    const phaseRows = [];
    let i = 0;
    for (const t of todo) {
      i++;
      // Before EVERY episode. The wedge's onset was abrupt and mid-episode, and
      // the episode it began in is unrecoverable either way; what the canary
      // buys is that the NEXT one is never run, and that onset is timestamped to
      // within one episode instead of being reconstructed from a store months
      // later.
      const pre = await livenessCanary({ proxy, collector });
      if (!pre.ok) return (code = canaryFailed(`before episode ${i}/${todo.length}`, pre));

      // Immediately after the canary, one localhost GET (§2.2). Cheap and
      // always-on. NEVER a gate: the canary is the gate, and a sampler that
      // could stop an episode would be a new way for the apparatus to fail.
      const sample = await sampleMetrics(aperture.token);
      // One definition of the stamp's shape, poll-failed included:
      // `metricsStamp(null)` IS the poll-failed row (tier4 §3.1).
      const stampFields = metricsStamp(sample.ok ? sample.json : null);
      try {
        appendFileSync(
          apparatusPath,
          JSON.stringify({
            at: new Date().toISOString(),
            task: t.task.id,
            arm: t.arm,
            runIndex: t.runIndex,
            ...(sample.ok ? { sample: sample.json } : { error: sample.error }),
          }) + '\n',
          'utf8',
        );
      } catch (e) {
        console.log(`      (apparatus sample not written: ${e.message})`);
      }

      const r = await runEpisode({
        proxy, collector, task: t.task, arm: t.arm, runIndex: t.runIndex,
        driver: agentDriver(proxy, t.task, opts),
      });
      // The sampler's two fields ride on the episode row beside G6b's, so a
      // GPU-process relaunch is visible in the store itself and not only in a
      // sidecar nobody opens.
      r.apparatus = { ...r.apparatus, ...stampFields };
      // Quarantine is stamped at write time so the store carries the ruling, and
      // recomputed at report time so stores written before G6b existed are held
      // to the same rule. The slot stays occupied: a quarantined episode is not
      // a missing one, and it re-runs only under --new-cohort.
      if (isWedged(r)) r.quarantined = 'apparatus_wedge';
      const row = stampEpisode(r, identity, ARM_DEFINITION, toolsHash);
      appendEpisode(storePath, row);
      phaseRows.push(row);
      stored.push(row);
      console.log(
        `[${String(i).padStart(3)}/${todo.length}] run${String(t.runIndex).padStart(3)} ${t.task.id.padEnd(20)} ${t.arm.padEnd(7)} ` +
          `${r.quarantined ? 'WEDGED' : r.success ? 'PASS' : 'fail'}  wrong=${r.wrongElement} steps=${r.steps} ` +
          `obs=${r.kinds.full}F/${r.kinds.diff}D/${r.kinds.nochange}N/${r.kinds.other}?/${r.kinds.error}E · ${r.obsChars}ch · $${r.costUsd.toFixed(4)} · ${(r.durationMs / 1000).toFixed(0)}s` +
          (r.driverError ? `  ERROR: ${r.driverError.slice(0, 80)}` : ''),
      );

      // The other half of the specification: any dead act or walk timeout at all
      // — one, below the quarantine threshold — is enough to ask the question
      // immediately rather than at the top of the next episode.
      if ((r.apparatus?.deadActs ?? 0) >= 1 || (r.apparatus?.walkTimeouts ?? 0) >= 1) {
        console.log(
          `      apparatus signal: ${r.apparatus.deadActs} dead act(s), ` +
            `${r.apparatus.walkTimeouts} walk timeout(s) — checking liveness`,
        );
        const post = await livenessCanary({ proxy, collector });
        if (!post.ok) return (code = canaryFailed(`after episode ${i}/${todo.length}`, post));
      }
    }

    console.log(
      `\nPHASE COMPLETE — ${phaseRows.length} episode(s) run, ${stored.length} on record at ${rel(storePath)}`,
    );

    // The verdict is over the WHOLE store, not over this phase. Scoring one
    // phase at a time is the exact failure this feature exists to remove: five
    // underpowered verdicts instead of one properly-powered one.
    const present = TASKS.filter((t) => stored.some((r) => r.task === t.id));
    progressAdvisory(stored, phaseRows, opts);
    code = report(stored, opts, present);
    return code;
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    await fixtures.close().catch(() => {});
    await collector.close().catch(() => {});
    if (aperture && !opts.keepAlive) await killTree(aperture.child);
  }
}


/**
 * The stratified report (tier3.md §3.3.3).
 *
 * Order is the design, not presentation:
 *   1. G6b QUARANTINE — applied before anything is computed from anything, and
 *      PRESERVED VERBATIM from the wave-2 code (table, per-arm counts,
 *      symmetry guard, disclosure sentence). §3.6 names it as an acceptance
 *      item: the rewrite must not quietly drop the guard that saved wave 2.
 *   2. The apparatus note — GPU pid transitions, advisory (§2.2).
 *   3. Per-task table, every scored task, stratum marked.
 *   4. APPARATUS GUARDS over ALL scored rows: G3, G5, G6, G6b, G9, G11. A
 *      wedge or an arm leak in a canary episode is still a wedge.
 *   5. The CANARY table and gate. They enter no interval anywhere.
 *   6. VERDICT ARITHMETIC over the DISCRIMINATIVE STRATUM ONLY: success CI,
 *      wrong-el CI, G4, G7, G10, MDE, the interim rule. Wave 2 pooled 210
 *      ceilinged episodes with 35 informative ones and diluted its only
 *      signal; that is why this partition exists, and this report says so.
 *
 * Exported so the §3.6 acceptance unit can feed it a synthetic row set and
 * assert that the quarantine table and the symmetry guard still fire.
 */
export function report(allRows, opts, tasks) {
  // G6b — the quarantine, applied before anything is computed from anything.
  //
  // A wedged episode is an ABSENT measurement, not an unfavourable one: no
  // action reached the page, so it contains zero bits about the variable under
  // test and averaging it into an arm is noise injection, not conservatism. It
  // is excluded from every guard and from the verdict arithmetic, and it is
  // reported in its own table rather than deleted.
  const quarantined = allRows.filter(isWedged);
  const rows = allRows.filter((r) => !isWedged(r));

  // THE STRATA. Everything the verdict is made of comes from `stratumRows`.
  const stratumRows = rows.filter(isDiscriminative);
  const canaryRows = rows.filter(isCanary);
  const diff = summarise(stratumRows, 'diff');
  const redump = summarise(stratumRows, 'redump');
  const stratumTasks = tasks.filter((t) => t.stratum !== 'canary');

  console.log('\n' + '='.repeat(72));
  console.log('RESULTS');
  console.log('='.repeat(72));
  console.log(
    `pooled over ${rows.length} episode(s) on record — every phase of this cohort, not just\n` +
      'the most recent one. The verdict rule below is the preregistered one, unchanged.',
  );
  console.log(
    `\nSTRATA — the verdict is computed over the DISCRIMINATIVE stratum ONLY\n` +
      `  discriminative : ${stratumRows.length} episode(s) over ${stratumTasks.length} task(s) — the verdict\n` +
      `  canary         : ${canaryRows.length} episode(s) over ${tasks.length - stratumTasks.length} task(s) — apparatus health, in NO interval\n` +
      '  Wave 2 pooled 35 informative episodes with 210 ceilinged ones and diluted the only\n' +
      '  signal it had (wave2-evaluation.md §4.2). This partition is the fix, and it is\n' +
      '  preregistered rather than applied after seeing which way the numbers went.',
  );

  const qByArm = { diff: 0, redump: 0 };
  if (quarantined.length) {
    for (const r of quarantined) qByArm[r.arm] = (qByArm[r.arm] ?? 0) + 1;
    console.log(
      `\nG6b QUARANTINE — ${quarantined.length} episode(s) excluded as apparatus failures ` +
        `(diff ${qByArm.diff}, re-dump ${qByArm.redump}) out of ${allRows.length} on record.`,
    );
    console.log(
      '  Predicate: two or more acknowledged click/type/clear actions produced no witness\n' +
        '  event OR were reported by the engine as input loss, or the walker timed out. Such\n' +
        '  an episode measured a wedged browser, not an arm. The episodes are kept, their\n' +
        '  slots stay occupied, and they re-run only under --new-cohort.',
    );
    for (const r of quarantined.slice(0, 12)) {
      const dead = r.apparatus?.deadActs ?? deadActsFrom(r.acts);
      console.log(
        `    ${r.task.padEnd(20)} ${r.arm.padEnd(7)} run${String(r.runIndex).padStart(3)}  ` +
          `dead acts ${String(dead).padStart(2)}  walk timeouts ${r.apparatus?.walkTimeouts ?? '?'}  ` +
          `pageActions ${r.pageActions}  ${Math.round((r.durationMs ?? 0) / 1000)}s`,
      );
    }
    if (quarantined.length > 12) console.log(`    … and ${quarantined.length - 12} more`);
    console.log(
      '\n  Any citation of this run must disclose the quarantine, its per-arm counts, and\n' +
        '  the fact that a rule which removes episodes can move a verdict class.',
    );
  }

  // ---- the apparatus note (§2.2) — advisory, no verdict effect ------------
  //
  // A GPU pid that CHANGES between consecutive episodes is a GPU process that
  // crashed and relaunched, which is the leading hypothesis for the wave-2
  // wedge and the one question that store could not answer. Printed here, next
  // to the quarantine, because that is where a reader is already asking "what
  // was the browser doing".
  printApparatusNote(allRows);
  // Immediately after the apparatus note, for the same reason: the witness's
  // own health belongs beside the apparatus questions, not among the results
  // (tier4 §6.3).
  printWitnessSummary(allRows);

  console.log('\nPer task (success diff / re-dump):');
  for (const t of tasks) {
    const d = rows.filter((r) => r.task === t.id && r.arm === 'diff');
    const u = rows.filter((r) => r.task === t.id && r.arm === 'redump');
    const pc = (a) => (a.length ? `${a.filter((r) => r.success).length}/${a.length}` : '   —');
    const w = (a) => (a.length ? (a.reduce((x, r) => x + r.wrongElement, 0) / a.length).toFixed(2) : '—');
    console.log(
      `  ${t.id.padEnd(20)} ${(t.stratum === 'canary' ? '[canary]' : '').padEnd(9)} ${pc(d).padStart(6)} / ${pc(u).padEnd(6)}   ` +
        `wrong-el ${w(d)} / ${w(u)}   obs ${Math.round(d.reduce((x, r) => x + r.obsChars, 0) / Math.max(1, d.length))} / ` +
        `${Math.round(u.reduce((x, r) => x + r.obsChars, 0) / Math.max(1, u.length))} chars`,
    );
  }

  const infra = [];
  const vacuous = [];

  // Unclassified observations, surfaced before anything is concluded from the
  // counts they are missing from.
  const odd = rows.flatMap((r) => (r.unclassified ?? []).map((u) => ({ ...u, task: r.task, arm: r.arm })));
  if (odd.length) {
    console.log(
      `\nUnclassified observations (${odd.length}) — neither full, diff, no-change, nor a bare error:`,
    );
    for (const u of odd.slice(0, 5)) {
      console.log(`  ${u.task} [${u.arm}] via ${u.tool}: ${JSON.stringify(u.head)}`);
    }
  }

  // ---- APPARATUS GUARDS — over ALL scored rows, both strata ---------------
  //
  // A wedge, an arm leak, a silent witness or a truncated page in a CANARY
  // episode is exactly as much of an apparatus failure as in a scored one. The
  // stratum partition is about what the VERDICT is computed over; it is not a
  // licence to stop looking at half the run.

  // G3 — the re-dump arm must receive nothing BUT full snapshots. Stated as a
  // whitelist, not a blacklist of diff shapes: an observation the shape
  // predicates fail to classify is exactly where a diff would hide, and a guard
  // that only looks for the shapes it already knows about would not see it.
  const g3 = rows.filter((r) => r.arm === 'redump' && redumpImpurities(r.kinds) > 0);
  if (g3.length) {
    infra.push(
      `G3: ${g3.length} re-dump episodes received an observation that was not a FULL SNAPSHOT. ` +
        'The arms are not what they claim to be. ' +
        'A single-line `error:` reply carries no page representation and both arms can receive ' +
        'it identically; it is recorded as kind `error` and does not bear on arm purity. ' +
        'If these episodes also satisfy G6b, the fault is the apparatus, not the arm forcing ' +
        '— see the quarantine table.',
    );
  }

  // G6b symmetry. A wedge that fell mostly on one arm confounds the comparison
  // in a way no amount of disclosure repairs: the surviving episodes of the two
  // arms are then drawn from different stretches of the run.
  if (Math.abs(qByArm.diff - qByArm.redump) >= 3) {
    infra.push(
      `G6b: the quarantine is asymmetric (diff ${qByArm.diff}, re-dump ${qByArm.redump}). ` +
        'The wedge fell on one arm; the comparison is confounded.',
    );
  }

  // G5 — the witness must have been alive throughout.
  const silent = rows.filter((r) => !r.loaded);
  if (silent.length) infra.push(`G5: ${silent.length} episodes where the fixture never reported to the collector.`);

  // G6 — a success with zero page actions did not happen.
  const ghosts = rows.filter((r) => r.success && r.pageActions === 0);
  if (ghosts.length) {
    vacuous.push(
      `G6: ${ghosts.length} episodes scored SUCCESS having performed zero actions on the page.`,
    );
  }

  // G9 — the model actually served must be the model requested.
  const served = new Set(rows.flatMap((r) => r.modelKeys));
  const wanted = [...served].some((k) => k.includes(opts.model.replace('claude-', '')));
  if (rows.some((r) => r.modelKeys.length) && !wanted) {
    infra.push(`G9: requested ${opts.model}, served ${[...served].join(', ') || 'nothing'}.`);
  }

  // G11 — arm symmetry. Everything except `observe` must be identical.
  const truncated = rows.filter((r) => r.truncatedObs > 0);
  if (truncated.length) {
    infra.push(
      `G11: ${truncated.length} episodes contained a budget-truncated observation. ` +
        'A truncated page is not the same page, and truncation does not fall equally on the arms.',
    );
  }

  // ---- STRATUM-ONLY guards and cost (G4, G7) ------------------------------
  const dObs = diff.rows.reduce((a, r) => a + r.kinds.diff + r.kinds.nochange, 0);
  // The denominator is the PAGE-REPRESENTATION observations only. `error` and
  // `other` carry no page — an `error:` by construction (§2.1's classifier), an
  // `other` by the fact that nothing recognised it — so counting them would let
  // a run of refusals depress the diff share of a perfectly healthy diff arm.
  // Numerically irrelevant on any clean store; wrong on principle before
  // (wave3-evaluation §1.4.4).
  const dAll = diff.rows.reduce((a, r) => a + r.kinds.full + r.kinds.diff + r.kinds.nochange, 0);
  const diffShare = dAll ? dObs / dAll : 0;
  if (diff.n && diffShare < 0.6) {
    infra.push(
      `G4: only ${fmtPct(diffShare)} of diff-arm observations were diffs (floor 60%), over the ` +
        'discriminative stratum. The diff arm has degenerated into a second re-dump arm and ' +
        'measures nothing.',
    );
  }

  const dChars = diff.obsChars.reduce((a, b) => a + b, 0) / Math.max(1, diff.n);
  const uChars = redump.obsChars.reduce((a, b) => a + b, 0) / Math.max(1, redump.n);
  if (diff.n && redump.n && dChars >= uChars) {
    infra.push(
      `G7: over the discriminative stratum the diff arm observed ${Math.round(dChars)} chars/episode ` +
        `against the re-dump arm's ${Math.round(uChars)}. The cheaper arm is not the diff arm — ` +
        'the labels are wrong.',
    );
  }

  console.log('\nObservation cost (discriminative stratum):');
  console.log(`  diff arm   : ${Math.round(dChars)} chars/episode  (${fmtPct(diffShare)} of observations were diffs)`);
  console.log(`  re-dump arm: ${Math.round(uChars)} chars/episode`);
  console.log(`  ratio      : ${uChars ? (dChars / uChars).toFixed(2) : '—'}x`);

  console.log('\nFailure attribution (acts, by arm, discriminative stratum):');
  const attrD = tally(diff.rows, 'attributions');
  const attrU = tally(redump.rows, 'attributions');
  for (const k of new Set([...Object.keys(attrD), ...Object.keys(attrU)])) {
    console.log(`  ${k.padEnd(20)} diff ${String(attrD[k] ?? 0).padStart(4)}   re-dump ${String(attrU[k] ?? 0).padStart(4)}`);
  }
  if (canaryRows.length) {
    const attrC = tally(canaryRows, 'attributions');
    const notOk = Object.entries(attrC).filter(([k]) => k !== 'ok');
    console.log(
      `  canary acts, kept out of the table above: ${
        notOk.length ? notOk.map(([k, v]) => `${k} ${v}`).join(', ') : 'all ok'
      }`,
    );
  }

  // ---- resync-window fragility (tier4 §4; wave3-evaluation §0.2) -----------
  //
  // The old line printed one post_resync count per arm side by side, and that
  // side-by-side was read as a comparison — 65 vs 236 — of two numbers that do
  // not measure the same thing. The proxy tag is arm-blind and stays that way;
  // the vacuity is in the READING, so the repair is in the report.
  //
  // Restricted to the diff arm, with rates rather than bare counts: a count
  // without its denominator is exactly how the misreading happened.
  const inWin = { nonOk: 0, n: 0 };
  const outWin = { nonOk: 0, n: 0 };
  for (const r of diff.rows) {
    for (const a of r.acts ?? []) {
      const bucket = (a.tags ?? []).includes('post_resync') ? inWin : outWin;
      bucket.n++;
      if (a.attribution !== 'ok') bucket.nonOk++;
    }
  }
  const rate = (b) => (b.n ? `${b.nonOk}/${b.n} acts non-ok (${fmtPct(b.nonOk / b.n)})` : '—');
  console.log('\nResync-window fragility (diff arm ONLY — see note):');
  console.log(`  within 2 observations of a FULL SNAPSHOT: ${rate(inWin)}`);
  console.log(`  all other acts:                           ${rate(outWin)}`);
  console.log('  NOTE: the re-dump arm is excluded BY CONSTRUCTION — under the arm');
  console.log('  forcing every observation is a full snapshot, so every act tags');
  console.log('  post_resync and the count degenerates to "all non-ok acts"');
  console.log('  (wave3-evaluation §0.2). No cross-arm reading of this block is');
  console.log('  licensed.');

  // ---- the canary table, and the canary gate (§3.3.3, §3.4) ---------------
  if (canaryRows.length) {
    console.log('\nCANARIES — apparatus health only. These numbers enter NO interval, ever.');
    for (const t of tasks.filter((x) => x.stratum === 'canary')) {
      const parts = ['diff', 'redump'].map((arm) => {
        const a = canaryRows.filter((r) => r.task === t.id && r.arm === arm);
        return { arm, n: a.length, s: a.filter((r) => r.success).length };
      });
      console.log(
        `  ${t.id.padEnd(20)} ` +
          parts.map((p) => `${p.arm.padEnd(7)} ${p.s}/${p.n}`).join('   ') +
          `   quota ${t.quota ?? '—'}/arm`,
      );
      for (const p of parts) {
        // The gate is evaluated at the quota, not on the way up: 0/1 in the
        // pilot wave is noise, 3/5 at quota is an apparatus question.
        if (p.n >= 5 && p.s < Math.ceil(CANARY_GATE * p.n)) {
          infra.push(
            `CANARY GATE: ${t.id} [${p.arm}] scored ${p.s}/${p.n}, below the preregistered 4/5 ` +
              'floor. A ceilinged task that stops ceilinging is an apparatus finding, not a ' +
              'result about the arms — investigate before continuing (§3.4).',
          );
        }
      }
    }
    console.log(
      '  They license exactly one sentence: "the apparatus and easy-task floor held".\n' +
        '  Their numbers appear in no claim about diffs, in this run or any other.',
    );
  }

  console.log('\nCost:');
  console.log(`  diff arm   : $${diff.cost.toFixed(4)} over ${diff.n} stratum episodes ($${(diff.cost / Math.max(1, diff.n)).toFixed(4)}/episode)`);
  console.log(`  re-dump arm: $${redump.cost.toFixed(4)} over ${redump.n} stratum episodes ($${(redump.cost / Math.max(1, redump.n)).toFixed(4)}/episode)`);
  const canaryCost = canaryRows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const totalCost = allRows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  console.log(`  canaries   : $${canaryCost.toFixed(4)} over ${canaryRows.length} episodes`);
  console.log(
    `  total      : $${totalCost.toFixed(4)} (including quarantined episodes — the money was spent)` +
      `\n               against the preregistered $85 hard cap.`,
  );

  if (infra.length) return bail(EXIT.INFRA, 'INFRASTRUCTURE GUARD FAILED — no verdict:', infra);
  if (vacuous.length) return bail(EXIT.VACUOUS, 'VACUOUS RUN — no verdict:', vacuous);

  // ---- the preregistered comparison, over the stratum ---------------------
  const sCI = propDiffCI(diff.successes, diff.n, redump.successes, redump.n);
  const wCI = meanDiffCI(diff.wrong, redump.wrong);
  const sD = wilson(diff.successes, diff.n);
  const sU = wilson(redump.successes, redump.n);

  console.log('\n' + '-'.repeat(72));
  console.log('DISCRIMINATIVE STRATUM — the verdict arithmetic');
  console.log(`success  diff    : ${diff.successes}/${diff.n} = ${fmtPct(sD.p)}  [${fmtPct(sD.lo)}, ${fmtPct(sD.hi)}]`);
  console.log(`success  re-dump : ${redump.successes}/${redump.n} = ${fmtPct(sU.p)}  [${fmtPct(sU.lo)}, ${fmtPct(sU.hi)}]`);
  console.log(`success  delta   : ${fmtSigned(sCI.delta)}  95% CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}]   (Newcombe)`);
  console.log(`wrong-el diff    : ${wCI.m1.toFixed(3)}/run`);
  console.log(`wrong-el re-dump : ${wCI.m2.toFixed(3)}/run`);
  console.log(`wrong-el delta   : ${wCI.delta >= 0 ? '+' : ''}${wCI.delta.toFixed(3)}/run  95% CI [${wCI.lo.toFixed(3)}, ${wCI.hi.toFixed(3)}]   (bootstrap, seeded)`);
  console.log('-'.repeat(72));

  const mde = smallestDetectableDrop(diff.n, redump.n, sU.p, SUCCESS_BOUND);
  console.log(
    `\nPower, honestly: at n=${diff.n}/${redump.n} stratum episodes and a re-dump rate of ${fmtPct(sU.p)},\n` +
      `the smallest true drop this run could distinguish from the ${fmtSigned(SUCCESS_BOUND)} bound is about ${fmtPct(mde)}.\n` +
      'Per-task numbers above are directional colour, not findings.',
  );

  // ---- the per-task wrong-element TRIPWIRE (§3.4) -------------------------
  //
  // The mirror of wave 2's dilution lesson, applied to the metric where one
  // task can hide inside a pool of three: a task can be quietly awful at
  // wrong-element while the stratum-pooled CI still clears +0.40.
  const tripped = [];
  console.log('\nPer-task wrong-element tripwire (discriminative stratum, blocks PASS at +1.0/run):');
  for (const t of stratumTasks) {
    const d = stratumRows.filter((r) => r.task === t.id && r.arm === 'diff').map((r) => r.wrongElement);
    const u = stratumRows.filter((r) => r.task === t.id && r.arm === 'redump').map((r) => r.wrongElement);
    if (!d.length || !u.length) {
      console.log(`  ${t.id.padEnd(20)} —  (no episodes in one arm yet)`);
      continue;
    }
    const ci = meanDiffCI(d, u);
    const trip = ci.lo > PER_TASK_WRONG_TRIP;
    if (trip) tripped.push(`${t.id} (CI lower ${ci.lo.toFixed(3)}/run)`);
    console.log(
      `  ${t.id.padEnd(20)} delta ${(ci.delta >= 0 ? '+' : '') + ci.delta.toFixed(3)}/run  ` +
        `CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]${trip ? '   <-- TRIPPED' : ''}`,
    );
  }

  // ---- the preregistered SENSITIVITY line (§3.3.3) ------------------------
  printSensitivity(stratumRows, stratumTasks, sCI, wCI);

  // The preregistered interim rule, evaluated and printed rather than left for
  // someone to apply from memory. It conditions ONLY on pooled levels and cost
  // — never on the delta between the arms — which is the property that makes
  // looking at the pilot legitimate instead of a peek that biases the stop.
  const perTaskN = Math.min(diff.n, redump.n) / Math.max(1, stratumTasks.length);
  const costPerEp = (diff.cost + redump.cost) / Math.max(1, diff.n + redump.n);
  const branch =
    sD.p >= INTERIM_CEILING && sU.p >= INTERIM_CEILING
      ? `STOP — both arms are at or above ${fmtPct(INTERIM_CEILING)} over the discriminative stratum. The ` +
        'suite failed to leave the ceiling; redesign harder tasks and do not spend the rest.'
      : sU.p < INTERIM_REDUMP_FLOOR
        ? `STOP — the re-dump arm is below ${fmtPct(INTERIM_REDUMP_FLOOR)} over the stratum. The tasks are too hard ` +
          'or broken; fix them and --new-cohort.'
        : costPerEp > INTERIM_COST_TRIM
          ? `TRIM — $${costPerEp.toFixed(3)}/discriminative episode is above the $${INTERIM_COST_TRIM.toFixed(2)} threshold. Run the ` +
            'remaining phases at --n 35 instead of --n 45 (a uniform cap under quota; identity untouched).'
          : 'CONTINUE — pooled stratum rates are off the ceiling, the re-dump arm is healthy, and ' +
            'cost is inside the threshold. Run out to the quotas and pool.';
  console.log(
    `\nInterim rule (preregistered; reads pooled levels and cost only, blind to the arm\n` +
      `delta). At about N=${perTaskN.toFixed(1)}/task/arm — diff ${fmtPct(sD.p)}, re-dump ${fmtPct(sU.p)}, $${costPerEp.toFixed(3)}/ep:\n` +
      `  ${branch}\n` +
      '  (The canary gate is the fourth branch and is enforced above as an INFRA stop.)' +
      (perTaskN < INTERIM_PILOT_N
        ? `\n  (Advisory only below N=${INTERIM_PILOT_N}/task/arm; the rule is meant to be applied at the pilot wave.)`
        : ''),
  );

  // G8 — the floor on the STRATUM, per arm.
  if (diff.n < STRATUM_FLOOR || redump.n < STRATUM_FLOOR) {
    return bail(EXIT.INCONCLUSIVE, `G8: below the floor of ${STRATUM_FLOOR} stratum episodes per arm. This is a PILOT, not a result:`, [
      `diff n=${diff.n}, re-dump n=${redump.n} over the discriminative stratum. The loop is ` +
        'exercised; the comparison is not evidence.',
    ]);
  }

  // G10 — the ceiling, on STRATUM rates. Two perfect arms cannot demonstrate
  // anything about a bookkeeping penalty.
  if (sD.p >= 0.98 && sU.p >= 0.98) {
    return bail(EXIT.INCONCLUSIVE, 'G10: CEILING. Both arms are at or above 98% over the discriminative stratum:', [
      'A task set both arms solve every time cannot detect a diff-bookkeeping penalty even',
      'if one exists. This licenses no claim. Make the tasks harder or the model smaller.',
    ]);
  }

  const wrongHolds = wCI.hi <= WRONG_BOUND;
  const pass = sCI.lo >= SUCCESS_BOUND && wrongHolds && tripped.length === 0;
  const regression = sCI.hi < SUCCESS_BOUND || wCI.lo > WRONG_BOUND;

  if (pass) {
    const clearS = sCI.lo - SUCCESS_BOUND;
    const clearW = WRONG_BOUND - wCI.hi;
    console.log('\nRESULT: PASS (exit 0)');
    console.log(
      '\nWhat this licenses, and nothing more:\n' +
        `  "On this ${stratumTasks.length}-task positional-identity suite (post-P1 engine) with ${opts.model},\n` +
        '   no diff-bookkeeping penalty larger than 10pp in task success or +0.4\n' +
        '   wrong-element actions per run was found."\n' +
        `\n  MDE beside it, always: at n=${diff.n}/${redump.n} the smallest true drop this run could\n` +
        `  distinguish from the bound is about ${fmtPct(mde)}.\n` +
        `\n  Margin clearance: success CI lower ${fmtSigned(sCI.lo)} clears the bound by ${fmtSigned(clearS)};\n` +
        `  wrong-element CI upper ${wCI.hi.toFixed(3)} clears +${WRONG_BOUND} by ${clearW.toFixed(3)}/run.` +
        (clearS < 0.02
          ? '\n  THIS IS A THIN PASS. It is reported as thin, on purpose — wave 2 cleared its\n' +
            '  bound by 0.25pp and the number was read as if it were comfortable.'
          : '') +
        '\n\n  It is NOT parity and NOT equivalence. It says nothing about other models, real\n' +
        '  websites, insert-mutation pages (tier3.md §3.1.2), larger pages, longer tasks, or\n' +
        '  iframes. The canaries license only "the apparatus and easy-task floor held", and\n' +
        '  any comparison with wave 2 is directional narrative — different engine, never\n' +
        '  pooled, never CI\'d.',
    );
    return EXIT.PASS;
  }
  if (regression) {
    return bail(EXIT.REGRESSION, 'RESULT: REGRESSION — diffs cost the agent something real:', [
      `success delta CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}] against a bound of ${fmtSigned(SUCCESS_BOUND)}`,
      `wrong-element delta CI [${wCI.lo.toFixed(3)}, ${wCI.hi.toFixed(3)}] against a bound of +${WRONG_BOUND}`,
      'Computed over the discriminative stratum; the canaries are not in it.',
    ]);
  }

  return bail(EXIT.INCONCLUSIVE, 'RESULT: INCONCLUSIVE — the intervals do not decide it:', [
    `success delta CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}], bound ${fmtSigned(SUCCESS_BOUND)}`,
    `wrong-element delta CI [${wCI.lo.toFixed(3)}, ${wCI.hi.toFixed(3)}], bound +${WRONG_BOUND}`,
    ...(tripped.length
      ? [
          `PER-TASK TRIPWIRE: ${tripped.join(', ')} — its own wrong-element CI lower is above ` +
            `+${PER_TASK_WRONG_TRIP.toFixed(1)}/run, which BLOCKS a PASS whatever the pooled CI says. ` +
            'One task can hide inside a pool of three; this is the rule that stops it.',
        ]
      : []),
    'This licenses no README claim. More episodes, or a harder suite.',
  ]);
}

/**
 * GPU-process pid transitions across consecutive episodes (§2.2), CLASSIFIED
 * (tier4 §3.3). Advisory: it changes no verdict and no exit code. It exists
 * because after the wave-2 wedge nobody could say whether the GPU process had
 * died, and that is the single most likely explanation on record.
 *
 * The classification is what makes the note readable. A changed GPU pid across
 * an APP RESTART is a new process tree, not a crash — wave 3 ran in phases and
 * every phase boundary produced one. Only a GPU pid that changed while the
 * BROWSER process stayed the same is the wedge hypothesis's signature, and
 * before the instance stamp the store could not tell the two apart.
 */
function printApparatusNote(allRows) {
  const seen = allRows.filter((r) => r.apparatus && 'gpuPid' in r.apparatus);
  if (!seen.length) return;
  const transitions = [];
  const kinds = new Set();
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1];
    const b = seen[i];
    if (a.apparatus.gpuPid !== b.apparatus.gpuPid) {
      const kind = classifyGpuTransition(a.apparatus, b.apparatus);
      kinds.add(kind);
      const suffix =
        kind === 'restart'
          ? `  [app restart — expected]  (browser pid ${String(a.apparatus.browserPid)} -> ${String(b.apparatus.browserPid)})`
          : kind === 'crash'
            ? '  [SAME-INSTANCE GPU RELAUNCH — crash candidate]'
            : kind === 'unmeasured'
              ? '  [apparatus poll failed across this boundary — unmeasured]'
              : '  [instance identity not recorded (pre-tier4 rows) — cross-check the aperture.<stamp>.log]';
      transitions.push(
        `    ${String(a.apparatus.gpuPid)} -> ${String(b.apparatus.gpuPid)}  between ` +
          `${a.task} [${a.arm}] run${a.runIndex} and ${b.task} [${b.arm}] run${b.runIndex}` +
          (b.recordedAt ? `  (${b.recordedAt})` : '') +
          suffix,
      );
    }
  }
  if (!transitions.length) return;
  console.log(
    `\nAPPARATUS NOTE — the GPU process pid changed ${transitions.length} time(s) across the store.`,
  );
  // The crash hypothesis is printed only when the store cannot rule it out. A
  // store whose every transition coincides with a new instance was telling the
  // reader to go looking for a crash that the same rows already explain.
  if (kinds.has('crash') || kinds.has('unknown-instance')) {
    console.log('  A changed GPU pid is a GPU process that crashed and relaunched — the leading');
    console.log('  hypothesis for the wave-2 wedge. ADVISORY ONLY: no verdict effect. Cross-check');
    console.log('  against the aperture.<stamp>.log for the same window.');
  } else {
    console.log('  All GPU pid transitions coincide with a new Aperture instance: app restarts');
    console.log('  between phases, not crashes. ADVISORY ONLY: no verdict effect.');
  }
  for (const t of transitions.slice(0, 12)) console.log(t);
  if (transitions.length > 12) console.log(`    … and ${transitions.length - 12} more`);
}

/**
 * The input witness's own health, cumulative per Aperture instance (tier4 §6.3).
 *
 * `WITNESS_TALLY` counts one increment per `settle()` resolution and resets
 * with the process, so the LAST row of each instance carries that instance's
 * totals — summing every row would count the same settles once per episode.
 * Rows are grouped by `browserCreated`, the instance identity §3 added.
 *
 * Why it is printed at all: Gate 2's `deadActs` repair made `lost` a live
 * attribution, but `unknown` still falls through to `observe`, so a run whose
 * witness had silently degraded to unknown-mode looks exactly like a healthy
 * one — and in that state W1's lost-detection is blind. Advisory only.
 */
function printWitnessSummary(allRows) {
  const withWitness = allRows.filter((r) => r.apparatus?.witness);
  if (!withWitness.length) return;

  // Group by instance, keep the LAST row of each (counters are cumulative).
  const lastPerInstance = new Map();
  for (const r of withWitness) {
    lastPerInstance.set(r.apparatus.browserCreated ?? r.apparatus.browserPid ?? 'unknown', r);
  }
  let landed = 0;
  let unknown = 0;
  let lost = 0;
  for (const r of lastPerInstance.values()) {
    landed += r.apparatus.witness.landed ?? 0;
    unknown += r.apparatus.witness.unknown ?? 0;
    lost += r.apparatus.witness.lost ?? 0;
  }
  const total = landed + unknown + lost;
  console.log(
    `\nInput witness (cumulative across ${lastPerInstance.size} instance(s)): ` +
      `landed ${landed} · unknown ${unknown} · lost ${lost}`,
  );
  if (total && unknown / total > 0.1) {
    console.log(
      '  ADVISORY: the input witness answered `unknown` for >10% of settles — W1\'s',
    );
    console.log(
      '  lost-detection was blind for that share (dead poll channel or navigating',
    );
    console.log(
      '  pages). Cross-check the child log before trusting the absence of input-loss',
    );
    console.log('  errors.');
  }
}

/**
 * The preregistered SENSITIVITY line (§3.3.3), never the headline.
 *
 * The §3.4 ceiling checkpoint retires a discriminative task that scored 10/10
 * in BOTH arms over its first ten runs — its later slots are simply not asked
 * for, while the episodes it already produced STAY in the pool (no post-hoc
 * exclusion, ever). This line is where the no-ceiling reading lives: the same
 * stratum verdict, recomputed with those tasks' episodes removed, so a reader
 * can see whether the headline depends on a task that stopped discriminating.
 */
function printSensitivity(stratumRows, stratumTasks, sCI, wCI) {
  const retired = stratumTasks.filter((t) => {
    for (const arm of ['diff', 'redump']) {
      const a = stratumRows.filter((r) => r.task === t.id && r.arm === arm && r.runIndex < 10);
      if (a.length < 10 || a.some((r) => !r.success)) return false;
    }
    return true;
  });

  console.log('\nSENSITIVITY (preregistered, never the headline):');
  if (!retired.length) {
    console.log(
      '  No discriminative task was 10/10 in both arms over its first ten runs, so the\n' +
        '  ceiling checkpoint retired nothing and this line is identical to the headline.',
    );
    return;
  }
  const kept = stratumRows.filter((r) => !retired.some((t) => t.id === r.task));
  const d = summarise(kept, 'diff');
  const u = summarise(kept, 'redump');
  if (!d.n || !u.n) {
    console.log(`  Excluding ${retired.map((t) => t.id).join(', ')} leaves an empty arm — nothing to recompute.`);
    return;
  }
  const s2 = propDiffCI(d.successes, d.n, u.successes, u.n);
  const w2 = meanDiffCI(d.wrong, u.wrong);
  console.log(
    `  Ceiling-checkpoint retirees: ${retired.map((t) => t.id).join(', ')} (10/10 in both arms at N=10).\n` +
      '  Their episodes STAY in the headline pool. Recomputed WITHOUT them:\n' +
      `    success delta ${fmtSigned(s2.delta)}  95% CI [${fmtSigned(s2.lo)}, ${fmtSigned(s2.hi)}]  (headline: ${fmtSigned(sCI.delta)} [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}])\n` +
      `    wrong-el delta ${(w2.delta >= 0 ? '+' : '') + w2.delta.toFixed(3)}/run  95% CI [${w2.lo.toFixed(3)}, ${w2.hi.toFixed(3)}]  (headline: ${(wCI.delta >= 0 ? '+' : '') + wCI.delta.toFixed(3)} [${wCI.lo.toFixed(3)}, ${wCI.hi.toFixed(3)}])\n` +
      `    n = ${d.n}/${u.n} per arm.`,
  );
  console.log('  This is a sensitivity reading. The verdict below is the headline one.');
}

// The runner runs when it IS the entry point, and only then. Importing this
// file (the §3.6 report unit does) must not start a benchmark.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((c) => process.exit(c ?? EXIT.INFRA))
    .catch((e) => {
      console.error('\nRUNNER FAILED:', e?.stack ?? e);
      process.exit(EXIT.INFRA);
    });
}
