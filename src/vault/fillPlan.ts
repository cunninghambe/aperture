import type { SnapshotNode } from '@core/snapshot/types.js';
import type { CredentialTargetKind } from '@shared/types.js';
import { isFreeTextPrompt } from './profile.js';

/**
 * Which field on the page receives which credential value.
 *
 * APERTURE CHOOSES. THE AGENT NEVER DOES.
 *
 * The agent supplies an entry id and a tab id and nothing else. It cannot name
 * a target field, now or ever, and that is one property rather than two: if the
 * agent could name the target, an injected page could steer it into naming a
 * visible `input[type=text]` — and the walker serialises the values of text
 * inputs, so the password would come straight back to the agent in the next
 * snapshot. "The agent cannot name a wrong-origin entry" and "the agent cannot
 * name a wrong field" are the same rule applied to the two halves of the
 * routing decision.
 *
 * PURE, AND FOR A STATED REASON. No Electron import, no DOM, no clock. The
 * same argument `envelope.ts` makes for itself: this is a security boundary, so
 * it has to be unit-testable without a live browser. Everything that needs a
 * page — connectivity, obstruction, maskedness at write time — is checked
 * later, by code that can see the element.
 *
 * See docs/design/vaultfill.md section 5.
 */

export type { CredentialTargetKind };

export interface CredentialTarget {
  /** Agent-facing, for the plan output only. Never honoured by `apply`. */
  ref: string;
  /** Identity key. THIS is what the write is aimed by. */
  key: string;
  /** Page-authored. Envelope or `quote()` at every single use. */
  label: string;
  kind: CredentialTargetKind;
}

export type PlanDenyCode =
  | 'NO_FIELDS'
  | 'AMBIGUOUS_FIELDS'
  | 'ALREADY_FILLED'
  | 'OTP_NO_SEED';

export type CredentialPlan =
  | { ok: true; targets: CredentialTarget[] }
  | { ok: false; code: PlanDenyCode; candidates?: string[] };

interface Candidate {
  ref: string;
  key: string;
  label: string;
  /** Higher is a stronger declaration of what the field wants. */
  confidence: number;
  hasValue: boolean;
}

/**
 * A field that declares itself a one-time code.
 *
 * Tier 2's shape is deliberately two-part: an "authenticator"/"two-factor"
 * word AND the word "code", unless the first match was already unambiguous on
 * its own (`otp`, `totp`, `passcode`). "Verification" alone is a signup email
 * field as often as it is a 2FA box.
 */
const OTP_WORDS =
  /\b(one[\s-]?time|verification|authenticat\w*|two[\s-]?factor|2fa|mfa|otp|totp|passcode)\b/i;
const OTP_SELF_SUFFICIENT = /\b(otp|totp|passcode)\b/i;
const OTP_CODE_WORD = /\bcode\b/i;

const USERNAME_WORDS =
  /\b(user\s?name|user\s?id|login|e-?mail|account\s*(name|id)?)\b/i;

/** Input types a one-time-code box is plausibly rendered as. */
const OTP_INPUT_TYPES = new Set(['text', 'tel', 'number']);

