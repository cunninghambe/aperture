import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DETAIL_PAD,
  MIN_AUTO_DIM,
  TRIM_PAD,
  contentBounds,
  cropNoteFor,
  detailRect,
  detectScale,
  trimRect,
  type Bitmap,
  type Rect,
} from '../src/capture/autocrop.js';

/**
 * Autocrop, at the level the feature earns (docs/design/autocrop.md §8).
 *
 * Unit coverage of the pure core, one acceptance case at the seam's math, and
 * ONE GUARD LEG over the caption channel. Not a RED-first sabotage battery:
 * no page byte gains a new route into agent context or off the machine, the
 * one new caption channel is closed-alphabet by construction, and the residual
 * risk is FILING A MISLEADING RECORD — which the decline rules and the
 * always-annotated captions address. The full battery is for mechanism classes
 * guarding credentials; spending it here would invert the proportionality the
 * security programme's own closure argued.
 */

const ROOT = join(__dirname, '..');

// --- bitmap fixtures --------------------------------------------------------

/** A solid frame. The channel order is never named — the math ignores it. */
function frame(w: number, h: number, bg: readonly [number, number, number]): Bitmap {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function paint(bmp: Bitmap, [x, y, w, h]: Rect, c: readonly [number, number, number]): Bitmap {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const at = (yy * bmp.width + xx) * 4;
      bmp.data[at] = c[0];
      bmp.data[at + 1] = c[1];
      bmp.data[at + 2] = c[2];
    }
  }
  return bmp;
}

const WHITE = [255, 255, 255] as const;
const DARK = [17, 17, 17] as const;

describe('contentBounds finds the tight bounds of what is rendered', () => {
  it('bounds a block on a light frame exactly', () => {
    const bmp = paint(frame(320, 200, WHITE), [60, 50, 80, 40], DARK);
    expect(contentBounds(bmp)).toEqual([60, 50, 80, 40]);
  });

  it('is colour-agnostic — the same block on a dark frame', () => {
    // The background is whatever the corners say it is. Nothing here knows or
    // cares which theme is rendering, which is why dark mode needed no
    // coordination with this feature.
    const bmp = paint(frame(320, 200, DARK), [60, 50, 80, 40], WHITE);
    expect(contentBounds(bmp)).toEqual([60, 50, 80, 40]);
  });

  it('does not over-trim content flush against an edge', () => {
    // Flush to the TOP edge (not a corner — a corner is the no-uniform-
    // background case below). The bound must be 0, not 1.
    const top = paint(frame(100, 80, WHITE), [40, 0, 20, 20], DARK);
    expect(contentBounds(top)).toEqual([40, 0, 20, 20]);

    // Flush to the BOTTOM edge: the bound must reach h-1.
    const bottom = paint(frame(100, 80, WHITE), [40, 60, 20, 20], DARK);
    expect(contentBounds(bottom)).toEqual([40, 60, 20, 20]);

    // Flush to the LEFT edge, mid-height, so no corner is touched.
    const left = paint(frame(100, 80, WHITE), [0, 30, 20, 20], DARK);
    expect(contentBounds(left)).toEqual([0, 30, 20, 20]);
  });

  it('tolerates a near-background pixel and keeps a just-different one', () => {
    // TRIM_TOLERANCE is 8 per channel. 255 -> 250 is background; 255 -> 240 is
    // content, and content is never trimmed.
    const soft = paint(frame(64, 64, WHITE), [10, 10, 4, 4], [250, 250, 250]);
    expect(contentBounds(soft)).toBeNull(); // nothing but background: blank frame

    const hard = paint(frame(64, 64, WHITE), [10, 10, 4, 4], [240, 240, 240]);
    expect(contentBounds(hard)).toEqual([10, 10, 4, 4]);
  });
});

