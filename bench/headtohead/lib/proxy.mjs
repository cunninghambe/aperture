/**
 * The head-to-head MCP proxy: one sealed surface, two engines behind it.
 *
 * Same skeleton as `bench/lib/proxy.mjs` (episode state, step caps, witness
 * attribution, observation recording) with the four differences headtohead.md
 * §8 names: two upstream adapters, the §3.2 shim, the §3.4 allowlist
 * forwarding, and per-section char accounting with `upstreamMs` timing.
 *
 * THE FOUR RULES THE ORIGINAL PROXY EXISTS FOR STILL HOLD, AND ONE IS NEW:
 *
 *  1. THE ARM MUST BE INVISIBLE. Same tool names, same schemas, same act and
 *     done descriptions in all three sealed arms; the MCP server is called
 *     `browser` everywhere so the tool ids the model sees carry no product
 *     name. The only thing that differs is what comes back.
 *  2. THE SURFACE MUST BE SEALED, not merely allow-listed. In the sealed arms
 *     exactly three tools are REGISTERED; §1.3's four escapes cannot be reached
 *     because they do not exist in `tools/list`. In `pw-stock` the withheld set
 *     is filtered at registration, not at call time, for the same reason.
 *  3. THE SHADOW MODEL MUST SEE EXACTLY WHAT THE AGENT SAW. Fed here, from the
 *     same bytes, in the same order — streamModel for the aperture arms,
 *     ariaModel for the pw arms.
 *  4. THE STEP CAP MUST BE EXTERNAL, counted here, because maxTurns counts
 *     conversation turns and a runaway agent can burn unbounded actions inside
 *     one turn.
 *  5. NEW, AND IT IS THE ONE THAT MAKES A TWO-SIDED SUITE HONEST: A SHIM FAULT
 *     MUST BE DISTINGUISHABLE FROM A COMPETITOR FAULT. Everything this file
 *     originates that is a BUG rather than a designed refusal carries
 *     `HARNESS_ERROR_PREFIX`, and H9 counts them. A comparison whose failure
 *     mode is "the competitor scored zero because our shim broke" is worthless.
 *
 * NOTHING IN ANY ARM EVER CALLS `browser_evaluate` OR `browser_run_code_unsafe`,
 * not even internally, not even for setup. §3.2 makes that an absolute rule and
 * it is kept absolute: an integrity story with no exceptions is auditable.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import * as z from 'zod';

// ONE definition of the aperture taxonomy and of the shadow model, imported —
// never re-derived (tier4.md §7.4, and this suite's standing rule).
import { applyObservation, classifyObservation, isTruncated } from '../../lib/streamModel.mjs';
import { attributeAct, labelsAgree, REF_ERROR, INPUT_LOSS } from '../../lib/proxy.mjs';
import { settle } from '../../lib/collector.mjs';
import {
  applyPwObservation,
  classifyPwObservation,
  sectionChars,
  snapshotYaml,
} from './ariaModel.mjs';

/** §8: 8896 is left to the task suite so a stray process cannot be confused. */
export const H2H_PROXY_PORT = 8894;

/** The viewport centre of the pinned 1280x720, where a sealed scroll happens. */
export const VIEWPORT = { width: 1280, height: 720 };

/**
 * The distinct prefix H9 keys `tool_fault` off.
 *
 * A DESIGNED REFUSAL IS NOT A FAULT and must not carry it: the ref-grammar
 * refusal, the step-budget refusal and the finished-session refusal are all
 * spelled `error: …` exactly as Aperture spells its own, because the sealed
 * surface has to look the same in both arms right down to how it says no.
 * This prefix is for the shim BEING WRONG — an unmapped action, a transport
 * failure, an exception inside the mapping.
 */
export const HARNESS_ERROR_PREFIX = 'error: [harness] ';
export const isHarnessFault = (t) => typeof t === 'string' && t.startsWith(HARNESS_ERROR_PREFIX);

export const APERTURE_ARMS = new Set(['aperture-diff', 'aperture-redump']);
export const PW_ARMS = new Set(['pw-sealed', 'pw-stock']);
export const SEALED_ARMS = new Set(['aperture-diff', 'aperture-redump', 'pw-sealed']);

/**
 * §3.2's ref grammar. Aperture rejects a non-ref natively; enforcing the same
 * shape here is what stops §1.3's escape #4 (a CSS selector passed as a "ref")
 * from re-entering through the sealed schema.
 *
 * SPEC DEFECT, MEASURED, AND IT WOULD HAVE BEEN CATASTROPHIC. §3.2 writes the
 * grammar as `/^e\d+$/` for both engines. Playwright MCP 0.0.78 emits
 * `${refPrefix}e${++lastRef}` where
 *
 *     refPrefix = this._frameSeq && options.mode === 'ai' ? 'f' + this._frameSeq : ''
 *
 * (playwright-core coreBundle.js, packages/injected/src/ariaSnapshot.ts). The
 * FIRST page a server ever loads has `_frameSeq === 0` and gets bare `e1, e2…`;
 * every navigation after that gets `f1e…`, `f2e…`, `f3e…`. Since §8 pins ONE
 * server per arm per run and per-episode freshness by navigation, exactly the
 * first episode of each arm would have passed the spec's grammar and every
 * later one would have had EVERY act refused — a competitor scoring zero
 * because our shim broke, which is the precise failure H9 exists to name.
 * Probed live before any budget: 0 of 48 refs violated the grammar on the first
 * fixture, 1014 of 1014 on the sixth.
 *
 * The grammar is therefore per engine. The INTENT of §3.2 is preserved exactly
 * — a CSS selector, an XPath or a text= locator still cannot pass — and only
 * the letter, which was written from an assumption about the competitor's
 * format, moves.
 */
