import { join } from 'node:path';
import { BrowserWindow, ipcMain, dialog, shell, type BaseWindow } from 'electron';
import { vault } from '@vault/vault.js';
import { profiles } from '@vault/profileStore.js';
import { attachments } from '@vault/attachments.js';
import type { Profile } from '@vault/profile.js';
import { loadNotionConfig, saveNotionConfig } from '../capture/capture.js';
import {
  loadTelemetryConfig,
  saveTelemetryConfig,
  telemetryStats,
} from '../telemetry/reporter.js';

/**
 * The vault window.
 *
 * This is the human-only surface: master password entry, credential CRUD,
 * reveal, and the profile and attachment editors. Three properties make it
 * safe, and all three are structural rather than policy:
 *
 *   1. **The agent cannot address it.** TabManager never learns about this
 *      window, so it has no tab id. Every agent action routes through
 *      TabManager by id, which means there is no argument the agent could pass
 *      to reach this window's contents — not a blocked one, an unrepresentable
 *      one.
 *
 *   2. **It is excluded from capture.** `setContentProtection(true)` maps to
 *      `WDA_EXCLUDEFROMCAPTURE` on Windows, so screenshots and screen shares
 *      see a blank region where this window is. The agent's screenshot tools
 *      go through the OS capture path, so they get nothing either.
 *
 *   3. **Its IPC channels are separate.** The `vaultui:` handlers below are
 *      registered only for this window's contents and are checked on every
 *      call. The page preload does not expose them and the MCP server does not
 *      wrap them.
 *
 * Honest limitation: the security design calls for this to live in its own OS
 * process (and, hardened, its own low-privilege user account), so that a
 * compromised browser process cannot reach vault memory. This implementation
 * runs it in the same process as the browser. That is fine against the threat
 * that actually matters here — a hostile page steering the agent — and it is
 * not fine against local code execution as the same user. See
 * docs/design/security.md; this is the T-Base tier.
 */

let win: BrowserWindow | null = null;

export function openVaultWindow(parent: BaseWindow): void {
  if (win && !win.isDestroyed()) {
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    title: 'Aperture Vault',
    backgroundColor: '#16161a',
    autoHideMenuBar: true,
    parent: parent as BrowserWindow,
    webPreferences: {
      preload: join(__dirname, '../preload/vault.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The vault preload uses only contextBridge and ipcRenderer, both of
      // which are available to a sandboxed preload. There is no reason to give
      // the window that holds credentials a preload with full Node access.
      sandbox: true,
      // No remote content is ever loaded here, so there is nothing for a
      // network origin to reach.
      webSecurity: true,
    },
  });

  // Keep the window out of screenshots, screen shares, and the agent's
  // screenshot tooling.
  win.setContentProtection(true);

  // A vault window that can be navigated is a vault window that can be
  // replaced with a phishing page.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/vault.html`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/vault.html'));
  }

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error(`[vault-ui] ${message}`);
  });
  win.webContents.on('did-finish-load', () => {
    console.log('[aperture] vault window loaded');
  });

  win.on('closed', () => {
    win = null;
  });
}

export function vaultWindowContentsId(): number | null {
  return win && !win.isDestroyed() ? win.webContents.id : null;
}

/**
 * Register the vault UI's IPC.
 *
 * Every handler re-checks that the caller is the vault window. Without that,
 * any renderer that learned a channel name could call these — and the page
 * preload runs in every web page we load.
 */
