import { createHmac } from 'node:crypto';

/**
 * TOTP (RFC 6238).
 *
 * Worth being clear about what this is, because the name "Google
 * Authenticator" misleads people: TOTP is a fully offline open standard with
 * no registration, no accounts, and no network calls. Google Authenticator is
 * just one client for it, and Aperture is another. A secret is shared once —
 * usually as a QR code — and after that both sides independently compute
 * HMAC(secret, current 30-second window). Nothing phones home.
 *
 * This implements the storing-and-generating side: codes for the *other* sites
 * you log into. Whether TOTP should also gate the vault itself is a different
 * and much weaker proposition — see the note in docs/design/security.md.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;

/** RFC 4648 base32, which is how every authenticator app transports secrets. */
export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * The current code, plus how long it remains valid.
 *
 * Returning the remaining seconds matters for usability: a code with two
 * seconds left will be rejected by the time it is typed, and showing that is
 * the difference between "it worked" and "this app is broken".
 */
export function totp(
  secretBase32: string,
  atMs: number,
  opts: { digits?: number; step?: number; algorithm?: string } = {},
): { code: string; secondsRemaining: number } {
  const step = opts.step ?? STEP_SECONDS;
  const digits = opts.digits ?? DIGITS;
  const key = base32Decode(secretBase32);

  const counter = Math.floor(atMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac(opts.algorithm ?? 'sha1', key).update(buf).digest();

  // Dynamic truncation, per RFC 4226 §5.4.
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const code = String(binary % 10 ** digits).padStart(digits, '0');
  const secondsRemaining = step - Math.floor((atMs / 1000) % step);
  return { code, secondsRemaining };
}

/**
 * Pull the secret out of an `otpauth://` URI, which is what a QR code encodes.
 *
 * Accepts a bare base32 secret too, since sites often print one next to the QR
 * code and that is what people paste.
 */
export function parseOtpauth(input: string): {
  secret: string;
  issuer?: string;
  account?: string;
  digits?: number;
  step?: number;
  algorithm?: string;
} | null {
  const trimmed = input.trim();

  if (!/^otpauth:\/\//i.test(trimmed)) {
    const bare = trimmed.replace(/[\s-]/g, '');
    if (/^[A-Z2-7]{16,}=*$/i.test(bare)) return { secret: bare };
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const secret = url.searchParams.get('secret');
  if (!secret) return null;

  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const [labelIssuer, account] = label.includes(':')
    ? label.split(':', 2)
    : [undefined, label];

  const digits = Number(url.searchParams.get('digits'));
  const step = Number(url.searchParams.get('period'));
  const alg = url.searchParams.get('algorithm');

  return {
    secret,
    issuer: url.searchParams.get('issuer') ?? labelIssuer,
    account,
    digits: Number.isFinite(digits) && digits > 0 ? digits : undefined,
    step: Number.isFinite(step) && step > 0 ? step : undefined,
    algorithm: alg ? alg.toLowerCase().replace('sha', 'sha') : undefined,
  };
}
