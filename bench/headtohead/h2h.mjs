/**
 * Head-to-head: Aperture vs Playwright MCP — the runner.
 *
 * Implements docs/design/headtohead.md, as amended by docs/design/tier4.md §7.
 * Every load-bearing call was made in the design document; this file executes
 * them and refuses where it cannot.
 *
 * WHAT IT MEASURES (§0): for a user choosing how to give an LLM a browser, does
 * Aperture's diff-based observation beat the incumbent, and on which axis —
 * reliability (witness-scored task success), precision (wrong-element actions),
 * economics (dollars per episode, per page-size class). Wall-clock is reported
 * and verdicts nothing (§2).
 *
 * THE PHILOSOPHICAL DIFFERENCE FROM bench/task.mjs, AND IT CHANGES THE EXIT
 * CODES: this suite is TWO-SIDED. A competitor win is exit 0. MEASURED means
 * the preregistered questions were answered, whichever way they came out.
 * Nonzero still must never be read as "roughly fine".
 *
 * EXIT CODES
 *   0 MEASURED · 3 INFRA · 4 VACUOUS · 5 SELFTEST · 6 INTEGRITY · 7 HARNESS-FAULT
 *
 * USAGE
 *   npm run bench:h2h -- --plan        the phase plan and cost projections. No infra.
 *   npm run bench:h2h -- --dry         module/schema/mapping self-test. No infra, no browser.
 *   npm run bench:h2h -- --selftest    ALL preflights H0-H5 (+H2b). Live infra, $0 budget.
 *   npm run bench:h2h -- --phase 1     the $4 kill shot. SPENDS BUDGET.
 *   npm run bench:h2h -- --report      score the store, run nothing.
 *
 * PORTS (§8). Aperture 8817, fixtures 8899, collector 8898 — all hardcoded and
 * shared with the task suite, which is why this suite is port-gated behind it.
 * The h2h proxy is 8894, deliberately NOT 8896, so a stray process from either
 * suite cannot be mistaken for the other's.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { TASKS as HOME_TASKS } from '../tasks.mjs';
import { NEUTRAL_TASKS, NEUTRAL_FIXTURES, sizeVerdict } from './neutralTasks.mjs';
import { BULK_WORDS } from './fixtures/make-fixtures.mjs';
import { lintAll } from './lint-fixtures.mjs';

import { startCollector, settle, COLLECTOR_PORT, dedupeActions } from '../lib/collector.mjs';
import { APERTURE_PORT, killTree, portIsOpen, runStamp, startAperture } from '../lib/aperture.mjs';
import { redumpImpurities } from '../task.mjs';
import { propDiffCI, meanDiffCI, mean, mulberry32, fmtPct, fmtSigned } from '../lib/stats.mjs';

import {
  H2H_ACT_DESCRIPTION, H2H_ARM_DEFINITION, H2H_DONE_DESCRIPTION, H2H_PROXY_PORT,
  PW_ARMS, APERTURE_ARMS, SEALED_ARMS, PW_STOCK_WITHHELD, PW_STOCK_KEPT,
  startH2hProxy, PW_OBSERVATION_MODES, HARNESS_ERROR_PREFIX, isHarnessFault,
  PW_BUDGET_TOKENS_NOTICE,
} from './lib/proxy.mjs';
import {
  chromiumBuild, launchFlagsFor, PW_PINNED_VERSION, pwPackageVersion, pwScratchDir, startPw,
} from './lib/pwUpstream.mjs';
import * as aria from './lib/ariaModel.mjs';
import { resolveLabel as apertureResolveLabel } from './lib/solve.mjs';
import {
  appendEpisode, archiveStore, buildH2hIdentity, checkH2hIntegrity, cohortPathFor,
  defaultH2hStorePath, h2hEpisodeKey, loadCohort, loadStore, stampH2hEpisode, writeCohort,
} from './lib/h2hStore.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const NEUTRAL_DIR = join(HERE, 'fixtures');
const HOME_DIR = join(ROOT, 'bench', 'fixtures');
const RESULTS = join(HERE, 'results');
const FIXTURE_PORT = 8899;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

export const EXIT = {
  MEASURED: 0, INFRA: 3, VACUOUS: 4, SELFTEST: 5, INTEGRITY: 6, HARNESS_FAULT: 7,
};

export const ARMS = ['aperture-diff', 'aperture-redump', 'pw-sealed', 'pw-stock'];

/** §7.1's preregistered thresholds, stamped onto every episode. */
export const VERDICT_RULE = {
  reliability: 'success delta (aperture-diff − pw-sealed), Newcombe 95% CI, pooled over ALL tasks; non-inferiority bound −10pp',
  precision: 'wrong-element delta CI upper ≤ +0.2/run',
  economics: 'cost ratio aperture-diff/pw-sealed per size class, seeded-bootstrap 90% CI; headline requires the neutral-large CI entirely below 1.0',
  mechanism: 'H10: MECHANISM CONFIRMED only if observation bytes explain ≥50% of the cost delta',
  ceiling: 'H12: both headline arms ≥98% pooled success ⇒ INCONCLUSIVE-by-ceiling; only economics survives',
  floor: 'H11: any (task,class) cell where BOTH headline arms succeed <50% is excluded from cost claims',
  contamination:
    'H11 floor, second clause: any task cell in which ANY arm has an apparatus_contaminated episode is ' +
    'excluded from EVERY claim — reliability, precision, economics and decomposition alike, not only cost, ' +
    'and regardless of success rates. The surviving episodes of a contaminated arm are the ones that ' +
    'happened to stay under the SDK cap, which is to say the CHEAPEST ones; scoring what is left would ' +
    'read a survivorship artefact as a result. The exclusion is printed and the arm is named.',
};

/**
 * C1 — THE CAP THE HARNESS MUST SET, AND THE ONE NUMBER IN THIS FILE THAT
 * DECIDES WHETHER THE MODEL SEES THE PAGE AT ALL.
 *
 * The SDK reads `MAX_MCP_OUTPUT_TOKENS` from the environment. Over that ceiling
 * it does not truncate the MCP tool result and it does not pass it on — it
 * REJECTS IT WHOLESALE and hands the model a ~1.3KB error instead, telling it
 * the output was saved to a file and to go read it with offset/limit and jq.
 * The agent under test has no filesystem tools. So the arm was billed for a
 * page it was never shown, `obsChars` recorded the bytes the proxy returned,
 * and the episode looked like a competitor that read half a megabyte and still
 * failed. Four episodes on record say exactly that (catalog-order, both pw arms,
 * runs 0 and 1).
 *
 * Left unset, the ceiling is a 25,000-token default that a remote gate can also
 * move underneath a running cohort. MEASURED: catalog-order's pw-sealed snapshot
 * — the largest LEGITIMATE observation any arm produces — is 87,009 chars, i.e.
 * ~21,750 tokens at 4 chars/token and ~25,000 at the 3.5 chars/token that aria
 * YAML actually runs closer to. That is not "inside the default": it is ON the
 * default, to within the error of the estimate, which is precisely why some
 * catalog-order episodes were eaten and the smaller fixtures were not. A
 * benchmark whose largest fixture straddles a ceiling nobody set is not
 * measuring page size; it is measuring how close the fixture got to a number the
 * harness never chose.
 *
 * 50,000 puts ~2.3x headroom over that observation — the response would have to
 * average under 1.75 chars per token to be refused, which no tokenizer does. It is
 * SET EXPLICITLY, THE SAME VALUE IN EVERY ARM, stamped into the cohort identity
 * and printed in H0. Same value everywhere is not a nicety: a cap that differed
 * by arm would silently delete the competitor's observation channel and call the
 * result a win.
 */
export const MAX_MCP_OUTPUT_TOKENS = 50000;

/**
 * C2(b) — THE OVER-CAP REJECTION, AS THE SDK ACTUALLY SPELLS IT.
 *
 * Reconstructed from the pinned SDK's own bundle rather than guessed, because a
 * detector written from a memory of an error message is a detector that goes
 * quietly stale. The over-cap path formats one of two strings, and they share a
 * head and a tail that no page content produces:
 *
 *   persisted     `Error: result (445,509 characters across 8,912 lines) exceeds
 *                  maximum allowed tokens. Output has been saved to <path>.
 *                  Format: Plain text …`
 *   persist-failed `Error: result (445,509 characters) exceeds maximum allowed
 *                  tokens. Failed to save output to file: … If this MCP server
 *                  provides pagination or filtering tools, use them …`
 *
 * A third path (large-output-files disabled, or image content) truncates instead
 * and appends `[OUTPUT TRUNCATED - exceeded 25000 token limit]`. That one is
 * still a delivered-vs-returned lie — the model got a prefix and `obsChars`
 * recorded the whole thing — so it is detected too.
 *
 * MATCHED AGAINST THE TOOL RESULT THE MODEL RECEIVED, never against what the
 * proxy sent: the SDK echoes each turn's `tool_result` blocks back on the stream
 * as a `user` message, and that content is the post-substitution bytes. This is
 * the only place in the apparatus where "delivered" is observable at all.
 */
export const SDK_MCP_CAP_REJECTION =
  /Error: result \([\d,]+ characters(?: across [\d,]+ lines?)?\) exceeds maximum allowed tokens\./;
export const SDK_MCP_CAP_TRUNCATION = /\[OUTPUT TRUNCATED - exceeded \d+ token limit\]/;

/** null when the text is a real observation; otherwise which cap path ate it. */
export function sdkMcpCapVerdict(text) {
  if (typeof text !== 'string') return null;
  if (SDK_MCP_CAP_REJECTION.test(text)) return 'rejected';
  if (SDK_MCP_CAP_TRUNCATION.test(text)) return 'truncated';
  return null;
}

/**
 * §3.3: the existing SYSTEM_PROMPT from bench/task.mjs, byte-identical across
 * the three sealed arms. H4 re-extracts it from bench/task.mjs's source and
 * byte-compares — a copy that drifts from its original is exactly the class of
 * defect this suite's headers keep warning about.
 */
const SYSTEM_PROMPT_SEALED = [
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

/**
 * §3.3's minimal truthful variant for `pw-stock`. The tool sentence is
 * replaced; "Act on elements by their ref (the eN codes)" is RETAINED because
 * it is true — Playwright's refs are eN too. The asymmetry is inherent to
 * measuring a different surface and the report states it.
 */
const SYSTEM_PROMPT_STOCK = [
  'You are operating a web browser to complete a task for a user.',
  '',
  'You have a set of browser tools and task_done. There is no filesystem, no',
  'shell and no other tool. The page is the',
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

const systemPromptFor = (arm) => (arm === 'pw-stock' ? SYSTEM_PROMPT_STOCK : SYSTEM_PROMPT_SEALED);

const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// The task set: home (imported, never copied) + neutral
// ---------------------------------------------------------------------------

/**
 * §4.1: "the 7 wave-2 tasks (bench/tasks.mjs TASKS), byte-identical, imported
 * not copied."
 *
 * SPEC DEFECT, IMPLEMENTED THE ONLY WAY IT CAN BE: `TASKS` is no longer the
 * wave-2 seven. tier3/wave3 retired four of them into `RETIRED` and added two
 * new ones, so `TASKS` today holds five. The spec's OPERATIVE instruction is
 * "bench/tasks.mjs TASKS, imported not copied" and that is what happens here;
 * the count 7 was descriptive of 2026-08-01. Every count the report prints is
 * derived from `HOME_TASKS.length`, never hardcoded, so "a 13-task suite"
 * becomes whatever the suite actually is and cannot silently become a lie.
 */
export const HOME = HOME_TASKS.map((t) => ({ ...t, class: 'home' }));
export const ALL_TASKS = [...HOME, ...NEUTRAL_TASKS];

const CLASSES = ['home', 'neutral-small', 'neutral-large'];

/** §6 H6: ONE shared budget table. Same maxSteps and maxTurns in all arms. */
export function budgetFor(task) {
  return { maxSteps: task.maxSteps, maxTurns: task.maxSteps + 6 };
}

/**
 * §6 H6: aperture arms on LARGE fixtures get budgetTokens 20000 injected on
 * every act and snapshot. The default 2000-token budget would truncate a
 * large-page full, and a truncated page is not the page — Playwright has no
 * budget to truncate, so leaving the default in would be measuring our budget
 * against their page.
 */
export function injectFor(task, arm) {
  if (!APERTURE_ARMS.has(arm)) return null;
  return task.class === 'neutral-large' ? { budgetTokens: 20000 } : null;
}

// ---------------------------------------------------------------------------
// Infrastructure the runner owns end to end
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/**
 * One fixture server, TWO roots.
 *
 * §8 says the served roots cannot cross, and they do not: a request resolves
 * against the neutral root first and the home root second, and the only name
 * present in both is `bench.js`, which H5 proves byte-identical. `no-store` is
 * load-bearing — the task suite measured an edited fixture in its OLD form
 * once, and printed a verdict about the one on disk.
 */
async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0].replace(/^\/+/, '');
    for (const root of [NEUTRAL_DIR, HOME_DIR]) {
      const file = join(root, path);
      if (!file.startsWith(root)) continue;
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store, no-cache, must-revalidate',
        });
        res.end(body);
        return;
      } catch {
        /* try the other root */
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(FIXTURE_PORT, '127.0.0.1', ok);
  });
  return { close: () => new Promise((r) => server.close(() => r())) };
}

