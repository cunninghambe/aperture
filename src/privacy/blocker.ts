import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { app, type Session } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';

/**
 * Tracker and ad blocking.
 *
 * Uses Ghostery's engine, which compiles EasyList/EasyPrivacy-scale rule sets
 * into a compact matcher rather than walking a rule array per request. That
 * matters here more than in a normal browser: an agent driving pages hard
 * makes far more requests per minute than a human does, so per-request
 * matching cost is on the hot path.
 */

let engine: ElectronBlocker | null = null;
const wired = new WeakSet<Session>();

/** Where the compiled engine is cached between launches. */
function cachePath(): string {
  return join(app.getPath('userData'), 'cache', 'adblock-engine.bin');
}

async function loadEngine(): Promise<ElectronBlocker> {
  if (engine) return engine;

  engine = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: cachePath(),
    read: async (path: string) => readFile(path),
    write: async (path: string, data: Uint8Array) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
  });

  return engine;
}

export interface BlockerHandle {
  /** Requests blocked since process start, by session partition. */
  counts: Map<string, number>;
}

const handle: BlockerHandle = { counts: new Map() };

/**
 * Install blocking on a session. Safe to call repeatedly; a session is only
 * wired once.
 */
export async function installBlocker(sess: Session): Promise<BlockerHandle> {
  if (wired.has(sess)) return handle;

  let e: ElectronBlocker;
  try {
    e = await loadEngine();
  } catch (err) {
    // A failed filter-list fetch must not stop the browser from starting. It
    // degrades privacy, so it is loud, but it is not fatal.
    console.error('[aperture] blocker unavailable, continuing unprotected:', err);
    return handle;
  }

  e.enableBlockingInSession(sess);
  wired.add(sess);

  e.on('request-blocked', (req: { tabId?: number }) => {
    void req;
    const key = 'total';
    handle.counts.set(key, (handle.counts.get(key) ?? 0) + 1);
  });

  return handle;
}

export function blockedCount(): number {
  return handle.counts.get('total') ?? 0;
}
