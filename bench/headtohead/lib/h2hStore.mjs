/**
 * The head-to-head episode store and its refuse-to-pool guard.
 *
 * Modeled on `bench/lib/store.mjs`, and the I/O half is IMPORTED from it rather
 * than copied — one definition of "append an episode", "archive a cohort",
 * "a malformed line is reported, never skipped". What is new here is the
 * IDENTITY: this experiment has a second product in it, so a cohort is only
 * poolable if BOTH engines and the harness between them were the same.
 *
 * §8's identity list, implemented field for field:
 *   bench/headtohead/**            the harness, hashed
 *   the two fixture dirs           home (bench/fixtures) and neutral
 *   aperture buildVersion          out/main + out/preload — the code that ran
 *   pw version                     the pin, 0.0.78
 *   chromium build                 the browser the competitor drove
 *   model                          claude-sonnet-5
 *   prompt / description hashes    per task, so one edited prompt names itself
 *   verdict rule                   the preregistered thresholds
 *   arm definitions                the exact forcing rules, as prose
 *
 * AND ONE THE SPEC DID NOT ANTICIPATE, because 0.0.78 did not behave as §1.1
 * describes: `pwObservationMode`. The harness can either resolve Playwright's
 * snapshot file links into the response (the design of record's premise) or
 * leave them (0.0.78 as a filesystem-less agent receives it). Those are two
 * different experiments and they must never pool, so the mode is in the stamp.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export {
  appendEpisode,
  archiveStore,
  cohortPathFor,
  loadCohort,
  loadStore,
  writeCohort,
} from '../../lib/store.mjs';

/** Hand-bumped when a change to how an h2h episode is produced or scored is
 *  deliberate and old episodes should not pool with new ones. */
export const H2H_SUITE_VERSION = '2026-08-02.1';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Every file under a directory, recursively, sorted — the harness IS the
 *  experiment here, so all of it is hashed. `node_modules`, `results` and the
 *  lockfile are excluded: dependency BYTES are not the experiment (the pinned
 *  VERSIONS are, and they are stamped separately), and hashing the store into
 *  the store's own identity is a fixed-point nobody wants. `.agent-cwd` is
 *  excluded for the same fixed-point reason, learned the hard way: the SDK
 *  runner writes into it DURING a phase, so hashing it made phase 1 sever its
 *  own cohort before phase 2 could start — the harness's runtime exhaust is
 *  not the experiment either. */
const SKIP_DIRS = new Set(['node_modules', 'results', '.playwright-mcp', '.agent-cwd']);
const SKIP_FILES = new Set(['package-lock.json']);

function walk(root, dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(root, p, out);
    else out.push({ path: relative(root, p).replace(/\\/g, '/'), hash: sha(readFileSync(p)) });
  }
}

export function hashTree(root, dir) {
  const out = [];
  if (!existsSync(dir)) return [{ path: relative(root, dir).replace(/\\/g, '/') + '/', hash: 'MISSING-DIR' }];
  walk(root, dir, out);
  return out;
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Aperture's built artifacts, hashed with the SAME rule bench/lib/store.mjs
 * uses, so `buildVersion` here and `buildVersion` in the task suite are the
 * same number for the same build. H0 prints both and a human can compare them
 * by eye — which is the only cross-suite check that costs nothing.
 */
export function apertureBuildVersion(root) {
  const files = [];
  const preload = join(root, 'out', 'preload');
  if (existsSync(preload)) {
    for (const n of readdirSync(preload).sort()) {
      if (!/\.cjs$/.test(n)) continue;
      files.push({ path: `out/preload/${n}`, hash: sha(readFileSync(join(preload, n))) });
    }
  } else files.push({ path: 'out/preload/', hash: 'MISSING-DIR' });
  const main = join(root, 'out', 'main', 'index.js');
  files.push({ path: 'out/main/index.js', hash: existsSync(main) ? sha(readFileSync(main)) : 'MISSING' });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    digest: sha(files.map((f) => `${f.path} ${f.hash}`).join('\n')).slice(0, 16),
    files,
  };
}