async function waitForLoad(collector, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (collector.loaded()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

/** One episode: navigate, run a driver, then judge from the WITNESS alone. */
async function runEpisode({ proxy, collector, task, arm, driver, runIndex }) {
  collector.reset();
  const b = budgetFor(task);
  const ep = proxy.newEpisode({
    maxSteps: b.maxSteps,
    allowed: task.allowed,
    taskId: task.id,
    inject: injectFor(task, arm),
  });
  await proxy.navigate(`${BASE}/${task.fixture}?benchrun=${Date.now()}`);
  const loaded = await waitForLoad(collector);

  const t0 = Date.now();
  let driverError = null;
  let sdk = null;
  try {
    sdk = await driver(ep);
  } catch (e) {
    driverError = e instanceof Error ? e.message : String(e);
    // §F7: a run that threw still cost money. The SDK driver banks its usage as
    // the stream arrives and exposes it here; without this every failed episode
    // reported $0.00 and 0 turns, which understates the spend against the $130
    // cap in exactly the situation — a systematic fault — where the spend is
    // running away fastest. The scripted driver has no `.usage`, so it keeps
    // yielding null and its rows are unchanged.
    sdk = driver.usage?.() ?? null;
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

  const kinds = { full: 0, diff: 0, nochange: 0, other: 0, error: 0, header: 0, link: 0, empty: 0 };
  for (const o of ep.observations) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;

  const attributions = {};
  for (const a of ep.acts) attributions[a.attribution] = (attributions[a.attribution] ?? 0) + 1;

  const sectionChars = {};
  for (const o of ep.observations) {
    if (!o.sections) continue;
    for (const [k, v] of Object.entries(o.sections)) sectionChars[k] = (sectionChars[k] ?? 0) + v;
  }

  // §5.1 / §4.3: mustObserve is checked against the DIFF-ONLY stream in the
  // aperture-diff arm (as today) and against the CONCATENATED observation
  // stream in the pw arms — each product's own observation channel, on its own
  // terms.
  const diffStream = ep.observations
    .filter((o) => o.kind === 'diff' || o.kind === 'nochange')
    .map((o) => o.text)
    .join('\n');
  const fullStream = ep.observations.map((o) => o.text).join('\n');

  const row = {
    task: task.id,
    class: task.class,
    arm,
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
    sectionChars: Object.keys(sectionChars).length ? sectionChars : null,
    obsSeq: ep.observations.map((o) => (o.tool === 'browser_act' ? 'a' : 's') + ':' + o.kind),
    attributions,
    acts: ep.acts,
    toolFaults: ep.toolFaults,
    nonRefTargeting: ep.nonRefTargeting,
    snapshotLinksUnresolved: ep.snapshotLinksUnresolved,
    snapshotAbsent: ep.snapshotAbsent,
    budgetTokensRefused: ep.budgetTokensRefused ?? 0,
    unclassified: ep.observations
      .filter((o) => o.kind === 'other')
      .map((o) => ({ tool: o.tool, head: o.text.slice(0, 240) })),
    upstreamMs: ep.upstreamMs,
    costUsd: sdk?.costUsd ?? 0,
    inputTokens: sdk?.inputTokens ?? 0,
    outputTokens: sdk?.outputTokens ?? 0,
    cacheRead: sdk?.cacheRead ?? 0,
    cacheCreate: sdk?.cacheCreate ?? 0,
    modelKeys: sdk?.modelKeys ?? [],
    turns: sdk?.turns ?? 0,
    sdkSubtype: sdk?.subtype ?? null,
    durationMs: Date.now() - t0,
    failureClass: null, // filled by H9 below
    /** C2(b)+(c): null when the model read what the proxy returned. */
    apparatusContaminated: null,
    diffStream,
    fullStream,
  };

  // C2 — POST-EPISODE RECONCILIATION. Last, because it reads the finished row:
  // the detector's evidence comes off the SDK stream, the arithmetic off the
  // row's own token totals, and neither is available any earlier.
  row.apparatusContaminated = contaminationOf(row, sdk?.capRejections ?? []);
  return row;
}

/**
 * maxTurns exhaustion, as the SDK spells it when it raises rather than returns.
 *
 * It is NOT a fault. An agent that used its whole turn budget and did not
 * finish is a competitor outcome — the most ordinary failure there is — and
 * burying it in `tool_fault` both hides a real loss and inflates H9's fault
 * rate with episodes where nothing broke. `error_max_turns` is matched too, in
 * case the SDK starts returning the result instead of throwing on it.
 */
const MAX_TURNS_EXHAUSTED = /(reached maximum number of turns|error_max_turns)/i;

/**
 * Failure classes that mean THE APPARATUS FAILED, not the arm. None may be
 * scored, and H9 counts all of them against the 10% ceiling.
 *
 * `apparatus_contaminated` joins them under C4. It is not a failure in the
 * ordinary sense — a contaminated episode can even SUCCEED, and two of the four
 * on record did — which is exactly why it has to be here rather than left as an
 * annotation. Its cost, its turn count and its `obsChars` are all statements
 * about an apparatus that swapped the observation for an error, and every one of
 * them would otherwise be averaged into a headline.
 */
export const HARNESS_CLASSES = new Set(['tool_fault', 'harness_fault', 'apparatus_contaminated']);

/**
 * C2(c) — THE ARITHMETIC THAT CATCHES WHAT THE DETECTOR MISSES.
 *
 * `sdkMcpCapVerdict` matches a string the SDK owns and may reword. This does
 * not: it asks whether the bytes the proxy says it returned could possibly have
 * become the tokens the API says it billed.
 *
 * Every observation the model receives is new context, so it must be paid for as
 * `inputTokens + cacheCreate` — cache READS are re-reads of context banked on an
 * earlier turn and would double-count. The ratio obsChars / new-context-tokens
 * therefore has a hard ceiling: no tokenizer averages more than a handful of
 * characters per token on aria YAML or Aperture diffs, and the denominator also
 * carries the system prompt, the tool schemas and every assistant message, none
 * of which contribute to the numerator. It can only be pushed DOWN by real work.
 *
 * MEASURED over the 86 uncontaminated episodes of the pilot cohort, the ratio
 * spans 0.24 to 2.28. The four contaminated ones sit at 7.85, 9.18, 17.18 and
 * 49.47 — the numerator counts a snapshot the denominator never paid for. A
 * ceiling of 4.0 is 1.75x above the highest honest episode and 2x below the
 * lowest contaminated one, which is as wide a moat as the data offers.
 *
 * Two guards keep it from firing on episodes it cannot speak about: a scripted
 * or never-billed run has no denominator at all, and below ~10K observed chars
 * the fixed prompt-and-schema overhead dominates the denominator so hard that
 * the ratio cannot reach the ceiling for any reason, honest or otherwise.
 */
export const CHARS_PER_NEW_CONTEXT_TOKEN_CEILING = 4;
const RECONCILE_MIN_OBS_CHARS = 10000;

export function observationBytesReconciliation(r) {
  const newContextTokens = (r.inputTokens ?? 0) + (r.cacheCreate ?? 0);
  if (!newContextTokens) return null;
  if ((r.obsChars ?? 0) < RECONCILE_MIN_OBS_CHARS) return null;
  const ratio = r.obsChars / newContextTokens;
  if (ratio <= CHARS_PER_NEW_CONTEXT_TOKEN_CEILING) return null;
  return {
    ratio,
    obsChars: r.obsChars,
    newContextTokens,
    ceiling: CHARS_PER_NEW_CONTEXT_TOKEN_CEILING,
    why:
      `${r.obsChars} observed chars against ${newContextTokens} new-context tokens is ` +
      `${ratio.toFixed(1)} chars/token, over the ${CHARS_PER_NEW_CONTEXT_TOKEN_CEILING} ceiling. ` +
      'Those bytes were returned by the proxy; they were not billed, so they were not delivered.',
  };
}

/**
 * C2(b)+(c) — build the episode's contamination record, or null if it is clean.
 *
 * Two independent witnesses, deliberately: the detector reads the SDK's own
 * words, the reconciliation reads the API's own arithmetic. Either alone is
 * enough to disqualify the episode. Keeping both means a reworded SDK error
 * cannot make the contamination invisible, and a contamination the arithmetic
 * cannot resolve (a small over-cap result) is still named.
 */
export function contaminationOf(r, capRejections = []) {
  const reasons = [];
  if (capRejections.length) {
    reasons.push({
      reason: 'sdk_mcp_output_cap',
      count: capRejections.length,
      verdicts: [...new Set(capRejections.map((c) => c.verdict))],
      sample: capRejections[0].text,
    });
  }
  const recon = observationBytesReconciliation(r);
  if (recon) reasons.push({ reason: 'chars_per_token_implausible', ...recon });
  if (!reasons.length) return null;
  return {
    reasons,
    obsChars: r.obsChars,
    /**
     * THE ANNOTATION C2 EXISTS FOR. `obsChars` is not wrong — it is the honest
     * count of what the proxy put on the wire — but on a contaminated episode it
     * is NOT what the model read, and every downstream consumer of it (H10's
     * decomposition, the per-arm obs-chars column, the cost-per-byte story)
     * silently assumes it is.
     */
    obsCharsMeaning:
      'RETURNED, NOT DELIVERED — obsChars counts the bytes this proxy returned to the SDK. ' +
      'The SDK replaced at least one of those tool results with an over-cap error before the ' +
      'model saw it, so obsChars overstates what was observed by an unknown amount and may not ' +
      'be used in any claim.',
  };
}

/**
 * §6 H9: every failed episode is classified from the WITNESS and the reply
 * stream, never from what the agent said it did.
 *
 * THE ZERO-CONTACT RULE IS FIRST AND IT IS THE ONE THAT MATTERS. `steps === 0`
 * means the proxy's tool handler was never entered — not once, in the whole
 * episode. `upstreamMs === 0` means no engine did any work. `obsChars === 0`
 * means the agent was shown nothing. An episode with all three did not touch
 * the apparatus at any point, and there is NO reading of that where the arm
 * under test lost a fair contest. `task_wrong` was precisely the wrong answer:
 * 22 pw-stock episodes carried it while the real story was a server returning
 * 500 to every `initialize`, and because `task_wrong` is a scoreable competitor
 * outcome the store looked like a crushing win rather than a broken harness.
 *
 * A conceivable false positive — an agent that legitimately refuses and calls
 * nothing — is worth accepting: it is rare, and misfiling it as a harness fault
 * costs one excluded episode, while misfiling the other direction costs the
 * whole verdict.
 */
export function classifyFailure(r) {
  /**
   * C4 — CONTAMINATION FIRST, AND IT OUTRANKS SUCCESS.
   *
   * Every other branch below asks what the ARM did. This one asks whether the
   * episode measured the arm at all, and when the answer is no there is nothing
   * left for the other branches to classify: the agent was answering a different
   * question from the one the harness thinks it asked. Placed above the success
   * check on purpose — a contaminated episode that PASSED is the dangerous one,
   * because nothing about it looks wrong until its cost lands in a mean.
   */
  if (r.apparatusContaminated) return 'apparatus_contaminated';
  // Anything this harness originated, said in its own voice (§9's prefix rule).
  if (typeof r.driverError === 'string' && isHarnessFault(r.driverError)) return 'harness_fault';
  if (!r.success && r.steps === 0 && r.obsChars === 0 && r.upstreamMs === 0) return 'harness_fault';
  if (r.toolFaults > 0) return 'tool_fault';
  if (r.driverError) {
    // The split. Transport and shim exceptions are ours; a spent turn budget is
    // the competitor's, and it SCORES.
    if (!MAX_TURNS_EXHAUSTED.test(r.driverError)) return 'tool_fault';
    if (r.success) return null; // finished the work, then ran out of turns
    return 'gave_up';
  }
  if (r.success) return null;
  if (r.declaredDone || r.capHits > 0) return 'gave_up';
  return 'task_wrong';
}

/**
 * The deterministic solver, per arm.
 *
 * H3's rule is absolute and it is the direct answer to "what if Playwright
 * fails a task our harness cannot score fairly": ANY failure here is presumed a
 * harness or shim defect, not a competitor defect. A configuration our own
 * scripted driver cannot pass is disqualified from scoring anyone.
 */
function scriptedDriver(proxy, task, arm, wire = null) {
  return async () => {
    /**
     * THE FIRST CALL OF EVERY SCRIPTED EPISODE GOES OVER THE REAL TRANSPORT.
     *
     * `proxy.direct.*` is the tool implementation invoked in-process. It proves
     * the SHIM works and proves nothing whatsoever about the SERVER — not the
     * registration, not the schema conversion, not the session factory, not the
     * transport. H3 is the guard that certifies an arm fit to score, and an arm
     * certified entirely through `direct` is an arm certified against a code
     * path no agent will ever take. pw-stock passed H3 that way while its
     * server 500'd on `initialize`.
     *
     * One call is enough — everything the wire can break, it breaks at
     * `initialize`/`tools/list`/the first `tools/call`. The rest of the solve
     * stays direct so the scripted timings remain comparable to every episode
     * already on record.
     */
    let pending = wire;
    const direct = (name, args) => {
      if (arm === 'pw-stock') return proxy.direct.stock(name, args);
      if (name === 'browser_snapshot') return proxy.direct.snapshot(args);
      if (name === 'browser_act') return proxy.direct.act(args);
      throw new Error(`the scripted solver has no direct path for ${name}`);
    };
    const call = async (name, args) => {
      if (!pending) return direct(name, args);
      const w = pending;
      pending = null; // once per episode; degrade to direct afterwards
      return wireText(await w.callTool({ name, arguments: args }));
    };

    if (arm === 'pw-stock') {
      await call('browser_snapshot', {});
      for (const step of task.solve) {
        const r = aria.resolveLabel(proxy.episode().model, step);
        if (r.error) throw new Error(`step ${step.act} "${step.label}": ${r.error}`);
        const out =
          step.act === 'type'
            ? await call('browser_type', { target: r.ref, text: step.text })
            : await call('browser_click', { target: r.ref });
        if (/^### Error$/m.test(out)) {
          throw new Error(`step ${step.act} "${step.label}" errored: ${out.slice(0, 300)}`);
        }
        // pw's plain fill emits no snapshot at all (0.0.78: browser_type only
        // calls setIncludeSnapshot when submit or slowly is set), so the model
        // must be refreshed before the next label resolves. The AGENT is not
        // given this crutch; the scripted solver needs it to prove the task is
        // mechanically solvable at all, which is H3's whole job.
        if (!aria.isPwFull(out)) await call('browser_snapshot', {});
      }
      proxy.direct.done('scripted solver');
      return null;
    }

    await call('browser_snapshot', { mode: 'full' });
    for (const step of task.solve) {
      const model = proxy.episode().model;
      const resolve_ = (m) =>
        PW_ARMS.has(arm) ? aria.resolveLabel(m, step) : apertureResolveLabel(m, step);
      let r = resolve_(model);
      // THE EXPAND ROUND-TRIP, and it is a product behaviour, not a workaround.
      // Aperture's renderer elides a run of five or more same-shape siblings
      // (render.ts COLLAPSE_RUN) — a 1-to-5 star rating group is exactly five,
      // so `star-4` and `star-5` are behind `… 2 more`. §4.3's own note on T2
      // rules on this in advance: "if it costs an expand round-trip, that cost
      // is real and belongs in the number." The scripted solver therefore pays
      // it the way an agent would have to, rather than pretending the element
      // was addressable all along. Caught by H2b, which measured the two
      // engines doing DIFFERENT physical work on identical scripts.
      if (r.error && !PW_ARMS.has(arm)) {
        await proxy.direct.snapshot({ mode: 'full', expand: true });
        r = resolve_(proxy.episode().model);
      }
      if (r.error) throw new Error(`step ${step.act} "${step.label}": ${r.error}`);
      const args =
        step.act === 'type'
          ? { action: 'type', ref: r.ref, text: step.text }
          : { action: step.act, ref: r.ref };
      const out = await proxy.direct.act(args);
      const errored = PW_ARMS.has(arm) ? /^### Error$/m.test(out) : /^error:/m.test(out);
      if (errored) throw new Error(`step ${step.act} "${step.label}" errored: ${out.slice(0, 300)}`);
      if (PW_ARMS.has(arm) && !aria.isPwFull(out)) await proxy.direct.snapshot({ mode: 'full' });
    }
    proxy.direct.done('scripted solver');
    return null;
  };
}

const SCRATCH = join(HERE, '.agent-cwd');

/**
 * C2(b) — every `tool_result` text the SDK put in front of the model this turn.
 *
 * Exported and pure so the detector can be exercised for $0 against a
 * reconstructed cap rejection. A detector that has only ever been run against
 * the happy path is a detector that has never been run.
 */
export function toolResultTexts(message) {
  const content = message?.message?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const c = block.content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) for (const b of c) if (typeof b?.text === 'string') out.push(b.text);
  }
  return out;
}

/**
 * §F7 — consume an SDK message stream, banking usage AS IT ARRIVES.
 *
 * The old code tallied after the loop, off the final `result`. `for await`
 * rethrows whatever the stream raises, so on any error path the tally never ran
 * and the episode was recorded at $0.00 and 0 turns — for turns that were
 * really billed. Two episodes on record say exactly that: 12 steps, 623,568
 * observed chars, `$0`. A systematic failure would have looked FREE in the
 * budget line while it ate the $130 cap.
 *
 * The accumulator is the caller's object, mutated in place, so it survives the
 * rethrow. The `finally` still prefers the `result` frame's own totals when one
 * arrived: the SDK enqueues that frame BEFORE it raises on a nonzero exit, so
 * even a maxTurns run hands over its real dollars, and the per-message tally is
 * the floor rather than the answer.
 *
 * Separated from `agentDriver` so it can be exercised for $0 against a fake
 * stream — a driver that only works when it is billing is a driver nobody
 * checks.
 */
export async function drainSdkStream(q, acc) {
  let result = null;
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        acc.mcpServers = m.mcp_servers ?? [];
      } else if (m.type === 'user') {
        // C2(b): DELIVERED, not returned. The proxy knows what it handed the
        // SDK; only this frame knows what the SDK handed the model.
        for (const text of toolResultTexts(m)) {
          const verdict = sdkMcpCapVerdict(text);
          if (!verdict) continue;
          acc.capRejections.push({ verdict, text: text.slice(0, 400), chars: text.length });
        }
      } else if (m.type === 'assistant') {
        const u = m.message?.usage ?? {};
        const model = m.message?.model;
        if (model && !acc.modelKeys.includes(model)) acc.modelKeys.push(model);
        acc.inputTokens += u.input_tokens ?? 0;
        acc.outputTokens += u.output_tokens ?? 0;
        acc.cacheRead += u.cache_read_input_tokens ?? 0;
        acc.cacheCreate += u.cache_creation_input_tokens ?? 0;
        acc.turns++;
      } else if (m.type === 'result') {
        result = m;
      }
    }
  } finally {
    if (result) {
      const usage = Object.values(result.modelUsage ?? {});
      const sum = (k) => usage.reduce((a, u) => a + (u?.[k] ?? 0), 0);
      acc.costUsd = result.total_cost_usd ?? 0;
      acc.modelKeys = Object.keys(result.modelUsage ?? {});
      acc.inputTokens = sum('inputTokens');
      acc.outputTokens = sum('outputTokens');
      acc.cacheRead = sum('cacheReadInputTokens');
      acc.cacheCreate = sum('cacheCreationInputTokens');
      acc.turns = result.num_turns ?? 0;
      acc.subtype = result.subtype ?? null;
    }
  }
  return acc;
}

