import { describe, expect, it } from 'vitest';
import {
  meanDiffCI,
  mulberry32,
  propDiffCI,
  smallestDetectableDrop,
  wilson,
} from '../bench/lib/stats.mjs';

/**
 * The statistics the verdict rule is written in.
 *
 * A benchmark whose verdict is produced by an untested interval calculation is
 * a benchmark whose verdict is an assertion. These pin the two properties the
 * verdict actually depends on: that the intervals behave sensibly at the
 * degenerate ends (0/n and n/n, where Wald would hand back a confident lie),
 * and that the bootstrap is REPRODUCIBLE — a run that prints a different
 * interval for the same data is not evidence of anything.
 */

describe('wilson', () => {
  it('matches the published interval for 10/20', () => {
    const w = wilson(10, 20);
    expect(w.p).toBe(0.5);
    expect(w.lo).toBeCloseTo(0.2993, 3);
    expect(w.hi).toBeCloseTo(0.7007, 3);
  });

  it('stays inside [0,1] at both degenerate ends', () => {
    const zero = wilson(0, 20);
    // Floating point puts this at ~1e-17, not at exactly 0. What matters for
    // the verdict is that it never goes negative.
    expect(zero.lo).toBeGreaterThanOrEqual(0);
    expect(zero.lo).toBeCloseTo(0, 12);
    expect(zero.hi).toBeGreaterThan(0);
    expect(zero.hi).toBeLessThan(0.2);

    const all = wilson(20, 20);
    expect(all.hi).toBe(1);
    expect(all.lo).toBeGreaterThan(0.8);
    expect(all.lo).toBeLessThan(1);
  });
});

describe('propDiffCI (Newcombe)', () => {
  it('straddles zero when the arms are identical', () => {
    const ci = propDiffCI(15, 20, 15, 20);
    expect(ci.delta).toBe(0);
    expect(ci.lo).toBeLessThan(0);
    expect(ci.hi).toBeGreaterThan(0);
  });

  it('excludes zero for a large, real difference', () => {
    const ci = propDiffCI(4, 20, 18, 20);
    expect(ci.delta).toBeCloseTo(-0.7, 6);
    expect(ci.hi).toBeLessThan(0);
  });

  it('never reports a bound outside [-1, 1] at the ends', () => {
    const ci = propDiffCI(0, 6, 6, 6);
    expect(ci.lo).toBeGreaterThanOrEqual(-1);
    expect(ci.hi).toBeLessThanOrEqual(1);
  });

  it('two perfect arms produce an interval that cannot reject parity', () => {
    // The ceiling problem, in numbers: this is why G10 exists.
    const ci = propDiffCI(20, 20, 20, 20);
    expect(ci.delta).toBe(0);
    expect(ci.lo).toBeGreaterThan(-0.2);
  });
});

describe('meanDiffCI (seeded bootstrap)', () => {
  it('is reproducible for identical inputs', () => {
    const a = [0, 0, 1, 2, 0, 1];
    const b = [0, 1, 0, 0, 3, 0];
    const one = meanDiffCI(a, b, { iters: 2000 });
    const two = meanDiffCI(a, b, { iters: 2000 });
    expect(one.lo).toBe(two.lo);
    expect(one.hi).toBe(two.hi);
  });

  it('brackets the observed difference', () => {
    const ci = meanDiffCI([2, 2, 2, 2], [0, 0, 0, 0], { iters: 2000 });
    expect(ci.delta).toBe(2);
    expect(ci.lo).toBeLessThanOrEqual(2);
    expect(ci.hi).toBeGreaterThanOrEqual(2);
  });

  it('collapses to a point interval when both samples are constant', () => {
    const ci = meanDiffCI([0, 0, 0], [0, 0, 0], { iters: 500 });
    expect(ci.lo).toBe(0);
    expect(ci.hi).toBe(0);
  });
});

describe('smallestDetectableDrop', () => {
  it('needs a bigger true drop at small n than at large n', () => {
    const small = smallestDetectableDrop(20, 20, 0.8);
    const large = smallestDetectableDrop(200, 200, 0.8);
    expect(small).toBeGreaterThan(large);
    expect(large).toBeGreaterThan(0);
  });
});

describe('mulberry32', () => {
  it('is deterministic and stays in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 50; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
