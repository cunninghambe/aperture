/**
 * The semantic page model.
 *
 * This is deliberately NOT the DOM and NOT Chromium's raw accessibility tree.
 * It borrows the AX tree's semantics (role, accessible name) but keeps the
 * operational facts an agent needs and the AX tree buries — href, scroll
 * offsets, viewport intersection, current value — and drops the AX artifacts
 * an agent does not need (generic wrappers, presentation-only nodes).
 */

export type Role =
  | 'button' | 'link' | 'textbox' | 'searchbox' | 'combobox' | 'checkbox'
  | 'radio' | 'slider' | 'list' | 'listitem' | 'table' | 'row' | 'dialog'
  | 'form' | 'img' | 'iframe' | 'heading' | 'banner' | 'nav' | 'main'
  | 'contentinfo' | 'region' | 'group' | 'scrollable' | 'text' | 'tab'
  | 'tabpanel' | 'menu' | 'menuitem' | 'option' | 'generic';

/** Packed element state. A bitset because these travel on every node. */
export const State = {
  Checked: 1,
  Disabled: 2,
  Expanded: 4,
  Selected: 8,
  Required: 16,
  Focused: 32,
  Modal: 64,
  Readonly: 128,
  Volatile: 256,
  Offscreen: 512,
  Invalid: 1024,
} as const;

export type StateBits = number;

/** Human-readable names for the bits, used by the renderer. */
export const STATE_NAMES: [number, string][] = [
  [State.Checked, 'checked'],
  [State.Disabled, 'disabled'],
  [State.Expanded, 'expanded'],
  [State.Selected, 'selected'],
  [State.Required, 'required'],
  [State.Focused, 'focused'],
  [State.Modal, 'modal'],
  [State.Readonly, 'readonly'],
  [State.Invalid, 'invalid'],
];

export type Rect = [x: number, y: number, w: number, h: number];

export interface SnapshotNode {
  role: Role;
  /** Accessible name, normalized and length-capped. */
  name?: string;
  /** Agent-facing handle, e.g. "e42". Present only on addressable nodes. */
  ref?: string;
  /**
   * Identity key. Never serialized to the model — it exists so that the same
   * logical element keeps the same ref across re-renders that replaced every
   * underlying DOM node.
   */
  key: string;
  value?: string;
  /** Path-only; the origin is already on the page line. */
  href?: string;
  /** Merged inline leaf text. */
  text?: string;
  states: StateBits;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  frameId: number;
  rect: Rect;
  scroll?: { top: number; height: number };
  dims?: { rows: number; cols: number };
  /** Table rows pre-flattened to cell text, so the renderer can pipe-join. */
  rows?: string[][];
  /**
   * Number of options on a native `<select>`.
   *
   * Set on EVERY native select, enumerated inline or not. It is the agent's
   * only discriminator between a native select (drive with `browser_act`
   * `select`) and a custom ARIA combobox (drive with `click`), and nothing
   * else in the renderer emits `[N options]`.
   */
  optionCount?: number;
  /**
   * This node was manufactured by the walker and has no element behind it.
   *
   * True only for the `option` children the walker synthesizes to enumerate a
   * small native `<select>`. They exist so the agent can read four options
   * without a second call — but the page-side index has no entry for them, so
   * a ref would name something no action could ever resolve. `option` is an
   * addressable role again (custom ARIA listbox options are real, clickable
   * elements); this flag is what keeps that from handing out refs which are
   * guaranteed to fail. Honoured in `registry.assignRefs` and at every
   * `ensureRef` site in `diff.ts`.
   */
  synthetic?: boolean;
  /**
   * The field's own `autocomplete` token. Kept out of the rendered text (it
   * costs tokens and the agent does not need it) but carried on the node,
   * because it is the strongest available signal for autofill matching.
   */
  autocomplete?: string;
  /** Input type attribute, for the same reason. */
  inputType?: string;
  /**
   * Shape hash over child roles, ignoring text. Runs of siblings sharing a
   * shape hash are what make "…21 more listitems (same shape)" possible.
   */
  shape?: string;
  children: SnapshotNode[];
}

export interface Viewport {
  top: number;
  height: number;
  docHeight: number;
}