/**
 * §F4 — did the agent actually get the browser? Returns null when it did, or
 * the reason it did not.
 *
 * The SDK's `init` message reports every configured MCP server's connection
 * status and then the run proceeds regardless of what it says. That report is
 * the ONLY runtime signal that separates "the arm under test failed the task"
 * from "the arm under test was never handed any tools", and for 22 episodes and
 * ~$4 nobody read it. `browser` absent, or in any status but `connected`, means
 * the episode measured nothing.
 *
 * Pure and exported so it can be tested for $0. The path that matters is the
 * rejecting one, and an SDK run costs money to produce.
 */
export function browserServerProblem(mcpServers) {
  if (!Array.isArray(mcpServers)) {
    return 'the SDK never announced an init message, so whether the agent had any tools ' +
      'at all is unknown. An unverifiable episode does not score.';
  }
  const browser = mcpServers.find((s) => s?.name === 'browser');
  if (!browser || browser.status !== 'connected') {
    return `the agent's MCP server "browser" was ${browser ? `"${browser.status}"` : 'ABSENT'} at ` +
      `init (servers: ${JSON.stringify(mcpServers)}). The episode ran with NO browser tools; its ` +
      'result is a fact about this harness, not about the arm under test.';
  }
  return null;
}

/**
 * The environment every arm's SDK subprocess runs under.
 *
 * Pure and exported so C1 can be CHECKED FOR $0. The cap it sets decides whether
 * the largest fixture reaches the model or is replaced by an error, which makes
 * it as load-bearing as any pin in H0 — and an SDK run costs money to produce,
 * so a cap that could only be verified by billing one would never be verified.
 */
export function sdkEnv(base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY; // measured: the SDK uses Claude Code's own auth
  /**
   * C1 — SET, NOT INHERITED, AND THE SAME IN EVERY ARM.
   *
   * Assigned AFTER the spread so an operator's shell value cannot move the
   * cohort's ceiling out from under it: this number is part of the experiment's
   * identity, and an experiment whose identity is whatever was exported in the
   * terminal is not an experiment.
   */
  env.MAX_MCP_OUTPUT_TOKENS = String(MAX_MCP_OUTPUT_TOKENS);
  return env;
}

/**
 * The SDK driver — `bench/task.mjs`'s `agentDriver`, arm-parameterised.
 *
 * TWO THINGS IT DOES THAT THE ORIGINAL DID NOT, both learned from the pw-stock
 * incident:
 *
 *  - IT CHECKS THAT THE AGENT ACTUALLY GOT THE BROWSER (§F4). The SDK announces
 *    every MCP server's connection status in its `init` message and then carries
 *    on regardless if one failed. 22 pw-stock episodes ran to completion against
 *    a server that 500'd on `initialize`; the SDK knew, said so in a message
 *    nobody read, and the harness scored the results as though the competitor
 *    had merely failed the task. An episode whose tools never arrived is not an
 *    outcome — it is a harness fault, and it now says so.
 *
 *  - IT KEEPS THE MONEY ON THE ERROR PATH (§F7). Usage is accumulated as the
 *    stream arrives rather than read off the final `result`, and is reachable
 *    through `.usage()` even when the run throws. The old code recorded $0.00
 *    for any episode whose SDK call raised — so the two maxTurns episodes on
 *    record show $0 spent for turns that were really billed, and a systematic
 *    failure would have looked FREE in the budget line while it burned the cap.
 */
function agentDriver(proxy, task, arm, opts) {
  /**
   * Reachable by `runEpisode` after a throw. Populated as the stream arrives,
   * overwritten by the authoritative `result` totals if one shows up.
   */
  const acc = {
    costUsd: 0,
    modelKeys: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    turns: 0,
    subtype: null,
    /** null = never announced; otherwise the SDK's own init report. */
    mcpServers: null,
    /** C2(b): tool results the SDK refused to deliver over the MCP output cap. */
    capRejections: [],
  };

  const run = async () => {
    if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
    writeFileSync(join(SCRATCH, '.gitignore'), '*\n');

    const env = sdkEnv();

    const allowed = proxy
      .registeredTools()
      .map((t) => `mcp__browser__${t.name}`);

    const q = query({
      prompt: task.prompt,
      options: {
        model: opts.model,
        systemPrompt: systemPromptFor(arm), // plain string = full replacement
        settingSources: [],
        allowedTools: allowed,
        disallowedTools: [
          'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch',
          'WebSearch', 'NotebookEdit', 'TodoWrite', 'Task',
        ],
        permissionMode: 'dontAsk',
        maxTurns: budgetFor(task).maxTurns,
        cwd: SCRATCH,
        env,
        // Named `browser` in EVERY arm (§3.2): the tool ids are
        // mcp__browser__* and the model never sees a product name.
        mcpServers: {
          browser: {
            type: 'http',
            url: proxy.url,
            headers: { Authorization: `Bearer ${proxy.token}` },
          },
        },
      },
    });

    await drainSdkStream(q, acc);

    // §F4 — RUNTIME DETECTION. It fires AFTER the accounting above, so a
    // rejected episode still records what it really cost.
    const why = browserServerProblem(acc.mcpServers);
    if (why) throw new Error(HARNESS_ERROR_PREFIX + why);

    return acc;
  };

  run.usage = () => acc;
  return run;
}

// ---------------------------------------------------------------------------
// Arm lifecycle
// ---------------------------------------------------------------------------

/**
 * Start whatever an arm needs, run `fn`, and tear it down whatever happens.
 * One Playwright server per arm per run (§8) — per-episode process churn would
 * put a browser cold start inside one arm's wall-clock and not the other's.
 */
async function withArm(arm, ctx, fn) {
  let pw = null;
  let proxy = null;
  try {
    if (PW_ARMS.has(arm)) {
      const out = pwScratchDir(ctx.stamp, arm);
      mkdirSync(out, { recursive: true });
      pw = await startPw({
        arm,
        outputDir: out,
        logPath: join(RESULTS, `pw.${ctx.stamp}.${arm}.log`),
        browserOverride: ctx.opts.pwBrowser,
      });
      proxy = await startH2hProxy({
        arm, collector: ctx.collector, pw, pwOutputDir: out,
        pwObservation: ctx.opts.pwObservation,
      });
    } else {
      proxy = await startH2hProxy({
        arm, collector: ctx.collector,
        aperture: { url: `http://127.0.0.1:${APERTURE_PORT}/mcp`, token: ctx.apertureToken },
      });
    }
    return await fn(proxy, pw);
  } finally {
    if (proxy) await proxy.close();
    if (pw) await pw.close();
  }
}

/**
 * A REAL MCP client on a proxy's REAL transport — the same handshake, headers
 * and JSON-RPC the agent's SDK performs.
 *
 * WHY THIS EXISTS, AND IT IS THE MOST EXPENSIVE LESSON IN THIS SUITE. Every
 * `$0` check in this file used to reach the tool implementations through
 * `proxy.direct.*`, which is the handler function called in-process. That path
 * cannot see anything the SERVER does: registration, schema conversion, the
 * session factory, the transport. `createMcpHandler` builds its server LAZILY,
 * once per connecting session, so a registration that throws is invisible until
 * a client connects — and no preflight ever connected one. pw-stock therefore
 * passed H0-H5 green, was certified, and ran 22 scored episodes at ~$4 against
 * a server that 500'd on `initialize`, with the agent holding zero tools the
 * whole time. Nothing in the harness could tell that from a hard task.
 *
 * So: preflights connect for real now. An arm is never certified through
 * `direct` alone.
 */
async function openWire(proxy, who = 'guard') {
  const client = new Client({ name: `aperture-h2h-${who}`, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(proxy.url), {
    requestInit: { headers: { Authorization: `Bearer ${proxy.token}` } },
  });
  await client.connect(transport);
  return client;
}

async function withWire(proxy, fn) {
  const client = await openWire(proxy);
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      /* the session is going away regardless */
    }
  }
}

/** A wire `tools/call`, flattened to the text `proxy.direct.*` would return. */
const wireText = (res) =>
  (res?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');

// ---------------------------------------------------------------------------
// Preflights H0 - H5. They spend NO API budget.
// ---------------------------------------------------------------------------

/**
 * Pull a string constant out of another module's SOURCE, without importing it
 * and without editing it to add an export.
 *
 * This exists because §3.3 says `task_done`'s description and the system prompt
 * are "the existing ones, unchanged" — a claim that is worth nothing unless
 * something checks it. Editing bench/lib/proxy.mjs or bench/task.mjs to export
 * them would move the TASK SUITE's codeVersion and invalidate a running cohort,
 * so the check reads the bytes instead. Handles the two literal forms those
 * files use: `'a' + 'b' + …;` and `[ 'a', 'b' ].join('\n');`.
 */
export function extractStringConst(source, name) {
  const start = source.indexOf(`const ${name} =`);
  if (start < 0) return null;
  const end = source.indexOf(';', start);
  if (end < 0) return null;
  const body = source.slice(start, end);
  const parts = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body))) parts.push(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
  if (!parts.length) return null;
  if (/\]\s*\.join\('\\n'\)/.test(body)) {
    // the trailing '\n' of .join is itself a literal — drop it
    return parts.slice(0, -1).join('\n');
  }
  return parts.join('');
}

/** H0 — the pin check. Mismatch with an existing store is INTEGRITY. */
async function guardH0(ctx) {
  const problems = [];
  const notes = [];
  const version = pwPackageVersion();
  notes.push(`  @playwright/mcp        ${version}   (pinned ${PW_PINNED_VERSION})`);
  if (version !== PW_PINNED_VERSION) {
    problems.push(
      `H0 — @playwright/mcp is ${version}, the cohort pins ${PW_PINNED_VERSION}. Version drift is a ` +
        'named preflight, not a silent upgrade: reinstall the pin inside bench/headtohead/.',
    );
  }
  const chromium = chromiumBuild();
  notes.push(`  chromium               rev ${chromium.revision} (${chromium.browserVersion}) via playwright-core ${chromium.playwrightCore}`);
  notes.push(`  aperture buildVersion  ${ctx.identity.buildVersion}`);
  notes.push(`  aperture codeVersion   ${ctx.identity.codeVersion}   (bench/headtohead/** + both fixture dirs)`);

  /**
   * C1 — THE CAP, PRINTED BEFORE ANYTHING ELSE IS BELIEVED.
   *
   * H0 exists to show a human every pin the cohort depends on. This one decides
   * whether the model is shown the page or an error telling it to read a file,
   * and until this batch it was not pinned, not printed and not stamped.
   */
  notes.push(
    `  MAX_MCP_OUTPUT_TOKENS  ${MAX_MCP_OUTPUT_TOKENS}   (SET by the harness in every arm's SDK env; ` +
      'above this the SDK REJECTS an MCP tool result wholesale)',
  );
  notes.push(
    '                         largest legitimate observation MEASURED 87,009 chars (catalog-order, pw-sealed) ' +
      `≈ 21.8K-25K tokens → ~${(MAX_MCP_OUTPUT_TOKENS / 22000).toFixed(1)}x headroom.`,
  );
  notes.push(
    '                         Unset, the ceiling is a 25,000-token default a remote gate can move — i.e. ON ' +
      'that observation, which is what ate four episodes.',
  );
  if (ctx.identity.maxMcpOutputTokens !== MAX_MCP_OUTPUT_TOKENS) {
    problems.push(
      `H0 — the cohort identity stamps maxMcpOutputTokens ${JSON.stringify(ctx.identity.maxMcpOutputTokens)} ` +
        `but the runner sets ${MAX_MCP_OUTPUT_TOKENS}. The value the episodes are stamped with must be the ` +
        'value the agents ran under, or the stamp is decoration.',
    );
  }

  // The launch flags are byte-compared against §3.2/§3.4, which is the only way
  // a flag that drifted can be told from a flag that was always wrong.
  for (const arm of ['pw-sealed', 'pw-stock']) {
    const flags = launchFlagsFor(arm, '<scratch>');
    notes.push(`  ${arm.padEnd(22)} ${flags.join(' ')}`);
  }
  if (ctx.opts.pwBrowser) {
    notes.push('');
    notes.push(`  !! --browser OVERRIDDEN to "${ctx.opts.pwBrowser}". The spec pins chromium; the`);
    notes.push('     override is recorded on the cohort and printed in every report.');
  }

  // §3.3's "unchanged" claims, checked against the originals' bytes.
  const proxySrc = readFileSync(join(ROOT, 'bench', 'lib', 'proxy.mjs'), 'utf8');
  const taskSrc = readFileSync(join(ROOT, 'bench', 'task.mjs'), 'utf8');
  const done = extractStringConst(proxySrc, 'DONE_DESCRIPTION');
  const sys = extractStringConst(taskSrc, 'SYSTEM_PROMPT');
  if (done !== H2H_DONE_DESCRIPTION) {
    problems.push(
      'H0 — task_done\'s description is NOT byte-identical to bench/lib/proxy.mjs\'s DONE_DESCRIPTION.\n' +
        `      h2h : ${JSON.stringify(H2H_DONE_DESCRIPTION)}\n` +
        `      task: ${JSON.stringify(done)}`,
    );
  } else notes.push('  task_done description  byte-identical to bench/lib/proxy.mjs');
  if (sys !== SYSTEM_PROMPT_SEALED) {
    problems.push(
      'H0 — the sealed system prompt is NOT byte-identical to bench/task.mjs\'s SYSTEM_PROMPT.\n' +
        `      h2h : ${JSON.stringify(SYSTEM_PROMPT_SEALED)}\n` +
        `      task: ${JSON.stringify(sys)}`,
    );
  } else notes.push('  sealed system prompt   byte-identical to bench/task.mjs');

  // H6's first half, checkable for free: the budget table is ONE table and it
  // is a function of the task alone, so "same maxSteps and maxTurns per task in
  // all arms" is true by construction rather than by discipline. Printed so a
  // reader can see the numbers rather than trust the sentence.
  notes.push('  budget table (H6 — arm-independent by construction):');
  for (const t of ALL_TASKS) {
    const b = budgetFor(t);
    const inj = ARMS.map((arm) => injectFor(t, arm)).filter(Boolean)[0];
    notes.push(
      `    ${t.id.padEnd(18)} ${t.class.padEnd(14)} maxSteps ${String(b.maxSteps).padStart(2)} · ` +
        `maxTurns ${String(b.maxTurns).padStart(2)}` +
        (inj ? ` · aperture inject ${JSON.stringify(inj)}` : ''),
    );
  }
  notes.push(`  prompt hashes          sealed ${sha16(SYSTEM_PROMPT_SEALED)} · stock ${sha16(SYSTEM_PROMPT_STOCK)}`);
  notes.push(`  act description        ${sha16(H2H_ACT_DESCRIPTION)}`);
  notes.push(`  done description       ${sha16(H2H_DONE_DESCRIPTION)}`);
  return { problems, notes };
}