export const REF_GRAMMAR = /^e\d+$/;
export const PW_REF_GRAMMAR = /^(f\d+)?e\d+$/;
export const refGrammarFor = (arm) => (PW_ARMS.has(arm) ? PW_REF_GRAMMAR : REF_GRAMMAR);
export const refRefusal = (v) => `error: "${v}" is not a known element ref`;

// ---------------------------------------------------------------------------
// The arm definitions — prose that lands on every stored episode
// ---------------------------------------------------------------------------

export const H2H_ARM_DEFINITION = {
  'aperture-diff':
    'engine: Aperture (HTTP MCP, :8817). browser_act: no observe override — Aperture returns its ' +
    'default, a diff against the state the agent already holds. browser_snapshot: mode forwarded ' +
    'as the agent asked. Sealed 3-tool surface.',
  'aperture-redump':
    'engine: Aperture (HTTP MCP, :8817). browser_act: observe="full" injected at the proxy on ' +
    'every call. browser_snapshot: mode="full" forced at the proxy, so a voluntary snapshot ' +
    'cannot come back as a diff. Sealed 3-tool surface. Decomposition control (headtohead.md §3.5).',
  'pw-sealed':
    'engine: Playwright MCP 0.0.78 (stdio, --isolated). Sealed 3-tool surface with byte-identical ' +
    'names and schemas, shimmed onto browser_click/browser_type/browser_press_key/browser_hover/' +
    'browser_mouse_wheel/browser_snapshot (headtohead.md §3.2). Ref grammar /^(f\\d+)?e\\d+$/ ' +
    'enforced — 0.0.78 frame-prefixes refs after the first navigation; §3.2 assumed bare eN. ' +
    'Playwright default observation: full aria snapshot per action, subject to the 0.0.78 ' +
    'link/absence findings recorded on the cohort as pwObservationMode.',
  'pw-stock':
    'engine: Playwright MCP 0.0.78 (stdio, --isolated). Playwright core surface forwarded verbatim ' +
    'minus the §3.4 withheld set, plus task_done. Selector targeting left in and measured. ' +
    'No --caps vision, default (typescript) codegen.',
};


// ---------------------------------------------------------------------------
// The tool texts (§3.3)
// ---------------------------------------------------------------------------

/**
 * §3.3, verbatim. Two changes from `bench/lib/proxy.mjs`'s ACT_DESCRIPTION and
 * both are stated there with their reasons:
 *
 *  - "Aperture reports…" → "The browser reports…", because no product name may
 *    reach the model in any arm.
 *  - the stale-ref recovery sentence is DROPPED, because it is verified true
 *    for Aperture and unverified for Playwright, and a description that may lie
 *    in one arm is the exact defect the original proxy's header comment exists
 *    to prevent.
 *
 * The imperative is kept at product strength. The pilot measured that weakening
 * it moves behaviour (G4 63.6% → 73.7%), so softening it here would deflate the
 * very cost advantage under measurement.
 */
export const H2H_ACT_DESCRIPTION =
  'Click, type, hover, scroll, or press a key on the page, then observe what ' +
  'changed.\n\n' +
  'The browser reports the result of each action for you. That is the whole point: ' +
  'do not call browser_snapshot after every action. ' +
  'The report after each action is complete: anything it does not mention is ' +
  'unchanged. Do not call browser_snapshot to re-verify what a report already ' +
  'told you — it will return nothing new.\n\n' +
  'Input is dispatched as real browser input, so framework handlers, native ' +
  'widgets and validation behave exactly as they do for a human.';

/** §3.3: the existing DONE_DESCRIPTION, unchanged, all arms. H4 byte-checks it
 *  against bench/lib/proxy.mjs's own literal rather than trusting this copy. */
export const H2H_DONE_DESCRIPTION =
  'Call this once, when you believe the task is complete. It ends the ' +
  'session. Do not call it before you have actually done the work.';

// ---------------------------------------------------------------------------
// §3.4 — what pw-stock does NOT get
// ---------------------------------------------------------------------------

export const PW_STOCK_WITHHELD = {
  browser_evaluate: 'observation bypass: arbitrary JS in the page reads any DOM state without touching the observation channel',
  browser_run_code_unsafe: 'RCE-equivalent by its own description; also disk access to the fixture HTML — the vector the whole methodology exists to exclude',
  browser_network_requests: 'the fixture source AND the witness answer key are both in the network log',
  browser_network_request: 'returns full response bodies: the fixture document and the witness POSTs to 127.0.0.1:8898',
  browser_take_screenshot: 'a second observation channel (vision) — Sonnet reads images, so leaving it in confounds the text-observation comparison',
  browser_tabs: 'harness integrity: multi-tab witness events are unattributable',
  browser_close: 'harness integrity: ends the session outside task_done',
  browser_resize: 'harness integrity: breaks the pinned symmetric viewport',
};

