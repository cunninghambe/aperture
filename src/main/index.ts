import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { app, BaseWindow, WebContentsView, ipcMain, shell } from 'electron';
import { TabManager, CHROME_HEIGHT } from './tabs.js';
import { registerIpc } from './ipc.js';
import { openVaultWindow, registerVaultIpc } from './vaultWindow.js';
import { installBlocker } from '@privacy/blocker';
import { containers } from '@privacy/containers';
import { startMcpServer } from '@mcp/server';
import { profiles } from '@vault/profileStore';
import { vault } from '@vault/vault';
import { revokeAllGrants } from './consent.js';
import { clearAllNeedles, invalidate } from '@core/snapshot/engine';
import { flushTelemetry, initTelemetry, report } from '../telemetry/reporter.js';
import { applyDarkMode, enableForceDark } from '@privacy/darkmode';

/** Chromium switches applied before app-ready. */
function applyCommandLineSwitches(): void {
  // Chromium's own histogram/variations reporting phones home to Google.
  app.commandLine.appendSwitch('disable-features', [
    'MediaRouter',
    'OptimizationHints',
    'Translate',
    'AutofillServerCommunication',
    'CalculateNativeWinOcclusion',
    'InterestFeedContentSuggestions',
  ].join(','));
  app.commandLine.appendSwitch('disable-domain-reliability');
  // Must happen before app-ready: force-dark is a Blink setting.
  enableForceDark();
  app.commandLine.appendSwitch('no-pings');
  // WebRTC leaks the real local IP even behind a proxy unless this is set.
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');
}

let win: BaseWindow | null = null;
let chrome: WebContentsView | null = null;
let tabs: TabManager | null = null;

async function createWindow(): Promise<void> {
  win = new BaseWindow({
    width: 1440,
    height: 920,
    minWidth: 640,
    minHeight: 400,
    title: 'Aperture',
    backgroundColor: '#16161a',
    autoHideMenuBar: true,
  });

  // The browser chrome (tab strip, address bar, agent activity rail) is itself
  // a WebContentsView, pinned to the top of the window.
  chrome = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/shell.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.contentView.addChildView(chrome);

  const layoutChrome = (): void => {
    if (!win || !chrome) return;
    const b = win.getContentBounds();
    chrome.setBounds({ x: 0, y: 0, width: b.width, height: CHROME_HEIGHT });
  };
  layoutChrome();
  win.on('resize', layoutChrome);

  tabs = new TabManager(win);

  // Refs are invalidated on any navigation, including same-document ones,
  // because a pushState can rewrite the whole view.
  tabs.on('navigated', (tabId: string) => invalidate(tabId, false));
  // Taint is only dropped when the DOCUMENT is replaced. A same-document
  // navigation leaves the filled values sitting in the DOM, so clearing taint
  // there let a page reveal them with one line:
  //   input.addEventListener('input', () => history.pushState({}, '', '#ok'))
  tabs.on('document-navigated', (tabId: string) => invalidate(tabId, true));

  // Push tab state to the chrome UI whenever it changes.
  tabs.on('changed', (list, activeId) => {
    chrome?.webContents.send('tabs:changed', { tabs: list, activeId });
  });

  registerIpc({ tabs, chrome, window: win });
  registerVaultIpc();

  if (process.env['ELECTRON_RENDERER_URL']) {
    await chrome.webContents.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}/index.html`,
    );
  } else {
    await chrome.webContents.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // External links (from the chrome UI, e.g. the docs link) go to the OS
  // browser rather than opening an unmanaged window here.
  chrome.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  tabs.create({ url: 'https://duckduckgo.com', activate: true });

  if (process.argv.includes('--open-vault')) openVaultWindow(win);

  // Dev-only: prove the crash pipeline end to end, including that the scrubber
  // actually redacts in production and not merely in unit tests. The payload
  // deliberately contains a URL, a home path and a bearer token.
  if (process.argv.includes('--test-crash')) {
    const err = new Error(
      'APERTURE_SCRUB_PROBE at https://secret-bank.example.com/account/12345 ' +
        `for user probe@example.com with Authorization: Bearer ${'A'.repeat(32)} ` +
        `from ${app.getPath('home')}\\dev\\aperture\\src\\main\\index.ts`,
    );
    report(err, 'main');
    await flushTelemetry(5000);
    console.log('[aperture] test crash reported and flushed');
  }

  win.on('closed', () => {
    win = null;
    chrome = null;
    tabs = null;
  });
}

applyCommandLineSwitches();

/**
 * What must stop being true the moment the vault locks.
 *
 * Registered here rather than inside `Vault` because `revokeAllGrants` lives in
 * `main/consent.ts` and `clearAllNeedles` in `core/snapshot/engine.ts`, and
 * importing either from the vault would create an import cycle. This is the one
 * module that already sees all three.
 *
 * Registering on `onLock` rather than at each explicit `lock()` call site is
 * what makes the IDLE auto-lock count too, which is the path that actually
 * matters: a human walks away, the vault times out, and a ten-minute autofill
 * grant used to outlive it because `revokeAllGrants` had no callers at all
 * (docs/design/vaultfill.md F1).
 */
vault.onLock(() => {
  revokeAllGrants();
  clearAllNeedles();
});

app.whenReady().then(async () => {
  // Blocking must be installed on the default container's session before the
  // first request goes out.
  // Before anything else that might throw, so early failures are reported.
  const tel = await initTelemetry(app.getVersion());
  console.log(
    `[aperture] crash reporting: ${tel.active ? 'on' : `off (${tel.reason})`}`,
  );

  applyDarkMode('dark');
  await installBlocker(containers.sessionFor(containers.defaultId()));

  await createWindow();

  const mcp = await startMcpServer(() => tabs, () => win);
  await publishMcpConfig(mcp);

  // Dev-only: seed a demo identity profile so the autofill path can be
  // exercised end to end. Not an agent-reachable write path — it requires an
  // explicit command-line flag on the browser itself.
  if (process.argv.includes('--seed-profile')) {
    await profiles.load();
    await profiles.upsert(
      {
        id: 'demo',
        label: 'Demo',
        values: {
          givenName: 'Brad', familyName: 'Cunningham',
          fullName: 'Brad Cunningham', email: 'brad@example.com',
          phone: '+61 400 000 000', addressLine1: '1 Example Street',
          city: 'Melbourne', region: 'VIC', postalCode: '3000',
          organization: 'PlusLife', jobTitle: 'Director',
          linkedin: 'linkedin.com/in/example', dateOfBirth: '1980-01-01',
        },
      },
      true,
    );
    console.log('[aperture] seeded demo profile');
  }

  // Dev-only: a vault with known contents, so the live credential guards
  // (bench/guards.mjs G16-G28) have something to fill. In-memory only — key
  // material generated fresh, `persist()` short-circuited, nothing written to
  // disk — and `seedForDev` refuses outright if a real vault file exists, so it
  // can never stand in front of a human's data. Gated on `!app.isPackaged` AND
  // this flag, both checked inside `seedForDev` itself; this is main-process
  // argv and is not reachable from MCP, IPC, an env var, or a page.
  if (process.argv.includes('--seed-vault')) {
    try {
      await vault.seedForDev();
      console.log(
        '[aperture] ############ --seed-vault: IN-MEMORY DEV VAULT SEEDED. ' +
          'DEV BUILD ONLY. ############',
      );
    } catch (err) {
      console.error(
        `[aperture] --seed-vault refused: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  app.on('activate', () => {
    if (!win) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Deny every attempt to attach a debugger or open devtools from page content,
// and refuse navigation to file:// from a web origin.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) event.preventDefault();
  });
});

