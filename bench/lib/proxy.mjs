/**
 * The sealed MCP surface the agent under test sees.
 *
 * Everything the agent can do goes through here, and that is deliberate:
 *
 *  1. THE ARM MUST BE INVISIBLE. The prompt is byte-identical in both arms, so
 *     the arm cannot be signalled in the prompt. It is applied here, by
 *     injecting `observe:"full"` (re-dump) or leaving the default (diff) into
 *     every browser_act. The model cannot tell which arm it is in except by
 *     looking at what it gets back — which is the variable under test.
 *
 *  2. THE SURFACE MUST BE SEALED, not merely allow-listed. browser_navigate
 *     and browser_read are not registered here at all, so they do not exist in
 *     `tools/list` and no allowlist bug can bring them back. browser_read
 *     matters most: innerText re-reads would let the agent route around diff
 *     bookkeeping entirely and dilute the variable under test into nothing.
 *
 *  3. THE SHADOW MODEL MUST SEE EXACTLY WHAT THE AGENT SAW. It is fed here,
 *     from the same bytes, in the same order. That is what makes the difference
 *     between "the LLM lost track" and "the engine lost the ref" decidable.
 *
 *  4. THE STEP CAP MUST BE EXTERNAL. maxTurns exists in the SDK but counts
 *     conversation turns, not page actions; a runaway agent can burn an
 *     unbounded number of actions inside one turn. The cap is counted here.
 *
 * One deviation from Aperture's own tool surface, stated plainly because it is
 * the kind of thing that turns into a false result: browser_act's description
 * is written HERE rather than forwarded, because Aperture's own says "The
 * result is a DIFF against the page state you already hold" — true in one arm
 * and false in the other. A description that lies to one arm is not a
 * controlled experiment. browser_snapshot's description IS forwarded verbatim,
 * which is where the agent gets the snapshot format legend.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import * as z from 'zod';
import {
  applyObservation,
  isDiff,
  isFullSnapshot,
  isNoChange,
  isTruncated,
} from './streamModel.mjs';
import { settle } from './collector.mjs';

export const PROXY_PORT = 8896;

/**
 * The arm, written down in prose so an episode on disk carries the rule it was
 * produced under and a phased run can refuse to pool episodes made under a
 * different one.
 *
 * This is the CLAIM. The two `ep.arm === 'redump'` lines below are the
 * ENFORCEMENT, and they are what actually runs — so the prose is checked the
 * only way prose can be: this file is inside the benchmark's `codeVersion`
 * hash, so the two cannot drift apart without every stamp moving.
 */
export const ARM_DEFINITION = {
  diff:
    'browser_act: no observe override — Aperture returns its default, a diff against ' +
    'the state the agent already holds. browser_snapshot: mode forwarded as the agent asked.',
  redump:
    'browser_act: observe="full" injected at the proxy on every call. ' +
    'browser_snapshot: mode="full" forced at the proxy, so a voluntary snapshot ' +
    'cannot come back as a diff.',
};

/**
 * Arm-neutral, but no weaker than the product's own words.
 *
 * The first version of this said "you do not need to call browser_snapshot
 * after every action" where Aperture's real description says "That is the whole
 * point: do not call browser_snapshot after every action." Permissive where the
 * product is imperative — a fidelity bug in the harness, not a design choice,
 * and one that inflates voluntary re-snapshotting in the diff arm and so
 * deflates the very cost advantage under measurement. Found while diagnosing a
 * G4 trip in the pilot; the threshold was NOT touched, the harness was.
 *
 * The one sentence still dropped is "The result is a DIFF against the page
 * state you already hold", which is true in one arm and false in the other. A
 * description that lies to one arm is not a controlled experiment.
 *
 * The completeness sentences say "the report", not "the diff", and that is the
 * arm-neutrality check spelled out: in the re-dump arm the report is a full
 * snapshot, for which "anything it does not mention is unchanged" and "a
 * re-verifying snapshot returns nothing new" are also true — more obviously so.
 * Identical bytes to both arms can move the absolute level of voluntary
 * snapshotting; it cannot move the between-arm comparison.
 */
const ACT_DESCRIPTION =
  'Click, type, hover, scroll, or press a key on the page, then observe what ' +
  'changed.\n\n' +
  'Aperture reports the result of the action for you. That is the whole point: ' +
  'do not call browser_snapshot after every action. ' +
  'The report after each action is complete: anything it does not mention is ' +
  'unchanged. Do not call browser_snapshot to re-verify what a report already ' +
  'told you — it will return nothing new.\n\n' +
  'Input is dispatched as real browser input, so framework handlers, native ' +
  'widgets and validation behave exactly as they do for a human.\n\n' +
  'If a ref has gone stale you get a targeted error naming what is there now, ' +
  'so you can recover without re-reading the whole page.';

const DONE_DESCRIPTION =
  'Call this once, when you believe the task is complete. It ends the ' +
  'session. Do not call it before you have actually done the work.';

