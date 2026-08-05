import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE RECURRENCE MECHANISM FOR THE COVERAGE CLASS.
 *
 * The class, stated as a mechanism rather than as a surface: **a data class the
 * machinery was never wired to.** Its one known member is F-F
 * (`docs/design/sink-closure-review-3.md` §2), and F-F is not a sink anybody
 * forgot to scrub. Every sink was closed. `registerNeedles` had exactly ONE call
 * site — `vault_request_fill` — so three gates of machinery (origin-keyed
 * needles, `carriedOrigins`, `redactUrl`, the walk-time alphabet) protected
 * credentials and nothing else, and `browser_fill_form` wrote a date of birth
 * into a page with none of it armed. The gate pointed sink 1 — the FIRST attack
 * of the whole programme — at that value and it walked out through the same-tab
 * snapshot, a link href, the page title, a carrier tab and the tab listing.
 *
 * So the fix that matters is not the one-line `registerNeedles` call. It is
 * this file: **a third fill path cannot ship uncovered.**
 *
 * WHY A SOURCE SCAN. `completeness.test.ts` closed its own class by making
 * "rendered" a MEASUREMENT rather than a list — plant a canary in every field,
 * render, see which survive. That move is not available here, for the same
 * reason `urlsurfaces.test.ts` gives: these are CALL SITES, not type members,
 * and no runtime observation enumerates them. A test that filled a form and
 * checked the redaction would measure the two paths that exist; it could not
 * fail for a third that does not exist yet, which is the failure this file is
 * for. `docs.test.ts` set the precedent: assert over the text when the property
 * lives in the text.
 *
 * WHAT WOULD BE STRONGER, and why it is not done. Making `registerNeedles`
 * unreachable-if-forgotten — folding it into `requestFill` itself, so the write
 * cannot happen without it — is the shape this codebase already reached for once
 * and it worked (`redactFreeText` lost its `marker` parameter, which turned
 * "right marker, wrong scrub" from a reviewable mistake into a compile error).
 * It does not transfer here: the credential path needles EVERY value it writes
 * and the profile path needles only the SENSITIVE ones, so the decision is
 * per-target and a funnel would have to take a flag — at which point a third
 * path can pass the wrong flag and tsc is satisfied. That is exactly the case-B
 * weakness the second gate measured against `completeness.test.ts`: forcing a
 * ruling is not the same as measuring one.
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
 * rather than about the comments explaining them. Same conservative stripper as
 * `urlsurfaces.test.ts`: whole-line `//` and docblock lines go, nothing else.
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
  code: code(readFileSync(path, 'utf8')),
}));

/** The tool whose handler each `server.registerTool(` block belongs to. */
function toolBlocks(src: string): { name: string; body: string }[] {
  const parts = src.split(/server\.registerTool\(/);
  return parts.slice(1).map((body) => ({
    name: /^\s*'([^']+)'/.exec(body)?.[1] ?? '(unnamed)',
    body,
  }));
}

