import { createHash } from 'node:crypto';

/**
 * Crash-report scrubbing.
 *
 * A browser is the worst application to wire crash reporting into carelessly,
 * because in a browser the crash *context is* the sensitive data. URLs are
 * browsing history. Page titles are page content. Stack traces can carry form
 * values. This process also holds the MCP bearer token, vault state, and the
 * user's profile PII. An unfiltered error report from a password manager is a
 * privacy incident, not a diagnostic.
 *
 * So this is an **allowlist**. Fields are dropped unless named here. A denylist
 * would mean every future field is a leak waiting for someone to remember it —
 * and that failure mode has already happened once in this stack (the Caddy
 * header-logging leak found in uh-oh's July 2026 security review).
 *
 * Everything here is pure and synchronous so it can be tested without a
 * browser or a network.
 */

/** Envelope fields we are willing to transmit at all. */
const ALLOWED_TOP_LEVEL = new Set([
  'sdk', 'timestamp', 'platform', 'release', 'level', 'exception',
  'breadcrumbs', 'device', 'fingerprint', 'tags',
]);

/** Context keys that are safe because we set them ourselves. */
const ALLOWED_CONTEXT = new Set([
  'electron', 'chrome', 'node', 'arch', 'locale', 'tabCount',
  'containerCount', 'uptimeSec', 'vaultLocked',
]);

/**
 * Patterns for secrets that must never appear in any string we send, wherever
 * they turn up — a message, a stack frame path, a breadcrumb.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [redacted]'],
  [/\bntn_[A-Za-z0-9]{20,}\b/g, '[notion-token]'],
  [/\bsecret_[A-Za-z0-9]{20,}\b/g, '[notion-token]'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g, '[jwt]'],
  [/"?(password|passphrase|token|secret|apiKey|api_key)"?\s*[:=]\s*"?[^",}\s]{4,}"?/gi,
   '$1=[redacted]'],
  [/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '[email]'],
];

export function scrubString(s: string): string {
  let out = s;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Reduce a URL to its origin, hashed.
 *
 * You need "these crashes cluster on one site", not which site. A salted hash
 * gives you the clustering without the browsing history. The salt is
 * per-install so hashes cannot be compared across users or rainbow-tabled
 * against a list of popular domains.
 */
export function hashOrigin(url: string, salt: string): string {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return 'site:unparseable';
  }
  const h = createHash('sha256').update(`${salt}|${origin}`).digest('hex');
  return `site:${h.slice(0, 12)}`;
}

/**
 * Replace any URL in a string with a hashed origin.
 *
 * Local file paths are kept — they are our own source paths and are what make
 * a stack trace useful — but the user's home directory is stripped, since it
 * usually contains their real name.
 */