/** JSON-RPC over Streamable HTTP, the same shape bench/fidelity.mjs speaks. */
function makeUpstream(url, token) {
  let id = 0;
  return async function call(name, args = {}) {
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
    if (!line) return '';
    const parsed = JSON.parse(line.replace(/^data: /, ''));
    return parsed.result?.content?.[0]?.text ?? parsed.error?.message ?? '';
  };
}

async function upstreamToolList(url, token) {
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

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Do the page's own label for an element and the agent's model agree?
 *
 * Not string equality: Aperture truncates long accessible names with an ellipsis
 * and normalises whitespace, so a strict compare would manufacture
 * `identity_mismatch` for every long label and bury the real ones. Containment
 * either way is the tolerant-but-still-discriminating rule — "Archive" vs
 * "Archive" agrees, "Archive" vs "Select Marcus Webb" does not.
 */
export function labelsAgree(pageLabel, modelLabel) {
  const a = norm(pageLabel).replace(/…$/, '');
  const b = norm(modelLabel).replace(/…$/, '');
  if (!a || !b) return true; // nothing to contradict
  return a === b || a.includes(b) || b.includes(a);
}

export async function startProxy({ apertureUrl, apertureToken, collector, port = PROXY_PORT }) {
  const token = randomBytes(24).toString('base64url');
  const upstream = makeUpstream(apertureUrl, apertureToken);

  // Forwarded verbatim: this is where the agent gets the snapshot format legend.
  const upstreamTools = await upstreamToolList(apertureUrl, apertureToken);
  const snapshotDesc =
    upstreamTools.find((t) => t.name === 'browser_snapshot')?.description ?? '';
  if (!snapshotDesc) {
    throw new Error('upstream browser_snapshot has no description — refusing to run with no format legend');
  }

  /** @type {any} */
  let ep = null;

  // `inject` is forced onto every upstream browser_act/browser_snapshot call.
  // Its only current use is `budgetTokens` for the size sweep, and it exists
  // because the default budget truncates at ~8k chars: above that page size
  // the re-dump arm's observations are cut and the diff arm's are not, which
  // is not a measurement of diffs, it is a measurement of the budget. Applied
  // to both arms identically — it must never become a second thing that
  // differs between them (see ARM_DEFINITION).
  function newEpisode({ arm, maxSteps, allowed, taskId, inject }) {
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
      observations: [], // { tool, kind, chars, truncated }
      acts: [], // { ref, action, attribution, tags[], landed }
      /** index of the observation that was the most recent FULL SNAPSHOT */
      lastFullAt: -99,
      errors: [],
    };
    return ep;
  }

  function recordObservation(tool, text, forwarded) {
    const kind = isFullSnapshot(text)
      ? 'full'
      : isDiff(text)
        ? 'diff'
        : isNoChange(text)
          ? 'nochange'
          : 'other';
    // The text is kept, not just the shape. `mustObserve` is checked against
    // the diff-only stream, and a failure report that cannot show the bytes the
    // agent actually read is not a failure report.
    //
    // `mode`/`expand` are recorded AS FORWARDED, not as the agent asked: the
    // re-dump arm rewrites mode to 'full' below, and wave 1 could not tell an
    // agent-chosen full from a harness-forced one after the fact.
    const asked = forwarded
      ? { mode: forwarded.mode ?? null, expand: forwarded.expand ?? null }
      : {};
    ep.observations.push({ tool, kind, chars: text.length, truncated: isTruncated(text), ...asked, text });
    if (kind === 'full') ep.lastFullAt = ep.observations.length - 1;
    applyObservation(ep.model, text);
  }

  const REF_ERROR =
    /is not a known element|could not be acted on|no longer|has gone|not found/i;

  async function doAct(args) {
    // task_done ends the session. Without this the model can call it and then
    // carry on acting, and every one of those actions would be scored against a
    // task it had already declared finished.
    if (ep.done) return 'error: this session is finished — task_done was already called.';
    if (ep.steps >= ep.maxSteps) {
      ep.capHits++;
      return `error: step budget exhausted (${ep.maxSteps} steps used). Call task_done now.`;
    }
    ep.steps++;

    const before = collector.all().length;
    const ref = args.ref;
    const shadowHad = ref ? ep.model.has(ref) : true;
    const shadowLabel = ref ? ep.model.get(ref)?.label : undefined;

    const forwarded = { ...args, ...(ep.inject ?? {}) };
    // THE ARM. Nothing else in the whole apparatus differs between the two.
    // Stated in prose as ARM_DEFINITION at the top of this file, which is what
    // gets stamped onto every stored episode.
    if (ep.arm === 'redump') forwarded.observe = 'full';

    const text = await upstream('browser_act', forwarded);
    recordObservation('browser_act', text);

    // Attribute at the moment the fixture event lands, not at the end of the
    // run: only the page can say which element was actually hit.
    //
    // The quiet window is deliberately longer than the witness's own 100ms
    // input debounce. At 120ms it was shorter, and the consequence was measured
    // rather than imagined: a typed field's input event landed AFTER the next
    // action's click, so the "last event in the window" belonged to the
    // previous step and every type-then-click pair manufactured a spurious
    // identity_mismatch.
    await settle(collector, 260, 1500);
    const window = collector.all().slice(before).filter((e) => e.kind === 'action');
    // And even with the timing fixed, the event is chosen by ACTION KIND rather
    // than by arrival: a click on a checkbox also emits an input, and a type
    // emits a focus click. Belt to the braces above.
    const wantType = args.action === 'type' || args.action === 'clear' ? 'input' : 'click';
    const preferred = window.filter((e) => e.detail?.type === wantType);
    const landedEvents = preferred.length ? preferred : window;

    const errored = REF_ERROR.test(text) || /^error:/m.test(text);
    const tags = [];
    // "Within 2 steps of a FULL SNAPSHOT" — the resync window, where a model
    // that just had its world replaced is most likely to be carrying a ref it
    // should have dropped.
    if (ep.observations.length - 1 - ep.lastFullAt <= 2) tags.push('post_resync');

    let attribution;
    let landed = null;
    if (errored) {
      attribution = shadowHad ? 'engine_ref_loss' : 'model_bookkeeping';
      ep.errors.push(text.slice(0, 200));
    } else if (landedEvents.length === 0) {
      attribution = 'no_page_effect';
    } else {
      landed = landedEvents[landedEvents.length - 1];
      const pageLabel = landed.detail?.label;
      if (!labelsAgree(pageLabel, shadowLabel)) attribution = 'identity_mismatch';
      else if (!ep.allowed.has(landed.detail?.bench)) attribution = 'wrong_choice';
      else attribution = 'ok';
    }

    ep.acts.push({
      action: args.action,
      ref: ref ?? null,
      shadowHad,
      shadowLabel: shadowLabel ?? null,
      pageLabel: landed?.detail?.label ?? null,
      bench: landed?.detail?.bench ?? null,
      attribution,
      tags,
    });
    return text;
  }

  async function doSnapshot(args) {
    if (ep.done) return 'error: this session is finished — task_done was already called.';
    if (ep.steps >= ep.maxSteps) {
      ep.capHits++;
      return `error: step budget exhausted (${ep.maxSteps} steps used). Call task_done now.`;
    }
    ep.steps++;
    const forwarded = { ...args, ...(ep.inject ?? {}) };
    // A voluntary snapshot in the re-dump arm must not be allowed to come back
    // as a diff — that would be the re-dump arm observing a diff, which is
    // exactly what guard G3 exists to catch, caused by the harness itself.
    if (ep.arm === 'redump') forwarded.mode = 'full';
    const text = await upstream('browser_snapshot', forwarded);
    recordObservation('browser_snapshot', text, forwarded);
    return text;
  }

  function doDone(note) {
    ep.done = true;
    ep.doneNote = String(note ?? '');
    return 'recorded';
  }

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'aperture', version: '0.1.0' });

    server.registerTool(
      'browser_act',
      {
        title: 'Act on the page',
        description: ACT_DESCRIPTION,
        inputSchema: z.object({
          action: z.enum(['click', 'type', 'hover', 'scroll', 'key', 'clear']),
          ref: z.string().optional().describe('Element to act on. Not needed for scroll or key.'),
          text: z.string().optional().describe('For type.'),
          key: z.string().optional().describe('For key: Enter, Tab, Escape, Backspace, ArrowDown, …'),
          deltaY: z.number().optional().describe('For scroll: pixels. Positive scrolls down.'),
          submit: z.boolean().default(false).describe('For type: press Enter afterwards.'),
        }),
      },
      async (args) => ({ content: [{ type: 'text', text: await doAct(args) }] }),
    );

    server.registerTool(
      'browser_snapshot',
      {
        title: 'Read the page structure',
        description: snapshotDesc,
        inputSchema: z.object({
          mode: z.enum(['auto', 'full']).default('auto'),
          budgetTokens: z.number().int().min(200).max(20000).optional(),
          expand: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: true },
      },
      async (args) => ({ content: [{ type: 'text', text: await doSnapshot(args) }] }),
    );

    server.registerTool(
      'task_done',
      {
        title: 'Finish',
        description: DONE_DESCRIPTION,
        inputSchema: z.object({
          note: z.string().optional().describe('One line: what you did.'),
        }),
      },
      async ({ note }) => ({ content: [{ type: 'text', text: doDone(note) }] }),
    );

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

  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    newEpisode,
    episode: () => ep,
    /** The scripted solver drives the SAME code path, minus the transport. */
    direct: { act: doAct, snapshot: doSnapshot, done: doDone },
    upstream,
    toolSurfaceFingerprint: () =>
      JSON.stringify({ act: ACT_DESCRIPTION, snapshot: snapshotDesc, done: DONE_DESCRIPTION }),
    close: async () => {
      await handler.close();
      await new Promise((r) => http.close(() => r()));
    },
  };
}
