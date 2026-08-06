/**
 * Screenshot autocrop — the pure core.
 *
 * Plain data in, plain data out. No Electron import of any kind, not even a
 * type one: everything here is arithmetic over a byte buffer and four numbers,
 * so it runs under vitest with no runtime and adds no row to the egress
 * inventory (docs/design/autocrop.md §6.4).
 *
 * Two modes, one failure direction.
 *
 *  · **Auto-trim** removes only rows and columns in which EVERY pixel matches
 *    the frame's own background colour within tolerance. A consent dialog, an
 *    error banner, a form — anything rendered — is non-background and is
 *    therefore inside the retained bounds. It cannot hide visible content by
 *    construction. The one thing it does remove is the fact of emptiness, and
 *    that is preserved numerically by the caption note: `812×334 of 1280×800`
 *    states exactly how much emptiness was cut.
 *  · **Detail crop** narrows to a caller-named element. It CAN hide things —
 *    that is its purpose — so the decline list lives at the call site
 *    (`src/mcp/tools.ts`) and every entry files the full untrimmed frame.
 *
 * Nothing in this file may fail toward a TIGHTER crop. Every decline, every
 * clamp and every rounding choice here points at the full frame.
 */

/** Viewport/bitmap rectangle. Structurally identical to core/snapshot's Rect;
 *  declared locally so capture/ keeps zero runtime coupling to the engine. */
export type Rect = [x: number, y: number, w: number, h: number];

/** BGRA (or RGBA — the math never names a channel), 4 bytes per pixel. */
export interface Bitmap {
  width: number;
  height: number;
  data: Buffer;
}

export type CropDecline =
  | 'no-uniform-background' // corners disagree; nothing safely trimmable
  | 'blank-frame' // no non-background pixel at all
  | 'savings-too-small' // trim would save < MIN_TRIM_SAVINGS of area
  | 'region-too-small' // detail rect < MIN_DETAIL_DIM pre-pad
  | 'region-is-frame' // detail rect >= DETAIL_FULL_FRACTION of frame
  | 'processing-failed'; // invariant failed or an exception was caught

export const TRIM_TOLERANCE = 8; // per channel, first three channels
export const TRIM_PAD = 16; // bitmap px
export const DETAIL_PAD = 16; // CSS px
export const MIN_TRIM_SAVINGS = 0.05; // fraction of frame area
export const MIN_AUTO_DIM = 64; // bitmap px, post-pad floor
export const MIN_DETAIL_DIM = 24; // CSS px, pre-pad floor
export const DETAIL_FULL_FRACTION = 0.9;

/**
 * How many bitmap pixels sit behind one DIP, or `null` if the buffer does not
 * describe an integral scaling of the frame.
 *
 * The probe machine runs display scale 1.0, where `toBitmap()` came back at
 * exactly `getSize()` × 4 bytes. What `toBitmap()` does at dpr > 1 is
 * UNVERIFIED (docs/design/autocrop.md §9). This function is what makes the
 * unknown harmless: a byte length that does not round-trip through the
 * equation yields `null`, and `null` is answered upstream with the full frame.
 * A wrong assumption degrades to a declined trim, never to corrupt math.
 */
export function detectScale(byteLength: number, w: number, h: number): number | null {
  const sf = Math.sqrt(byteLength / (4 * w * h));
  if (!(sf > 0) || !Number.isFinite(sf)) return null;
  if (Math.round(w * sf) * Math.round(h * sf) * 4 !== byteLength) return null;
  return sf;
}

/** `contentBounds` internally, with the reason it gave up. */
type BoundsResult =
  | { rect: Rect }
  | { declined: 'no-uniform-background' | 'blank-frame' | 'processing-failed' };

function channelDelta(data: Buffer, a: number, b: number): number {
  // First three channels only. The fourth is alpha and is ignored throughout —
  // naming a channel would make this file care whether the buffer is BGRA or
  // RGBA, and it deliberately does not.
  let worst = 0;
  for (let c = 0; c < 3; c += 1) {
    const d = Math.abs(data[a + c]! - data[b + c]!);
    if (d > worst) worst = d;
  }
  return worst;
}

