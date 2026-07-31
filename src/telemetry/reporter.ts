import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { payloadIsSafe, scrubEvent } from './scrub.js';

/**
 * Crash reporting to uh-oh.
 *
 * Off by default. For a browser that sells itself on privacy, any other
 * default is indefensible — the user has to turn this on, knowing what it
 * sends.
 *
 * Two rules shape the implementation:
 *
 *   1. **The vault reports nothing, ever.** Not scrubbed — excluded. Errors
 *      originating in the vault window or in vault code paths are dropped
 *      before they reach the scrubber, because the cost of a mistake there is
 *      unbounded and a diagnostic is not worth it.
 *
 *   2. **Fail closed.** The uh-oh client documents that a `beforeSend` which
 *      throws results in the event being sent *unmodified* — which for a
 *      scrubber is exactly backwards. So our hook can never throw: everything
 *      is wrapped, and any failure returns null (drop) rather than propagating.
 */

export interface TelemetryConfig {
  enabled: boolean;
  dsn?: string;
  /** Per-install salt for origin hashing. Never transmitted. */
  salt: string;
}

let config: TelemetryConfig | null = null;
let dropped = 0;
let sent = 0;

function configPath(): string {
  return join(app.getPath('userData'), 'telemetry.json');
}

export async function loadTelemetryConfig(): Promise<TelemetryConfig> {
  if (config) return config;
  try {
    const raw = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelemetryConfig>;
    config = {
      enabled: parsed.enabled === true,
      dsn: parsed.dsn,
      salt: parsed.salt ?? randomBytes(16).toString('hex'),
    };
  } catch {
    // Absent config means off. Opt-in, not opt-out.
    config = { enabled: false, salt: randomBytes(16).toString('hex') };
  }
  return config;
}

export async function saveTelemetryConfig(next: {
  enabled: boolean;
  dsn?: string;
}): Promise<void> {
  const current = await loadTelemetryConfig();
  config = { ...current, enabled: next.enabled, dsn: next.dsn ?? current.dsn };
  await writeFile(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * The `beforeSend` hook.
 *
 * Exported separately from the SDK wiring so it can be tested directly — which
 * matters more here than anywhere else in the codebase, because this function
 * failing open is the difference between a crash report and a privacy breach.
 */
export function makeBeforeSend(opts: { salt: string; homeDir?: string }) {
  const homeDir = opts.homeDir ?? homedir();

  return (event: unknown): unknown | null => {
    try {
      if (!event || typeof event !== 'object') return null;
      const e = event as Record<string, unknown>;

      if (originatesInVault(e)) {
        dropped++;
        return null;
      }

      const scrubbed = scrubEvent(e, { salt: opts.salt, homeDir });
      if (!scrubbed) {
        dropped++;
        return null;
      }

      // Independent final check over the serialized payload. Its value is that
      // it does not depend on the structural pass above being correct.
      if (!payloadIsSafe(JSON.stringify(scrubbed))) {
        dropped++;
        return null;
      }

      sent++;
      return scrubbed;
    } catch {
      // Fail closed. The SDK would otherwise send the raw event.
      dropped++;
      return null;
    }
  };
}

/**
 * Does this event come from the vault?
 *
 * Deliberately broad: any mention of a vault module in any frame, or a vault
 * tag, is enough to drop it. False positives cost a diagnostic; a false
 * negative costs a credential.
 */
export function originatesInVault(event: Record<string, unknown>): boolean {
  const tags = event['tags'];
  if (tags && typeof tags === 'object') {
    const surface = (tags as Record<string, unknown>)['surface'];
    if (surface === 'vault') return true;
  }

  const exception = event['exception'] as
    | { stacktrace?: { frames?: { filename?: string }[] } }
    | undefined;

  const frames = exception?.stacktrace?.frames ?? [];
  return frames.some((f) => /vault|credential|passphrase/i.test(f.filename ?? ''));
}

export function telemetryStats(): { sent: number; dropped: number; enabled: boolean } {
  return { sent, dropped, enabled: config?.enabled === true };
}

/**
 * Wire the SDK.
 *
 * The uh-oh client is vendored per its own instructions rather than imported,
 * so this is where it gets attached once a client file is dropped in. Until
 * then the hook above is fully testable on its own, which is the part that
 * carries the risk.
 */
export async function initTelemetry(): Promise<{ active: boolean; reason?: string }> {
  const cfg = await loadTelemetryConfig();
  if (!cfg.enabled) return { active: false, reason: 'disabled (default)' };
  if (!cfg.dsn) return { active: false, reason: 'no DSN configured' };

  // Deliberately not auto-installing global handlers here. See README: the
  // vendored client lands in src/telemetry/uh-oh-client.ts, and this function
  // calls its init() with { dsn, release, beforeSend: makeBeforeSend(...) }.
  return { active: false, reason: 'uh-oh client not yet vendored' };
}