/**
 * H1 — response-shape probe. Drive one scripted act per pw arm and RECORD THE
 * ACTUAL BYTES. The report's appendix must show what each arm's agent read,
 * not what a design document said it would read.
 */
async function guardH1(ctx) {
  const problems = [];
  const notes = [];
  const appendix = {};

  for (const arm of ['pw-sealed', 'pw-stock']) {
    if (!ctx.opts.arms.includes(arm)) continue;
    await withArm(arm, ctx, async (proxy) => {
      proxy.newEpisode({ maxSteps: 20, allowed: ['notifications'], taskId: '__h1' });
      ctx.collector.reset();
      await proxy.navigate(`${BASE}/account-prefs.html?h1=${Date.now()}`);
      await waitForLoad(ctx.collector, 8000);

      const snapText = arm === 'pw-stock'
        ? await proxy.direct.stock('browser_snapshot', {})
        : await proxy.direct.snapshot({ mode: 'full' });

      if (!aria.hasSnapshotSection(snapText)) {
        problems.push(`H1 — ${arm}: browser_snapshot returned no "### Snapshot" section. --snapshot-mode full is not live.`);
      }
      const model = proxy.episode().model;
      const hit = [...model.entries()].find(([, e]) => e.label === 'Enable notifications');
      if (!hit) {
        problems.push(`H1 — ${arm}: the aria model holds no "Enable notifications" checkbox; the reader or the flags are wrong.`);
        return;
      }
      const actText = arm === 'pw-stock'
        ? await proxy.direct.stock('browser_click', { target: hit[0] })
        : await proxy.direct.act({ action: 'click', ref: hit[0] });

      const shape = aria.snapshotYaml(actText);
      const kind = aria.classifyPwObservation(actText);
      const ep = proxy.episode();
      notes.push(
        `  ${arm.padEnd(11)} act reply: ${actText.length} chars · kind=${kind} · snapshot form=${shape?.form ?? 'ABSENT'}` +
          ` · links resolved by the harness: ${ep.snapshotLinksResolved}/${ep.observations.length}` +
          (ep.snapshotLinksUnresolved ? ` · UNREADABLE ${ep.snapshotLinksUnresolved}` : ''),
      );

      // THE 0.0.78 FINDING, reported whether or not the rescue worked. §1.1
      // says the snapshot is embedded; it is written to a file and linked.
      // With --pw-observation inline the harness reconstructs the response the
      // design of record measures, and that reconstruction is a DEVIATION that
      // has to be visible in every run, not a quiet fix.
      if (ep.snapshotLinksResolved > 0) {
        notes.push('');
        notes.push(`  !! ${arm}: ${ep.snapshotLinksResolved} of ${ep.observations.length} upstream replies arrived with the aria`);
        notes.push('     snapshot WRITTEN TO A FILE and referenced by link, not embedded. headtohead.md');
        notes.push('     §1.1 states the opposite, from response.ts at main; the pinned 0.0.78 bundle');
        notes.push('     branches to a file whenever _includeSnapshot !== "explicit", which is every');
        notes.push('     action tool (coreBundle.js:64833). The agent under test has no filesystem, so');
        notes.push(`     the mode in force here (--pw-observation ${ctx.opts.pwObservation}) decides whether the pw arms`);
        notes.push('     measure a competitor that shows the model the page, or one that shows it a path.');
        notes.push('     BOTH are defensible experiments. They are not the same experiment, they cannot');
        notes.push('     pool, and a human has to rule before any budget is spent.');
        notes.push('');
      }
      if (ep.snapshotLinksUnresolved > 0) {
        problems.push(
          `H1 — ${arm}: ${ep.snapshotLinksUnresolved} snapshot link(s) could not be read from disk in ` +
            'inline mode. The pw arm would be scoring blind observations.',
        );
      }

      if (!aria.hasSnapshotSection(actText)) {
        problems.push(
          `H1 — ${arm}: the ACTION response carries NO "### Snapshot" section at all.\n` +
            '      headtohead.md §1.1 states that every action response embeds a full aria snapshot.\n' +
            '      That is not what 0.0.78 does. See the H1 FINDING block below.',
        );
      } else if (shape?.form === 'link') {
        problems.push(
          `H1 — ${arm}: the ACTION response LINKS its snapshot to a file instead of inlining it.\n` +
            `      ${shape.path}\n` +
            '      The agent under test has no filesystem, so this is an EMPTY observation.',
        );
      }

      // §3.2's codegen assert: pw-sealed must show no "Ran Playwright code".
      const hasCodegen = /^### Ran Playwright code$/m.test(actText);
      if (arm === 'pw-sealed' && hasCodegen) {
        problems.push('H1 — pw-sealed: "### Ran Playwright code" is present; --codegen none did not take.');
      }
      if (arm === 'pw-stock' && !hasCodegen) {
        notes.push('  pw-stock    NOTE: no "### Ran Playwright code" section on this reply — default codegen may not fire on every tool.');
      }

      // §3.2's stale-ref probe: act on a dead ref and capture the reply verbatim.
      const stale = arm === 'pw-stock'
        ? await proxy.direct.stock('browser_click', { target: 'e9999' })
        : await proxy.direct.act({ action: 'click', ref: 'e9999' });
      // §1.3 escape #4: a CSS selector passed where a ref belongs.
      const selector = arm === 'pw-stock'
        ? await proxy.direct.stock('browser_click', { target: 'button#save' })
        : await proxy.direct.act({ action: 'click', ref: 'button#save' });

      appendix[arm] = {
        snapshotReply: snapText.slice(0, 4000),
        actReply: actText.slice(0, 4000),
        staleRefReply: stale.slice(0, 800),
        selectorReply: selector.slice(0, 800),
        sections: aria.sectionChars(actText),
      };
      notes.push(`  ${arm.padEnd(11)} stale-ref reply: ${JSON.stringify(stale.slice(0, 140))}`);
      notes.push(`  ${arm.padEnd(11)} selector reply : ${JSON.stringify(selector.slice(0, 140))}`);
    });
  }
  return { problems, notes, appendix };
}

/**
 * H2 — the null agent, PER ENGINE. Every predicate false on the untouched page
 * AND the witness's `load` event arrives under Playwright's chromium with the
 * §3.2 launch flags. This is the guard that catches an `--allowed-origins` list
 * that silently starves the collector — §12's unverifiable item (6).
 */
async function guardH2(ctx, tasks) {
  const problems = [];
  const notes = [];
  for (const arm of ctx.opts.arms) {
    if (arm === 'aperture-redump') continue; // same engine as aperture-diff
    await withArm(arm, ctx, async (proxy) => {
      for (const task of tasks) {
        ctx.collector.reset();
        proxy.newEpisode({ maxSteps: 4, allowed: task.allowed, taskId: task.id });
        await proxy.navigate(`${BASE}/${task.fixture}?h2=${Date.now()}`);
        if (!(await waitForLoad(ctx.collector))) {
          problems.push(
            `H2 — ${task.id} [${arm}]: the fixture never reported to the collector. Under a pw arm ` +
              'this is very likely the --allowed-origins list starving the witness (127.0.0.1:8898).',
          );
          continue;
        }
        let passes = false;
        try {
          passes = task.success(ctx.collector.lastState()) === true;
        } catch (e) {
          problems.push(`H2 — ${task.id} [${arm}]: the predicate threw on the untouched page: ${e.message}`);
          continue;
        }
        if (passes) {
          problems.push(`H2 — ${task.id} [${arm}]: SUCCEEDS ON AN UNTOUCHED PAGE. The predicate does not measure the task.`);
        }
        notes.push(
          `  ${task.id.padEnd(18)} ${arm.padEnd(15)} witness load OK  predicate ${passes ? 'TRUE  <-- BAD' : 'FALSE'}`,
        );
      }
    });
  }
  return { problems, notes };
}

/**
 * H2b — witness parity. §5.4.
 *
 * The witness is the one component that must be beyond suspicion in a
 * cross-engine fight, and this probe is its passport: identical scripted work
 * through both engines must produce IDENTICAL deduped witness event lists
 * (type + bench + value sequences), exact match, else HARNESS-FAULT.
 */
const witnessSignature = (collector) =>
  dedupeActions(collector.rawActions()).map(
    (e) => `${e.detail?.type}|${e.detail?.bench}|${JSON.stringify(e.detail?.value ?? null)}`,
  );

async function guardH2b(ctx, tasks) {
  const problems = [];
  const notes = [];
  /** @type {Record<string, Record<string, string[]>>} */
  const byTask = {};

  for (const arm of ['aperture-diff', 'pw-sealed']) {
    if (!ctx.opts.arms.includes(arm)) continue;
    await withArm(arm, ctx, async (proxy) => {
      for (const task of tasks) {
        byTask[task.id] ??= {};
        try {
          await runEpisode({
            proxy, collector: ctx.collector, task, arm, runIndex: 0,
            driver: scriptedDriver(proxy, task, arm),
          });
        } catch (e) {
          problems.push(`H2b — ${task.id} [${arm}]: the scripted solver could not run: ${e?.message ?? e}`);
        }
        byTask[task.id][arm] = witnessSignature(ctx.collector);
      }
    });
  }

  for (const [id, arms] of Object.entries(byTask)) {
    const a = arms['aperture-diff'];
    const b = arms['pw-sealed'];
    if (!a || !b) continue;
    const same = a.length === b.length && a.every((x, i) => x === b[i]);
    if (!same) {
      problems.push(
        `H2b — ${id}: the two engines produced DIFFERENT deduped witness streams on identical work.\n` +
          `      aperture-diff (${a.length}): ${JSON.stringify(a)}\n` +
          `      pw-sealed     (${b.length}): ${JSON.stringify(b)}\n` +
          '      Predicates are supposed to be engine-agnostic. Until this matches, no cross-engine\n' +
          '      number means anything: the same physical work is not scoring the same.',
      );
    } else {
      notes.push(`  ${id.padEnd(18)} ${a.length} witness events, byte-identical across engines`);
    }
  }
  return { problems, notes };
}

/**
 * H3 — scripted-solver parity. THE LOAD-BEARING ONE.
 *
 * The deterministic solver must solve EVERY task in EVERY arm before a scored
 * episode runs, and every `mustObserve` must match the arm's own observation
 * stream. Any failure is presumed a harness/shim defect — exit 7, no verdict.
 */
async function guardH3(ctx, tasks) {
  const problems = [];
  const notes = [];
  const results = {};

  for (const arm of ctx.opts.arms) {
    await withArm(arm, ctx, async (proxy) => {
      // §F3: ONE REAL MCP SESSION PER ARM, and every task's first scripted call
      // travels over it. `proxy.direct.*` exercises the shim; only this
      // exercises the server the agent will actually talk to. An arm certified
      // without it is an arm certified against a path no episode takes — which
      // is how pw-stock was certified green while `initialize` returned 500.
      //
      // A connect failure here is not "H3 could not run": it is H3's finding,
      // and it is the load-bearing one.
      let wire = null;
      try {
        wire = await openWire(proxy, 'h3');
        notes.push(`  ${arm.padEnd(16)} live MCP session open — first scripted call of each task goes over the wire`);
      } catch (e) {
        problems.push(
          `H3 — [${arm}]: a REAL MCP client could not open a session on ${proxy.url}: ${e?.message ?? e}\n` +
            '      PRESUMED A HARNESS/SHIM DEFECT. Every scored episode reaches this arm through\n' +
            '      exactly this transport, so an arm that cannot be connected to cannot score anyone —\n' +
            '      however green the in-process `direct` path looks.',
        );
      }

      try {
        for (const task of tasks) {
          let r;
          try {
            r = await runEpisode({
              proxy, collector: ctx.collector, task, arm, runIndex: 0,
              driver: scriptedDriver(proxy, task, arm, wire),
            });
          } catch (e) {
            problems.push(`H3 — ${task.id} [${arm}]: the scripted solver threw: ${e?.message ?? e}`);
            return;
          }
          results[`${task.id}|${arm}`] = r;

          if (r.driverError) {
            problems.push(
              `H3 — ${task.id} [${arm}]: the scripted solver could not run: ${r.driverError}\n` +
                '      PRESUMED A HARNESS/SHIM DEFECT. A configuration our own driver cannot pass is\n' +
                '      disqualified from scoring anyone.',
            );
            continue;
          }
          if (!r.success) {
            problems.push(
              `H3 — ${task.id} [${arm}]: the scripted solver did NOT satisfy the predicate.\n` +
                `      state: ${JSON.stringify(ctx.collector.lastState())}`,
            );
          }
          // G5, unchanged: the witness must see exactly the work that was done.
          if (r.pageActions !== task.solve.length) {
            problems.push(
              `H3/G5 — ${task.id} [${arm}]: the solver performed ${task.solve.length} actions but the ` +
                `witness counted ${r.pageActions}. The apparatus is miscounting.`,
            );
          }
          if (r.wrongElement > 0) {
            problems.push(
              `H3 — ${task.id} [${arm}]: the scripted solver touched ${r.wrongElement} element(s) outside ` +
                'the allowed set — the allowed set is wrong, not the solver.',
            );
          }
          if (r.toolFaults > 0) {
            problems.push(`H3 — ${task.id} [${arm}]: ${r.toolFaults} shim-originated fault(s) during a scripted run.`);
          }

          // mustObserve, per arm, against that arm's own channel (§4.3, §5.1).
          if (arm === 'aperture-diff' && !task.mustObserve.test(r.diffStream)) {
            problems.push(
              `H3 — ${task.id}: mustObserve ${task.mustObserve} does NOT match the diff-only stream.\n` +
                '      The information that decides this task does not arrive via a diff.\n' +
                '    ---- diff-only stream ----\n' +
                r.diffStream.split('\n').map((l) => '    ' + l).join('\n').slice(0, 2000),
            );
          }
          if (arm === 'pw-sealed' && !task.mustObserve.test(r.fullStream)) {
            problems.push(
              `H3 — ${task.id}: mustObserve ${task.mustObserve} does NOT match the pw-sealed observation stream.\n` +
                '      The deciding information does not travel through Playwright\'s observation channel\n' +
                '      either, so the task cannot compare the two products\' channels at all.',
            );
          }
          if (task.streamAssert && arm === 'aperture-diff') {
            const why = task.streamAssert(r.diffStream, r);
            if (why) problems.push(`H3 — ${task.id}: streamAssert FAILED — ${why}`);
          }
          // H8, checked for free at preflight (the task suite's G3 discipline).
          if (arm === 'aperture-redump' && redumpImpurities(r.kinds) > 0) {
            problems.push(
              `H3/H8 — ${task.id}: the re-dump arm received ${redumpImpurities(r.kinds)} observation(s) ` +
                'that were not FULL SNAPSHOTs. A single-line `error:` reply carries no page representation ' +
                'and both arms can receive it identically; it is kind `error` and does not bear on purity ' +
                '(tier4.md §7.4). `other` DOES bear on it.',
            );
          }
          if (r.truncatedObs > 0) {
            problems.push(
              `H3/H6 — ${task.id} [${arm}]: ${r.truncatedObs} observation(s) were cut by the token budget. ` +
                'A truncated page is not the same page, and truncation does not fall equally on the arms.',
            );
          }
          notes.push(
            `  ${task.id.padEnd(18)} ${arm.padEnd(15)} ${r.success ? 'SOLVED' : 'FAILED'}  ` +
              `${String(r.steps).padStart(2)} steps · ${r.pageActions} page actions · ` +
              `obs ${r.kinds.full}F/${r.kinds.diff}D/${r.kinds.nochange}N/${r.kinds.header}H/` +
              `${r.kinds.link}L/${r.kinds.empty}_/${r.kinds.error}E/${r.kinds.other}? · ` +
              `${String(r.obsChars).padStart(6)} chars`,
          );
        }
      } finally {
        try {
          await wire?.close();
        } catch {
          /* the proxy is torn down by withArm regardless */
        }
      }
    });
  }

  // G7's spirit: on identical scripted work the diff arm must observe fewer
  // bytes than the re-dump arm. If it does not, the labels are on the wrong
  // arms and nothing downstream means anything.
  for (const task of tasks) {
    const d = results[`${task.id}|aperture-diff`];
    const u = results[`${task.id}|aperture-redump`];
    if (d && u && d.obsChars >= u.obsChars) {
      problems.push(
        `H3/G7 — ${task.id}: identical scripted work observed ${d.obsChars} chars in aperture-diff and ` +
          `${u.obsChars} in aperture-redump. The cheaper arm is not the diff arm.`,
      );
    }
  }
  return { problems, notes, results };
}