function isBackground(data: Buffer, at: number, bg: readonly [number, number, number]): boolean {
  return (
    Math.abs(data[at]! - bg[0]) <= TRIM_TOLERANCE &&
    Math.abs(data[at + 1]! - bg[1]) <= TRIM_TOLERANCE &&
    Math.abs(data[at + 2]! - bg[2]) <= TRIM_TOLERANCE
  );
}

function computeBounds(bmp: Bitmap): BoundsResult {
  const { width: w, height: h, data } = bmp;
  // Defensive, and unreachable from `captureForFiling`, which builds the
  // Bitmap at a scale it has already round-tripped. A malformed buffer is an
  // invariant failure, which files the full frame like every other one.
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    return { declined: 'processing-failed' };
  }
  if (data.length < w * h * 4) return { declined: 'processing-failed' };

  const stride = w * 4;
  const tl = 0;
  const tr = (w - 1) * 4;
  const bl = (h - 1) * stride;
  const br = bl + tr;

  // Background candidate = the top-left corner. If any other corner disagrees,
  // there is no uniform background: full-bleed pages and content flush into a
  // corner both land here, and both correctly file the full frame.
  for (const corner of [tr, bl, br]) {
    if (channelDelta(data, tl, corner) > TRIM_TOLERANCE) {
      return { declined: 'no-uniform-background' };
    }
  }
  const bg: readonly [number, number, number] = [data[0]!, data[1]!, data[2]!];

  const rowIsBackground = (y: number): boolean => {
    const base = y * stride;
    for (let x = 0; x < w; x += 1) {
      if (!isBackground(data, base + x * 4, bg)) return false;
    }
    return true;
  };

  let top = -1;
  for (let y = 0; y < h; y += 1) {
    if (!rowIsBackground(y)) {
      top = y;
      break;
    }
  }
  if (top === -1) return { declined: 'blank-frame' };

  let bottom = top;
  for (let y = h - 1; y >= top; y -= 1) {
    if (!rowIsBackground(y)) {
      bottom = y;
      break;
    }
  }

  const columnIsBackground = (x: number): boolean => {
    for (let y = top; y <= bottom; y += 1) {
      if (!isBackground(data, y * stride + x * 4, bg)) return false;
    }
    return true;
  };

  let left = 0;
  for (let x = 0; x < w; x += 1) {
    if (!columnIsBackground(x)) {
      left = x;
      break;
    }
  }
  let right = left;
  for (let x = w - 1; x >= left; x -= 1) {
    if (!columnIsBackground(x)) {
      right = x;
      break;
    }
  }

  return { rect: [left, top, right - left + 1, bottom - top + 1] };
}

/**
 * Tight bounds of non-background content, in bitmap px, or `null` when there
 * is nothing safely trimmable (no uniform background, or a blank frame).
 */
export function contentBounds(bmp: Bitmap): Rect | null {
  const r = computeBounds(bmp);
  return 'rect' in r ? r.rect : null;
}

/**
 * Clamp the INTERVAL `[origin, origin + extent]` into `[0, limit]`.
 *
 * Interval-wise rather than origin-wise: clamping the origin to 0 and keeping
 * the extent would silently widen a rect whose padding ran off the left edge,
 * which is a crop that does not mean what the note says it means.
 */
function clampSpan(origin: number, extent: number, limit: number): [number, number] {
  const lo = Math.max(0, Math.min(origin, limit));
  const hi = Math.min(limit, origin + extent);
  return [lo, Math.max(0, hi - lo)];
}

/**
 * Grow a span to `min` about its own centre, clamped to the frame.
 *
 * Expansion rather than decline, deliberately: it is monotone TOWARD the full
 * frame and never away from it, so the floor can never cost the record a pixel
 * that was inside the content bounds.
 */
function expandToMin(origin: number, extent: number, limit: number, min: number): [number, number] {
  if (extent >= min) return [origin, extent];
  const want = Math.min(min, limit);
  if (extent >= want) return [origin, extent];
  const need = want - extent;
  let o = origin - Math.floor(need / 2);
  if (o + want > limit) o = limit - want;
  if (o < 0) o = 0;
  return [o, want];
}

