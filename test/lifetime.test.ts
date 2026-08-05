import { describe, expect, it } from 'vitest';
import { enclosingFunction, lineOf, occurrences, sources } from './lib/source.js';

/**
 * THE LIFETIME CLASS — the seventh mechanism.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT, IN ONE SENTENCE
 * ---------------------------------------------------------------------------
 *
 * **A value Aperture writes into a page stays covered from before the write
 * until the redactor's own clock or the human's own lock says otherwise — the
 * only disarms are an outcome that proves the value never landed, the TTL, and
 * a vault lock; never an event a page can cause, and never a drop of coverage
 * that a different write earned.**
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A CLASS OF ITS OWN
 * ---------------------------------------------------------------------------
 *
 * Six mechanisms were named across four gates and none of them is this one.
 * Scope is WHERE the redactor looks. Alphabet is WHAT BYTES it compares.
 * Coverage is WHICH VALUES it was ever given. This is **WHEN it holds one**,
 * and sorting the existing findings by that question makes four fall out
 * together (`docs/design/sink-closure-review-4.md` §6):
 *
 *   1. **The seventh sink.** `invalidate(documentReplaced)` called
 *      `clearNeedles`, so the navigation that DELIVERED the value was the one
 *      that disarmed the redactor. It was filed under scope. It is not a scope
 *      bug: the scope was right and the value was forgotten at the wrong moment.
 *   2. **`dropNeedles`'s cross-fill residual.** A refusal on attempt two
 *      removed a needle attempt one had earned. Neither scope, nor alphabet,
 *      nor coverage — a disarm triggered by the wrong event.
 *   3. **The TTL boundary.** Ten minutes, after which every copy the page made
 *      goes clear, with no event and no guard. Disclosed, never measured.
 *   4. **`unmarkTainted`'s asymmetry.** Taint comes off on a global refusal and
 *      stays on every uncertain outcome. Correct — and reasoned about nowhere
 *      near the other three, which is how 1 and 2 both shipped.
 *
 * Before this file, exactly one of the four was guarded, and by an assertion
 * living inside another class's guard (`fillpaths.test.ts` requires the arming
 * to precede the write — a lifetime property in a coverage file) plus one live
 * leg (G19h, navigation survival).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARD ACTUALLY CHECKS
 * ---------------------------------------------------------------------------
 *
 * The invariant is about disarms, so the guard enumerates disarms. Two tables,
 * both total in both directions:
 *
 *   · `SHRINKERS` — every expression in `src/` that can reduce what the
 *     redactor's two memories (the needle store and the taint set) will
 *     produce. Each is ruled by the function it may live in. A shrink written
 *     anywhere else — `needles.delete(...)` in a new helper,
 *     `st.tainted.clear()` on a new event, `narrow.add(...)` after
 *     registration — fails by name.
 *   · `DISARMS` — every CALL SITE of the three functions that shrink coverage,
 *     ruled by the event class that fires it. Re-adding `clearNeedles` to
 *     `invalidate` is the seventh sink, and it lands here as an unruled row
 *     before it can land in a snapshot as a password.
 *
 * The three permitted event classes are the sentence's three clauses, and every
 * ruling names one of them:
 *
 *   PROVES-NOTHING-LANDED · TTL · HUMAN-ACT
 *
 * WHAT IT CANNOT DO. It cannot execute the store: `engine.ts` imports
 * `electron`, so no unit test in this repo can import it, and the lifetime
 * logic is not in the pure leaf the way `registrableNeedle` is. So this asserts
 * over the source, which is the same instrument — and the same admitted
 * weakness — as `urlsurfaces.test.ts` and `fillpaths.test.ts`. The executable
 * counterparts are live: G19h and G30e for member 1, G32 for the origin bound.
 * Members 3 and 4 have rulings here and no runtime measurement anywhere, and
 * that is stated rather than implied.
 */

const SOURCES = sources();

