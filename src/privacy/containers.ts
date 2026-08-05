import { createHash } from 'node:crypto';
import { session, type Session } from 'electron';
import type { Container, ContainerId } from '@shared/types';
import { safeDownloadName } from '@shared/download.js';
import { buildUaProfile } from './useragent.js';

/**
 * Identity containers.
 *
 * A container is an isolated cookie jar + cache + storage bucket, plus a
 * stable synthetic fingerprint. Two sites in different containers cannot
 * correlate you, and they see two different — but each internally consistent —
 * browsers.
 *
 * The consistency point matters more than the isolation point. Randomising
 * canvas noise per page load makes you *more* identifiable, not less: real
 * browsers are boringly stable, so a machine whose fingerprint changes every
 * load is a machine wearing a sign. So the seed is per-container and
 * persistent, and every spoofed surface derives from that one seed.
 */

const DEFAULT: Container = {
  id: 'default',
  name: 'Personal',
  partition: 'persist:c-default',
  color: '#6aa9ff',
  claims: [],
  fingerprintSeed: 'default',
  ephemeral: false,
};

class ContainerRegistry {
  private map = new Map<ContainerId, Container>();
  private sessions = new Map<ContainerId, Session>();

  constructor() {
    this.map.set(DEFAULT.id, DEFAULT);
  }

  defaultId(): ContainerId {
    return DEFAULT.id;
  }

  list(): Container[] {
    return [...this.map.values()];
  }

  get(id: ContainerId): Container | null {
    return this.map.get(id) ?? null;
  }

  create(spec: {
    id: ContainerId;
    name: string;
    color?: string;
    claims?: string[];
    ephemeral?: boolean;
  }): Container {
    if (this.map.has(spec.id)) return this.map.get(spec.id)!;
    const c: Container = {
      id: spec.id,
      name: spec.name,
      partition: spec.ephemeral ? `c-${spec.id}` : `persist:c-${spec.id}`,
      color: spec.color ?? '#8b8b8b',
      claims: spec.claims ?? [],
      fingerprintSeed: createHash('sha256').update(spec.id).digest('hex').slice(0, 32),
      ephemeral: spec.ephemeral ?? false,
    };
    this.map.set(c.id, c);
    return c;
  }

  /** Get (and lazily build) the Electron session backing a container. */
  sessionFor(id: ContainerId): Session {
    const cached = this.sessions.get(id);
    if (cached) return cached;

    const c = this.map.get(id) ?? DEFAULT;
    const s = session.fromPartition(c.partition);
    this.harden(s, c);
    this.sessions.set(id, s);
    return s;
  }

  /** Which container should own this URL, honouring claims. */
  containerForUrl(url: string): ContainerId {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return DEFAULT.id;
    }
    for (const c of this.map.values()) {
      if (c.claims.some((d) => host === d || host.endsWith(`.${d}`))) return c.id;
    }
    return DEFAULT.id;
  }

  private harden(s: Session, c: Container): void {
    // Deny every permission by default. The browser asks the human; it never
    // asks the agent, because a page that can talk the agent into granting
    // geolocation has escalated through the weakest link in the system.
    s.setPermissionRequestHandler((_wc, permission, callback) => {
      const alwaysAllow = new Set(['fullscreen', 'clipboard-sanitized-write']);
      callback(alwaysAllow.has(permission));
    });

    s.setPermissionCheckHandler((_wc, permission) => {
      return permission === 'fullscreen';
    });

    // THE DOWNLOAD ROW OF THE EGRESS CLASS — 2026-08-05, third gate.
    //
    // The class is "an affordance where a page-supplied string causes Aperture
    // to act outside the page", and it is enumerable to exhaustion:
    // `test/egress.test.ts` is the enumeration and fails when a new affordance
    // appears. Downloads were its one unruled row — there was NO `will-download`
    // handler anywhere in `src/`, so a page's `a.download = '…'` or a
    // `Content-Disposition` name went straight into the save dialog and onto the
    // disk as the default.
    //
    // The transfer itself is not the finding and is not blocked: the human's
    // save dialog is the gate, it is the gate every browser uses, and a page
    // that can start a download can already `fetch()` the same bytes. What is
    // closed is the STRING — by the time the dialog is drawn, the name is
    // Aperture's, with no path, no invisible characters and a bound.
    // `safeDownloadName` is a pure leaf and argues the rest at its own header.
    //
    // Installed per SESSION rather than per webContents on purpose: a session is
    // created once per container in `sessionFor`, so this cannot double-register
    // as tabs come and go, and there is no tab whose download path this misses.
    s.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: safeDownloadName(item.getFilename()) });
    });

    // Strip the Electron/Chrome version skew from the UA. A stock Electron UA
    // announces "Electron/43.0.0" and is trivially fingerprintable.
    // Session-level UA, kept in sync with the per-tab profile in
    // privacy/useragent.ts so the two can never disagree.
    s.setUserAgent(buildUaProfile(process.versions.chrome ?? '150.0.0.0').userAgent);

    void c; // per-container fingerprint derivation is applied in the page preload
  }
}

export const containers = new ContainerRegistry();
