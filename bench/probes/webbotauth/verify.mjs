import { createPublicKey, createHash, verify as edVerify } from 'node:crypto';

/**
 * A WEB BOT AUTH VERIFIER, WRITTEN FROM RFC 9421 — THE SECOND INSTRUMENT.
 *
 * It shares no code with `src/net/`. That is the entire point: an
 * implementation verified only by itself has been verified of nothing, and the
 * failure mode is not hypothetical — a signer and a verifier built from one
 * canonicalization routine agree on every base they compute, including the
 * wrong ones. So this file re-reads RFC 9421 §2.1, §2.2, §2.3 and §2.5 and the
 * Web Bot Auth architecture draft, and re-implements them differently:
 * `botAuthCore.ts` BUILDS a base from a component list it was handed, this one
 * PARSES a component list off the wire and rebuilds the base from a raw request
 * line and raw headers.
 *
 * ITS OWN ACCEPTANCE, before it may judge anything (`selfTest` below): it
 * verifies RFC 9421 B.2.6 — a signature produced by neither implementation, by
 * the RFC's authors, over the RFC's own key — and it REJECTS a mutated copy of
 * it. A verifier that has not been shown to say no is a verifier whose greens
 * mean nothing, which is G33e's whole reason to exist.
 *
 * WHAT IT ENFORCES, and why the last one is on the list:
 *
 *   1. the signature math, against the key the JWKS publishes for that `keyid`
 *   2. `keyid` present, and resolvable in the directory
 *   3. `tag="web-bot-auth"`
 *   4. `created` not in the future, `expires` not in the past — THE CLOCK.
 *
 * Row 4 is the one an author does not think of. "Check the signature" is a
 * complete-sounding instruction that produces an instrument detecting forgery
 * and accepting every replay: a signature with a valid key and an hour-old
 * window is not tampered with in any way, and it is exactly what an attacker
 * who captured one holds. Staleness is not tampering, and nothing about the
 * cryptography reminds you to look at a clock.
 */

// ---------------------------------------------------------------------------
// A structured-fields reader, only as far as RFC 9421 needs one.
// ---------------------------------------------------------------------------

/** Read an sf-string starting at `i` (which must be the opening quote). */
function readString(s, i) {
  if (s[i] !== '"') throw new Error(`expected a quoted string at ${i}`);
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      const next = s[j + 1];
      if (next !== '\\' && next !== '"') throw new Error('bad escape in sf-string');
      out += next;
      j += 2;
      continue;
    }
    if (c === '"') return [out, j + 1];
    if (c < ' ' || c > '~') throw new Error('non-ASCII in sf-string');
    out += c;
    j += 1;
  }
  throw new Error('unterminated sf-string');
}

/** Read `;name=value` parameters starting at `i`. Returns [Map, next]. */
function readParams(s, i) {
  const out = new Map();
  let j = i;
  while (s[j] === ';') {
    j += 1;
    while (s[j] === ' ') j += 1;
    let name = '';
    while (j < s.length && /[a-z0-9_.*-]/.test(s[j])) {
      name += s[j];
      j += 1;
    }
    if (name === '') throw new Error(`empty parameter name at ${j}`);
    if (s[j] !== '=') {
      out.set(name, true);
      continue;
    }
    j += 1;
    if (s[j] === '"') {
      const [v, next] = readString(s, j);
      out.set(name, v);
      j = next;
      continue;
    }
    let num = '';
    while (j < s.length && /[0-9-]/.test(s[j])) {
      num += s[j];
      j += 1;
    }
    if (num === '') throw new Error(`unreadable parameter value for "${name}"`);
    out.set(name, Number(num));
  }
  return [out, j];
}

/**
 * Parse one `Signature-Input` dictionary member.
 *
 * Returns `{ label, components, params, paramsValue }`, where `paramsValue` is
 * the LITERAL text after the label's `=`. That literal is what goes into the
 * base's last line — reconstructing it from the parsed parameters would be a
 * second serializer, and a verifier that re-serializes what it just parsed is a
 * verifier that accepts only signers who serialize the way it does.
 */
export function parseSignatureInput(header) {
  const eq = header.indexOf('=');
  if (eq === -1) throw new Error('Signature-Input: no label');
  const label = header.slice(0, eq).trim();
  const rest = header.slice(eq + 1);
  if (rest[0] !== '(') throw new Error('Signature-Input: no inner list');

  const components = [];
  let i = 1;
  while (i < rest.length && rest[i] !== ')') {
    if (rest[i] === ' ') {
      i += 1;
      continue;
    }
    const [name, afterName] = readString(rest, i);
    const [params, afterParams] = readParams(rest, afterName);
    components.push({ name, key: params.get('key') });
    i = afterParams;
  }
  if (rest[i] !== ')') throw new Error('Signature-Input: unterminated inner list');
  const [params, end] = readParams(rest, i + 1);
  if (rest.slice(end).trim() !== '') throw new Error('Signature-Input: trailing junk');

  return { label, components, params, paramsValue: rest.trim() };
}

