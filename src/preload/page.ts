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
 * Fill a field.
 *
 * The value arrives from the main process and is written using the *native*
 * property setter captured from this isolated world's own prototype. That
 * matters: the page cannot monkeypatch `HTMLInputElement.prototype.value` to
 * intercept or redirect the write, because our world has its own builtins.
 *
 * This protects the integrity of the fill. It provides no confidentiality —
 * the page owns its DOM and can read the field back afterwards. That is a
 * property of the web platform, not a gap in this code, and the vault design
 * says so explicitly rather than implying otherwise.
 */
ipcRenderer.on(
  'aperture:fill',
  (
    _event,
    req: { requestId: string; fills: { key: string; value: string }[] },
  ) => {
    const filled: string[] = [];
    try {
      for (const f of req.fills) {
        const el = index.get(f.key);
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          continue;
        }

        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (!setter) continue;

        el.focus();
        setter.call(el, f.value);
        // React and friends listen for these; setting .value alone leaves
        // controlled components with stale state.
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        filled.push(f.key);
      }
      ipcRenderer.send('aperture:fill-result', req.requestId, {
        ok: true,
        filled,
      });
    } catch (err) {
      ipcRenderer.send('aperture:fill-result', req.requestId, {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        filled,
      });
    }
  },
);

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
        obstructed,
        obstructor: obstructed
          ? (atPoint?.tagName ?? '') + (atPoint?.id ? `#${atPoint.id}` : '')
          : null,
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
 * WHY THIS EXISTS. Wave 2 ended with Aperture's input path wedged for forty
 * minutes while `browser_act` answered `ok` to every call: CDP
 * `Input.dispatchMouseEvent` resolved, the walker kept serving snapshots, the
 * renderer kept loading pages — and not one click reached the DOM. Nothing
 * anywhere in the stack could tell the difference between "the click landed
 * and the page did nothing" and "the click never landed", so the agent was
 * told the first when the truth was the second. `sendCommand` resolving is a
 * statement about CDP, not about the page; the only witness that means
 * anything is an event observed in the page itself.
 *
 * The listener is capture-phase on the resolved target's WINDOW, which is the
 * first node in the capture path — so no page handler can `stopPropagation`
 * its way out of being observed. A document-level listener would not be
 * enough: a page capture handler on `window` runs earlier and could suppress
 * every witness, turning a working page into a permanent false alarm. The page
 * also cannot remove this listener — it lives in the isolated world, and the
 * page holds no reference to it or to this world's `EventTarget.prototype`.
 *
 * It witnesses ARRIVAL, not effect. A click that reaches a dead button is
 * still `ok` — "the action caused no visible change" is a real finding and
 * this must not turn it into an error. The one thing it converts is silence on
 * the input path itself.
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
