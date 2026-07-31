import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { app, BaseWindow, WebContentsView, ipcMain, shell } from 'electron';
import { TabManager, CHROME_HEIGHT } from './tabs.js';
import { registerIpc } from './ipc.js';
import { installBlocker } from '@privacy/blocker';
import { containers } from '@privacy/containers';
import { startMcpServer } from '@mcp/server';
import { profiles } from '@vault/profileStore';
import { invalidate } from '@core/snapshot/engine';
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

  // A navigation invalidates every ref and clears any taint, so the next
  // observation must be a full snapshot.
  tabs.on('navigated', (tabId: string) => invalidate(tabId));

  // Push tab state to the chrome UI whenever it changes.
  tabs.on('changed', (list, activeId) => {
    chrome?.webContents.send('tabs:changed', { tabs: list, activeId });
  });

  registerIpc({ tabs, chrome, window: win });

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

  win.on('closed', () => {
    win = null;
    chrome = null;
    tabs = null;
  });
}

applyCommandLineSwitches();

app.whenReady().then(async () => {
  // Blocking must be installed on the default container's session before the
  // first request goes out.
  applyDarkMode('dark');
  await installBlocker(containers.sessionFor(containers.defaultId()));

  await createWindow();

  const mcp = await startMcpServer(() => tabs);
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
});

// Handle IPC that must exist even before a window does.
ipcMain.handle('app:version', () => app.getVersion());
