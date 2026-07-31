import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage, type WebContents } from 'electron';
import { appendCapture, datedPage, pageIdFromUrl, type NotionConfig } from './notion.js';

/**
 * Capture a page and put it somewhere useful.
 *
 * The routing is a fallback chain, in the order that matches what someone
 * actually means when they hit the button:
 *
 *   1. A Notion page is open in a tab → append there. You were looking at it;
 *      that is where you want the shot.
 *   2. Notion is configured → append to today's dated page under the inbox.
 *   3. Otherwise → write a PNG to disk.
 *
 * Every step falls through to the next on failure, and step 3 cannot fail for
 * any reason short of a full disk. Losing a screenshot because an API call
 * 400'd would be the worst possible outcome for a button whose whole job is
 * "keep this".
 */

export type CaptureDestination = 'notion-open-page' | 'notion-dated' | 'disk';

export interface CaptureResult {
  destination: CaptureDestination;
  /** Path on disk, or the Notion page id. */
  location: string;
  bytes: number;
  /** Set when a Notion attempt failed and we fell through. */
  fellBackBecause?: string;
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'notion.dat');
}

/** Notion token, encrypted at rest with safeStorage (DPAPI on Windows). */
export async function loadNotionConfig(): Promise<NotionConfig | null> {
  try {
    const raw = await readFile(settingsPath());
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    const cfg = JSON.parse(json) as NotionConfig;
    return cfg.token ? cfg : null;
  } catch {
    return null;
  }
}

export async function saveNotionConfig(cfg: NotionConfig): Promise<void> {
  const json = JSON.stringify(cfg);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  await writeFile(settingsPath(), buf, { mode: 0o600 });
}

export async function capturePage(wc: WebContents): Promise<Buffer> {
  const image = await wc.capturePage();
  return image.toPNG();
}

export interface RouteOptions {
  /** URLs of all open tabs, so we can spot an open Notion page. */
  openUrls?: string[];
  /** Caption / title for the capture. */
  title?: string;
  sourceUrl?: string;
  /** Skip Notion entirely and write to disk. */
  diskOnly?: boolean;
}

export async function routeCapture(
  bytes: Buffer,
  opts: RouteOptions = {},
): Promise<CaptureResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const date = stamp.slice(0, 10);
  const filename = `aperture-${stamp}.png`;
  const caption = [opts.title, opts.sourceUrl].filter(Boolean).join(' — ') || filename;

  if (opts.diskOnly) return toDisk(bytes, filename);

  const cfg = await loadNotionConfig();
  if (!cfg) return toDisk(bytes, filename);

  // 1. A Notion page is open — that is almost certainly the target.
  const openNotion = (opts.openUrls ?? [])
    .map((u) => pageIdFromUrl(u))
    .find((id): id is string => id !== null);

  if (openNotion) {
    try {
      await appendCapture(cfg, openNotion, bytes, caption, filename);
      return { destination: 'notion-open-page', location: openNotion, bytes: bytes.length };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ...(await toDisk(bytes, filename)), fellBackBecause: reason };
    }
  }

  // 2. No Notion page open, but Notion is configured — file it by date.
  try {
    const pageId = await datedPage(cfg, date);
    await appendCapture(cfg, pageId, bytes, caption, filename);
    return { destination: 'notion-dated', location: pageId, bytes: bytes.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...(await toDisk(bytes, filename)), fellBackBecause: reason };
  }
}

/** The destination that always works. */
async function toDisk(bytes: Buffer, filename: string): Promise<CaptureResult> {
  const dir = join(app.getPath('pictures'), 'Aperture');
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return { destination: 'disk', location: path, bytes: bytes.length };
}