/**
 * Everything §3.4 says stays. Listed explicitly rather than derived by
 * subtraction so that a tool Playwright ADDS in a future version cannot enter
 * the arm silently — H0 diffs the live `tools/list` against this set and says
 * so.
 */
export const PW_STOCK_KEPT = [
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_find',
  'browser_click', 'browser_type', 'browser_press_key', 'browser_hover',
  'browser_fill_form', 'browser_select_option', 'browser_drag', 'browser_drop',
  'browser_file_upload', 'browser_handle_dialog', 'browser_wait_for',
  'browser_console_messages',
];

// ---------------------------------------------------------------------------
// The aperture upstream (HTTP JSON-RPC)
// ---------------------------------------------------------------------------

/**
 * JSON-RPC over Streamable HTTP, the shape bench/fidelity.mjs and
 * bench/lib/proxy.mjs both speak.
 *
 * DUPLICATED, NOT IMPORTED, and the reason is a rule rather than an oversight:
 * `makeUpstream` is module-private in bench/lib/proxy.mjs, and exporting it
 * would edit a file inside the task suite's `codeVersion` — which would move
 * every cohort stamp in the running suite. The wire format is four lines and is
 * pinned by H1's live probe; the alternative was invalidating $37 of episodes
 * for a refactor.
 */
function makeApertureUpstream(url, token) {
  let id = 0;
  return async function call(name, args = {}) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const body = await res.text();
      const line = body
        .split('\n')
        .find((l) => l.trim().startsWith('{') || l.startsWith('data: {'));
      if (!line) return { text: '', upstreamMs: Date.now() - t0 };
      const parsed = JSON.parse(line.replace(/^data: /, ''));
      return {
        text: parsed.result?.content?.[0]?.text ?? parsed.error?.message ?? '',
        upstreamMs: Date.now() - t0,
      };
    } catch (e) {
      return {
        text: `${HARNESS_ERROR_PREFIX}aperture transport failed: ${e?.message ?? e}`,
        upstreamMs: Date.now() - t0,
        transportFault: true,
      };
    }
  };
}

export async function apertureToolList(url, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await res.text();
  const line = body.split('\n').find((l) => l.trim().startsWith('{') || l.startsWith('data: {'));
  if (!line) return [];
  return JSON.parse(line.replace(/^data: /, '')).result?.tools ?? [];
}

// ---------------------------------------------------------------------------
// SNAPSHOT LINK RESOLUTION — the 0.0.78 finding, made explicit
// ---------------------------------------------------------------------------

/**
 * headtohead.md §1.1 states, from `response.ts` at main, that "every action
 * response embeds a full aria snapshot of the page by default". MEASURED
 * AGAINST THE PINNED 0.0.78 BUNDLE, that is not what happens:
 *
 *   `if (this._includeSnapshot !== 'explicit' || this._includeSnapshotFileName)`
 *       → write the aria yaml to a FILE, emit `- [Snapshot](path.yml)`
 *   `else`
 *       → emit the yaml inline in a ```yaml fence
 *
 * `_includeSnapshot` is `'explicit'` only on the `browser_snapshot` TOOL path.
 * So in 0.0.78 the explicit snapshot inlines and EVERY ACTION RESPONSE LINKS.
 * (coreBundle.js:64833-64841 in playwright-core 1.62.0-alpha-1783623505000.)
 *
 * The agent under test has no filesystem, so an unresolved link is an empty
 * observation, and the pw arms would measure a blindfolded competitor.
 *
 * Two modes, both implemented, neither default-by-accident:
 *
 *   'inline'    — the harness reads the linked file and substitutes the yaml,
 *                 reconstructing the response §1.1 describes and the design of
 *                 record measures. Charges the competitor for bytes it wrote to
 *                 disk rather than to the wire.
 *   'asshipped' — the link is left alone. Measures 0.0.78 exactly as a
 *                 filesystem-less agent receives it.
 *
 * The mode is stamped into the cohort identity, so the two can never pool, and
 * H1 prints which one is live with the finding beside it.
 */
export const PW_OBSERVATION_MODES = ['inline', 'asshipped'];

