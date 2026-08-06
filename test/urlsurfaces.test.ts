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

/**
 * The body of a top-level `function name(...)` or `const name = ...`, or null.
 *
 * ONE LEVEL, and the shallowness is the design. This exists so the routeCapture
 * guard can see through `openUrls: [captureDestination(t)]` — a spelling that
 * satisfies every shape check while restoring F-G. It resolves a BARE
 * IDENTIFIER call in the same file and nothing else; a member call is left to
 * the `.list(`/`.map(` ban on the call site itself. Following a method through
 * a class in another file would be a call-graph walk, which is a second parser.
 */
function declarationBody(c: string, name: string): string | null {
  const decl = new RegExp(
    `(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`,
  ).exec(c);
  if (!decl) return null;
  const from = decl.index;
  const open = c.indexOf('{', from);
  // An arrow with an expression body has no brace before its terminating `;`.
  const semi = c.indexOf(';', from);
  if (open === -1 || (semi !== -1 && semi < open)) {
    return semi === -1 ? c.slice(from) : c.slice(from, semi + 1);
  }
  let depth = 0;
  for (let i = open; i < c.length; i++) {
    if (c[i] === '{') depth++;
    else if (c[i] === '}' && --depth === 0) return c.slice(from, i + 1);
  }
  return null;
}

const SOURCES = filesUnder(join(ROOT, 'src'), '.ts').map((path) => ({
  rel: path.slice(ROOT.length + 1).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
})).map((f) => ({ ...f, code: code(f.text) }));