/**
 * H4 — arm-blindness fingerprint. The sealed arms' tools/list must be
 * byte-identical across aperture-* and pw-sealed EXCEPT the forwarded snapshot
 * description, which §3.3 rules asymmetric on purpose.
 *
 * AND — since the pw-stock incident — the LIVE-SURFACE check. See the block
 * marked THE CLASS DETECTOR below.
 */
async function guardH4(ctx) {
  const problems = [];
  const notes = [];
  const fingerprints = {};
  const toolsHash = {};

  for (const arm of ctx.opts.arms) {
    await withArm(arm, ctx, async (proxy, pw) => {
      const tools = proxy.registeredTools();
      fingerprints[arm] = {
        names: tools.map((t) => t.name).sort(),
        act: tools.find((t) => t.name === 'browser_act')?.description ?? null,
        done: tools.find((t) => t.name === 'task_done')?.description ?? null,
        snapshot: proxy.snapshotDescription(),
      };
      toolsHash[arm] = sha16(proxy.toolSurfaceFingerprint());
      const descChars = tools.reduce((a, t) => a + (t.description ?? '').length, 0);
      const schemaChars = tools.reduce((a, t) => a + (t.schemaChars ?? 0), 0);
      const overhead = descChars + schemaChars;
      fingerprints[arm].overheadChars = overhead;
      notes.push(
        `  ${arm.padEnd(16)} ${String(tools.length).padStart(2)} tools · toolsHash ${toolsHash[arm]} · ` +
          `${String(descChars).padStart(5)} desc + ${String(schemaChars).padStart(5)} schema chars ` +
          `= ~${Math.ceil(overhead / 4)} tokens of surface overhead per turn`,
      );
      notes.push(`    names: ${fingerprints[arm].names.join(', ')}`);
      notes.push(`    snapshot description hash ${sha16(fingerprints[arm].snapshot)}  (${fingerprints[arm].snapshot.length} chars)`);

      // ---------------------------------------------------------------------
      // THE CLASS DETECTOR.
      //
      // Everything above this line is `registeredTools()` — what this harness
      // BELIEVES it registered. It is assembled eagerly, in the proxy, from a
      // plain array; it is a statement of intent and it cannot fail. What the
      // agent actually gets is whatever `createMcpHandler`'s LAZY per-session
      // factory manages to build when a client connects. Those two are
      // different objects built at different times by different code, and
      // NOTHING used to compare them.
      //
      // That gap is not hypothetical: pw-stock's registration threw inside the
      // factory on every session (raw JSON Schema where a Standard Schema was
      // required), the server 500'd on `initialize`, `registeredTools()` went
      // on reporting 17 tools, H0-H5 went green, and 22 scored episodes ran at
      // ~$4 with the agent holding no tools at all — scored `task_wrong`, as
      // though Playwright had simply lost.
      //
      // A guard that has never been red is decoration. This one connects a real
      // client over the real transport and diffs. If it cannot connect, that IS
      // the finding.
      // ---------------------------------------------------------------------
      let live = null;
      try {
        live = await withWire(proxy, async (c) => (await c.listTools()).tools ?? []);
      } catch (e) {
        problems.push(
          `H4/LIVE — ${arm}: a REAL MCP client could not reach the tool surface at ${proxy.url}.\n` +
            `      ${e?.message ?? e}\n` +
            `      registeredTools() claims ${tools.length} tool(s) for this arm. The agent would have got NONE.\n` +
            '      The registration list is built EAGERLY and the server is built LAZILY, so a\n' +
            '      registration that throws is invisible until something connects. This is that check,\n' +
            '      and an arm that fails it is disqualified from scoring anyone.',
        );
      }
      if (live) {
        const wireNames = live.map((t) => t.name).sort();
        const localNames = tools.map((t) => t.name).sort();
        if (JSON.stringify(wireNames) !== JSON.stringify(localNames)) {
          const only = (a, b) => a.filter((n) => !b.includes(n));
          problems.push(
            `H4/LIVE — ${arm}: the LIVE tools/list disagrees with registeredTools().\n` +
              `      wire  (${wireNames.length}): ${wireNames.join(', ') || '(none)'}\n` +
              `      local (${localNames.length}): ${localNames.join(', ') || '(none)'}\n` +
              `      on the wire only: ${only(wireNames, localNames).join(', ') || '(none)'}\n` +
              `      registered only : ${only(localNames, wireNames).join(', ') || '(none)'}`,
          );
        }
        for (const t of live) {
          const mine = tools.find((x) => x.name === t.name);
          if (mine && (mine.description ?? '') !== (t.description ?? '')) {
            problems.push(
              `H4/LIVE — ${arm}: ${t.name}'s description differs between the wire and registeredTools(). ` +
                'H4 counts the local one and the model reads the wire one; they must be the same bytes.',
            );
          }
        }
        // §3.4's "forwarded VERBATIM", checked on the wire instead of asserted
        // in a comment. The fix for the registration bug wraps each schema for
        // the SDK; if that wrapping also changed what `tools/list` serves, the
        // arm would no longer be measuring stock Playwright's surface.
        if (arm === 'pw-stock' && pw) {
          const drifted = [];
          for (const t of live) {
            const up = pw.tools.find((u) => u.name === t.name);
            if (!up) continue;
            if (JSON.stringify(up.inputSchema) !== JSON.stringify(t.inputSchema)) drifted.push(t.name);
          }
          if (drifted.length) {
            problems.push(
              `H4/LIVE — pw-stock serves schemas that are NOT byte-identical to @playwright/mcp's own for: ` +
                `${drifted.join(', ')}. §3.4 forwards the shipped surface verbatim or it is not the shipped surface.`,
            );
          } else {
            notes.push('    served schemas byte-identical to @playwright/mcp\'s own (§3.4 verbatim, checked on the wire)');
          }
        }
        notes.push(`    LIVE tools/list over a real MCP session: ${live.length} tool(s) — agrees with registeredTools()`);
      }
    });
  }

  const sealed = ctx.opts.arms.filter((a) => SEALED_ARMS.has(a));
  for (let i = 1; i < sealed.length; i++) {
    const a = fingerprints[sealed[0]];
    const b = fingerprints[sealed[i]];
    if (!a || !b) continue;
    if (JSON.stringify(a.names) !== JSON.stringify(b.names)) {
      problems.push(`H4 — ${sealed[0]} and ${sealed[i]} register different tool NAMES: ${a.names} vs ${b.names}`);
    }
    if (a.act !== b.act) problems.push(`H4 — ${sealed[0]} and ${sealed[i]} disagree on browser_act's description.`);
    if (a.done !== b.done) problems.push(`H4 — ${sealed[0]} and ${sealed[i]} disagree on task_done's description.`);
  }
  if (ctx.opts.arms.includes('pw-stock') && fingerprints['pw-stock']) {
    const got = fingerprints['pw-stock'].names.filter((n) => n !== 'task_done');
    const missing = PW_STOCK_KEPT.filter((n) => !got.includes(n));
    const extra = got.filter((n) => !PW_STOCK_KEPT.includes(n));
    if (missing.length) notes.push(`  pw-stock KEPT-but-absent (not in this pw build): ${missing.join(', ')}`);
    if (extra.length) problems.push(`H4 — pw-stock registered tools outside the §3.4 kept set: ${extra.join(', ')}`);
    notes.push(`  pw-stock withheld (§3.4): ${Object.keys(PW_STOCK_WITHHELD).join(', ')}`);
  }
  return { problems, notes, fingerprints, toolsHash };
}

/**
 * H5 — fixture neutrality lint, size bands, and the padding-never-leaks assert.
 */
async function guardH5(ctx, h3results) {
  const { problems, notes } = lintAll();

  // Size bands, measured against the UNTRUNCATED Aperture full snapshot.
  if (ctx.opts.arms.includes('aperture-diff')) {
    await withArm('aperture-diff', ctx, async (proxy) => {
      for (const task of NEUTRAL_TASKS) {
        ctx.collector.reset();
        proxy.newEpisode({
          maxSteps: 4, allowed: task.allowed, taskId: task.id,
          inject: { budgetTokens: 20000 },
        });
        await proxy.navigate(`${BASE}/${task.fixture}?h5=${Date.now()}`);
        await waitForLoad(ctx.collector, 8000);
        const snap = await proxy.direct.snapshot({ mode: 'full' });
        const v = sizeVerdict(task.class, snap.length);
        const truncated = /more lines beyond budget/.test(snap);
        // R1, LIVE: the static linter cannot see JS-created controls, so the
        // uniqueness rule is checked here against the only place they exist.
        const labels = new Map();
        for (const line of snap.split('\n')) {
          const m = /^\s*(button|link|checkbox|radio|textbox|combobox|searchbox|tab|option) (e\d+) "([^"]*)"/.exec(line);
          if (!m) continue;
          labels.set(m[3], (labels.get(m[3]) ?? 0) + 1);
        }
        const dupes = [...labels.entries()].filter(([, n]) => n > 1);
        if (dupes.length) {
          problems.push(
            `H5/R1 — ${task.fixture}: ${dupes.length} accessible name(s) are shared by more than one ` +
              `interactive element in the live snapshot: ${dupes.slice(0, 4).map(([l, n]) => `"${l}" x${n}`).join(', ')}. ` +
              'The identical-sibling construction is banned in the neutral set (§4.2 rule 2).',
          );
        }
        if (truncated) {
          problems.push(`H5 — ${task.fixture}: the full snapshot is STILL budget-truncated at 20000 tokens.`);
        }
        if (!v.ok) {
          problems.push(
            `H5 — ${task.fixture} (${task.class}): full snapshot is ${v.tokens} tokens, outside the ` +
              `${v.band.minTokens}-${v.band.maxTokens} band §4.2 fixes for this class. ` +
              'Retune bench/headtohead/fixtures/make-fixtures.mjs SIZE_PLAN and log it in FIXTURE_CHANGELOG.md.',
          );
        }
        notes.push(
          `  ${task.fixture.padEnd(24)} ${String(snap.length).padStart(6)} chars = ` +
            `${String(v.tokens).padStart(5)} tokens  [${task.class}] ${v.ok ? 'in band' : 'OUT OF BAND'}`,
        );
      }
    });
  }

  // The padding-never-leaks assert, over H3's aperture-diff streams.
  for (const task of NEUTRAL_TASKS) {
    const r = h3results?.[`${task.id}|aperture-diff`];
    if (!r) continue;
    const leaked = BULK_WORDS.filter((w) => r.diffStream.includes(w));
    if (leaked.length) {
      problems.push(
        `H5 — ${task.id}: the diff stream names static padding (${leaked.slice(0, 3).join(', ')}). ` +
          'A diff that restates bulk is not measuring the diff mechanism, and the large-class ' +
          'economics number would be about the restatement instead.',
      );
    }
  }
  return { problems, notes };
}

// ---------------------------------------------------------------------------
// The phase plan (§9)
// ---------------------------------------------------------------------------

const PHASES = [
  { n: 0, what: 'build harness, fixtures, ALL preflights H0-H5 (+H2b)', episodes: 0, usd: 0, gate: 'any red → fix before money' },
  { n: 1, what: 'KILL SHOT: console-quota (T5, neutral-large), aperture-diff vs pw-sealed, N=3/arm', episodes: 6, usd: 4, gate: 'aperture mean cost ≥ 0.9x pw here ⇒ STOP-AND-DECIDE printed; a human decides' },
  { n: 2, what: 'pilot: every task x 4 arms x N=2', episodes: null, usd: 15, gate: 'projections from measured $/ep; H8/H9 rates; SHIM-SUSPECT scan' },
  { n: 3, what: 'fill: headline arms N=10, aperture-redump N=10, pw-stock N=5', episodes: null, usd: 72, gate: 'resumable, wave-major, append-per-episode' },
  { n: 4, what: 'report + verdict over the whole store', episodes: 0, usd: 0, gate: 'H10 decomposition mandatory' },
];

const PHASE3_N = { 'aperture-diff': 10, 'aperture-redump': 10, 'pw-sealed': 10, 'pw-stock': 5 };