export interface Snapshot {
  /** "epoch.step", e.g. "7.0". Full snapshots always end in .0. */
  seq: string;
  epoch: number;
  url: string;
  title: string;
  root: SnapshotNode;
  viewport: Viewport;
  /** Ref of the modal currently obscuring the page, if any. */
  modal?: string;
}

export interface PropDelta {
  name?: [string, string];
  value?: string;
  text?: [string, string];
  /**
   * Old and new link target.
   *
   * Both sides are kept for consumers that want to reason about the move; the
   * renderer emits only `[1]`, the same convention `name` follows. A stable
   * label over a mutated href is a wrong-element action the agent cannot
   * detect from the stream — see docs/design/security.md.
   */
  href?: [string, string];
  /**
   * The table's rows, RESTATED in full rather than edited row by row.
   *
   * Rows have no identity, so a row-level edit script would need a second
   * matching pass — the exact thing `REPLACE_MATCH_RATIO` exists to avoid. The
   * restatement is bounded: the walker caps a table at 50 rows with truncated
   * cells, and the engine's size valve turns anything pathological into a full
   * resync.
   */
  rows?: string[][];
  /** Set with `rows` and never alone — dims is derived from rows. */
  dims?: { rows: number; cols: number };
  statesOn?: StateBits;
  statesOff?: StateBits;
}

export type DiffOp =
  | { op: 'update'; ref: string; delta: PropDelta }
  | { op: 'add'; parent: string; after: string | null; subtree: SnapshotNode }
  | {
      op: 'remove';
      ref: string;
      role: Role;
      label?: string;
      /**
       * Refs INSIDE the removed subtree that died with it.
       *
       * Naming only the top of a removed subtree leaves the model believing in
       * every ref underneath — the same phantom-ref failure the `replace` op's
       * `gone` list was added to close, on the path that closes a dropdown or
       * dismisses a dialog. A reader cannot infer it: nothing in the stream
       * tells it what the removed node contained.
       */
      gone?: string[];
    }
  | { op: 'move'; ref: string; parent: string; after: string | null }
  /**
   * Refs that died with a removed subtree whose ROOT carries no ref.
   *
   * `remove` can only report deaths it can hang off a named ref, and most
   * containers on the web are not addressable: a `<div>` is `generic`, a table
   * or list row is `listitem`, and neither is in ADDRESSABLE. Removing one used
   * to orphan every ref beneath it — no `remove` line, no `gone` list, no
   * `markDead` — so the model kept acting on elements that no longer existed.
   * There is nothing to name at the top, so this op names only the dead.
   */
  | { op: 'gone'; refs: string[] }
  /**
   * Regional fallback. When most of a container turned over, one replace is
   * both cheaper and far less likely to be misapplied by the model than
   * twenty adds interleaved with twenty removes.
   */
  | {
      op: 'replace';
      ref: string;
      subtree: SnapshotNode;
      /** Refs destroyed by the replace. Without these the model keeps
       *  believing in elements that no longer exist. */
      gone?: string[];
    };

export interface SnapshotDiff {
  seq: string;
  /** The seq this diff applies to. The model checks it still remembers it. */
  baseSeq: string;
  ops: DiffOp[];
  /** Count of volatile-node changes deliberately withheld. */
  suppressed: number;
  /** Changes inside regions the model has never been shown. */
  unreadChanges: number;
}

/** What the engine hands back after an action settles. */
export type Observation =
  | { kind: 'diff'; diff: SnapshotDiff }
  | { kind: 'full'; snapshot: Snapshot }
  | { kind: 'unchanged'; seq: string };

export interface RefEntry {
  ref: string;
  key: string;
  frameId: number;
  role: Role;
  name?: string;
  href?: string;
  rect: Rect;
  state: 'live' | 'dead';
  /** Whether this node has ever been rendered to the model. */
  emitted: boolean;
  /**
   * The model was shown this ref and then told it died. Until the ref is
   * rendered in full again, naming it is not enough for the model to act on.
   *
   * A ref can come back from the dead — `ensureRef` revives a key that
   * reappears, which is what makes tabbed UIs behave — and a revival hidden
   * inside a collapsed `… N more` run is a *silent* one: the model deleted the
   * ref, was never shown it again, and a later `~ eN` or a `gone: eN` would
   * name an element it no longer holds. The renderer refuses to collapse a run
   * containing a ref in this state.
   */
  needsReannounce: boolean;
  lastSeenSeq: string;
}