describe('contentBounds declines rather than guessing', () => {
  it('refuses when the corners disagree — no uniform background', () => {
    // A full-bleed page, and content flush INTO a corner, both land here, and
    // both correctly file the full frame.
    const bmp = paint(frame(100, 80, WHITE), [0, 0, 5, 5], DARK);
    expect(contentBounds(bmp)).toBeNull();
    expect(trimRect(bmp)).toEqual({ declined: 'no-uniform-background' });
  });

  it('refuses a frame with nothing on it', () => {
    const bmp = frame(100, 80, WHITE);
    expect(contentBounds(bmp)).toBeNull();
    expect(trimRect(bmp)).toEqual({ declined: 'blank-frame' });
  });
});

describe('trimRect — the seam\'s math, end to end', () => {
  it('pads the tight bounds and keeps the result when the saving is real', () => {
    // The acceptance case. 320x200 white, an 80x40 block at (60, 50):
    // tight bounds [60,50,80,40] + TRIM_PAD on each side = [44,34,112,72],
    // both axes already over MIN_AUTO_DIM, savings ~87%.
    const bmp = paint(frame(320, 200, WHITE), [60, 50, 80, 40], DARK);
    const r = trimRect(bmp);
    expect(r).toEqual({ rect: [44, 34, 112, 72] });

    const rect = (r as { rect: Rect }).rect;
    expect(rect[0]).toBe(60 - TRIM_PAD);
    const saved = (320 * 200 - rect[2] * rect[3]) / (320 * 200);
    expect(saved).toBeGreaterThan(0.85);
  });

  it('declines when the padded rect is the frame', () => {
    // 120x80 frame, a 100x60 block at (8,8). Padding runs off every edge, the
    // clamp lands on the full frame, and a "trim" that saves nothing is not a
    // trim. Silent: the full frame is filed and the absence of a note is the
    // honest record.
    const bmp = paint(frame(120, 80, WHITE), [8, 8, 100, 60], DARK);
    expect(trimRect(bmp)).toEqual({ declined: 'savings-too-small' });
  });

  it('expands a tiny region to the floor rather than declining', () => {
    // Expansion is monotone TOWARD the full frame and never away from it, so
    // the floor can never cost the record a pixel that was inside the bounds.
    const bmp = paint(frame(320, 200, WHITE), [155, 95, 10, 10], DARK);
    const r = trimRect(bmp) as { rect: Rect };
    expect(r.rect).toEqual([128, 68, MIN_AUTO_DIM, MIN_AUTO_DIM]);
    // Still centred on the content, and still inside the frame.
    expect(r.rect[0] + r.rect[2] / 2).toBe(160);
    expect(r.rect[1] + r.rect[3] / 2).toBe(100);
  });

  it('clamps the floor to a frame smaller than it', () => {
    // MIN_AUTO_DIM is 64; the frame is 40 wide. Expansion clamps, it does not
    // produce a rect outside the image.
    const bmp = paint(frame(40, 200, WHITE), [18, 95, 4, 4], DARK);
    const r = trimRect(bmp) as { rect: Rect };
    expect(r.rect[0]).toBe(0);
    expect(r.rect[2]).toBe(40);
    expect(r.rect[1] + r.rect[3]).toBeLessThanOrEqual(200);
  });
});

describe('detectScale is what makes an unverified HiDPI assumption harmless', () => {
  it('is exact at scale 1.0 — the probed case', () => {
    expect(detectScale(4 * 100 * 80, 100, 80)).toBe(1);
  });

  it('accepts a buffer that genuinely round-trips at 2x', () => {
    expect(detectScale(4 * 200 * 160, 100, 80)).toBe(2);
  });

  it('refuses a length that implies a scale the dimensions cannot reproduce', () => {
    // 101x80 at 1.25 rounds to 126x100 = 50400 bytes, not the 50500 a naive
    // 1.25 would predict. The round-trip equation catches it and the caller
    // files the full frame — degraded, disclosed, safe.
    expect(detectScale(50500, 101, 80)).toBeNull();
  });

  it('refuses a length that is not four bytes per pixel', () => {
    expect(detectScale(4 * 100 * 80 + 1, 100, 80)).toBeNull();
    expect(detectScale(0, 100, 80)).toBeNull();
    expect(detectScale(4 * 100 * 80, 0, 80)).toBeNull();
  });
});

