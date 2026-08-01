import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The README and the handoff may not claim a test COUNT.
 *
 * "187 tests" and "283 tests" were both corrections once, and both were stale
 * again within a week — the number moves every time anyone adds a test, which
 * is the one thing a healthy repo does constantly. A hardcoded copy of it has
 * been wrong twice and flattering never.
 *
 * The number is available to anyone who wants it, from the tool that owns it:
 * `npx vitest run` prints it. What is banned is a SECOND copy in prose, which
 * has no way to stay true. This guard removes the class rather than correcting
 * the instance — the same move as tethering the fidelity reader's field set to
 * the walker's emission set instead of resolving to be more careful.
 *
 * The regex is deliberately blunt: it catches "37 tests cover this" and
 * "verified against RFC 6238 test vectors" alike. A false positive costs one
 * rewritten sentence and the rewritten sentence is durable, which is the trade
 * this guard exists to make. Do not narrow it to rescue a sentence; rewrite the
 * sentence.
 */

const ROOT = join(__dirname, '..');
const COUNT_CLAIM = /\b\d+\s+tests?\b/;

const DOCS = ['README.md', 'docs/HANDOFF.md'];

describe('documentation cannot claim a test count', () => {
  for (const rel of DOCS) {
    it(`${rel} states no number of tests`, () => {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      const offenders = text
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => COUNT_CLAIM.test(line));

      expect(
        offenders.map(({ n, line }) => `${rel}:${n}  ${line.trim()}`),
        'A test count in prose goes stale the next time anyone writes a test. ' +
          'Say what the suite covers, not how many cases it holds; `npx vitest run` ' +
          'is where the number lives.',
      ).toEqual([]);
    });
  }

  it('the guard would actually catch the claims it was written for', () => {
    // The two real ones, from the two files, at the two moments they were true.
    expect(COUNT_CLAIM.test('npm test         # 187 tests, 49 of them on the snapshot engine')).toBe(true);
    expect(COUNT_CLAIM.test('283 tests pass. The browser runs, the MCP server works')).toBe(true);
    expect(COUNT_CLAIM.test('37 tests cover this, including "an unknown top-level field is dropped"')).toBe(true);
    expect(COUNT_CLAIM.test('1 test passes')).toBe(true);
    // And does not fire on prose that merely mentions testing.
    expect(COUNT_CLAIM.test('npm test         # full suite — snapshot engine, security, vault')).toBe(false);
    expect(COUNT_CLAIM.test('The full test suite passes.')).toBe(false);
  });
});
