import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import * as uhOh from './uh-oh-client.js';
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

  // `stacktrace` is a flat StackFrame[] on the wire. Reading it as
  // `.stacktrace.frames` silently found nothing, so this returned false for
  // every event and the vault exclusion — the strongest claim in the telemetry
  // design — did not actually exclude anything.
  const exception = event['exception'] as { stacktrace?: unknown } | undefined;
  const frames = Array.isArray(exception?.stacktrace) ? exception.stacktrace : [];

  return frames.some((f) => {
    const filename = (f as { filename?: unknown }).filename;
    return (
      typeof filename === 'string' &&
      /vault|credential|passphrase|profileStore|attachments/i.test(filename)
    );
  });
}

export function telemetryStats(): { sent: number; dropped: number; enabled: boolean } {
  return { sent, dropped, enabled: config?.enabled === true };
}

/** Wire the vendored uh-oh client. No-op unless the human turned it on. */
export async function initTelemetry(release: string): Promise<{
  active: boolean;
  reason?: string;
}> {
  const cfg = await loadTelemetryConfig();
  if (!cfg.enabled) return { active: false, reason: 'disabled (default)' };
  if (!cfg.dsn) return { active: false, reason: 'no DSN configured' };

  try {
    uhOh.init({
      dsn: cfg.dsn,
      release,
      environment: app.isPackaged ? 'production' : 'development',
      runtime: 'node',
      debug: process.argv.includes('--telemetry-debug'),
      beforeSend: makeBeforeSend({ salt: cfg.salt }) as never,
      // The queue is spooled next to the other app data so a crash during
      // shutdown still reports on next launch.
      spoolDir: app.getPath('userData'),
      // Usage analytics stays off. This is a privacy browser; "which pages did
      // you open" is precisely what it exists not to send.
      analytics: { auto: false },
    } as never);

    // Non-secret build context, matching the scrubber's context allowlist.
    uhOh.setContext('electron', {
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      arch: process.arch,
    });

    // No user identity is ever attached. There is one user and we know who
    // they are; an id buys nothing and costs everything.
    uhOh.setUser(null);

    return { active: true };
  } catch (err) {
    // Telemetry must never be the reason the browser fails to start.
    return {
      active: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Report an error we caught ourselves.
 *
 * Routed through here rather than calling the client directly, so the
 * enabled-check and the vault exclusion cannot be bypassed by a future caller.
 */
export function report(err: unknown, surface: string): void {
  if (config?.enabled !== true) return;
  if (surface === 'vault') return;
  try {
    uhOh.setTag('surface', surface);
    uhOh.captureException(err);
  } catch {
    // Never let reporting an error raise one.
  }
}

export async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  if (config?.enabled !== true) return;
  try {
    await uhOh.flush(timeoutMs);
  } catch {
    /* shutdown path; nothing useful to do */
  }
}
