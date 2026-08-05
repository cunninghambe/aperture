import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { originLabel, originOf } from '../src/shared/origin.js';
import { REDACTED_HREF, scrubUrlish } from '../src/core/snapshot/redact.js';

/**
 * THE RECURRENCE MECHANISM FOR THE URL CLASS.
 *
 * Every finding this file guards has the same shape, and it is not "somebody
 * forgot to scrub a string". It is: **a helper was written for a sentence, and
 * then wired to some of the places that sentence applies.**
 *
 *  · `scrubUrlish`'s header says a page writing the value into a URL gets
 *    `?pw=my%20pass` back out. It was wired to `Snapshot.url` and
 *    `SnapshotNode.href` — and not to `browser_tabs list`, not to
 *    `browser_navigate`'s `loaded …` line, and not to `browser_capture`'s
 *    `sourceUrl`, which leaves the machine (sink-closure-review-2.md F-C).
 *  · `security.md` then recorded "Both fields are needle-scrubbed now" about
 *    the capture path — true of the agent's `browser_capture` and false of the
 *    human's toolbar button, which reaches the same `routeCapture` with the
 *    same two page-written strings and had no scrub at all.
 *
 * `completeness.test.ts` closed this class for the fields of a snapshot by
 * making "rendered" a MEASUREMENT instead of a list. The same move is not
 * available here — these are call sites, not type members, and no runtime
 * observation enumerates them. So this file reads the source, which is a weaker
 * instrument and is the strongest one there is for "did every call site get the
 * treatment". `docs.test.ts` sets the precedent: assert over the text when the
 * property lives in the text.
 *
 * The unit tests below it are the other half — the shipped functions, executed,
 * because both are pure leaves.
 */

const ROOT = join(__dirname, '..');

function filesUnder(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, ext));
    else if (p.endsWith(ext) && statSync(p).isFile()) out.push(p);
  }
  return out;
}

/**
 * The file with its PROSE removed, so these assertions are about call sites
 * rather than about the comments explaining them.
 *
 * Deliberately conservative: whole-line `//` and docblock `*` lines go, and
 * nothing else. Stripping `//` mid-line would eat the `.origin` off
 * `new URL('http://x').origin` and turn this guard into a false negative,
 * which is the one failure a source-level guard cannot afford.
 */
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
  text: readFileSync(path, 'utf8'),
})).map((f) => ({ ...f, code: code(f.text) }));

