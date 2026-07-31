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

function wireOnce(): void {
  if (wired) return;
  wired = true;
  ipcMain.on('aperture:resolve-result', (_e, requestId: string, payload: unknown) => {
    pending.get(requestId)?.(payload);
    pending.delete(requestId);
  });
}

export interface Resolved {
  ok: true;
  x: number;
  y: number;
  obstructed: boolean;
  obstructor: string | null;
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
