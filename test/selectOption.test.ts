import { describe, expect, it } from 'vitest';
import { describe as describeOption, matchOption } from '../src/core/snapshot/selectOption.js';
import type { OptionInfo } from '../src/core/snapshot/selectOption.js';

/**
 * Option matching is a safety module, not a convenience one: everything it
 * decides is a decision about whether to put a value the human did not ask for
 * into a form the human will submit. So the tests are mostly about refusals.
 */

function opts(...specs: (string | Partial<OptionInfo>)[]): OptionInfo[] {
  return specs.map((s, index) =>
    typeof s === 'string'
      ? { text: s, value: s, index }
      : { text: '', value: '', index, ...s },
  );
}

const COUNTRIES = opts(
  { text: 'United Kingdom', value: 'GB' },
  { text: 'United States', value: 'US' },
  { text: 'United States Minor Outlying Islands', value: 'UM' },
  { text: 'Uruguay', value: 'UY' },
);

describe('matchOption — exact before loose', () => {
  it('selects "United States" uniquely and never reaches the prefix tier', () => {
    // THE trap. "United States" is a prefix of "United States Minor Outlying
    // Islands", so a prefix-first matcher makes the commonest option on a
    // country list unselectable — ambiguous forever, with no way to phrase it.
    const m = matchOption(COUNTRIES, 'United States');
    expect(m).toEqual({ ok: true, index: 1, tier: 1 });
  });

  it('still matches the long one when it is named in full', () => {
    expect(matchOption(COUNTRIES, 'United States Minor Outlying Islands')).toEqual({
      ok: true,
      index: 2,
      tier: 1,
    });
  });

  it('matches on value when no label matches', () => {
    expect(matchOption(COUNTRIES, 'UY')).toEqual({ ok: true, index: 3, tier: 2 });
  });

  it('prefers a label over a value that collides with it', () => {
    // One option's value is another option's label. Label is tier 1, value is
    // tier 2, so the human-visible text wins — which is what the agent read.
    const list = opts({ text: 'Alpha', value: 'beta' }, { text: 'Beta', value: 'x' });
    expect(matchOption(list, 'Beta')).toEqual({ ok: true, index: 1, tier: 1 });
  });

  it('relaxes case only after both exact tiers have failed', () => {
    expect(matchOption(COUNTRIES, 'united kingdom')).toEqual({ ok: true, index: 0, tier: 3 });
    expect(matchOption(COUNTRIES, 'gb')).toEqual({ ok: true, index: 0, tier: 4 });
  });

  it('accepts an unambiguous prefix last of all', () => {
    expect(matchOption(COUNTRIES, 'Urug')).toEqual({ ok: true, index: 3, tier: 5 });
  });

  it('normalizes whitespace on both sides', () => {
    const list = opts({ text: '  New   Zealand\n', value: 'NZ' });
    expect(matchOption(list, 'New Zealand')).toEqual({ ok: true, index: 0, tier: 1 });
  });
});

describe('matchOption — ambiguity is an error, never a guess', () => {
  it('stops at the tier that was ambiguous instead of falling through', () => {
    // Two options really are called "Melbourne". Falling through to a looser
    // tier would find one of them by some other route and select it, which is
    // guessing with extra steps.
    const list = opts(
      { text: 'Melbourne', value: 'mel-au' },
      { text: 'Melbourne', value: 'mel-us' },
    );
    const m = matchOption(list, 'Melbourne');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.reason).toBe('ambiguous');
    if (m.reason !== 'ambiguous') throw new Error('unreachable');
    expect(m.tier).toBe(1);
    // The candidates have to be distinguishable, or the agent's next call
    // cannot be any more specific than the one that just failed.
    expect(m.candidates).toEqual([
      '"Melbourne" (value "mel-au")',
      '"Melbourne" (value "mel-us")',
    ]);
  });

  it('refuses an ambiguous prefix', () => {
    const m = matchOption(COUNTRIES, 'United');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.reason).toBe('ambiguous');
    if (m.reason !== 'ambiguous') throw new Error('unreachable');
    expect(m.tier).toBe(5);
    expect(m.candidates).toHaveLength(3);
  });
});

describe('matchOption — near misses are refused, with a suggestion', () => {
  it('does not select "Victoria" for "Victora"', () => {
    const list = opts('Victoria', 'Queensland', 'Tasmania');
    const m = matchOption(list, 'Victora');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.reason).toBe('no-match');
    if (m.reason !== 'no-match') throw new Error('unreachable');
    expect(m.suggestions).toContain('"Victoria"');
  });

  it('has no substring tier: "States" selects nothing', () => {
    const m = matchOption(COUNTRIES, 'States');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.reason).toBe('no-match');
  });

  it('offers something to look at even when nothing is close', () => {
    const m = matchOption(opts('Alpha', 'Beta'), 'zzzzz');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    if (m.reason !== 'no-match') throw new Error('unreachable');
    expect(m.suggestions.length).toBeGreaterThan(0);
  });
});