function printPlan(ctx) {
  const nTasks = ALL_TASKS.length;
  const p2 = nTasks * ARMS.length * 2;
  const p3 = ALL_TASKS.reduce((a) => a, 0) || 0;
  const p3Total = ARMS.reduce((a, arm) => a + nTasks * PHASE3_N[arm], 0);

  console.log('\nPHASE PLAN — headtohead.md §9, cheapest disconfirming check first\n');
  console.log(`  task set: ${HOME.length} home (imported from bench/tasks.mjs) + ${NEUTRAL_TASKS.length} neutral = ${nTasks}`);
  console.log(`            classes: ${CLASSES.map((c) => `${c} ${ALL_TASKS.filter((t) => t.class === c).length}`).join(' · ')}`);
  console.log(`  arms:     ${ARMS.join(', ')}   (headline: aperture-diff vs pw-sealed)\n`);
  console.log('  phase  episodes   est. $   what');
  console.log('  -----  --------   ------   ----------------------------------------------------------');
  for (const ph of PHASES) {
    const eps = ph.n === 2 ? p2 : ph.n === 3 ? p3Total - p2 : ph.episodes;
    console.log(
      `  ${String(ph.n).padStart(5)}  ${String(eps ?? 0).padStart(8)}   ${('$' + ph.usd).padStart(6)}   ${ph.what}`,
    );
    console.log(`                            gate: ${ph.gate}`);
  }
  console.log(`\n  scored total (through phase 3): ${p3Total} episodes`);
  console.log('  BUDGET CAP $130. Degrade rule, fixed in §9 and not negotiable at run time:');
  console.log('    reduce aperture-redump large-class N to 6, then pw-stock large-class N to 3.');
  console.log('    Never drop an arm. Never drop a class. --force-budget requires a human saying so');
  console.log('    in the session, in words.');
  console.log('\n  COST MODEL behind the estimate, stated so it can be discounted (§9):');
  console.log('    wave 1 measured $0.11/ep on small fixtures for the aperture arms;');
  console.log('    pw small-class carries ~1.5-2x observation bytes + schema overhead → $0.13-0.18;');
  console.log('    pw large-class re-sends a 6-9k-token snapshot per action → $0.4-0.9 with SDK');
  console.log('    caching. That is the widest error bar in the table and the reason phase 2 exists.');
  console.log(`    Runtime: ~${p3Total} episodes at 25-90s ≈ 4-6 h scored, serial.\n`);
  console.log('  !! The §9 cost model assumes headtohead.md §1.1 — a full re-dump in every action');
  console.log('     response. H1 measures whether that is true of the pinned 0.0.78 before any');
  console.log('     money is spent. If it is not, the large-class projection is wrong in the');
  console.log('     competitor\'s favour and phase 1\'s gate is the place that finds out.\n');
}

// ---------------------------------------------------------------------------
// Reporting helpers used by --report (H8-H12)
// ---------------------------------------------------------------------------

export function armPurityProblems(rows) {
  const out = [];
  for (const r of rows) {
    if (r.arm === 'aperture-redump' && redumpImpurities(r.kinds) > 0) {
      out.push(`H8 — ${r.task} [${r.arm}] run ${r.runIndex}: ${redumpImpurities(r.kinds)} non-FULL observation(s).`);
    }
    if (PW_ARMS.has(r.arm) && (r.kinds.other ?? 0) > 0) {
      out.push(
        `H8 — ${r.task} [${r.arm}] run ${r.runIndex}: ${r.kinds.other} unclassified observation(s): ` +
          JSON.stringify(r.unclassified?.slice(0, 2) ?? []),
      );
    }
  }
  const diff = rows.filter((r) => r.arm === 'aperture-diff');
  if (diff.length) {
    const num = diff.reduce((a, r) => a + (r.kinds.diff ?? 0) + (r.kinds.nochange ?? 0), 0);
    const den = diff.reduce((a, r) => a + (r.kinds.full ?? 0) + (r.kinds.diff ?? 0) + (r.kinds.nochange ?? 0), 0);
    if (den && num / den < 0.6) {
      out.push(`H8/G4 — aperture-diff observed only ${(100 * num / den).toFixed(1)}% diffs (floor 60%).`);
    }
  }
  return out;
}

/** §6 H9: >10% of an arm's episodes faulting is exit 7 for the cohort. */
export function harnessFaultCheck(rows) {
  const out = [];
  for (const arm of ARMS) {
    const a = rows.filter((r) => r.arm === arm);
    if (!a.length) continue;
    const classes = a.map((r) => classifyFailure(r));
    const faults = classes.filter((c) => HARNESS_CLASSES.has(c)).length;
    const zero = classes.filter((c) => c === 'harness_fault').length;
    // C4: contamination counts toward the fault rate, and is named separately
    // because the fix is different — a shim fault is a bug in this file, a
    // contamination is the SDK deleting an observation between us and the model.
    const dirty = classes.filter((c) => c === 'apparatus_contaminated').length;
    if (faults / a.length > 0.1) {
      const detail = [
        zero ? `${zero} never reached the tool surface at all` : null,
        dirty ? `${dirty} apparatus_contaminated — the model was not shown what the proxy returned` : null,
      ].filter(Boolean);
      out.push(
        `H9 — ${arm}: ${faults}/${a.length} episodes (${(100 * faults / a.length).toFixed(0)}%) faulted in the ` +
          `shim, the transport or the apparatus${detail.length ? ` (${detail.join('; ')})` : ''}. ` +
          'A comparison whose failure mode is "the competitor scored zero ' +
          'because our shim broke" is worthless.',
      );
    }
  }
  /**
   * SHIM-SUSPECT, BOTH WAYS.
   *
   * It used to test one direction only — sealed dead where stock is alive —
   * which encodes an assumption about which side breaks. The one that actually
   * broke was the other one: pw-stock at 0% on every task while pw-sealed
   * scored 17/23, and this check looked straight past it because it was only
   * ever asked the opposite question. A detector that can only find the failure
   * you already imagined is not a detector.
   */
  for (const task of ALL_TASKS) {
    const s = rows.filter((r) => r.task === task.id && r.arm === 'pw-sealed');
    const k = rows.filter((r) => r.task === task.id && r.arm === 'pw-stock');
    if (!s.length || !k.length) continue;
    const sr = s.filter((r) => r.success).length / s.length;
    const kr = k.filter((r) => r.success).length / k.length;
    if (sr === 0 && kr >= 0.8) {
      out.push(
        `SHIM-SUSPECT — ${task.id}: pw-sealed 0% while pw-stock ${(100 * kr).toFixed(0)}%. ` +
          'Investigate before any verdict is printed.',
      );
    }
    if (kr === 0 && sr >= 0.8) {
      out.push(
        `SHIM-SUSPECT — ${task.id}: pw-stock 0% while pw-sealed ${(100 * sr).toFixed(0)}%. ` +
          'The two pw arms drive the SAME Playwright build; a total wipeout on one of them is a ' +
          'statement about the surface this harness built, not about the engine. ' +
          'Investigate before any verdict is printed.',
      );
    }
  }
  return out;
}

/**
 * Seeded bootstrap CI for the RATIO of two means — §7.1's economics interval.
 *
 * A ratio and not a difference, because the preregistered claim is "cost [R]x
 * as much per episode" and a difference in dollars is not comparable across
 * size classes. Seeded for the same reason every other interval in this repo
 * is: a benchmark whose verdict moves when you run it twice on identical
 * inputs is not evidence.
 */
export function meanRatioCI(xs, ys, { iters = 10000, seed = 20260802, alpha = 0.1 } = {}) {
  const m = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const ratio = m(ys) === 0 ? Infinity : m(xs) / m(ys);
  if (!xs.length || !ys.length) return { ratio, lo: -Infinity, hi: Infinity, m1: m(xs), m2: m(ys) };
  const rnd = mulberry32(seed);
  const out = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let a = 0;
    for (let k = 0; k < xs.length; k++) a += xs[(rnd() * xs.length) | 0];
    let b = 0;
    for (let k = 0; k < ys.length; k++) b += ys[(rnd() * ys.length) | 0];
    out[i] = b === 0 ? Infinity : (a / xs.length) / (b / ys.length);
  }
  out.sort((p, q) => p - q);
  return {
    ratio,
    lo: out[Math.floor((alpha / 2) * iters)],
    hi: out[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)],
    m1: m(xs),
    m2: m(ys),
  };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/**
 * H7 — model identity. The SET of served model keys must be identical across
 * arms. A cross-arm model mismatch is the single most flattering possible bug.
 */
export function modelIdentityCheck(rows) {
  const byArm = {};
  for (const r of rows) {
    byArm[r.arm] ??= new Set();
    for (const k of r.modelKeys ?? []) byArm[r.arm].add(k);
  }
  const sets = Object.entries(byArm).map(([arm, s]) => [arm, [...s].sort().join(',')]);
  const distinct = new Set(sets.map(([, v]) => v));
  if (distinct.size <= 1) return [];
  return [
    'H7 — the arms were not served by the same model set:\n' +
      sets.map(([a, v]) => `      ${a.padEnd(16)} ${v || '(none recorded)'}`).join('\n') +
      '\n      A cross-arm model mismatch is the single most flattering possible bug.',
  ];
}

/**
 * H10 — win-reason decomposition. THE guard the brief asked for by name.
 *
 * Splits the per-episode token delta into the named terms and computes what
 * share of the cost delta OBSERVATION BYTES — the claimed mechanism — explain.
 * `MECHANISM CONFIRMED` prints only at ≥50%. Below that the verdict still
 * stands but the report must lead with the actual explanation.
 *
 * Printed per task as well as pooled, because wave 1's lesson is baked in as a
 * rule: pooling hid a sign change once already, and a number right about the
 * aggregate and wrong about every subset is not a finding.
 */
export function decompose(rows, a, b, surfaceOverheadChars = {}) {
  const A = rows.filter((r) => r.arm === a);
  const B = rows.filter((r) => r.arm === b);
  if (!A.length || !B.length) return null;
  const m = (xs, f) => (xs.length ? xs.reduce((s, r) => s + f(r), 0) / xs.length : 0);

  const obsDelta = m(B, (r) => r.obsChars) - m(A, (r) => r.obsChars);
  const codegenDelta =
    m(B, (r) => r.sectionChars?.['Ran Playwright code'] ?? 0) -
    m(A, (r) => r.sectionChars?.['Ran Playwright code'] ?? 0);
  const turnsDelta = m(B, (r) => r.turns) - m(A, (r) => r.turns);
  const outDelta = m(B, (r) => r.outputTokens) - m(A, (r) => r.outputTokens);
  const surfaceDelta = (surfaceOverheadChars[b] ?? 0) - (surfaceOverheadChars[a] ?? 0);
  const costDelta = m(B, (r) => r.costUsd) - m(A, (r) => r.costUsd);

  // Every term in TOKENS, at this repo's 4-chars-per-token rule, so the shares
  // are commensurable. The turn term is turns x mean per-turn context, which is
  // how extra round-trips turn into money under prompt caching.
  const meanCtxPerTurnA = m(A, (r) => (r.turns ? (r.inputTokens + r.cacheRead) / r.turns : 0));
  const terms = {
    observationBytes: obsDelta / 4,
    codegenSection: codegenDelta / 4,
    toolSurface: (surfaceDelta / 4) * m(B, (r) => r.turns),
    turnCount: turnsDelta * meanCtxPerTurnA,
    outputTokens: outDelta,
  };
  const total = Object.values(terms).reduce((s, v) => s + Math.abs(v), 0);
  const share = total ? Math.abs(terms.observationBytes) / total : 0;
  return { terms, share, costDelta, nA: A.length, nB: B.length };
}

// ---------------------------------------------------------------------------
// Scored phases
// ---------------------------------------------------------------------------

/**
 * What a phase wants run, WAVE-MAJOR WITHIN AN ARM.
 *
 * Two orderings are in tension and both matter. Wave-major (runIndex outermost)
 * means an interrupted phase leaves every task with the same number of episodes
 * rather than the first three tasks finished and the rest at zero — the
 * difference between a partial store that can be reported on and one that
 * cannot. Arm-major means one Playwright server per arm per run (§8) instead of
 * a browser cold start inside every other episode, which would land entirely in
 * one arm's wall-clock. Arm outermost, wave next, task innermost resolves it.
 */
export function targetsFor(tasks, arms, nByArm) {
  const out = [];
  for (const arm of arms) {
    const n = typeof nByArm === 'number' ? nByArm : (nByArm[arm] ?? 0);
    for (let runIndex = 0; runIndex < n; runIndex++) {
      for (const t of tasks) out.push({ task: t, arm, runIndex });
    }
  }
  return out;
}

const BUDGET_CAP_USD = 130;

async function runScoredPhase(ctx, phase, storePath, identity, stored, toolsHash) {
  const opts = ctx.opts;
  let tasks = opts.tasks ? ALL_TASKS.filter((t) => opts.tasks.includes(t.id)) : ALL_TASKS;
  let arms = opts.arms;
  let n = opts.n;

  if (phase === 1) {
    // §9's kill shot: the cheapest disconfirming check first, on the class MOST
    // favourable to the mechanism.
    tasks = ALL_TASKS.filter((t) => t.id === 'console-quota');
    arms = ['aperture-diff', 'pw-sealed'];
    n = n ?? 3;
  } else if (phase === 2) {
    n = n ?? 2;
  } else if (phase === 3) {
    n = n ?? PHASE3_N;
  }

  const targets = targetsFor(tasks, arms, n ?? 1);
  const have = new Set(
    stored.map((r) => h2hEpisodeKey({ ...r, codeVersion: identity.codeVersion, model: identity.model })),
  );
  const todo = targets.filter(
    (t) => !have.has(h2hEpisodeKey({ task: t.task.id, arm: t.arm, runIndex: t.runIndex, codeVersion: identity.codeVersion, model: identity.model })),
  );

  const spent = stored.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  console.log(`\nphase ${phase}: ${todo.length} episode(s) to run (${targets.length} targeted, ${targets.length - todo.length} already on record)`);
  console.log(`store has ${stored.length} episode(s), $${spent.toFixed(2)} spent so far (cap $${BUDGET_CAP_USD})`);
  if (spent >= BUDGET_CAP_USD && !opts.forceBudget) {
    return bail(EXIT.INFRA, `BUDGET CAP reached ($${spent.toFixed(2)} of $${BUDGET_CAP_USD}).`, [
      '  §9\'s degrade rule, fixed before any episode ran and not negotiable here:',
      '    reduce aperture-redump large-class N to 6, then pw-stock large-class N to 3.',
      '    Never drop an arm. Never drop a class.',
      '  --force-budget requires a human saying so in the session, in words.',
    ]);
  }

  const fresh = [];
  let done = 0;
  for (const arm of arms) {
    const mine = todo.filter((t) => t.arm === arm);
    if (!mine.length) continue;
    await withArm(arm, ctx, async (proxy) => {
      for (const t of mine) {
        const r = await runEpisode({
          proxy, collector: ctx.collector, task: t.task, arm,
          runIndex: t.runIndex, driver: agentDriver(proxy, t.task, arm, opts),
        });
        r.failureClass = classifyFailure(r);
        const row = stampH2hEpisode(r, identity, H2H_ARM_DEFINITION, toolsHash);
        appendEpisode(storePath, row);
        fresh.push(row);
        done++;
        console.log(
          `  [${String(done).padStart(3)}/${todo.length}] ${t.task.id.padEnd(18)} ${arm.padEnd(16)} run${t.runIndex} ` +
            `${r.success ? 'OK ' : 'no '} ${String(r.pageActions).padStart(2)}a ${String(r.turns).padStart(2)}t ` +
            `$${r.costUsd.toFixed(4)} ${String(r.obsChars).padStart(6)}ch ${(r.durationMs / 1000).toFixed(1)}s` +
            (r.failureClass ? ` [${r.failureClass}]` : ''),
        );
      }
    });
  }
  writeCohort(storePath, identity, {
    toolsHash,
    pwVersion: identity.pwVersion,
    chromium: identity.chromium,
    pwObservationMode: identity.pwObservationMode,
    // C1: on the sidecar as well as on every row, so a cold `--report` can say
    // what ceiling the episodes it is scoring were actually delivered under.
    maxMcpOutputTokens: identity.maxMcpOutputTokens,
    launchFlags: identity.launchFlags,
    pwBrowserOverride: opts.pwBrowser ?? null,
  });

  const all = [...stored, ...fresh];

  // Phase 1's gate. It conditions on COST LEVELS ONLY, never on the headline
  // delta — §7.1's no-peeking rule.
  if (phase === 1) {
    const a = all.filter((r) => r.task === 'console-quota' && r.arm === 'aperture-diff').map((r) => r.costUsd);
    const b = all.filter((r) => r.task === 'console-quota' && r.arm === 'pw-sealed').map((r) => r.costUsd);
    const ma = mean(a);
    const mb = mean(b);
    console.log('\n' + '='.repeat(78));
    console.log(`KILL SHOT — console-quota (neutral-large), N=${a.length}/${b.length}`);
    console.log(`  aperture-diff  $${ma.toFixed(4)}/ep      pw-sealed  $${mb.toFixed(4)}/ep      ratio ${(mb ? ma / mb : Infinity).toFixed(3)}x`);
    if (mb && ma >= 0.9 * mb) {
      console.log('\n  STOP-AND-DECIDE. On the class MOST favourable to the mechanism, Aperture\'s mean');
      console.log('  cost is at least 0.9x Playwright\'s. §9\'s gate: the economics premise is likely');
      console.log('  dead, and a human decides whether the remaining ~$85 is worth spending. This is');
      console.log('  a cost-level reading only; it says nothing about the headline delta and no');
      console.log('  verdict is licensed by it.');
    } else {
      console.log('\n  Gate PASSED on cost levels. Phase 2 (the pilot) is the next step.');
    }
    console.log('='.repeat(78));
  }

  const problems = [...armPurityProblems(all), ...harnessFaultCheck(all), ...modelIdentityCheck(all)];
  for (const p of problems) console.log(`\n  ${p}`);
  return problems.length ? EXIT.HARNESS_FAULT : EXIT.MEASURED;
}