describe('detailRect', () => {
  it('pads and clamps exactly', () => {
    expect(detailRect([100, 100, 50, 40], 800, 600)).toEqual({
      rect: [100 - DETAIL_PAD, 100 - DETAIL_PAD, 50 + DETAIL_PAD * 2, 40 + DETAIL_PAD * 2],
    });
    // Padding that runs off the top-left clamps to the frame rather than
    // widening the far side.
    expect(detailRect([4, 4, 60, 60], 800, 600)).toEqual({ rect: [0, 0, 80, 80] });
  });

  it('refuses a target too small to be a real detail shot', () => {
    expect(detailRect([100, 100, 20, 40], 800, 600)).toEqual({ declined: 'region-too-small' });
    expect(detailRect([100, 100, 40, 23], 800, 600)).toEqual({ declined: 'region-too-small' });
    // Entirely outside the viewport: the padded rect clamps to nothing.
    expect(detailRect([900, 100, 50, 50], 800, 600)).toEqual({ declined: 'region-too-small' });
  });

  it('refuses a target that is effectively the frame', () => {
    expect(detailRect([0, 0, 780, 580], 800, 600)).toEqual({ declined: 'region-is-frame' });
  });

  it('rounds outward, so rounding error trims less and never more', () => {
    const r = detailRect([110.4, 20.6, 50.2, 40.3], 800, 600) as { rect: Rect };
    expect(r.rect).toEqual([94, 4, 83, 73]);
    // The property the numbers exist for: the integer rect COVERS the padded
    // real-valued one on all four sides.
    expect(r.rect[0]).toBeLessThanOrEqual(110.4 - DETAIL_PAD);
    expect(r.rect[1]).toBeLessThanOrEqual(20.6 - DETAIL_PAD);
    expect(r.rect[0] + r.rect[2]).toBeGreaterThanOrEqual(110.4 + 50.2 + DETAIL_PAD);
    expect(r.rect[1] + r.rect[3]).toBeGreaterThanOrEqual(20.6 + 40.3 + DETAIL_PAD);
  });
});

describe('cropNoteFor — the caption channel is a closed alphabet', () => {
  const CLOSED = /^(trimmed|detail e\d+) \d+×\d+ of \d+×\d+$/;

  it('every non-throwing output matches the closed alphabet', () => {
    // A property over a sweep, not three examples. This is the assertion that
    // makes "no page-authored byte can reach the Notion caption through this
    // channel" a test rather than a review note.
    for (const w of [1, 7, 64, 812, 3840]) {
      for (const h of [1, 9, 334, 2160]) {
        expect(cropNoteFor('trimmed', null, w, h, 3840, 2160)).toMatch(CLOSED);
        for (const ref of ['e0', 'e1', 'e42', 'e1000000']) {
          expect(cropNoteFor('detail', ref, w, h, 3840, 2160)).toMatch(CLOSED);
        }
      }
    }
  });

  it('says exactly what was cut, and of what', () => {
    expect(cropNoteFor('trimmed', null, 812, 334, 1280, 800)).toBe('trimmed 812×334 of 1280×800');
    expect(cropNoteFor('detail', 'e7', 240, 96, 1280, 800)).toBe('detail e7 240×96 of 1280×800');
  });

  it('throws on a ref that is not Aperture-minted', () => {
    // A caller that gets here with an unvalidated ref has a bug, and the throw
    // is caught by captureForFiling into a full-frame filing — the correct
    // failure direction. A silently sanitised note would be a wrong record.
    for (const bad of ['x', 'e1"', '', 'e1 e2', 'E1', 'e', 'e1\n', 'e-1', '1', 'e١']) {
      expect(() => cropNoteFor('detail', bad, 10, 10, 20, 20), bad).toThrow();
    }
    expect(() => cropNoteFor('detail', null, 10, 10, 20, 20)).toThrow();
    // And the trimmed form takes no ref at all.
    expect(() => cropNoteFor('trimmed', 'e1', 10, 10, 20, 20)).toThrow();
  });

  it('throws on a dimension that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => cropNoteFor('trimmed', null, bad, 10, 20, 20), `w=${bad}`).toThrow();
      expect(() => cropNoteFor('trimmed', null, 10, bad, 20, 20), `h=${bad}`).toThrow();
      expect(() => cropNoteFor('trimmed', null, 10, 10, bad, 20), `fw=${bad}`).toThrow();
      expect(() => cropNoteFor('trimmed', null, 10, 10, 20, bad), `fh=${bad}`).toThrow();
    }
  });
});

