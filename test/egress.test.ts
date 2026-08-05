import { describe, expect, it } from 'vitest';
import { safeDownloadName } from '../src/shared/download.js';
import { sources } from './lib/source.js';

/**
 * THE EGRESS CLASS, ENUMERATED BY MODULE SURFACE.
 *
 * The class: **an affordance where a page-supplied string causes Aperture to
 * act outside the page.** Its first member is the eleventh sink — a page called
 * `window.open('mailto:…' + MARKER)`, `normalizeUrl` answered a disallowed
 * scheme with a DuckDuckGo search over the whole string, and Aperture put
 * page-chosen bytes on the network to a host the page never named
 * (`docs/design/security.md`, "a page could make Aperture put its own bytes on
 * the network").
 *
 * It is a DIFFERENT PROPERTY from everything else in this programme, and the
 * distinction is load-bearing. Every other finding moves a value from one place
 * inside the browser to another place inside the browser, and the repair is a
 * scrub. No scrub applies to this one; the only repair is not to do it. It also
 * hits precisely the adversary the needle mechanism exists for — injected script
 * on an otherwise-honest origin, whose own CSP (`connect-src 'self'`) can forbid
 * its `fetch()` and forbade nothing here. Aperture was a CSP bypass.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS REWRITTEN — 2026-08-05, fourth gate
 * ---------------------------------------------------------------------------
 *
 * Its docblock claimed the class *can* be enumerated to exhaustion because
 * "the set of ways a browser reaches outside a page is small, fixed, and named
 * by the platform". **That is true of the platform and it was not true of this
 * file.** `PRIMITIVES` was eleven hand-written regexes, and one of them was
 * `/shell\.openExternal\(/` — the single FUNCTION name, not the `shell` module.
 * So `shell.openPath`, `shell.moveItemToTrash`, `clipboard.writeText`,
 * `webContents.print`, `session.setProxy` and `net.request` were all outside the
 * enumeration, and the gate shipped a new `browser_share` tool acting on
 * page-written strings through two of them with the whole suite green
 * (`docs/design/sink-closure-review-4.md` §3).
 *
 * A list of chosen function names is a thing somebody remembers. **A module
 * surface is a thing the platform publishes.** So the unit of enumeration is
 * now the surface rather than the name:
 *
 *   · `ELECTRON_SURFACE` freezes every value symbol imported from `'electron'`
 *     anywhere in `src/`, **with the files that import it**. A new symbol
 *     (`clipboard`, `net`, `protocol`, `powerMonitor`) fails by name, and so
 *     does a new FILE reaching for one that is already ruled.
 *   · `MEMBERS` freezes every member accessed on one of those symbols, and on
 *     the two Electron objects this codebase holds by reference rather than by
 *     import — `Session` and `WebContents`. Every member is ruled on one
 *     question: *can a page choose the bytes this acts on?* `shell.openPath`
 *     next to a ruled `shell.openExternal` is an unruled row, not a near-miss.
 *   · `PRIMITIVES` stays on top, unchanged, because it covers the platform
 *     surfaces that are NOT electron-module members: node's `fetch`,
 *     `createServer`, `writeFile`, `child_process`, and the three event names.
 *
 * TOTAL IN BOTH DIRECTIONS, for all three tables: a new affordance fails with
 * the file and the member named, and a ruling whose affordance has DISAPPEARED
 * fails too. That second half is what stops this becoming the stale audit
 * `security.md`'s preload `reason:` count turned out to be — four sites, still
 * four, different four.
 *
 * WHAT IT CANNOT DO, stated because every guard in this repo now states it.
 *
 *   1. **It cannot falsify a ruling.** A row that says "no — the argument is
 *      Aperture's own" is checked by a human reading it, exactly as
 *      `completeness.test.ts` cannot falsify a `not-page-text` claim. What it
 *      guarantees is that no affordance exists without one, which is the
 *      failure that actually happened — twice.
 *   2. **`Session` and `WebContents` are found lexically, not by type.**
 *      `test/lib/source.ts` is a lexer. It finds a receiver by its annotation
 *      (`s: Session`, `wc: WebContents`) or by a direct binding
 *      (`const wc = rec.view.webContents;`). A WebContents obtained through an
 *      expression it cannot follow — passed through a generic, stored in a
 *      collection, returned from a helper with an inferred type — carries
 *      members this table will not see. That residual is why `PRIMITIVES`
 *      keeps `.loadURL(` as a receiver-INDEPENDENT row: the highest-value
 *      member of the surface with the weakest receiver tracking is matched on
 *      the member alone.
 *   3. **It says nothing about the renderer's own DOM.** `dialog.showModal()`
 *      in `vault-ui.ts` is an HTML `<dialog>` and `navigator.clipboard` is the
 *      page's own — neither file imports from `'electron'`, so neither appears
 *      here. Import-scoping is what lets the member match be loose without
 *      teaching a reader to ignore the table's rows.
 */

