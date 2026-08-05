import { ipcMain, type BaseWindow, type WebContentsView } from 'electron';
import type { TabManager } from './tabs.js';
import { containers } from '@privacy/containers';
import { blockedCount } from '@privacy/blocker';
import { vault } from '@vault/vault';
import { openVaultWindow } from './vaultWindow.js';
import { capturePage, routeCapture } from '../capture/capture.js';
import { redactFreeText, redactUrl } from '@core/snapshot/engine.js';

export interface IpcDeps {
  tabs: TabManager;
  chrome: WebContentsView;
  window: BaseWindow;
}

let deps: IpcDeps | null = null;

/**
 * IPC exposed to the *chrome UI only*. Web pages never reach these — they get
 * a separate, far narrower preload. Every handler here assumes a trusted
 * caller; that assumption is only sound because the chrome UI loads local
 * content and has its own preload.
 */
export function registerIpc(d: IpcDeps): void {
  deps = d;

  handle('tabs:list', () => deps!.tabs.list());
  handle('tabs:create', (_e, url?: string) => deps!.tabs.create({ url }));
  handle('tabs:close', (_e, id: string) => deps!.tabs.close(id));
  handle('tabs:activate', (_e, id: string) => deps!.tabs.activate(id));
  handle('tabs:navigate', (_e, id: string, url: string) => deps!.tabs.navigate(id, url));
  handle('tabs:back', (_e, id: string) => deps!.tabs.goBack(id));
  handle('tabs:forward', (_e, id: string) => deps!.tabs.goForward(id));
  handle('tabs:reload', (_e, id: string) => deps!.tabs.reload(id));
  handle('tabs:stop', (_e, id: string) => deps!.tabs.stop(id));

  handle('containers:list', () => containers.list());

  handle('privacy:stats', () => ({ blocked: blockedCount() }));

  // THE OTHER CALL SITE OF routeCapture, AND THE ONE NOBODY SCRUBBED.
  //
  // `browser_capture` (src/mcp/tools.ts) was hardened on 2026-08-05 because its
  // caption and source URL LEAVE THE MACHINE: both are page-written
  // (`document.title`, `history.replaceState`) and both are forwarded to Notion
  // as the caption of the uploaded image, so a credential Aperture wrote into
  // that page moments earlier is disclosed to a third party. `security.md` then
  // recorded "Both fields are needle-scrubbed now."
  //
  // That sentence was false here. This is the human's toolbar button, it reaches
  // the same `routeCapture` with the same two page-written strings, and it had
  // no scrub of any kind. The agent cannot invoke it — but the agent does not
  // need to: the skimmer writes `document.title = password` and waits for the
  // human to file a screenshot, which is the one thing this button exists for.
  //
  // Same treatment as the agent path, and the same split: `redactUrl` for the
  // URL because the browser percent-encodes what the page put in it,
  // `redactFreeText` for the title because nothing encoded it.
  //
  // NOT given `browser_capture`'s agent-owned-tab refusal, deliberately: that
  // rule exists to stop an INJECTED "capture tab t1" from screenshotting the
  // human's bank tab, and a human pressing their own capture button on their own
  // tab is the case the rule is carving out.
  handle('capture:page', async () => {
    const t = deps!.tabs;
    const id = t.active;
    if (!id) return { destination: 'disk', location: '' };
    const info = t.info(id);
    const bytes = await capturePage(t.webContents(id));
    return routeCapture(bytes, {
      openUrls: t.list().map((tab) => tab.url),
      title: redactFreeText(id, info?.title ?? ''),
      sourceUrl: redactUrl(id, info?.url ?? ''),
    });
  });

  // --- vault -------------------------------------------------------------
  // Note what is absent: there is no 'vault:read' or 'vault:get-password'.
  // The chrome UI can list entries and trigger fills; it cannot extract a
  // secret, and neither can anything downstream of it.
  handle('vault:state', () => vault.state());
  handle('vault:lock', () => vault.lock());
  // Opening the vault window is the only vault action the chrome UI can take.
  // Unlocking happens inside that window, so the passphrase never crosses this
  // channel — the chrome UI renders content derived from page titles and
  // favicons, and a passphrase should not share a bus with anything a page
  // can influence.
  handle('vault:open', () => openVaultWindow(deps!.window));
}

function handle(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, fn as never);
}
