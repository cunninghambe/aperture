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
 *
 * KNOWN LIMITATIONS, stated rather than papered over:
 * - The SDK exposes no temperature control (only `effort`), so runs are
 *   stochastic. That is acceptable because it affects both arms identically,
 *   but it means a single episode is noise and only the pooled CIs are evidence.
 * - The model is Sonnet, not Opus, and that is a SENSITIVITY choice: if the
 *   model scores ~100% in both arms the suite cannot detect a bookkeeping
 *   penalty even if one exists. G10 refuses to call that PARITY.
 * - `browser_read` is withheld. innerText re-reads would let the agent route
 *   around diff bookkeeping and dilute the variable under test.
 *
 * RUNNING IT IN PHASES
 *
 * 400 episodes is six-odd hours, so the suite is resumable. Every scored
 * episode is appended to `bench/task/results/episodes.jsonl` as it completes,
 * keyed by (task, arm, runIndex, codeVersion, model); a later invocation skips
 * every combination already on record and runs only what is missing. The
 * verdict is computed over the WHOLE accumulated store, not over one phase —
 * five partial runs that each score their own rows give five underpowered
 * verdicts and no result.
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
 *   npm run bench:task -- --n 20              phase 2: only the missing 15
 *   npm run bench:task -- --report            score the store, run nothing
 *   npm run bench:task -- --new-cohort --n 5  archive the store, start again
 *
 * EXIT CODES — nonzero must never be read as "roughly green"
 *   0 PARITY · 1 REGRESSION · 2 INCONCLUSIVE · 3 INFRA · 4 VACUOUS · 5 SELFTEST
 *   6 INTEGRITY — the store holds episodes from a different experiment
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { TASKS, FIXTURES, taskById } from './tasks.mjs';
import { startCollector, settle, COLLECTOR_PORT } from './lib/collector.mjs';
import { startProxy, PROXY_PORT, ARM_DEFINITION } from './lib/proxy.mjs';
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
const APERTURE_PORT = 8817;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

export const EXIT = {
  PARITY: 0,
  REGRESSION: 1,
  INCONCLUSIVE: 2,
  INFRA: 3,
  VACUOUS: 4,
  SELFTEST: 5,
  INTEGRITY: 6,
};

// The verdict rule, written down before the first scored run and not touched
// since. Both must hold for PARITY.
const PARITY_SUCCESS_MARGIN = -0.05; // success-delta CI lower bound >= this
const PARITY_WRONG_MARGIN = 0.2; // wrong-element-delta CI upper bound <= this
const N_FLOOR = 5;
const N_PREREGISTERED = 20; // per task, per arm

/**
 * Stamped onto every episode and compared on resume. The thresholds are the
 * verdict; an episode scored under different ones is not poolable with these,
 * and this is the field that says so out loud.
 */
const VERDICT_RULE = {
  successMargin: PARITY_SUCCESS_MARGIN,
  wrongMargin: PARITY_WRONG_MARGIN,
  nFloor: N_FLOOR,
};

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
    selftest: false, n: N_PREREGISTERED, tasks: null, arms: ['diff', 'redump'],
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

async function portIsOpen(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(700) });
    return true;
  } catch (e) {
    // A refused connection is "closed"; anything else (a 401, a 404, a reset
    // mid-response) means something IS listening.
    return !/ECONNREFUSED|refused/i.test(String(e?.cause?.code ?? e?.message ?? ''));
  }
}

function readApertureToken() {
  const p = join(process.env.APPDATA ?? '', 'aperture', 'mcp.json');
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const auth = cfg?.mcpServers?.aperture?.headers?.Authorization ?? '';
    return auth.replace(/^Bearer /, '') || null;
  } catch {
    return null;
  }
}

