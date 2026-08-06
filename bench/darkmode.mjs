/**
 * Dark-mode contrast bench — WCAG ratios recomputed from PAINTED PIXELS.
 *
 * `docs/design/darkmode-contrast.md` §6. The report was "some text is
 * unreadable"; the diagnosis measured 1.21:1 to 2.40:1 on ordinary web widgets
 * under Chromium's force-dark. This file is the durable form of that
 * measurement, so the claim survives an Electron upgrade that moves Blink's
 * classifier constants.
 *
 * WHY PIXELS AND NOT STYLESHEETS. Force-dark rewrites colours at paint time.
 * `getComputedStyle` still reports the authored values and is blind to the
 * entire defect class — a static audit of these fixtures reports every patch
 * passing while the screen shows light-grey text on a light-grey badge. So the
 * instrument is a CDP screenshot of the tab target, sampled at points the page
 * itself supplies: the centre of a run of U+2588 FULL BLOCK (a solid rectangle
 * of pure painted text colour, median-of-9 to kill antialiasing) for the
 * foreground, and a text-free patch corner for the background.
 *
 * THE BAR. `REQ = min(4.5, max(0.8 × authored, min(3.0, authored)))`. Relative
 * rather than flat because darkening is not contrast-preserving in WCAG terms
 * — pure inversion takes an authored 4.83 to about 3.9 — and a flat 4.5 would
 * fail surfaces whose authors never cleared 4.5 in the first place. What the
 * bench forbids is darkening DESTROYING usable contrast, which is what the
 * report was about. The floor is the AUTHORED ratio rather than a flat 3.0 for
 * the same reason the ceiling is not flat: see `req` for the row that proved
 * the difference.
 *
 * Usage:
 *   node bench/darkmode.mjs            # starts and stops its own Aperture
 *   npm run bench:darkmode
 * Exit: 0 all rounds green · 1 a round is red · 3 the bench could not run
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { APERTURE_PORT, killTree, portIsOpen, startAperture } from './lib/aperture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(ROOT, 'bench', 'fixtures', 'darkmode');
const FIXTURE_PORT = 8991;
const FIXTURE_BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const CDP_PORT = 9333;

// ---------------------------------------------------------------------------
// THE ARTIFACT THIS RUN IS ABOUT — refuse a stale one, and name it.
//
// Same rule, same reason, as bench/guards.mjs: a green run against a build that
// predates the fix is byte-identical to a green run against the right one, so
// nothing in the output can be read as evidence either way. This bench is
// RED-FIRST by construction (§6.2 records exactly what it must say before the
// fix), which makes a stale artifact worse than useless here — it would report
// the red set as still red, or the green set as already green, and either way
// the operator would draw the wrong conclusion.
// ---------------------------------------------------------------------------
const ARTIFACT = join(ROOT, 'out', 'main', 'index.js');
let ARTIFACT_HASH = '(unhashed)';
{
  let built;
  try {
    built = statSync(ARTIFACT);
  } catch {
    console.error(
      `REFUSING TO RUN: ${relative(ROOT, ARTIFACT)} does not exist.\n` +
        'Run `npx electron-vite build` first — there is nothing to measure.',
    );
    process.exit(3);
  }
  const newestUnder = (dir) => {
    let newest = { path: dir, mtimeMs: 0 };
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const hit = e.isDirectory() ? newestUnder(p) : { path: p, mtimeMs: statSync(p).mtimeMs };
      if (hit.mtimeMs > newest.mtimeMs) newest = hit;
    }
    return newest;
  };
  const newest = newestUnder(join(ROOT, 'src'));
  if (newest.mtimeMs > built.mtimeMs) {
    console.error(
      'REFUSING TO RUN: the built artifact is older than the source.\n' +
        `  ${relative(ROOT, ARTIFACT)}  built ${new Date(built.mtimeMs).toISOString()}\n` +
        `  ${relative(ROOT, newest.path)}  edited ${new Date(newest.mtimeMs).toISOString()}\n` +
        'Every ratio below would have been measured against code that is not on ' +
        'disk any more. Run `npx electron-vite build` and run this again.',
    );
    process.exit(3);
  }
  ARTIFACT_HASH = createHash('sha256').update(readFileSync(ARTIFACT)).digest('hex');
  console.log(
    `artifact  ${relative(ROOT, ARTIFACT).replace(/\\/g, '/')}\n` +
      `          sha256 ${ARTIFACT_HASH}  built ${new Date(built.mtimeMs).toISOString()}\n`,
  );
}

// ---------------------------------------------------------------------------
// Colour: WCAG 2.x relative luminance, and Blink's Rec.601 luma for the band.
// ---------------------------------------------------------------------------
const chan = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const relLum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
const contrast = (a, b) => {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const hexToRgb = (h) => {
  const s = h.replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const rgbToHex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const near = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/**
 * The acceptance bound. §6.1 — relative, not flat, and clamped at both ends.
 *
 * THE FLOOR IS THE AUTHORED RATIO, NOT A FLAT 3.0 (corrected 2026-08-06).
 * The bound was `min(4.5, max(3.0, 0.8 × authored))`, whose `max(3.0, …)` leg
 * demanded 3.0 from EVERY surface — including surfaces whose author never
 * reached 3.0. That contradicts the sentence §6.1 states as this bound's own
 * reason: *never holds a surface to a bar its author didn't clear.* The row
 * that exposed it is `fg-aaa/fff`, authored 2.32: inversion IMPROVED it to
 * 2.82 and the old bound failed it anyway, for the offence of having been
 * low-contrast in the source. That is a defect the page shipped, not damage
 * the darkening did, and this bench measures the darkening.
 *
 * So the floor is `min(3.0, authored)`: never demand more than the author
 * shipped, while still demanding the full 0.8× wherever the author did clear
 * 3.0. Above authored 3.75 the `0.8 ×` leg dominates and nothing changes; the
 * only rows that move are those authored below 3.0, which are now required to
 * come out no worse than they went in.
 */
