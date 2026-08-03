import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The vault reaches for Electron's `app.getPath('userData')`. Point it at a
 * scratch directory so these tests exercise the real crypto against a real
 * file rather than a mock of it — the file format and the AEAD binding are
 * exactly what needs testing here.
 */
const dir = mkdtempSync(join(tmpdir(), 'aperture-vault-'));
vi.mock('electron', () => ({
  app: { getPath: () => dir },
}));

const { Vault, registrableDomain } = await import('../src/vault/vault.js');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PASS = 'correct horse battery staple';

async function freshVault() {
  rmSync(join(dir, 'vault.aperture'), { force: true });
  const v = new Vault();
  await v.create(PASS);
  return v;
}

describe('vault lifecycle', () => {
  beforeEach(() => rmSync(join(dir, 'vault.aperture'), { force: true }));

  it('starts absent, then exists after create', async () => {
    const v = new Vault();
    expect(await v.exists()).toBe(false);
    await v.create(PASS);
    expect(await v.exists()).toBe(true);
    expect(v.state()).toBe('unlocked');
  });

  it('round-trips through lock and unlock', async () => {
    const v = await freshVault();
    await v.addRecord({
      origin: 'https://github.com',
      username: 'brad',
      password: 'hunter2',
    });

    v.lock();
    expect(v.state()).toBe('locked');
    // A locked vault must expose nothing at all, not merely refuse writes.
    expect(v.listAllPublic()).toEqual([]);

    const v2 = new Vault();
    expect(await v2.unlock(PASS)).toBe(true);
    expect(v2.listAllPublic()).toHaveLength(1);
    expect(v2.listAllPublic()[0]!.username).toBe('brad');
  });

  it('refuses the wrong passphrase', async () => {
    await freshVault();
    const v2 = new Vault();
    expect(await v2.unlock('not the passphrase')).toBe(false);
    expect(v2.state()).toBe('locked');
  });

  it('refuses a tampered file', async () => {
    const v = await freshVault();
    await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });

    const { readFileSync, writeFileSync } = await import('node:fs');
    const p = join(dir, 'vault.aperture');
    const file = JSON.parse(readFileSync(p, 'utf8'));
    // Flip a byte in the ciphertext. The AEAD tag must catch it.
    const ct = Buffer.from(file.ciphertext, 'base64');
    ct[10] = ct[10]! ^ 0xff;
    file.ciphertext = ct.toString('base64');
    writeFileSync(p, JSON.stringify(file));

    const v2 = new Vault();
    expect(await v2.unlock(PASS)).toBe(false);
  });
});

describe('records', () => {
  beforeEach(() => rmSync(join(dir, 'vault.aperture'), { force: true }));

  it('reveals only to the human-only path', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://github.com',
      username: 'brad',
      password: 'hunter2',
    });

    expect(v.revealForHuman(id)).toBe('hunter2');
    // The agent-facing listing must never carry the secret.
    expect(JSON.stringify(v.listAllPublic())).not.toContain('hunter2');
    expect(JSON.stringify(v.listPublic('https://github.com'))).not.toContain('hunter2');
  });

  it('will not reveal while locked', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    v.lock();
    expect(v.revealForHuman(id)).toBeNull();
  });

  it('updates without clobbering the password when none is given', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    await v.updateRecord(id, { username: 'u2' });
    expect(v.revealForHuman(id)).toBe('p');
    expect(v.listAllPublic()[0]!.username).toBe('u2');
  });

  it('deletes', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    expect(await v.deleteRecord(id)).toBe(true);
    expect(v.listAllPublic()).toHaveLength(0);
    expect(await v.deleteRecord(id)).toBe(false);
  });
});