export function buildH2hIdentity({
  root,
  h2hDir,
  model,
  systemPrompts,
  tasks,
  verdictRule,
  pwVersion,
  chromium,
  pwObservationMode,
  launchFlags,
}) {
  const harness = hashTree(root, h2hDir);
  const homeFixtures = hashTree(root, join(root, 'bench', 'fixtures'));
  const neutralFixtures = harness.filter((f) => f.path.includes('/fixtures/'));
  const build = apertureBuildVersion(root);

  const all = [...harness, ...homeFixtures].sort((a, b) => (a.path < b.path ? -1 : 1));
  const codeVersion = sha(all.map((f) => `${f.path} ${f.hash}`).join('\n')).slice(0, 16);

  const promptHashes = {};
  for (const t of tasks) {
    const sp = systemPrompts[t.armPromptKey ?? 'sealed'] ?? systemPrompts.sealed;
    promptHashes[t.id] = sha(`${sp} ${t.prompt}`).slice(0, 16);
  }

  return {
    suiteVersion: H2H_SUITE_VERSION,
    codeVersion,
    buildVersion: build.digest,
    model,
    verdictRule,
    promptHashes,
    pwVersion,
    chromium,
    pwObservationMode,
    launchFlags,
    files: [...all, ...build.files],
    neutralFixtureCount: neutralFixtures.length,
    gitSha: git(root, ['rev-parse', '--short', 'HEAD']),
    treeDirty: (git(root, ['status', '--porcelain']) ?? '').length > 0,
  };
}

export function defaultH2hStorePath(h2hDir) {
  return join(h2hDir, 'results', 'episodes.jsonl');
}

/** The resume key. Present in the store means already run; do not run it again. */
export function h2hEpisodeKey({ task, arm, runIndex, codeVersion, model }) {
  return [task, arm, runIndex, codeVersion, model].join(' ');
}

const CHECKED = [
  'codeVersion', 'buildVersion', 'suiteVersion', 'model', 'promptHash',
  'armDefinition', 'verdictRule', 'toolsHash', 'pwVersion', 'chromiumRevision',
  'pwObservationMode',
];

const LABEL = {
  codeVersion: 'codeVersion       (bench/headtohead/** + both fixture dirs)',
  buildVersion: 'buildVersion      (out/main, out/preload — the Aperture that ran)',
  suiteVersion: 'suiteVersion      (hand-bumped)',
  model: 'model',
  promptHash: 'promptHash        (system prompt + this task\'s instruction)',
  armDefinition: 'armDefinition     (the exact forcing rule for this arm)',
  verdictRule: 'verdictRule       (the preregistered thresholds)',
  toolsHash: 'toolsHash         (the tool descriptions the agent was shown)',
  pwVersion: 'pwVersion         (@playwright/mcp, pinned)',
  chromiumRevision: 'chromiumRevision  (the browser the competitor drove)',
  pwObservationMode: 'pwObservationMode (snapshot links resolved, or as shipped)',
};

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