/** Parse one `Signature` dictionary member into raw bytes. */
export function parseSignature(header, label) {
  const m = /^([A-Za-z0-9_-]+)=:([A-Za-z0-9+/=]+):$/.exec(header.trim());
  if (!m) throw new Error('Signature: not a single byte-sequence member');
  if (m[1] !== label) throw new Error(`Signature label ${m[1]} does not match Signature-Input ${label}`);
  return Buffer.from(m[2], 'base64');
}

// ---------------------------------------------------------------------------
// Rebuilding the base (RFC 9421 §2.1, §2.2, §2.5).
// ---------------------------------------------------------------------------

/** The sf-dictionary member named `key`, re-serialized as it was written. */
function dictMember(value, key) {
  let depth = 0;
  let quoted = false;
  const parts = [];
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quoted) {
      if (c === '\\') i += 1;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    if (p.slice(0, eq).trim() === key) return p.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The signature base for a request, from the raw request line and headers.
 *
 * `req` is `{ method, target, headers }` — `target` being the request target
 * exactly as it appeared on the request line, and `headers` a plain object of
 * lowercased names. Deliberately NOT a URL object: the point of this instrument
 * is to read the bytes the server received, and building a URL first would
 * import a parser's opinions about them.
 */
export function rebuildBase(req, components, paramsValue) {
  const lines = [];
  for (const c of components) {
    const id = c.key === undefined ? `"${c.name}"` : `"${c.name}";key="${c.key}"`;
    lines.push(`${id}: ${valueOf(req, c)}`);
  }
  lines.push(`"@signature-params": ${paramsValue}`);
  return lines.join('\n');
}

function valueOf(req, c) {
  if (c.name.startsWith('@')) {
    switch (c.name) {
      case '@method':
        return req.method.toUpperCase();
      case '@authority': {
        // RFC 9421 §2.2.3: host lowercased, default port omitted. The scheme is
        // known from how the request arrived, not from the target, because an
        // origin-form request target carries no scheme at all.
        const host = (req.headers['host'] ?? '').trim().toLowerCase();
        const [name, port] = splitHostPort(host);
        const dflt = req.scheme === 'https' ? '443' : '80';
        return port === null || port === dflt ? name : `${name}:${port}`;
      }
      case '@path': {
        // §2.2.6: the absolute path, no query, no trailing '?', empty as '/',
        // percent-encoding preserved exactly as sent.
        const q = req.target.indexOf('?');
        const p = q === -1 ? req.target : req.target.slice(0, q);
        return p === '' ? '/' : p;
      }
      default:
        throw new Error(`unsupported derived component ${c.name}`);
    }
  }
  const raw = req.headers[c.name.toLowerCase()];
  if (raw === undefined) throw new Error(`covered header absent: ${c.name}`);
  const value = String(raw).replace(/\s+/g, ' ').trim();
  if (c.key === undefined) return value;
  const member = dictMember(value, c.key);
  if (member === null) throw new Error(`no member "${c.key}" in ${c.name}`);
  return member;
}

function splitHostPort(host) {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    const port = host.slice(close + 1).startsWith(':') ? host.slice(close + 2) : null;
    return [host.slice(0, close + 1), port];
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? [host, null] : [host.slice(0, colon), host.slice(colon + 1)];
}

// ---------------------------------------------------------------------------
// Keys.
// ---------------------------------------------------------------------------

/** base64url SHA-256 JWK thumbprint over the OKP required members (RFC 8037 A.3). */
export function thumbprintOf(jwk) {
  const canonical = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/** A `keyid` → public key map, from a published JWKS. */
export function directoryIndex(directory) {
  const out = new Map();
  for (const jwk of directory.keys ?? []) {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') continue;
    out.set(thumbprintOf(jwk), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------

/**
 * Verify one request. Returns `{ ok, reason, keyid, components, created, expires, nonce }`.
 *
 * `now` is injectable in SECONDS so the staleness leg can be exercised without
 * a sleep and without a clock the test cannot see.
 */
export function verifyRequest(req, keys, now = Math.floor(Date.now() / 1000)) {
  const si = req.headers['signature-input'];
  const sig = req.headers['signature'];
  if (!si || !sig) return { ok: false, reason: 'no signature headers' };

  let parsed;
  try {
    parsed = parseSignatureInput(si);
  } catch (err) {
    return { ok: false, reason: `unreadable Signature-Input: ${err.message}` };
  }

  const keyid = parsed.params.get('keyid');
  const created = parsed.params.get('created');
  const expires = parsed.params.get('expires');
  const tag = parsed.params.get('tag');
  const nonce = parsed.params.get('nonce');
  const details = {
    keyid,
    created,
    expires,
    nonce,
    tag,
    components: parsed.components.map((c) => (c.key === undefined ? `"${c.name}"` : `"${c.name}";key="${c.key}"`)),
  };

  if (typeof keyid !== 'string') return { ok: false, reason: 'no keyid', ...details };
  if (tag !== 'web-bot-auth') return { ok: false, reason: `tag is ${JSON.stringify(tag)}`, ...details };
  if (typeof created !== 'number') return { ok: false, reason: 'no created', ...details };
  if (typeof expires !== 'number') return { ok: false, reason: 'no expires', ...details };

  // THE CLOCK. Not a formality and not tampering: a captured signature with a
  // real key replays perfectly against a verifier that skips this.
  if (created > now + 5) return { ok: false, reason: 'created in the future', ...details };
  if (expires < now) return { ok: false, reason: 'signature has expired', ...details };

  const key = keys.get(keyid);
  if (!key) return { ok: false, reason: `keyid ${keyid} is not in the directory`, ...details };

  let base;
  try {
    base = rebuildBase(req, parsed.components, parsed.paramsValue);
  } catch (err) {
    return { ok: false, reason: `cannot rebuild the base: ${err.message}`, ...details };
  }

  let signature;
  try {
    signature = parseSignature(sig, parsed.label);
  } catch (err) {
    return { ok: false, reason: `unreadable Signature: ${err.message}`, ...details };
  }

  const ok = edVerify(null, Buffer.from(base, 'ascii'), key, signature);
  return { ok, reason: ok ? 'verified' : 'signature does not verify', base, ...details };
}

// ---------------------------------------------------------------------------
// Acceptance: RFC 9421 B.2.6, verbatim.
// ---------------------------------------------------------------------------

/**
 * The RFC's own Ed25519 example — key B.1.4, signature B.2.6.
 *
 * Copied from the RFC text, not from any design document in this repo: a vector
 * transcribed from our own prose would prove that our prose and our code agree,
 * which is the thing an external vector exists to avoid proving.
 */
export const RFC9421_B26 = {
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' },
  privateJwk: {
    kty: 'OKP',
    crv: 'Ed25519',
    d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
    x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
  },
  base:
    '"date": Tue, 20 Apr 2021 02:07:55 GMT\n' +
    '"@method": POST\n' +
    '"@path": /foo\n' +
    '"@authority": example.com\n' +
    '"content-type": application/json\n' +
    '"content-length": 18\n' +
    '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" ' +
    '"content-length");created=1618884473;keyid="test-key-ed25519"',
  signature:
    'wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==',
  signatureInput:
    'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");' +
    'created=1618884473;keyid="test-key-ed25519"',
  /** The B.2 test-request, as the fields this verifier reads. */
  request: {
    method: 'POST',
    target: '/foo?param=Value&Pet=dog',
    scheme: 'http',
    headers: {
      host: 'example.com',
      date: 'Tue, 20 Apr 2021 02:07:55 GMT',
      'content-type': 'application/json',
      'content-digest':
        'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
      'content-length': '18',
    },
  },
};

/**
 * This instrument's own acceptance. Throws if it fails, so nothing that imports
 * it can proceed with a verifier of unknown value.
 *
 * B.2.6 has no `tag` and no `expires` — it is an RFC vector, not a Web Bot Auth
 * one — so the profile checks are exercised separately below rather than being
 * relaxed for it. What this leg establishes is the part that must be right
 * before any profile check matters: that this file rebuilds a base the RFC's
 * authors signed, byte for byte, and that one flipped byte breaks it.
 */
export function selfTest() {
  const b = RFC9421_B26;
  const parsed = parseSignatureInput(b.signatureInput);
  const rebuilt = rebuildBase(b.request, parsed.components, parsed.paramsValue);
  if (rebuilt !== b.base) {
    throw new Error(
      `bench verifier FAILED its own acceptance: rebuilt base differs from RFC 9421 B.2.6.\n` +
        `--- rebuilt ---\n${rebuilt}\n--- expected ---\n${b.base}`,
    );
  }

  const key = createPublicKey({ key: b.publicJwk, format: 'jwk' });
  const good = edVerify(null, Buffer.from(b.base, 'ascii'), key, Buffer.from(b.signature, 'base64'));
  if (!good) throw new Error('bench verifier FAILED its own acceptance: B.2.6 does not verify');

  // ...and it must say NO. Three mutations, because a verifier can fail to
  // reject in three independent ways: the bytes, the signature, and the
  // covered-component list that binds them together.
  const mutations = [
    ['one byte of the base', b.base.replace('/foo', '/bar'), b.signature],
    ['one byte of the signature', b.base, flipBase64(b.signature)],
    ['a dropped covered component', b.base.replace('"@path": /foo\n', ''), b.signature],
  ];
  for (const [what, base, sig] of mutations) {
    if (edVerify(null, Buffer.from(base, 'ascii'), key, Buffer.from(sig, 'base64'))) {
      throw new Error(`bench verifier FAILED its own acceptance: it accepted ${what} mutated`);
    }
  }
  return true;
}

function flipBase64(b64) {
  const buf = Buffer.from(b64, 'base64');
  buf[0] ^= 0x01;
  return buf.toString('base64');
}
