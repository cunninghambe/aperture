import type { RefRegistry } from './registry.js';
import type {
  DiffOp,
  Snapshot,
  SnapshotDiff,
  SnapshotNode,
  StateBits,
} from './types.js';
import { STATE_NAMES, State } from './types.js';

/**
 * Rendering the semantic tree into the text an agent actually reads.
 *
 * JSON is rejected here: braces, quoted keys, and key repetition cost 40-60%
 * overhead for structure a model reads natively from indentation. Every
 * syntactic choice below is justified on token cost — see docs/design/snapshot.md.
 *
 * The format legend is paid ONCE, in the MCP tool description, never per call.
 */

export interface RenderOptions {
  /** Soft cap on rendered tokens. Lower tiers degrade before higher ones. */
  budgetTokens?: number;
  registry?: RefRegistry;
  /**
   * Render collapsed `… N more` runs in full.
   *
   * Off by default: collapsing repetition is most of the token saving on a
   * catalogue page. On demand it is the only way to obtain refs for items the
   * elision hides — and the only way to obtain a complete ground truth for
   * anything comparing the diff stream against the page.
   */
  expand?: boolean;
}

const DEFAULT_BUDGET = 2000;
/** Rough chars-per-token for English + markup. Good enough for budgeting. */
const CHARS_PER_TOKEN = 4;
/** Runs of same-shape siblings longer than this get collapsed. */
const COLLAPSE_RUN = 5;
const COLLAPSE_SHOW = 3;

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export function renderFull(snap: Snapshot, opts: RenderOptions = {}): string {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const out: string[] = [];

  out.push(
    `FULL SNAPSHOT #${snap.seq} — replaces all prior state for this page`,
  );
  out.push(`page ${quote(snap.title)} ${snap.url}`);

  const v = snap.viewport;
  if (v.docHeight > v.height) {
    out.push(`viewport: scroll ${Math.round(v.top)}/${Math.round(v.docHeight)}px`);
  }
  out.push('');

  const body: string[] = [];
  renderNode(snap.root, 0, body, {
    reg: opts.registry,
    seq: snap.seq,
    expand: opts.expand === true,
  });

  // Budget enforcement degrades by dropping offscreen detail before it ever
  // truncates mid-structure — a half-emitted subtree is worse than an honest
  // "there is more below".
  const budgetChars = budget * CHARS_PER_TOKEN;
  let joined = body.join('\n');
  if (joined.length > budgetChars) {
    const kept: string[] = [];
    let used = 0;
    let dropped = 0;
    for (const line of body) {
      if (used + line.length > budgetChars) {
        dropped++;
        continue;
      }
      kept.push(line);
      used += line.length + 1;
    }
    joined = kept.join('\n');
    if (dropped > 0) {
      joined += `\n… ${dropped} more lines beyond budget — use browser_find or browser_read to reach them`;
    }
  }

  out.push(joined);
  return out.join('\n');
}

interface RenderCtx {
  reg: RefRegistry | undefined;
  seq: string;
  /** Suppress run collapsing entirely; every child gets its own line. */
  expand: boolean;
}

function renderNode(
  n: SnapshotNode,
  depth: number,
  out: string[],
  ctx: RenderCtx,
): void {
  // The root is a container, not content.
  if (depth > 0 || n.role !== 'generic') {
    const line = renderLine(n, depth);
    if (line !== null) {
      out.push(line);
      if (ctx.reg && n.ref) ctx.reg.markEmitted(n.ref, ctx.seq);
    }
  }

  const kids = n.children;
  const childDepth = depth + (n.role === 'generic' && depth === 0 ? 0 : 1);

  let i = 0;
  while (i < kids.length) {
    const run = sameShapeRunLength(kids, i);
    if (!ctx.expand && run >= COLLAPSE_RUN) {
      // Collapsing a run that is bringing a previously-dead, previously-emitted
      // ref back to life would revive it silently — the model has already
      // deleted that ref and would have no line to restore it from. Such a run
      // pays for its own re-announcement and renders in full.
      if (runOwesReannounce(kids, i + COLLAPSE_SHOW, i + run, ctx.reg)) {
        for (let k = 0; k < run; k++) {
          renderNode(kids[i + k]!, childDepth, out, ctx);
        }
        i += run;
        continue;
      }

      for (let k = 0; k < COLLAPSE_SHOW; k++) {
        renderNode(kids[i + k]!, childDepth, out, ctx);
      }
      const rest = run - COLLAPSE_SHOW;
      const shape = describeShape(kids[i]!);
      out.push(
        `${'  '.repeat(childDepth)}… ${rest} more ${kids[i]!.role}s (${shape})` +
          (n.ref ? ` — read ${n.ref}` : ''),
      );
      i += run;
      continue;
    }
    renderNode(kids[i]!, childDepth, out, ctx);
    i++;
  }
}

