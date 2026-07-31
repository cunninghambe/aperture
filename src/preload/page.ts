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
