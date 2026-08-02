/**
 * The competitor, as a process this harness owns end to end.
 *
 * WHY STDIO AND NOT HTTP (headtohead.md §8): Playwright MCP's HTTP mode wants a
 * real MCP session handshake, and the aperture side of this suite talks raw
 * JSON-RPC over Streamable HTTP with no client library at all. Rather than
 * reimplement a handshake, this speaks stdio through the MCP SDK's own client —
 * which does the handshake — and stdio needs no port, so the competitor cannot
 * collide with 8817/8894/8898/8899 however many arms are alive at once.
 *
 * THE LAUNCH FLAGS ARE DATA, NOT PROSE. `headtohead.md` §3.2/§3.4 fixes them,
 * H0 byte-compares what actually ran against what is written here, and every
 * episode carries the array verbatim. A flag that drifts silently is a different
 * competitor measured under the old name.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createWriteStream, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);

/** The pin. H0 refuses any store whose episodes were made against another. */
export const PW_PINNED_VERSION = '0.0.78';

export const H2H_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * Both packages publish an `exports` map with no `./package.json` and no
 * `./cli.js` entry, so every subpath here is reached from the resolved MAIN
 * rather than by subpath specifier. Measured, not assumed: the specifier form
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED under node 22.
 */
const pkgDirOf = (spec) => dirname(require_.resolve(spec, { paths: [H2H_DIR] }));