/**
 * Every way the redactor's COVERAGE can shrink, and where each is allowed to be
 * written.
 *
 * Keyed by the expression rather than by the function, because the failure this
 * table is for is a shrink appearing somewhere new — which is exactly what the
 * seventh sink was.
 *
 * "SHRINK" MEANS WHAT `needlesFor` WILL RETURN, NOT WHAT THE MAP CONTAINS, and
 * that distinction was bought with a sabotage row. The first version of this
 * table enumerated removals — `delete`, `clear` — and a row that ADDS to the
 * `narrow` set takes coverage away just as completely, because a narrow needle
 * is refused on every carried origin. One helper called from `invalidate`,
 * confining every live needle to its filled origin, reopened F-A, F-D and F-E
 * for every value and left the suite green. `narrow.add(` is therefore a
 * shrink and is ruled as one.
 */
const SHRINKERS: Record<string, { in: string[]; ruling: string }> = {
  'needles.delete(': {
    in: ['registerNeedles', 'clearNeedles'],
    ruling:
      'TTL (inside registerNeedles, as the timer body) and the tail of a drop ' +
      'that emptied an origin. Nothing else may forget an origin wholesale.',
  },
  'needles.clear(': {
    in: ['clearAllNeedles'],
    ruling: 'HUMAN-ACT — the vault lock hook, and only that.',
  },
  'values.delete(': {
    in: ['dropNeedles'],
    ruling: 'PROVES-NOTHING-LANDED — the undo of one registration, by identity.',
  },
  'narrow.delete(': {
    in: ['dropNeedles'],
    ruling: 'The same undo, keeping the narrow set in step with the values set.',
  },
  'narrow.add(': {
    in: ['registerNeedles'],
    ruling:
      'GROWING THE NARROW SET IS SHRINKING COVERAGE, which is why an ADD is in ' +
      'a table of shrinks. `needlesFor` refuses a narrow needle on every ' +
      'carried origin, so moving a value in here confines it to where it was ' +
      'filled. Membership is decided once, by `originBoundNeedle`, at ' +
      'registration; deciding it later — on a navigation, say — would take ' +
      'F-A, F-D and F-E back in one line with nothing deleted from anything. ' +
      'Added after a sabotage row did exactly that and stayed green.',
  },
  'tainted.clear(': {
    in: ['invalidate'],
    ruling:
      'A document-replacing navigation. Taint names DOM FIELDS, which really ' +
      'are gone with the document — this is the one page-caused event that is ' +
      'allowed to shrink anything, and it is allowed because what it forgets ' +
      'cannot exist any more. NEEDLES MUST NOT JOIN IT: they name a VALUE, the ' +
      'value belongs to an origin, and the origin outlives the document. That ' +
      'is the seventh sink, and this row is where it comes back.',
  },
  'tainted.delete(': {
    in: ['unmarkTainted'],
    ruling: 'PROVES-NOTHING-LANDED — a globally refused fill, validated before the first write.',
  },
};

/**
 * Every call site of the three functions that shrink coverage, and the event
 * class that fires it.
 *
 * Declarations are not call sites and do not appear. `clearNeedles` is
 * deliberately module-private, so its only possible caller is inside
 * `engine.ts`; it is enumerated anyway, because "it is not exported" is a
 * property a future edit can remove in one word.
 */