// --- the one guard leg ------------------------------------------------------

/**
 * Source-reading, on the `urlsurfaces.test.ts` / `docs.test.ts` precedent:
 * assert over the text when the property lives in the text.
 *
 * The property: the caption channel has ONE PRODUCER and one spelling. Together
 * with the closed-alphabet property above, that pins the whole channel — a
 * reviewer never has to notice a third spelling, because a third spelling is
 * RED here.
 */
function filesUnder(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, ext));
    else if (p.endsWith(ext) && statSync(p).isFile()) out.push(p);
  }
  return out;
}

/** The file with its PROSE removed — same conservative strip as urlsurfaces. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const SOURCES = filesUnder(join(ROOT, 'src'), '.ts').map((path) => ({
  rel: path.slice(ROOT.length + 1).replace(/\\/g, '/'),
  code: code(readFileSync(path, 'utf8')),
}));

describe('the caption channel has one producer and one spelling', () => {
  it('cropNote is written at the two routeCapture call sites and nowhere else', () => {
    const sites = SOURCES.filter((f) => /\bcropNote\s*\??\s*:/.test(f.code));
    expect(
      sites.map((f) => f.rel).sort(),
      'cropNote belongs to capture.ts (which declares it) and the two capture ' +
        'call sites (which pass it). A third file writing it is a second ' +
        'caption producer, which is the thing this leg exists to prevent.',
    ).toEqual(['src/capture/capture.ts', 'src/main/ipc.ts', 'src/mcp/tools.ts']);

    for (const f of sites) {
      const occurrences = [...f.code.matchAll(/\bcropNote\s*\??\s*:[^\n]*/g)].map((m) =>
        m[0].trim(),
      );
      if (f.rel === 'src/capture/capture.ts') {
        expect(occurrences, 'capture.ts declares the option and never writes it').toEqual([
          'cropNote?: string;',
        ]);
      } else {
        expect(
          occurrences,
          `${f.rel}: the note must be passed through verbatim from captureForFiling. ` +
            'Any other expression here is a second producer of the caption ' +
            'annotation and is outside the closed alphabet.',
        ).toEqual(['cropNote: cap.note,']);
      }
    }
  });

  it('cropNoteFor is defined and called in capture/ and nowhere else', () => {
    const users = SOURCES.filter((f) => /cropNoteFor\(/.test(f.code)).map((f) => f.rel).sort();
    expect(
      users,
      'The note has exactly one producer: autocrop.ts defines cropNoteFor and ' +
        'capture.ts calls it. A third caller is a byte reaching the Notion ' +
        'caption by a route the closed-alphabet property does not cover.',
    ).toEqual(['src/capture/autocrop.ts', 'src/capture/capture.ts']);
  });

  it('both capture call sites default to auto-trim', () => {
    // The human's button and the agent's default are the same framing on the
    // same page state. The one asymmetry is the agent's `crop` parameter, and
    // it is visible in the transcript.
    const ipc = SOURCES.find((f) => f.rel === 'src/main/ipc.ts')!;
    const tools = SOURCES.find((f) => f.rel === 'src/mcp/tools.ts')!;
    expect(ipc.code).toMatch(/captureForFiling\([^;]*\{\s*kind:\s*'trim'\s*\}/);
    expect(tools.code).toMatch(/kind:\s*'trim'/);
    // And the removed export stays removed, so a forgotten caller is a compile
    // error rather than a silent behaviour change.
    expect(SOURCES.filter((f) => /\bcapturePage\b/.test(f.code)).map((f) => f.rel)).toEqual([
      'src/capture/capture.ts',
    ]);
  });
});