export function checkH2hIntegrity({ rows, malformed = [], cohort = null, identity, armDefinitions, toolsHash = null }) {
  const blocks = [];

  if (malformed.length) {
    blocks.push({
      title: `${malformed.length} line(s) in the store could not be parsed`,
      lines: [
        'An unreadable line is an episode that cannot be scored. Skipping it would',
        'quietly change the sample, so the run refuses instead.',
        ...malformed.slice(0, 5).map((m) => `    line ${m.line}: ${m.err} :: ${m.text.slice(0, 120)}`),
      ],
    });
  }
  if (!rows.length) return { ok: blocks.length === 0, blocks };

  const expectedTools = toolsHash ?? cohort?.toolsHash ?? rows[0]?.toolsHash ?? null;
  const expectedFor = (row, field) => {
    switch (field) {
      case 'codeVersion': return identity.codeVersion;
      case 'buildVersion': return identity.buildVersion;
      case 'suiteVersion': return identity.suiteVersion;
      case 'model': return identity.model;
      case 'promptHash': return identity.promptHashes[row.task] ?? '(this task is no longer defined)';
      case 'armDefinition': return armDefinitions[row.arm] ?? '(this arm is no longer defined)';
      case 'verdictRule': return identity.verdictRule;
      case 'toolsHash': return expectedTools?.[row.arm] ?? expectedTools ?? null;
      case 'pwVersion': return identity.pwVersion;
      case 'chromiumRevision': return identity.chromium?.revision ?? null;
      case 'pwObservationMode': return identity.pwObservationMode;
      default: return null;
    }
  };

  const groups = new Map();
  for (const row of rows) {
    const bad = [];
    for (const field of CHECKED) {
      const expected = expectedFor(row, field);
      if (expected === null || expected === undefined) continue;
      const found = row[field] ?? '(absent)';
      if (JSON.stringify(found) !== JSON.stringify(expected)) bad.push({ field, expected, found });
    }
    if (!bad.length) continue;
    const sig = bad.map((b) => `${b.field}=${show(b.found)}`).join('|');
    if (!groups.has(sig)) groups.set(sig, { fields: bad, rows: [] });
    groups.get(sig).rows.push(row);
  }

  for (const { fields, rows: affected } of groups.values()) {
    const lines = [];
    for (const f of fields) {
      lines.push(`    ${LABEL[f.field] ?? f.field}`);
      lines.push(`        on record : ${show(f.found)}`);
      lines.push(`        now       : ${show(f.expected)}`);
    }
    if (fields.some((f) => f.field === 'codeVersion' || f.field === 'buildVersion') && cohort?.files) {
      const now = new Map(identity.files.map((f) => [f.path, f.hash]));
      const then = new Map(cohort.files.map((f) => [f.path, f.hash]));
      const changed = [];
      for (const [p, h] of then) {
        if (!now.has(p)) changed.push(`${p.padEnd(46)} was ${h.slice(0, 12)}  now GONE FROM THE WATCHED SET`);
        else if (now.get(p) !== h) changed.push(`${p.padEnd(46)} was ${h.slice(0, 12)}  now ${now.get(p).slice(0, 12)}`);
      }
      for (const p of now.keys()) if (!then.has(p)) changed.push(`${p.padEnd(46)} NEW in the watched set`);
      lines.push('    files that differ from the cohort on record:');
      for (const c of changed.slice(0, 20)) lines.push(`        ${c}`);
      if (!changed.length) lines.push('        (none — the sidecar and the stamps disagree; the store has been edited)');
      if (changed.length > 20) lines.push(`        … and ${changed.length - 20} more`);
    }
    const byTask = {};
    for (const r of affected) {
      const k = `${r.task} [${r.arm}]`;
      byTask[k] = (byTask[k] ?? 0) + 1;
    }
    lines.push(`    ${affected.length} episode(s) affected:`);
    for (const [k, v] of Object.entries(byTask).slice(0, 12)) lines.push(`        ${k.padEnd(36)} x${v}`);
    blocks.push({ title: `${affected.length} episode(s) were produced by a DIFFERENT experiment`, lines });
  }

  return { ok: blocks.length === 0, blocks };
}

/** Strip an in-memory episode to what gets persisted, and stamp it. */
export function stampH2hEpisode(row, identity, armDefinitions, toolsHash) {
  const { obsStream, ...keep } = row;
  return {
    ...keep,
    recordedAt: new Date().toISOString(),
    suiteVersion: identity.suiteVersion,
    codeVersion: identity.codeVersion,
    buildVersion: identity.buildVersion,
    model: identity.model,
    promptHash: identity.promptHashes[row.task],
    armDefinition: armDefinitions[row.arm],
    verdictRule: identity.verdictRule,
    toolsHash: toolsHash?.[row.arm] ?? null,
    pwVersion: identity.pwVersion,
    chromiumRevision: identity.chromium?.revision ?? null,
    pwObservationMode: identity.pwObservationMode,
  };
}
