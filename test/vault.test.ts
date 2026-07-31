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

    const ok = v.resolveForFill(id, 'https://github.com');
    expect('password' in ok && ok.password).toBe('p1');

    const bad = v.resolveForFill(id, 'https://evil.com');
    expect('error' in bad && bad.error).toBe('ORIGIN_MISMATCH');
  });

  it('is not fooled by a lookalike subdomain', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://google.com',
      username: 'g',
      password: 'p',
    });
    // google.com.evil.com registers under evil.com, not google.com.
    const bad = v.resolveForFill(id, 'https://google.com.evil.com');
    expect('error' in bad && bad.error).toBe('ORIGIN_MISMATCH');
  });

  it('matches a subdomain of the same registrable domain', async () => {
    const v = await freshVault();
    const id = await v.addRecord({
      origin: 'https://github.com',
      username: 'g',
      password: 'p',
    });
    const ok = v.resolveForFill(id, 'https://gist.github.com');
    expect('password' in ok).toBe(true);
  });

  it('refuses to fill over plain http', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    const r = v.resolveForFill(id, 'http://a.com');
    expect('error' in r && r.error).toBe('INSECURE_TRANSPORT');
  });

  it('refuses to fill while locked', async () => {
    const v = await freshVault();
    const id = await v.addRecord({ origin: 'https://a.com', username: 'u', password: 'p' });
    v.lock();
    const r = v.resolveForFill(id, 'https://a.com');
    expect('error' in r && r.error).toBe('VAULT_LOCKED');
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
