import { describe, expect, it } from 'vitest';
import {
  enclosingFunction,
  firstStringArg,
  lineOf,
  occurrences,
  sources,
} from './lib/source.js';

/**
 * THE RECURRENCE MECHANISM FOR THE COVERAGE CLASS.
 *
 * The class, stated as a mechanism rather than as a surface: **a data class the
 * machinery was never wired to.** Its known member is F-F
 * (`docs/design/sink-closure-review-3.md` §2), and F-F is not a sink anybody
 * forgot to scrub. Every sink was closed. `registerNeedles` had exactly ONE call
 * site — the credential path — so three gates of machinery (origin-keyed
 * needles, `carriedOrigins`, `redactUrl`, the walk-time alphabet) protected
 * credentials and nothing else, and `browser_fill_form` wrote a date of birth
 * into a page with none of it armed. The gate pointed sink 1 — the FIRST attack
 * of the whole programme — at that value and it walked out through the same-tab
 * snapshot, a link href, the page title, a carrier tab and the tab listing.
 *
 * So the fix that matters is not the one-line `registerNeedles` call. It is this
 * file: **a third fill path cannot ship uncovered.**
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE USED TO DO, AND WHY IT DID NOT WORK — 2026-08-05, fourth gate
 * ---------------------------------------------------------------------------
 *
 * It rested on a true claim — *"`requestFill` is the ONE funnel from main into
 * the preload's write pass, so enumerating its call sites enumerates the fill
 * paths"* — and then enumerated something else. It split `tools.ts` on
 * `server.registerTool(` and looked for `requestFill(` inside the resulting
 * blocks, discarding everything above the first one. Those are different sets,
 * and the gate measured the difference: a genuinely new third fill path,
 * declared as a module-scope helper above the first `registerTool` and called
 * from a tool whose own handler never names `requestFill`, left both assertions
 * passing **vacuously** with the whole suite green
 * (`docs/design/sink-closure-review-4.md` §2).
 *
 * That is the programme's own recurrence pattern reproduced inside a guard —
 * *a helper written for a sentence, wired to only some of the places the
 * sentence applies* — and it is why the criterion in `security.md` now requires
 * a sabotage row **the guard's author did not have in hand**.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOW: FOLLOW THE WRITE, NOT THE SYNTAX
 * ---------------------------------------------------------------------------
 *
 * A value reaches a page field along exactly one path, and every link in it is
 * asserted here rather than claimed in a comment:
 *
 *   1. **The write happens in the preload**, and the preload only acts on
 *      channels it listens to. `PAGE_CHANNELS` freezes that surface and rules
 *      each member on one question — *does this channel write a value into a
 *      field?* Exactly one does. A second write channel fails by name.
 *   2. **One sender.** `aperture:fill` is sent from exactly one place in `src/`,
 *      inside `requestFill`. So the funnel is a measured fact.
 *   3. **The call sites of that sender are the fill paths.** Every occurrence of
 *      `requestFill(` in real code — in any file, at any nesting, inside a tool
 *      handler or a module-scope helper — is enumerated, named by its
 *      ENCLOSING FUNCTION, and frozen. A third occurrence fails on the frozen
 *      list before any structural check runs, and so does a SECOND occurrence
 *      inside a function that already has one.
 *   4. **Each of them arms both halves first**, in the function the value flows
 *      through rather than in whatever block a `split()` happened to produce.
 *
 * WHAT IT STILL CANNOT DO, stated because every guard here states it. This is a
 * lexer (`test/lib/source.ts`), not a type checker. It can prove that the
 * function performing a write also names `registerNeedles` and `markTainted`
 * before it. It cannot prove that the VALUES handed to those are the values
 * handed to the write — a path that arms an empty array satisfies every
 * assertion below. What closes that gap is not another regex: it is the frozen
 * site list, which forces a human to look at any new write at all. The rulings
 * in `WRITES` are where that looking is recorded.
 *
 * WHAT WOULD BE STRONGER, and why it is not done. Making `registerNeedles`
 * unreachable-if-forgotten — folding it into `requestFill` itself — is the shape
 * this codebase reached for once and it worked (`redactFreeText` lost its
 * `marker` parameter, which turned "right marker, wrong scrub" into a compile
 * error). It does not transfer: the credential path needles EVERY value it
 * writes and the profile path needles only the SENSITIVE ones, so the decision
 * is per-target and a funnel would have to take a flag — at which point a third
 * path passes the wrong flag and tsc is satisfied. Forcing a ruling is not the
 * same as measuring one, which is the case-B weakness the second gate measured
 * against `completeness.test.ts`.
 */