export function registerVaultIpc(): void {
  const guard = (e: Electron.IpcMainInvokeEvent): boolean =>
    e.sender.id === vaultWindowContentsId();

  const handle = <T>(
    channel: string,
    fn: (e: Electron.IpcMainInvokeEvent, ...args: never[]) => T,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (e, ...args) => {
      if (!guard(e)) throw new Error('forbidden');
      return fn(e, ...(args as never[]));
    });
  };

  // -- vault lifecycle ------------------------------------------------------
  handle('vaultui:status', async () => ({
    exists: await vault.exists(),
    state: vault.state(),
  }));

  handle('vaultui:create', (_e, passphrase: string) => vault.create(passphrase));
  handle('vaultui:unlock', (_e, passphrase: string) => vault.unlock(passphrase));
  handle('vaultui:lock', () => vault.lock());

  // -- credentials ----------------------------------------------------------
  handle('vaultui:list', () => vault.listAllPublic());

  handle('vaultui:add', (_e, spec: { origin: string; username: string; password: string }) =>
    vault.addRecord(spec),
  );

  handle('vaultui:update', (_e, id: string, patch: Record<string, string>) =>
    vault.updateRecord(id, patch),
  );

  handle('vaultui:delete', (_e, id: string) => vault.deleteRecord(id));

  // Plaintext crosses this channel, which is exactly why the guard above is
  // not optional and why this channel name appears nowhere else.
  handle('vaultui:reveal', (_e, id: string) => vault.revealForHuman(id));

  handle('vaultui:generate', (_e, length: number) => vault.generatePassword(length));

  handle('vaultui:totp', (_e, id: string) => vault.totpCode(id));
  handle('vaultui:set-totp', (_e, id: string, secret: string) => vault.setTotp(id, secret));

  // -- telemetry ----------------------------------------------------------
  handle('vaultui:telemetry-get', async () => {
    const cfg = await loadTelemetryConfig();
    const { sent, dropped } = telemetryStats();
    // The config is the authority on `enabled`; the stats object also carries
    // one, and spreading it here would silently overwrite this.
    return { enabled: cfg.enabled, dsn: cfg.dsn ?? '', sent, dropped };
  });

  handle('vaultui:telemetry-save', (_e, enabled: boolean, dsn: string) =>
    saveTelemetryConfig({ enabled, dsn: dsn || undefined }),
  );

  // -- identity profile -----------------------------------------------------
  handle('vaultui:profile-get', async () => {
    await profiles.load();
    return profiles.get();
  });

  handle('vaultui:profile-save', async (_e, profile: Profile) => {
    await profiles.load();
    await profiles.upsert(profile, true);
  });

  // -- attachments ----------------------------------------------------------
  handle('vaultui:attachments', async () => {
    await attachments.load();
    return attachments.listPublic();
  });

  handle('vaultui:attachment-add', async (_e, label: string, kind: string) => {
    // The human picks the file through the OS dialog. There is deliberately no
    // path parameter anywhere in this flow — not even here — so no caller can
    // ever supply one.
    const parent = win;
    if (!parent) return null;
    const res = await dialog.showOpenDialog(parent, {
      title: 'Add attachment',
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;

    await attachments.load();
    const a = await attachments.add(
      res.filePaths[0],
      label || 'Untitled',
      kind as 'cv' | 'cover-letter' | 'portfolio' | 'certificate' | 'other',
    );
    return { id: a.id, label: a.label, filename: a.filename };
  });

  handle('vaultui:attachment-remove', async (_e, id: string) => {
    await attachments.load();
    await attachments.remove(id);
  });

  handle('vaultui:open-external', (_e, url: string) => {
    // Allowlisted so a bug in the vault UI cannot be turned into a launcher
    // for arbitrary URLs or local executables.
    if (!/^https:\/\/(www\.)?notion\.(so|com)\//i.test(url)) return;
    void shell.openExternal(url);
  });

  // -- Notion -------------------------------------------------------------
  // The token is entered here, in the vault window, and nowhere else. It is a
  // credential, so it gets the same treatment as one: never through the agent
  // surface, never through the chrome UI's IPC, encrypted at rest.
  handle('vaultui:notion-get', async () => {
    const cfg = await loadNotionConfig();
    if (!cfg) return { configured: false, inboxPageId: '' };
    // The token itself is never sent back to the UI, even here — the UI only
    // needs to know whether one is set.
    return { configured: true, inboxPageId: cfg.inboxPageId ?? '' };
  });

  handle('vaultui:notion-save', async (_e, token: string, inboxPageId: string) => {
    const existing = await loadNotionConfig();
    // An empty token field means "leave the saved one alone", so re-saving the
    // inbox page id does not wipe the credential.
    const finalToken = token || existing?.token;
    if (!finalToken) return false;
    await saveNotionConfig({ token: finalToken, inboxPageId: inboxPageId || undefined });
    return true;
  });

  handle('vaultui:notion-test', async () => {
    const cfg = await loadNotionConfig();
    if (!cfg) return { ok: false, detail: 'no token saved' };
    try {
      const res = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Notion-Version': '2022-06-28',
        },
      });
      if (!res.ok) return { ok: false, detail: `Notion returned ${res.status}` };
      const me = (await res.json()) as { name?: string; bot?: { workspace_name?: string } };
      return {
        ok: true,
        detail: `connected as "${me.name ?? 'integration'}"` +
          (me.bot?.workspace_name ? ` in ${me.bot.workspace_name}` : ''),
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });
}
