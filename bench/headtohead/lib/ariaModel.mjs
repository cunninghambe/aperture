/**
 * The mechanical reader of PLAYWRIGHT MCP's observation stream — the pw-arm
 * counterpart to `bench/lib/streamModel.mjs` (headtohead.md §5.1).
 *
 * Two jobs, the same two the aperture-side shadow model has:
 *   1. label-targeted scripted solving (H3 needs `resolveLabel` over it), and
 *   2. `identity_mismatch` attribution — page-reported label vs model label,
 *      through the SAME `labelsAgree` the aperture arms use, imported rather
 *      than re-implemented.
 *
 * ONE STRUCTURAL DIFFERENCE FROM THE APERTURE READER, AND IT IS THE PRODUCT
 * DIFFERENCE UNDER TEST: each response's snapshot REPLACES the model wholesale.
 * There are no deltas to apply and therefore nothing that can drift. That is
 * what "re-dump architecture" means, expressed as thirty lines of parser.
 *
 * Nothing here talks to the network or knows what a task is.
 */
import { labelsAgree } from '../../lib/proxy.mjs';

export { labelsAgree };

// ---------------------------------------------------------------------------
// Section format (verified live against 0.0.78 — H1 re-verifies every run)
// ---------------------------------------------------------------------------

/**
 * `_build()` emits markdown sections in a fixed order: `### Error`,
 * `### Result`, `### Ran Playwright code`, `### Open tabs` / `### Page`,
 * `### Modal state`, `### Snapshot`, `### Events`, `### Paused`.
 *
 * Split on the headings rather than searched for individually, because the
 * per-section CHAR ACCOUNTING is H10's decomposition input: "how much of the
 * competitor's bill is snapshot and how much is codegen" is a question the
 * report has to answer with numbers, not adjectives.
 */
export function sections(text) {
  const out = [];
  const re = /^### (.+)$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(text))) heads.push({ name: m[1].trim(), at: m.index, end: re.lastIndex });
  if (!heads.length) return out;
  if (heads[0].at > 0) out.push({ name: '(preamble)', body: text.slice(0, heads[0].at) });
  for (let i = 0; i < heads.length; i++) {
    const body = text.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].at : text.length);
    out.push({ name: heads[i].name, body });
  }
  return out;
}

export function sectionChars(text) {
  const out = {};
  for (const s of sections(text)) out[s.name] = (out[s.name] ?? 0) + s.body.length;
  return out;
}

export const sectionBody = (text, name) =>
  sections(text).find((s) => s.name === name)?.body ?? null;

/**
 * The `### Snapshot` section's aria yaml, whichever form it arrived in.
 *
 * FORM A (inline): a ```yaml fence. This is what an explicit `browser_snapshot`
 * returns, and — after the harness's link resolution (see `proxy.mjs`'s
 * SNAPSHOT LINK RESOLUTION note) — what every action response carries too.
 *
 * FORM B (link): `- [Snapshot](relative\path\page-….yml)`. This is what 0.0.78
 * ACTUALLY returns on every action response, contrary to headtohead.md §1.1.
 * Recognised here so the harness can say so out loud rather than silently
 * scoring an empty observation.
 */
const FENCE = /```yaml\n([\s\S]*?)```/;
const LINK = /^\s*-\s*\[Snapshot\]\(([^)]+)\)\s*$/m;

export function snapshotYaml(text) {
  const body = sectionBody(text, 'Snapshot');
  if (body === null) return null;
  const f = FENCE.exec(body);
  if (f) return { form: 'inline', yaml: f[1] };
  const l = LINK.exec(body);
  if (l) return { form: 'link', path: l[1], yaml: null };
  return { form: 'other', yaml: null, raw: body };
}

/** §5.3: `### Snapshot` present = full observation; absent = header-only. */
export const isPwFull = (text) => snapshotYaml(text)?.form === 'inline';
export const hasSnapshotSection = (text) => sectionBody(text, 'Snapshot') !== null;

