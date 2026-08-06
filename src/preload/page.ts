import { ipcRenderer } from 'electron';
import { isDisabled, walk } from '@core/snapshot/walker.js';
import {
  describe as describeOption,
  matchOption,
  type OptionInfo,
} from '@core/snapshot/selectOption.js';
import { quoteFull } from '@core/snapshot/text.js';

/**
 * Preload injected into every web page. Hostile territory.
 *
 * Runs in an isolated world, so page JavaScript can neither see nor redefine
 * anything here. Nothing is exposed to the page — there is deliberately no
 * `contextBridge.exposeInMainWorld` call. The only surface is an IPC channel
 * the main process calls *into*; the page has no way to reach it.
 */

interface WalkRequest {
  requestId: string;
}

/**
 * Identity key → live element, rebuilt on every walk. Lives only in this
 * isolated world, so the page can neither read it nor tamper with it.
 */
let index = new Map<string, HTMLElement>();

// -- the input recorder (W1) ------------------------------------------------

/**
 * A witness for dispatched input THAT THE PAGE CANNOT PREEMPT.
 *
 * WHAT WENT WRONG BEFORE. The first W1 armed a capture-phase listener on the
 * target's window AT ACT TIME and its comment claimed that being first in the
 * capture path made it unsuppressable. That is empirically false and Gate 2
 * proved it live: a page whose own script runs
 * `window.addEventListener('mousedown', e => e.stopImmediatePropagation(), true)`
 * at parse time silences every listener registered LATER on that node —
 * isolated worlds share the per-node listener list for dispatch, and
 * `stopImmediatePropagation` cuts the list at the caller. The page registered
 * first, W1 registered second, so a click that LANDED (the fixture's counter
 * incremented) came back as the terminal "input never reached the page" error.
 * A whole healthy class of pages — drag handlers, overlays, editor libraries —
 * was being reported as a broken browser.
 *
 * WHAT MAKES THIS ONE DIFFERENT: registration ORDER, not capture phase. This
 * runs at document_start, in the preload, before any page script exists. No
 * handler the page registers later can suppress it, because
 * `stopImmediatePropagation` only silences listeners after the caller in the
 * list, and there is nothing before us. Probed on Electron 43 (2026-08-02)
 * against a hostile fixture registering `stopImmediatePropagation` capture
 * handlers on `window` for ALL of pointerdown/mousedown/mouseup/click/keydown:
 * this recorder observed every CDP-dispatched event; a listener registered
 * after page load (the shipped W1's shape) observed ZERO. See
 * docs/design/tier3.md §1.2 and §8.
 *
 * WHY `isTrusted`: the same probe had the fixture flooding synthetic
 * `mousedown` events every 100ms. Those arrive `isTrusted: false`; CDP-
 * dispatched input arrives `isTrusted: true`. Without the filter a page could
 * mask a genuinely dead input path by manufacturing arrivals. With it, the
 * counters move only for input the browser itself delivered.
 *
 * The handlers are two lines and do nothing else on purpose: no
 * stopPropagation, no preventDefault, no per-event IPC. `passive: true` so the
 * recorder can never delay scrolling. `counts` lives in this isolated world;
 * the page holds no reference to it, to the listeners, or to this world's
 * `EventTarget.prototype`, so it can neither read the counters nor remove the
 * recorder.
 *
 * It witnesses ARRIVAL, not effect. A click that reaches a dead button still
 * counts — "the action caused no visible change" is a real finding about the
 * page and turning it into an engine error is exactly what W1 must not do.
 */
const RECORDED_TYPES = [
  'pointerdown',
  'mousedown',
  'mouseup',
  'click',
  'keydown',
  'wheel',
  'mousemove',
] as const;

const inputCounts: Record<string, number> = Object.create(null) as Record<string, number>;

/**
 * A per-document identity for the counters, and the defect it closes.
 *
 * THE COUNTERS DIE WITH THE DOCUMENT. This recorder, and everything it has
 * counted, is torn down when a navigation commits; the new document gets a
 * fresh preload and fresh counters starting at zero. A settle poll issued
 * after that commit is therefore answered by a DIFFERENT recorder, and the
 * main process — comparing with a strict `>` against a baseline taken in the
 * old document — reads the reset as "frozen". The act that CAUSED the
 * navigation is the commonest healthy action a real page has: a link click, an
 * Enter that submits a form. Left alone it returns the terminal
 * restart-the-browser error. The old one-shot was immune only by accident, in
 * that it resolved at ~0ms, before teardown. See Amendment A.2 of
 * docs/design/tier3.md.
 *
 * So every happy reply carries this token and the main process treats ANY
 * token change as `unknown`, rather than comparing counts across a boundary
 * where the comparison means nothing. It is not security-bearing — the page
 * cannot reach it, and forging it could only ever buy an `unknown` — so
 * uniqueness across two documents in one tab is the entire requirement.
 * `crypto.randomUUID` is undefined outside secure contexts, which plain-http
 * pages are, hence the fallback.
 */
const docToken = ((): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Falls through to the arithmetic fallback, which is sufficient alone.
  }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
})();

for (const type of RECORDED_TYPES) {
  inputCounts[type] = 0;
  window.addEventListener(
    type,
    (e: Event) => {
      if (e.isTrusted) inputCounts[e.type] = (inputCounts[e.type] ?? 0) + 1;
    },
    { capture: true, passive: true },
  );
}