const SOURCES = sources();

/**
 * Platform primitives that are NOT electron-module members: node's own egress,
 * and the three Electron EVENT names, which are strings rather than members.
 *
 * Kept from the previous generation of this file because they are still the
 * right instrument for their targets, and one of them — `.loadURL(` — is
 * deliberately receiver-independent, which is the backstop for residual 2
 * above.
 */
const PRIMITIVES: [string, RegExp][] = [
  ['window.open handler', /setWindowOpenHandler\(/],
  ['navigation', /\.loadURL\(/],
  ['renderer navigation', /'will-navigate'/],
  ['download', /'will-download'/],
  ['hand to the OS', /shell\.openExternal\(/],
  ['network request', /\bfetch\b/],
  ['inbound listener', /createServer\(/],
  ['write to disk', /\bwriteFile\(/],
  ['native file dialog', /dialog\.show(MessageBox|OpenDialog|SaveDialog|ErrorBox)/],
  ['custom protocol', /protocol\.register/],
  ['child process', /child_process|\bspawn\(|\bexecFile\(/],
];

/**
 * The ruled table for `PRIMITIVES`. `page-supplied?` is the question the class
 * is about: can a PAGE choose the bytes this primitive acts on?
 *
 * Kept in step with `docs/design/security.md`'s egress table by hand, and that
 * is a real seam — but the seam is between two documents that both have to be
 * edited, rather than between a document and a fact nobody is checking.
 */
const RULED: Record<string, string> = {
  // --- page-supplied: YES. These are the class. ----------------------------
  'src/main/tabs.ts :: window.open handler':
    'YES, and it is the eleventh sink. Chromium hands the page\'s target over ' +
    'resolved and absolute; the scheme is checked HERE rather than left to ' +
    'normalizeUrl, whose search fallback would have put the string on the ' +
    'network. Guarded by G19l.',
  'src/main/tabs.ts :: navigation':
    'YES — a page can navigate itself, and the agent can be steered into a ' +
    'navigate call. isAllowedScheme is enforced again at this funnel rather ' +
    'than trusted from the caller, because this is the last place a bad scheme ' +
    'can be stopped. Guarded by test/security.test.ts and G20.',
  'src/privacy/containers.ts :: download':
    'YES — `a.download` and Content-Disposition are the page\'s strings. The ' +
    'transfer is gated by the human\'s save dialog, as in every browser; what ' +
    'this handler closes is the NAME, via safeDownloadName (no path, no ' +
    'invisible characters, bounded). Was the enumeration\'s one unruled row ' +
    'until 2026-08-05: there was no will-download handler anywhere in src/.',
  'src/main/index.ts :: renderer navigation':
    'YES for a tab, and this listener is the app-wide one. It denies only ' +
    'file://, which is E1 — a known-open item, unchanged, and theoretical ' +
    'because the shell renderer has no link, no window.open and no innerHTML ' +
    'sink to reach it with. Chromium resolves the target and there is no ' +
    'normalizeUrl search fallback on this path.',
  'src/main/index.ts :: hand to the OS':
    'YES IF REACHED, and it is E2 — the chrome renderer\'s window-open handler ' +
    'passes any URL to shell.openExternal with no scheme check, which on ' +
    'Windows is a ShellExecute-class primitive. Known-open, unchanged, and ' +
    'gated behind E1: it needs script in the chrome renderer first. E1+E2 are ' +
    'one chain and the only path in this codebase that ends in code execution.',

  // --- page-supplied: NO. Ruled, so the table is total. --------------------
  'src/main/index.ts :: window.open handler':
    'NO — the chrome renderer is local content and opens nothing on a page\'s ' +
    'behalf. The URL it receives is E2\'s argument, ruled above.',
  'src/main/index.ts :: navigation':
    'NO — loads the bundled renderer HTML, a path Aperture built.',
  'src/main/index.ts :: write to disk':
    'NO — writes mcp.json to userData from Aperture\'s own config object.',
  'src/main/vaultWindow.ts :: window.open handler':
    'NO — unconditional deny. The vault window opens nothing.',
  'src/main/vaultWindow.ts :: renderer navigation':
    'NO — unconditional preventDefault, which is what the shell window (E1) ' +
    'does not do and should.',
  'src/main/vaultWindow.ts :: navigation':
    'NO — the bundled vault HTML.',
  'src/main/vaultWindow.ts :: hand to the OS':
    'NO — allowlisted to Notion HTTPS URLs, with the comment saying why. This ' +
    'is the treatment index.ts (E2) did not get.',
  'src/main/vaultWindow.ts :: network request':
    'NO — api.notion.com, a fixed host, with the human\'s own token.',
  'src/main/vaultWindow.ts :: native file dialog':
    'NO — a human picking a file to attach; the agent cannot raise it and ' +
    'browser_attach takes library ids, never paths.',
  'src/main/consent.ts :: native file dialog':
    'NO — the fill consent dialog. Native by design: there is no parameter an ' +
    'agent can set that asserts prior consent, and no page can render it.',
  'src/capture/notion.ts :: network request':
    'NO — api.notion.com. The CAPTION and SOURCE URL it carries are ' +
    'page-written and are scrubbed at both routeCapture call sites; the ' +
    'DESTINATION is the active tab only, which is F-G. test/urlsurfaces.test.ts ' +
    'asserts all three.',
  'src/capture/capture.ts :: write to disk':
    'NO — a PNG under userData, named from a timestamp Aperture generated.',
  'src/privacy/blocker.ts :: network request':
    'NO — the prebuilt filter lists, fetched by @ghostery/adblocker from its ' +
    'own fixed endpoints.',
  'src/privacy/blocker.ts :: write to disk':
    'NO — the filter-list cache, under userData.',
  'src/telemetry/reporter.ts :: write to disk':
    'NO — the telemetry config, under userData.',
  'src/telemetry/uh-oh-client.ts :: network request':
    'NO — a vendored analytics client reached through a locally-typed view of ' +
    'globals; it mints and sends no identifier, and no page string reaches it.',
  'src/vault/vault.ts :: write to disk':
    'NO — the encrypted vault file, under userData.',
  'src/vault/profileStore.ts :: write to disk':
    'NO — the encrypted profile store, under userData.',
  'src/vault/attachments.ts :: write to disk':
    'NO — the attachment index, under userData.',
  'src/mcp/server.ts :: inbound listener':
    'NO, and it is inbound rather than egress — bound to 127.0.0.1 only, ' +
    'behind a per-launch bearer, with Host and Origin validated BEFORE auth so ' +
    'the DNS-rebinding defence is not gated on a token a page does not have.',
};

/**
 * Every value symbol this codebase imports from `'electron'`, and where.
 *
 * The FILE LIST is part of the freeze, not decoration. `shell` is already ruled
 * for `index.ts` and `vaultWindow.ts`; the gate's sabotage imported it into
 * `tools.ts`, which is the MCP surface the agent drives, and a symbol-only
 * freeze would have shrugged.
 */
const ELECTRON_SURFACE: Record<string, { files: string[]; ruling: string }> = {
  app: {
    files: [
      'src/capture/capture.ts',
      'src/main/consent.ts',
      'src/main/index.ts',
      'src/mcp/server.ts',
      'src/privacy/blocker.ts',
      'src/privacy/darkmode.ts',
      'src/telemetry/reporter.ts',
      'src/vault/attachments.ts',
      'src/vault/profileStore.ts',
      'src/vault/vault.ts',
    ],
    ruling:
      'Process lifecycle and Aperture\'s own paths. Its egress-capable members ' +
      '(setAsDefaultProtocolClient, relaunch, moveToApplicationsFolder, ' +
      'requestSingleInstanceLock) are absent from MEMBERS, so adding one is a red.',
  },
  BaseWindow: { files: ['src/main/index.ts'], ruling: 'A window class. No egress surface.' },
  BrowserWindow: {
    files: ['src/main/consent.ts', 'src/main/vaultWindow.ts'],
    ruling: 'A window class. Its WebContents is the surface, and it is ruled below.',
  },
  WebContentsView: {
    files: ['src/main/index.ts', 'src/main/tabs.ts'],
    ruling: 'A view class. Its WebContents is the surface, and it is ruled below.',
  },
  contextBridge: {
    files: ['src/preload/shell.ts', 'src/preload/vault.ts'],
    ruling:
      'Exposes an API into a TRUSTED renderer. Not present in page.ts, which is ' +
      'the preload a hostile page shares a process with — that asymmetry is the ' +
      'point and `test/security.test.ts` asserts it.',
  },
  dialog: {
    files: ['src/main/consent.ts', 'src/main/vaultWindow.ts'],
    ruling: 'Native OS dialogs. Human-facing, no agent-reachable parameter.',
  },
  ipcMain: {
    files: [
      'src/core/snapshot/act.ts',
      'src/core/snapshot/engine.ts',
      'src/main/index.ts',
      'src/main/ipc.ts',
      'src/main/vaultWindow.ts',
    ],
    ruling: 'Inbound from Aperture\'s own preloads. Not egress; ruled so the table is total.',
  },
  ipcRenderer: {
    files: ['src/preload/page.ts', 'src/preload/shell.ts', 'src/preload/vault.ts'],
    ruling:
      'The preload side of the same channel. In page.ts it reaches main and ' +
      'nothing else; the page cannot see it (no contextBridge there).',
  },
  nativeTheme: {
    files: ['src/privacy/darkmode.ts'],
    ruling: 'Reads and sets the OS theme preference. No string leaves the process.',
  },
  safeStorage: {
    files: ['src/capture/capture.ts', 'src/vault/profileStore.ts'],
    ruling:
      'OS keychain encrypt/decrypt, on bytes Aperture owns. It is egress to the ' +
      'OS credential store and it is ruled here rather than left off the list.',
  },
  session: {
    files: ['src/privacy/containers.ts'],
    ruling:
      'The container sessions. `fromPartition` names a partition Aperture built; ' +
      'every method called on the resulting Session is a Session# row below.',
  },
  shell: {
    files: ['src/main/index.ts', 'src/main/vaultWindow.ts'],
    ruling:
      'THE OS HANDOFF, and on Windows a ShellExecute-class primitive. Two files ' +
      'and two members — a third of either is the eleventh sink\'s shape.',
  },
};

/**
 * Every member accessed on an Electron surface, ruled on one question: can a
 * PAGE choose the bytes this acts on?
 *
 * `Session#` and `WebContents#` rows are the two objects held by reference
 * rather than by import — see residual 2 in the header for how they are found
 * and what that misses.
 */
const MEMBERS: Record<string, string> = {
  // --- app ------------------------------------------------------------------
  'src/capture/capture.ts :: app.getPath': 'NO — userData.',
  'src/main/index.ts :: app.getPath': 'NO — userData.',
  'src/privacy/blocker.ts :: app.getPath': 'NO — userData.',
  'src/telemetry/reporter.ts :: app.getPath': 'NO — userData.',
  'src/vault/attachments.ts :: app.getPath': 'NO — userData.',
  'src/vault/profileStore.ts :: app.getPath': 'NO — userData.',
  'src/vault/vault.ts :: app.getPath': 'NO — userData.',
  'src/main/consent.ts :: app.isPackaged': 'NO — a boolean; gates the dev-only consent flag.',
  'src/telemetry/reporter.ts :: app.isPackaged': 'NO — a boolean.',
  'src/vault/vault.ts :: app.isPackaged': 'NO — a boolean.',
  'src/main/index.ts :: app.commandLine':
    'NO — Aperture\'s own switches, set before any page exists.',
  'src/privacy/darkmode.ts :: app.commandLine': 'NO — Aperture\'s own switches.',
  'src/main/index.ts :: app.getVersion': 'NO — a constant.',
  'src/main/index.ts :: app.on': 'NO — lifecycle events.',
  'src/main/index.ts :: app.quit': 'NO — no argument.',
  'src/main/index.ts :: app.whenReady': 'NO — no argument.',
  'src/mcp/server.ts :: app.getAppMetrics':
    'NO — process metadata, served on the authenticated loopback /metrics route. ' +
    'No page data, no tab, no URL (security.md, "GET /metrics").',

  // --- safeStorage ----------------------------------------------------------
  'src/capture/capture.ts :: safeStorage.isEncryptionAvailable': 'NO — a boolean.',
  'src/capture/capture.ts :: safeStorage.encryptString': 'NO — the Notion token, Aperture\'s own.',
  'src/capture/capture.ts :: safeStorage.decryptString': 'NO — the same, coming back.',
  'src/vault/profileStore.ts :: safeStorage.isEncryptionAvailable': 'NO — a boolean.',
  'src/vault/profileStore.ts :: safeStorage.encryptString':
    'NO — the profile store. Human-authored values, never page-authored.',
  'src/vault/profileStore.ts :: safeStorage.decryptString': 'NO — the same, coming back.',

  // --- ipcMain / ipcRenderer / contextBridge --------------------------------
  'src/core/snapshot/act.ts :: ipcMain.on': 'NO — inbound results from Aperture\'s own preload.',
  'src/core/snapshot/engine.ts :: ipcMain.on': 'NO — inbound; the fill/walk/read results.',
  'src/main/index.ts :: ipcMain.handle': 'NO — inbound from the shell renderer.',
  'src/main/ipc.ts :: ipcMain.handle': 'NO — inbound from the shell renderer.',
  'src/main/ipc.ts :: ipcMain.removeHandler': 'NO — teardown.',
  'src/main/vaultWindow.ts :: ipcMain.handle': 'NO — inbound from the vault renderer.',
  'src/main/vaultWindow.ts :: ipcMain.removeHandler': 'NO — teardown.',
  'src/preload/page.ts :: ipcRenderer.on':
    'NO, and this is the surface the coverage guard starts from: the channels ' +
    'listened to here are frozen in test/fillpaths.test.ts and exactly one of ' +
    'them writes a value into a field.',
  'src/preload/page.ts :: ipcRenderer.send': 'NO — results back to main, over the same channels.',
  'src/preload/shell.ts :: ipcRenderer.invoke': 'NO — the shell renderer\'s own requests.',
  'src/preload/shell.ts :: ipcRenderer.on': 'NO — main\'s pushes to the shell renderer.',
  'src/preload/shell.ts :: ipcRenderer.removeListener': 'NO — teardown.',
  'src/preload/vault.ts :: ipcRenderer.invoke': 'NO — the vault renderer\'s own requests.',
  'src/preload/shell.ts :: contextBridge.exposeInMainWorld': 'NO — a trusted local renderer.',
  'src/preload/vault.ts :: contextBridge.exposeInMainWorld': 'NO — a trusted local renderer.',

  // --- dialog / nativeTheme -------------------------------------------------
  'src/main/consent.ts :: dialog.showMessageBox':
    'NO — the fill consent dialog. Its text is Aperture\'s and the ORIGIN it ' +
    'names is the committed one, not a page-chosen string.',
  'src/main/vaultWindow.ts :: dialog.showOpenDialog':
    'NO — a human picking an attachment. The agent cannot raise it.',
  'src/privacy/darkmode.ts :: nativeTheme.themeSource': 'NO — an enum Aperture sets.',
  'src/privacy/darkmode.ts :: nativeTheme.shouldUseDarkColors': 'NO — a boolean.',

  // --- shell — THE OS HANDOFF ----------------------------------------------
  'src/main/index.ts :: shell.openExternal':
    'YES IF REACHED — E2, known-open, gated behind E1. See RULED above; this row ' +
    'exists so that a SECOND shell member here fails even though openExternal is ruled.',
  'src/main/vaultWindow.ts :: shell.openExternal':
    'NO — allowlisted to Notion HTTPS. The treatment index.ts did not get.',

  // --- session --------------------------------------------------------------
  'src/privacy/containers.ts :: session.fromPartition':
    'NO — the partition name is `c-<containerId>`, and container ids are ' +
    'agent- or human-chosen, never page-chosen.',
  'src/privacy/containers.ts :: Session#setPermissionRequestHandler':
    'NO — denies everything except fullscreen and sanitized clipboard write. A ' +
    'page that could talk the AGENT into granting geolocation would have ' +
    'escalated through the weakest link; it is never asked.',
  'src/privacy/containers.ts :: Session#setPermissionCheckHandler': 'NO — the same, synchronous.',
  'src/privacy/containers.ts :: Session#on':
    'The `will-download` handler. YES on its argument — the page names the file ' +
    '— and that is the RULED download row: the transfer stays the human\'s save ' +
    'dialog and the NAME becomes Aperture\'s via safeDownloadName.',
  'src/privacy/containers.ts :: Session#setUserAgent':
    'NO — derived from process.versions.chrome. Never page-influenced, and ' +
    'privacy/useragent.ts asserts the two spellings agree.',

  // --- WebContents ----------------------------------------------------------
  'src/core/snapshot/act.ts :: WebContents#send': 'NO — Aperture\'s act channels.',
  'src/core/snapshot/engine.ts :: WebContents#send':
    'NO — Aperture\'s walk/read/select/fill channels. The fill one carries the ' +
    'SECRET into the page, which is the write the coverage guard enumerates; it ' +
    'is not egress out of the page.',
  'src/main/index.ts :: WebContents#send': 'NO — pushes to the shell renderer.',
  'src/core/snapshot/act.ts :: WebContents#debugger':
    'NO — CDP Input domain, coordinates and key names Aperture computed.',
  'src/core/snapshot/engine.ts :: WebContents#debugger':
    'NO — CDP DOM.setFileInputFiles, with paths from the attachment library ' +
    '(library ids, never page strings) — the browser_attach ruling.',
  'src/privacy/darkmode.ts :: WebContents#debugger': 'NO — CDP Emulation, Aperture\'s own values.',
  'src/privacy/useragent.ts :: WebContents#debugger': 'NO — CDP Emulation, Aperture\'s own values.',
  'src/privacy/darkmode.ts :: WebContents#executeJavaScript':
    'NO — a fixed script literal. No interpolation of any page or agent string.',
  'src/mcp/tools.ts :: WebContents#executeJavaScript':
    'NO — `readScript()`, a fixed literal, run in the ISOLATED world. Its RESULT ' +
    'is page text and is treated as such (stripFormat, redaction, envelope).',
  'src/main/index.ts :: WebContents#loadURL':
    'NO — the bundled renderer HTML, a path Aperture built.',
  'src/main/index.ts :: WebContents#loadFile': 'NO — a bundled file.',
  'src/main/tabs.ts :: WebContents#loadURL':
    'YES — the tab funnel. isAllowedScheme is enforced HERE rather than trusted ' +
    'from the caller (RULED, "src/main/tabs.ts :: navigation").',
  'src/main/index.ts :: WebContents#setWindowOpenHandler':
    'NO — the chrome renderer opens nothing on a page\'s behalf; its URL is E2.',
  'src/main/tabs.ts :: WebContents#setWindowOpenHandler':
    'YES — the eleventh sink. Scheme checked in the handler (G19l).',
  'src/main/vaultWindow.ts :: WebContents#setWindowOpenHandler': 'NO — unconditional deny.',
  'src/main/tabs.ts :: WebContents#getURL':
    'NO — reads. It is the committed origin every fill decision keys on.',
  'src/mcp/tools.ts :: WebContents#getURL': 'NO — reads.',
  'src/main/tabs.ts :: WebContents#getTitle':
    'NO — reads, and what it returns is page-authored: it goes through the tab ' +
    'listing\'s scrub, never anywhere else.',
  'src/main/tabs.ts :: WebContents#on': 'NO — load-state events.',
  'src/main/vaultWindow.ts :: WebContents#on': 'NO — will-navigate, denied unconditionally.',
  'src/main/vaultWindow.ts :: WebContents#id': 'NO — an integer.',
  'src/main/tabs.ts :: WebContents#close': 'NO — no argument.',
  'src/main/tabs.ts :: WebContents#stop': 'NO — no argument.',
  'src/main/tabs.ts :: WebContents#reload': 'NO — no argument.',
  'src/main/tabs.ts :: WebContents#navigationHistory':
    'NO — goBack/goForward/canGoBack. No URL crosses; the destination is one ' +
    'the tab already visited.',
  'src/main/tabs.ts :: WebContents#session':
    'NO — reads the container Session back off a tab, for the blocker. Every ' +
    'method reachable through it is a Session# row above; this accessor takes ' +
    'no argument at all.',
  'src/main/tabs.ts :: WebContents#isAudioMuted': 'NO — a boolean.',
  'src/main/tabs.ts :: WebContents#isCurrentlyAudible': 'NO — a boolean.',
  'src/capture/capture.ts :: WebContents#capturePage':
    'NO on its argument (no argument). The IMAGE never enters agent context; ' +
    'where it is FILED is routeCapture\'s destination, which is F-G and is ' +
    'asserted by test/urlsurfaces.test.ts.',
};

/** Value symbols imported from `'electron'` in this file. */
function electronValueImports(raw: string, code: string): string[] {
  const out: string[] = [];
  const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'electron'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    // The match was found in the RAW text; `code` blanks comments, so a
    // commented-out import is not an import.
    if (code.slice(m.index, m.index + 6) !== 'import') continue;
    if (m[1]) continue;
    for (const part of m[2]!.split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('type ')) continue;
      out.push(t.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return out;
}

/** Identifiers in this file that hold an object of Electron type `name`. */
function receivers(code: string, name: string, extra: RegExp[] = []): Set<string> {
  const ids = new Set<string>();
  for (const x of code.matchAll(new RegExp(`\\b([A-Za-z0-9_$]+)\\s*:\\s*${name}\\b`, 'g'))) {
    ids.add(x[1]!);
  }
  for (const re of extra) for (const x of code.matchAll(re)) ids.add(x[1]!);
  return ids;
}

/** Every `file :: surface.member` this tree touches. */
function observedMembers(): Set<string> {
  const out = new Set<string>();
  for (const f of SOURCES) {
    for (const s of electronValueImports(f.raw, f.code)) {
      for (const x of f.code.matchAll(new RegExp(`\\b${s}\\.([A-Za-z0-9_$]+)`, 'g'))) {
        out.add(`${f.rel} :: ${s}.${x[1]}`);
      }
    }
    const sessions = receivers(f.code, 'Session', [
      /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)[^=;]*=\s*session\.fromPartition/g,
    ]);
    for (const id of sessions) {
      for (const x of f.code.matchAll(new RegExp(`\\b${id}\\.([A-Za-z0-9_$]+)`, 'g'))) {
        out.add(`${f.rel} :: Session#${x[1]}`);
      }
    }
    const wcs = receivers(f.code, 'WebContents', [
      /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=;]*)?=\s*[A-Za-z0-9_$.!?[\]]*\.webContents(\s*\([^()]*\))?\s*;/g,
    ]);
    for (const id of wcs) {
      for (const x of f.code.matchAll(new RegExp(`\\b${id}\\.([A-Za-z0-9_$]+)`, 'g'))) {
        out.add(`${f.rel} :: WebContents#${x[1]}`);
      }
    }
    // The receiver spelled INLINE, with or without an intervening call:
    // `rec.view.webContents.getURL()` and `t.webContents(id).downloadURL(…)`.
    //
    // This clause is here because of a measured sabotage rather than a guess.
    // With only the two named-receiver patterns above, `webContents.downloadURL`
    // was RED in `tabs.ts` (where a `const wc = …` binding exists) and GREEN in
    // `tools.ts` (where the same call is written inline) — the same affordance,
    // caught or missed according to how its author happened to spell the
    // receiver. Row S-E3 in `docs/design/security.md`'s sabotage table.
    for (const x of f.code.matchAll(/\.webContents(?:\s*\([^()]*\))?\s*\.([A-Za-z0-9_$]+)/g)) {
      out.add(`${f.rel} :: WebContents#${x[1]}`);
    }
  }
  return out;
}

describe('the egress class, enumerated', () => {
  const observed = new Set<string>();
  for (const f of SOURCES) {
    for (const [name, re] of PRIMITIVES) {
      // `quoted` rather than `code`: three of these primitives ARE strings
      // (the event names), and a blanked file has no strings in it. `quoted`
      // appends the file's real literals, so an event name in a COMMENT still
      // does not count and one in the code still does.
      if (re.test(f.quoted)) observed.add(`${f.rel} :: ${name}`);
    }
  }

  it('every affordance that can act outside a page carries a ruling', () => {
    const unruled = [...observed].filter((k) => !(k in RULED)).sort();
    expect(
      unruled,
      'A NEW AFFORDANCE. Something in src/ can now act outside a page and ' +
        'nothing says whether a page chooses the bytes. Rule it here and in ' +
        'docs/design/security.md\'s egress table.',
    ).toEqual([]);
  });

  it('every ruling still has an affordance under it', () => {
    const stale = Object.keys(RULED).filter((k) => !observed.has(k)).sort();
    expect(
      stale,
      'A STALE RULING. This row claims to rule on something that is no longer ' +
        'in the code. Delete it — a table that keeps rows for affordances that ' +
        'left is how the preload `reason:` audit stayed plausible while its ' +
        'membership changed underneath the count.',
    ).toEqual([]);
  });

  it('the download row is a handler and not a hope', () => {
    // The row that was open. Asserted on its own because "there is no handler
    // at all" is what the third gate found, and the whole-table check above
    // would pass just as happily if this row were ruled and absent.
    const containers = SOURCES.find((f) => f.rel === 'src/privacy/containers.ts')!;
    expect(containers.quoted).toMatch(/'will-download'/);
    expect(
      containers.code,
      'the save dialog must be pre-filled with a name Aperture built, not with ' +
        'the page\'s',
    ).toMatch(/safeDownloadName\(/);
  });
});

describe('the Electron surface, enumerated by module rather than by name', () => {
  const imported = new Map<string, string[]>();
  for (const f of SOURCES) {
    for (const s of electronValueImports(f.raw, f.code)) {
      imported.set(s, [...(imported.get(s) ?? []), f.rel].sort());
    }
  }

  it('every symbol imported from electron is ruled, and imported where it is ruled', () => {
    // Total in both directions on BOTH axes: a new symbol, a new file for an
    // existing symbol, a ruled symbol that has disappeared. The gate's sabotage
    // imported `clipboard` (a new symbol) and `shell` into a new file, and this
    // is the assertion each of those halves lands on.
    const observedPairs = [...imported]
      .flatMap(([s, files]) => files.map((f) => `${s} <- ${f}`))
      .sort();
    const ruledPairs = Object.entries(ELECTRON_SURFACE)
      .flatMap(([s, r]) => r.files.map((f) => `${s} <- ${f}`))
      .sort();
    expect(
      observedPairs,
      'THE ELECTRON SURFACE MOVED. A new symbol, or an old symbol reaching a new ' +
        'file. This is the enumeration the fourth gate walked past when eleven ' +
        'chosen function names stood in for the module surface: rule it in ' +
        'ELECTRON_SURFACE, and rule each of its members in MEMBERS.',
    ).toEqual(ruledPairs);
  });

  it('every member of an Electron surface carries a ruling', () => {
    const seen = observedMembers();
    const unruled = [...seen].filter((k) => !(k in MEMBERS)).sort();
    expect(
      unruled,
      'AN UNRULED MEMBER. `shell.openPath` beside a ruled `shell.openExternal` ' +
        'is a new affordance, not a near-miss — that is exactly what the fourth ' +
        'gate shipped past this file. Answer one question for each row: can a ' +
        'PAGE choose the bytes this acts on?',
    ).toEqual([]);
  });

  it('every member ruling still has a member under it', () => {
    const seen = observedMembers();
    const stale = Object.keys(MEMBERS).filter((k) => !seen.has(k)).sort();
    expect(
      stale,
      'A STALE MEMBER RULING. The call it rules on is gone. Delete the row — a ' +
        'ruling with nothing under it is how an audit stays plausible while its ' +
        'membership changes.',
    ).toEqual([]);
  });

  it('the modules that can act outside the page have exactly the members ruled', () => {
    // The narrow, high-value restatement of the assertion above: for the four
    // surfaces whose every member is an OS or network act, name the members.
    // If the table above were ever loosened, this row still fails on a second
    // `shell.` or a first `clipboard.`.
    const seen = [...observedMembers()];
    const of = (surface: string): string[] =>
      [...new Set(seen.filter((k) => k.includes(` :: ${surface}.`)).map((k) => k.split(' :: ')[1]!))].sort();
    expect(of('shell'), 'shell reaches the OS').toEqual(['shell.openExternal']);
    expect(of('clipboard'), 'clipboard reaches every other app on the machine').toEqual([]);
    expect(of('net'), 'net reaches the network outside Chromium\'s stack').toEqual([]);
    expect(of('protocol'), 'protocol registers a scheme handler').toEqual([]);
  });
});

describe('safeDownloadName, executed', () => {
  // A pure leaf, so the suite runs the shipped function rather than a copy.
  it('drops the path, in both flavours and both directions', () => {
    expect(safeDownloadName('../../Startup/evil.lnk')).toBe('evil.lnk');
    expect(safeDownloadName('..\\..\\Startup\\evil.lnk')).toBe('evil.lnk');
    expect(safeDownloadName('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts');
    expect(safeDownloadName('\\\\server\\share\\payload.exe')).toBe('payload.exe');
    expect(safeDownloadName('/etc/passwd')).toBe('passwd');
  });

  it('removes the override that makes an extension read backwards', () => {
    // `invoice\u202Egnp.exe` DRAWS as `invoiceexe.png` in the dialog the human
    // is reading before they click Save. The strip is the same one text.ts
    // applies everywhere else; here it is a spoofing defence rather than a
    // redaction one.
    const spoof = 'invoice\u202Egnp.exe';
    expect(safeDownloadName(spoof)).toBe('invoicegnp.exe');
    expect(safeDownloadName(spoof)).not.toContain('\u202e');
    expect(safeDownloadName('re\u0000port.pdf')).toBe('report.pdf');
  });

  it('never returns an empty name, whatever it was handed', () => {
    for (const junk of ['', '   ', '..', '../..', '/', '\\', '...', '~', '\u202e']) {
      expect(safeDownloadName(junk), `for ${JSON.stringify(junk)}`).toBe('download');
    }
  });

  it('bounds the length and keeps the extension while doing it', () => {
    // Truncating from the END would remove the extension, which is the same
    // deception the RTL override buys — produced by us, this time.
    const long = 'a'.repeat(4000) + '.pdf';
    const out = safeDownloadName(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('leaves an ordinary name exactly as it was', () => {
    // The non-vacuity half: a sanitiser that mangled every name would pass every
    // assertion above and break the feature.
    for (const ok of ['statement-2026-08.pdf', 'Invoice 41.xlsx', 'a.tar.gz']) {
      expect(safeDownloadName(ok)).toBe(ok);
    }
  });

  it('replaces the characters Win32 refuses, rather than dropping the name', () => {
    expect(safeDownloadName('re:port<1>.pdf')).toBe('re_port_1_.pdf');
  });
});
