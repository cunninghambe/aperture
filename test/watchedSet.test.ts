import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { hashTree } from '../bench/headtohead/lib/h2hStore.mjs';
import { buildIdentity } from '../bench/lib/store.mjs';

/**
 * THE WATCHED-SET POLLUTION CLASS (docs/design/harness-debt.md WO-C1).
 *
 * `bench/fixtures/` is inside the content hash of BOTH scored suites, and the
 * two suites hash it with DIFFERENT RECURSION:
 *
 *   - the h2h identity hashes it RECURSIVELY (`hashTree`, h2hStore.mjs), so a
 *     file one directory deep moves its `codeVersion`;
 *   - the task identity hashes it NON-RECURSIVELY (`hashFileSet`, store.mjs
 *     skips directories), so the same file is invisible to it.
 *
 * That asymmetry is the trap: a fixture dropped one level down severs one
 * scored suite and not the other, and nothing anywhere says so. It already
 * happened — the darkmode bench's three fixtures and the WebBotAuth dev key
 * landed under `bench/fixtures/` and silently moved the h2h `codeVersion` from
 * `dfa962c3f89b4d53` to `8d282bdbf37a6bfa` while nobody was looking. It cost
 * nothing only because no cohort was in flight.
 *
 * These two assertions are the class guard at rest: one per identity, because a
 * test that checked only one would re-create the asymmetry it exists to close.
 * They were written RED — both failed at HEAD before the fixtures moved out.
 *
 * The complementary live guard is in `bench/darkmode.mjs`, which refuses to
 * start if its own fixture dir appears in either watched table (the precedent is
 * `bench/size.mjs`'s `--dry` separation check). A bench that can quietly sever a
 * scored cohort is a bench nobody can trust the next cohort of.
 */
const ROOT = resolve(__dirname, '..');

describe('the scored suites\' watched set holds no other bench\'s fixtures', () => {
  it('H2H (recursive hashTree): nothing under bench/fixtures/darkmode/ is watched', () => {
    const watched = hashTree(ROOT, resolve(ROOT, 'bench', 'fixtures'));
    const intruders = watched
      .map((f: { path: string }) => f.path)
      .filter((p: string) => p.startsWith('bench/fixtures/darkmode/'));
    expect(intruders).toEqual([]);
  });

  it('H2H (recursive hashTree): every watched bench/fixtures file is a fixture or the witness', () => {
    // The recursive half of the same rule as the task assertion below. Stated
    // separately because `hashTree` sees files `hashFileSet` cannot, so an
    // intruder in a NEW subdirectory would slip past a darkmode-specific check.
    const watched = hashTree(ROOT, resolve(ROOT, 'bench', 'fixtures'));
    const wrongKind = watched
      .map((f: { path: string }) => f.path)
      .filter((p: string) => !/\.(html|js)$/.test(p));
    expect(wrongKind).toEqual([]);
  });

  it('TASK (non-recursive hashFileSet): every watched bench/fixtures file is .html or .js', () => {
    // The fixtures and `bench.js` (the witness) are the only things that belong
    // in that directory. The WebBotAuth dev key was neither — it was a seed for
    // a different bench that happened to be parked there.
    const identity = buildIdentity({
      root: ROOT,
      model: 'test',
      systemPrompt: '',
      tasks: [],
      verdictRule: {},
    });
    const wrongKind = identity.files
      .map((f: { path: string }) => f.path)
      .filter((p: string) => p.startsWith('bench/fixtures/') && !/\.(html|js)$/.test(p));
    expect(wrongKind).toEqual([]);
  });
});
