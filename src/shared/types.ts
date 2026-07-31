/**
 * Cross-process contract. Imported by main, preload, and renderer, so it must
 * stay dependency-free and side-effect-free.
 */

export type TabId = string;
export type ContainerId = string;

/** Where a tab is in its load lifecycle. */
export type LoadState = 'idle' | 'loading' | 'complete' | 'failed';

export interface TabInfo {
  id: TabId;
  url: string;
  title: string;
  favicon: string | null;
  loadState: LoadState;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Identity container this tab's session is bound to. */
  container: ContainerId;
  /** True when the agent (not the human) opened this tab. */
  agentOwned: boolean;
  /** Trackers blocked on this tab since last navigation. */
  blockedCount: number;
  audible: boolean;
  muted: boolean;
}

/**
 * An identity container: an isolated cookie jar, cache, and storage bucket,
 * plus a stable synthetic fingerprint. Sites in different containers cannot
 * see each other's state, and present as different (but internally consistent)
 * browsers.
 */
export interface Container {
  id: ContainerId;
  name: string;
  /** Electron session partition string, e.g. "persist:c-work". */
  partition: string;
  color: string;
  /** Domains that auto-open in this container. */
  claims: string[];
  /** Deterministic seed seeding this container's fingerprint. */
  fingerprintSeed: string;
  ephemeral: boolean;
}

/** Result of a navigation attempt. */
export interface NavResult {
  ok: boolean;
  url: string;
  httpStatus: number | null;
  error: string | null;
  /** Milliseconds from request to load event. */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

/** A stable, agent-facing handle to an element. Rendered as e.g. "e42". */
export type Ref = string;

export interface SnapshotNode {
  ref: Ref | null;
  role: string;
  name: string;
  /** Present for inputs: the current value. */
  value?: string;
  /** Compact state flags: disabled, checked, expanded, required, invalid... */
  flags?: string[];
  /** Element is outside the current viewport. */
  offscreen?: boolean;
  children?: SnapshotNode[];
  /**
   * When a run of structurally identical siblings is collapsed, this records
   * how many were elided so the agent knows to expand if it cares.
   */
  elided?: number;
}

export interface Snapshot {
  tabId: TabId;
  url: string;
  title: string;
  /** Monotonic per-tab. The agent echoes this back so we can detect drift. */
  seq: number;
  root: SnapshotNode;
  /** Serialized, token-efficient form handed to the model. */
  text: string;
  tokensEstimate: number;
}

export type DiffOp =
  | { op: 'add'; parent: Ref | null; after: Ref | null; node: SnapshotNode }
  | { op: 'remove'; ref: Ref }
  | { op: 'update'; ref: Ref; name?: string; value?: string; flags?: string[] }
  | { op: 'move'; ref: Ref; parent: Ref | null; after: Ref | null };

export interface SnapshotDiff {
  tabId: TabId;
  /** Snapshot seq this diff applies *to*. */
  baseSeq: number;
  /** Snapshot seq after applying. */
  seq: number;
  ops: DiffOp[];
  text: string;
  /**
   * Set when the engine gave up on diffing and returned a full snapshot
   * instead. The agent must discard its mental model when it sees this.
   */
  reset: boolean;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

/**
 * What the agent is allowed to know about a vault entry. Deliberately contains
 * no secret material — not the password, not the TOTP seed. This type is the
 * enforcement boundary: nothing carrying plaintext is ever shaped like this.
 */
export interface VaultEntryPublic {
  id: string;
  origin: string;
  username: string;
  hasTotp: boolean;
  lastUsed: string | null;
}

export type VaultState = 'absent' | 'locked' | 'unlocked';

/** Outcome of an agent-requested fill. Never carries the secret. */
export interface FillResult {
  ok: boolean;
  /** Why it was refused, if it was. */
  reason?:
    | 'locked'
    | 'no-match'
    | 'origin-mismatch'
    | 'user-denied'
    | 'no-field'
    | 'timeout';
  filledFields?: ('username' | 'password' | 'totp')[];
}
