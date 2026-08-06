import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';

/**
 * Input dispatch.
 *
 * Everything here goes through CDP `Input.*` rather than
 * `element.dispatchEvent`, because synthesized DOM events carry
 * `isTrusted: false` and are ignored by native widgets, most date pickers, and
 * a good share of framework handlers. Agent frameworks that shortcut to
 * `dispatchEvent` are also trivially detectable, which is a separate reason
 * not to.
 *
 * One deliberate correction: CDP-generated mouse events set `screenX === clientX`
 * and `screenY === clientY`, which real events never do — the screen
 * coordinates carry the window's own offset. Cloudflare Turnstile checks this
 * (Chromium bug 40280325, still open). We add the window offset so the pair is
 * plausible rather than a signature.
 */

let wired = false;
const pending = new Map<string, (payload: unknown) => void>();
const armings = new Map<string, (payload: unknown) => void>();
const witnesses = new Map<string, (payload: unknown) => void>();
const polls = new Map<string, (payload: unknown) => void>();

function wireOnce(): void {
  if (wired) return;
  wired = true;
  ipcMain.on('aperture:resolve-result', (_e, requestId: string, payload: unknown) => {
    pending.get(requestId)?.(payload);
    pending.delete(requestId);
  });
  ipcMain.on('aperture:witness-armed', (_e, requestId: string, payload: unknown) => {
    armings.get(requestId)?.(payload);
    armings.delete(requestId);
  });
  ipcMain.on('aperture:witness-result', (_e, requestId: string, payload: unknown) => {
    witnesses.get(requestId)?.(payload);
    witnesses.delete(requestId);
  });
  ipcMain.on('aperture:witness-poll-result', (_e, requestId: string, payload: unknown) => {
    polls.get(requestId)?.(payload);
    polls.delete(requestId);
  });
}

export interface Resolved {
  ok: true;
  x: number;
  y: number;
  /**
   * Live viewport geometry, for the capture path's detail crop.
   *
   * OPTIONAL, and that is load-bearing rather than tidiness: against a stale
   * preload artifact these fields are simply absent, and the capture flow
   * treats absence as a decline to the full frame instead of crashing or
   * cropping the wrong pixels. Existing consumers read `ok`/`x`/`y`/
   * `obstructed` and are unaffected.
   */
  rect?: [number, number, number, number];
  vw?: number;
  vh?: number;
  obstructed: boolean;
  obstructor: string | null;
  /**
   * Why a human could not reach this element, from the preload.
   *
   * OPTIONAL for the same named precedent as `rect`/`vw`/`vh` above: against a
   * stale preload artifact the field is simply absent, and absence must mean NO
   * GATING rather than a crash or a blanket refusal. What actually protects a
   * guard run from a stale build is `guards.mjs`'s own refusal, which compares
   * `out/` against `src/` and stops before the first check.
   */
  blocked?: 'inert' | 'modal' | 'no-pointer' | null;
  tag: string;
  editable: boolean;
}
export type ResolveResult = Resolved | { ok: false; reason: string };

export async function resolveRef(
  wc: WebContents,
  key: string,
  timeoutMs = 4000,
): Promise<ResolveResult> {
  wireOnce();
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, reason: 'timed out resolving element' });
    }, timeoutMs);
    pending.set(requestId, (p) => {
      clearTimeout(timer);
      resolve(p as ResolveResult);
    });
    wc.send('aperture:resolve', { requestId, key });
  });
}

/**
 * Did the input we dispatched actually reach the page?
 *
 * `landed`  — a trusted event of a relevant type was counted in the page.
 * `lost`    — a live recorder covering the top document, in the SAME document
 *             the baseline was taken in, counted NOTHING relevant at 500ms and
 *             again at 2500ms. The input path is dead; `ok` would be a lie.
 * `unknown` — the witness could not speak: the poll went unanswered, the
 *             element was gone, the target was in a subframe and the
 *             (suppressible) one-shot stayed silent, a re-poll failed
 *             mid-settle, or THE DOCUMENT CHANGED under the act. The act
 *             proceeds and is reported normally: a mechanism that turns its
 *             own unavailability into an error would invent failures.
 *
 * Two contract lines follow from that, and both are deliberate:
 * a suppressing-but-alive page cannot produce `lost`, and **a navigating act
 * cannot produce `lost`** (docs/design/tier3.md §1.4 and Amendment A.2).
 */