// ---------------------------------------------------------------------------
// The report (§7)
// ---------------------------------------------------------------------------

export function report(rows, surfaceOverheadChars = {}) {
  const problems = [];
  // All THREE harness classes are excluded, not just `tool_fault`: an episode
  // whose agent never reached the tool surface — or whose observations the SDK
  // ate before the model saw them — is not a slower or worse result, it is no
  // result, and averaging it in would let a broken arm masquerade as a beaten
  // one.
  const scored = rows.filter((r) => !HARNESS_CLASSES.has(classifyFailure(r)));
  const excluded = rows.length - scored.length;
  const zeroContact = rows.filter((r) => classifyFailure(r) === 'harness_fault').length;
  const contaminated = rows.filter((r) => r.apparatusContaminated);

  console.log(
    `\n${rows.length} episode(s) on record · ${excluded} excluded as harness fault (§6 H9)` +
      (zeroContact ? ` — ${zeroContact} of them never reached the tool surface` : '') +
      (contaminated.length ? ` — ${contaminated.length} apparatus_contaminated` : ''),
  );
  console.log(`total spend $${rows.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(2)}\n`);

  // --- C2/C4: the contamination roll, named episode by episode ---
  if (contaminated.length) {
    console.log(`APPARATUS CONTAMINATION — ${contaminated.length} episode(s) did not measure the arm (§C2)`);
    for (const r of contaminated) {
      const why = r.apparatusContaminated.reasons.map((x) => x.reason).join(' + ');
      console.log(
        `  ${r.task.padEnd(18)} ${r.arm.padEnd(16)} run${r.runIndex}  ${r.success ? 'SUCCEEDED' : 'failed   '}  ` +
          `obsChars ${String(r.obsChars).padStart(7)} RETURNED-NOT-DELIVERED  [${why}]`,
      );
      for (const x of r.apparatusContaminated.reasons) {
        if (x.reason === 'sdk_mcp_output_cap') {
          console.log(`      the SDK ${x.verdicts.join('/')} ${x.count} tool result(s) over MAX_MCP_OUTPUT_TOKENS:`);
          console.log(`      ${JSON.stringify(x.sample.slice(0, 200))}`);
        } else {
          console.log(`      ${x.why}`);
        }
      }
    }
    console.log('  Their cost, turns and observed bytes are facts about this harness, not about any arm.');
    console.log('');
  }

  /**
   * --- C4: H11's FLOOR, SECOND CLAUSE — CONTAMINATION EXCLUDES THE WHOLE CELL ---
   *
   * Dropping the contaminated EPISODES is not enough, and this is the part that
   * is easy to get wrong. The episodes that survive in a contaminated arm are
   * the ones whose observations happened to fit under the SDK cap — which is to
   * say the SMALLEST and therefore CHEAPEST ones. Scoring the survivors reads a
   * survivorship artefact as a result, and it reads it in the direction that
   * flatters whichever arm was NOT contaminated.
   *
   * So the exclusion is by CELL, it is triggered by ONE arm (not both), it does
   * not care what the success rates were, and unlike the <50% clause it removes
   * the cell from EVERY claim rather than only the cost ones. It is applied
   * BEFORE the per-arm table, not after it, because a table is read as a result
   * whatever a later paragraph says about it. Named out loud, with the arm,
   * because an exclusion nobody can see is an exclusion nobody can audit.
   */
  const contaminatedCells = new Map();
  for (const r of contaminated) {
    if (!contaminatedCells.has(r.task)) contaminatedCells.set(r.task, new Map());
    const byArm = contaminatedCells.get(r.task);
    byArm.set(r.arm, (byArm.get(r.arm) ?? 0) + 1);
  }
  if (contaminatedCells.size) {
    console.log('H11/C4 — EXCLUDED FROM EVERY CLAIM (an arm in this cell was contaminated):');
    for (const [task, byArm] of contaminatedCells) {
      const who = [...byArm].map(([arm, n]) => `${arm} x${n}`).join(', ');
      console.log(`  ${task.padEnd(18)} contaminated in: ${who}`);
    }
    console.log('  Not a capability finding and not a cost finding — the cell was never measured.');
    console.log('  The surviving episodes of a contaminated arm are the ones that fit under the cap,');
    console.log('  i.e. the cheapest ones; scoring what is left would report survivorship as a result.');
    console.log('');
  }
  const claimable = scored.filter((r) => !contaminatedCells.has(r.task));

  const rate = (rs) => (rs.length ? rs.filter((r) => r.success).length / rs.length : 0);
  console.log('PER ARM, PER CLASS' + (contaminatedCells.size ? '  (contaminated cells removed)' : ''));
  console.log('  arm              class           n   success   wrong-el/run   $/ep      obs chars/ep   turns');
  for (const arm of ARMS) {
    for (const cls of CLASSES) {
      const rs = claimable.filter((r) => r.arm === arm && r.class === cls);
      if (!rs.length) continue;
      console.log(
        `  ${arm.padEnd(16)} ${cls.padEnd(14)} ${String(rs.length).padStart(3)}   ` +
          `${fmtPct(rate(rs)).padStart(6)}   ${mean(rs.map((r) => r.wrongElement)).toFixed(3).padStart(10)}   ` +
          `$${mean(rs.map((r) => r.costUsd)).toFixed(4)}   ${String(Math.round(mean(rs.map((r) => r.obsChars)))).padStart(10)}   ` +
          `${mean(rs.map((r) => r.turns)).toFixed(1)}`,
      );
    }
  }

  // --- H11: the capability floor, applied BEFORE any cost claim ---
  const excludedCells = [];
  for (const t of ALL_TASKS) {
    const a = claimable.filter((r) => r.task === t.id && r.arm === 'aperture-diff');
    const b = claimable.filter((r) => r.task === t.id && r.arm === 'pw-sealed');
    if (!a.length || !b.length) continue;
    if (rate(a) < 0.5 && rate(b) < 0.5) excludedCells.push(t.id);
  }
  if (excludedCells.length) {
    console.log(`\nH11 — excluded from every cost claim (both headline arms <50%): ${excludedCells.join(', ')}`);
    console.log('  A failing arm\'s episodes are not the same work. Reported as a capability finding.');
  }
  const costable = claimable.filter((r) => !excludedCells.includes(r.task));

  // --- §7.1 reliability, pooled over ALL tasks ---
  const a = claimable.filter((r) => r.arm === 'aperture-diff');
  const b = claimable.filter((r) => r.arm === 'pw-sealed');
  const sCI = propDiffCI(a.filter((r) => r.success).length, a.length, b.filter((r) => r.success).length, b.length);
  console.log('\nRELIABILITY (primary) — aperture-diff − pw-sealed, Newcombe 95%, pooled over all tasks');
  console.log(`  delta ${fmtSigned(sCI.delta)}  CI [${fmtSigned(sCI.lo)}, ${fmtSigned(sCI.hi)}]  bound −10pp`);
  const reliabilityHolds = sCI.lo >= -0.1;
  const reliabilityLost = sCI.hi < -0.1;
  console.log(`  ${reliabilityHolds ? 'BOUND HOLDS' : reliabilityLost ? 'BOUND FAILS — §7.3\'s reliability sentence is owed' : 'INCONCLUSIVE on this axis (§7.5)'}`);

  // --- §7.1 precision ---
  const wCI = meanDiffCI(a.map((r) => r.wrongElement), b.map((r) => r.wrongElement), { seed: 20260802 });
  console.log('\nPRECISION (primary) — wrong-element delta per run, bootstrap 95%');
  console.log(`  delta ${wCI.delta >= 0 ? '+' : ''}${wCI.delta.toFixed(3)}  CI [${wCI.lo.toFixed(3)}, ${wCI.hi.toFixed(3)}]  bound +0.2`);
  console.log(`  ${wCI.hi <= 0.2 ? 'BOUND HOLDS' : 'BOUND FAILS — §7.3\'s precision sentence is owed, with the attribution split'}`);

  // --- §7.1 economics, per class, never pooled ---
  console.log('\nECONOMICS (primary) — cost ratio aperture-diff / pw-sealed, seeded bootstrap 90%');
  let headlineEconomics = null;
  for (const cls of CLASSES) {
    const xs = costable.filter((r) => r.arm === 'aperture-diff' && r.class === cls).map((r) => r.costUsd);
    const ys = costable.filter((r) => r.arm === 'pw-sealed' && r.class === cls).map((r) => r.costUsd);
    if (!xs.length || !ys.length) continue;
    const c = meanRatioCI(xs, ys);
    const verdict = c.hi < 1 ? 'CHEAPER' : c.lo > 1 ? 'DEARER' : 'null';
    console.log(`  ${cls.padEnd(14)} ${c.ratio.toFixed(3)}x  CI [${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]  n=${xs.length}/${ys.length}  ${verdict}`);
    if (cls === 'neutral-large') headlineEconomics = c;
  }
  if (headlineEconomics) {
    console.log(
      `  HEADLINE (neutral-large): ${headlineEconomics.hi < 1
        ? 'the economic claim is licensed — CI entirely below 1.0'
        : '§7.3\'s economics sentence is owed — the CI includes or exceeds 1.0'}`,
    );
  }

  // --- H12 ceiling ---
  if (a.length && b.length && rate(a) >= 0.98 && rate(b) >= 0.98) {
    console.log('\nH12 — INCONCLUSIVE-by-ceiling: both headline arms are ≥98% on success pooled, so the');
    console.log('  reliability comparison is INCONCLUSIVE-by-ceiling and only the economics claims survive.');
  }

  // --- H10 decomposition, pooled and per task ---
  console.log('\nH10 — WIN-REASON DECOMPOSITION (mandatory)');
  const pooled = decompose(costable, 'aperture-diff', 'pw-sealed', surfaceOverheadChars);
  if (pooled) {
    for (const [k, v] of Object.entries(pooled.terms)) {
      console.log(`  ${k.padEnd(20)} ${v >= 0 ? '+' : ''}${Math.round(v)} tokens/ep`);
    }
    console.log(`  observation-byte share of the delta: ${fmtPct(pooled.share)}`);
    if (pooled.share >= 0.5) console.log('  MECHANISM CONFIRMED');
    else {
      console.log('  MECHANISM NOT CONFIRMED — the verdict stands, but the report MUST lead with the');
      console.log('  actual explanation, not with the diff mechanism.');
    }
    console.log('  per task (pooling hid a sign change once already):');
    for (const t of ALL_TASKS) {
      const d = decompose(costable.filter((r) => r.task === t.id), 'aperture-diff', 'pw-sealed', surfaceOverheadChars);
      if (d) console.log(`    ${t.id.padEnd(18)} obs share ${fmtPct(d.share).padStart(6)}  Δ$ ${d.costDelta.toFixed(4)}`);
    }
  }

  // --- §3.5's three-way decomposition ---
  console.log('\nDECOMPOSITION (secondary) — §3.5\'s three named comparisons');
  for (const [x, y, what] of [
    ['aperture-diff', 'aperture-redump', 'the DIFF MECHANISM (same engine, same dialect)'],
    ['aperture-redump', 'pw-sealed', 'ENGINE + DIALECT at equal observation strategy'],
    ['aperture-diff', 'pw-sealed', 'the product headline'],
  ]) {
    const xs = claimable.filter((r) => r.arm === x);
    const ys = claimable.filter((r) => r.arm === y);
    if (!xs.length || !ys.length) continue;
    const s = propDiffCI(xs.filter((r) => r.success).length, xs.length, ys.filter((r) => r.success).length, ys.length);
    console.log(`  ${x} − ${y}: success ${fmtSigned(s.delta)} [${fmtSigned(s.lo)}, ${fmtSigned(s.hi)}]   ${what}`);
  }

  // --- §7.4's affordance sentence ---
  const stock = claimable.filter((r) => r.arm === 'pw-stock');
  if (stock.length && b.length) {
    const half = (sCI.hi - sCI.lo) / 2;
    const d = rate(stock) - rate(b);
    console.log(`\nAFFORDANCE (secondary) — pw-stock ${fmtPct(rate(stock))} vs pw-sealed ${fmtPct(rate(b))} (Δ ${fmtSigned(d)})`);
    if (d > half) {
      console.log('  §7.4 REQUIRED SENTENCE: "Sealing Playwright MCP to three tools cost it measurable');
      console.log('  capability; the sealed comparison understates the incumbent, and the stock numbers');
      console.log('  are the deployment-relevant ones."');
    }
    const nonRef = mean(stock.map((r) => r.nonRefTargeting ?? 0));
    console.log(`  non-ref targeting in pw-stock: ${nonRef.toFixed(2)} per episode (§3.4)`);
    console.log('  Any pw-stock claim carries the qualifier "with code-execution, network-inspection');
    console.log('  and screenshot tools disabled" — preregistered in §3.4 so it cannot be dropped.');
  }

  // --- §2: wall-clock, reported, never verdicted ---
  console.log('\nWALL-CLOCK (reported, never verdicted — §2)');
  for (const arm of ARMS) {
    for (const cls of CLASSES) {
      const rs = claimable.filter((r) => r.arm === arm && r.class === cls);
      if (!rs.length) continue;
      const ms = rs.map((r) => r.durationMs);
      const up = rs.map((r) => r.upstreamMs ?? 0);
      console.log(
        `  ${arm.padEnd(16)} ${cls.padEnd(14)} median ${(median(ms) / 1000).toFixed(1)}s  ` +
          `IQR [${(quantile(ms, 0.25) / 1000).toFixed(1)}, ${(quantile(ms, 0.75) / 1000).toFixed(1)}]  ` +
          `browser time ${(median(up) / 1000).toFixed(1)}s median`,
      );
    }
  }
  console.log('  At these episode lengths, wall-clock differences are dominated by API queueing');
  console.log('  noise; the attributable component is the token and turn deltas reported above.');

  problems.push(...armPurityProblems(rows), ...harnessFaultCheck(rows), ...modelIdentityCheck(rows));
  for (const p of problems) console.log(`\n  ${p}`);
  return problems.length ? EXIT.HARNESS_FAULT : EXIT.MEASURED;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    plan: false, dry: false, selftest: false, lint: false, report: false,
    phase: null, n: null, tasks: null, arms: [...ARMS], model: 'claude-sonnet-5',
    newCohort: false, store: null, verbose: false,
    pwObservation: 'inline', pwObservationExplicit: false,
    pwBrowser: null, forceBudget: false, keepAlive: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') out.plan = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--lint') out.lint = true;
    else if (a === '--report') out.report = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--keep-alive') out.keepAlive = true;
    else if (a === '--new-cohort') out.newCohort = true;
    else if (a === '--force-budget') out.forceBudget = true;
    else if (a === '--phase') out.phase = Number(argv[++i]);
    else if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--tasks') out.tasks = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--arms') out.arms = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--store') out.store = resolve(argv[++i]);
    else if (a === '--pw-observation') {
      out.pwObservation = argv[++i];
      out.pwObservationExplicit = true;
    }
    else if (a === '--pw-browser') out.pwBrowser = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  for (const arm of out.arms) if (!ARMS.includes(arm)) throw new Error(`unknown arm: ${arm}`);
  if (!PW_OBSERVATION_MODES.includes(out.pwObservation)) {
    throw new Error(`--pw-observation must be one of ${PW_OBSERVATION_MODES.join('|')}`);
  }
  return out;
}

