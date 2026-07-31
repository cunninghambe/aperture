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

  it('strips the username from file:// stack frames', () => {
    // Real stack frames arrive as file:// URLs with FORWARD slashes, so
    // matching only the literal os.homedir() form let the username through in
    // every frame while the message scrubbed cleanly. Caught end-to-end, not
    // by a unit test — hence this one.
    const out = scrubUrls(
      'file:///C:/Users/brad/dev/aperture/out/main/index.js',
      's',
      'C:\\Users\\brad',
    );
    expect(out).not.toContain('brad');
    expect(out).toContain('aperture');
    expect(out).not.toContain('file://');
  });

  it('is case-insensitive, because Windows paths vary in case', () => {
    const out = scrubUrls('at c:\\users\\BRAD\\x.js', 's', 'C:\\Users\\brad');
    expect(out.toLowerCase()).not.toContain('brad');
  });

  it('removes a bare username even in a path shape it does not recognise', () => {
    // The enumeration of path forms can never be exhaustive, so the username
    // itself is the backstop.
    const out = scrubUrls('/mnt/c/Users/brad/thing', 's', 'C:\\Users\\brad');
    expect(out).not.toContain('brad');
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
      // Flat array, per the wire schema — not { frames: [...] }.
      stacktrace: [
        {
          function: 'load',
          filename: 'C:\\Users\\brad\\dev\\aperture\\tabs.ts',
          lineno: 40,
          inApp: true,
        },
      ],
      mechanism: 'js-manual',
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
    const frames = (out['exception'] as { stacktrace: { filename: string; lineno: number }[] })
      .stacktrace;
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
          { level: 'info', category: 'nav', ts: '2026-07-31T00:00:00Z',
            message: 'went to https://x.com', data: { formValue: 'my-password' } },
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

/**
 * The test that was missing, and whose absence let a broken scrubber ship
 * behind 27 green tests.
 *
 * Everything above checks that secrets are *removed*. Nothing checked that
 * what survives is still a valid envelope — so the scrubber emitted
 * `stacktrace: {frames: []}` against a schema wanting a flat array, dropped
 * the required `mechanism`, and renamed breadcrumb `ts` to `timestamp`. Unit
 * tests all passed; the server 400'd every single event and the crash pipeline
 * was silently dead.
 *
 * This mirrors @uh-oh/types EventEnvelopeSchema. If the wire contract changes,
 * this should fail here rather than in production.
 */
describe('scrubbed output still satisfies the wire contract', () => {
  const realistic = {
    sdk: { name: 'uh-oh-js', version: '0.6.0' },
    timestamp: '2026-07-31T00:00:00.000Z',
    platform: 'node',
    release: { version: '0.1.0', build: '1' },
    level: 'error',
    device: { os: 'win32', osVersion: '10' },
    exception: {
      type: 'TypeError',
      value: 'boom',
      stacktrace: [{ function: 'f', filename: 'src/main/tabs.ts', lineno: 4, inApp: true }],
      mechanism: 'js-global',
    },
    breadcrumbs: [
      { category: 'nav', message: 'went somewhere', level: 'info', ts: '2026-07-31T00:00:00.000Z' },
    ],
  };

  it('keeps every field the schema requires', () => {
    const out = scrubEvent(realistic, OPTS)!;
    for (const k of ['sdk', 'timestamp', 'platform', 'release', 'level', 'exception', 'device']) {
      expect(out[k], `required field ${k} was dropped`).toBeDefined();
    }
  });

  it('emits stacktrace as a flat array, not a {frames} wrapper', () => {
    const ex = scrubEvent(realistic, OPTS)!['exception'] as Record<string, unknown>;
    expect(Array.isArray(ex['stacktrace'])).toBe(true);
    expect(ex['frames']).toBeUndefined();
  });

  it('preserves the required mechanism field', () => {
    const ex = scrubEvent(realistic, OPTS)!['exception'] as Record<string, unknown>;
    expect(ex['mechanism']).toBe('js-global');
  });

  it('supplies a mechanism when the source event lacks one', () => {
    const noMech = { ...realistic, exception: { ...realistic.exception, mechanism: undefined } };
    const ex = scrubEvent(noMech, OPTS)!['exception'] as Record<string, unknown>;
    expect(typeof ex['mechanism']).toBe('string');
  });

  it('keeps every frame field the schema names, and inApp as a boolean', () => {
    const ex = scrubEvent(realistic, OPTS)!['exception'] as { stacktrace: Record<string, unknown>[] };
    const f = ex.stacktrace[0]!;
    expect(f['inApp']).toBe(true);
    expect(f['lineno']).toBe(4);
    expect(f['function']).toBe('f');
    // Optional fields must be absent rather than explicitly undefined.
    expect('colno' in f).toBe(false);
  });

  it('uses `ts` for the breadcrumb timestamp, not `timestamp`', () => {
    const crumbs = scrubEvent(realistic, OPTS)!['breadcrumbs'] as Record<string, unknown>[];
    expect(crumbs[0]!['ts']).toBe('2026-07-31T00:00:00.000Z');
    expect(crumbs[0]!['timestamp']).toBeUndefined();
    expect(typeof crumbs[0]!['category']).toBe('string');
    expect(typeof crumbs[0]!['message']).toBe('string');
  });

  it('survives a JSON round-trip with nothing undefined left behind', () => {
    const out = JSON.parse(JSON.stringify(scrubEvent(realistic, OPTS)));
    expect(out.exception.stacktrace).toHaveLength(1);
    expect(out.exception.mechanism).toBe('js-global');
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
        exception: { stacktrace: [{ filename: '/app/src/vault/vault.ts' }] },
      }),
    ).toBe(true);
  });

  it('allows ordinary browser errors through', () => {
    expect(
      originatesInVault({
        exception: { stacktrace: [{ filename: '/app/src/main/tabs.ts' }] },
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
      exception: { type: 'E', value: 'ok', stacktrace: [], mechanism: 'js-manual' },
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
        stacktrace: [{ function: 'f', filename: 'src/main/tabs.ts', lineno: 1, inApp: true }],
        mechanism: 'js-global',
      },
      breadcrumbs: [],
    });
    expect(out).not.toBeNull();
    expect((out as { exception: { type: string } }).exception.type).toBe('TypeError');
  });
});