/**
 * The pw-arm observation taxonomy — the counterpart of streamModel's
 * `classifyObservation`, deliberately NOT the same function: the two products'
 * wire formats share no grammar, and one classifier over both would be a
 * classifier over neither.
 *
 *   full    a response carrying the aria snapshot inline
 *   header  a well-formed response with sections but no snapshot bytes
 *   link    a response whose snapshot is a file reference the agent cannot read
 *   error   a single-line `error:` the SHIM produced (step budget, ref grammar)
 *   empty   a response with NO BYTES AT ALL
 *   other   anything with no recognisable structure — surfaced verbatim by H8,
 *           because unclassified is where a bug hides in either product
 *
 * `empty` earns its own bucket rather than falling into `other`, and it is not
 * a hypothetical: MEASURED on 0.0.78, a `browser_type` without `submit` under
 * `--codegen none` returns a completely empty response. `browser_type`'s handler
 * only calls `setIncludeSnapshot()` when `submit` or `slowly` is set
 * (coreBundle.js, keyboard.ts), the Page header renders only on change, and
 * codegen is off — so there is nothing left to say. The agent is told nothing
 * whatsoever about what its keystrokes did. That is a real product behaviour and
 * H8's "unclassified is where bugs hide" rule must not bury it in `other`.
 */
export function classifyPwObservation(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'empty';
  const s = snapshotYaml(text);
  if (s?.form === 'inline') return 'full';
  if (s?.form === 'link') return 'link';
  if (text.startsWith('error: ') && !text.includes('\n')) return 'error';
  if (sections(text).length) return 'header';
  return 'other';
}

// ---------------------------------------------------------------------------
// The aria snapshot itself
// ---------------------------------------------------------------------------

/**
 * One aria-snapshot line:
 *   `- checkbox "Marketing emails" [ref=e4]`
 *   `- textbox "Name" [ref=e7]: Alex Morgan`
 *   `- heading "Settings" [level=1] [ref=e3]`
 *   `- link "Home" [ref=e12]:`   (children follow, indented)
 *   `- text: Marketing emails`
 *   `- /url: /home`              (a property line, not an element)
 *
 * A trailing `:` with nothing after it opens a CHILD BLOCK; a trailing `: x`
 * is a VALUE. Conflating them would give every container the text of its first
 * child as a value and manufacture identity mismatches out of nothing.
 */
const LINE = /^\s*-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*(?::\s*(.*))?$/;

const unesc = (s) => s.replace(/\\(.)/g, '$1');

export function parseAriaLine(line) {
  if (/^\s*-\s*\//.test(line)) return null; // property line (/url:, /children:)
  const m = LINE.exec(line);
  if (!m) return null;
  const [, role, rawLabel, brackets = '', tail] = m;
  const attrs = {};
  const states = new Set();
  for (const b of brackets.matchAll(/\[([^\]]*)\]/g)) {
    const tok = b[1].trim();
    const eq = tok.indexOf('=');
    if (eq > 0) attrs[tok.slice(0, eq)] = tok.slice(eq + 1);
    else if (tok) states.add(tok);
  }
  return {
    role,
    ref: attrs.ref ?? null,
    label: rawLabel === undefined ? '' : unesc(rawLabel),
    value: tail ? tail.trim() : '',
    states,
    attrs,
  };
}

/**
 * Build the model from one response.
 *
 * WHOLESALE REPLACEMENT, and the guard clause matters: a response with NO
 * inline snapshot must leave the previous model ALONE rather than clear it.
 * A header-only response is not the statement "the page is now empty" — and a
 * reader that treated it as one would attribute every subsequent act to a
 * bookkeeping failure the agent never made.
 */
export function applyPwObservation(model, text) {
  const snap = snapshotYaml(text);
  if (!snap || snap.form !== 'inline') return model;
  model.clear();
  for (const line of snap.yaml.split('\n')) {
    const el = parseAriaLine(line);
    if (el?.ref) model.set(el.ref, el);
  }
  return model;
}

export const parseAriaSnapshot = (yaml) => applyPwObservation(new Map(), '### Snapshot\n```yaml\n' + yaml + '\n```');

// ---------------------------------------------------------------------------
// Label targeting for the scripted solver (H3)
// ---------------------------------------------------------------------------

/**
 * Resolve a solver step's label against the aria model.
 *
 * ONE definition, in `solve.mjs`, parameterised by role dialect — deliberately
 * the same logic and the same failure text the aperture arms' solver uses. H3
 * compares arms, and two solvers that failed differently would make a shim
 * defect look like a competitor defect, which is exactly what H3's
 * harness-fault presumption exists to prevent.
 */
export { ARIA_CLICK_ROLES as CLICK_ROLES, ARIA_TYPE_ROLES as TYPE_ROLES } from './solve.mjs';
export { resolveAriaLabel as resolveLabel } from './solve.mjs';

/** Refs the model holds whose label equals `label`. Mirrors streamModel's. */
export function refsByLabel(model, label, roles) {
  return [...model.entries()]
    .filter(([, e]) => e.label === label && (!roles || roles.has(e.role)))
    .map(([r]) => r);
}