export type DispatchVerdict = 'landed' | 'lost' | 'unknown';

export interface InputWitness {
  /** Wait up to `ms` AFTER dispatch for the page to confirm arrival. */
  settle(ms?: number): Promise<DispatchVerdict>;
}

/**
 * How the witness itself has been doing, cumulatively since process launch.
 *
 * WHY IT EXISTS (docs/design/tier4.md §6.3). `lost` became live attribution in
 * tier3, but `unknown` never did: every unknown verdict falls through to a
 * normal `observe`, so a run in which the witness silently degraded to
 * unknown-mode — dead poll channel, navigating fixtures, subframe targets —
 * looks exactly like a healthy one from outside. In that state W1's
 * lost-detection is BLIND, and a recurrence of the wave-2 wedge would be
 * acknowledged `ok` unseen. These counters are how a consumer can tell the two
 * apart; they change no verdict and gate nothing.
 *
 * Process-global and cumulative on purpose: the bench drives one tab per
 * instance, so a per-tab breakdown would be three numbers describing the same
 * tab, and a reader comparing two rows of the same instance can difference
 * them. They reset when the process does, which is what makes "group by
 * instance" the correct way to read them.
 *
 * Event tallies only. No key, no ref, no URL, no page-derived value of any
 * kind ever enters this object — that is what lets `/metrics` serve it under
 * the same "no page data crosses this endpoint" claim as the rest of the reply
 * (docs/design/security.md).
 */
const WITNESS_TALLY: Record<DispatchVerdict, number> = {
  landed: 0,
  unknown: 0,
  lost: 0,
};

/**
 * Record one `settle()` resolution and pass the verdict through.
 *
 * Every resolution path routes through here exactly once — recorder mode, the
 * subframe one-shot, and the no-witness constant — so `landed + unknown + lost`
 * is the number of settles this process has completed. Wrapping the verdict
 * rather than incrementing at each `return` is deliberate: the recorder-mode
 * settle has five exit points and a counter maintained at each of them would
 * drift the first time one is added.
 */
function tally(v: DispatchVerdict): DispatchVerdict {
  WITNESS_TALLY[v]++;
  return v;
}

/** A snapshot of the tally — a copy, so no caller can hold the live object. */
export function witnessTally(): Record<DispatchVerdict, number> {
  return { ...WITNESS_TALLY };
}

/** Beyond this the listener is a leak, not a witness. Preload-side cleanup. */
const WITNESS_CLEANUP_MS = 5000;
/** The post-dispatch window. Wave-2's wedge produced silence for 40 minutes. */
const WITNESS_WINDOW_MS = 500;
/**
 * The bounded retry after a silent first window: 2500ms total post-dispatch.
 *
 * A page whose main thread is blocked by a long task delivers the event late,
 * and 500ms of silence on a busy-but-alive page must not produce a terminal
 * error. A wedge is not a latency phenomenon — wave 2's was absolute silence
 * for forty minutes — so waiting another two seconds costs no detection power
 * and removes a whole false-alarm class.
 */
const WITNESS_RETRY_MS = 2000;
/** A poll the preload never answers means the apparatus is gone, not broken. */
const POLL_TIMEOUT_MS = 1000;
/**
 * The short-circuit ladder: extra polls at 20% and 50% of the settle window —
 * 100ms and 250ms against the shipped 500ms — as fractions, so the whole
 * schedule scales with whatever `settle(ms)` is given.
 *
 * WHY. Arrival on a healthy page is ~0-5ms, and waiting the full 500ms before
 * asking cost ~500ms on EVERY act: roughly an hour across wave 3's ~7,000
 * acts, which is money and also an hour more exposure to the very wedge this
 * exists to catch. Polling earlier cannot change WHICH acts are `landed` — the
 * counters only increment, so an advance visible at 100ms is visible at 500ms,
 * and a trace frozen through 500ms reaches exactly the same authoritative poll
 * it always did.
 *
 * The rungs are ADVANCE-ONLY, and that rule is load-bearing rather than
 * tidiness: an unanswered or unhappy rung is IGNORED and falls through to the
 * next. Only the 500ms poll and the 2500ms re-poll carry `unknown` authority.
 * Without the rule, a flaky-but-recovering IPC channel would convert traces
 * that score `landed` or `lost` into `unknown` — precisely on the
 * apparatus-degradation traces G6b exists to see. Amendment A.3 of
 * docs/design/tier3.md.
 */