describe('origin binding', () => {
  beforeEach(() => rmSync(join(dir, 'vault.aperture'), { force: true }));

  it('only lists entries for the matching origin', async () => {
    const v = await freshVault();
    await v.addRecord({ origin: 'https://github.com', username: 'g', password: 'p1' });
    await v.addRecord({ origin: 'https://gitlab.com', username: 'l', password: 'p2' });

    expect(v.listPublic('https://github.com')).toHaveLength(1);
    expect(v.listPublic('https://github.com')[0]!.username).toBe('g');
    // The whole anti-phishing story: on an unrelated origin the agent is not
    // told these entries exist, so injection has no identifier to weaponize.
    expect(v.listPublic('https://evil.com')).toHaveLength(0);
  });

  it('returns nothing rather than everything when no origin is given', async () => {
    const v = await freshVault();
    await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    expect(v.listPublic()).toHaveLength(0);
  });

  it('refuses a fill for a mismatched origin', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://github.com',
      username: 'g',
      password: 'p1',
    });

    const ok = v.resolveEntryFor(id, 'https://github.com');
    expect(ok.ok).toBe(true);
    const secrets = await v.secretsForFill(id, 'https://github.com', {
      username: true,
      password: true,
      otp: false,
    });
    expect(secrets.ok && secrets.password).toBe('p1');

    const bad = v.resolveEntryFor(id, 'https://evil.com');
    expect(!bad.ok && bad.error).toBe('ORIGIN_MISMATCH');
  });

  it('is not fooled by a lookalike subdomain', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://google.com',
      username: 'g',
      password: 'p',
    });
    // google.com.evil.com registers under evil.com, not google.com.
    const bad = v.resolveEntryFor(id, 'https://google.com.evil.com');
    expect(!bad.ok && bad.error).toBe('ORIGIN_MISMATCH');
  });

  it('matches a subdomain of the same registrable domain', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://github.com',
      username: 'g',
      password: 'p',
    });
    expect(v.resolveEntryFor(id, 'https://gist.github.com').ok).toBe(true);
  });

  it('refuses to fill over plain http', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    const r = v.resolveEntryFor(id, 'http://a.com');
    expect(!r.ok && r.error).toBe('INSECURE_TRANSPORT');
  });

  it('refuses to fill while locked', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    v.lock();
    const r = v.resolveEntryFor(id, 'https://a.com');
    expect(!r.ok && r.error).toBe('VAULT_LOCKED');
  });

  it('refuses the secrets too, not only the metadata, on a wrong origin', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    // `secretsForFill` re-runs the full check rather than trusting that the
    // caller already ran `resolveEntryFor`. A secret handed out on the strength
    // of a check made somewhere else is exactly the bug shape this design
    // exists to make impossible.
    const r = await v.secretsForFill(id, 'https://evil.com', {
      username: true,
      password: true,
      otp: false,
    });
    expect(!r.ok && r.error).toBe('ORIGIN_MISMATCH');
  });
});

describe('resolve is not use (F2, F3)', () => {
  beforeEach(() => rmSync(join(dir, 'vault.aperture'), { force: true }));

  it('resolveEntryFor does not stamp lastUsed', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    expect(v.listAllPublic()[0]!.lastUsed).toBeNull();

    // Resolving is a CHECK. A refused, failed or human-declined fill used to
    // stamp the record anyway, because the stamp happened here.
    v.resolveEntryFor(id, 'https://a.com');
    v.resolveEntryFor(id, 'https://evil.com');
    expect(v.listAllPublic()[0]!.lastUsed).toBeNull();
  });

  it('noteUsed stamps AND persists across lock/unlock', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    await v.noteUsed(id);
    const stamped = v.listAllPublic()[0]!.lastUsed;
    expect(stamped).not.toBeNull();

    // The old code mutated the field and never called persist(), so the
    // mutation was lost at lock and "last used" was permanently null on disk.
    v.lock();
    const v2 = new Vault();
    expect(await v2.unlock(PASS)).toBe(true);
    expect(v2.listAllPublic()[0]!.lastUsed).toBe(stamped);
  });
});

