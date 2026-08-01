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
    expect(m.reason).toBe('no-match');
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
