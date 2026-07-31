import { describe, expect, it } from 'vitest';
import { base32Decode, parseOtpauth, totp } from '../src/vault/totp.js';

describe('base32Decode', () => {
  it('decodes the RFC 4648 test vector', () => {
    expect(base32Decode('MZXW6YTB').toString()).toBe('fooba');
  });

  it('tolerates padding, spaces and dashes, as printed next to QR codes', () => {
    expect(base32Decode('MZXW 6YTB').toString()).toBe('fooba');
    expect(base32Decode('MZXW-6YTB=').toString()).toBe('fooba');
  });

  it('rejects invalid characters rather than producing a wrong key', () => {
    expect(() => base32Decode('MZXW6YT1')).toThrow();
  });
});

describe('totp', () => {
  // RFC 6238 Appendix B test vectors. The published vectors use the ASCII
  // secret "12345678901234567890", which is this in base32.
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches the RFC 6238 vector at T=59', () => {
    expect(totp(SECRET, 59_000, { digits: 8 }).code).toBe('94287082');
  });

  it('matches the RFC 6238 vector at T=1111111109', () => {
    expect(totp(SECRET, 1_111_111_109_000, { digits: 8 }).code).toBe('07081804');
  });

  it('matches the RFC 6238 vector at T=1234567890', () => {
    expect(totp(SECRET, 1_234_567_890_000, { digits: 8 }).code).toBe('89005924');
  });

  it('produces six digits by default', () => {
    const { code } = totp(SECRET, 59_000);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('is stable within a 30-second window and changes across one', () => {
    const a = totp(SECRET, 60_000).code;
    const b = totp(SECRET, 89_000).code;
    const c = totp(SECRET, 90_000).code;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('reports the seconds left, so a nearly-dead code can be flagged', () => {
    expect(totp(SECRET, 60_000).secondsRemaining).toBe(30);
    expect(totp(SECRET, 85_000).secondsRemaining).toBe(5);
  });
});

describe('parseOtpauth', () => {
  it('extracts the secret and metadata from a QR-code URI', () => {
    const r = parseOtpauth(
      'otpauth://totp/GitHub:brad?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30',
    )!;
    expect(r.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(r.issuer).toBe('GitHub');
    expect(r.account).toBe('brad');
    expect(r.digits).toBe(6);
  });

  it('accepts a bare base32 secret, which is what people paste', () => {
    expect(parseOtpauth('JBSWY3DPEHPK3PXP')!.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(parseOtpauth('jbsw y3dp ehpk 3pxp')!.secret).toBe('jbswy3dpehpk3pxp');
  });

  it('rejects something that is neither', () => {
    expect(parseOtpauth('https://github.com')).toBeNull();
    expect(parseOtpauth('hello world')).toBeNull();
  });

  it('round-trips a parsed secret into a working code', () => {
    const parsed = parseOtpauth('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')!;
    expect(totp(parsed.secret, 59_000, { digits: 8 }).code).toBe('94287082');
  });
});