const DISARMS: Record<string, string> = {
  'dropNeedles <- src/mcp/tools.ts :: applyFill':
    'PROVES-NOTHING-LANDED — the credential path\'s global refusal, where the ' +
    'preload completed validation before the first write. Takes what THIS ' +
    'registration added, so an earlier successful fill of the same value keeps ' +
    'its coverage.',
  'dropNeedles <- src/mcp/tools.ts :: browser_fill_form':
    'PROVES-NOTHING-LANDED — the profile path\'s `!res.wrote` refusal, same ' +
    'rule. `res.wrote` present at all means the refusal arrived MID-write and ' +
    'values may be in the form, in which case nothing is dropped.',
  'clearNeedles <- src/core/snapshot/engine.ts :: dropNeedles':
    'Bookkeeping, not a disarm: the origin\'s set is already empty, and this ' +
    'cancels its timer so a dead entry cannot hold one.',
  'clearAllNeedles <- src/main/index.ts :: vault.onLock(…)':
    'HUMAN-ACT — registered on `vault.onLock`, which is what makes the IDLE ' +
    'auto-lock count as well as an explicit lock. A locked vault should not ' +
    'leave its plaintext lying in main for the rest of the ten minutes.',
  'unmarkTainted <- src/mcp/tools.ts :: applyFill':
    'PROVES-NOTHING-LANDED, and the asymmetry is the ruling: taint comes off ' +
    'on a GLOBAL refusal and stays on every partial, reverted, interrupted or ' +
    'timed-out outcome. `FILL_UNCONFIRMED` is the sharp case — the page never ' +
    'answered, so whether anything landed is genuinely unknown, and unknown is ' +
    'treated as landed.',
};

/** Where `name(` is called, as `name <- file :: enclosing function`. */
function callSites(name: string): string[] {
  const out: string[] = [];
  for (const f of SOURCES) {
    for (const at of occurrences(f.code, `${name}(`)) {
      // The declaration itself is not a call site.
      if (/\bfunction\s+$/.test(f.code.slice(Math.max(0, at - 40), at))) continue;
      const fn = enclosingFunction(f.code, f.raw, at);
      out.push(`${name} <- ${f.rel} :: ${fn?.name ?? '(module scope)'}`);
    }
  }
  return out;
}