function bail(code, title, lines) {
  console.log(`\n${title}`);
  for (const l of lines) console.log(l);
  return code;
}

/**
 * `--dry`: prove the harness loads, the schemas build, and the §3.2 mapping
 * table is what the spec says — with NO infrastructure at all. Cheapest
 * possible check that the thing is wired up, and the first thing to run after
 * any edit.
 */
function dryRun(opts) {
  console.log('\nDRY SELF-TEST — no Aperture, no Playwright, no ports, no budget\n');
  console.log(`  tasks           ${ALL_TASKS.length} (${HOME.length} home + ${NEUTRAL_TASKS.length} neutral)`);
  for (const c of CLASSES) {
    const t = ALL_TASKS.filter((x) => x.class === c);
    console.log(`    ${c.padEnd(14)} ${t.length}: ${t.map((x) => x.id).join(', ')}`);
  }
  console.log(`  arms            ${ARMS.join(', ')}`);
  console.log(`  fixtures        neutral ${NEUTRAL_FIXTURES.length}, home ${[...new Set(HOME.map((t) => t.fixture))].length}`);
  console.log(`  pw pin          ${PW_PINNED_VERSION} (installed ${pwPackageVersion()})`);
  console.log(`  chromium        ${JSON.stringify(chromiumBuild())}`);
  console.log(`  pwObservation   ${opts.pwObservation}`);
  console.log('');
  console.log('  §3.2 SEALED → PLAYWRIGHT MAPPING, as built:');
  const rows = [
    ['act click ref', 'browser_click { target: ref }', 'element param omitted (it exists for permission UIs)'],
    ['act type ref text submit', 'browser_type { target, text, submit }', 'pw default is fill-at-once; that IS its shipped typing'],
    ['act clear ref', "browser_type { target, text: '' }", 'fill semantics make this exact'],
    ['act key key', 'browser_press_key { key }', ''],
    ['act hover ref', 'browser_hover { target: ref }', ''],
    ['act scroll deltaY', 'browser_mouse_move_xy{640,360} → browser_mouse_wheel{deltaX:0,deltaY}', '0.0.78 wheel takes no position; the move is how "viewport centre" is honoured. Only the wheel reply is the observation.'],
    ['browser_snapshot mode/expand', 'browser_snapshot {}', 'Aperture semantics; full honoured, auto upgraded, expand vacuous. {} is the whole page — Playwright\'s own default — delivered and billed in full'],
    ['browser_snapshot budgetTokens', `(refused: ${JSON.stringify(PW_BUDGET_TOKENS_NOTICE)})`, 'C3 ruling: NO budgetTokens→depth mapping. depth/find are stock-surface affordances, measured in pw-stock. Refusal costs no step'],
    ['task_done', '(handled at the proxy, never forwarded)', ''],
  ];
  for (const [a, b, why] of rows) {
    console.log(`    ${a.padEnd(30)} -> ${b}`);
    if (why) console.log(`    ${' '.repeat(30)}    ${why}`);
  }
  console.log('');
  console.log(`  MAX_MCP_OUTPUT_TOKENS  ${MAX_MCP_OUTPUT_TOKENS} — set by the harness in every arm's SDK env (C1)`);
  console.log(`  contamination bound    ${CHARS_PER_NEW_CONTEXT_TOKEN_CEILING} chars per new-context token (C2c)`);
  console.log('');
  console.log(`  ref grammar     /^e\\d+$/ enforced in pw-sealed; refusal: ${JSON.stringify('error: "<value>" is not a known element ref')}`);
  console.log(`  §3.4 withheld   ${Object.keys(PW_STOCK_WITHHELD).join(', ')}`);
  console.log(`  §3.4 kept       ${PW_STOCK_KEPT.join(', ')}`);
  console.log('');
  const lint = lintAll();
  for (const n of lint.notes) console.log(n);
  if (lint.problems.length) {
    console.log(`\n  ${lint.problems.length} LINT PROBLEM(S):`);
    for (const p of lint.problems) console.log(`    - ${p}`);
    return EXIT.SELFTEST;
  }
  console.log('\n  DRY GREEN. Nothing here proves either engine works — that is H0-H5\'s job.');
  return EXIT.MEASURED;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(RESULTS, { recursive: true });

  if (opts.lint) {
    const { problems, notes } = lintAll();
    for (const n of notes) console.log(n);
    for (const p of problems) console.log(`  - ${p}`);
    return problems.length ? EXIT.SELFTEST : EXIT.MEASURED;
  }
  if (opts.plan) {
    printPlan({ opts });
    return EXIT.MEASURED;
  }
  if (opts.dry) return dryRun(opts);

  const stamp = runStamp();
  const storePath = opts.store ?? defaultH2hStorePath(HERE);

  const identity = buildH2hIdentity({
    root: ROOT,
    h2hDir: HERE,
    model: opts.model,
    systemPrompts: { sealed: SYSTEM_PROMPT_SEALED, stock: SYSTEM_PROMPT_STOCK },
    tasks: ALL_TASKS,
    verdictRule: VERDICT_RULE,
    pwVersion: pwPackageVersion(),
    chromium: chromiumBuild(),
    pwObservationMode: opts.pwObservation,
    launchFlags: { sealed: launchFlagsFor('pw-sealed', '<scratch>'), stock: launchFlagsFor('pw-stock', '<scratch>') },
    maxMcpOutputTokens: MAX_MCP_OUTPUT_TOKENS,
  });

  if (opts.newCohort) {
    const moved = archiveStore(storePath);
    for (const m of moved) console.log(`archived ${m}`);
  }

  const { rows: stored, malformed } = loadStore(storePath);
  const cohort = loadCohort(storePath);
  const integrity = checkH2hIntegrity({
    rows: stored, malformed, cohort, identity, armDefinitions: H2H_ARM_DEFINITION,
  });
  if (!integrity.ok) {
    console.log('\nINTEGRITY — this store holds episodes from a different experiment.\n');
    for (const b of integrity.blocks) {
      console.log(`  ${b.title}`);
      for (const l of b.lines) console.log(l);
      console.log('');
    }
    console.log('There is no override. `--new-cohort` archives the old store and starts a fresh one.');
    return EXIT.INTEGRITY;
  }

  if (opts.report || opts.phase === 4) {
    if (!stored.length) return bail(EXIT.VACUOUS, 'VACUOUS — the store is empty.', [`  ${storePath}`]);
    console.log(`\nstore: ${storePath}`);
    console.log(`cohort: ${cohortPathFor(storePath)}`);
    // Surface overhead is a live measurement (it depends on what Playwright's
    // build registers), so a report over a cold store takes it from the cohort
    // sidecar rather than inventing it.
    return report(stored, cohort?.surfaceOverheadChars ?? {});
  }

  /**
   * THE RULING GATE. A scored phase may not start on a defaulted
   * `--pw-observation`, because the default was CHOSEN BY THE IMPLEMENTER for a
   * question the design document did not know it had to answer.
   *
   * headtohead.md §1.1 asserts that every Playwright action response embeds a
   * full aria snapshot. The pinned 0.0.78 writes it to a file and links it, and
   * the agent under test has no filesystem. `inline` reconstructs the response
   * §1.1 describes and measures the competitor's observation channel as the
   * design of record intends; `asshipped` measures what a filesystem-less agent
   * actually receives from 0.0.78. Both are defensible. They are different
   * experiments, they cannot pool, and picking one silently would be the single
   * largest un-disclosed judgement call in this harness.
   *
   * Preflights default to `inline` so H1 can SHOW the human the finding. Money
   * requires the human to have seen it and said which one.
   */
  if (opts.phase !== null && opts.phase !== 4 && !opts.pwObservationExplicit) {
    return bail(EXIT.INFRA, 'A HUMAN RULING IS REQUIRED BEFORE ANY SCORED PHASE.', [
      '  headtohead.md §1.1: "every action response embeds a full aria snapshot of the page',
      '  by default". MEASURED against the pinned @playwright/mcp 0.0.78: every action',
      '  response WRITES the aria snapshot to a file and returns',
      '      - [Snapshot](results\\pw-out\\…\\page-….yml)',
      '  Only the explicit browser_snapshot tool inlines the bytes',
      '  (playwright-core coreBundle.js:64833, `_includeSnapshot !== "explicit"`).',
      '  The agent under test has no filesystem tools, so an unresolved link is an empty',
      '  observation.',
      '',
      '  Pass ONE of these, deliberately:',
      '    --pw-observation inline      the harness reads the linked file and substitutes the',
      '                                 yaml, reconstructing the response §1.1 describes. Charges',
      '                                 the competitor for bytes it wrote to disk rather than to',
      '                                 the wire. This is the design of record\'s experiment.',
      '    --pw-observation asshipped   the link is left alone. Measures 0.0.78 exactly as a',
      '                                 filesystem-less agent receives it, which will show the pw',
      '                                 arms observing almost nothing per action.',
      '',
      '  The choice is stamped into the cohort identity; the two can never pool.',
      '  Run `--selftest` first: H1 prints the finding with the verbatim bytes.',
    ]);
  }

  if (!opts.selftest && opts.phase === null) {
    return bail(EXIT.INFRA, 'Nothing to do. Pick one:', [
      '  --plan      the phase plan and cost projections (no infra)',
      '  --dry       module/schema/mapping self-test (no infra)',
      '  --selftest  ALL preflights H0-H5 (+H2b), live infra, $0 budget',
      '  --phase N   a scored phase. SPENDS BUDGET.',
      '  --report    score the store',
    ]);
  }

  // ---- live infrastructure ----
  for (const p of [APERTURE_PORT, FIXTURE_PORT, COLLECTOR_PORT, H2H_PROXY_PORT]) {
    if (await portIsOpen(p)) {
      return bail(EXIT.INFRA, `INFRA — port ${p} is already in use.`, [
        '  This runner owns its world: it starts everything and kills everything.',
        '  Something else is listening, and pooling episodes across two apparatuses is',
        '  exactly what the integrity guard exists to prevent.',
      ]);
    }
  }

  console.log(`\nhead-to-head · stamp ${stamp} · store ${storePath}`);
  console.log(`identity: code ${identity.codeVersion} · build ${identity.buildVersion} · pw ${identity.pwVersion} · chromium ${identity.chromium.revision} · pwObservation ${identity.pwObservationMode} · maxMcpOutputTokens ${identity.maxMcpOutputTokens}\n`);

  const fixtures = await startFixtureServer();
  const collector = await startCollector();
  let aperture = null;
  let exitCode = EXIT.MEASURED;

  try {
    const needAperture = opts.arms.some((a) => APERTURE_ARMS.has(a));
    if (needAperture) {
      aperture = await startAperture({ root: ROOT, stamp, logDir: RESULTS });
    }
    const ctx = { opts, collector, stamp, identity, apertureToken: aperture?.token ?? null };

    if (opts.selftest) {
      const tasks = (opts.tasks ? ALL_TASKS.filter((t) => opts.tasks.includes(t.id)) : ALL_TASKS);
      const blocks = [];
      const say = (name, r) => {
        console.log(`\n${name}`);
        for (const n of r.notes ?? []) console.log(n);
        if (r.problems.length) {
          console.log(`\n  ${r.problems.length} PROBLEM(S):`);
          for (const p of r.problems) console.log(`  - ${p}`);
        }
        blocks.push({ name, problems: r.problems });
      };

      say('H0 — pin check', await guardH0(ctx));
      const h1 = await guardH1(ctx);
      say('H1 — response-shape probe', h1);
      if (h1.appendix) {
        writeFileSync(join(RESULTS, `h1-appendix.${stamp}.json`), JSON.stringify(h1.appendix, null, 2));
        console.log(`\n  verbatim responses written to results/h1-appendix.${stamp}.json`);
      }
      say('H2 — null agent, per engine', await guardH2(ctx, tasks));
      say('H2b — witness parity across engines', await guardH2b(ctx, tasks.filter((t) => t.class !== 'home')));
      const h3 = await guardH3(ctx, tasks);
      say('H3 — scripted-solver parity (the load-bearing one)', h3);
      const h4 = await guardH4(ctx);
      say('H4 — arm-blindness fingerprint', h4);
      say('H5 — fixture neutrality, size bands, padding leak', await guardH5(ctx, h3.results));

      const total = blocks.reduce((a, b) => a + b.problems.length, 0);
      const h3Red = blocks.find((b) => b.name.startsWith('H3'))?.problems.length ?? 0;
      const h2bRed = blocks.find((b) => b.name.startsWith('H2b'))?.problems.length ?? 0;
      console.log('\n' + '-'.repeat(78));
      if (!total) {
        console.log('PREFLIGHTS GREEN — H0-H5 (+H2b) all pass. No API budget was spent.');
        exitCode = EXIT.MEASURED;
      } else {
        console.log(`PREFLIGHTS RED — ${total} problem(s) across ${blocks.filter((b) => b.problems.length).map((b) => b.name.split(' ')[0]).join(', ')}.`);
        // H3 and H2b carry the harness-fault presumption: a failure there is
        // OURS until proven otherwise, and it is worth a distinct exit code.
        exitCode = h3Red || h2bRed ? EXIT.HARNESS_FAULT : EXIT.SELFTEST;
      }
      console.log('-'.repeat(78));
      return exitCode;
    }

    // A scored phase needs the live tool surface for its stamp AND for H10's
    // decomposition, so H4 runs first even when the preflights are not being
    // asked for: an episode stamped with a toolsHash nobody measured is an
    // episode that cannot be refused later.
    const h4 = await guardH4(ctx);
    if (h4.problems.length) {
      for (const p of h4.problems) console.log(`  ${p}`);
      return EXIT.SELFTEST;
    }
    const surfaceOverheadChars = Object.fromEntries(
      Object.entries(h4.fingerprints).map(([arm, f]) => [arm, f.overheadChars ?? 0]),
    );
    ctx.surfaceOverheadChars = surfaceOverheadChars;
    const code = await runScoredPhase(ctx, opts.phase, storePath, identity, stored, h4.toolsHash);
    console.log('\nrun `--report` (or `--phase 4`) for the §7 verdict over the whole store.');
    return code;
  } finally {
    if (aperture) await killTree(aperture.child);
    await collector.close();
    await fixtures.close();
    if (await portIsOpen(APERTURE_PORT)) {
      console.log(`\nWARNING: something is STILL listening on ${APERTURE_PORT}.`);
    }
  }
}

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