async function resolveSnapshotLink(text, outputDir) {
  const s = snapshotYaml(text);
  if (!s || s.form !== 'link') return { text, resolved: false };
  const p = isAbsolute(s.path) ? s.path : resolvePath(outputDir, '..', '..', '..', s.path);
  // The link is printed relative to the server's cwd, which is the nested
  // package dir; `outputDir` is absolute. Try the literal path, then the path
  // relative to the output dir's parent chain, then give up LOUDLY.
  for (const cand of [p, resolvePath(outputDir, s.path), resolvePath(dirname(outputDir), s.path)]) {
    try {
      const yaml = await readFile(cand, 'utf8');
      return {
        text: text.replace(
          /^\s*-\s*\[Snapshot\]\([^)]+\)\s*$/m,
          '```yaml\n' + yaml.replace(/\n$/, '') + '\n```',
        ),
        resolved: true,
        from: cand,
      };
    } catch {
      /* try the next candidate */
    }
  }
  return {
    text,
    resolved: false,
    unreadable: s.path,
  };
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {'aperture-diff'|'aperture-redump'|'pw-sealed'|'pw-stock'} o.arm
 * @param {object} o.collector          the loopback witness
 * @param {object} [o.aperture]         { url, token } for the aperture arms
 * @param {object} [o.pw]               the startPw() handle for the pw arms
 * @param {string} [o.pwOutputDir]      where pw writes its snapshot files
 * @param {'inline'|'asshipped'} [o.pwObservation]
 */
