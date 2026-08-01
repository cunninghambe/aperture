import type { RefRegistry } from './registry.js';
import type {
  DiffOp,
  Snapshot,
  SnapshotDiff,
  SnapshotNode,
  StateBits,
} from './types.js';
import { STATE_NAMES, State } from './types.js';
import { quote } from './text.js';

// Re-exported because most of the codebase imports quote() from here. The
// implementation moved to text.js so selectOption.ts — which runs in the
// isolated world and must not pull in the renderer — can share exactly one
// copy of it. Two copies of a neutralizer is how one of them goes stale.
export { quote };

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
  const marks: [number, string][] = [];
  renderNode(snap.root, 0, body, {
    reg: opts.registry,
    seq: snap.seq,
    expand: opts.expand === true,
    marks,
  });

  // Budget enforcement degrades by dropping offscreen detail before it ever
  // truncates mid-structure — a half-emitted subtree is worse than an honest
  // "there is more below".
  const budgetChars = budget * CHARS_PER_TOKEN;
  let joined = body.join('\n');
  const kept = new Set<number>();
  if (joined.length > budgetChars) {
    const keptLines: string[] = [];
    let used = 0;
    let dropped = 0;
    body.forEach((line, i) => {
      if (used + line.length > budgetChars) {
        dropped++;
        return;
      }
      keptLines.push(line);
      kept.add(i);
      used += line.length + 1;
    });
    joined = keptLines.join('\n');
    if (dropped > 0) {
      joined += `\n… ${dropped} more lines beyond budget — use browser_find or browser_read to reach them`;
    }
  } else {
    body.forEach((_, i) => kept.add(i));
  }

  // Emission marks are applied only for lines that SURVIVED the budget cut.
  // Marking a ref emitted for a line the model never received poisons the
  // wasEmitted bookkeeping every diff gate relies on — the model would then
  // get `~ eN` updates for an element it was never shown.
  if (opts.registry) {
    for (const [i, ref] of marks) {
      if (kept.has(i)) opts.registry.markEmitted(ref, snap.seq);
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
  /**
   * When present, emission marks are recorded as [lineIndex, ref] rather than
   * applied immediately. renderFull needs the indirection because the budget
   * cut can drop a rendered line after the fact; renderDiff's dry pass needs
   * it because a candidate diff the engine discards for a full snapshot must
   * not mark anything as shown to the model.
   */
  marks?: [number, string][];
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
      if (ctx.reg && n.ref) {
        if (ctx.marks) ctx.marks.push([out.length - 1, n.ref]);
        else ctx.reg.markEmitted(n.ref, ctx.seq);
      }
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
    if (!t) return null;
    // A text node normally has no ref, and a bare quoted line is cheapest.
    // But a text node that CHANGED during a diff was given a ref so the
    // update could be named — from then on the full line must show that ref,
    // or the model holds `~ eN` updates for a name it has never seen.
    return n.ref ? `${pad}text ${n.ref} ${quote(t)}` : `${pad}${quote(t)}`;
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
    return [head, ...renderRows(n.rows, `${pad}  `)].join('\n');
  }

  return head;
}

/**
 * Table rows, pipe-joined, one line each, indented by `pad`.
 *
 * The single spelling of the row format. It is emitted from two places — a
 * table's own line in a full snapshot, and an `~` update that restates a
 * changed table — and the bench's stream reader parses both with one rule. Two
 * copies of a wire format is how one of them goes stale.
 */
