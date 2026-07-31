import { describe, expect, it, vi } from 'vitest';
import {
  hashOrigin,
  payloadIsSafe,
  scrubEvent,
  scrubString,
  scrubUrls,
} from '../src/telemetry/scrub.js';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
const { makeBeforeSend, originatesInVault } = await import('../src/telemetry/reporter.js');

const OPTS = { salt: 'test-salt', homeDir: 'C:\\Users\\brad' };

describe('scrubString', () => {
  it('redacts bearer tokens', () => {
    const out = scrubString('failed with Authorization: Bearer PBed9_6BOIlkm8aGRZR2rwtzl');
    expect(out).not.toContain('PBed9_6BOIlkm8aGRZR2rwtzl');
    expect(out).toContain('[redacted]');
  });

  it('redacts Notion integration secrets', () => {
    const out = scrubString('token ntn_1234567890abcdefghijklmnopqrstuvwxyz failed');
    expect(out).not.toContain('ntn_1234567890abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts password-shaped key/value pairs', () => {
    expect(scrubString('{"password":"hunter2"}')).not.toContain('hunter2');
    expect(scrubString('passphrase=correct-horse')).not.toContain('correct-horse');
  });

  it('redacts email addresses', () => {
    expect(scrubString('user brad@example.com not found')).not.toContain('brad@example.com');
  });

  it('leaves ordinary diagnostics alone', () => {
    const msg = 'TypeError: cannot read property length of undefined';
    expect(scrubString(msg)).toBe(msg);
  });
});

describe('hashOrigin', () => {
  it('is stable for the same origin', () => {
    expect(hashOrigin('https://github.com/a', 's')).toBe(hashOrigin('https://github.com/b', 's'));
  });

  it('differs across origins, so crashes still cluster', () => {
    expect(hashOrigin('https://a.com', 's')).not.toBe(hashOrigin('https://b.com', 's'));
  });

  it('differs across installs, so hashes cannot be compared between users', () => {
    expect(hashOrigin('https://a.com', 's1')).not.toBe(hashOrigin('https://a.com', 's2'));
  });

  it('never contains the original host', () => {
    expect(hashOrigin('https://verysecretbank.com', 's')).not.toContain('verysecretbank');
  });
});

describe('scrubUrls', () => {
  it('replaces URLs with hashed origins', () => {
    const out = scrubUrls('failed loading https://mybank.com/account/12345', 's', '');
    expect(out).not.toContain('mybank.com');
    expect(out).not.toContain('12345');
    expect(out).toContain('site:');
  });

  it('strips the home directory, which usually contains a real name', () => {
    const out = scrubUrls('at C:\\Users\\brad\\dev\\aperture\\main.js:12', 's', 'C:\\Users\\brad');
    expect(out).not.toContain('brad');
    expect(out).toContain('~');
    // The useful part of the path survives.
    expect(out).toContain('aperture');
  });
});

describe('scrubEvent', () => {
  const base = {
    sdk: { name: 'uh-oh', version: '1' },
    timestamp: '2026-07-31T00:00:00Z',
    platform: 'node',
    release: { version: '0.1.0', build: '1' },
    level: 'error',
    device: { os: 'win32' },
    exception: {
      type: 'TypeError',
      value: 'failed on https://mybank.com/statement',
      stacktrace: {
        frames: [
          { function: 'load', filename: 'C:\\Users\\brad\\dev\\aperture\\tabs.ts', lineno: 40, inApp: true },
        ],
      },
    },
    breadcrumbs: [],
  };

  it('hashes URLs in the exception message', () => {
    const out = scrubEvent(base, OPTS)!;
    const ex = out['exception'] as { value: string };
    expect(ex.value).not.toContain('mybank.com');
    expect(ex.value).toContain('site:');
  });

  it('keeps the stack useful while removing the username', () => {
    const out = scrubEvent(base, OPTS)!;
    const frames = (out['exception'] as { stacktrace: { frames: { filename: string; lineno: number }[] } })
      .stacktrace.frames;
    expect(frames[0]!.filename).not.toContain('brad');
    expect(frames[0]!.filename).toContain('tabs.ts');
    expect(frames[0]!.lineno).toBe(40);
  });

  it('drops user identity entirely', () => {
    const out = scrubEvent({ ...base, user: { id: 'u1', email: 'a@b.com' } }, OPTS)!;
    expect(out['user']).toBeUndefined();
  });

  it('drops unknown top-level fields rather than passing them through', () => {
    // This is the allowlist doing its job: a field the SDK adds in a future
    // version must not travel just because nobody thought to deny it.
    const out = scrubEvent({ ...base, somethingNew: 'browsing history!' }, OPTS)!;
    expect(out['somethingNew']).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('browsing history');
  });

  it('drops unknown context keys but keeps the safe ones', () => {
    const out = scrubEvent(
      { ...base, context: { electron: '43.2.0', currentUrl: 'https://secret.com' } },
      OPTS,
    )!;
    const ctx = out['context'] as Record<string, unknown>;
    expect(ctx['electron']).toBe('43.2.0');
    expect(ctx['currentUrl']).toBeUndefined();
  });

  it('drops breadcrumb data bags wholesale', () => {
    const out = scrubEvent(
      {
        ...base,
        breadcrumbs: [
          { level: 'info', category: 'nav', message: 'went to https://x.com',
            data: { formValue: 'my-password' } },
        ],
      },
      OPTS,
    )!;
    const crumbs = out['breadcrumbs'] as Record<string, unknown>[];
    expect(crumbs[0]!['data']).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('my-password');
    expect(JSON.stringify(out)).not.toContain('x.com');
  });
});

describe('payloadIsSafe', () => {
  it('catches a bearer token that survived the structural pass', () => {
    expect(payloadIsSafe('{"m":"Bearer abcdefghijklmnopqrstuvwxyz123"}')).toBe(false);
  });
  it('catches a private key', () => {
    expect(payloadIsSafe('-----BEGIN RSA PRIVATE KEY-----')).toBe(false);
  });
  it('passes an ordinary payload', () => {
    expect(payloadIsSafe('{"exception":{"type":"TypeError"}}')).toBe(true);
  });
});

describe('originatesInVault', () => {
  it('catches events tagged as the vault surface', () => {
    expect(originatesInVault({ tags: { surface: 'vault' } })).toBe(true);
  });

  it('catches events whose stack passes through vault code', () => {
    expect(
      originatesInVault({
        exception: { stacktrace: { frames: [{ filename: '/app/src/vault/vault.ts' }] } },
      }),
    ).toBe(true);
  });

  it('allows ordinary browser errors through', () => {
    expect(
      originatesInVault({
        exception: { stacktrace: { frames: [{ filename: '/app/src/main/tabs.ts' }] } },
      }),
    ).toBe(false);
  });
});

describe('beforeSend hook', () => {
  const beforeSend = makeBeforeSend({ salt: 'salt', homeDir: 'C:\\Users\\brad' });

  it('drops anything from the vault', () => {
    expect(beforeSend({ tags: { surface: 'vault' }, exception: { type: 'E' } })).toBeNull();
  });

  it('fails closed on malformed input', () => {
    // The SDK sends the event unmodified if beforeSend throws, which for a
    // scrubber is exactly backwards — so it must never throw.
    expect(beforeSend(null)).toBeNull();
    expect(beforeSend('not an object')).toBeNull();
    expect(() => beforeSend(undefined)).not.toThrow();
  });

  it('fails closed rather than emitting a payload that still holds a secret', () => {
    const evt = {
      sdk: { name: 'x', version: '1' },
      exception: { type: 'E', value: 'ok', stacktrace: { frames: [] } },
      // A shape the structural pass does not rewrite, to prove the final gate
      // is doing independent work.
      tags: { note: '-----BEGIN RSA PRIVATE KEY-----' },
    };
    expect(beforeSend(evt)).toBeNull();
  });

  it('lets a clean crash through', () => {
    const out = beforeSend({
      sdk: { name: 'uh-oh', version: '1' },
      timestamp: 't',
      platform: 'node',
      release: { version: '0.1.0', build: '1' },
      level: 'error',
      device: { os: 'win32' },
      exception: {
        type: 'TypeError',
        value: 'cannot read length of undefined',
        stacktrace: { frames: [{ function: 'f', filename: 'src/main/tabs.ts', lineno: 1, inApp: true }] },
      },
      breadcrumbs: [],
    });
    expect(out).not.toBeNull();
    expect((out as { exception: { type: string } }).exception.type).toBe('TypeError');
  });
});