export async function startH2hProxy({
  arm,
  collector,
  aperture = null,
  pw = null,
  pwOutputDir = null,
  pwObservation = 'inline',
  port = H2H_PROXY_PORT,
}) {
  if (!H2H_ARM_DEFINITION[arm]) throw new Error(`unknown arm: ${arm}`);
  if (APERTURE_ARMS.has(arm) && !aperture) throw new Error(`${arm} needs an aperture upstream`);
  if (PW_ARMS.has(arm) && !pw) throw new Error(`${arm} needs a playwright upstream`);
  if (!PW_OBSERVATION_MODES.includes(pwObservation)) {
    throw new Error(`--pw-observation must be one of ${PW_OBSERVATION_MODES.join('|')}`);
  }

  const token = randomBytes(24).toString('base64url');
  const isPw = PW_ARMS.has(arm);
  const refGrammar = refGrammarFor(arm);
  const apertureUpstream = aperture ? makeApertureUpstream(aperture.url, aperture.token) : null;

  /**
   * §3.3: `browser_snapshot`'s description is FORWARDED VERBATIM from each
   * product. Asymmetric bytes are correct here — the observation channel's
   * self-explanation is part of the observation channel, and writing Playwright
   * a legend it does not ship would be coaching (or sabotaging) the competitor
   * with our prose.
   */
  let snapshotDesc = '';
  if (isPw) {
    snapshotDesc = pw.tools.find((t) => t.name === 'browser_snapshot')?.description ?? '';
  } else {
    const tools = await apertureToolList(aperture.url, aperture.token);
    snapshotDesc = tools.find((t) => t.name === 'browser_snapshot')?.description ?? '';
  }
  if (!snapshotDesc) {
    throw new Error(`upstream browser_snapshot has no description in ${arm} — refusing to run with no format legend`);
  }

  /** @type {any} */
  let ep = null;

  function newEpisode({ maxSteps, allowed, taskId, inject }) {
    ep = {
      taskId,
      arm,
      maxSteps,
      inject: inject ? { ...inject } : null,
      allowed: new Set(allowed),
      steps: 0,
      capHits: 0,
      done: false,
      doneNote: '',
      model: new Map(),
      observations: [],
      acts: [],
      lastFullAt: -99,
      errors: [],
      toolFaults: 0,
      nonRefTargeting: 0,
      upstreamMs: 0,
      snapshotLinksResolved: 0,
      snapshotLinksUnresolved: 0,
      snapshotAbsent: 0,
    };
    return ep;
  }

  /** The taxonomy, per engine. The aperture one is IMPORTED, never re-derived. */
  const classify = (text) => (isPw ? classifyPwObservation(text) : classifyObservation(text));

  function recordObservation(tool, text, forwarded, upstreamMs) {
    const kind = classify(text);
    const asked = forwarded
      ? { mode: forwarded.mode ?? null, expand: forwarded.expand ?? null }
      : {};
    const row = {
      tool,
      kind,
      chars: text.length,
      truncated: isPw ? false : isTruncated(text),
      upstreamMs: upstreamMs ?? 0,
      ...asked,
      text,
    };
    if (isPw) row.sections = sectionChars(text);
    ep.observations.push(row);
    if (kind === 'full') ep.lastFullAt = ep.observations.length - 1;
    if (isPw) {
      if (kind === 'link') ep.snapshotLinksUnresolved++;
      if (kind === 'header') ep.snapshotAbsent++;
      applyPwObservation(ep.model, text);
    } else {
      applyObservation(ep.model, text);
    }
    ep.upstreamMs += upstreamMs ?? 0;
    return row;
  }

  // -------------------------------------------------------------------------
  // §3.2 — the shim. EVERY ROW OF THE SPEC'S TABLE IS ONE BRANCH HERE.
  // -------------------------------------------------------------------------

  /**
   * @returns {{calls: {name:string, args:object}[], observeIndex:number}|{error:string}}
   *
   * `observeIndex` names which upstream reply is THE observation. Only `scroll`
   * needs more than one call, and only its second reply is the observation:
   * `browser_mouse_wheel` in 0.0.78 takes `{deltaX, deltaY}` and NO position,
   * so "at viewport centre" (§3.2) can only be honoured by moving the pointer
   * there first. That is a positioning primitive, not an observation, and
   * counting its reply would charge the arm for a byte the design does not
   * intend. No fixture scrolls (H3 asserts the scripted solvers never do), so
   * this path is expected dead — it is written correctly anyway because a dead
   * path that silently does the wrong thing is how a benchmark starts lying.
   */
  function shimSealedAct(args) {
    const { action, ref, text, key, deltaY, submit } = args;
    switch (action) {
      case 'click':
        return { calls: [{ name: 'browser_click', args: { target: ref } }], observeIndex: 0 };
      case 'hover':
        return { calls: [{ name: 'browser_hover', args: { target: ref } }], observeIndex: 0 };
      case 'type':
        return {
          calls: [{
            name: 'browser_type',
            args: { target: ref, text: String(text ?? ''), ...(submit ? { submit: true } : {}) },
          }],
          observeIndex: 0,
        };
      // fill semantics make an empty fill exactly "clear"
      case 'clear':
        return { calls: [{ name: 'browser_type', args: { target: ref, text: '' } }], observeIndex: 0 };
      case 'key':
        return { calls: [{ name: 'browser_press_key', args: { key } }], observeIndex: 0 };
      case 'scroll':
        return {
          calls: [
            { name: 'browser_mouse_move_xy', args: { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 } },
            { name: 'browser_mouse_wheel', args: { deltaX: 0, deltaY: Number(deltaY ?? 0) } },
          ],
          observeIndex: 1,
        };
      default:
        return { error: `${HARNESS_ERROR_PREFIX}the shim has no mapping for action "${action}"` };
    }
  }

  /** One upstream call, whichever engine, with link resolution folded in. */
  async function callUpstream(name, callArgs) {
    if (isPw) {
      const r = await pw.call(name, callArgs);
      let text = r.text ?? '';
      if (pwObservation === 'inline' && pwOutputDir) {
        const fixed = await resolveSnapshotLink(text, pwOutputDir);
        text = fixed.text;
        // Counted BOTH WAYS, because "the harness had to rescue this response"
        // is the single most important fact about the pw arms and it must be
        // visible in the store, not only in a preflight's stdout.
        if (fixed.resolved) ep.snapshotLinksResolved++;
        else if (fixed.unreadable) ep.snapshotLinksUnresolved++;
      }
      return { text, upstreamMs: r.upstreamMs, transportFault: r.transportFault === true };
    }
    return apertureUpstream(name, callArgs);
  }

  // -------------------------------------------------------------------------
  // Attribution
  // -------------------------------------------------------------------------

  /**
   * §5.2's pw vocabulary, plus the two buckets §5.2's list omits but the
   * machine can reach. Reported as a spec gap rather than papered over:
   *
   *   stale_ref_error    the act errored on a ref the previous snapshot DID
   *                      contain — pw's analogue of `engine_ref_loss`.
   *   model_bookkeeping  the act errored on a ref the previous snapshot did
   *                      NOT contain. Under a re-dump architecture the last
   *                      response restated the whole page, so a ref missing
   *                      from it was retired in front of the agent — the same
   *                      concept the aperture arms give the same name, which is
   *                      what lets the report compare like with like.
   *   invalid_action     an error that names no ref at all (a malformed
   *                      argument). Borrowed verbatim from the aperture
   *                      vocabulary for the same reason.
   *
   * The non-error half is `attributeAct` from bench/lib/proxy.mjs, CALLED, not
   * copied: `ok` / `wrong_choice` / `identity_mismatch` / `no_page_effect` must
   * mean the same thing in both arms or the headline compares two definitions.
   */
  const PW_REF_ERROR = /not found in the current page snapshot|does not match any elements|aria-ref=|Ref e\d+ not found/i;

  function attributePwAct({ errored, text, shadowHad, ref, landedEvents, labelsAgreeFn }) {
    if (errored) {
      if (isHarnessFault(text)) return 'tool_fault';
      if (!ref) return 'invalid_action';
      if (!PW_REF_ERROR.test(text)) return 'invalid_action';
      return shadowHad ? 'stale_ref_error' : 'model_bookkeeping';
    }
    return attributeAct({
      errored: false,
      text,
      shadowHad,
      landedEvents,
      allowed: ep.allowed,
      labelsAgreeFn,
    });
  }

  // -------------------------------------------------------------------------
  // The three sealed tools
  // -------------------------------------------------------------------------

  function budgetRefusal() {
    ep.capHits++;
    return `error: step budget exhausted (${ep.maxSteps} steps used). Call task_done now.`;
  }

  async function doAct(args) {
    if (ep.done) return 'error: this session is finished — task_done was already called.';
    if (ep.steps >= ep.maxSteps) return budgetRefusal();
    ep.steps++;

    const ref = args.ref;

    // §3.2's ref-grammar enforcement, pw arms only: Aperture rejects a non-ref
    // natively, and this is what makes the refusal symmetric. Recorded BEFORE
    // the upstream call, because an escape that never leaves the proxy still
    // happened and the report says how often.
    if (isPw && ref !== undefined && ref !== null && !refGrammar.test(String(ref))) {
      ep.nonRefTargeting++;
      const t = refRefusal(String(ref));
      recordObservation('browser_act', t, null, 0);
      ep.acts.push({
        action: args.action, ref: String(ref), shadowHad: false, shadowLabel: null,
        pageLabel: null, bench: null, attribution: 'invalid_action',
        tags: ['ref_grammar_refused'], toolFault: false,
      });
      ep.errors.push(t);
      return t;
    }

    const before = collector.all().length;
    const shadowHad = ref ? ep.model.has(ref) : true;
    const shadowLabel = ref ? ep.model.get(ref)?.label : undefined;

    let text;
    let upstreamMs = 0;
    let transportFault = false;

    if (isPw) {
      const plan = shimSealedAct(args);
      if (plan.error) {
        text = plan.error;
      } else {
        const replies = [];
        for (const c of plan.calls) {
          const r = await callUpstream(c.name, c.args);
          upstreamMs += r.upstreamMs ?? 0;
          transportFault = transportFault || r.transportFault === true;
          replies.push(r.text);
        }
        text = replies[plan.observeIndex] ?? replies[replies.length - 1] ?? '';
      }
    } else {
      const forwarded = { ...args, ...(ep.inject ?? {}) };
      // THE ARM, for the aperture side. Nothing else differs between them.
      if (arm === 'aperture-redump') forwarded.observe = 'full';
      const r = await apertureUpstream('browser_act', forwarded);
      text = r.text;
      upstreamMs = r.upstreamMs;
      transportFault = r.transportFault === true;
    }

    recordObservation('browser_act', text, null, upstreamMs);

    // The 260ms quiet window is the aperture suite's, unchanged and shared:
    // asymmetric settle timing would be a quiet thumb on the scale, and this is
    // the number that stopped every type-then-click pair manufacturing a
    // spurious identity_mismatch.
    await settle(collector, 260, 1500);
    const windowed = collector.all().slice(before).filter((e) => e.kind === 'action');
    const wantType = args.action === 'type' || args.action === 'clear' ? 'input' : 'click';
    const preferred = windowed.filter((e) => e.detail?.type === wantType);
    const landedEvents = preferred.length ? preferred : windowed;

    const errored = isPw
      ? /^### Error$/m.test(text) || isHarnessFault(text) || /^error:/m.test(text)
      : REF_ERROR.test(text) || /^error:/m.test(text);

    const tags = [];
    if (ep.observations.length - 1 - ep.lastFullAt <= 2) tags.push('post_resync');

    const labelsAgreeFn = (pageLabel) => labelsAgree(pageLabel, shadowLabel);
    const attribution = isPw
      ? attributePwAct({ errored, text, shadowHad, ref, landedEvents, labelsAgreeFn })
      : attributeAct({ errored, text, shadowHad, landedEvents, allowed: ep.allowed, labelsAgreeFn });

    const toolFault = isHarnessFault(text) || transportFault;
    if (toolFault) ep.toolFaults++;
    if (errored) ep.errors.push(text.slice(0, 200));
    const landed = errored || !landedEvents.length ? null : landedEvents[landedEvents.length - 1];

    ep.acts.push({
      action: args.action,
      ref: ref ?? null,
      shadowHad,
      shadowLabel: shadowLabel ?? null,
      pageLabel: landed?.detail?.label ?? null,
      bench: landed?.detail?.bench ?? null,
      attribution: toolFault ? 'tool_fault' : attribution,
      tags,
      toolFault,
    });
    return text;
  }

  async function doSnapshot(args) {
    if (ep.done) return 'error: this session is finished — task_done was already called.';
    if (ep.steps >= ep.maxSteps) return budgetRefusal();
    ep.steps++;

    if (isPw) {
      // §3.2: mode/expand/budgetTokens are Aperture semantics. Playwright is
      // always full, never collapsed, never budgeted — so `full` is honoured,
      // `auto` upgrades to full, `expand` is vacuously satisfied and
      // `budgetTokens` is ignored. Recorded as forwarded, not as asked, and
      // printed in the run log rather than silently dropped.
      const r = await callUpstream('browser_snapshot', {});
      recordObservation('browser_snapshot', r.text, { mode: 'full', expand: true }, r.upstreamMs);
      if (r.transportFault) ep.toolFaults++;
      return r.text;
    }

    const forwarded = { ...args, ...(ep.inject ?? {}) };
    if (arm === 'aperture-redump') forwarded.mode = 'full';
    const r = await apertureUpstream('browser_snapshot', forwarded);
    recordObservation('browser_snapshot', r.text, forwarded, r.upstreamMs);
    if (r.transportFault) ep.toolFaults++;
    return r.text;
  }

  function doDone(note) {
    ep.done = true;
    ep.doneNote = String(note ?? '');
    return 'recorded';
  }

  // -------------------------------------------------------------------------
  // pw-stock — forwarded verbatim, minus the withheld set
  // -------------------------------------------------------------------------

  /**
   * A forwarded pw tool. Everything the sealed path does for bookkeeping still
   * happens — step cap, observation record, witness attribution — because
   * `pw-stock` is a scored arm and an arm with no bookkeeping is an arm with no
   * numbers.
   *
   * §3.4: selector targeting stays. The proxy records, per act, whether
   * `target` matched the ref grammar; the report gives the non-ref-targeting
   * rate. The witness scores wrong-element actions identically regardless of
   * how the element was targeted, so the metric survives.
   */
  async function doStockTool(name, args) {
    if (ep.done) return 'error: this session is finished — task_done was already called.';
    if (ep.steps >= ep.maxSteps) return budgetRefusal();
    ep.steps++;

    const targets = [args?.target, args?.startTarget, args?.endTarget].filter(
      (t) => typeof t === 'string',
    );
    for (const t of targets) if (!refGrammar.test(t)) ep.nonRefTargeting++;

    const ref = typeof args?.target === 'string' ? args.target : null;
    const shadowHad = ref ? ep.model.has(ref) : true;
    const shadowLabel = ref ? ep.model.get(ref)?.label : undefined;
    const before = collector.all().length;

    const r = await callUpstream(name, args ?? {});
    recordObservation(name, r.text, null, r.upstreamMs);
    await settle(collector, 260, 1500);

    const windowed = collector.all().slice(before).filter((e) => e.kind === 'action');
    const wantType = name === 'browser_type' || name === 'browser_fill_form' ? 'input' : 'click';
    const preferred = windowed.filter((e) => e.detail?.type === wantType);
    const landedEvents = preferred.length ? preferred : windowed;

    const errored = /^### Error$/m.test(r.text) || isHarnessFault(r.text);
    const toolFault = isHarnessFault(r.text) || r.transportFault === true;
    if (toolFault) ep.toolFaults++;
    if (errored) ep.errors.push(r.text.slice(0, 200));

    // Read-only tools produce no witness event by design; attributing them as
    // `no_page_effect` would swamp the metric with correct behaviour.
    const readOnly = new Set([
      'browser_snapshot', 'browser_find', 'browser_console_messages', 'browser_wait_for',
    ]);
    let attribution;
    if (readOnly.has(name) && !errored) attribution = 'ok';
    else {
      attribution = attributePwAct({
        errored, text: r.text, shadowHad, ref, landedEvents,
        labelsAgreeFn: (pageLabel) => labelsAgree(pageLabel, shadowLabel),
      });
    }
    const landed = errored || !landedEvents.length ? null : landedEvents[landedEvents.length - 1];

    ep.acts.push({
      action: name,
      ref,
      shadowHad,
      shadowLabel: shadowLabel ?? null,
      pageLabel: landed?.detail?.label ?? null,
      bench: landed?.detail?.bench ?? null,
      attribution: toolFault ? 'tool_fault' : attribution,
      tags: ref && !refGrammar.test(ref) ? ['non_ref_target'] : [],
      toolFault,
    });
    return r.text;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * The tool surface, built EAGERLY.
   *
   * It used to be assembled inside `createMcpHandler`'s factory, which the SDK
   * calls lazily — once per session, and never before one exists. H4 asked for
   * the fingerprint before any agent had connected and got an empty list and a
   * hash of nothing, which is a green that means "we checked no tools against
   * no tools". Built here instead, and the factory just registers it.
   */
  const toolSpecs = [];

  if (arm === 'pw-stock') {
    for (const t of pw.tools) {
      if (PW_STOCK_WITHHELD[t.name]) continue;
      if (!PW_STOCK_KEPT.includes(t.name)) continue; // unknown tools do not enter silently
      toolSpecs.push({
        name: t.name,
        // Forwarded VERBATIM: names, schemas and descriptions untouched. The
        // schema-token cost of the shipped surface is part of what stock costs
        // and H10 counts it.
        title: t.annotations?.title ?? t.name,
        description: t.description,
        /**
         * THE BUG THAT COST A COHORT, AND IT WAS SILENT BECAUSE IT WAS LAZY.
         *
         * `registerTool` accepts a Standard Schema (a Zod object, or anything
         * exposing `~standard`) or a raw Zod SHAPE. It does NOT accept raw JSON
         * Schema: handed one it throws
         *   TypeError: inputSchema/outputSchema/argsSchema must be a Standard
         *   Schema (e.g. z.object({...})) or a raw Zod shape …
         * The sealed arms pass `z.object(…)` and were always fine. `pw-stock`
         * forwards what `tools/list` gave us, which is JSON Schema — so every
         * registration in this loop threw. And because the throw happens inside
         * `createMcpHandler`'s LAZY per-session factory, nothing failed at
         * startup: `registeredTools()` (built eagerly, right here) cheerfully
         * reported 17 tools while the server 500'd on `initialize` and every
         * pw-stock agent ran the entire episode with ZERO tools. 22 episodes,
         * ~$4, all scored `task_wrong` — which is exactly the reading a failure
         * that never reached the tool surface must never be given.
         *
         * `fromJsonSchema` wraps the JSON Schema in a StandardSchemaWithJSON
         * (auto-selecting the AJV validator) and hands the ORIGINAL back out for
         * `tools/list`, so §3.4's "forwarded verbatim" survives the fix: the
         * served schema is byte-identical to the upstream one. Measured, not
         * assumed — H4 now diffs the LIVE tools/list against this list.
         */
        inputSchema: fromJsonSchema(t.inputSchema),
        /**
         * The wire original, kept because the wrapper is not measurable.
         *
         * `schemaChars` used to read `inputSchema`, which post-fix is the
         * StandardSchema wrapper. MEASURED: that wrapper stringifies to
         *   {"~standard":{"version":1,"vendor":"mcp","jsonSchema":{}}}
         * — 58 bytes, the SAME 58 bytes for every tool. It would have turned
         * pw-stock's real 8,482 schema chars into a flat 17x58, constant-ising
         * H10's toolSurface term and H4's per-turn overhead for the one arm
         * whose entire thesis is that a 17-tool surface costs something.
         * Measure THIS.
         */
        rawSchema: t.inputSchema,
        annotations: t.annotations,
        run: (args) => doStockTool(t.name, args),
      });
    }
  } else {
    toolSpecs.push({
      name: 'browser_act',
      title: 'Act on the page',
      description: H2H_ACT_DESCRIPTION,
      // BYTE-IDENTICAL to bench/lib/proxy.mjs's schema, in all three sealed
      // arms. H4 fingerprints it.
      inputSchema: z.object({
        action: z.enum(['click', 'type', 'hover', 'scroll', 'key', 'clear']),
        ref: z.string().optional().describe('Element to act on. Not needed for scroll or key.'),
        text: z.string().optional().describe('For type.'),
        key: z.string().optional().describe('For key: Enter, Tab, Escape, Backspace, ArrowDown, …'),
        deltaY: z.number().optional().describe('For scroll: pixels. Positive scrolls down.'),
        submit: z.boolean().default(false).describe('For type: press Enter afterwards.'),
      }),
      run: (args) => doAct(args),
    });
    toolSpecs.push({
      name: 'browser_snapshot',
      title: 'Read the page structure',
      description: snapshotDesc,
      inputSchema: z.object({
        mode: z.enum(['auto', 'full']).default('auto'),
        budgetTokens: z.number().int().min(200).max(20000).optional(),
        expand: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true },
      run: (args) => doSnapshot(args),
    });
  }

  toolSpecs.push({
    name: 'task_done',
    title: 'Finish',
    description: H2H_DONE_DESCRIPTION,
    inputSchema: z.object({
      note: z.string().optional().describe('One line: what you did.'),
    }),
    run: ({ note }) => doDone(note),
  });

  const handler = createMcpHandler(() => {
    // Named `browser` in EVERY arm (§3.2), so the tool ids are
    // mcp__browser__* everywhere and the model never sees a product name.
    const server = new McpServer({ name: 'browser', version: '0.1.0' });
    for (const spec of toolSpecs) {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema: spec.inputSchema,
          ...(spec.annotations ? { annotations: spec.annotations } : {}),
        },
        async (args) => ({ content: [{ type: 'text', text: await spec.run(args) }] }),
      );
    }
    return server;
  });

  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const http = createServer((req, res) => {
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;
    if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    void nodeHandler(req, res);
  });

  await new Promise((ok, bad) => {
    http.once('error', bad);
    http.listen(port, '127.0.0.1', () => ok());
  });

  /** Navigation is the harness's, never the agent's, in the sealed arms. */
  async function navigate(url) {
    const name = 'browser_navigate';
    const args = isPw ? { url } : { action: 'goto', url };
    const r = await callUpstream(name, args);
    return r.text;
  }

  return {
    arm,
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    newEpisode,
    episode: () => ep,
    navigate,
    /** The scripted solver drives the SAME code path, minus the transport. */
    direct: { act: doAct, snapshot: doSnapshot, done: doDone, stock: doStockTool },
    registeredTools: () =>
      toolSpecs.map((t) => ({
        name: t.name,
        description: t.description,
        // The JSON Schema the model is actually shown. H4 counts its chars,
        // because a 20-tool surface's schema overhead is one of H10's named
        // decomposition terms and "the schema overhead of 20 tools did it" is
        // a licensed conclusion only if the schemas were measured.
        //
        // `rawSchema` FIRST and it is load-bearing: in pw-stock `inputSchema` is
        // now a `fromJsonSchema` wrapper whose JSON form is a fixed ~58-byte
        // husk, identical for all 17 tools. Measuring the wrapper would have
        // reported a constant where the whole point is a variable.
        schemaChars: JSON.stringify(t.rawSchema ?? t.inputSchema?._zod?.def ?? t.inputSchema ?? {}).length,
      })),
    toolSurfaceFingerprint: () =>
      JSON.stringify({
        act: SEALED_ARMS.has(arm) ? H2H_ACT_DESCRIPTION : null,
        snapshot: snapshotDesc,
        done: H2H_DONE_DESCRIPTION,
        stock: arm === 'pw-stock' ? toolSpecs.map((t) => t.name).sort() : null,
      }),
    snapshotDescription: () => snapshotDesc,
    pwObservation,
    close: async () => {
      await handler.close();
      await new Promise((r) => http.close(() => r()));
    },
  };
}