export function renderRows(rows: string[][], pad: string): string[] {
  return rows.map((r) => `${pad}${r.map((c) => (c ? quote(c) : '')).join(' | ')}`);
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

export interface UnchangedOptions {
  /**
   * True when the observation followed an agent action.
   *
   * The two meanings of "nothing changed" are not the same fact and must not
   * read the same. After an action it is DIAGNOSTIC — the click had no visible
   * effect, which is real signal about the page. After a voluntary snapshot it
   * is REDUNDANT — the agent already holds the page and has just paid a turn to
   * be told so. The engine is the only place that knows which; the wire should
   * say which.
   */
  afterAction?: boolean;
  suppressed?: number;
  unreadChanges?: number;
}

/**
 * The one spelling of an observation with zero ops.
 *
 * Both variants share the `(unchanged` prefix on purpose: one regex classifies
 * them, and the bench's stream reader is that regex.
 */
export function renderUnchanged(seq: string, opts: UnchangedOptions = {}): string {
  const head = opts.afterAction
    ? `page #${seq} (unchanged — the action caused no visible change)`
    : `page #${seq} (unchanged — you already hold the current page)`;

  // Same notes a non-empty diff carries, in the same words. The empty path used
  // to hardcode unreadChanges to 0, so a page whose only changes were in regions
  // the model has never been shown reported "nothing changed" with no caveat at
  // all — the one case where the agent most needs the caveat.
  const notes: string[] = [];
  if (opts.suppressed) notes.push(`${opts.suppressed} live-region updates suppressed`);
  if (opts.unreadChanges) {
    notes.push(`${opts.unreadChanges} changes in regions you have not read`);
  }
  return notes.length ? `${head} (${notes.join('; ')})` : head;
}

/**
 * `commit: false` renders the identical text but records no emission marks.
 * The engine uses it to size a candidate diff before deciding between the
 * diff and a full resync — a diff that is then thrown away must not mark its
 * subtree refs as shown to the model, because they were not.
 */
export function renderDiff(d: SnapshotDiff, reg?: RefRegistry, commit = true): string {
  // One spelling of "nothing changed", held in renderUnchanged. The engine calls
  // it directly on its own empty path (where it knows whether an action caused
  // the observation); this branch delegates so a second spelling cannot drift
  // into existence behind it.
  if (d.ops.length === 0) {
    return renderUnchanged(d.seq, {
      suppressed: d.suppressed,
      unreadChanges: d.unreadChanges,
    });
  }

  const out: string[] = [`page #${d.seq} (diff from #${d.baseSeq})`];
  for (const op of d.ops) out.push(renderOp(op, reg, d.seq, commit));

  const notes: string[] = [];
  if (d.suppressed) notes.push(`${d.suppressed} live-region updates suppressed`);
  if (d.unreadChanges) notes.push(`${d.unreadChanges} changes in regions you have not read`);
  if (notes.length) out.push(`(${notes.join('; ')})`);

  return out.join('\n');
}

function renderOp(
  op: DiffOp,
  reg: RefRegistry | undefined,
  seq: string,
  commit: boolean,
): string {
  // In a dry render the marks land in a throwaway array; in a commit render
  // they are applied immediately (diffs have no budget cut to survive).
  const marks: [number, string][] | undefined = commit ? undefined : [];
  switch (op.op) {
    case 'update': {
      const bits: string[] = [];
      if (op.delta.name) bits.push(quote(op.delta.name[1]));
      if (op.delta.value !== undefined) bits.push(`=${quote(op.delta.value)}`);
      if (op.delta.text) bits.push(quote(op.delta.text[1]));
      // New target only — the same convention `name` and `value` follow.
      // Unquoted, because `sanitizeHref` (walker.ts) has already stripped
      // whitespace, control characters and bidi overrides and capped the
      // length, so the token cannot break the line or a reader parsing it.
      if (op.delta.href) bits.push(`href=${op.delta.href[1]}`);
      if (op.delta.statesOn) bits.push(`+${stateWords(op.delta.statesOn)}`);
      if (op.delta.statesOff) bits.push(`-${stateWords(op.delta.statesOff)}`);
      // A changed table is RESTATED, not edited row by row: rows have no
      // identity, so a row-level script would need a second matching pass. The
      // `RxC:` tail goes last because the rows follow on the next lines, in
      // exactly the format a table's own snapshot line uses.
      if (op.delta.rows) {
        const d =
          op.delta.dims ??
          { rows: op.delta.rows.length, cols: op.delta.rows[0]?.length ?? 0 };
        bits.push(`${d.rows}x${d.cols}:`);
        return [`~ ${op.ref} ${bits.join(' ')}`, ...renderRows(op.delta.rows, '  ')].join(
          '\n',
        );
      }
      return `~ ${op.ref} ${bits.join(' ')}`;
    }
    case 'add': {
      const lines: string[] = [];
      // Diffs are the production stream and stay collapsed; `expand` is an
      // explicit, opt-in request on a full snapshot.
      renderNode(op.subtree, 1, lines, { reg, seq, expand: false, marks });
      const where = op.after ? `after ${op.after}` : `under ${op.parent}`;
      return `+ ${where}:\n${lines.join('\n')}`;
    }
    case 'remove': {
      // The label rides along so the agent never has to look up what it lost,
      // and `gone` names the refs that died INSIDE it — without that line a
      // closed dropdown leaves its options alive in the model forever.
      const was = op.label ? ` (was: ${op.role} ${quote(op.label)})` : '';
      const inside = op.gone && op.gone.length ? ` (gone: ${op.gone.join(' ')})` : '';
      return `- ${op.ref} removed${was}${inside}`;
    }
    case 'move':
      return `> ${op.ref} moved ${op.after ? `after ${op.after}` : `into ${op.parent}`}`;
    case 'gone':
      // Same vocabulary as the `(gone: …)` suffix, minus the ref it would hang
      // off: the container that died was a plain <div> or an <li>, neither of
      // which is addressable, so there is no name for the top of what went.
      return `- gone: ${op.refs.join(' ')}`;
    case 'replace': {
      const lines: string[] = [];
      renderNode(op.subtree, 1, lines, { reg, seq, expand: false, marks });
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