const RUNG_FRACTIONS = [0.2, 0.5] as const;

/** Which recorder counters an action is allowed to be witnessed by. */
export const RELEVANT_COUNTERS = {
  click: ['pointerdown', 'mousedown', 'mouseup', 'click'],
  clear: ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown'],
  type: ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown'],
  hover: ['mousemove'],
  scroll: ['wheel'],
  key: ['keydown'],
} as const satisfies Record<string, readonly string[]>;

interface PollOk {
  ok: true;
  top: boolean;
  /**
   * Identity of the DOCUMENT that owns `counts`. Absent only if a preload
   * older than Amendment A ever answers — in which case every reply lacks it
   * equally, the comparison below degrades to "always matches", and behaviour
   * is the pre-amendment behaviour rather than a spurious mismatch.
   */
  docToken?: string;
  counts: Record<string, number>;
}
type PollResult = PollOk | { ok: false; reason: string } | null;

/** One `aperture:witness-poll` round trip. `null` means it went unanswered. */
async function pollWitness(
  wc: WebContents,
  key: string | null,
  timeoutMs: number,
): Promise<PollResult> {
  wireOnce();
  const requestId = randomUUID();
  return new Promise<PollResult>((resolve) => {
    const timer = setTimeout(() => {
      polls.delete(requestId);
      resolve(null);
    }, timeoutMs);
    polls.set(requestId, (p) => {
      clearTimeout(timer);
      resolve((p as PollResult) ?? null);
    });
    try {
      wc.send('aperture:witness-poll', { requestId, ...(key === null ? {} : { key }) });
    } catch {
      // The tab was destroyed mid-act. That is the apparatus going away, not
      // the input path failing, and it must resolve to `unknown` rather than
      // throwing out of `settle()` into the tool's error path.
      clearTimeout(timer);
      polls.delete(requestId);
      resolve(null);
    }
  });
}

/** Did any counter in the relevant set move between two polls? */
function advanced(
  before: Record<string, number>,
  after: Record<string, number>,
  kinds: readonly string[],
): boolean {
  return kinds.some((k) => (after[k] ?? 0) > (before[k] ?? 0));
}

/** The verdict a witness that could not be established must return. */
const UNKNOWN_WITNESS: InputWitness = { settle: async () => tally('unknown') };

export interface WitnessTuning {
  settleMs?: number;
  retryMs?: number;
  pollTimeoutMs?: number;
  armTimeoutMs?: number;
}

/**
 * Establish a witness for input that is about to be dispatched.
 *
 * WHY THIS EXISTS. Wave 2 ended with Aperture's input path wedged for forty
 * minutes while `browser_act` answered `ok` to every call: CDP
 * `Input.dispatchMouseEvent` resolved, the walker kept serving snapshots, the
 * renderer kept loading pages — and not one click reached the DOM. Nothing
 * anywhere in the stack could tell "the click landed and the page did nothing"
 * from "the click never landed", so the agent was told the first when the
 * truth was the second. CDP's completion is a statement about the browser
 * process accepting the command, not about arrival in the DOM.
 *
 * WHY IT IS A POLL AND NOT A LISTENER. The first W1 armed a listener at act
 * time; Gate 2 proved live that a page's own earlier-registered
 * `stopImmediatePropagation` capture handler silences it, so healthy pages
 * with drag/overlay/editor handlers were reported as a broken browser. The
 * recorder in `src/preload/page.ts` is registered at document_start, ahead of
 * every page script, and only counts `isTrusted` events — a page can neither
 * suppress it nor feed it. This function reads those counters across the
 * dispatch.
 *
 * Three modes, and which one is chosen is itself the safety property:
 *
 *   - **unknown mode** — the baseline poll went unanswered or came back
 *     unhappy. `settle()` returns `'unknown'` unconditionally. A mechanism
 *     that turned its own unavailability into an error would invent failures.
 *   - **subframe mode** (`top: false`) — the target lives in another document,
 *     which the recorder cannot speak for. Falls back to the one-shot
 *     listener: fired → `landed`, silent → `unknown`, NEVER `lost`. A
 *     suppressible witness is not allowed to declare the input path dead.
 *   - **recorder mode** (`top: true`, including targetless scroll/key) — the
 *     only mode that can return `lost`, and only after two silent windows in
 *     one unbroken document.
 */