const req = (authored) =>
  Math.min(4.5, Math.max(0.8 * authored, Math.min(3.0, authored)));

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '  n/a');

// ---------------------------------------------------------------------------
// PNG. Chromium's screenshots are 8-bit, non-interlaced; that is all this
// decodes, and it says so rather than guessing when handed anything else.
// ---------------------------------------------------------------------------
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('unsupported interlaced PNG');
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!chans) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * chans;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= chans ? cur[i - chans] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= chans ? prev[i - chans] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  const px = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const i = y * stride + x * chans;
    if (colorType === 0 || colorType === 4) return [out[i], out[i], out[i]];
    if (colorType === 3) {
      const p = out[i] * 3;
      return [palette[p], palette[p + 1], palette[p + 2]];
    }
    return [out[i], out[i + 1], out[i + 2]];
  };
  return { w, h, px };
}

/** Median-of-9: a 3×3 device-pixel neighbourhood, per channel. §1. */
function sample(img, x, y) {
  const got = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const p = img.px(x + dx, y + dy);
      if (p) got.push(p);
    }
  }
  if (!got.length) return null;
  return [0, 1, 2].map((c) => got.map((p) => p[c]).sort((a, b) => a - b)[got.length >> 1]);
}

/** Vacuity guard: a capture that measured nothing prints no verdict. */
function distinctColours(img, cap = 64) {
  const seen = new Set();
  const sx = Math.max(1, Math.floor(img.w / 120));
  const sy = Math.max(1, Math.floor(img.h / 120));
  for (let y = 0; y < img.h; y += sy) {
    for (let x = 0; x < img.w; x += sx) {
      seen.add(img.px(x, y).join(','));
      if (seen.size >= cap) return seen.size;
    }
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// CDP. The tab target is the only place painted pixels exist.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_r, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  static async open(wsUrl) {
    const c = new Cdp();
    c.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      c.#ws.addEventListener('open', res, { once: true });
      c.#ws.addEventListener('error', () => rej(new Error(`CDP connect failed: ${wsUrl}`)), { once: true });
    });
    c.#ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = c.#pending.get(msg.id);
      if (!p) return;
      c.#pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${msg.error.message ?? 'CDP error'}`));
      else p.res(msg.result);
    });
    return c;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.#pending.delete(id);
        rej(e);
      }
    });
  }

  async evaluate(expression) {
    const r = await withTimeout(
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      8000,
      'Runtime.evaluate',
    );
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }

  /**
   * CDP screenshots on this build are flaky — roughly half of first calls hang
   * (measured). Three attempts behind an 8s timeout each. A RETRY, not a
   * tolerance change: the numbers the retry returns are the same numbers.
   */
  async screenshot() {
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await withTimeout(
          this.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
          8000,
          'Page.captureScreenshot',
        );
        return decodePng(Buffer.from(r.data, 'base64'));
      } catch (e) {
        last = e;
        await sleep(400);
      }
    }
    throw last;
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
    signal: AbortSignal.timeout(5000),
  });
  return await res.json();
}