/**
 * Does any item about to be elided carry a ref that owes the model a full line?
 *
 * Only the elided tail is examined: the first COLLAPSE_SHOW items are rendered
 * either way. Refs the model has never been shown never owe anything, so a
 * fresh page still collapses exactly as before.
 */
function runOwesReannounce(
  kids: SnapshotNode[],
  from: number,
  to: number,
  reg: RefRegistry | undefined,
): boolean {
  if (!reg) return false;
  for (let i = from; i < to; i++) {
    const stack: SnapshotNode[] = [kids[i]!];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.ref && reg.needsReannounce(n.ref)) return true;
      for (const c of n.children) stack.push(c);
    }
  }
  return false;
}

/** One line of the tree, or null for nodes that carry nothing worth a line. */
export function renderLine(n: SnapshotNode, depth: number): string | null {
  const pad = '  '.repeat(depth);
  const parts: string[] = [];

  // Headings compress to h1..h6 rather than `heading "..." level=1`.
  if (n.role === 'heading' && n.headingLevel) parts.push(`h${n.headingLevel}`);
  else if (n.role === 'text') {
    const t = n.text ?? n.name ?? '';
    return t ? `${pad}${quote(t)}` : null;
  } else parts.push(n.role);

  if (n.ref) parts.push(n.ref);
  if (n.name) parts.push(quote(n.name));
  if (n.value !== undefined) parts.push(`=${quote(n.value)}`);
  if (n.href) parts.push(n.href);
  if (n.optionCount !== undefined) parts.push(`[${n.optionCount} options]`);
  if (n.dims) parts.push(`${n.dims.rows}x${n.dims.cols}`);
  if (n.scroll) {
    parts.push(`(${Math.round(n.scroll.top)}/${Math.round(n.scroll.height)}px)`);
  }

  const flags = stateWords(n.states);
  if (flags) parts.push(flags);

  const head = `${pad}${parts.join(' ')}`;

  // Tables render their rows inline, pipe-joined — models parse that natively
  // from markdown, and it is ~4x cheaper than nested cell nodes.
  if (n.rows && n.rows.length) {
    const rowLines = n.rows.map(
      (r) => `${pad}  ${r.map((c) => (c ? quote(c) : '')).join(' | ')}`,
    );
    return [head, ...rowLines].join('\n');
  }

  return head;
}

/** Only set states are emitted, so booleans cost nothing when false. */
export function stateWords(bits: StateBits): string {
  const words: string[] = [];
  for (const [bit, word] of STATE_NAMES) {
    if (bits & bit) words.push(word);
  }
  if (bits & State.Volatile) words.push('live');
  return words.join(' ');
}

function sameShapeRunLength(kids: SnapshotNode[], start: number): number {
  const shape = kids[start]?.shape;
  if (!shape) return 1;
  let n = 1;
  while (start + n < kids.length && kids[start + n]!.shape === shape) n++;
  return n;
}

/**
 * A short description of what the collapsed items look like. This is what
 * lets the model decide whether it needs to expand them.
 */
