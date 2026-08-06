import { createHash } from 'node:crypto';

/**
 * WEB BOT AUTH — THE PURE LEAF.
 *
 * RFC 9421 signature-base construction, RFC 7638/8037 thumbprints, the §6
 * config validator, and the §3 signing predicate. `docs/design/webbotauth.md`
 * is the decision record; this file implements it and nothing else.
 *
 * **NO IMPORTS FROM `electron` OR FROM ANYWHERE ELSE IN `src/`.** That is the
 * `redact.ts` / `origin.ts` / `download.ts` rule and it is here for the reason
 * those files give: the suite must execute the SHIPPED code rather than a copy
 * of it. `engine.ts` imports `electron`, which is why lifetime members 3 and 4
 * have rulings and no runtime measurement anywhere; this module does not repeat
 * that. `node:crypto` is the one exception and it is not an exception to the
 * rule as stated — it is a Node builtin, available identically to the main
 * process and to vitest, and a thumbprint needs a SHA-256 from somewhere.
 *
 * `registrableDomain` and `originOf` are INJECTED rather than imported. They
 * live in `src/vault/vault.ts` and `src/shared/origin.ts`, and importing either
 * would drag the vault (and therefore `electron`) in here. Injection keeps the
 * leaf executable while still using the ONE spelling of each fact — there is no
 * second implementation of "which origin is this" or "which registrable domain
 * is this" in this file, which is the failure `src/shared/origin.ts`'s own
 * header exists to prevent.
 *
 * WHAT THIS FILE MUST NEVER DO — §8, binding rather than tone:
 *
 *   · Nothing here reads a RESPONSE. The predicate is a pure function of
 *     configuration, tab state and the request. `Accept-Signature` is not
 *     parsed, not named, and not reachable; there is no block-page retry, and
 *     no server or page can turn signing on, off, or re-aim it.
 *   · Nothing here varies a fingerprint surface. The only bytes this module
 *     produces are the three signature headers, and the mux contract makes
 *     them additive.
 *   · Nothing here returns private key material. `signatureBase` takes bytes
 *     to sign and hands them back; the key never enters this file at all.
 */

// ---------------------------------------------------------------------------
// Structured-field serialization (RFC 8941), only as much as RFC 9421 needs.
// ---------------------------------------------------------------------------

/**
 * An RFC 8941 sf-string.
 *
 * Backslash and double quote are escaped; everything else must already be
 * printable ASCII, because the signature base is an ASCII string by RFC 9421
 * §2.5 step 4 and a signer that silently emitted UTF-8 would produce a base no
 * verifier could reconstruct. A non-conforming character throws rather than
 * being dropped: dropping it would make the signature cover different bytes
 * than the header carries, which is the one failure a signature cannot express.
 */
export function sfString(s: string): string {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`sf-string: non-printable-ASCII code point U+${c.toString(16).toUpperCase()}`);
    }
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One covered-component identifier, in the two shapes this design uses.
 *
 * `key` is present only for the `signature-agent` sf-dictionary form (§4). The
 * two candidate forms are both implemented here, deliberately: which one ships
 * is a fact about the ecosystem measured by the differential probe, not a
 * choice made in code, and a leaf that could only spell one of them would have
 * made the probe's answer unactionable.
 */
export interface Component {
  name: string;
  key?: string;
}

/** `"@authority"` · `"signature-agent"` · `"signature-agent";key="sig1"`. */
export function serializeComponent(c: Component): string {
  const base = sfString(c.name.toLowerCase());
  return c.key === undefined ? base : `${base};key=${sfString(c.key)}`;
}

/** A signature parameter, ordered — the wire order IS the signed bytes. */
export type SigParam = [name: string, value: number | string];

/**
 * The `@signature-params` value: an inner list of component identifiers,
 * followed by the parameters in the order given.
 *
 * The ORDER of `params` is load-bearing and that is why this takes an array
 * rather than an object. RFC 9421 gives no canonical parameter order; the
 * verifier reproduces the literal string off the wire, so any order verifies —
 * but two implementations comparing bases byte-for-byte must be handed the same
 * one, which is exactly what the differential probe does.
 *
 * Integers are emitted bare (`created=1618884473`) and strings quoted
 * (`keyid="…"`), per RFC 8941 Item serialization.
 */
export function signatureParamsValue(components: Component[], params: SigParam[]): string {
  const inner = components.map(serializeComponent).join(' ');
  const tail = params
    .map(([k, v]) => (typeof v === 'number' ? `;${k}=${v}` : `;${k}=${sfString(v)}`))
    .join('');
  return `(${inner})${tail}`;
}

