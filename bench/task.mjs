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
 * USAGE
 *   npm run bench:task -- --selftest          G1+G2 only. Spends NO API budget.
 *   npm run bench:task -- --tasks a,b --n 2   a small scored pilot
 *   npm run bench:task                        the full preregistered suite
 *
 * EXIT CODES — nonzero must never be read as "roughly green"
 *   0 PARITY · 1 REGRESSION · 2 INCONCLUSIVE · 3 INFRA · 4 VACUOUS · 5 SELFTEST
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { TASKS, FIXTURES, taskById } from './tasks.mjs';
import { startCollector, settle, COLLECTOR_PORT } from './lib/collector.mjs';
import { startProxy, PROXY_PORT } from './lib/proxy.mjs';
import { propDiffCI, meanDiffCI, wilson, smallestDetectableDrop, fmtPct, fmtSigned } from './lib/stats.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE_DIR = join(ROOT, 'bench', 'fixtures');
const FIXTURE_PORT = 8899;
const APERTURE_PORT = 8817;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

export const EXIT = { PARITY: 0, REGRESSION: 1, INCONCLUSIVE: 2, INFRA: 3, VACUOUS: 4, SELFTEST: 5 };

// The verdict rule, written down before the first scored run and not touched
// since. Both must hold for PARITY.
const PARITY_SUCCESS_MARGIN = -0.05; // success-delta CI lower bound >= this
const PARITY_WRONG_MARGIN = 0.2; // wrong-element-delta CI upper bound <= this
const N_FLOOR = 5;

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
    selftest: false, n: 20, tasks: null, arms: ['diff', 'redump'],
    model: 'claude-sonnet-5', keepAlive: false, verbose: false,
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
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
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

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else child.kill('SIGTERM');
  } catch {
    /* best effort */
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
async function runEpisode({ proxy, collector, task, arm, driver, index }) {
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
    index,
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
        proxy, collector, task, arm, index: 0, driver: scriptedDriver(proxy, task),
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasks = opts.tasks ? opts.tasks.map(taskById) : TASKS;

  console.log('# Task-success benchmark — diffs vs full re-dumps\n');
  console.log(`tasks   : ${tasks.length} (${tasks.map((t) => t.id).join(', ')})`);
  console.log(`fixtures: ${FIXTURES.length}`);
  console.log(`mode    : ${opts.selftest ? 'SELFTEST (G1+G2 only, no API budget)' : `scored, N=${opts.n}/task/arm, arms=${opts.arms.join('+')}`}`);
  console.log(`model   : ${opts.model}`);
  console.log(`prompt  : sha256 ${createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 16)}\n`);

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
    const rows = [];
    const total = tasks.length * opts.n * opts.arms.length;
    let i = 0;
    for (const task of tasks) {
      for (let k = 0; k < opts.n; k++) {
        for (const arm of opts.arms) {
          i++;
          const r = await runEpisode({
            proxy, collector, task, arm, index: k, driver: agentDriver(proxy, task, opts),
          });
          rows.push(r);
          console.log(
            `[${String(i).padStart(3)}/${total}] ${task.id.padEnd(20)} ${arm.padEnd(7)} ` +
              `${r.success ? 'PASS' : 'fail'}  wrong=${r.wrongElement} steps=${r.steps} ` +
              `obs=${r.kinds.full}F/${r.kinds.diff}D/${r.kinds.nochange}N/${r.kinds.other}? · ${r.obsChars}ch · $${r.costUsd.toFixed(4)} · ${(r.durationMs / 1000).toFixed(0)}s` +
              (r.driverError ? `  ERROR: ${r.driverError.slice(0, 80)}` : ''),
          );
        }
      }
    }

    code = report(rows, opts, tasks);
    return code;
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    await fixtures.close().catch(() => {});
    await collector.close().catch(() => {});
    if (aperture && !opts.keepAlive) killTree(aperture.child);
  }
}

function report(rows, opts, tasks) {
  const diff = summarise(rows, 'diff');
  const redump = summarise(rows, 'redump');

  console.log('\n' + '='.repeat(72));
  console.log('RESULTS');
  console.log('='.repeat(72));

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
