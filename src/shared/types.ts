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

// ---------------------------------------------------------------------------
// The fill path
// ---------------------------------------------------------------------------

/**
 * Every way a fill can be refused or fall short.
 *
 * The union is total and closed on purpose: `src/mcp/tools.ts` maps it to a
 * `Record<FillDenyCode, string>`, so a code added here without a wire string
 * fails the typecheck rather than reaching an agent as `undefined`. See
 * docs/design/vaultfill.md section 10 for the strings and for the two rules
 * they hold to.
 *
 * Nothing here can carry a secret. That is not a convention — none of these is
 * a string the caller supplies, and the only values ever interpolated into
 * their prose are `safeOrigin()` output, integers, and (for `AMBIGUOUS_FIELDS`
 * alone) page-authored labels inside an envelope.
 */
export type FillDenyCode =
  | 'NO_TAB'
  | 'VAULT_LOCKED'
  | 'FILL_IN_FLIGHT'
  | 'NO_MATCH'
  | 'ORIGIN_MISMATCH'
  | 'INSECURE_TRANSPORT'
  | 'CONSENT_COOLDOWN'
  | 'NO_FIELDS'
  | 'AMBIGUOUS_FIELDS'
  | 'ALREADY_FILLED'
  | 'OTP_NO_SEED'
  | 'TOTP_ALREADY_ISSUED'
  | 'TOTP_UNAVAILABLE'
  | 'FIELD_GONE'
  | 'FIELD_OBSTRUCTED'
  | 'FIELD_NOT_EDITABLE'
  | 'PASSWORD_FIELD_NOT_MASKED'
  | 'FIELD_IN_SUBFRAME'
  | 'FIELD_TOO_SMALL'
  | 'ORIGIN_CHANGED'
  | 'USER_DENIED'
  | 'CONSENT_RATE_LIMITED'
  | 'CONSENT_NO_WINDOW'
  | 'FILL_REVERTED'
  | 'FILL_INTERRUPTED'
  | 'FILL_UNCONFIRMED'
  | 'WRITE_FAILED'
  | 'SUBMIT_SKIPPED_FOCUS_LOST'
  | 'SUBMIT_UNCONFIRMED';

/** What a fill target is FOR. The checks that differ, differ by this. */
export type CredentialTargetKind = 'username' | 'password' | 'otp';
export type FillTargetKind = 'profile' | CredentialTargetKind;

/**
 * The preload's fixed reason vocabulary for the `aperture:fill` channel.
 *
 * These are literals. Nothing on that channel ever interpolates `err.message`,
 * which closes one of the four sites docs/design/security.md names under
 * "Preload reason strings are NOT all literals". Being a closed union here is
 * what makes that testable rather than merely intended.
 */
export type FillSkipReason =
  | 'origin-changed'
  | 'gone'
  | 'subframe'
  | 'not-input'
  | 'not-masked'
  | 'not-editable'
  | 'too-small'
  | 'no-setter'
  | 'reverted'
  | 'write-failed';

/** One target's outcome. `landed` is a boolean about a value, never a value. */
export interface FillTargetResult {
  key: string;
  kind: FillTargetKind;
  wrote: boolean;
  landed: boolean;
  skipped?: FillSkipReason;
}

/**
 * What the page replies on `aperture:fill`.
 *
 * Carries booleans and keys. There is no field here that can hold a secret,
 * which is the same enforcement `VaultEntryPublic` provides on the other side.
 */
export type FillChannelResult =
  | { ok: true; results: FillTargetResult[]; focusedKey: string | null }
  /**
   * `wrote` is how many targets had already been written when the refusal
   * happened — a COUNT, never a value, and absent for every refusal decided
   * before the write pass began. It exists because the atomic path can now stop
   * MID-write, when a page mutates a later target from an earlier one's event
   * handlers, and "nothing was inserted" would be false in that case.
   */
  | { ok: false; reason: FillSkipReason; key?: string; wrote?: number };

/** One field the fill path is about to write into. */
export interface FillTargetRequest {
  key: string;
  kind: FillTargetKind;
  value: string;
}

/** Main -> preload on `aperture:fill`. */
export interface FillRequest {
  requestId: string;
  /** Exact serialization to compare against `location.origin` in the page. */
  expectedOrigin: string;
  /** True for credentials: any failed validation means nothing is written. */
  atomic: boolean;
  targets: FillTargetRequest[];
}