const SOURCES = sources();
const file = (rel: string) => SOURCES.find((f) => f.rel === rel)!;

/**
 * The channels the page-world preload listens on, and the one question that
 * matters about each: can it put a value into a field?
 *
 * This is link 1 of the chain, and it is what makes "requestFill is the one
 * funnel" a measurement rather than a sentence. The write pass lives behind
 * `aperture:fill`; a future channel that also writes — a paste path, an
 * autofill-from-clipboard, a second fill protocol — appears here first, with no
 * ruling, and fails.
 */
const PAGE_CHANNELS: Record<string, string> = {
  'aperture:walk': 'READS the tree. No write pass.',
  'aperture:read': 'READS innerText. No write pass.',
  'aperture:resolve': 'Resolves a ref to an element. No write pass.',
  'aperture:select': 'Chooses an <option> ALREADY IN THE PAGE — the page authored ' +
    'every candidate, so no value crosses from Aperture into the document.',
  'aperture:witness': 'Arms an input-event witness. Observes; writes nothing.',
  'aperture:witness-poll': 'Reads the armed witness. Observes; writes nothing.',
  'aperture:fill':
    'THE WRITE PASS, and the only one. Everything below is about its senders ' +
    'and their callers.',
};

/**
 * Every place a value is written into a page, named by the function the value
 * flows through, with what that function arms.
 *
 * FROZEN. This list is the guard. A third fill path — a new tool, a new file, a
 * module-scope helper, a retry inside a function that already writes — is not
 * on it and fails by name before anything else is checked.
 *
 * `applyFill` rather than `vault_request_fill`: the credential tool splits its
 * pipeline into a named helper so the in-flight lock can wrap it in a `finally`,
 * and the helper is where the arming and the write both live. Naming the unit
 * the value actually flows through is the entire point of this file — the tool
 * that owns it is named in the ruling.
 */
const WRITES: Record<string, string> = {
  'src/mcp/tools.ts :: applyFill':
    'The CREDENTIAL path (`vault_request_fill`, steps 7-16). Arms taint on the ' +
    'target keys and needles on every value it writes — username, password and ' +
    'the one-time code — against the committed origin the human approved.',
  'src/mcp/tools.ts :: browser_fill_form':
    'The PROFILE path. Arms taint and needles on the SENSITIVE subset only: a ' +
    'needle for `Brad` or `Melbourne` would redact the web, and the plan ' +
    'already prints the open values to the agent in clear because they are ' +
    'defaults a human is being asked to confirm. This path had NEITHER half ' +
    'for three gates (F-F).',
};

/** Every `requestFill(` in real code, excluding the declaration itself. */
function writeSites(): { key: string; rel: string; line: number; body: string; at: number }[] {
  const out: { key: string; rel: string; line: number; body: string; at: number }[] = [];
  for (const f of SOURCES) {
    for (const at of occurrences(f.code, 'requestFill(')) {
      if (/\bfunction\s+$/.test(f.code.slice(Math.max(0, at - 40), at))) continue;
      const fn = enclosingFunction(f.code, f.raw, at);
      out.push({
        key: `${f.rel} :: ${fn?.name ?? '(module scope)'}`,
        rel: f.rel,
        line: lineOf(f.raw, at),
        body: fn?.body ?? '',
        at: fn ? at - fn.open : -1,
      });
    }
  }
  return out;
}