/** Auto-trim: the region worth keeping, in bitmap px. */
export function trimRect(bmp: Bitmap): { rect: Rect } | { declined: CropDecline } {
  const bounds = computeBounds(bmp);
  if (!('rect' in bounds)) return { declined: bounds.declined };

  const [bx, by, bw, bh] = bounds.rect;
  let [x, w] = clampSpan(bx - TRIM_PAD, bw + TRIM_PAD * 2, bmp.width);
  let [y, h] = clampSpan(by - TRIM_PAD, bh + TRIM_PAD * 2, bmp.height);
  [x, w] = expandToMin(x, w, bmp.width, MIN_AUTO_DIM);
  [y, h] = expandToMin(y, h, bmp.height, MIN_AUTO_DIM);

  const frameArea = bmp.width * bmp.height;
  if ((frameArea - w * h) / frameArea < MIN_TRIM_SAVINGS) {
    return { declined: 'savings-too-small' };
  }
  return { rect: [x, y, w, h] };
}

/**
 * Detail crop: the padded region around a caller-named element, in CSS px.
 *
 * `vw`/`vh` are the viewport the rect was measured against, already clamped to
 * the captured frame by the caller — the returned rect is always inside it.
 */
export function detailRect(
  target: Rect,
  vw: number,
  vh: number,
): { rect: Rect } | { declined: 'region-too-small' | 'region-is-frame' } {
  if (target[2] < MIN_DETAIL_DIM || target[3] < MIN_DETAIL_DIM) {
    return { declined: 'region-too-small' };
  }

  const [x0, w0] = clampSpan(target[0] - DETAIL_PAD, target[2] + DETAIL_PAD * 2, vw);
  const [y0, h0] = clampSpan(target[1] - DETAIL_PAD, target[3] + DETAIL_PAD * 2, vh);
  if (w0 <= 0 || h0 <= 0) return { declined: 'region-too-small' };

  if (w0 * h0 >= DETAIL_FULL_FRACTION * vw * vh) return { declined: 'region-is-frame' };

  // Outward rounding: floor the origin, ceil the extent. Rounding error trims
  // LESS, never more. The re-clamp keeps the result inside the frame, which is
  // what `crop` will be handed.
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  const w = Math.min(Math.ceil(w0 + (x0 - x)), vw - x);
  const h = Math.min(Math.ceil(h0 + (y0 - y)), vh - y);
  return { rect: [x, y, w, h] };
}

/**
 * THE ONE PRODUCER OF THE CAPTION NOTE.
 *
 * `cropNote` is a new `routeCapture` option and it is NOT page-influenced. Its
 * output alphabet is closed — `/^(trimmed|detail e\d+) \d+×\d+ of \d+×\d+$/` —
 * and every byte of it comes from this function: a ref Aperture minted and
 * validated against `/^e\d+$/`, plus four integers. An element's accessible
 * name is PAGE BYTES and is deliberately not in the caption, because the
 * caption leaves the machine (docs/design/autocrop.md §6.2).
 *
 * The throw on a bad ref is deliberate. A caller that reaches this function
 * with an unvalidated ref has a bug, and the throw is caught by
 * `captureForFiling`'s catch-all into a full-frame filing — the correct
 * failure direction. A silently-sanitised note would be a wrong record.
 */
export function cropNoteFor(
  kind: 'trimmed' | 'detail',
  ref: string | null,
  w: number,
  h: number,
  fw: number,
  fh: number,
): string {
  for (const n of [w, h, fw, fh]) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('cropNoteFor: dimensions must be positive integers');
    }
  }
  if (kind === 'trimmed') {
    if (ref !== null) throw new Error('cropNoteFor: trimmed takes no ref');
    return `trimmed ${w}×${h} of ${fw}×${fh}`;
  }
  if (ref === null || !/^e\d+$/.test(ref)) {
    throw new Error('cropNoteFor: detail requires a validated eN ref');
  }
  return `detail ${ref} ${w}×${h} of ${fw}×${fh}`;
}