describe('LIFETIME: when the redactor holds a value', () => {
  it('nothing shrinks the redactor\'s memory outside the functions ruled for it', () => {
    // The seventh sink, generalised. It was one line — `clearNeedles(tabId)` —
    // inside `invalidate`, and the class it belongs to had no name, so nothing
    // in the suite could have objected to it being there.
    const offenders: string[] = [];
    for (const [expr, rule] of Object.entries(SHRINKERS)) {
      for (const f of SOURCES) {
        for (const at of occurrences(f.code, expr)) {
          const fn = enclosingFunction(f.code, f.raw, at);
          const where = fn?.name ?? '(module scope)';
          if (rule.in.includes(where)) continue;
          offenders.push(`${expr} in ${f.rel}:${lineOf(f.raw, at)} (${where})`);
        }
      }
    }
    expect(
      offenders,
      'A NEW WAY TO FORGET. Something outside the ruled functions removes a ' +
        'value from the redactor\'s memory. Every disarm must be one of ' +
        'PROVES-NOTHING-LANDED, TTL or HUMAN-ACT — and if it fires on an event ' +
        'a PAGE can cause, it is the seventh sink again: the navigation that ' +
        'delivers the secret was the one that disarmed the redactor.',
    ).toEqual([]);
  });

  it('every ruled shrink still exists', () => {
    // The stale half. A ruling for an expression nobody writes any more is how
    // an audit stays plausible while its membership changes underneath it.
    const missing = Object.keys(SHRINKERS).filter(
      (expr) => !SOURCES.some((f) => f.code.includes(expr)),
    );
    expect(missing, 'a ruled shrink has disappeared — delete the row').toEqual([]);
  });

  it('every call site of a coverage-shrinking function is ruled by its event class', () => {
    const seen = [
      ...callSites('dropNeedles'),
      ...callSites('clearNeedles'),
      ...callSites('clearAllNeedles'),
      ...callSites('unmarkTainted'),
    ].sort();
    expect(
      seen,
      'A NEW DISARM. Somebody can now take coverage away from a value that was ' +
        'written into a page. Name the event that fires it and rule it as one ' +
        'of PROVES-NOTHING-LANDED, TTL or HUMAN-ACT. If it is none of those, it ' +
        'is a page-controlled off switch for the whole mechanism.\n  ' +
        seen.join('\n  '),
    ).toEqual(Object.keys(DISARMS).sort());
  });

  it('an undo removes what its own registration added, and re-derives nothing', () => {
    // Member 2, and the difference is one word in a signature. `dropNeedles`
    // taking `values: string[]` meant "the values this fill WANTED to write",
    // which is not the same set as "the values this fill ADDED" whenever an
    // earlier fill on the same origin wrote one of them. Taking the return of
    // `registerNeedles` makes the two the same set by construction.
    const engine = SOURCES.find((f) => f.rel === 'src/core/snapshot/engine.ts')!;
    expect(
      engine.code,
      'registerNeedles must hand back what it added, or an undo cannot be ' +
        'precise about what it takes',
    ).toMatch(/export function registerNeedles\([^)]*\):\s*string\[\]/);
    const drop = /export function dropNeedles\([\s\S]{0,600}?\n\}/.exec(engine.code)?.[0] ?? '';
    expect(drop, 'dropNeedles must exist to be checked').not.toBe('');
    expect(
      drop,
      'dropNeedles must not re-derive needle spellings from its argument: the ' +
        'argument is already what the store holds, and re-deriving is how a ' +
        'canonical form gets dropped without its raw twin — or, worse, how a ' +
        'value another fill registered gets dropped by name',
    ).not.toMatch(/needleForms/);

    for (const site of ['src/mcp/tools.ts']) {
      const f = SOURCES.find((x) => x.rel === site)!;
      for (const at of occurrences(f.code, 'dropNeedles(')) {
        const fn = enclosingFunction(f.code, f.raw, at);
        expect(
          fn?.body ?? '',
          `${site}:${lineOf(f.raw, at)}: the value passed to dropNeedles must ` +
            'be what registerNeedles returned, not the list this call site ' +
            'intended to register',
        ).toMatch(/const registered = registerNeedles\(/);
      }
    }
  });

  it('the TTL is one bound, stated once, and the timer is the only thing that expires', () => {
    // Member 3. There is no runtime measurement of this boundary anywhere in
    // the repo, and this assertion does not pretend to be one — it holds the
    // two properties that make the disclosure in security.md true: there is
    // exactly ONE expiry constant, and the thing it schedules is the whole-
    // origin forget rather than some partial decay nobody could reason about.
    const engine = SOURCES.find((f) => f.rel === 'src/core/snapshot/engine.ts')!;
    const constants = [...engine.code.matchAll(/const\s+([A-Z_]*TTL[A-Z_]*)\s*=/g)].map(
      (m) => m[1],
    );
    expect(constants, 'one expiry bound, not two').toEqual(['NEEDLE_TTL_MS']);
    expect(
      engine.code,
      'the TTL must schedule the whole-origin forget; a partial expiry would ' +
        'leave the store in a state no ruling here describes',
    ).toMatch(/setTimeout\(\(\) => needles\.delete\(origin\), NEEDLE_TTL_MS\)/);
  });

  it('a navigation forgets fields and never values', () => {
    // Member 1, asserted at the exact line it was wrong on. `invalidate` may
    // clear taint (DOM fields, genuinely gone with the document) and may not
    // touch the needle store (a VALUE, whose origin outlives the document) —
    // and the page chooses when this function runs, which is the whole reason
    // the distinction is load-bearing rather than tidy.
    const engine = SOURCES.find((f) => f.rel === 'src/core/snapshot/engine.ts')!;
    const at = engine.code.indexOf('tainted.clear(');
    expect(at, 'a document-replacing navigation must still clear taint').toBeGreaterThanOrEqual(0);
    const fn = enclosingFunction(engine.code, engine.raw, at);
    expect(fn?.name, 'and it must be invalidate that does it').toBe('invalidate');
    const body = fn?.body ?? '';
    for (const forbidden of ['clearNeedles', 'dropNeedles', 'clearAllNeedles', 'needles.']) {
      expect(
        body,
        `invalidate must not name ${forbidden}: a document-replacing navigation ` +
          'is an event the PAGE causes, and using it to forget a value makes ' +
          'the delivery of the secret its own off switch (the seventh sink)',
      ).not.toContain(forbidden);
    }
  });
});