function tokensOf(autocomplete: string | undefined): string[] {
  if (!autocomplete) return [];
  return autocomplete.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Document-order walk over everything that could be a form field.
 *
 * `synthetic` nodes are skipped: they are manufactured by the walker to
 * enumerate a short `<select>` and have no element behind them, so the
 * page-side index has no entry for their key and a write aimed at one could
 * never resolve. That is the trap docs/design/tier1.md section 2 names.
 */
function collect(root: SnapshotNode, out: SnapshotNode[]): void {
  if (root.synthetic !== true && root.ref && root.role === 'textbox') {
    out.push(root);
  }
  for (const c of root.children) collect(c, out);
}

export function planCredentialFill(
  root: SnapshotNode,
  opts: { hasTotp: boolean },
): CredentialPlan {
  const nodes: SnapshotNode[] = [];
  collect(root, nodes);

  const passwords: Candidate[] = [];
  const otps: Candidate[] = [];
  const usernames: Candidate[] = [];

  for (const n of nodes) {
    const label = n.name ?? '';
    const ac = tokensOf(n.autocomplete);
    const free = isFreeTextPrompt(label);
    const mk = (confidence: number): Candidate => ({
      ref: n.ref!,
      key: n.key,
      label,
      confidence,
      hasValue: Boolean(n.value),
    });

    // PASSWORD: `type=password` and nothing else, ever. No label heuristic
    // promotes a field to password-candidate — a "Password" label on a plain
    // text input is a field whose value the walker serialises, which is the
    // one place a saved password must never go.
    if (n.inputType === 'password') {
      passwords.push(mk(1));
      continue;
    }

    const typeOk = n.inputType === undefined || OTP_INPUT_TYPES.has(n.inputType);

    // OTP, in tier order.
    if (typeOk && !free) {
      if (ac.includes('one-time-code')) {
        otps.push(mk(1));
        continue;
      }
      const m = OTP_WORDS.exec(label);
      if (m && (OTP_SELF_SUFFICIENT.test(m[0]) || OTP_CODE_WORD.test(label))) {
        otps.push(mk(0.85));
        continue;
      }
    }

    // USERNAME, in tier order.
    if (free) continue;
    if (ac.includes('username') || ac.includes('email')) usernames.push(mk(1));
    else if (n.inputType === 'email') usernames.push(mk(0.9));
    else if (USERNAME_WORDS.test(label)) usernames.push(mk(0.8));
  }

  // Ambiguity ERRORS with the candidates and never guesses — the same rule
  // `select` follows for options, for the same reason: a near-miss silently
  // resolved is a wrong value the human submits without noticing.

  if (passwords.length > 1) {
    // A sign-up or change-password form (new + confirm). Filling a SAVED
    // password into "new password" is wrong in a way the human does not find
    // out about until the next sign-in fails.
    return { ok: false, code: 'AMBIGUOUS_FIELDS', candidates: passwords.map((c) => c.label) };
  }
  if (otps.length > 1) {
    // Also covers the one-box-per-digit UI, which is out of scope (section 18).
    // The wire string names it, so the agent can tell the human something
    // useful rather than "it did not work".
    return { ok: false, code: 'AMBIGUOUS_FIELDS', candidates: otps.map((c) => c.label) };
  }

  const password = passwords[0];
  const otp = otps[0];

  if (!password && !otp) return { ok: false, code: 'NO_FIELDS' };
  if (!password && !opts.hasTotp) return { ok: false, code: 'OTP_NO_SEED' };

  // A one-time-code box on a page that ALSO has a password, for an entry with
  // no seed, is not a refusal: the username and password are still fillable and
  // still useful, and the human types the code. Only the OTP-ONLY page — where
  // there would be nothing left to do — is `OTP_NO_SEED` above.
  const otpTarget = opts.hasTotp ? otp : undefined;

  // The walker renders a non-empty password as `••••••`, so `hasValue` is all
  // that is knowable here — and all that is needed. No `overwrite` parameter is
  // added: the agent already has `browser_act action:"clear"` if the human
  // wants it cleared, and that is a page action rather than a credential lever.
  if (password?.hasValue) return { ok: false, code: 'ALREADY_FILLED' };

  // An OTP-only fill is the second step of a two-step sign-in, where the
  // username is already displayed. A username there would be noise at best.
  let username: Candidate | undefined;
  if (password) {
    const top = Math.max(0, ...usernames.map((c) => c.confidence));
    const tied = usernames.filter((c) => c.confidence === top);
    if (tied.length > 1) {
      return { ok: false, code: 'AMBIGUOUS_FIELDS', candidates: tied.map((c) => c.label) };
    }
    username = tied[0];
  }

  // Write order is username, then password, then otp, regardless of document
  // order. It matches human order, and a page whose username `change` handler
  // reveals the password field will have run it before the password write.
  const targets: CredentialTarget[] = [];
  const push = (c: Candidate | undefined, kind: CredentialTargetKind): void => {
    if (c) targets.push({ ref: c.ref, key: c.key, label: c.label, kind });
  };
  push(username, 'username');
  push(password, 'password');
  push(otpTarget, 'otp');

  return { ok: true, targets };
}

/** The fixed vocabulary section 9.2's `Will fill:` line is drawn from. */
export function describeTargets(targets: CredentialTarget[]): string {
  const has = (k: CredentialTargetKind): boolean => targets.some((t) => t.kind === k);
  if (has('username') && has('password') && has('otp')) {
    return 'username, password and two-factor code';
  }
  if (has('username') && has('password')) return 'username and password';
  if (has('password')) return 'password';
  return 'two-factor code';
}