describe('every URL that leaves this process goes through the URL scrubber', () => {
  it('every routeCapture call site treats ALL THREE page-influenced arguments', () => {
    // The caption and the source URL are forwarded to Notion, so this is the
    // one surface in the codebase where a page-written string leaves the
    // MACHINE rather than merely entering the model's context. There are two
    // call sites — the agent's `browser_capture` and the human's toolbar
    // button — and for one commit only the first was scrubbed.
    //
    // THE THIRD ARGUMENT, ADDED 2026-08-05 (third gate, F-G) — and the reason
    // it was missing is the reason this file exists. Sink 10's lesson was
    // "`routeCapture` has two call sites and one was hardened". The
    // reconciliation covered `title` and `sourceUrl`, and this guard was written
    // in the same pass to stop the recurrence — enumerating both call sites and
    // asserting on TWO of the three page-influenced arguments. `openUrls` picks
    // WHERE THE SCREENSHOT GOES: `routeCapture` appends to the first tab whose
    // URL yields a Notion page id, so the human path's `t.list().map(…)` let
    // whichever tab got there first choose the destination, and a page can
    // create a tab. A guard that reconciles two of three arguments is the same
    // mistake it is guarding against, one level up.
    // ENUMERATED BY CALL SITE, NOT BY FILE — 2026-08-06, row D-i1.
    //
    // The previous spelling filtered SOURCES to the files containing a
    // `routeCapture(` and then ran `exec` once per file. Two holes followed
    // from that and neither was in the comment: `exec` returns the FIRST match
    // only, so a second call site in an already-listed file was never
    // examined; and the file that DEFINES routeCapture was excluded whole, so
    // a call site inside capture.ts was invisible too. Row D-i1 added an
    // unscrubbed second `routeCapture` to browser_capture — all three
    // page-influenced arguments raw, destination taken from the tab list, F-G
    // and sink 10 together — and this leg passed 666/666.
    //
    // `test/fillpaths.test.ts` was rebuilt in the fourth gate for exactly this
    // defect, and `test/autocrop.test.ts`'s cropNote leg already uses
    // matchAll. The lesson had landed in two sibling files and not in this one.
    //
    // The definition is excluded by its SIGNATURE, not by its file.
    const isDefinition = (c: string, at: number) =>
      /\bfunction\s+$/.test(c.slice(Math.max(0, at - 40), at));
    // The site's NAME is the surface it serves, so a new one fails by name
    // rather than by count.
    const enclosing = (c: string, at: number) => {
      const before = c.slice(0, at);
      let name = '(top level)';
      for (const m of before.matchAll(
        /(?:registerTool\(\s*'([^']+)'|\bhandle\(\s*'([^']+)'|function\s+(\w+))/g,
      )) {
        name = m[1] ?? m[2] ?? m[3] ?? name;
      }
      return name;
    };

    const sites: { rel: string; name: string; opts: string }[] = [];
    for (const f of SOURCES) {
      for (const m of f.code.matchAll(/routeCapture\(/g)) {
        const at = m.index ?? 0;
        if (isDefinition(f.code, at)) continue;
        sites.push({
          rel: f.rel,
          name: enclosing(f.code, at),
          opts: /^routeCapture\([\s\S]*?\n\s*\}\)/.exec(f.code.slice(at))?.[0] ?? '',
        });
      }
    }

    expect(
      sites.map((s) => `${s.rel} ${s.name}`).sort(),
      'a routeCapture call site was added or moved. Every one of them forwards ' +
        'page-written bytes off the machine, so each is frozen by name here.',
    ).toEqual(['src/main/ipc.ts capture:page', 'src/mcp/tools.ts browser_capture']);

    for (const f of sites) {
      const opts = f.opts;
      const title = /title:\s*([^\n]*)/.exec(opts)?.[1] ?? '';
      const sourceUrl = /sourceUrl:\s*([^\n]*)/.exec(opts)?.[1] ?? '';
      const openUrls = /openUrls:\s*([^\n]*)/.exec(opts)?.[1] ?? '';

      expect(title, `${f.rel}: the Notion caption must be needle-scrubbed`).toMatch(
        /redactFreeText\(/,
      );
      expect(
        sourceUrl,
        `${f.rel}: the source URL must go through redactUrl, not the text scrub — ` +
          'the browser percent-encodes whatever the page put in it',
      ).toMatch(/redactUrl\(/);

      // The destination is a ONE-ELEMENT array literal, and it is not built by
      // walking a collection. Both halves are needed: `[a, b]` and
      // `t.list().map(…)` are the two spellings of "let something other than the
      // active tab choose", and only the second is what shipped.
      expect(
        openUrls,
        `${f.rel}: the capture destination must come from the ACTIVE TAB ONLY. ` +
          'routeCapture takes the FIRST tab whose URL yields a Notion page id, ' +
          'so any wider list hands the destination to whichever tab got there ' +
          'first — and a page can open one (F-G).',
      ).toMatch(/^\s*\[[^,\]]*\]\s*,?\s*$/);
      expect(
        openUrls,
        `${f.rel}: the destination must not be derived from the tab list`,
      ).not.toMatch(/\.list\(|\.map\(/);

      // ONE LEVEL OF INDIRECTION, RESOLVED — 2026-08-06, row D-i2.
      //
      // The two checks above assert the SHAPE of an expression, not what the
      // expression computes. `[captureDestination(t)]` is a one-element array
      // literal containing neither `.list(` nor `.map(` — both of which now
      // live one function away — and it restores F-G on the human path while
      // the agent path keeps its literal, which is class D exactly. It passed
      // 666/666. This is the S-E3 / S-L2 lesson in a third place: an act caught
      // or missed by how its author spelled it.
      //
      // DEPTH ONE, DELIBERATELY. A general call-graph walk in a source-level
      // test is a second parser, which is the failure test/lib/source.ts
      // exists to prevent. A bare-identifier call is resolvable in this file by
      // construction, so that is the case resolved; if it cannot be resolved
      // the guard FAILS rather than passes, because a guard that cannot see
      // through an indirection must say so.
      const callee = /^\s*\[\s*([A-Za-z_$][\w$]*)\s*\(/.exec(openUrls)?.[1];
      if (callee) {
        const src = SOURCES.find((s) => s.rel === f.rel)?.code ?? '';
        const body = declarationBody(src, callee);
        expect(
          body,
          `${f.rel}: openUrls calls ${callee}(), which this guard cannot locate ` +
            'in the same file. The capture destination must be resolvable at ' +
            'the call site — an unresolvable spelling is how F-G comes back.',
        ).toBeTruthy();
        expect(
          body ?? '',
          `${f.rel}: ${callee}() derives the capture destination from the tab ` +
            'list. Moving the expression one function away does not change ' +
            'which tab chooses where the screenshot goes (F-G).',
        ).not.toMatch(/\.list\(|\.map\(/);
      }
    }
  });

  it("browser_read's body is transformed BEFORE redaction and not after", () => {
    // The one page-text path that is not the walker's. Its alphabet agreement is
    // maintained by hand, so the hand is what gets frozen: every mutation of the
    // body happens before redactFreeText, and the only thing between that call
    // and the return is the needle loop, the length cap and the envelope.
    //
    // Ordering, not presence. `stripFormat(body)` being present says nothing if
    // something else re-normalises the bytes afterwards, which is F-B with the
    // steps in the wrong order. A single `.replace(/\s{2,}/g, ' ')` added here
    // puts `my  pass phrase` past a needle of `my pass phrase` and then emits
    // the value whole — and the needles that carry whitespace are the ordinary
    // ones, since the profile fill path registers full names and street
    // addresses (G30a-e).
    const f = SOURCES.find((x) => x.rel === 'src/mcp/tools.ts');
    expect(f, 'src/mcp/tools.ts must exist').toBeTruthy();
    const from = f!.code.indexOf("'browser_read'");
    expect(from, "browser_read's registration must be locatable").toBeGreaterThan(-1);
    const next = f!.code.indexOf('server.registerTool(', from);
    const handler = f!.code.slice(from, next === -1 ? f!.code.length : next);

    const iStrip = handler.indexOf('stripFormat(body)');
    const iSafe = handler.indexOf('let safe =');
    const iRedact = handler.indexOf('redactFreeText(id, body)');
    const iReturn = handler.indexOf('return text(untrusted(');
    for (const [i, what] of [
      [iStrip, 'stripFormat(body)'],
      [iSafe, 'let safe ='],
      [iRedact, 'redactFreeText(id, body)'],
      [iReturn, 'return text(untrusted('],
    ] as const) {
      expect(i, `browser_read must still contain \`${what}\``).toBeGreaterThan(-1);
    }

    expect(
      iStrip,
      'stripFormat(body) must run BEFORE redactFreeText, or the redactor is ' +
        'searching bytes the caller will never see',
    ).toBeLessThan(iRedact);

    // FROZEN BY NAME, not by count: an addition fails saying what it was.
    const tail = handler.slice(iSafe, iReturn);
    const assigns = [...tail.matchAll(/safe\s*=\s*([^\n]*)/g)].map((m) => (m[1] ?? '').trim());
    expect(
      assigns,
      'the only writes to `safe` between the redaction and the return are the ' +
        'redaction itself and the tainted-value loop. Anything else is a ' +
        'transformation applied AFTER the needle scrub, which is F-B.',
    ).toEqual(['redactFreeText(id, body);', 'safe.split(v).join(REDACTED);']);

    for (const banned of ['.replace(', '.normalize(', '.trim(', 'stripFormat(']) {
      expect(
        tail.includes(banned),
        `browser_read calls ${banned} after redactFreeText. Whatever it ` +
          'normalises, the needle scrub has already run on the un-normalised ' +
          'bytes — so a needle that differs only by that normalisation is ' +
          'missed at redaction and reassembled on the way out.',
      ).toBe(false);
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