/**
 * Report the recorder's counters, and whether the named element is one the
 * recorder can speak for.
 *
 * `top` is the frame question. The recorder is registered on THIS document's
 * window, so it counts input delivered to this document only. An element that
 * lives in a subframe has its own window and its own preload instance, and
 * nothing here can corroborate arrival over there — so the main process is
 * told, and falls back to the one-shot listener with `lost` disabled.
 *
 * `docToken` rides on every happy reply so the main process can tell a frozen
 * counter from a counter that belongs to a different document — see the token's
 * own comment above.
 *
 * `reason` strings stay fixed vocabulary (`gone`, `poll-failed`) — never
 * interpolated from a caught error. Nothing on this channel currently reaches
 * the agent (an unhappy poll produces the `unknown` verdict, which is silent),
 * but the discipline is the one docs/design/security.md asks for and costs
 * nothing to keep.
 */
ipcRenderer.on(
  'aperture:witness-poll',
  (_event, req: { requestId: string; key?: string }) => {
    const reply = (payload: unknown): void => {
      ipcRenderer.send('aperture:witness-poll-result', req.requestId, payload);
    };

    try {
      let top = true;
      if (req.key !== undefined && req.key !== null) {
        const el = index.get(req.key);
        if (!el || !el.isConnected) return reply({ ok: false, reason: 'gone' });
        // Whether `index` can hold an element whose owner document is not this
        // one. The old comment here asserted that it CAN, because "the walker
        // descends into same-origin subframes" — which is false at this HEAD:
        // `walker.ts` contains no `contentDocument` access and maps IFRAME to a
        // leaf role, and a preload without `nodeIntegrationInSubFrames` runs in
        // the main frame only. So this is expected to be `true` always. It is
        // kept as a CHECK rather than deleted, because if that configuration
        // ever changes the honest answer is "the recorder cannot speak for that
        // frame" and not a verdict derived from counters that never saw it.
        top = el.ownerDocument === document;
      }
      // A copy, so a reply in flight cannot be mutated by a later event.
      reply({ ok: true, top, docToken, counts: { ...inputCounts } });
    } catch {
      reply({ ok: false, reason: 'poll-failed' });
    }
  },
);