export async function witnessInput(
  wc: WebContents,
  key: string | null,
  kinds: readonly string[],
  tuning: WitnessTuning = {},
): Promise<InputWitness> {
  wireOnce();
  const pollTimeoutMs = tuning.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const settleMs = tuning.settleMs ?? WITNESS_WINDOW_MS;
  const retryMs = tuning.retryMs ?? WITNESS_RETRY_MS;

  const baseline = await pollWitness(wc, key, pollTimeoutMs);
  if (!baseline || baseline.ok !== true) return UNKNOWN_WITNESS;

  if (!baseline.top) {
    // `top: false` is only reachable when a key was supplied — the preload
    // answers `top: true` for a keyless poll, because a keyless poll is asking
    // about the document the recorder covers. The guard is belt-and-braces:
    // if that ever stops holding, the answer is `unknown`, never a verdict
    // derived from a frame the recorder cannot see.
    if (key === null) return UNKNOWN_WITNESS;
    return armOneShotWitness(wc, key, kinds, tuning.armTimeoutMs ?? 1000);
  }

  const before = baseline.counts;
  const baseToken = baseline.docToken;

  /**
   * One rung of the ladder, or one authoritative poll.
   *
   * `'continue'` means "nothing decided here" — for an early rung that is also
   * what an unanswered or unhappy poll produces, which is the advance-only
   * rule; an authoritative poll turns those into `'unknown'` instead.
   */
  const read = (r: PollResult, authoritative: boolean): DispatchVerdict | 'continue' => {
    if (!r || r.ok !== true) return authoritative ? 'unknown' : 'continue';
    // The document turned over under the act — a link click, an Enter that
    // submitted. The counters on the other side of that boundary belong to a
    // different recorder and comparing them says nothing, so this resolves
    // immediately: a later poll can never re-match, and there is nothing left
    // to wait for. `unknown` rather than `landed` because the token proves the
    // document changed, NOT that this act's input arrived; the observe that
    // follows reports the navigation either way. A wedge cannot escape here —
    // a wedged tab delivers no input, so nothing navigates, so the token still
    // matches and the counters are still frozen at 2500ms.
    if (r.docToken !== baseToken) return 'unknown';
    if (advanced(before, r.counts, kinds)) return 'landed';
    return 'continue';
  };

  /**
   * The verdict machine. Five exit points, which is exactly why `settle` below
   * wraps it in ONE `tally` call instead of counting at each `return`.
   */
  const resolveVerdict = async (ms: number): Promise<DispatchVerdict> => {
    // Every poll after the baseline deliberately carries NO key. The key's
    // only job was answering the frame question, which the baseline already
    // answered; the counters are a property of the document, not of the
    // element. Re-keying would report `unknown` for every act that
    // legitimately removed its own target — a click on "Reject" that deletes
    // its row — which is most of what an agent does, and it would buy
    // nothing: under a real wedge the target never disappears, because
    // nothing happened.
    let elapsed = 0;
    for (const fraction of RUNG_FRACTIONS) {
      const at = Math.round(ms * fraction);
      await delay(at - elapsed);
      elapsed = at;
      const verdict = read(await pollWitness(wc, null, pollTimeoutMs), false);
      if (verdict !== 'continue') return verdict;
    }

    await delay(ms - elapsed);
    const authoritative = read(await pollWitness(wc, null, pollTimeoutMs), true);
    if (authoritative !== 'continue') return authoritative;

    await delay(retryMs);
    const retried = read(await pollWitness(wc, null, pollTimeoutMs), true);
    return retried === 'continue' ? 'lost' : retried;
  };

  return {
    settle: async (ms = settleMs): Promise<DispatchVerdict> =>
      tally(await resolveVerdict(ms)),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The pre-tier3 one-shot listener, kept for subframe targets only.
 *
 * The two-step (arm, ack, dispatch) is not ceremony: a synthesized click can
 * beat an `addEventListener` into place, and a witness that loses that race
 * reports a false alarm on the exact path an agent must be able to trust.
 *
 * Its silence is `'unknown'`, never `'lost'` — see `witnessInput`'s subframe
 * mode and docs/design/tier3.md §1.3.2.
 */
async function armOneShotWitness(
  wc: WebContents,
  key: string,
  types: readonly string[],
  armTimeoutMs: number,
): Promise<InputWitness> {
  const requestId = randomUUID();

  const result = new Promise<unknown>((resolve) => {
    witnesses.set(requestId, resolve);
  });

  const armed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      armings.delete(requestId);
      resolve(false);
    }, armTimeoutMs);
    armings.set(requestId, (p) => {
      clearTimeout(timer);
      resolve((p as { ok?: boolean } | null)?.ok === true);
    });
    wc.send('aperture:witness', {
      requestId,
      key,
      types: [...types],
      timeoutMs: WITNESS_CLEANUP_MS,
    });
  });

  if (!armed) {
    witnesses.delete(requestId);
    return UNKNOWN_WITNESS;
  }

  return {
    settle: (ms = WITNESS_WINDOW_MS) =>
      new Promise<DispatchVerdict>((resolve) => {
        // The resolver is deliberately LEFT registered when this window
        // expires: the preload always answers, at the latest on its own
        // cleanup timer, and letting that answer land is what frees the entry.
        // `resolve` after the first call is a no-op, so the late reply cannot
        // change a verdict already returned.
        const timer = setTimeout(() => resolve('unknown'), ms);
        void result.then((p) => {
          clearTimeout(timer);
          const r = p as { witnessed?: boolean } | null;
          resolve(r?.witnessed === true ? 'landed' : 'unknown');
        });
        // `.then` on the promise, not a call at each `resolve`: the promise
        // settles once however many times `resolve` is called, so the tally
        // cannot double-count a late preload reply.
      }).then(tally),
  };
}

