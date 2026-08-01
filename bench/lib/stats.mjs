/**
 * The statistics the verdict rule is written in.
 *
 * Two quantities, two different shapes of data, so two different intervals:
 *
 *   success rate   — a proportion. Newcombe's hybrid-score interval for the
 *                    difference of two independent proportions. Chosen over the
 *                    Wald interval because Wald is badly wrong exactly where
 *                    this suite is likely to sit: near 0 or near 1, where it can
 *                    put a bound outside [-1, 1] and hand back a confident
 *                    PARITY from a degenerate sample.
 *
 *   wrong-element  — a count per run, not a proportion. Percentile bootstrap on
 *                    the difference of means, seeded so a rerun of the same data
 *                    prints the same interval. A benchmark whose verdict moves
 *                    when you run it twice on identical inputs is not evidence.
 */

/** Deterministic PRNG. The bootstrap must not make the verdict irreproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const Z95 = 1.959963984540054;

/** Wilson score interval for x successes in n trials. */
export function wilson(x, n, z = Z95) {
  if (n === 0) return { p: 0, lo: 0, hi: 1 };
  const p = x / n;
  const z2 = z * z;
  const denom = n + z2;
  const centre = (x + z2 / 2) / denom;
  const half = (z / denom) * Math.sqrt((x * (n - x)) / n + z2 / 4);
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Newcombe hybrid-score interval for p1 - p2 (independent samples).
 * Returns the interval for (arm1 − arm2).
 */
export function propDiffCI(x1, n1, x2, n2, z = Z95) {
  const a = wilson(x1, n1, z);
  const b = wilson(x2, n2, z);
  const delta = a.p - b.p;
  const lo = delta - Math.sqrt((a.p - a.lo) ** 2 + (b.hi - b.p) ** 2);
  const hi = delta + Math.sqrt((a.hi - a.p) ** 2 + (b.p - b.lo) ** 2);
  return { delta, lo: Math.max(-1, lo), hi: Math.min(1, hi), p1: a.p, p2: b.p };
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Percentile bootstrap CI for mean(xs1) - mean(xs2).
 * `seed` is fixed by the caller; identical inputs give identical output.
 */
export function meanDiffCI(xs1, xs2, { iters = 10000, seed = 20260731, alpha = 0.05 } = {}) {
  const delta = mean(xs1) - mean(xs2);
  if (!xs1.length || !xs2.length) return { delta, lo: -Infinity, hi: Infinity, m1: mean(xs1), m2: mean(xs2) };
  const rnd = mulberry32(seed);
  const deltas = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s1 = 0;
    for (let k = 0; k < xs1.length; k++) s1 += xs1[(rnd() * xs1.length) | 0];
    let s2 = 0;
    for (let k = 0; k < xs2.length; k++) s2 += xs2[(rnd() * xs2.length) | 0];
    deltas[i] = s1 / xs1.length - s2 / xs2.length;
  }
  deltas.sort((a, b) => a - b);
  const lo = deltas[Math.floor((alpha / 2) * iters)];
  const hi = deltas[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)];
  return { delta, lo, hi, m1: mean(xs1), m2: mean(xs2) };
}

/**
 * The honest power statement, computed rather than asserted.
 *
 * Given the sample sizes actually collected and a re-dump success rate of p2,
 * the smallest true drop this suite could distinguish from zero is the smallest
 * d such that the Newcombe interval for (p2−d) vs p2 excludes the parity margin.
 * Searched numerically because there is no closed form for Newcombe.
 */
export function smallestDetectableDrop(n1, n2, p2, margin = -0.05) {
  for (let d = 0; d <= 1.0001; d += 0.005) {
    const x1 = Math.round((p2 - d) * n1);
    if (x1 < 0) return 1;
    const ci = propDiffCI(x1, n1, Math.round(p2 * n2), n2);
    if (ci.hi < margin) return d;
  }
  return 1;
}

export const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;
export const fmtSigned = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
