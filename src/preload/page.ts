import { ipcRenderer } from 'electron';
import { walk } from '@core/snapshot/walker.js';

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
 */
ipcRenderer.on(
  'aperture:read',
  (_event, req: { requestId: string; key: string }) => {
    const reply = (payload: unknown): void =>
      ipcRenderer.send('aperture:read-result', req.requestId, payload);
    try {
      const el = index.get(req.key);
      if (!el || !el.isConnected) return reply({ ok: false, reason: 'gone' });
      reply({ ok: true, text: el.innerText });
    } catch (err) {
      reply({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  },
);