/**
 * Write a ready-to-use MCP config next to the user data, and print it.
 *
 * The bearer token is regenerated every launch, so this file is the only way
 * to learn it. It is written 0600 and lives outside any project directory, so
 * it does not end up committed by accident.
 */
async function publishMcpConfig(mcp: {
  url: string;
  token: string;
}): Promise<void> {
  const config = {
    mcpServers: {
      // "Claude Browser" and "Claude Preview" are reserved names in Claude
      // Code and would be silently skipped, hence "aperture".
      aperture: {
        // A url entry without an explicit type is a configuration error in
        // Claude Code — it gets read as stdio and skipped.
        type: 'http',
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.token}` },
      },
    },
  };

  const dest = join(app.getPath('userData'), 'mcp.json');
  await writeFile(dest, JSON.stringify(config, null, 2), { mode: 0o600 });

  console.log(`[aperture] MCP server listening on ${mcp.url}`);
  console.log(`[aperture] connect Claude Code with:`);
  console.log(
    `  claude mcp add --transport http aperture ${mcp.url} ` +
      `-H "Authorization: Bearer ${mcp.token}"`,
  );
  console.log(`[aperture] config also written to ${dest}`);
}

process.on('uncaughtException', (err) => {
  console.error('[aperture] uncaught:', err);
  report(err, 'main');
});

process.on('unhandledRejection', (reason) => {
  console.error('[aperture] unhandled rejection:', reason);
  report(reason, 'main');
});

// Give queued reports a moment to leave before the process goes away.
app.on('before-quit', () => {
  void flushTelemetry(1500);
});

// Handle IPC that must exist even before a window does.
ipcMain.handle('app:version', () => app.getVersion());