async function cdp(wc: WebContents, method: string, params: object): Promise<void> {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  await wc.debugger.sendCommand(method, params);
}

/**
 * Screen-space offset for a viewport point.
 *
 * Approximates the window position plus browser chrome. Exactness is not the
 * goal — the goal is that screenX/screenY differ from clientX/clientY the way
 * they do in a real browser.
 */
let windowOffset: { dx: number; dy: number } = { dx: 0, dy: 88 };

/** Kept current by the tab manager, which owns the window. */
export function setWindowOffset(dx: number, dy: number): void {
  windowOffset = { dx, dy };
}

function screenOffset(_wc: WebContents): { dx: number; dy: number } {
  return windowOffset;
}

export async function click(
  wc: WebContents,
  x: number,
  y: number,
  opts: { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {},
): Promise<void> {
  const { dx, dy } = screenOffset(wc);
  const base = {
    x,
    y,
    // Without these the pair is identical, which is the documented tell.
    screenX: x + dx,
    screenY: y + dy,
    button: opts.button ?? 'left',
    clickCount: opts.clickCount ?? 1,
    buttons: 1,
    pointerType: 'mouse',
  };

  // A real click is preceded by the pointer arriving. Some handlers only bind
  // to hover, and some detectors look for a click with no approach at all.
  await cdp(wc, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0, clickCount: 0 });
  await cdp(wc, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp(wc, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

export async function hover(wc: WebContents, x: number, y: number): Promise<void> {
  const { dx, dy } = screenOffset(wc);
  await cdp(wc, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, screenX: x + dx, screenY: y + dy,
    buttons: 0, pointerType: 'mouse',
  });
}

/**
 * Type text as a sequence of key events.
 *
 * `Input.insertText` is one call and much faster, but it produces no keydown
 * or keyup at all — which breaks sites that filter, mask, or autocomplete on
 * keystrokes, and looks nothing like a human on sites that measure cadence.
 */
export async function typeText(
  wc: WebContents,
  text: string,
  opts: { delayMs?: number } = {},
): Promise<void> {
  const delay = opts.delayMs ?? 12;
  for (const ch of text) {
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
}

/** Named keys: Enter, Tab, Escape, Backspace, arrows. */
export async function pressKey(wc: WebContents, key: string): Promise<void> {
  const map: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    PageUp: { code: 'PageUp', keyCode: 33 },
  };
  const k = map[key];
  if (!k) throw new Error(`unsupported key: ${key}`);

  const common = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(k.text ? { text: k.text } : {}) });
  await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

export async function scroll(
  wc: WebContents,
  x: number,
  y: number,
  deltaY: number,
): Promise<void> {
  const { dx, dy } = screenOffset(wc);
  await cdp(wc, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, screenX: x + dx, screenY: y + dy,
    deltaX: 0, deltaY, pointerType: 'mouse',
  });
}

/** Clear a focused field without assuming the page honours select-all. */
export async function clearField(wc: WebContents): Promise<void> {
  await cdp(wc, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await cdp(wc, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await pressKey(wc, 'Delete');
}