function describeShape(n: SnapshotNode): string {
  const bits: string[] = [];
  for (const c of n.children.slice(0, 4)) {
    if (c.role === 'link') bits.push('link');
    else if (c.role === 'button') bits.push(`button ${c.name ? quote(c.name) : ''}`.trim());
    else if (c.role === 'text') bits.push('text');
    else bits.push(c.role);
  }
  return bits.join('/') || 'same shape';
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

export function renderDiff(d: SnapshotDiff, reg?: RefRegistry): string {
  if (d.ops.length === 0) {
    const extra = d.suppressed ? ` (${d.suppressed} live-region updates suppressed)` : '';
    return `page #${d.seq} (no visible change)${extra}`;
  }

  const out: string[] = [`page #${d.seq} (diff from #${d.baseSeq})`];
  for (const op of d.ops) out.push(renderOp(op, reg, d.seq));

  const notes: string[] = [];
  if (d.suppressed) notes.push(`${d.suppressed} live-region updates suppressed`);
  if (d.unreadChanges) notes.push(`${d.unreadChanges} changes in regions you have not read`);
  if (notes.length) out.push(`(${notes.join('; ')})`);

  return out.join('\n');
}

function renderOp(op: DiffOp, reg: RefRegistry | undefined, seq: string): string {
  switch (op.op) {
    case 'update': {
      const bits: string[] = [];
      if (op.delta.name) bits.push(quote(op.delta.name[1]));
      if (op.delta.value !== undefined) bits.push(`=${quote(op.delta.value)}`);
      if (op.delta.text) bits.push(quote(op.delta.text[1]));
      if (op.delta.statesOn) bits.push(`+${stateWords(op.delta.statesOn)}`);
      if (op.delta.statesOff) bits.push(`-${stateWords(op.delta.statesOff)}`);
      return `~ ${op.ref} ${bits.join(' ')}`;
    }
    case 'add': {
      const lines: string[] = [];
      // Diffs are the production stream and stay collapsed; `expand` is an
      // explicit, opt-in request on a full snapshot.
      renderNode(op.subtree, 1, lines, { reg, seq, expand: false });
      const where = op.after ? `after ${op.after}` : `under ${op.parent}`;
      return `+ ${where}:\n${lines.join('\n')}`;
    }
    case 'remove':
      // The label rides along so the agent never has to look up what it lost.
      return `- ${op.ref} removed${op.label ? ` (was: ${op.role} ${quote(op.label)})` : ''}`;
    case 'move':
      return `> ${op.ref} moved ${op.after ? `after ${op.after}` : `into ${op.parent}`}`;
    case 'replace': {
      const lines: string[] = [];
      renderNode(op.subtree, 1, lines, { reg, seq, expand: false });
      // Naming the refs the replace destroyed is what stops the model going on
      // believing in elements that no longer exist — the phantom refs the
      // fidelity check caught. A replace that reports only what it created is
      // a lossy diff.
      const goneNote =
        op.gone && op.gone.length ? ` (gone: ${op.gone.join(' ')})` : '';
      return `! ${op.ref} replaced${goneNote}:\n${lines.join('\n')}`;
    }
  }
}

// ---------------------------------------------------------------------------

const MAX_TEXT = 80;

/**
 * Quote and neutralize page-authored text.
 *
 * Every string that came from the page sits inside double quotes, and our
 * structural tokens only ever appear unquoted at the start of a line. That
 * means a page cannot emit text that parses as snapshot structure — it cannot
 * forge a `FULL SNAPSHOT` header or a `- e5 removed` line.
 *
 * This is framing hygiene, not a claim of prompt-injection immunity. Page text
 * is still untrusted content and is marked as such at the MCP boundary.
 */
export function quote(s: string): string {
  let t = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Strip control characters and the bidi overrides used to visually reorder
  // text so that what a human reviewer sees differs from what is really there.
  t = t.replace(
    /[\u0000-\u001f\u0085\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    '',
  );
  if (t.length > MAX_TEXT) t = `${t.slice(0, MAX_TEXT - 1)}…`;
  // Backslash must be escaped before the quote, or the encoding is not
  // injective and page text can close the quoted string early, leaving the
  // remainder to parse as snapshot structure.
  return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