/** The one target whose url matches, waited for rather than assumed present. */
async function targetFor(match, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const list = await targets();
      seen = list.map((t) => t.url);
      const hit = list.find((t) => t.webSocketDebuggerUrl && match(t.url ?? ''));
      if (hit) return hit;
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
  }
  throw new Error(
    `no CDP target matched${lastErr ? ` (last: ${lastErr.message})` : ''}. saw:\n  ${seen.join('\n  ')}`,
  );
}

/**
 * Is the Aperture on 8817 the one THIS bench started?
 *
 * `startAperture` returns as soon as the token in %APPDATA% answers on 8817 —
 * and that token belongs to whichever Aperture is listening, not necessarily to
 * the child just spawned. This tree runs several benches at once; a child that
 * loses the port race dies with EADDRINUSE while its parent happily proceeds to
 * measure SOMEBODY ELSE'S browser. That happened, and it presents as an
 * unrelated CDP failure three rounds later. `--remote-debugging-port` is the
 * discriminator: no other launcher in this repo passes it, so a live CDP
 * endpoint plus a live child is proof of ownership.
 */
async function assertOwnAperture(child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(
    `the Aperture answering on ${APERTURE_PORT} is NOT the one this bench started ` +
      `— nothing is listening on the CDP port ${CDP_PORT}` +
      (child.exitCode !== null ? ` and the child exited with code ${child.exitCode}` : '') +
      '.\nAnother Aperture (another bench, or a hand-started one) owns the port. ' +
      'Wait for it to finish and run this again.',
  );
}