describe('matchOption — options a human could not choose', () => {
  it('refuses a disabled option instead of setting it through the DOM', () => {
    const list = opts(
      { text: 'Standard', value: 's' },
      { text: 'Express', value: 'e', disabled: true },
    );
    const m = matchOption(list, 'Express');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.reason).toBe('disabled');
    if (m.reason !== 'disabled') throw new Error('unreachable');
    expect(m.label).toBe('Express');
  });

  it('reports an empty select as empty rather than as a bad query', () => {
    expect(matchOption([], 'anything')).toEqual({ ok: false, reason: 'empty' });
  });

  it('does not match the empty string by prefix', () => {
    // Every label starts with "", so an unguarded prefix tier would make an
    // empty query ambiguous across the whole list — or worse, select item 0.
    const m = matchOption(opts('Alpha', 'Beta'), '');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.reason).toBe('blank-query');
  });

  it('refuses a blank query on the placeholder select it used to reset', () => {
    // The test above passed for the wrong reason: `opts('Alpha','Beta')` makes
    // value === text, so no option had an empty value and the empty query fell
    // through to no-match. Add the <option value=""> every country picker on
    // the web starts with and the exact-VALUE tier matches it — silently
    // resetting a field the human is about to submit.
    const placeholder = opts(
      { text: '-- Choose a country --', value: '' },
      { text: 'Australia', value: 'AU' },
    );
    for (const q of ['', '   ', '\n\t ']) {
      const m = matchOption(placeholder, q);
      expect(m.ok).toBe(false);
      if (m.ok) throw new Error('unreachable');
      expect(m.reason).toBe('blank-query');
    }
  });

  it('still lets the placeholder be chosen when it is named', () => {
    const placeholder = opts(
      { text: '-- Choose a country --', value: '' },
      { text: 'Australia', value: 'AU' },
    );
    expect(matchOption(placeholder, '-- Choose a country --')).toEqual({
      ok: true,
      index: 0,
      tier: 1,
    });
  });
});

describe('matchOption — what comes back is bounded and neutralized', () => {
  const long = (n: number, tag: string) =>
    opts(
      ...Array.from({ length: n }, (_, i) => ({
        text: `${tag} option ${i} — ${'a very long option label '.repeat(12)}`,
        value: `v${i}`,
      })),
    );

  it('caps an ambiguous candidate list instead of dumping the whole select', () => {
    // Measured before the cap: an ambiguous 1-character query against an
    // 800-option select returned 36,031 chars (~9k tokens) — more than a
    // browser_read of the same element, which IS capped.
    const m = matchOption(long(800, 'x'), 'x');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    if (m.reason !== 'ambiguous') throw new Error('unreachable');
    expect(m.matched).toBe(800); // the count stays honest
    expect(m.candidates.length).toBeLessThanOrEqual(8);
    expect(m.candidates.join('\n').length).toBeLessThan(2000);
  });

  it('caps a no-match suggestion list the same way', () => {
    const m = matchOption(long(6, 'y'), 'zzzz');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    if (m.reason !== 'no-match') throw new Error('unreachable');
    expect(m.suggestions.join('\n').length).toBeLessThan(1200);
  });

  it('does NOT cap the browser_read listing, which must stay nameable', () => {
    // The cap is right for an error (the page must not choose our token cost)
    // and wrong for the listing (the agent has to be able to copy a label back
    // into action:"select", and nothing matches a string ending in an
    // ellipsis). browser_read bounds its own total with maxChars.
    const long = 'a very long option label '.repeat(20).trim();
    const capped = describeOption({ text: long, value: 'v', index: 0 });
    const full = describeOption({ text: long, value: 'v', index: 0 }, { full: true });
    expect(capped).toContain('…');
    expect(capped.length).toBeLessThan(120);
    expect(full).not.toContain('…');
    expect(full).toContain(long);
    // Neutralization is NOT part of what `full` relaxes.
    const bidi = describeOption({ text: '‮x‬', value: 'v', index: 0 }, { full: true });
    expect(bidi).not.toContain('‮');
  });

  it('neutralizes page-authored labels instead of reproducing them raw', () => {
    // A label containing a bare quote plus `[disabled]` used to render as a
    // second, differently-named option that appeared unusable — a page writing
    // Aperture's own error vocabulary. Bidi overrides survived too, while the
    // snapshot line for the same option escaped them correctly.
    const forged = describeOption({
      text: 'Beta" [disabled] and "Gamma',
      value: 't2',
      index: 0,
    });
    expect(forged).toBe('"Beta\\" [disabled] and \\"Gamma" (value "t2")');

    const bidi = describeOption({ text: '‮reversed‬', value: 't3', index: 0 });
    expect(bidi).not.toContain('‮');
    expect(bidi).not.toContain('‬');
  });
});

describe('matchOption — unicode', () => {
  it('matches across NFC and NFD spellings of the same label', () => {
    // Fails closed today, which is the right direction — but the suggestion it
    // then offers is byte-different and screen-identical to what the agent
    // asked for, which is a loop the agent cannot get out of.
    const nfc = 'Café au lait'.normalize('NFC');
    const nfd = 'Café au lait'.normalize('NFD');
    expect(nfc).not.toBe(nfd); // the premise

    expect(matchOption(opts({ text: nfc, value: 'c' }), nfd)).toEqual({
      ok: true,
      index: 0,
      tier: 1,
    });
    expect(matchOption(opts({ text: nfd, value: 'c' }), nfc)).toEqual({
      ok: true,
      index: 0,
      tier: 1,
    });
  });
});

describe('describe — how an option is named back', () => {
  it('carries the value only when it differs from the label', () => {
    expect(describeOption({ text: 'Large', value: 'Large', index: 0 })).toBe('"Large"');
    expect(describeOption({ text: 'Large', value: 'l', index: 0 })).toBe('"Large" (value "l")');
  });

  it('shows the group and the disabled state', () => {
    expect(
      describeOption({ text: 'Express', value: 'e', index: 0, group: 'Fast', disabled: true }),
    ).toBe('"Express" (value "e") in "Fast" [disabled]');
  });
});
