/**
 * Starting and stopping the Aperture the bench owns — and KEEPING ITS LOG.
 *
 * Extracted from bench/task.mjs for one reason, and it is not tidiness
 * (docs/design/tier3.md §2.1): the wave-2 wedge's root cause is permanently
 * undecidable because the child's stdout and stderr were held in a string in
 * memory, used once for a startup-failure message, and thrown away when the
 * process exited. Chromium reports GPU-process death and relaunch on stderr.
 * That was the single most likely record of what happened, and the harness
 * discarded it while spending $2.16 measuring the aftermath.
 *
 * So `startAperture` now writes every byte the child emits to
 * `bench/task/results/aperture.<stamp>.log`, one file per Aperture start,
 * never truncated and never rotated — a wave starts one or two of them. The
 * in-memory tail is kept as well, because the startup-failure message has to
 * work before the file is worth reading, but it is now BOUNDED: the file is
 * the complete record, so holding hours of Chromium chatter in a string buys
 * nothing.
 *
 * `bench/fidelity.mjs` and the other spawners are deliberately NOT refactored
 * onto this module in this bundle. Smallest blast radius, and the multi-hour
 * path is the one that needs the log.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const APERTURE_PORT = 8817;

/** Bytes of child output kept in memory for the startup-failure message. */
const TAIL_LIMIT = 64 * 1024;

/**
 * A filename-safe ISO stamp: `20260803T141522Z`. Shared by the Aperture log
 * and the apparatus sampler's jsonl so the two artifacts of one run are
 * obviously one run's (§2.2).
 */
export function runStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export async function portIsOpen(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(700) });
    return true;
  } catch (e) {
    // A refused connection is "closed"; anything else (a 401, a 404, a reset
    // mid-response) means something IS listening.
    return !/ECONNREFUSED|refused/i.test(String(e?.cause?.code ?? e?.message ?? ''));
  }
}

export function readApertureToken() {
  const p = join(process.env.APPDATA ?? '', 'aperture', 'mcp.json');
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const auth = cfg?.mcpServers?.aperture?.headers?.Authorization ?? '';
    return auth.replace(/^Bearer /, '') || null;
  } catch {
    return null;
  }
}

export async function tokenWorks(token, port = APERTURE_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.text();
    return body.includes('browser_act');
  } catch {
    return false;
  }
}

/**
 * Start the Aperture this run owns, and do not return until it answers.
 *
 * @param {{root: string, stamp?: string, logDir?: string}} o
 * @returns {Promise<{child: any, token: string, log: () => string, logPath: string, stamp: string}>}
 */
export async function startAperture({ root, stamp = runStamp(), logDir = null }) {
  if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js is missing — run `npx electron-vite build` first');
  }

  const dir = logDir ?? join(root, 'bench', 'task', 'results');
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `aperture.${stamp}.log`);
  const sink = createWriteStream(logPath, { flags: 'a' });
  sink.on('error', (e) => console.log(`  (aperture log write failed: ${e.message})`));
  sink.write(
    `# aperture child log — started ${new Date().toISOString()} from ${dirname(join(root, 'out'))}\n`,
  );

  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  let tail = '';
  const take = (d) => {
    // Both sinks, always. The file is the record; the tail is what the
    // startup-failure message can print before anyone opens the file.
    //
    // The bearer token is redacted at the write point. The token is per-launch
    // and the results dir is gitignored, so the exposure was already small —
    // but a log that gets pasted into a bug report should not need a scrub
    // pass first. Safe to scrub here: readApertureToken() takes the token
    // from %APPDATA%/aperture/mcp.json, never from this log or the tail.
    const scrubbed = String(d).replace(/Bearer [A-Za-z0-9_-]+/g, 'Bearer [redacted]');
    sink.write(scrubbed);
    tail += scrubbed;
    if (tail.length > TAIL_LIMIT) tail = tail.slice(-TAIL_LIMIT);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('exit', (code, signal) => {
    sink.write(`\n# child exited code=${code} signal=${signal} at ${new Date().toISOString()}\n`);
    sink.end();
  });

  console.log(`aperture log: ${logPath}`);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const token = readApertureToken();
    if (token && (await tokenWorks(token))) {
      return { child, token, log: () => tail, logPath, stamp };
    }
  }
  throw new Error(
    `Aperture did not come up on ${APERTURE_PORT} within 60s.\n` +
      `full child output: ${logPath}\n${tail.slice(-2000)}`,
  );
}

/**
 * Kill the Aperture this run started, and do not return until it is gone.
 *
 * The await is load-bearing and was measured, not assumed. This used to fire
 * `taskkill` and return immediately, and `main()` then called `process.exit()`
 * before the kill had landed — so a completed run routinely left an Aperture
 * holding 8817 and the NEXT invocation died on the port check with exit 3.
 * Survivable when the suite was run once; not survivable when the whole point
 * is running it in five phases back to back.
 */
export async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((done) => {
    try {
      if (process.platform !== 'win32') {
        child.kill('SIGTERM');
        done();
        return;
      }
      // The child is the npx shell wrapper; /T is what reaches Electron under it.
      const t = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      t.on('exit', done);
      t.on('error', done);
      setTimeout(done, 10000).unref();
    } catch {
      done();
    }
  });
  // Verified against the port rather than against the exit code of taskkill: a
  // successful taskkill on a wrapper that has already lost track of its child
  // reports success and leaves the listener up.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await portIsOpen(APERTURE_PORT))) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(
    `\nWARNING: Aperture is STILL listening on ${APERTURE_PORT} after the teardown. The next\n` +
      '         phase will refuse to start. Run: taskkill //F //IM electron.exe',
  );
}