export function scrubUrls(s: string, salt: string, homeDir: string): string {
  let out = s.replace(/https?:\/\/[^\s"'<>)]+/g, (m) => hashOrigin(m, salt));

  // Stack frames arrive as `file:///C:/Users/name/...` URLs, which the http(s)
  // pattern above does not touch. Strip the scheme so the path handling below
  // sees a plain path — the local path is what makes a trace useful, the
  // scheme is noise.
  out = out.replace(/\bfile:\/\/\/?/gi, '');

  if (homeDir) {
    // The home directory appears in at least three forms in practice, and
    // matching only the literal one let the username through in every stack
    // frame while the message itself scrubbed cleanly:
    //   C:\Users\name      (os.homedir)
    //   C:/Users/name      (file:// URL, forward slashes)
    //   C%3A%2FUsers%2Fname (percent-encoded, occasionally)
    const forward = homeDir.replace(/\\/g, '/');
    for (const form of [homeDir, forward, encodeURI(forward)]) {
      if (form) out = splitJoinCI(out, form, '~');
    }

    // Belt and braces: whatever the shape, the username itself must not
    // survive. This is what actually guarantees the property, since the
    // enumeration above can never be exhaustive.
    const user = homeDir.split(/[\\/]/).filter(Boolean).pop();
    if (user && user.length >= 3) out = splitJoinCI(out, user, '~user');
  }

  return out;
}

/** Case-insensitive replace-all. Windows paths vary in case constantly. */
function splitJoinCI(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const at = lowerHay.indexOf(lowerNeedle, i);
    if (at === -1) {
      out += haystack.slice(i);
      return out;
    }
    out += haystack.slice(i, at) + replacement;
    i = at + needle.length;
  }
}

export interface ScrubOptions {
  salt: string;
  homeDir: string;
}

/**
 * Rebuild an event from scratch, copying only allowlisted fields.
 *
 * Rebuilding rather than deleting matters: a `delete` pass leaves anything the
 * SDK adds in a future version, whereas an empty object can only ever contain
 * what we explicitly put in it.
 */
export function scrubEvent(
  event: Record<string, unknown>,
  opts: ScrubOptions,
): Record<string, unknown> | null {
  const clean = (s: unknown): string =>
    typeof s === 'string' ? scrubUrls(scrubString(s), opts.salt, opts.homeDir) : '';

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (ALLOWED_TOP_LEVEL.has(k)) out[k] = v;
  }

  // `user` is dropped entirely, always. There is one user and we know who they
  // are; an identifier buys nothing and costs everything.
  delete out['user'];

  // The envelope shape below is the wire contract (@uh-oh/types
  // EventEnvelopeSchema), NOT a shape invented here. Getting it wrong does not
  // fail loudly in unit tests — it fails as a 400 at ingest, silently dropping
  // every crash. `stacktrace` is a flat StackFrame[]; `mechanism` is required.
  const exception = event['exception'] as
    | { type?: string; value?: string; stacktrace?: unknown; mechanism?: string }
    | undefined;

  if (exception) {
    const frames = Array.isArray(exception.stacktrace) ? exception.stacktrace : [];
    out['exception'] = {
      type: typeof exception.type === 'string' && exception.type
        ? exception.type
        : 'Error',
      value: clean(exception.value),
      stacktrace: frames.slice(0, 500).map((f) => {
        const frame = f as Record<string, unknown>;
        const out: Record<string, unknown> = { inApp: frame['inApp'] === true };
        // Optional fields are omitted rather than set to undefined: the schema
        // rejects an explicit null, and JSON.stringify drops undefined anyway.
        if (typeof frame['function'] === 'string') out['function'] = frame['function'];
        if (typeof frame['module'] === 'string') out['module'] = clean(frame['module']);
        if (typeof frame['filename'] === 'string') out['filename'] = clean(frame['filename']);
        if (typeof frame['lineno'] === 'number') out['lineno'] = frame['lineno'];
        if (typeof frame['colno'] === 'number') out['colno'] = frame['colno'];
        return out;
      }),
      // Required by the schema. Preserved as-is: it is an enum of our own
      // making ('js-global', 'js-manual', ...) and carries nothing sensitive.
      mechanism: typeof exception.mechanism === 'string'
        ? exception.mechanism
        : 'js-manual',
    };
  }

  // Breadcrumb messages are free-form and are the most likely place for a URL
  // or a form value to have been logged.
  const crumbs = event['breadcrumbs'];
  if (Array.isArray(crumbs)) {
    // Field names per BreadcrumbSchema: category, message, level, ts. The
    // timestamp key is `ts`, not `timestamp` — an easy and silent 400.
    out['breadcrumbs'] = crumbs.slice(-40).map((c) => {
      const crumb = c as Record<string, unknown>;
      const b: Record<string, unknown> = {
        category: typeof crumb['category'] === 'string' && crumb['category']
          ? crumb['category'].slice(0, 64)
          : 'app',
        message: clean(crumb['message']).slice(0, 1024),
        level: typeof crumb['level'] === 'string' ? crumb['level'] : 'info',
      };
      if (typeof crumb['ts'] === 'string') b['ts'] = crumb['ts'];
      // `data` is dropped wholesale: an arbitrary bag cannot be allowlisted
      // meaningfully, and it is where page-derived values end up.
      return b;
    });
  }

  const ctx = event['context'];
  if (ctx && typeof ctx === 'object') {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx as Record<string, unknown>)) {
      if (!ALLOWED_CONTEXT.has(k)) continue;
      kept[k] = typeof v === 'string' ? clean(v) : v;
    }
    out['context'] = kept;
  }

  const tags = event['tags'];
  if (tags && typeof tags === 'object') {
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
      if (typeof v === 'string') kept[k] = clean(v);
    }
    out['tags'] = kept;
  }

  return out;
}

/**
 * Final gate before transmission.
 *
 * A last sweep over the fully-serialized payload, because the value of this
 * check is that it does not depend on the correctness of everything above it.
 * If a secret survived the structural pass, this drops the whole event.
 */
const FORBIDDEN_IN_PAYLOAD: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\bntn_[A-Za-z0-9]{20,}/,
  /"password"\s*:\s*"[^"]+"/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function payloadIsSafe(serialized: string): boolean {
  return !FORBIDDEN_IN_PAYLOAD.some((re) => re.test(serialized));
}
