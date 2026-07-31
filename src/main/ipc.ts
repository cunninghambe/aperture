import { ipcMain, type BaseWindow, type WebContentsView } from 'electron';
import type { TabManager } from './tabs.js';
import { containers } from '@privacy/containers';
import { blockedCount } from '@privacy/blocker';
import { vault } from '@vault/vault';

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

  // --- vault -------------------------------------------------------------
  // Note what is absent: there is no 'vault:read' or 'vault:get-password'.
  // The chrome UI can list entries and trigger fills; it cannot extract a
  // secret, and neither can anything downstream of it.
  handle('vault:state', () => vault.state());
  handle('vault:list', (_e, origin?: string) => vault.listPublic(origin));
  handle('vault:unlock', (_e, passphrase: string) => vault.unlock(passphrase));
  handle('vault:lock', () => vault.lock());
}

function handle(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, fn as never);
}
