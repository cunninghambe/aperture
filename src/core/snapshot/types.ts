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
  /** Number of options on a select, when not enumerated inline. */
  optionCount?: number;
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
  statesOn?: StateBits;
  statesOff?: StateBits;
}

export type DiffOp =
  | { op: 'update'; ref: string; delta: PropDelta }
  | { op: 'add'; parent: string; after: string | null; subtree: SnapshotNode }
  | { op: 'remove'; ref: string; role: Role; label?: string }
  | { op: 'move'; ref: string; parent: string; after: string | null }
  /**
   * Regional fallback. When most of a container turned over, one replace is
   * both cheaper and far less likely to be misapplied by the model than
   * twenty adds interleaved with twenty removes.
   */
  | { op: 'replace'; ref: string; subtree: SnapshotNode };

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
  lastSeenSeq: string;
}