describe('every path that writes a value into a page arms the redaction for it', () => {
  it('the preload listens on exactly the channels ruled here, and one of them writes', () => {
    const page = file('src/preload/page.ts');
    const listened = occurrences(page.code, 'ipcRenderer.on(')
      .map((at) => firstStringArg(page.code, page.raw, at))
      .filter((c): c is string => c !== null)
      .sort();

    expect(
      listened,
      'A NEW CHANNEL INTO THE PAGE WORLD. The whole coverage argument starts ' +
        'from "the preload writes values only on aperture:fill". Rule this ' +
        'channel on whether it can put a value into a field; if it can, its ' +
        'senders belong in WRITES below.',
    ).toEqual(Object.keys(PAGE_CHANNELS).sort());

    const writers = Object.entries(PAGE_CHANNELS).filter(([, r]) => /THE WRITE PASS/.test(r));
    expect(writers.map(([c]) => c)).toEqual(['aperture:fill']);
  });

  it('aperture:fill has exactly one sender, and it is requestFill', () => {
    // Link 2. Without this, a new `wc.send('aperture:fill', …)` beside the
    // existing one would be a fill path with no `requestFill(` anywhere near
    // it, and every assertion below would be looking at the wrong token.
    const senders: string[] = [];
    for (const f of SOURCES) {
      for (const at of occurrences(f.code, '.send(')) {
        if (firstStringArg(f.code, f.raw, at) !== 'aperture:fill') continue;
        // The whole nest, innermost first: the send sits inside a Promise
        // executor, and naming only that would freeze a detail while letting
        // the function that OWNS the channel change underneath it.
        const nest: string[] = [];
        for (let fn = enclosingFunction(f.code, f.raw, at); fn; ) {
          nest.push(fn.name);
          fn = fn.open > 0 ? enclosingFunction(f.code, f.raw, fn.open) : null;
        }
        senders.push(`${f.rel} :: ${nest.join(' in ') || '(module scope)'}`);
      }
    }
    expect(
      senders,
      'the write channel must have one sender, so that enumerating that ' +
        'sender\'s call sites enumerates the fill paths',
    ).toEqual(['src/core/snapshot/engine.ts :: Promise(…) in requestFill']);
  });

  it('the write sites are exactly the ones ruled here', () => {
    // Link 3, and the assertion the fourth gate's sabotage walks into. It does
    // not care where the call is written — a tool handler, a module-scope
    // helper, a new file, a second call inside a function that already has one.
    // Every occurrence is a row, and a row nobody ruled is a red.
    const sites = writeSites();
    expect(
      sites.map((s) => s.key).sort(),
      'A FILL PATH NOBODY RULED. Every occurrence of requestFill( is a place a ' +
        'value enters a page. Give it needles and taint, then rule it in ' +
        'WRITES saying WHICH values it arms — or it ships with the coverage ' +
        'F-F measured.\n' +
        sites.map((s) => `  ${s.rel}:${s.line}  ${s.key}`).join('\n'),
    ).toEqual(Object.keys(WRITES).sort());
  });

  it('every write site arms BOTH halves, in the function the value flows through', () => {
    // Both halves are required and neither implies the other. TAINT is keyed on
    // the ELEMENT Aperture wrote into, so it masks that field and no copy of
    // it, and `invalidate(documentReplaced)` clears it — the seventh sink's off
    // switch. NEEDLES are keyed on the VALUE and on the ORIGIN, so they cover
    // every copy the page makes, survive navigation, and are what
    // `carriedOrigins`, `redactUrl` and the walk-time alphabet all operate on.
    // A path with taint alone has the F-F coverage; a path with needles alone
    // cannot mask a field whose value the page has since cleared.
    for (const s of writeSites()) {
      for (const arm of ['registerNeedles(', 'markTainted(']) {
        const armAt = s.body.indexOf(arm);
        expect(
          armAt,
          `${s.key} (${s.rel}:${s.line}): the function that performs this ` +
            `write must call ${arm.slice(0, -1)} — not a caller three frames ` +
            'up, and not a sibling branch',
        ).toBeGreaterThanOrEqual(0);
        // ORDERING, and it is a lifetime property stated here because this is
        // where the write is: a registration after `requestFill` resolved leaves
        // a window in which the value is in the DOM and the redactor does not
        // know it, and a concurrent `browser_snapshot` is one MCP call away with
        // no page script required at all.
        expect(
          armAt,
          `${s.key}: ${arm.slice(0, -1)} must come BEFORE the write`,
        ).toBeLessThan(s.at);
      }
    }
  });

  it('the profile path needles the SENSITIVE values and not the open ones', () => {
    // The other way to get this wrong, and it is not hypothetical: needling
    // every profile value would register `Brad`, `Melbourne` and `Director` —
    // `MIN_NEEDLE_LENGTH` stops none of those — and the marker would start
    // appearing on unrelated pages for the whole TTL.
    const profile = writeSites().find((s) => s.key.endsWith(':: browser_fill_form'))!;
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
    const engine = file('src/core/snapshot/engine.ts');
    expect(engine.code).toMatch(/\nfunction needlesFor\(/);
    expect(engine.code).not.toMatch(/export function needlesFor\(/);
    expect(engine.code).not.toMatch(/export function scrubbablesFor\(/);
  });
});