async function tokenWorks(token) {
  try {
    const res = await fetch(`http://127.0.0.1:${APERTURE_PORT}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.text();
    return body.includes('browser_act');
  } catch {
    return false;
  }
}

async function startAperture() {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js is missing — run `npx electron-vite build` first');
  }
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const token = readApertureToken();
    if (token && (await tokenWorks(token))) return { child, token, log: () => log };
  }
  throw new Error(`Aperture did not come up on ${APERTURE_PORT} within 60s.\n${log.slice(-2000)}`);
}

/**
 * Kill the Aperture this run started, and do not return until it is gone.
 *
 * The await is load-bearing and was measured, not assumed. This used to fire
 * `taskkill` and return immediately, and `main()` then called `process.exit()`
 * before the kill had landed — so a completed run routinely left an Aperture
 * holding 8817 and the NEXT invocation died on the port check with exit 3.
 * Survivable when the suite was run once; not survivable when the whole point
 * is running it in five phases back to back.
 */
async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((done) => {
    try {
      if (process.platform !== 'win32') {
        child.kill('SIGTERM');
        done();
        return;
      }
      // The child is the npx shell wrapper; /T is what reaches Electron under it.
      const t = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      t.on('exit', done);
      t.on('error', done);
      setTimeout(done, 10000).unref();
    } catch {
      done();
    }
  });
  // Verified against the port rather than against the exit code of taskkill: a
  // successful taskkill on a wrapper that has already lost track of its child
  // reports success and leaves the listener up.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await portIsOpen(APERTURE_PORT))) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(
    `\nWARNING: Aperture is STILL listening on ${APERTURE_PORT} after the teardown. The next\n` +
      '         phase will refuse to start. Run: taskkill //F //IM electron.exe',
  );
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
 */
function resolveLabel(model, step) {
  const roles = step.act === 'type' || step.act === 'clear' ? TYPE_ROLES : CLICK_ROLES;
  const hits = [...model.entries()].filter(([, e]) => e.label === step.label && roles.has(e.role));
  if (hits.length === 1) return { ref: hits[0][0] };
  return {
    error:
      `"${step.label}" resolves to ${hits.length} elements in the model (need exactly 1). Model holds:\n` +
      [...model.entries()].map(([r, e]) => `    ${r} ${e.role} "${e.label}"`).join('\n'),
  };
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

  const kinds = { full: 0, diff: 0, nochange: 0, other: 0 };
  for (const o of ep.observations) kinds[o.kind]++;
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
    // Any observation the shape predicates could not classify. An unclassified
    // observation is the hole a diff could slip through unnoticed in the
    // re-dump arm, so they are surfaced rather than bucketed and forgotten.
    unclassified: ep.observations.filter((o) => o.kind === 'other').map((o) => ({ tool: o.tool, head: o.text.slice(0, 240) })),
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
        if (r.kinds.diff === 0) {
          problems.push(`${task.id}: the diff arm produced no diffs at all.`);
        }
      }
      // G3 and G7, run here rather than only after the scored run. Arm purity
      // is checkable for FREE with the scripted solver, and an experiment whose
      // two arms are secretly the same arm is the single worst thing this suite
      // could print — it would come out as a confident PARITY.
      if (arm === 'redump' && (r.kinds.diff > 0 || r.kinds.nochange > 0)) {
        problems.push(
          `G3 — ${task.id}: the re-dump arm received ${r.kinds.diff + r.kinds.nochange} ` +
            'diff-shaped observation(s). The arms are not what they claim to be.',
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
 * before run 4 of any.
 *
 * The order is the whole point. A phase that dies halfway through — a laptop
 * sleeping, a rate limit, a Ctrl-C — leaves even coverage across the task set
 * rather than four finished tasks and six untouched ones, and the per-task
 * table stays comparable at every point on the way up.
 */
function targetsFor(tasks, arms, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    for (const task of tasks) for (const arm of arms) out.push({ task, arm, runIndex: k });
  }
  return out;
}

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

const WAVES = [1, 5, 10, 15, N_PREREGISTERED];

function printPlan({ rows, storePath, identity, opts }) {
  const est = perEpisode(rows);
  const perWave = TASKS.length * 2;
  const total = perWave * N_PREREGISTERED;

  console.log('='.repeat(72));
  console.log('SUGGESTED PHASE PLAN');
  console.log('='.repeat(72));
  console.log(
    `\nThe full preregistered suite is ${TASKS.length} tasks x 2 arms x N=${N_PREREGISTERED} = ${total} episodes,\n` +
      `about ${fmtDuration((total * est.sec)).padEnd(1)} and $${(total * est.usd).toFixed(2)} at ${est.sec.toFixed(0)}s and $${est.usd.toFixed(4)} per episode (from ${est.source}).`,
  );

  console.log('\nSplit it by N in waves, not by task:');
  console.log('  A partial run across ALL ten tasks is far more informative than a complete');
  console.log('  run of two. Ten tasks at N=5 already shows you which tasks separate the arms');
  console.log('  and whether the whole thing is heading for the G10 ceiling; two tasks at N=20');
  console.log('  tells you a great deal about two tasks. The runner iterates wave-major for');
  console.log('  the same reason, so an interrupted phase also leaves even coverage.');

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
    const cum = perWave * n;
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
    const minRuns = Math.min(...TASKS.map((t) => Math.min(perTaskArm[`${t.id}|diff`] ?? 0, perTaskArm[`${t.id}|redump`] ?? 0)));
    console.log(`  ${present.size}/${TASKS.length} tasks touched; every task has at least ${minRuns} run(s) in both arms.`);
    const nextWave = WAVES.find((n) => n > minRuns);
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
 * parity margin, IF the observed rates held. Advice about how much further
 * there is to go, not a stopping rule.
 *
 * Returns null for "not inside the cap", which is NOT the same as "never" — a
 * true delta of −4.0pp against a −5.0pp margin needs an interval half-width
 * under 1pp and so needs thousands of episodes per arm. Reporting that as
 * "impossible" would be a different claim from the true one, so the caller
 * distinguishes the two.
 */
const PARITY_SEARCH_CAP = 5000;

function parityReachableAt(pd, pu, cap = PARITY_SEARCH_CAP) {
  for (let n = 5; n <= cap; n += 5) {
    if (propDiffCI(Math.round(pd * n), n, Math.round(pu * n), n).lo >= PARITY_SUCCESS_MARGIN) return n;
  }
  return null;
}

/**
 * Printed after every phase. Two jobs: say where the sample is, and say plainly
 * what it can and cannot support yet — because "5/5 in both arms" reads like a
 * result to everyone who has not thought about the interval.
 *
 * It is ADVISORY. It computes nothing the verdict uses and changes no
 * threshold. The PARITY/REGRESSION/INCONCLUSIVE rule below runs exactly as it
 * did before this block existed.
 */
function progressAdvisory(allRows, phaseRows, opts) {
  const diff = summarise(allRows, 'diff');
  const redump = summarise(allRows, 'redump');
  const present = [...new Set(allRows.map((r) => r.task))];

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
  console.log('\non record, pooled across every phase:');
  console.log(line('diff', diff));
  console.log(line('re-dump', redump));
  console.log(
    `  ${present.length}/${TASKS.length} tasks touched · ` +
      `${(diff.n / Math.max(1, present.length)).toFixed(1)} runs per task per arm`,
  );

  console.log('\ncoverage (runs on record, diff / re-dump, target N per task per arm):');
  for (const t of TASKS) {
    const d = allRows.filter((r) => r.task === t.id && r.arm === 'diff').length;
    const u = allRows.filter((r) => r.task === t.id && r.arm === 'redump').length;
    const bar = '#'.repeat(Math.min(N_PREREGISTERED, Math.min(d, u))).padEnd(N_PREREGISTERED, '.');
    console.log(`  ${t.id.padEnd(20)} ${String(d).padStart(3)} / ${String(u).padEnd(3)}  ${bar}`);
  }

  const sD = wilson(diff.successes, diff.n);
  const sU = wilson(redump.successes, redump.n);
  const perTask = diff.n / Math.max(1, present.length);

  console.log('\nCan this sample support a verdict yet?');
  if (diff.n < N_FLOOR || redump.n < N_FLOOR) {
    console.log(
      `  No. ${diff.n}/${redump.n} episodes per arm is below the hard floor of ${N_FLOOR} (G8). This exercises`,
    );
    console.log('  the loop; it is not a measurement, and the run will exit INCONCLUSIVE.');
  } else {
    const mde = smallestDetectableDrop(diff.n, redump.n, sU.p, PARITY_SUCCESS_MARGIN);
    console.log(
      `  At ${diff.n}/${redump.n} episodes per arm — about N=${perTask.toFixed(1)}/task/arm over ${present.length}/${TASKS.length} tasks —`,
    );
    console.log(
      `  and an observed re-dump rate of ${fmtPct(sU.p)}, the smallest true drop this sample can`,
    );
    console.log(
      `  distinguish from the ${fmtSigned(PARITY_SUCCESS_MARGIN)} parity margin is about ${fmtPct(mde)}. Anything smaller than`,
    );
    console.log('  that is inside the noise, however clean the percentages look.');
    const need = parityReachableAt(sD.p, sU.p);
    const gap = sD.p - sU.p;
    if (gap <= PARITY_SUCCESS_MARGIN) {
      console.log(
        `  The observed delta itself, ${fmtSigned(gap)}, is already at or past the ${fmtSigned(PARITY_SUCCESS_MARGIN)} margin. At`,
      );
      console.log('  these rates no sample size produces PARITY; more episodes buy precision about');
      console.log('  a gap, not a pass.');
    } else if (need === null) {
      console.log(
        `  The observed gap of ${fmtSigned(gap)} sits close enough to the ${fmtSigned(PARITY_SUCCESS_MARGIN)} margin that the interval`,
      );
      console.log(
        `  would not fit inside it within ${PARITY_SEARCH_CAP} episodes per arm at these rates. Reaching`,
      );
      console.log('  PARITY here is not a matter of finishing the planned phases.');
    } else if (need > diff.n) {
      console.log(
        `  If these rates hold, the success interval would clear the margin at about ${need}`,
      );
      console.log(`  episodes per arm. You have ${diff.n}.`);
    } else {
      console.log('  The success interval already clears the parity margin at this sample size.');
    }
  }
  console.log(
    `  The preregistered design is N=${N_PREREGISTERED}/task/arm over all ${TASKS.length} tasks = ` +
      `${TASKS.length * N_PREREGISTERED} episodes per arm.`,
  );

  // Early stopping, stated as advice and nothing else. If the diff arm has
  // already fallen off a cliff, six more hours buys a tighter interval around a
  // disaster that is already unambiguous.
  if (diff.n >= N_FLOOR && redump.n >= N_FLOOR) {
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
    console.log(
      `this phase asks for ${targets.length} episode(s) — ${tasks.length} task(s) x ${opts.arms.length} arm(s) x N=${opts.n}`,
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
    aperture = await startAperture();
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

    if (opts.selftest) {
      console.log('SELFTEST PASS — G1 and G2 green, no API budget spent.');
      return (code = EXIT.PARITY);
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
    console.log(`cohort   : ${rel(cohortFile)}`);
    console.log(`writing  : ${rel(storePath)}  (one line per episode, as it completes)\n`);

    const phaseRows = [];
    let i = 0;
    for (const t of todo) {
      i++;
      const r = await runEpisode({
        proxy, collector, task: t.task, arm: t.arm, runIndex: t.runIndex,
        driver: agentDriver(proxy, t.task, opts),
      });
      const row = stampEpisode(r, identity, ARM_DEFINITION, toolsHash);
      appendEpisode(storePath, row);
      phaseRows.push(row);
      stored.push(row);
      console.log(
        `[${String(i).padStart(3)}/${todo.length}] run${String(t.runIndex).padStart(3)} ${t.task.id.padEnd(20)} ${t.arm.padEnd(7)} ` +
          `${r.success ? 'PASS' : 'fail'}  wrong=${r.wrongElement} steps=${r.steps} ` +
          `obs=${r.kinds.full}F/${r.kinds.diff}D/${r.kinds.nochange}N/${r.kinds.other}? · ${r.obsChars}ch · $${r.costUsd.toFixed(4)} · ${(r.durationMs / 1000).toFixed(0)}s` +
          (r.driverError ? `  ERROR: ${r.driverError.slice(0, 80)}` : ''),
      );
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

function report(rows, opts, tasks) {
  const diff = summarise(rows, 'diff');
  const redump = summarise(rows, 'redump');

  console.log('\n' + '='.repeat(72));
  console.log('RESULTS');
  console.log('='.repeat(72));
  console.log(
    `pooled over ${rows.length} episode(s) on record — every phase of this cohort, not just\n` +
      'the most recent one. The verdict rule below is the preregistered one, unchanged.',
  );

  console.log('\nPer task (success diff / re-dump):');
  for (const t of tasks) {
    const d = rows.filter((r) => r.task === t.id && r.arm === 'diff');
    const u = rows.filter((r) => r.task === t.id && r.arm === 'redump');
    const pc = (a) => (a.length ? `${a.filter((r) => r.success).length}/${a.length}` : '   —');
    const w = (a) => (a.length ? (a.reduce((x, r) => x + r.wrongElement, 0) / a.length).toFixed(2) : '—');
    console.log(
      `  ${t.id.padEnd(20)} ${pc(d).padStart(6)} / ${pc(u).padEnd(6)}   ` +
        `wrong-el ${w(d)} / ${w(u)}   obs ${Math.round(d.reduce((x, r) => x + r.obsChars, 0) / Math.max(1, d.length))} / ` +
        `${Math.round(u.reduce((x, r) => x + r.obsChars, 0) / Math.max(1, u.length))} chars`,
    );
  }

  const infra = [];
  const vacuous = [];

  // Unclassified observations, surfaced before anything is concluded from the
  // counts they are missing from.
  const odd = rows.flatMap((r) => r.unclassified.map((u) => ({ ...u, task: r.task, arm: r.arm })));
  if (odd.length) {
    console.log(`\nUnclassified observations (${odd.length}) — neither full, diff, nor no-change:`);
    for (const u of odd.slice(0, 5)) {
      console.log(`  ${u.task} [${u.arm}] via ${u.tool}: ${JSON.stringify(u.head)}`);
    }
  }

  // G3 — the re-dump arm must receive nothing BUT full snapshots. Stated as a
  // whitelist, not a blacklist of diff shapes: an observation the shape
  // predicates fail to classify is exactly where a diff would hide, and a guard
  // that only looks for the shapes it already knows about would not see it.
  const g3 = redump.rows.filter(
    (r) => r.kinds.diff > 0 || r.kinds.nochange > 0 || r.kinds.other > 0,
  );
  if (g3.length) {
    infra.push(
      `G3: ${g3.length} re-dump episodes received an observation that was not a FULL SNAPSHOT. ` +
        'The arms are not what they claim to be.',
    );
  }

  // G4 — the diff arm must not degenerate into a re-dump arm.
  const dObs = diff.rows.reduce((a, r) => a + r.kinds.diff + r.kinds.nochange, 0);
  const dAll = diff.rows.reduce((a, r) => a + r.kinds.full + r.kinds.diff + r.kinds.nochange + r.kinds.other, 0);
  const diffShare = dAll ? dObs / dAll : 0;
  if (diff.n && diffShare < 0.6) {
    infra.push(
      `G4: only ${fmtPct(diffShare)} of diff-arm observations were diffs (floor 60%). ` +
        'The diff arm has degenerated into a second re-dump arm and measures nothing.',
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

  // G7 — the diff arm must be cheaper to observe. If it is not, the arms are
  // mislabelled somewhere upstream of everything else in this report.
  const dChars = diff.obsChars.reduce((a, b) => a + b, 0) / Math.max(1, diff.n);
  const uChars = redump.obsChars.reduce((a, b) => a + b, 0) / Math.max(1, redump.n);
  if (diff.n && redump.n && dChars >= uChars) {
    infra.push(
      `G7: the diff arm observed ${Math.round(dChars)} chars/episode against the re-dump arm's ` +
        `${Math.round(uChars)}. The cheaper arm is not the diff arm — the labels are wrong.`,
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

  console.log('\nObservation cost:');
  console.log(`  diff arm   : ${Math.round(dChars)} chars/episode  (${fmtPct(diffShare)} of observations were diffs)`);
  console.log(`  re-dump arm: ${Math.round(uChars)} chars/episode`);
  console.log(`  ratio      : ${uChars ? (dChars / uChars).toFixed(2) : '—'}x`);

  console.log('\nFailure attribution (acts, by arm):');
  const attrD = tally(diff.rows, 'attributions');
  const attrU = tally(redump.rows, 'attributions');
  for (const k of new Set([...Object.keys(attrD), ...Object.keys(attrU)])) {
    console.log(`  ${k.padEnd(20)} diff ${String(attrD[k] ?? 0).padStart(4)}   re-dump ${String(attrU[k] ?? 0).padStart(4)}`);
  }
  console.log(
    `  ${'(of those, within 2 steps of a FULL SNAPSHOT)'.padEnd(20)} diff ` +
      `${diff.rows.reduce((a, r) => a + r.postResyncFailures, 0)}   re-dump ${redump.rows.reduce((a, r) => a + r.postResyncFailures, 0)}`,
  );

  console.log('\nCost:');
  console.log(`  diff arm   : $${diff.cost.toFixed(4)} over ${diff.n} episodes ($${(diff.cost / Math.max(1, diff.n)).toFixed(4)}/episode)`);
  console.log(`  re-dump arm: $${redump.cost.toFixed(4)} over ${redump.n} episodes ($${(redump.cost / Math.max(1, redump.n)).toFixed(4)}/episode)`);
  console.log(`  total      : $${(diff.cost + redump.cost).toFixed(4)}`);

  if (infra.length) return bail(EXIT.INFRA, 'INFRASTRUCTURE GUARD FAILED — no verdict:', infra);
  if (vacuous.length) return bail(EXIT.VACUOUS, 'VACUOUS RUN — no verdict:', vacuous);

  // ---- the preregistered comparison ------------------------------------
  const sCI = propDiffCI(diff.successes, diff.n, redump.successes, redump.n);
  const wCI = meanDiffCI(diff.wrong, redump.wrong);
  const sD = wilson(diff.successes, diff.n);
  const sU = wilson(redump.successes, redump.n);

  console.log('\n' + '-'.repeat(72));
  console.log(`success  diff    : ${diff.successes}/${diff.n} = ${fmtPct(sD.p)}  [${fmtPct(sD.lo)}, ${fmtPct(sD.hi)}]`);
  console.log(`success  re-dump : ${redump.successes}/${redump.n} = ${fmtPct(sU.p)}  [${fmtPct(sU.lo)}, ${fmtPct(sU.hi)}]`);
  console.log(`success  delta   : ${fmtSigned(sCI.delta)}  95% CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}]   (Newcombe)`);
  console.log(`wrong-el diff    : ${wCI.m1.toFixed(3)}/run`);
  console.log(`wrong-el re-dump : ${wCI.m2.toFixed(3)}/run`);
  console.log(`wrong-el delta   : ${wCI.delta >= 0 ? '+' : ''}${wCI.delta.toFixed(3)}/run  95% CI [${wCI.lo.toFixed(3)}, ${wCI.hi.toFixed(3)}]   (bootstrap, seeded)`);
  console.log('-'.repeat(72));

  const mde = smallestDetectableDrop(diff.n, redump.n, sU.p, PARITY_SUCCESS_MARGIN);
  console.log(
    `\nPower, honestly: at n=${diff.n}/${redump.n} and a re-dump rate of ${fmtPct(sU.p)}, the smallest\n` +
      `true drop this run could distinguish from the parity margin is about ${fmtPct(mde)}.\n` +
      'Per-task numbers above are directional colour, not findings.',
  );

  // G8 — the hard floor on N.
  if (diff.n < N_FLOOR || redump.n < N_FLOOR) {
    return bail(EXIT.INCONCLUSIVE, 'G8: below the hard floor of N=5 per arm. This is a PILOT, not a result:', [
      `diff n=${diff.n}, re-dump n=${redump.n}. The loop is exercised; the comparison is not evidence.`,
    ]);
  }

  // G10 — the ceiling. Two perfect arms cannot demonstrate parity.
  if (sD.p >= 0.98 && sU.p >= 0.98) {
    return bail(EXIT.INCONCLUSIVE, 'G10: CEILING. Both arms are at or above 98%:', [
      'A task set both arms solve every time cannot detect a diff-bookkeeping penalty even',
      'if one exists. This licenses no claim. Make the tasks harder or the model smaller.',
    ]);
  }

  const parity = sCI.lo >= PARITY_SUCCESS_MARGIN && wCI.hi <= PARITY_WRONG_MARGIN;
  const regression = sCI.hi < PARITY_SUCCESS_MARGIN || wCI.lo > PARITY_WRONG_MARGIN;

  if (parity) {
    console.log('\nRESULT: PARITY (exit 0)');
    console.log(
      '\nWhat this licenses, and nothing more:\n' +
        `  "On this ${tasks.length}-task fixture suite, with ${opts.model}, agents observing via diffs\n` +
        `   completed tasks ${fmtSigned(sCI.delta)} as often as agents observing via full re-dumps\n` +
        `   (95% CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}]), with ${wCI.delta >= 0 ? '+' : ''}${wCI.delta.toFixed(2)} wrong-element actions per run\n` +
        `   (95% CI [${wCI.lo.toFixed(2)}, ${wCI.hi.toFixed(2)}]), at ${(dChars / uChars).toFixed(2)}x the observation cost."\n` +
        '  It says nothing about other models, real websites, longer tasks, larger pages,\n' +
        '  the budget-truncation regime, browser_read workflows, or iframes.',
    );
    return EXIT.PARITY;
  }
  if (regression) {
    return bail(EXIT.REGRESSION, 'RESULT: REGRESSION — diffs cost the agent something real:', [
      `success delta CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}] against a margin of ${fmtSigned(PARITY_SUCCESS_MARGIN)}`,
      `wrong-element delta CI [${wCI.lo.toFixed(3)}, ${wCI.hi.toFixed(3)}] against a margin of +${PARITY_WRONG_MARGIN}`,
    ]);
  }
  return bail(EXIT.INCONCLUSIVE, 'RESULT: INCONCLUSIVE — the intervals do not decide it:', [
    `success delta CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}], margin ${fmtSigned(PARITY_SUCCESS_MARGIN)}`,
    `wrong-element delta CI [${wCI.lo.toFixed(3)}, ${wCI.hi.toFixed(3)}], margin +${PARITY_WRONG_MARGIN}`,
    'This licenses no README claim. More episodes, or a harder suite.',
  ]);
}

main()
  .then((c) => process.exit(c ?? EXIT.INFRA))
  .catch((e) => {
    console.error('\nRUNNER FAILED:', e?.stack ?? e);
    process.exit(EXIT.INFRA);
  });
