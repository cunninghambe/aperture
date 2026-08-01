import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `npm test` must include the typecheck, because that is where the green comes
 * from.
 *
 * THE RECURRENCE PATH THIS CLOSES. `test/completeness.test.ts` is the
 * congruence tether: its ruling table is typed as
 * `Record<keyof SnapshotNode, Ruling>`, so ADDING A FIELD TO `SnapshotNode`
 * WITHOUT RULING ON IT IS A TYPE ERROR. That is the whole mechanism — and
 * `vitest` does not typecheck. It transforms TypeScript by stripping types and
 * never asks tsc anything, so a contributor who runs `npm test` alone gets a
 * clean green while `propDelta` silently ignores a new rendered field. That is
 * precisely the failure the tether was written to prevent: the diff-completeness
 * promise quietly becoming false, an agent told "unchanged" about a table whose
 * every cell moved (docs/design/review-external-2026-08-01.md §1).
 *
 * Gate 2 raised it as an unenforced dependency; docs/design/tier3.md §4.4 rules
 * on it. The guard has to live in the suite rather than in a CI workflow: this
 * repo has a remote but no CI, and a workflow would not have been running on
 * the machine where the green was read. If CI is ever added it runs the same
 * command and inherits this for free.
 *
 * COST, STATED: this adds roughly 10-20 seconds to every `npm test` run. That
 * is the price of `npm test` meaning what people already believe it means, and
 * it is paid once per run rather than once per file.
 *
 * WHY NOT LITERALLY `npx`: the invocation below is exactly
 * `npx tsc --noEmit -p tsconfig.json` — same compiler, same flags, same
 * tsconfig — resolved through node instead of through npm's shell shim. On
 * Windows `npx` is a `.cmd` and needs `shell: true`, which drags command-string
 * quoting into a path that may contain spaces. Spawning the resolved binary
 * with `process.execPath` has neither problem and is a few seconds faster.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
// .../typescript/lib/typescript.js → .../typescript/bin/tsc, which survives
// whatever the package manager did with hoisting.
const TSC = join(dirname(require_.resolve('typescript')), '..', 'bin', 'tsc');

describe('the repository typechecks', () => {
  it(
    'tsc --noEmit is clean',
    async () => {
      const { code, output } = await run(process.execPath, [
        TSC,
        '--noEmit',
        '-p',
        'tsconfig.json',
      ]);

      // tsc's own report, verbatim. A bare "expected 1 to be 0" would send the
      // reader to run the command by hand to find out what broke.
      expect(code, `tsc --noEmit failed:\n\n${output}`).toBe(0);
    },
    120_000,
  );
});

function run(cmd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ code, output: output || (err ? String(err) : '') });
      },
    );
  });
}