// ---------------------------------------------------------------------------
// Component values (RFC 9421 §2.1 and §2.2).
// ---------------------------------------------------------------------------

/** The minimum of a request this module needs in order to canonicalize it. */
export interface SignableRequest {
  method: string;
  /** Absolute request URL, as the network layer has it. */
  url: string;
  /** Header values Aperture itself is about to send, lowercased names. */
  headers: Record<string, string>;
}

/**
 * `@authority` — RFC 9421 §2.2.3.
 *
 * Host lowercased, default port for the scheme omitted, non-default port kept.
 * `new URL` already lowercases the host and already drops `:80` on http and
 * `:443` on https, so the elision is Chromium's own parser rather than a second
 * table of default ports that could drift from it.
 */
function authorityOf(url: URL): string {
  return url.host.toLowerCase();
}

/**
 * `@path` — RFC 9421 §2.2.6.
 *
 * The absolute path, no query, no trailing `?`, an empty path normalized to
 * `/`, and percent-encoded octets left EXACTLY as sent: the RFC's simple string
 * comparison rule. `URL.pathname` preserves the encoding the caller wrote, so
 * decoding here would be the bug rather than the fix.
 */
function pathOf(url: URL): string {
  return url.pathname === '' ? '/' : url.pathname;
}

/**
 * The canonical value of one covered component against one request.
 *
 * Header values are trimmed of leading and trailing OWS per RFC 9421 §2.1.
 * Aperture builds every header it covers, so the trim never fires in
 * production — it is here because the bench verifier reads the same rules off
 * the wire and the two must not disagree about a byte.
 */
export function componentValue(req: SignableRequest, c: Component): string {
  if (c.name.startsWith('@')) {
    if (c.key !== undefined) throw new Error(`derived component ${c.name} takes no key parameter`);
    const url = new URL(req.url);
    switch (c.name) {
      case '@method':
        return req.method.toUpperCase();
      case '@authority':
        return authorityOf(url);
      case '@path':
        return pathOf(url);
      default:
        throw new Error(`unsupported derived component ${c.name}`);
    }
  }
  const raw = req.headers[c.name.toLowerCase()];
  if (raw === undefined) throw new Error(`covered header not present: ${c.name}`);
  const value = raw.trim();
  if (c.key === undefined) return value;
  // The sf-dictionary form: the covered value is the named MEMBER, serialized
  // on its own, not the whole header. Cloudflare's library gets this wrong at
  // 0.1.3 (it hands the whole header value back), which is the measurement that
  // decided which form ships — see the implementation report in webbotauth.md.
  const member = dictionaryMember(value, c.key);
  if (member === null) throw new Error(`no member "${c.key}" in ${c.name}`);
  return member;
}

/**
 * The value of one member of an sf-dictionary header, re-serialized.
 *
 * Deliberately narrow: this design's only dictionary-valued header is
 * `Signature-Agent`, whose members are sf-strings. A general RFC 8941 parser
 * here would be a second structured-fields implementation with nothing asking
 * for it, and every member of it would be untested.
 */
function dictionaryMember(header: string, key: string): string | null {
  for (const part of splitTopLevel(header)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== key) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/** Split on commas that are not inside a quoted string. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\') i += 1;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * The signature base — RFC 9421 §2.5.
 *
 * One line per covered component, then the `@signature-params` line, joined by
 * LF with NO trailing newline (the ABNF is `*( signature-base-line LF )
 * signature-params-line`). A trailing newline is the single most common way two
 * implementations produce different bytes from the same intent, which is why
 * the RFC vector test asserts the whole string rather than a hash of it.
 */
export function signatureBase(
  req: SignableRequest,
  components: Component[],
  paramsValue: string,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of components) {
    const id = serializeComponent(c);
    if (seen.has(id)) throw new Error(`duplicate covered component ${id}`);
    seen.add(id);
    lines.push(`${id}: ${componentValue(req, c)}`);
  }
  lines.push(`"@signature-params": ${paramsValue}`);
  const out = lines.join('\n');
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e\n]/.test(out)) throw new Error('signature base contains non-ASCII bytes');
  return out;
}

// ---------------------------------------------------------------------------
// Key identity (RFC 7638 §3.2, RFC 8037 A.3).
// ---------------------------------------------------------------------------

/** The public half of an Ed25519 JWK. */
export interface OkpPublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