export function pwPackageVersion() {
  const p = join(pkgDirOf('@playwright/mcp'), 'package.json');
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

export function pwCliPath() {
  return join(pkgDirOf('@playwright/mcp'), 'cli.js');
}

/**
 * The chromium the competitor actually drives, read from the PINNED
 * playwright-core's own `browsers.json` rather than from a directory listing —
 * several chromium builds are routinely present on a dev box and only the
 * revision this playwright-core asks for is the one under test.
 */
export function chromiumBuild() {
  try {
    const dir = pkgDirOf('playwright-core');
    const core = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const browsers = JSON.parse(readFileSync(join(dir, 'browsers.json'), 'utf8'));
    const c = (browsers.browsers ?? []).find((b) => b.name === 'chromium');
    return {
      playwrightCore: core.version,
      name: c?.name ?? 'chromium',
      revision: c?.revision ?? null,
      browserVersion: c?.browserVersion ?? null,
    };
  } catch (e) {
    return { name: 'chromium', revision: null, probeError: String(e?.message ?? e) };
  }
}

/**
 * §3.2, verbatim, in the order the spec writes them. `--browser chromium`:
 * 0.0.78's generated option table lists "chrome, firefox, webkit, msedge" and
 * NOT chromium, while the same README's docker example passes `chromium` — so
 * this string is asserted live by H0 rather than trusted, and the probe's
 * finding is recorded on the cohort.
 */
export function sealedLaunchFlags(outputDir) {
  return [
    '--isolated',
    '--browser', 'chromium',
    '--caps', 'vision',
    '--codegen', 'none',
    '--snapshot-mode', 'full',
    '--output-dir', outputDir,
    // NOT IN §3.2's list, and load-bearing — see H1. Measured on 0.0.78: with
    // `--output-dir` set, a response's snapshot comes back as
    // `- [Snapshot](results\\pw-out\\…\\page-….yml)` — a FILE LINK, not the
    // aria bytes — even though the generated option table says
    // `--output-mode` defaults to "stdout". The agent under test has no
    // filesystem, so a link is an empty observation: the pw arms would have
    // measured a competitor that shows the model nothing. Forced to `stdout`,
    // which is the documented default and therefore not a configuration
    // advantage handed to either side.
    '--output-mode', 'stdout',
    '--viewport-size', '1280x720',
    '--allowed-origins', 'http://127.0.0.1:8899;http://127.0.0.1:8898',
  ];
}

/**
 * §3.4: "Launch flags as §3.2 but no `--caps vision` and default codegen
 * (typescript): stock means the default experience, and the codegen tokens are
 * part of what stock costs."
 */
export function stockLaunchFlags(outputDir) {
  return [
    '--isolated',
    '--browser', 'chromium',
    '--snapshot-mode', 'full',
    '--output-dir', outputDir,
    // NOT IN §3.2's list, and load-bearing — see H1. Measured on 0.0.78: with
    // `--output-dir` set, a response's snapshot comes back as
    // `- [Snapshot](results\\pw-out\\…\\page-….yml)` — a FILE LINK, not the
    // aria bytes — even though the generated option table says
    // `--output-mode` defaults to "stdout". The agent under test has no
    // filesystem, so a link is an empty observation: the pw arms would have
    // measured a competitor that shows the model nothing. Forced to `stdout`,
    // which is the documented default and therefore not a configuration
    // advantage handed to either side.
    '--output-mode', 'stdout',
    '--viewport-size', '1280x720',
    '--allowed-origins', 'http://127.0.0.1:8899;http://127.0.0.1:8898',
  ];
}

export const launchFlagsFor = (arm, outputDir) =>
  arm === 'pw-stock' ? stockLaunchFlags(outputDir) : sealedLaunchFlags(outputDir);

/**
 * Start one Playwright MCP server and hold it for the whole arm.
 *
 * One process per arm per run, `--isolated`, per-episode freshness by
 * navigation with a cache-buster — exactly Aperture's discipline on the other
 * side, because per-episode process churn would put a browser cold start inside
 * one arm's wall-clock and not the other's.
 *
 * stderr is PIPED and kept. The aperture side learned this the expensive way
 * (bench/lib/aperture.mjs's header): chromium reports GPU-process death on
 * stderr, and a harness that throws that away cannot ever say what happened.
 */
export async function startPw({ arm, outputDir, logPath = null, onStderr = null, browserOverride = null }) {
  const flags = launchFlagsFor(arm, outputDir);
  // DIAGNOSTIC ESCAPE ONLY, never used by a scored phase: H0 records the flags
  // that actually ran, so an override lands in the cohort and in the report
  // rather than hiding. It exists because the pinned chromium's launchability
  // is a machine property, not a spec property (see H0's preflight note).
  if (browserOverride) {
    const i = flags.indexOf('--browser');
    if (i >= 0) flags[i + 1] = browserOverride;
  }
  const cli = pwCliPath();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, ...flags],
    stderr: 'pipe',
    cwd: H2H_DIR,
  });

  let stderrTail = '';
  const sink = logPath ? createWriteStream(logPath, { flags: 'a' }) : null;
  transport.stderr?.on('data', (d) => {
    const s = String(d);
    stderrTail = (stderrTail + s).slice(-64 * 1024);
    if (sink) sink.write(s);
    if (onStderr) onStderr(s);
  });

  const client = new Client({ name: 'aperture-h2h', version: '0.1.0' });
  await client.connect(transport);

  const listed = await client.listTools();
  const tools = listed.tools ?? [];

  /**
   * One tool call, flattened to the text the agent would read.
   *
   * `isError` is folded into the text rather than thrown: the aperture upstream
   * returns error text too, and an exception on one side and a string on the
   * other would make the two arms' attribution incomparable at the very point
   * the comparison matters.
   */
  async function call(name, args = {}) {
    const t0 = Date.now();
    let res;
    try {
      res = await client.callTool({ name, arguments: args });
    } catch (e) {
      return {
        text: `error: [harness] playwright transport failed: ${e?.message ?? e}`,
        upstreamMs: Date.now() - t0,
        transportFault: true,
      };
    }
    const text = (res.content ?? [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { text, upstreamMs: Date.now() - t0, isError: res.isError === true };
  }

  return {
    arm,
    flags,
    cli,
    tools,
    call,
    stderr: () => stderrTail,
    pid: () => transport.pid,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* the process is going away regardless */
      }
      sink?.end();
    },
  };
}

/** Where a run's playwright scratch goes. Never inside the fixture roots. */
export const pwScratchDir = (stamp, arm) =>
  join(H2H_DIR, 'results', 'pw-out', `${stamp}.${arm}`);