describe('TOTP delivery', () => {
  beforeEach(() => rmSync(join(dir, 'vault.aperture'), { force: true }));

  const SEED = 'JBSWY3DPEHPK3PXP';

  it('refuses a second code in the same counter window', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://a.com',
      username: 'u',
      password: 'p',
      totpSecret: SEED,
    });

    const first = await v.secretsForFill(id, 'https://a.com', {
      username: false, password: false, otp: true,
    });
    expect(first.ok).toBe(true);
    expect(first.ok && first.otp?.code).toMatch(/^\d{6}$/);

    // Most verifiers burn a code on first use. Re-inserting the same digits
    // gets them rejected, and the agent reads that as "wrong code" and retries
    // — a loop that ends in a lockout.
    const second = await v.secretsForFill(id, 'https://a.com', {
      username: false, password: false, otp: true,
    });
    expect(!second.ok && second.error).toBe('TOTP_ALREADY_ISSUED');
    expect(!second.ok && 'secondsUntilNext' in second && second.secondsUntilNext)
      .toBeGreaterThan(0);
  });

  it('waits past the step boundary when the code is nearly stale', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://a.com',
      username: 'u',
      password: 'p',
      totpSecret: SEED,
    });

    // Two seconds left. A code with two seconds left is rejected by the server,
    // and a rejected second factor costs an attempt against a lockout counter —
    // strictly worse than a one-second delay.
    const step = 30_000;
    const nearBoundary = Math.floor(Date.now() / step) * step + (step - 2000);
    vi.useFakeTimers({ shouldAdvanceTime: true, now: nearBoundary });
    try {
      const r = await v.secretsForFill(id, 'https://a.com', {
        username: false, password: false, otp: true,
      });
      expect(r.ok).toBe(true);
      expect(r.ok && r.otp!.waitedMs).toBeGreaterThan(0);
      expect(r.ok && r.otp!.secondsRemaining).toBeGreaterThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the replay record is cleared by a lock', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://a.com',
      username: 'u',
      password: 'p',
      totpSecret: SEED,
    });
    await v.secretsForFill(id, 'https://a.com', {
      username: false, password: false, otp: true,
    });
    v.lock();
    expect(await v.unlock(PASS)).toBe(true);
    const again = await v.secretsForFill(id, 'https://a.com', {
      username: false, password: false, otp: true,
    });
    expect(again.ok).toBe(true);
  });

  it('says so rather than guessing when there is no seed', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    const r = await v.secretsForFill(id, 'https://a.com', {
      username: false, password: false, otp: true,
    });
    expect(!r.ok && r.error).toBe('TOTP_UNAVAILABLE');
  });
});

describe('lock hooks (F1)', () => {
  beforeEach(() => rmSync(join(dir, 'vault.aperture'), { force: true }));

  it('fire on an explicit lock', async () => {
    const v = await freshVault();
    let fired = 0;
    v.onLock(() => { fired += 1; });
    v.lock();
    expect(fired).toBe(1);
  });

  it('fire on the IDLE auto-lock, which is the path that matters', async () => {
    const v = await freshVault();
    let fired = 0;
    v.onLock(() => { fired += 1; });

    // The hooks hang off `lock()` rather than off its callers precisely so the
    // idle timer counts. A human walks away, the vault times out, and a
    // ten-minute autofill grant used to outlive it.
    vi.useFakeTimers();
    try {
      v.touch();
      vi.advanceTimersByTime(5 * 60 * 1000 + 10);
    } finally {
      vi.useRealTimers();
    }
    expect(fired).toBe(1);
    expect(v.state()).toBe('locked');
  });

  it('a throwing hook does not leave the vault unlocked', async () => {
    const v = await freshVault();
    v.onLock(() => { throw new Error('hook blew up'); });
    let second = false;
    v.onLock(() => { second = true; });
    expect(() => v.lock()).not.toThrow();
    expect(v.state()).toBe('locked');
    expect(second).toBe(true);
  });
});

describe('registrableDomain', () => {
  it('reduces a host to eTLD+1', () => {
    expect(registrableDomain('https://gist.github.com')).toBe('github.com');
    expect(registrableDomain('https://example.com')).toBe('example.com');
  });

  it('handles multi-part suffixes', () => {
    expect(registrableDomain('https://shop.example.co.uk')).toBe('example.co.uk');
  });

  it('keeps localhost and IPs intact', () => {
    expect(registrableDomain('http://localhost:3000')).toBe('localhost');
    expect(registrableDomain('http://127.0.0.1:8080')).toBe('127.0.0.1');
  });
});

describe('password generation', () => {
  it('produces distinct passwords of the requested length', async () => {
    const v = await freshVault();
    const a = v.generatePassword(24);
    const b = v.generatePassword(24);
    expect(a).toHaveLength(24);
    expect(a).not.toBe(b);
  });

  it('omits characters that are ambiguous when read aloud or retyped', async () => {
    const v = await freshVault();
    const joined = Array.from({ length: 40 }, () => v.generatePassword(32)).join('');
    for (const ch of ['l', 'I', 'O', '0', '1']) {
      expect(joined).not.toContain(ch);
    }
  });
});
