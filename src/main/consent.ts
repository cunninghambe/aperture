import { BrowserWindow, dialog, type BaseWindow } from 'electron';

/**
 * Human consent for agent-initiated fills.
 *
 * This exists because the previous "gate" was a sentence in a tool description
 * asking the agent to check with the human. That is not a gate — it is the
 * agent's judgement, and the agent is precisely the component we have assumed
 * is manipulable by page content. The vault got origin binding with no
 * override; profile autofill got a suggestion. That inconsistency was the
 * single worst thing in this codebase.
 *
 * The dialog is a native OS modal owned by the main process. The agent cannot
 * render it, cannot see it, cannot click it, and cannot pass a parameter that
 * skips it. There is deliberately no `force`, no `skipConsent`, and no
 * "already approved" argument anywhere in the call path.
 */

export type ConsentScope = 'ordinary' | 'sensitive';

export interface ConsentRequest {
  origin: string;
  /** Field names only — never values, and never for sensitive fields. */
  fields: string[];
  sensitiveFields: string[];
  /** Verbatim from the agent, shown quoted and attributed. Never parsed. */
  reason?: string;
}

/** Grants live for one origin, for a bounded window, in memory only. */
interface Grant {
  origin: string;
  expiresAt: number;
  /** Sensitive fields always re-prompt, so a grant never covers them. */
}

const grants = new Map<string, Grant>();
const GRANT_MS = 10 * 60 * 1000;

/**
 * Rate limit. A prompt flood is an attack, and the right response to an attack
 * is to stop rather than to keep asking.
 */
const recent: number[] = [];
const MAX_PROMPTS_PER_MINUTE = 6;

function rateLimited(now: number): boolean {
  while (recent.length && now - recent[0]! > 60_000) recent.shift();
  return recent.length >= MAX_PROMPTS_PER_MINUTE;
}

export type ConsentResult =
  | { ok: true; via: 'grant' | 'human' }
  | { ok: false; reason: 'denied' | 'rate-limited' | 'no-window' };

export async function requestFillConsent(
  parent: BaseWindow | null,
  req: ConsentRequest,
): Promise<ConsentResult> {
  const now = Date.now();
  const hasSensitive = req.sensitiveFields.length > 0;

  // A live grant covers ordinary fields for the same origin. Sensitive fields
  // never ride on a grant — a date of birth or national ID is worth one
  // deliberate click every time.
  if (!hasSensitive) {
    const g = grants.get(req.origin);
    if (g && g.expiresAt > now) return { ok: true, via: 'grant' };
  }

  if (rateLimited(now)) return { ok: false, reason: 'rate-limited' };
  if (!parent) return { ok: false, reason: 'no-window' };
  recent.push(now);

  const lines = [
    `Aperture's AI agent wants to fill a form on:`,
    ``,
    `    ${req.origin}`,
    ``,
    `Fields: ${req.fields.join(', ') || '(none)'}`,
  ];

  if (hasSensitive) {
    lines.push(
      ``,
      `⚠ Includes sensitive information: ${req.sensitiveFields.join(', ')}.`,
      `These values are never shown to the AI, but the website will receive them.`,
    );
  }

  if (req.reason) {
    // Quoted and attributed, so the human can see it is the agent speaking and
    // not Aperture. Never interpreted.
    lines.push(``, `The agent says: "${req.reason.slice(0, 200)}"`);
  }

  const buttons = hasSensitive
    ? ['Cancel', 'Fill once']
    : ['Cancel', 'Fill once', `Allow for ${req.origin} (10 min)`];

  const { response } = await dialog.showMessageBox(parent as BrowserWindow, {
    type: hasSensitive ? 'warning' : 'question',
    title: 'Confirm autofill',
    message: 'Fill this form with your saved details?',
    detail: lines.join('\n'),
    buttons,
    // Cancel is both the default and the escape action, so a reflexive Enter
    // or Escape denies rather than approves.
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });

  if (response === 0) return { ok: false, reason: 'denied' };
  if (response === 2) {
    grants.set(req.origin, { origin: req.origin, expiresAt: now + GRANT_MS });
  }
  return { ok: true, via: 'human' };
}

/** Drop all grants — called when the vault locks or the app loses focus. */
export function revokeAllGrants(): void {
  grants.clear();
}