describe('every URL that leaves this process goes through the URL scrubber', () => {
  it('every routeCapture call site scrubs BOTH the caption and the source URL', () => {
    // The caption and the source URL are forwarded to Notion, so this is the
    // one surface in the codebase where a page-written string leaves the
    // MACHINE rather than merely entering the model's context. There are two
    // call sites — the agent's `browser_capture` and the human's toolbar
    // button — and for one commit only the first was scrubbed.
    const sites = SOURCES.filter(
      (f) => /routeCapture\(/.test(f.code) && !/export async function routeCapture/.test(f.code),
    );
    expect(sites.map((f) => f.rel).sort()).toEqual(['src/main/ipc.ts', 'src/mcp/tools.ts']);

    for (const f of sites) {
      // The whole options object, whichever call site it is.
      const opts = /routeCapture\([\s\S]*?\n\s*\}\)/.exec(f.code)?.[0] ?? '';
      const title = /title:\s*([^\n]*)/.exec(opts)?.[1] ?? '';
      const sourceUrl = /sourceUrl:\s*([^\n]*)/.exec(opts)?.[1] ?? '';

      expect(title, `${f.rel}: the Notion caption must be needle-scrubbed`).toMatch(
        /redactFreeText\(/,
      );
      expect(
        sourceUrl,
        `${f.rel}: the source URL must go through redactUrl, not the text scrub — ` +
          'the browser percent-encodes whatever the page put in it',
      ).toMatch(/redactUrl\(/);
    }
  });

  it('no call site outside the redactor hand-rolls the URL marker', () => {
    // `redactFreeText` used to take a `marker`, so a caller could pass
    // `REDACTED_HREF` and get the RIGHT MARKER with the WRONG SCRUB — which is
    // exactly what the tab listing did, and nothing could tell that apart from
    // a correct call. The parameter is gone; this asserts nobody reintroduces
    // the pattern by other means.
    const offenders = SOURCES.filter(
      (f) => f.rel !== 'src/core/snapshot/redact.ts' &&
        f.rel !== 'src/core/snapshot/engine.ts' &&
        /REDACTED_HREF/.test(f.code),
    );
    expect(
      offenders.map((f) => f.rel),
      'REDACTED_HREF belongs to redact.ts (which defines it) and engine.ts ' +
        '(whose redactUrl applies it). A third file naming it is a call site ' +
        'choosing a URL marker for itself, which is how F-C happened.',
    ).toEqual([]);
  });

  it('there is exactly one implementation of "which origin is this URL on"', () => {
    // `registerNeedles` keys the needle store by one of these; `originScope`
    // looks it up with the other. A disagreement is not a wrong label — it is
    // `needles.get(origin)` missing on every lookup, a silent and TOTAL failure
    // of redaction with no error anywhere.
    //
    // `src/telemetry/scrub.ts` is exempt and stays exempt: it computes an
    // origin in order to HASH it out of a crash report, never touches the
    // needle store, and must keep working if `origin.ts` ever changes its
    // failure shape. Naming it here is the point — an exemption a reader can
    // see is not the same thing as a second implementation nobody noticed.
    const EXEMPT = new Set(['src/shared/origin.ts', 'src/telemetry/scrub.ts']);
    const offenders = SOURCES.filter(
      (f) => !EXEMPT.has(f.rel) && /new URL\([^)]*\)\.origin/.test(f.code),
    );
    expect(
      offenders.map((f) => f.rel),
      'Origin computation for redaction scope lives in src/shared/origin.ts ' +
        'and nowhere else. registerNeedles keys the store by it and ' +
        'originScope looks it up with it; two spellings is a silent total ' +
        'failure waiting for a disagreement.',
    ).toEqual([]);
  });
});

describe('the URL scrubber itself, executed', () => {
  const PW = 'guard-pw-93a1';

  it('catches a value the URL parser percent-encoded', () => {
    // The general case, and it needs no adversary: an ordinary password with a
    // space in it comes back as `%20` and the plain scrub misses it.
    const spaced = 'my pass phrase';
    expect(scrubUrlish('/leak?pw=my%20pass%20phrase', [spaced])).toContain(REDACTED_HREF);
    expect(scrubUrlish('/leak?pw=my%20pass%20phrase', [spaced])).not.toContain('pass%20phrase');
  });

  it('catches the URLSearchParams spelling of a space', () => {
    expect(scrubUrlish('/leak?pw=my+pass', ['my pass'])).toContain(REDACTED_HREF);
  });

  it('catches a value split by one invisible character AND then encoded', () => {
    // Both transformations are Aperture's: the walker's `new URL(...)` encoded
    // the separator into `%E2%80%AD`, so the strip found nothing and the
    // rendered target read `?pw=guard-pw%E2%80%AD-93a1` — the password to any
    // reader willing to do the two decodings Aperture itself would do.
    const encoded = '/settle.html?landed=1&pw=guard-pw%E2%80%AD-93a1';
    expect(scrubUrlish(encoded, [PW])).toContain(REDACTED_HREF);
    expect(scrubUrlish(encoded, [PW])).not.toContain('93a1');
  });

  it('leaves a URL that carries no needle exactly as it was', () => {
    const clean = '/checkout?step=2&ref=abc%20def';
    expect(scrubUrlish(clean, [PW])).toBe(clean);
  });
});

describe('the one origin function', () => {
  it('agrees with itself in both spellings', () => {
    for (const url of [
      'http://127.0.0.1:8899/x?y=1#z',
      'https://example.com/a/b',
      'http://localhost:8899/',
      'https://sub.example.co.uk:8443/p',
    ]) {
      expect(originLabel(url)).toBe(originOf(url));
    }
  });

  it('separates hosts that resolve to the same server', () => {
    // The fact G20's cross-origin navigation and G19m's second hop both turn on.
    expect(originOf('http://localhost:8899/x')).not.toBe(originOf('http://127.0.0.1:8899/x'));
  });

  it('treats an opaque or unparseable origin as no origin at all', () => {
    // Keying a needle store by the literal string "null" would pool every
    // opaque-origin document in the browser into one bucket.
    expect(originOf('data:text/html,<p>x')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf('')).toBeNull();
    expect(originLabel('not a url')).toBe('unknown');
  });

  it('drops userinfo, so a credential in the authority cannot become an origin', () => {
    expect(originOf('http://user:guard-pw-93a1@127.0.0.1:8899/')).toBe('http://127.0.0.1:8899');
  });
});