/**
 * The base64url SHA-256 JWK thumbprint, over the OKP required members only.
 *
 * RFC 7638 §3.2: the members are the REQUIRED ones for the key type, in
 * lexicographic order, serialized as JSON with no whitespace and no other
 * members. For OKP those are `crv`, `kty`, `x` (RFC 8037 A.3), and any `d`,
 * `kid`, `use` or `alg` a caller happens to be holding must not enter the hash
 * — which is why this takes the three fields rather than a JWK object it would
 * have to remember to strip. A thumbprint computed over a private JWK is a
 * DIFFERENT string, so the verifier's keyid lookup would miss and the failure
 * would be silent.
 */
export function jwkThumbprint(jwk: OkpPublicJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

// ---------------------------------------------------------------------------
// Configuration (§6), validated (§5).
// ---------------------------------------------------------------------------

/** One container's signing configuration, after validation. */
export interface ContainerSigning {
  containerId: string;
  /** The `Signature-Agent` value's URL. HTTPS in file config; §7.4 may seed loopback HTTP. */
  directoryUrl: string;
  /** Registrable-domain entries, canonical form. */
  domains: string[];
  /** Exact-origin entries, as `originOf()` spells them. */
  origins: string[];
}

export interface BotAuthConfig {
  /** Only containers that may sign. An entry with any error is absent, not disabled. */
  containers: Record<string, ContainerSigning>;
}

export interface OriginFns {
  registrableDomain(origin: string): string | null;
  originOf(url: string): string | null;
}

export interface ParseOptions {
  /** Container ids that are ephemeral, so §5.3 can refuse them. */
  ephemeral?: (id: string) => boolean;
  /** §7.4's seeded dev path may carry loopback HTTP; file config may not. */
  allowInsecureDirectory?: boolean;
}

export interface ParseResult {
  config: BotAuthConfig;
  /** One line per refusal, already fit to print. Never thrown. */
  errors: string[];
}

/** An IP literal or a single-label host — no registrable domain to speak of. */
function isLiteralOrSingleLabel(host: string): boolean {
  if (host.startsWith('[') || host.includes(':')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return !host.includes('.');
}

/**
 * Parse and validate `userData/botauth.json`.
 *
 * FAIL CLOSED PER ENTRY, and never throw: §6. A bad container entry disables
 * signing for that container and produces a line naming the reason; an
 * unparseable file disables signing everywhere; the browser always starts. A
 * config error must never be quieter than the feature it disables, which is why
 * every refusal below carries a message a human can act on rather than a
 * boolean.
 *
 * §5.2 is enforced here and it is the one rule that fails TWO containers for
 * one mistake: a `directoryUrl` appearing in more than one container disables
 * signing for every container involved. Picking a winner would silently grant
 * one container an identity the human ambiguously assigned, and the
 * `Signature-Agent` VALUE is itself a cross-container correlator — two
 * containers sending the same directory URL are linkable by any origin
 * allowlisted in both, which is the container boundary defeated through a side
 * door the per-container keys had closed.
 */
export function parseBotAuthConfig(
  text: string,
  fns: OriginFns,
  opts: ParseOptions = {},
): ParseResult {
  const errors: string[] = [];
  const containers: Record<string, ContainerSigning> = {};

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    return {
      config: { containers: {} },
      errors: [`botauth.json is not valid JSON (${err instanceof Error ? err.message : String(err)}) — signing is off everywhere`],
    };
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return { config: { containers: {} }, errors: ['botauth.json is not a JSON object — signing is off everywhere'] };
  }
  const obj = root as Record<string, unknown>;
  if (obj['version'] !== 1) {
    return {
      config: { containers: {} },
      errors: [`botauth.json "version" must be 1, found ${JSON.stringify(obj['version'])} — signing is off everywhere`],
    };
  }
  const raw = obj['containers'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: { containers: {} }, errors: ['botauth.json "containers" must be an object — signing is off everywhere'] };
  }

  // Pass 1: validate each entry on its own terms.
  const byDirectory = new Map<string, string[]>();
  for (const [containerId, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    const where = `container "${containerId}"`;
    if (typeof entryRaw !== 'object' || entryRaw === null || Array.isArray(entryRaw)) {
      errors.push(`${where}: entry must be an object — signing off for it`);
      continue;
    }
    const entry = entryRaw as Record<string, unknown>;

    if (opts.ephemeral?.(containerId)) {
      // §5.3. An ephemeral container is the maximal-unlinkability primitive; a
      // persistent identity assertion inside one is a contradiction.
      errors.push(`${where}: is ephemeral, and an ephemeral container cannot carry a persistent identity — signing off for it`);
      continue;
    }

    const directoryUrl = entry['directoryUrl'];
    if (typeof directoryUrl !== 'string' || directoryUrl === '') {
      errors.push(`${where}: "directoryUrl" must be a non-empty string — signing off for it`);
      continue;
    }
    let dir: URL;
    try {
      dir = new URL(directoryUrl);
    } catch {
      errors.push(`${where}: "directoryUrl" is not a URL — signing off for it`);
      continue;
    }
    if (dir.protocol !== 'https:' && !opts.allowInsecureDirectory) {
      errors.push(`${where}: "directoryUrl" must be https:// — signing off for it`);
      continue;
    }

    const signRaw = entry['sign'];
    if (!Array.isArray(signRaw) || signRaw.length === 0) {
      errors.push(`${where}: "sign" must be a non-empty array — signing off for it`);
      continue;
    }

    const domains: string[] = [];
    const origins: string[] = [];
    let entryFailed = false;
    for (const itemRaw of signRaw) {
      if (typeof itemRaw !== 'string' || itemRaw.trim() === '') {
        errors.push(`${where}: every "sign" entry must be a non-empty string — signing off for it`);
        entryFailed = true;
        break;
      }
      const item = itemRaw.trim();

      if (/^https?:\/\//i.test(item)) {
        // An exact-origin entry. Compared with `originOf()` equality, so it is
        // stored the way `originOf()` spells it and nothing else.
        const origin = fns.originOf(item);
        if (origin === null) {
          errors.push(`${where}: "${item}" has no origin — signing off for it`);
          entryFailed = true;
          break;
        }
        origins.push(origin);
        continue;
      }

      // A registrable-domain entry. It must equal its OWN registrableDomain()
      // (§6): `www.example.com` is a host and not a registrable domain, and
      // silently canonicalizing it would make the file claim something the
      // human did not write.
      const canonical = fns.registrableDomain(`https://${item}`);
      if (canonical === null) {
        errors.push(`${where}: "${item}" has no registrable domain (unknown suffix, or a bare public suffix) — signing off for it`);
        entryFailed = true;
        break;
      }
      if (canonical !== item.toLowerCase()) {
        errors.push(`${where}: "${item}" is not a registrable domain; write "${canonical}" — signing off for it`);
        entryFailed = true;
        break;
      }
      // DEVIATION FROM THE SPEC'S PREMISE, FAILING CLOSED — see the
      // implementation report in docs/design/webbotauth.md, item 1.
      //
      // §3 S1 says exact-origin entries exist "because registrableDomain()
      // correctly returns null for IP literals and single-label hosts". It does
      // not: `src/vault/vault.ts` returns the HOST for `localhost`, for a
      // dotted-quad and for anything bracketed, deliberately ("literal
      // addresses have no registrable domain; they are their own identity").
      // So a bare `127.0.0.1` in `sign` would pass the equality check above and
      // then match at DOMAIN granularity — every port and BOTH schemes on that
      // address, which is strictly wider than the exact-origin entry the human
      // meant and wider than anything §3 sanctions. Refused here, naming the
      // spelling that does what they meant.
      if (isLiteralOrSingleLabel(item.toLowerCase())) {
        errors.push(
          `${where}: "${item}" is an address literal or a single-label host, which has no registrable domain to scope a match to; ` +
            `write the exact origin instead (e.g. "http://${item}:8080") — signing off for it`,
        );
        entryFailed = true;
        break;
      }
      domains.push(canonical);
    }
    if (entryFailed) continue;

    containers[containerId] = {
      containerId,
      directoryUrl,
      domains,
      origins,
    };
    byDirectory.set(directoryUrl, [...(byDirectory.get(directoryUrl) ?? []), containerId]);
  }

  // Pass 2: §5.2 — one directory URL, at most one container. Both go off.
  for (const [url, ids] of byDirectory) {
    if (ids.length < 2) continue;
    for (const id of ids) delete containers[id];
    errors.push(
      `directoryUrl ${url} is configured for ${ids.length} containers (${ids.join(', ')}). ` +
        'The Signature-Agent VALUE is itself an identifier, so two containers sending it are linkable by any origin ' +
        'allowlisted in both — signing off for ALL of them. Host the same JWKS at two URLs if you mean this.',
    );
  }

  return { config: { containers }, errors };
}

// ---------------------------------------------------------------------------
// The predicate (§3).
// ---------------------------------------------------------------------------

export interface SignContext {
  /** Electron's `resourceType`, verbatim. */
  resourceType: string;
  /** Whether the owning tab was created through the MCP surface. */
  tabAgentOwned: boolean;
  /** The owning tab's container, or null when the request has no tab. */
  containerId: string | null;
  /** The absolute request URL. */
  targetUrl: string;
  config: BotAuthConfig | null;
}

export type SignRefusal =
  | 'no-config'
  | 'no-tab'
  | 'container-not-configured'
  | 'not-agent-owned'
  | 'not-main-frame'
  | 'not-allowlisted';

export type SignDecision =
  | { sign: false; why: SignRefusal }
  | { sign: true; container: ContainerSigning };

/**
 * Does the target match this container's allowlist? — S1.
 *
 * TWO KINDS OF ENTRY AND ONE HARD RULE. An exact-origin entry is compared with
 * `originOf()` equality, so scheme, host and port all have to agree. A
 * registrable-domain entry is compared with `registrableDomain()`, so the
 * subdomains of one operator are in and another tenant of a shared host is not
 * (the PSL's private section is what keeps `victim.github.io` and
 * `attacker.github.io` apart).
 *
 * **A `null` from `registrableDomain()` MATCHES NOTHING.** Not the empty
 * string, not another null, not a bucket. `registrableDomain` answers null for
 * a host whose suffix is not in the PSL and for a bare public suffix, and a
 * null-equality comparison would pool every such origin into one identity — the
 * exact failure `originOf`'s header warns about, transplanted into a new
 * module. There is no code path below on which a null participates in a
 * comparison.
 */
function matchesAllowlist(targetUrl: string, c: ContainerSigning, fns: OriginFns): boolean {
  const origin = fns.originOf(targetUrl);
  if (origin === null) return false;
  if (c.origins.includes(origin)) return true;
  if (c.domains.length === 0) return false;
  const rd = fns.registrableDomain(origin);
  if (rd === null) return false;
  return c.domains.includes(rd);
}

/**
 * The §3 predicate: sign iff S1 ∧ S2 ∧ S3 ∧ S4.
 *
 * A PURE FUNCTION OF CONFIGURATION, TAB STATE AND THE REQUEST. No response, no
 * page-supplied string, no clock, no I/O — which is what makes the whole matrix
 * vitest-exhaustible and what makes §8's third clause structural rather than a
 * promise. Evaluated S4 → S3 → S2 → S1 because S1 needs the container S4
 * resolves; the order is otherwise arbitrary and only the `why` depends on it.
 *
 * Returns a refusal REASON rather than a boolean so the guard block and the
 * matrix can tell "no configuration" from "wrong tab" from "off the allowlist".
 * The reason is never shown to an agent and never logged per request.
 */
export function decideSigning(ctx: SignContext, fns: OriginFns): SignDecision {
  // S4 — the container has signing configured (directory URL present, key
  // present, not ephemeral, no config error). Everything but "key present" is
  // decided at load: an entry with any error is ABSENT from the map rather than
  // present-and-disabled, so there is no second place to forget a check.
  if (!ctx.config) return { sign: false, why: 'no-config' };
  if (ctx.containerId === null) return { sign: false, why: 'no-tab' };
  const container = ctx.config.containers[ctx.containerId];
  if (!container) return { sign: false, why: 'container-not-configured' };

  // S3 — the tab is agentOwned. The one agent/human boundary that already
  // exists and is already shown to the human. A human's tab is shared
  // authorship and a bot assertion over it is the anti-detect lie inverted.
  if (!ctx.tabAgentOwned) return { sign: false, why: 'not-agent-owned' };

  // S2 — a main-frame document request. THE SHARPEST CUT IN THE DESIGN, and it
  // is spelled as an EQUALITY against the one value that may sign, never as a
  // denylist of values that may not. `resourceType !== 'subFrame'` reads
  // plausibly and signs `image` and `xhr`, which re-opens the minting oracle
  // this clause exists to close: page script on an allowlisted origin could
  // otherwise manufacture signed requests with a chosen method, path and body
  // by calling `fetch()`.
  if (ctx.resourceType !== 'mainFrame') return { sign: false, why: 'not-main-frame' };

  // S1 — the target is on this container's allowlist.
  if (!matchesAllowlist(ctx.targetUrl, container, fns)) return { sign: false, why: 'not-allowlisted' };

  return { sign: true, container };
}

// ---------------------------------------------------------------------------
// The wire format (§4).
// ---------------------------------------------------------------------------

/** The signature label. One signature, always this label. */
export const SIG_LABEL = 'sig1';

/** `tag` — the value that scopes this signature to Web Bot Auth. */
export const WBA_TAG = 'web-bot-auth';

/** `expires − created`, in seconds. */
export const EXPIRY_SECONDS = 300;

/**
 * Which spelling of the `Signature-Agent` component is on the wire.
 *
 * `sf-string`  — `Signature-Agent: "https://…"`, covered as `"signature-agent"`.
 * `sf-dict`    — `Signature-Agent: sig1="https://…"`, covered as
 *                `"signature-agent";key="sig1"`.
 *
 * draft-meunier-web-bot-auth-architecture-04 changed the header to an
 * sf-dictionary and marks the sf-string spelling LEGACY. Cloudflare's
 * `web-bot-auth` npm package at 0.1.3 emits the sf-string form and CANNOT
 * verify the sf-dictionary form — its verifier hands the whole header value to
 * the base builder instead of the named member, so it computes a base nobody
 * else computes. §4's decision procedure says to adopt the form the library
 * emits, and the differential probe is where that was measured rather than
 * assumed. Both are implemented so the day the library catches up is a
 * one-constant change with a test on each side of it.
 */
export type SignatureAgentForm = 'sf-string' | 'sf-dict';

/** The form that ships. See `SignatureAgentForm` and the implementation report. */
export const SHIPPED_SIGNATURE_AGENT_FORM: SignatureAgentForm = 'sf-string';

/** The covered components, in order. §4. */
export function coveredComponents(form: SignatureAgentForm): Component[] {
  return [
    { name: '@authority' },
    { name: '@method' },
    { name: '@path' },
    form === 'sf-dict' ? { name: 'signature-agent', key: SIG_LABEL } : { name: 'signature-agent' },
  ];
}

/** The `Signature-Agent` header VALUE for a directory URL, in the given form. */
export function signatureAgentValue(directoryUrl: string, form: SignatureAgentForm): string {
  const s = sfString(directoryUrl);
  return form === 'sf-dict' ? `${SIG_LABEL}=${s}` : s;
}

export interface SignatureInputs {
  /** Seconds since the epoch. */
  created: number;
  /** base64url, 64 CSPRNG bytes. */
  nonce: string;
  keyid: string;
  directoryUrl: string;
  form: SignatureAgentForm;
}

/**
 * Everything needed to sign, and the headers that carry the result.
 *
 * Split from the signing itself so the leaf never touches key material: this
 * returns the BASE to sign plus the two headers that are complete without the
 * signature, and the caller appends the signature bytes. That is not a
 * stylistic split — §2.5's "the private key never leaves the main process" is
 * easier to keep true when the module the test suite imports has no way to
 * hold one.
 */
export function prepareSignature(
  req: SignableRequest,
  inputs: SignatureInputs,
): { base: string; signatureInput: string; signatureAgent: string } {
  const components = coveredComponents(inputs.form);
  // §4's parameter enumeration, in §4's order. RFC 9421 fixes no order; the
  // verifier reproduces the literal string, so the only thing order has to be
  // is stable. `alg` is deliberately absent: §4 does not list it, the algorithm
  // is determined by the key the directory publishes, and RFC 9421 §7.3.7 warns
  // against a verifier trusting it. Cloudflare's verifier does not require it —
  // measured by the probe, not assumed.
  const params: SigParam[] = [
    ['created', inputs.created],
    ['expires', inputs.created + EXPIRY_SECONDS],
    ['keyid', inputs.keyid],
    ['tag', WBA_TAG],
    ['nonce', inputs.nonce],
  ];
  const paramsValue = signatureParamsValue(components, params);
  const signatureAgent = signatureAgentValue(inputs.directoryUrl, inputs.form);
  const withAgent: SignableRequest = {
    ...req,
    headers: { ...req.headers, 'signature-agent': signatureAgent },
  };
  return {
    base: signatureBase(withAgent, components, paramsValue),
    signatureInput: `${SIG_LABEL}=${paramsValue}`,
    signatureAgent,
  };
}

/** The `Signature` header value for a raw signature. */
export function signatureHeaderValue(signature: Uint8Array): string {
  return `${SIG_LABEL}=:${Buffer.from(signature).toString('base64')}:`;
}