ipcRenderer.on('aperture:walk', (_event, req: WalkRequest) => {
  const reply = (payload: unknown): void => {
    ipcRenderer.send('aperture:walk-result', req.requestId, payload);
  };

  try {
    const fresh = new Map<string, HTMLElement>();
    const result = walk({
      frameId: 0,
      doc: document,
      win: window,
      index: fresh,
      seen: new Map(),
    });
    index = fresh;
    reply({ ok: true, result });
  } catch (err) {
    // A page that throws from a getter we touched must not take the whole
    // snapshot down — report and let the engine decide.
    reply({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Fill fields — including credentials.
 *
 * WHY THE WRITE IS AIMED BY IDENTITY AND NOT BY FOCUS
 *
 * `act.ts`'s doctrine is that everything goes through CDP, because synthesized
 * events are untrusted and detectable. This is an owned divergence from it, the
 * same class as `select` (docs/design/tier1.md section 2), and the reasoning is
 * its own.
 *
 * CDP key events go to WHATEVER HAS FOCUS AT THE MOMENT EACH ONE IS DELIVERED,
 * and delivery is one round trip per character at ~12ms. A 20-character
 * password is ~40 CDP commands spanning a quarter of a second, during which the
 * page may move focus: an autocomplete dropdown, a validation handler, a modal,
 * a `focus()` call in a `keyup` listener. If focus moves at character 9, nine
 * characters of the credential are in the password field and eleven are in
 * whatever took focus — potentially a visible `input[type=text]` whose value
 * the walker serialises into the next snapshot, i.e. straight into agent
 * context. For an ordinary typed string that race is a usability bug; for a
 * secret it is a disclosure, into exactly the component the whole design exists
 * to keep blind. `Input.insertText` loses on the same argument before fidelity
 * is even reached: it also targets the focused element.
 *
 * `index.get(key)` resolves ONE element and the setter is called on it. There
 * is no intermediate state and no dependency on focus.
 *
 * WHAT THE SETTER BUYS. It is taken from THIS isolated world's prototype, so a
 * page that monkeypatches its own builtins cannot intercept or redirect the
 * write. React's value tracker is installed with `Object.defineProperty` on the
 * MAIN world's wrapper for the node and is therefore not on the object this
 * code touches, so the DOM value diverges from React's cached value and the
 * dispatched `input` reads as a genuine change.
 *
 * WHAT IT DOES NOT BUY, SAID PLAINLY. No `keydown`, `keyup`, `beforeinput` or
 * `compositionend`, so input masks, phone formatters and forms that gate
 * submission on having seen typing will not see what they expect. And the
 * events carry `isTrusted: false`, so a site that checks it will ignore the
 * write. Both failure modes are DETECTABLE, not silent, and that is what makes
 * them acceptable: the deferred verification below catches them and turns them
 * into a refusal rather than a false success.
 *
 * This protects the integrity of the fill. It provides no confidentiality — the
 * page owns its DOM and can read the field back afterwards. That is a property
 * of the web platform, not a gap in this code.
 *
 * REASON STRINGS ON THIS CHANNEL ARE LITERALS, WITHOUT EXCEPTION. The catch
 * block replies `write-failed` and nothing else. `browser_fill_form` used to
 * print an interpolated `err.message` OUTSIDE the untrusted-content envelope —
 * one of the four sites docs/design/security.md names under "Preload reason
 * strings are NOT all literals". That one is closed here, and it costs nothing
 * to hold from the start.
 */
type FillKind = 'profile' | 'username' | 'password' | 'otp';
type FillReason =
  | 'origin-changed' | 'gone' | 'subframe' | 'not-input' | 'not-masked'
  | 'not-editable' | 'too-small' | 'no-setter' | 'reverted' | 'write-failed';

interface FillTarget {
  key: string;
  kind: FillKind;
  value: string;
}

/** Below this a "field" is a hidden trap rather than something a human types in. */
const MIN_FILL_WIDTH = 16;
const MIN_FILL_HEIGHT = 8;

/**
 * How long to wait before asking whether the value stuck.
 *
 * NOT 0ms: a controlled component that snaps back does so on its next render,
 * and a same-task read-back cannot see it. NOT 2000ms: this reply is on the
 * critical path of a human-visible action, and a framework that has not
 * re-rendered in 250ms has not re-rendered because of this write.
 *
 * The same-task read-back is kept AS WELL, because it catches the synchronous
 * class the deferred one cannot attribute: a page whose `input` handler
 * rewrites `el.value` in the same event turn. MEASURED (probe, Electron 43,
 * 2026-08-03): a handler doing `p.value = p.value.slice(0,8)` produced
 * `landed:false` and `FILL_REVERTED` with the page holding 8 characters.
 *
 * The spec's stated example for this check — `maxlength` truncation — is NOT
 * one, and the same probe showed why: `maxlength` constrains USER input only
 * and does not apply to a programmatic value assignment. A 13-character
 * password written into a `maxlength=8` field lands whole, `landed:true`, with
 * the page reading all 13. The check earns its place on the sanitiser class,
 * not on that one.
 *
 * The 250ms number is a judgement, not a measurement: a framework that reverts
 * at 400ms reports `landed: true`. Stated in docs/design/vaultfill.md section
 * 17.8 rather than hidden.
 */
const VERIFY_DELAY_MS = 250;

ipcRenderer.on(
  'aperture:fill',
  (
    _event,
    req: {
      requestId: string;
      expectedOrigin: string;
      atomic: boolean;
      targets: FillTarget[];
    },
  ) => {
    const reply = (payload: unknown): void => {
      ipcRenderer.send('aperture:fill-result', req.requestId, payload);
    };

    try {
      // THE TOCTOU FIX, and it is total rather than narrow.
      //
      // Main computes `expectedOrigin` before it raises the consent dialog, and
      // the dialog is open for as long as a human takes to read it. Nothing
      // used to re-check the committed origin in between, so a tab that
      // navigated during that window landed the values in a document the human
      // never approved. Main and this preload are separate tasks — but the
      // VALIDATION AND THE WRITE BELOW ARE THE SAME TASK, and a cross-document
      // navigation cannot commit in the middle of one. The residual window is
      // not "as long as the human reads the dialog"; it is zero.
      //
      // THAT ARGUMENT IS ABOUT NAVIGATION AND NOTHING ELSE. One task is not one
      // turn: the page's own handlers run inside this one, between validation
      // and the writes. See the write pass for the re-check that closes it.
      //
      // `location` is read from the isolated world, where the page cannot
      // redefine it.
      if (location.origin !== req.expectedOrigin) {
        return reply({ ok: false, reason: 'origin-changed' as FillReason });
      }

      // Validation pass. Every target, in order, BEFORE any write — collecting
      // failures rather than stopping at the first, so a non-atomic fill can
      // report exactly which ones it skipped and why.
      const checked: { t: FillTarget; el: HTMLElement }[] = [];
      const skipped: { key: string; kind: FillKind; reason: FillReason }[] = [];

      const fail = (t: FillTarget, reason: FillReason): void => {
        skipped.push({ key: t.key, kind: t.kind, reason });
      };

      for (const t of req.targets) {
        // An identity key the current index does not hold at all. Everything
        // else — including `isConnected`, whose absence was the old handler's
        // first defect, "the value is in the page" versus "the value is in a
        // node nobody can see" — is `checkTarget`'s.
        const el = index.get(t.key);
        if (!el) {
          fail(t, 'gone');
          continue;
        }
        const bad = checkTarget(t, el);
        if (bad) {
          fail(t, bad);
          continue;
        }
        checked.push({ t, el });
      }

      // ATOMIC: any failure means nothing is written at all. Because validation
      // is complete before the first write, `ok:false` here is a claim main can
      // rely on — it is what lets the caller drop the taint it applied.
      const firstFailure = skipped[0];
      if (req.atomic && firstFailure) {
        return reply({ ok: false, reason: firstFailure.reason, key: firstFailure.key });
      }

      // Write pass.
      //
      // VALIDATION AND THE WRITE ARE ONE TASK, BUT THEY ARE NOT ONE TURN, AND
      // THE DIFFERENCE IS THE WHOLE REASON FOR THE RE-CHECK BELOW.
      //
      // The same-task argument above is about NAVIGATION: a cross-document
      // commit cannot land in the middle of one task, so the origin echo is
      // exact. It says nothing about the page's own JavaScript, which runs
      // synchronously and repeatedly inside this loop: `focus()` fires
      // focus/focusin handlers, and the dispatched `input`/`change` fire
      // theirs. Targets are written username → password → otp, so the
      // username's handlers ALWAYS run before the password is written.
      //
      // MEASURED at c375415 by an independent review, with a fixture whose
      // username `focus`/`input` handler mutates the password field: `p.type =
      // 'text'`, `p.disabled = true` and `p.readOnly = true` each produced
      // `filled username and password …` while the page's own witness read
      // `pw-match:true pw-type:text`. The saved password went into an unmasked
      // field — in cleartext on the human's own screen — and into fields no
      // human could have typed in, and Aperture reported plain success. Three
      // pieces of shipped text asserted the opposite.
      //
      // So every predicate is re-asserted for each target BETWEEN `focus()` and
      // `setter.call`. Nothing page-authored runs in that gap: the setter comes
      // from this isolated world's prototype, so the page cannot intercept it,
      // and there is no `await` between the two lines. What the page does AFTER
      // its value has been written is not something any check here can prevent
      // — the page owns its DOM and already holds the value — and the honest
      // claim is therefore about the instant of the write, which is what the
      // tool description and `PASSWORD_FIELD_NOT_MASKED` now say.
      //
      // `checkTarget` is the SAME function the pre-pass used, deliberately: two
      // spellings of one predicate set is how the two passes would drift, and
      // the drift would be silent. Guarded by G22b.
      const written: { t: FillTarget; el: HTMLInputElement | HTMLTextAreaElement }[] = [];
      const reverted = new Set<string>();
      for (const { t, el } of checked) {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        input.focus();

        const bad = checkTarget(t, input);
        if (bad) {
          if (req.atomic) {
            // `wrote` is what keeps main's answer true. A refusal that arrives
            // after an earlier target was already written is NOT the "nothing
            // happened, take the taint back off" case, and main must not say
            // "nothing was inserted" about a form that has a value in it.
            // A count, not a value — this channel carries no secrets.
            for (const t2 of req.targets) t2.value = '';
            return reply({
              ok: false,
              reason: bad,
              key: t.key,
              wrote: written.length,
            });
          }
          fail(t, bad);
          continue;
        }

        const setter = setterFor(input)!;
        setter.call(input, t.value);
        // React and friends listen for these; setting .value alone leaves
        // controlled components with stale state.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // Same-task read-back: catches a synchronous sanitiser, which rewrites
        // the value inside this same event turn and is therefore invisible to
        // the deferred check below. (Not `maxlength` — see VERIFY_DELAY_MS.)
        if (input.value !== t.value) reverted.add(t.key);
        written.push({ t, el: input });
      }

      // THE DEFERRED VERIFICATION. The reply does not go out when the write
      // returns; it goes out after re-reading each target and comparing against
      // what was written. `ok` therefore means arrival, not delivery.
      //
      // This is the direct answer to this project's own history: six things
      // marked "working" broke the moment they were measured end to end. A fill
      // path that reports success from the fact that an IPC message was
      // delivered is that failure pre-committed.
      setTimeout(() => {
        try {
          const results = [
            ...written.map(({ t, el }) => ({
              key: t.key,
              kind: t.kind,
              wrote: true,
              landed: !reverted.has(t.key) && el.isConnected && el.value === t.value,
              ...(reverted.has(t.key) ? { skipped: 'reverted' as FillReason } : {}),
            })),
            ...skipped.map((s) => ({
              key: s.key,
              kind: s.kind,
              wrote: false,
              landed: false,
              skipped: s.reason,
            })),
          ];
          const active = document.activeElement;
          let focusedKey: string | null = null;
          for (const { t, el } of written) {
            if (el === active) focusedKey = t.key;
          }
          reply({ ok: true, results, focusedKey });
        } catch {
          reply({ ok: false, reason: 'write-failed' as FillReason });
        } finally {
          // The expected values lived in this closure for 250ms and are never
          // sent back. Dropping the references is housekeeping rather than a
          // boundary — the page cannot reach an isolated world's closure, and it
          // already holds the values in its own DOM regardless.
          for (const w of written) w.t.value = '';
          for (const t of req.targets) t.value = '';
        }
      }, VERIFY_DELAY_MS);
    } catch {
      reply({ ok: false, reason: 'write-failed' as FillReason });
    }
  },
);

/**
 * Every reason a target may not be written, in one place.
 *
 * ONE SPELLING, TWO CALL SITES. The pre-pass (which decides whether an atomic
 * fill happens at all) and the re-check (which decides whether THIS write
 * happens, immediately before it) must ask exactly the same question. Written
 * out twice they would drift, and the drift would be silent in the direction
 * that matters — the re-check is the one a hostile page is trying to get past.
 *
 * Returns `null` when the target is writable, or the fixed-vocabulary reason
 * why not. Order matters: connectivity before frame before shape, so the reason
 * reported is the first true thing about the element rather than the last.
 */
function checkTarget(t: FillTarget, el: HTMLElement): FillReason | null {
  if (!el.isConnected) return 'gone';

  // The top-frame rule, enforced rather than hoped for. A preload without
  // `nodeIntegrationInSubFrames` runs in the main frame only and the walker
  // does not descend into subframes, so this should be unreachable — which is
  // exactly why it is checked rather than asserted in a comment.
  if (el.ownerDocument !== document) return 'subframe';

  const credential = t.kind !== 'profile';
  const writable =
    el instanceof HTMLInputElement || (!credential && el instanceof HTMLTextAreaElement);
  // The old handler `continue`d silently past anything that was not an input or
  // textarea, so a partial fill was indistinguishable from a complete one.
  if (!writable) return 'not-input';

  const input = el as HTMLInputElement | HTMLTextAreaElement;

  // A password only ever goes into a masked field, AT THE INSTANT IT IS
  // WRITTEN. Two reasons, and the first one is the one that survives the taint
  // mechanism: a plain-text field puts the password in cleartext on the human's
  // own screen, which is what the masked-field rule is for at the human end.
  // The second is the snapshot — the walker serialises a text input's value,
  // and taint covers the key it knows about, not one the page substitutes.
  if (t.kind === 'password') {
    if (!(input instanceof HTMLInputElement) || input.type !== 'password') {
      return 'not-masked';
    }
  }
  if (t.kind === 'otp') {
    if (
      !(input instanceof HTMLInputElement) ||
      input.type === 'password' ||
      input.type === 'hidden'
    ) {
      return 'not-input';
    }
  }

  // "A human could not do it either" — the rule the `select` path already
  // follows. A click on a disabled control is discarded by the browser; a write
  // here is not, so nothing else stops it.
  //
  // `isDisabled` AND NOT `input.disabled`, and this is a deliberate
  // strengthening of what docs/design/vaultfill.md section 6.2 asks for. The
  // IDL `disabled` property reflects the CONTENT ATTRIBUTE only, so it is
  // `false` for a control disabled by an ancestor `<fieldset disabled>` — the
  // control is unusable to a human and this write would have gone straight into
  // it. That is the identical hole the `select` path closed for exactly this
  // reason (see the `aperture:select` handler below), and repeating it here
  // would be repeating a bug this codebase has already paid for once. The
  // change can only ever refuse MORE, never less. Measured by guard G25b.
  //
  // AN INERT ANCESTOR IS THE SAME RULE and slipped through until tier6 §4.2: a
  // human cannot type into an inert field either, and this write does not go
  // through the CDP input path that the platform would have stopped. It
  // returns the EXISTING token rather than growing the deny vocabulary —
  // `not-editable` is already what "a human could not have typed here" means
  // on this path, and a new token would need a new prose string, a new
  // `FILL_REASON` mapping and a new guard for no measurement gain.
  if (isDisabled(input) || input.readOnly || inInertSubtree(input)) {
    return 'not-editable';
  }

  if (credential) {
    const r = input.getBoundingClientRect();
    if (r.width < MIN_FILL_WIDTH || r.height < MIN_FILL_HEIGHT) return 'too-small';
  }

  if (!setterFor(input)) return 'no-setter';

  return null;
}

/**
 * The native value setter from THIS world's prototype.
 *
 * A page's `Object.defineProperty(node, 'value', …)` — which is exactly how
 * React's value tracker is installed — lives on the main world's wrapper and is
 * simply not on the object this file touches.
 */
function setterFor(
  el: HTMLInputElement | HTMLTextAreaElement,
): ((this: unknown, v: string) => void) | undefined {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value')?.set as
    | ((this: unknown, v: string) => void)
    | undefined;
}

/**
 * Resolve a ref's identity key to a live rect, scrolling it into view first.
 *
 * Returns viewport coordinates for CDP input dispatch. The hit-test is what
 * stops an agent "clicking" an element that is covered by a modal or a cookie
 * banner: if the point belongs to something else, we say so rather than
 * dispatching into whatever happens to be on top.
 */
ipcRenderer.on(
  'aperture:resolve',
  (_event, req: { requestId: string; key: string }) => {
    const reply = (payload: unknown): void =>
      ipcRenderer.send('aperture:resolve-result', req.requestId, payload);

    try {
      const el = index.get(req.key);
      if (!el || !el.isConnected) return reply({ ok: false, reason: 'gone' });

      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        return reply({ ok: false, reason: 'not-visible' });
      }

      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;

      // `document.elementFromPoint` stops at a shadow HOST, and
      // `Node.contains` does not cross shadow boundaries — so a target inside
      // an open shadow root always compared unequal to the host and reported
      // as "obstructed", making every shadow-DOM element unclickable. Descend
      // through shadow roots to the real element at the point, and compare
      // containment along the composed tree.
      let atPoint = document.elementFromPoint(x, y);
      while (atPoint?.shadowRoot) {
        const inner = atPoint.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === atPoint) break;
        atPoint = inner;
      }
      const obstructed =
        atPoint !== null &&
        atPoint !== el &&
        !composedContains(el, atPoint) &&
        !composedContains(atPoint, el);

      reply({
        ok: true,
        x,
        y,
        // Live geometry for the capture path's detail crop. Numbers from
        // `getBoundingClientRect`/`innerWidth`, measured in the isolated world
        // and flowing only into main-process crop math — this adds fields to an
        // existing reply, not a channel, and no page-authored string rides it.
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        vw: window.innerWidth,
        vh: window.innerHeight,
        obstructed,
        obstructor: obstructed
          ? (atPoint?.tagName ?? '') + (atPoint?.id ? `#${atPoint.id}` : '')
          : null,
        // Reachability facts the hit-test cannot see, and in two of the three
        // cases actively MISREPORTS: a `pointer-events: none` target cannot be
        // its own hit-test result, so it reads as "covered by" whatever sits
        // beneath it, and an addressable ANCESTOR of an open modal dialog is
        // excused by the containment test above. A fixed vocabulary, never
        // page bytes — these land in prose outside the untrusted envelope.
        blocked: blockedReason(el),
        tag: el.tagName,
        editable:
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          (el as HTMLElement).isContentEditable,
      });
    } catch (err) {
      reply({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  },
);

/**
 * Arm a one-shot witness for input that is about to be dispatched.
 *
 * SUBFRAME TARGETS ONLY, and the restriction is the point.
 *
 * This listener is registered AT ACT TIME, so a page script that already ran
 * can be ahead of it in the target node's listener list and silence it with
 * `stopImmediatePropagation`. The old comment here claimed the opposite — that
 * capture-phase-on-window put it beyond suppression — and Gate 2 falsified
 * that live on Electron 43: a page suppressing `mousedown` at window capture
 * turned landed clicks into the terminal input-loss error. Capture phase is
 * not the guarantee; REGISTRATION ORDER is, and only the document_start
 * recorder above has it.
 *
 * So this path survives for the one case the recorder cannot cover: an element
 * in a SUBFRAME, whose events never pass through the top window the recorder
 * listens on. There, `fired` means `landed` and silence means `unknown` —
 * never `lost`. A suppressible witness is not allowed to say the input path is
 * dead, because it cannot tell that from a page that merely suppressed it.
 * (`act.ts`, `witnessInput`, subframe mode. Residual, stated in
 * docs/design/tier3.md §1.3.2: a wedge affecting only subframe input still
 * acks `ok`.)
 *
 * It witnesses ARRIVAL, not effect. A click that reaches a dead button is
 * still `ok` — "the action caused no visible change" is a real finding and
 * this must not turn it into an error.
 *
 * `reason` strings here are fixed vocabulary (`gone`, `not-witnessed`), never
 * interpolated from a caught error — these land OUTSIDE the untrusted-content
 * envelope in `browser_act`'s prose. See docs/design/security.md, "Preload
 * reason strings".
 */
ipcRenderer.on(
  'aperture:witness',
  (
    _event,
    req: { requestId: string; key: string; types: string[]; timeoutMs?: number },
  ) => {
    const reply = (payload: unknown): void =>
      ipcRenderer.send('aperture:witness-result', req.requestId, payload);

    const el = index.get(req.key);
    if (!el || !el.isConnected) {
      // Answered on the ARMING channel, not the result channel: nothing was
      // armed, so there is no verdict to report and the caller must not spend
      // its arming timeout waiting for one it will never get.
      return ipcRenderer.send('aperture:witness-armed', req.requestId, {
        ok: false,
        reason: 'gone',
      });
    }

    const target: EventTarget = el.ownerDocument.defaultView ?? el.ownerDocument;
    let settled = false;
    const types = req.types.length ? req.types : ['mousedown'];

    const done = (witnessed: boolean, type?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const t of types) target.removeEventListener(t, onEvent, true);
      reply(
        witnessed
          ? { ok: true, witnessed: true, type }
          : { ok: false, reason: 'not-witnessed' },
      );
    };

    const onEvent = (e: Event): void => done(true, e.type);

    // The deadline is the preload's, not the main process's, so a wedge that
    // also kills IPC in this direction still produces exactly one reply.
    const timer = setTimeout(() => done(false), req.timeoutMs ?? 500);
    for (const t of types) target.addEventListener(t, onEvent, true);

    // Armed. The main process dispatches only after this ack, or the race is
    // real: a fast synthetic click can beat the listener into place.
    ipcRenderer.send('aperture:witness-armed', req.requestId, { ok: true });
  },
);

/** Ancestor test that crosses shadow boundaries via the host chain. */
function composedContains(ancestor: Element, node: Element): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parentNode ?? (cur instanceof ShadowRoot ? cur.host : null);
  }
  return false;
}

/**
 * Is this element inside an `[inert]` subtree?
 *
 * The SAME composed-tree ascent `composedContains` uses, and deliberately not
 * `closest('[inert]')`: `closest` stops at a shadow boundary, so an inert host
 * would not be seen from inside its own shadow root — and the walker pierces
 * shadow roots, so the agent is shown those elements and can name them.
 *
 * One helper, three consumers (the resolve gate, the select handler and the
 * fill preflight), because three copies of "is this reachable" is how one of
 * them goes stale.
 */
function inInertSubtree(node: Element): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (cur instanceof Element && cur.hasAttribute('inert')) return true;
    cur = cur.parentNode ?? (cur instanceof ShadowRoot ? cur.host : null);
  }
  return false;
}

/**
 * Why a human could not reach this element — `null` when they could.
 *
 * Computed HERE, in the preload, because this is where the live element is.
 * First match wins and the order is the order of severity: an inert control
 * inside an open dialog's background is inert AND behind a modal, and "the
 * page has disabled it" is the more actionable of the two.
 *
 * WHAT IS DELIBERATELY NOT HERE: `aria-modal="true"` div overlays. aria-modal
 * is ADVISORY — the platform does not make the background inert, a human can
 * still Tab into it — so the hit-test remains the only honest gate there, on
 * the covered-point case only, exactly as before. `dialog:modal` is different
 * in kind: the platform itself blocks the background.
 */
function blockedReason(el: Element): 'inert' | 'modal' | 'no-pointer' | null {
  if (inInertSubtree(el)) return 'inert';

  // Wrapped, and the catch means "no modal": a page cannot be allowed to break
  // the resolve by breaking the selector engine, and an Electron whose Chromium
  // lacked `:modal` would otherwise fail every act rather than degrade. The
  // failure mode of the degraded path is a RED G36, which is the correct
  // discovery route.
  let modal: Element | null = null;
  try {
    modal = document.querySelector('dialog:modal');
  } catch {
    modal = null;
  }
  if (modal && !composedContains(modal, el)) return 'modal';

  try {
    if (getComputedStyle(el).pointerEvents === 'none') return 'no-pointer';
  } catch {
    // Same posture: an unresolvable style is not a reason to fail the act.
  }
  return null;
}

/**
 * Scoped read: the rendered text of one element, found through the same
 * identity index that acting uses. `browser_read`'s `ref` parameter used to
 * be accepted and silently ignored — the whole document came back, and the
 * agent had no way to know.
 *
 * A native `<select>` is the one element whose `innerText` is worthless: it
 * concatenates every option label with no marker for which one is selected,
 * no values, and no groups. Since the snapshot deliberately renders a long
 * select as `[51 options]` and nothing else, this scoped read is the ONLY way
 * to discover what is in it — so it gets a real listing instead.
 */
ipcRenderer.on(
  'aperture:read',
  (_event, req: { requestId: string; key: string }) => {
    const reply = (payload: unknown): void =>
      ipcRenderer.send('aperture:read-result', req.requestId, payload);
    try {
      const el = index.get(req.key);
      if (!el || !el.isConnected) return reply({ ok: false, reason: 'gone' });
      reply({
        ok: true,
        text: el instanceof HTMLSelectElement ? describeSelect(el) : el.innerText,
      });
    } catch (err) {
      reply({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  },
);

/** Every option of a select, with its group, value, and selected state. */
function optionsOf(el: HTMLSelectElement): OptionInfo[] {
  return Array.from(el.options).map((o, index) => {
    const parent = o.parentElement;
    const info: OptionInfo = { text: o.text, value: o.value, index };
    // `o.disabled` is false for an option inside a disabled <optgroup>, even
    // though the option is unusable — the group's state has to be folded in.
    if (o.disabled || (parent instanceof HTMLOptGroupElement && parent.disabled)) {
      info.disabled = true;
    }
    if (parent instanceof HTMLOptGroupElement && parent.label) info.group = parent.label;
    return info;
  });
}

/**
 * The option list, formatted for an agent that is about to choose one.
 *
 * `>` marks the current selection, which is the first thing worth knowing.
 * Optgroups are passive: shown so the agent understands the list, never
 * accepted as part of a match — qualified `"group > label"` queries are a
 * deliberate deferral, not an oversight.
 */
function describeSelect(el: HTMLSelectElement): string {
  // Every string below came from the page, so every one of them is quoted and
  // neutralized. `quoteFull` and not `quote`: this listing exists so the agent
  // can name an option EXACTLY, and a label truncated to 80 characters with an
  // ellipsis matches no tier — truncating here would make a long option
  // permanently unselectable. browser_read caps the whole response with
  // `maxChars`, which is the bound that actually matters here.
  const opts = optionsOf(el);
  const selected = Array.from(el.selectedOptions).map((o) => quoteFull(o.text));
  const head =
    `native select${el.multiple ? ' (multi-select)' : ''} · ${opts.length} options · ` +
    (selected.length ? `selected: ${selected.join(', ')}` : 'nothing selected');

  const lines = [head, 'Choose one with browser_act action:"select".', ''];
  let group: string | undefined;
  for (const [i, o] of opts.entries()) {
    if (o.group !== group) {
      group = o.group;
      if (group) lines.push(`  ${quoteFull(group)}`);
    }
    const mark = el.options[i]!.selected ? '>' : ' ';
    lines.push(`${mark} ${describeOption({ ...o, group: undefined }, { full: true })}`);
  }
  return lines.join('\n');
}

/**
 * Choose an option in a native `<select>`.
 *
 * WHY THE PROTOTYPE SETTER ON THE OPTION, AND NOT `select.value = x`
 *
 * React instruments the *instance* `value` property of a form control to track
 * what it last rendered. Assigning through `select.value` therefore updates
 * React's own cached value first; when the `change` event arrives React
 * compares the two, sees no difference, deduplicates the event, never calls
 * `onChange`, and the next render snaps the controlled component back to its
 * old state. Mutating the OPTION's `selected` bypasses that instrumentation
 * entirely: the tracker goes stale, so the dispatched `change` reads as a
 * genuine user change. This is the path Playwright and Puppeteer have used
 * against the production web for years.
 *
 * MEASURED, NOT ASSUMED — AND THE MEASUREMENT IS NARROWER THAN THE ARGUMENT
 *
 * That argument is about a MAIN-WORLD write. This code runs in the preload's
 * isolated world, and the two worlds hold separate JS wrappers for the same
 * DOM node, so a page's own `Object.defineProperty(node, 'value', …)` — which
 * is exactly how React's value tracker is installed — is simply not on the
 * object this file touches. Measured against
 * `test/fixtures/selects.html`, whose controlled select counts writes through
 * its instrumented instance property: after `select` actions that visibly
 * committed, the counter read **0**, and a deliberately regressed build using
 * `el.value = …` also read 0 and also committed.
 *
 * So the honest statement is: the React-dedup failure does not reproduce from
 * an isolated world, and the fixture's controlled select does not, on its own,
 * discriminate the two mechanisms. The prototype setter is kept anyway, for
 * three reasons that do not depend on the world boundary:
 *
 *   1. It is correct in a main-world context too, so this stays right if
 *      Aperture ever injects differently or runs with contextIsolation off.
 *   2. `el.value = v` selects the FIRST option with that value. When two
 *      options share a value — a real and common pattern — it silently
 *      chooses the wrong one, and the agent named a LABEL. The fixture's
 *      duplicate-value select makes that difference observable, and the
 *      `selects` bench scenario fails RED on a regression to `el.value`.
 *   3. It is the only mechanism that expresses "this option, by index", which
 *      is what the matcher decided.
 *
 * The setter is taken from THIS isolated world's `HTMLOptionElement`
 * prototype, so a page that monkeypatches its own builtins cannot intercept or
 * redirect the write.
 *
 * WHY NOT CDP, A POPUP, OR KEYBOARD INPUT
 *
 * `act.ts` sends everything through CDP because synthesized events are
 * untrusted and detectable — that reasoning is about input dispatch, where a
 * trusted path exists. For a native dropdown none does: the popup is a
 * separate OS window outside the WebContents, arrow keys on a closed select
 * are platform-divergent (Windows changes the value, macOS opens the popup),
 * and whether CDP key events even reach an open native popup in Electron is
 * unverified. So `select` is state-mutation-plus-notification — the same class
 * as `aperture:fill` — and it lives on this IPC path with it.
 */
ipcRenderer.on(
  'aperture:select',
  (_event, req: { requestId: string; key: string; option: string }) => {
    const reply = (payload: unknown): void =>
      ipcRenderer.send('aperture:select-result', req.requestId, payload);

    try {
      const el = index.get(req.key);
      if (!el || !el.isConnected) return reply({ ok: false, reason: 'gone' });
      if (!(el instanceof HTMLSelectElement)) {
        return reply({ ok: false, reason: 'not-a-select', tag: el.tagName });
      }
      // `matchOption` refuses a disabled OPTION on the rule "a human cannot
      // choose it, so neither can we". The rule was never applied one level
      // up, and it must be: this path writes through the DOM and dispatches
      // `change` itself, so nothing else stops it. A click on a disabled
      // control is discarded by the browser; a write here is not.
      //
      // `isDisabled` and not `el.disabled`, because `el.disabled` is false for
      // a select disabled by an ancestor `<fieldset disabled>` — the half of
      // this the snapshot could not even show the agent.
      if (isDisabled(el)) {
        return reply({ ok: false, reason: 'select-disabled', total: el.options.length });
      }
      // BELT AND BRACES, the shape the disabled fix above already uses: the
      // resolve gate in tools.ts refuses these too, and this handler refuses
      // them again so the invariant holds even if a future caller skips it.
      // Fixed tokens, never interpolated — they land outside the envelope.
      //
      // NO `no-pointer` HERE, and that is the ruled asymmetry rather than an
      // omission: `pointer-events` blocks POINTER input only, a human Tabs to
      // such a select and changes it with the keyboard, and `select` is
      // already the no-coordinates state-mutation path. Refusing it would make
      // the agent weaker than a human — the inverse failure (tier6 §4.2).
      if (inInertSubtree(el)) {
        return reply({ ok: false, reason: 'inert', total: el.options.length });
      }
      if (blockedReason(el) === 'modal') {
        return reply({ ok: false, reason: 'modal', total: el.options.length });
      }

      const opts = optionsOf(el);
      const m = matchOption(opts, req.option);
      if (!m.ok) {
        return reply({
          ok: false,
          reason: m.reason,
          total: opts.length,
          multiple: el.multiple,
          ...(m.reason === 'ambiguous'
            ? { tier: m.tier, candidates: m.candidates, matched: m.matched }
            : {}),
          ...(m.reason === 'no-match' ? { suggestions: m.suggestions } : {}),
          ...(m.reason === 'disabled' ? { label: m.label } : {}),
        });
      }

      const setter = Object.getOwnPropertyDescriptor(
        HTMLOptionElement.prototype,
        'selected',
      )?.set;
      if (!setter) return reply({ ok: false, reason: 'no-setter' });

      const previous = Array.from(el.selectedOptions).map((o) => o.text.trim());
      // Replace semantics, stated in the result rather than implied: a
      // multi-select is cleared first, so the outcome is exactly the one
      // option named. Adding to an existing selection is deferred, and
      // silently doing one when the agent asked for the other is the kind of
      // difference nobody notices until a form is submitted.
      if (el.multiple) for (const o of Array.from(el.options)) setter.call(o, false);
      setter.call(el.options[m.index]!, true);

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      reply({
        ok: true,
        label: el.options[m.index]!.text.trim(),
        value: el.options[m.index]!.value,
        tier: m.tier,
        multiple: el.multiple,
        total: opts.length,
        previous,
      });
    } catch (err) {
      reply({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  },
);