describe('every path that writes a value into a page arms the redaction for it', () => {
  it('the fill channel has exactly the call sites this file rules on', () => {
    // `requestFill` is the ONE funnel from main into the preload's write pass —
    // there is no second way to put a value in a field. So enumerating its call
    // sites enumerates the fill paths, and freezing that enumeration is what
    // makes a third one fail here by name instead of shipping uncovered for two
    // gates the way the profile path did.
    const callers = SOURCES.filter(
      (f) =>
        /requestFill\(/.test(f.code) &&
        !/export async function requestFill/.test(f.code),
    );
    expect(
      callers.map((f) => f.rel).sort(),
      'a new file calling requestFill is a new fill path — give it needles and ' +
        'add it here, or it ships with the coverage F-F measured',
    ).toEqual(['src/mcp/tools.ts']);

    const tools = SOURCES.find((f) => f.rel === 'src/mcp/tools.ts')!;
    const writers = toolBlocks(tools.code)
      .filter((b) => /requestFill\(/.test(b.body))
      .map((b) => b.name)
      .sort();
    expect(
      writers,
      'exactly two tools write values into a page: the credential path and the ' +
        'profile path. A third is the F-F shape again.',
    ).toEqual(['browser_fill_form', 'vault_request_fill']);
  });

  it('BOTH fill paths reach registerNeedles and markTainted', () => {
    // The parity assertion itself, and the one that is RED at 3942ff8:
    // `browser_fill_form` called `markTainted` and nothing else.
    //
    // Both halves are required and neither implies the other. TAINT is keyed on
    // the ELEMENT Aperture wrote into, so it masks that field and no copy of it,
    // and `invalidate(documentReplaced)` clears it — which is the seventh sink's
    // off switch. NEEDLES are keyed on the VALUE and on the ORIGIN, so they
    // cover every copy the page makes, survive navigation, and are what
    // `carriedOrigins`, `redactUrl` and the walk-time alphabet all operate on.
    // A path with taint alone has the F-F coverage; a path with needles alone
    // cannot mask a field whose value the page has since cleared.
    const tools = SOURCES.find((f) => f.rel === 'src/mcp/tools.ts')!;
    for (const b of toolBlocks(tools.code).filter((x) => /requestFill\(/.test(x.body))) {
      expect(
        b.body,
        `${b.name}: writes values into the page and must register needles for ` +
          'them — without it, redactObserved\'s needle branch never runs and ' +
          'every COPY the page makes of the value is delivered verbatim (F-F)',
      ).toMatch(/registerNeedles\(/);
      expect(
        b.body,
        `${b.name}: must mark the fields it wrote as tainted, so the field ` +
          'itself is masked even after the page clears the value',
      ).toMatch(/markTainted\(/);
    }
  });

  it('needles are registered BEFORE the write, on both paths', () => {
    // Ordering is a property of this class too, and it is cheap to state. A
    // registration that happened after `requestFill` resolved would leave a
    // window in which the value is in the DOM and the redactor does not know
    // it — and a concurrent `browser_snapshot` is one MCP call away, with no
    // page script required at all.
    const tools = SOURCES.find((f) => f.rel === 'src/mcp/tools.ts')!;
    for (const b of toolBlocks(tools.code).filter((x) => /requestFill\(/.test(x.body))) {
      expect(
        b.body.indexOf('registerNeedles('),
        `${b.name}: registerNeedles must come before requestFill`,
      ).toBeLessThan(b.body.indexOf('requestFill('));
    }
  });

  it('the profile path needles the SENSITIVE values and not the open ones', () => {
    // The other way to get this wrong, and it is not hypothetical: needling
    // every profile value would register `Brad`, `Melbourne` and `Director` —
    // `MIN_NEEDLE_LENGTH` stops none of those — and the marker would start
    // appearing on unrelated pages for the whole TTL. The plan already prints
    // the open values to the agent in clear, because they are defaults a human
    // is being asked to confirm rather than secrets.
    const tools = SOURCES.find((f) => f.rel === 'src/mcp/tools.ts')!;
    const profile = toolBlocks(tools.code).find((b) => b.name === 'browser_fill_form')!;
    const armLine = /const needleValues =[\s\S]{0,240}?;/.exec(profile.body)?.[0] ?? '';
    expect(
      armLine,
      'the values handed to registerNeedles on the profile path must come from ' +
        'the sensitive subset',
    ).toMatch(/sensitive/);
  });

  it('needlesFor is not exported — a caller can scrub, never read', () => {
    // The property that makes "register the value" safe to do on a second path:
    // main retains the plaintext, and the only way out of the store is a
    // function that returns SCRUBBED TEXT. `hasNeedles` was added in the same
    // pass and answers a boolean, which is the same line drawn one notch down.
    const engine = SOURCES.find((f) => f.rel === 'src/core/snapshot/engine.ts')!;
    expect(engine.code).toMatch(/\nfunction needlesFor\(/);
    expect(engine.code).not.toMatch(/export function needlesFor\(/);
    expect(engine.code).not.toMatch(/export function scrubbablesFor\(/);
  });
});