// ---------------------------------------------------------------------------
// MCP — theme and site policy are driven through the agent-facing tool, exactly
// as an agent would drive them. The tool surface is unchanged by this work.
// ---------------------------------------------------------------------------
let TOKEN = '';
let rpcId = 0;
async function mcp(name, args = {}) {
  const res = await fetch(`http://127.0.0.1:${APERTURE_PORT}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await res.text();
  const line = body.split('\n').find((l) => l.trim().startsWith('{') || l.startsWith('data: {'));
  if (!line) return '';
  const json = JSON.parse(line.replace(/^data: /, ''));
  return json.result?.content?.[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// Rounds.
// ---------------------------------------------------------------------------
const rounds = [];
function record(id, what, ok, rows, notes = []) {
  rounds.push({ id, what, ok, rows, notes });
}

/** Navigate the tab and read every patch's painted pair. */
async function measureFixture(file, expectPatches) {
  await mcp('browser_navigate', { action: 'goto', url: `${FIXTURE_BASE}/${file}` });
  // The policy loop's late pass runs at dom-ready and again at
  // did-stop-loading; measuring before it lands would measure the preseed.
  await sleep(1800);

  const t = await targetFor((u) => u.includes(`/${file}`));
  const cdp = await Cdp.open(t.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable').catch(() => {});
    const dpr = await cdp.evaluate('window.devicePixelRatio');
    const patches = await cdp.evaluate('window.__patches ? window.__patches() : null');
    if (!Array.isArray(patches)) throw new Error(`${file}: window.__patches() is missing`);
    if (patches.length !== expectPatches) {
      throw new Error(
        `${file}: expected ${expectPatches} patches, the page produced ${patches.length}`,
      );
    }
    const img = await cdp.screenshot();
    const colours = distinctColours(img);
    if (colours < 4) {
      throw new Error(
        `${file}: the screenshot is monochrome (${colours} distinct colours in ` +
          `${img.w}×${img.h}) — nothing was measured`,
      );
    }
    const out = [];
    for (const p of patches) {
      const fg = sample(img, Math.round(p.glyph.x * dpr), Math.round(p.glyph.y * dpr));
      const bg = sample(img, Math.round(p.corner.x * dpr), Math.round(p.corner.y * dpr));
      if (!fg || !bg) throw new Error(`${file}: patch ${p.name} sampled outside the capture`);
      out.push({
        name: p.name,
        authoredFg: hexToRgb(p.fg),
        authoredBg: hexToRgb(p.bg),
        authored: contrast(hexToRgb(p.fg), hexToRgb(p.bg)),
        paintedFg: fg,
        paintedBg: bg,
        painted: contrast(fg, bg),
      });
    }
    // Sampling integrity: an authored pair that differs cannot paint as one
    // colour unless the probe missed the glyph. That is a broken instrument,
    // not a contrast finding, and must not be reported as one.
    const collapsed = out.filter(
      (r) => !near(r.authoredFg, r.authoredBg, 0) && near(r.paintedFg, r.paintedBg, 0),
    );
    if (collapsed.length) {
      throw new Error(
        `${file}: the glyph probe missed on ${collapsed.length} patch(es) ` +
          `(${collapsed.map((r) => r.name).join(', ')}) — painted fg == painted bg exactly`,
      );
    }
    return { rows: out, dpr, img };
  } finally {
    cdp.close();
  }
}

function printTable(rows, mode) {
  const head =
    mode === 'req'
      ? '| patch | authored | REQ | painted fg/bg | painted | verdict |'
      : '| patch | authored fg/bg | painted fg/bg | verdict |';
  console.log(head);
  console.log(mode === 'req' ? '|---|---|---|---|---|---|' : '|---|---|---|---|');
  for (const r of rows) {
    if (mode === 'req') {
      console.log(
        `| ${r.name} | ${f2(r.authored)} | ${f2(req(r.authored))} | ` +
          `${rgbToHex(r.paintedFg)}/${rgbToHex(r.paintedBg)} | **${f2(r.painted)}** | ` +
          `${r.painted >= req(r.authored) - 1e-9 ? 'ok' : 'RED'} |`,
      );
    } else {
      const same = near(r.paintedFg, r.authoredFg) && near(r.paintedBg, r.authoredBg);
      console.log(
        `| ${r.name} | ${rgbToHex(r.authoredFg)}/${rgbToHex(r.authoredBg)} | ` +
          `${rgbToHex(r.paintedFg)}/${rgbToHex(r.paintedBg)} | ${same ? 'ok' : 'RED'} |`,
      );
    }
  }
}

// --- R6: Aperture's own windows --------------------------------------------
//
// A computed-style walk, which is valid HERE and nowhere else in this file:
// force-dark does not repaint the already-dark chrome (its colours sit outside
// both classifier thresholds), so authored == painted. That is an assumption,
// so it is CHECKED — the screenshot cross-check below fails the round if any
// audited background paints differently from its computed value.
const AUDIT_WALK = `(() => {
  const parse = (c) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/.exec(c || '');
    if (!m) return null;
    return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : parseFloat(m[4]) };
  };
  /**
   * The background as the compositor paints it, alpha composited.
   *
   * Walking PAST a semi-transparent fill to the first opaque ancestor reports a
   * colour that is never on screen, and here that is the whole finding: every
   * input in Aperture is \`#00000040\` over its container, so the omnibox's real
   * background is #17171b rather than the toolbar's #1e1e24, and the vault's is
   * #111114 rather than #16161a. Those are the two backgrounds the placeholder
   * rows are measured against.
   */
  const bgOf = (el) => {
    const stack = [];
    let n = el;
    while (n) {
      const p = parse(getComputedStyle(n).backgroundColor);
      if (p && p.a > 0) {
        stack.push(p);
        if (p.a >= 0.999) break;
      }
      n = n.parentElement;
    }
    let out = stack.length && stack[stack.length - 1].a >= 0.999
      ? stack.pop().rgb
      : [255, 255, 255];
    while (stack.length) {
      const p = stack.pop();
      out = [0, 1, 2].map((i) => Math.round(p.rgb[i] * p.a + out[i] * (1 - p.a)));
    }
    return out;
  };
  const opacityOf = (el) => {
    let o = 1, n = el;
    while (n) { o *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement; }
    return o;
  };
  const label = (el) => (el.id ? '#' + el.id : el.className ? el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] : el.tagName.toLowerCase());
  const textRects = (el) => {
    const out = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const q of r.getClientRects()) out.push({ l: q.left, t: q.top, r: q.right, b: q.bottom });
    }
    return out;
  };
  /**
   * A point inside \`el\` that no text of its own covers, or null.
   *
   * Inset past the BORDER, not just past the padding edge: a probe on a 1px
   * focus border reads the accent colour and reports the fill as repainted,
   * which is a false positive about force-dark and not a measurement. The
   * vertical-centre candidates come first because they are the ones a large
   * border-radius cannot clip.
   */
  const emptyPoint = (el, rect) => {
    const tr = textRects(el);
    const cs2 = getComputedStyle(el);
    const w = (s) => (parseFloat(s) || 0) + 4;
    const bl = w(cs2.borderLeftWidth), br = w(cs2.borderRightWidth);
    const bt = w(cs2.borderTopWidth), bb = w(cs2.borderBottomWidth);
    const cy = rect.top + rect.height / 2;
    const cands = [
      [rect.right - br, cy], [rect.left + bl, cy],
      [rect.left + rect.width / 2, rect.bottom - bb],
      [rect.right - br, rect.bottom - bb], [rect.left + bl, rect.top + bt],
    ];
    for (const [x, y] of cands) {
      if (tr.some((q) => x >= q.l - 1 && x <= q.r + 1 && y >= q.t - 1 && y <= q.b + 1)) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit === el) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  };

  const rows = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) continue;
    if (rect.bottom <= 0 || rect.right <= 0) continue;
    const op = opacityOf(el);
    const disabled = (el.matches && el.matches(':disabled')) || !!el.closest('[disabled]');
    const exempt = disabled ? 'disabled' : (op === 0 ? 'opacity:0 hover-reveal' : null);
    const bg = bgOf(el);
    const own = [].slice.call(el.childNodes)
      .filter((n) => n.nodeType === 3 && n.textContent.trim())
      .map((n) => n.textContent.trim()).join(' ');
    if (own) {
      const fg = parse(cs.color);
      if (fg) rows.push({
        what: label(el), kind: 'text', text: own.slice(0, 32),
        fg: fg.rgb, fgAlpha: fg.a, bg, exempt,
        probe: emptyPoint(el, rect),
      });
    }
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) {
      const p = parse(getComputedStyle(el, '::placeholder').color);
      if (p) rows.push({
        what: label(el) + '::placeholder', kind: 'placeholder', text: ph.slice(0, 32),
        fg: p.rgb, fgAlpha: p.a, bg, exempt,
        probe: emptyPoint(el, rect),
      });
    }
  }
  return { rows, colorScheme: getComputedStyle(document.documentElement).colorScheme };
})()`;

async function auditWindow(name, match) {
  const t = await targetFor(match);
  const cdp = await Cdp.open(t.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable').catch(() => {});
    const dpr = await cdp.evaluate('window.devicePixelRatio');
    const walk = await cdp.evaluate(AUDIT_WALK);
    const rows = walk.rows;
    if (rows.length < 6) {
      throw new Error(`${name}: the audit walk produced only ${rows.length} rows (needs ≥ 6)`);
    }

    // The cross-check. If any audited background paints differently from its
    // computed value, force-dark IS repainting this window and the whole walk
    // is invalid — that is a failure of the instrument's premise, not a pass.
    let img = null;
    let crossChecked = 0;
    let crossFailed = [];
    try {
      img = await cdp.screenshot();
    } catch (e) {
      crossFailed.push(`screenshot unavailable: ${e.message}`);
    }
    if (img) {
      const colours = distinctColours(img);
      if (colours < 4) {
        crossFailed.push(`the ${name} capture is monochrome (${colours} colours) — not a cross-check`);
        img = null;
      }
    }
    if (img) {
      for (const r of rows) {
        if (crossChecked >= 8) break;
        if (!r.probe) continue;
        const got = sample(img, Math.round(r.probe.x * dpr), Math.round(r.probe.y * dpr));
        if (!got) continue;
        crossChecked++;
        if (!near(got, r.bg, 3)) {
          crossFailed.push(
            `${r.what}: computed bg ${rgbToHex(r.bg)} paints as ${rgbToHex(got)} — ` +
              'the computed-style walk is not valid on this window',
          );
        }
      }
      if (crossChecked < 3) crossFailed.push(`only ${crossChecked} background(s) could be cross-checked`);
    }

    return { name, rows, colorScheme: walk.colorScheme, crossChecked, crossFailed };
  } finally {
    cdp.close();
  }
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
async function main() {
  if (await portIsOpen(APERTURE_PORT)) {
    console.error(
      `REFUSING TO RUN: something is already listening on ${APERTURE_PORT}.\n` +
        'This bench starts and owns its own Aperture. Run: taskkill //F //IM electron.exe',
    );
    process.exit(3);
  }

  const mime = { '.html': 'text/html; charset=utf-8' };
  const server = createServer(async (req, res) => {
    const p = (req.url || '/').split('?')[0];
    try {
      // `Cache-Control: no-store` is not decoration: Electron caches fixture
      // responses, and a run against a stale fixture measures a page nobody is
      // looking at while printing a verdict about the one on disk.
      const body = readFileSync(join(FIXTURE_DIR, p.replace(/^\/+/, '') || 'light.html'));
      res.writeHead(200, {
        'content-type': mime[extname(p)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(FIXTURE_PORT, '127.0.0.1', r));
  console.log(`fixtures  ${FIXTURE_BASE}  (from ${relative(ROOT, FIXTURE_DIR).replace(/\\/g, '/')})\n`);

  let ap = null;
  try {
    ap = await startAperture({ root: ROOT, args: [`--remote-debugging-port=${CDP_PORT}`] });
    TOKEN = ap.token;
    await assertOwnAperture(ap.child);
    await sleep(2500);

    // ---- R1 -------------------------------------------------------------
    // Theme dark is the startup default (`applyDarkMode('dark')`), so this is a
    // PLAIN navigation: no tool call has touched this tab or this origin.
    console.log('\n## R1 — theme dark, light.html, plain navigation\n');
    {
      const { rows } = await measureFixture('light.html', 30);
      printTable(rows, 'req');
      const bad = rows.filter((r) => r.painted < req(r.authored) - 1e-9);
      record('R1', 'plain light page under force-dark', bad.length === 0, rows,
        bad.map((r) => `${r.name} ${f2(r.painted)} < REQ ${f2(req(r.authored))}`));
    }

    // ---- R2 -------------------------------------------------------------
    // NO `browser_theme` CALL HAS HAPPENED YET, and that is the whole point:
    // the auto-skip protection has to run from navigation, not from the tool.
    console.log('\n## R2 — theme dark, darknative.html, plain navigation (no browser_theme first)\n');
    {
      const { rows } = await measureFixture('darknative.html', 7);
      printTable(rows, 'req');
      const bad = rows.filter((r) => r.painted < req(r.authored) - 1e-9);
      const darkPatches = rows.filter((r) => ['dk-body-text', 'dk-dim-text', 'dk-card'].includes(r.name));
      const notEqual = darkPatches.filter(
        (r) => !(near(r.paintedFg, r.authoredFg) && near(r.paintedBg, r.authoredBg)),
      );
      if (darkPatches.length !== 3) throw new Error('R2: the three dk-* dark patches are missing');
      console.log('\nequality leg (the page\'s own dark surfaces, untouched):');
      printTable(darkPatches, 'equal');
      record('R2', 'dark-native page, auto-skip from navigation',
        bad.length === 0 && notEqual.length === 0, rows,
        [
          ...bad.map((r) => `${r.name} ${f2(r.painted)} < REQ ${f2(req(r.authored))}`),
          ...notEqual.map(
            (r) => `${r.name} painted ${rgbToHex(r.paintedFg)}/${rgbToHex(r.paintedBg)} ` +
              `≠ authored ${rgbToHex(r.authoredFg)}/${rgbToHex(r.authoredBg)}`,
          ),
        ]);
    }

    // ---- R3 -------------------------------------------------------------
    console.log('\n## R3 — theme dark, darkscheme.html (the page ships its own dark theme)\n');
    {
      const { rows } = await measureFixture('darkscheme.html', 1);
      printTable(rows, 'equal');
      const r = rows[0];
      const want = { fg: hexToRgb('#d5d5da'), bg: hexToRgb('#232329') };
      const ok = near(r.paintedFg, want.fg) && near(r.paintedBg, want.bg);
      record('R3', 'color-scheme page renders its own palette', ok, rows,
        ok ? [] : [`painted ${rgbToHex(r.paintedFg)}/${rgbToHex(r.paintedBg)} ≠ #d5d5da/#232329`]);
    }

    // ---- R4 -------------------------------------------------------------
    console.log('\n## R4 — browser_theme{mode:light}, then a fresh navigation of light.html\n');
    {
      const said = await mcp('browser_theme', { mode: 'light' });
      console.log('browser_theme said:\n' + said.split('\n').map((l) => '    ' + l).join('\n') + '\n');
      const { rows } = await measureFixture('light.html', 30);
      printTable(rows, 'equal');
      const bad = rows.filter(
        (r) => !(near(r.paintedFg, r.authoredFg) && near(r.paintedBg, r.authoredBg)),
      );
      record('R4', 'theme light stops page darkening', bad.length === 0, rows,
        bad.map(
          (r) => `${r.name} painted ${rgbToHex(r.paintedFg)}/${rgbToHex(r.paintedBg)} ` +
            `≠ authored ${rgbToHex(r.authoredFg)}/${rgbToHex(r.authoredBg)}`,
        ));
    }

    // ---- R5 -------------------------------------------------------------
    console.log('\n## R5 — theme dark, browser_theme{site:off} on the fixture origin\n');
    {
      await mcp('browser_theme', { mode: 'dark' });
      await mcp('browser_navigate', { action: 'goto', url: `${FIXTURE_BASE}/light.html` });
      await sleep(1500);
      const said = await mcp('browser_theme', { site: 'off' });
      console.log('browser_theme said:\n' + said.split('\n').map((l) => '    ' + l).join('\n') + '\n');
      if (/mechanism: filter-inversion/.test(said)) {
        console.log(
          '    NOTE: the CDP per-tab override is reporting as unavailable on this build. ' +
            'Every round above measured the filter fallback, not force-dark.\n',
        );
      }
      await sleep(900);
      const t = await targetFor((u) => u.includes('/light.html'));
      const cdp = await Cdp.open(t.webSocketDebuggerUrl);
      let rows;
      try {
        await cdp.send('Page.enable').catch(() => {});
        const dpr = await cdp.evaluate('window.devicePixelRatio');
        const patches = await cdp.evaluate('window.__patches()');
        if (patches.length !== 30) throw new Error(`R5: expected 30 patches, got ${patches.length}`);
        const img = await cdp.screenshot();
        if (distinctColours(img) < 4) throw new Error('R5: the screenshot is monochrome');
        rows = patches.map((p) => {
          const fg = sample(img, Math.round(p.glyph.x * dpr), Math.round(p.glyph.y * dpr));
          const bg = sample(img, Math.round(p.corner.x * dpr), Math.round(p.corner.y * dpr));
          return {
            name: p.name,
            authoredFg: hexToRgb(p.fg), authoredBg: hexToRgb(p.bg),
            authored: contrast(hexToRgb(p.fg), hexToRgb(p.bg)),
            paintedFg: fg, paintedBg: bg, painted: contrast(fg, bg),
          };
        });
      } finally {
        cdp.close();
      }
      printTable(rows, 'equal');
      const bad = rows.filter(
        (r) => !(near(r.paintedFg, r.authoredFg) && near(r.paintedBg, r.authoredBg)),
      );
      record('R5', 'per-site off restores authored rendering', bad.length === 0, rows,
        bad.map(
          (r) => `${r.name} painted ${rgbToHex(r.paintedFg)}/${rgbToHex(r.paintedBg)} ` +
            `≠ authored ${rgbToHex(r.authoredFg)}/${rgbToHex(r.authoredBg)}`,
        ));
    }

    // ---- R6 -------------------------------------------------------------
    console.log('\n## R6 — Aperture\'s own windows: chrome + vault gate\n');
    {
      // Open the vault the way a human does: the toolbar button in the chrome
      // renderer. `--open-vault` would work too and would prove less.
      const chromeTarget = await targetFor((u) => /renderer[/\\]index\.html$/.test(u));
      const ck = await Cdp.open(chromeTarget.webSocketDebuggerUrl);
      try {
        await ck.evaluate("document.getElementById('vault-btn').click(); 1");
      } finally {
        ck.close();
      }
      await sleep(2500);

      const audits = [
        await auditWindow('chrome', (u) => /renderer[/\\]index\.html$/.test(u)),
        await auditWindow('vault gate', (u) => /renderer[/\\]vault\.html$/.test(u)),
      ];
      const notes = [];
      let ok = true;
      for (const a of audits) {
        console.log(`\n### ${a.name} — ${a.rows.length} rows, ` +
          `document color-scheme: ${a.colorScheme}\n`);
        console.log('| element | kind | fg | bg | ratio | verdict |');
        console.log('|---|---|---|---|---|---|');
        for (const r of a.rows) {
          const ratio = contrast(r.fg, r.bg);
          const verdict = r.exempt ? `exempt (${r.exempt})` : ratio >= 4.5 - 1e-9 ? 'ok' : 'RED';
          if (verdict === 'RED') {
            ok = false;
            notes.push(`${a.name} ${r.what} ${f2(ratio)} < 4.5`);
          }
          console.log(
            `| ${a.name}/${r.what} | ${r.kind} | ${rgbToHex(r.fg)}` +
              `${r.fgAlpha < 1 ? ` (a=${r.fgAlpha})` : ''} | ${rgbToHex(r.bg)} | ` +
              `**${f2(ratio)}** | ${verdict} |`,
          );
        }
        console.log(`\ncross-check: ${a.crossChecked} background(s) sampled from the capture` +
          (a.crossFailed.length ? ` — ${a.crossFailed.length} problem(s)` : ' — all agree'));
        for (const f of a.crossFailed) {
          console.log(`  ! ${f}`);
          notes.push(`${a.name} cross-check: ${f}`);
          ok = false;
        }
      }
      record('R6', "Aperture's own chrome and vault gate", ok, [], notes);
    }
  } finally {
    if (ap) await killTree(ap.child);
    server.close();
  }

  console.log('\n---\n\n## Verdict\n');
  console.log('| round | what | verdict |');
  console.log('|---|---|---|');
  for (const r of rounds) console.log(`| ${r.id} | ${r.what} | ${r.ok ? 'GREEN' : 'RED'} |`);
  const red = rounds.filter((r) => !r.ok);
  if (red.length) {
    console.log('\nred detail:');
    for (const r of red) for (const n of r.notes) console.log(`  ${r.id}  ${n}`);
  }
  if (rounds.length !== 6) {
    console.error(`\nREFUSING A VERDICT: only ${rounds.length} of 6 rounds reported.`);
    process.exit(3);
  }
  console.log(
    `\nDARKMODE BENCH: ${red.length ? `RED — ${red.length} of 6` : 'GREEN — 6 of 6'}` +
      `  [out/main/index.js sha256 ${ARTIFACT_HASH.slice(0, 16)}…]`,
  );
  process.exit(red.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\nBENCH COULD NOT RUN: ${e?.stack ?? e}`);
  process.exit(3);
});
