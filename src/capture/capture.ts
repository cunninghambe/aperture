import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage, type WebContents } from 'electron';
import { appendCapture, datedPage, pageIdFromUrl, type NotionConfig } from './notion.js';
import {
  cropNoteFor,
  detailRect,
  detectScale,
  trimRect,
  type CropDecline,
  type Rect,
} from './autocrop.js';

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

/**
 * What framing the caller wants. Both call sites default to `trim`; only the
 * agent can ask for anything else, and only by saying so in a parameter the
 * transcript keeps (docs/design/autocrop.md §2, §4).
 */
export type CaptureMode =
  | { kind: 'full' } // untouched frame — `crop: "none"`, and every decline
  | { kind: 'trim' } // auto-trim (the default, both call sites)
  | { kind: 'detail'; ref: string; rect: Rect; vw: number; vh: number };

export interface FilingCapture {
  /** PNG actually filed. */
  bytes: Buffer;
  /** DIP dims of the full capture. */
  frame: { w: number; h: number };
  /** Dims of what was filed. */
  out: { w: number; h: number };
  /** `cropNoteFor` output; set iff the image was cropped. */
  note?: string;
  /** Set iff a crop was attempted and refused. */
  declined?: CropDecline;
}

/**
 * Capture, and crop it to what is worth filing.
 *
 * THE UNIVERSAL FAILURE DIRECTION IS THE FULL FRAME. Every throw below is
 * caught and answered with the whole untouched capture: losing a screenshot
 * remains the worst outcome, and filing a MISLEADINGLY PARTIAL one is the
 * second worst. Nothing here may fail toward a tighter crop.
 *
 * `wc.capturePage()` stays in this file, argument-less, on a receiver
 * annotated `WebContents` — that is the keyed row in the egress inventory
 * (`test/egress.test.ts`), and its ruling ("the IMAGE never enters agent
 * context") stays true because cropping happens on the RETURNED image and
 * never through a capture rect.
 */
export async function captureForFiling(
  wc: WebContents,
  mode: CaptureMode,
): Promise<FilingCapture> {
  const img = await wc.capturePage();
  const size = img.getSize();
  const frame = { w: size.width, h: size.height };
  const full = (declined?: CropDecline): FilingCapture =>
    declined
      ? { bytes: img.toPNG(), frame, out: frame, declined }
      : { bytes: img.toPNG(), frame, out: frame };

  try {
    if (mode.kind === 'full') return full();

    let want: Rect;
    let noteRef: string | null = null;

    if (mode.kind === 'trim') {
      const raw = img.toBitmap();
      // HiDPI `toBitmap()` semantics are UNVERIFIED (docs/design/autocrop.md
      // §9). A byte length that does not round-trip is answered with the full
      // frame rather than with a guess about which representation this is.
      const scale = detectScale(raw.length, frame.w, frame.h);
      if (scale === null) return full('processing-failed');

      const bmp = {
        width: Math.round(frame.w * scale),
        height: Math.round(frame.h * scale),
        data: raw,
      };
      const trimmed = trimRect(bmp);
      if ('declined' in trimmed) return full(trimmed.declined);

      // Bitmap px back to DIP: floor the origin, ceil the extent, clamp to the
      // frame. Outward, like every other rounding in this feature.
      const [rx, ry, rw, rh] = trimmed.rect;
      const x = Math.floor(rx / scale);
      const y = Math.floor(ry / scale);
      want = [
        x,
        y,
        Math.min(Math.ceil((rx + rw) / scale) - x, frame.w - x),
        Math.min(Math.ceil((ry + rh) / scale) - y, frame.h - y),
      ];
    } else {
      const detail = detailRect(
        mode.rect,
        Math.min(mode.vw, frame.w),
        Math.min(mode.vh, frame.h),
      );
      if ('declined' in detail) return full(detail.declined);
      want = detail.rect;
      noteRef = mode.ref;
    }

    const cropped = img.crop({ x: want[0], y: want[1], width: want[2], height: want[3] });
    const got = cropped.getSize();
    // THE POST-CROP INVARIANT. This is what makes the unverified HiDPI `crop()`
    // semantics harmless: a wrong-scale crop cannot ship a wrong image, only a
    // full one.
    if (Math.abs(got.width - want[2]) > 2 || Math.abs(got.height - want[3]) > 2) {
      return full('processing-failed');
    }

    const out = { w: got.width, h: got.height };
    const note = noteRef === null
      ? cropNoteFor('trimmed', null, out.w, out.h, frame.w, frame.h)
      : cropNoteFor('detail', noteRef, out.w, out.h, frame.w, frame.h);
    return { bytes: cropped.toPNG(), frame, out, note };
  } catch {
    return full('processing-failed');
  }
}

export interface RouteOptions {
  /** URLs of all open tabs, so we can spot an open Notion page. */
  openUrls?: string[];
  /** Caption / title for the capture. */
  title?: string;
  sourceUrl?: string;
  /** Skip Notion entirely and write to disk. */
  diskOnly?: boolean;
  /** Aperture-authored crop annotation for the caption. Built ONLY by
   *  cropNoteFor — closed alphabet, never a page-authored byte. */
  cropNote?: string;
}

export async function routeCapture(
  bytes: Buffer,
  opts: RouteOptions = {},
): Promise<CaptureResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const date = stamp.slice(0, 10);
  const filename = `aperture-${stamp}.png`;
  // A cropped record can never masquerade as a full one: the note carries both
  // the filed dimensions and the frame's, so "812×334 of 1280×800" states
  // exactly how much was cut.
  const caption =
    (([opts.title, opts.sourceUrl].filter(Boolean).join(' — ') || filename) +
      (opts.cropNote ? ` · ${opts.cropNote}` : ''));

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
