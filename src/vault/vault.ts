import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import sodium from 'libsodium-wrappers-sumo';
import type { VaultEntryPublic, VaultState } from '@shared/types';
import { parseOtpauth, totp } from './totp.js';

/**
 * The agent-blind vault.
 *
 * The security property is structural, not procedural: there is no code path
 * that returns a plaintext credential to a caller. Not a discouraged one, not
 * one behind a flag — none. `VaultEntryPublic` is the only shape that crosses
 * the boundary toward the agent, and it has no field that can carry a secret.
 *
 * Two properties do the real work:
 *
 *   1. No getter. `fill()` performs the insertion itself and returns which
 *      fields it touched. A `getPassword()` that exists can be called, and
 *      anything the agent can call, a hostile page can talk it into calling.
 *
 *   2. Unnameability. `listPublic(origin)` returns only entries matching the
 *      frame's committed origin. On evil.com the agent is never told a
 *      google.com entry exists, so a prompt injection has no identifier to
 *      weaponize. Removing the vocabulary beats blocking the action.
 *
 * See docs/design/security.md for the full threat model.
 */

const MAGIC = 'APVLT\x01\x00\x00';

interface VaultRecord {
  id: string;
  /** Registrable domain (eTLD+1), ASCII/punycode. */
  rpId: string;
  username: string;
  password: string;
  totpSecret?: string;
  /** Extra origins the *human* has approved. Never agent-writable. */
  aliases: string[];
  createdAt: string;
  lastUsed: string | null;
}

interface VaultFile {
  version: 1;
  kdf: { alg: 'argon2id'; opslimit: number; memlimit: number; salt: string };
  nonce: string;
  ciphertext: string;
}

export class Vault {
  private key: Uint8Array | null = null;
  private records: VaultRecord[] = [];
  private lockTimer: NodeJS.Timeout | null = null;
  private ready = false;
  /**
   * KDF parameters for the open vault, kept so callers never have to pass
   * them. Making a caller supply crypto parameters on every write is how you
   * end up with one code path quietly using weaker ones.
   */
  private kdf: { salt: Uint8Array; opslimit: number; memlimit: number } | null = null;

  /**
   * Idle auto-lock. Agent activity deliberately does NOT count as activity —
   * an always-on agent would otherwise hold the vault open forever, which is
   * the easiest way to accidentally void the whole design.
   */
  private idleMs = 5 * 60 * 1000;

  private path(): string {
    return join(app.getPath('userData'), 'vault.aperture');
  }

  private async init(): Promise<void> {
    if (!this.ready) {
      await sodium.ready;
      this.ready = true;
    }
  }

  state(): VaultState {
    if (this.key) return 'unlocked';
    return 'locked';
  }

  async unlock(passphrase: string): Promise<boolean> {
    await this.init();
    let raw: Buffer;
    try {
      raw = await readFile(this.path());
    } catch {
      return false;
    }

    const file = JSON.parse(raw.toString('utf8')) as VaultFile;
    if (!raw.toString('utf8').length || file.version !== 1) return false;

    const salt = sodium.from_base64(file.kdf.salt);
    const key = sodium.crypto_pwhash(
      sodium.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      file.kdf.opslimit,
      file.kdf.memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );

    try {
      const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        sodium.from_base64(file.ciphertext),
        MAGIC,
        sodium.from_base64(file.nonce),
        key,
      );
      this.records = JSON.parse(new TextDecoder().decode(plain));
      this.key = key;
      this.kdf = {
        salt,
        opslimit: file.kdf.opslimit,
        memlimit: file.kdf.memlimit,
      };
      this.touch();
      return true;
    } catch {
      // Wrong passphrase, or a tampered file. Indistinguishable by design.
      sodium.memzero(key);
      return false;
    }
  }

  lock(): void {
    if (this.key) sodium.memzero(this.key);
    this.key = null;
    this.kdf = null;
    this.records = [];
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
  }

  /** Whether a vault file exists yet, so the UI knows to offer create vs unlock. */
  async exists(): Promise<boolean> {
    try {
      await readFile(this.path());
      return true;
    } catch {
      return false;
    }
  }

  /** Restart the idle countdown. Called on *human* interaction only. */
  touch(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), this.idleMs);
  }

  async create(passphrase: string): Promise<void> {
    await this.init();
    const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
    // Interactive desktop unlock happens rarely, so we spend far more than the
    // OWASP floor: memory-hardness is what makes offline guessing expensive.
    const opslimit = sodium.crypto_pwhash_OPSLIMIT_MODERATE;
    const memlimit = sodium.crypto_pwhash_MEMLIMIT_MODERATE;
    this.key = sodium.crypto_pwhash(
      sodium.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      opslimit,
      memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    this.records = [];
    this.kdf = { salt, opslimit, memlimit };
    this.touch();
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.key || !this.kdf) throw new Error('vault is locked');
    const { salt, opslimit, memlimit } = this.kdf;
    const nonce = sodium.randombytes_buf(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    );
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new TextEncoder().encode(JSON.stringify(this.records)),
      MAGIC,
      null,
      nonce,
      this.key,
    );

    const file: VaultFile = {
      version: 1,
      kdf: { alg: 'argon2id', opslimit, memlimit, salt: sodium.to_base64(salt) },
      nonce: sodium.to_base64(nonce),
      ciphertext: sodium.to_base64(ct),
    };

    const p = this.path();
    await mkdir(dirname(p), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a truncated vault.
    const tmp = `${p}.tmp`;
    await writeFile(tmp, JSON.stringify(file), 'utf8');
    await rename(tmp, p);
  }

  // -------------------------------------------------------------------------
  // The agent-facing surface. Everything below returns metadata only.
  // -------------------------------------------------------------------------

  /**
   * Entries for an origin.
   *
   * Passing no origin returns nothing rather than everything — the absence of
   * a list-all is deliberate, and defaulting to "all" would reintroduce it.
   */
  listPublic(origin?: string): VaultEntryPublic[] {
    if (!this.key) return [];
    if (!origin) return [];

    const rp = registrableDomain(origin);
    if (!rp) return [];

    return this.records
      .filter((r) => r.rpId === rp || r.aliases.includes(rp))
      .map((r) => ({
        id: r.id,
        origin: r.rpId,
        username: r.username,
        hasTotp: Boolean(r.totpSecret),
        lastUsed: r.lastUsed,
      }));
  }

  /**
   * Resolve an entry for filling.
   *
   * Deliberately NOT exported and NOT reachable from IPC or MCP. The only
   * caller is the fill path in the main process, which hands the value
   * straight to the renderer without returning it upward.
   */
  resolveForFill(
    entryId: string,
    committedOrigin: string,
  ): { username: string; password: string } | { error: FillDenyCode } {
    if (!this.key) return { error: 'VAULT_LOCKED' };

    const rec = this.records.find((r) => r.id === entryId);
    if (!rec) return { error: 'NO_MATCH' };

    const rp = registrableDomain(committedOrigin);
    if (!rp) return { error: 'ORIGIN_MISMATCH' };

    // Origin mismatch is terminal. There is no force flag and no override,
    // because the agent is exactly the component we have assumed is
    // manipulable — giving it a way to say "do it anyway" would reduce the
    // whole design to the agent's judgement under adversarial input.
    if (rec.rpId !== rp && !rec.aliases.includes(rp)) {
      return { error: 'ORIGIN_MISMATCH' };
    }

    if (!committedOrigin.startsWith('https://') && !isLocalhost(committedOrigin)) {
      return { error: 'INSECURE_TRANSPORT' };
    }

    rec.lastUsed = new Date().toISOString();
    return { username: rec.username, password: rec.password };
  }

  // -------------------------------------------------------------------------
  // Human-only operations.
  //
  // Everything below is reachable ONLY from the vault window's own IPC
  // channel. None of it is registered as an MCP tool, and none of it is
  // exposed on the page preload. That separation is the enforcement: a
  // capability the agent cannot name is one a hostile page cannot talk it into
  // using.
  // -------------------------------------------------------------------------

  /**
   * The current TOTP code for an entry.
   *
   * Human-only, same as reveal. The *code* is short-lived and low-value on its
   * own, but the seed it derives from is a permanent second factor — so the
   * seed never leaves this class, and only the derived code is returned.
   */
  totpCode(id: string): { code: string; secondsRemaining: number } | null {
    if (!this.key) return null;
    const rec = this.records.find((r) => r.id === id);
    if (!rec?.totpSecret) return null;
    try {
      const parsed = parseOtpauth(rec.totpSecret);
      if (!parsed) return null;
      return totp(parsed.secret, Date.now(), {
        digits: parsed.digits,
        step: parsed.step,
        algorithm: parsed.algorithm,
      });
    } catch {
      return null;
    }
  }

  async setTotp(id: string, secretOrUri: string): Promise<boolean> {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;
    if (!secretOrUri) {
      delete rec.totpSecret;
    } else {
      // Validate before storing: a seed that does not parse is a 2FA lockout
      // discovered at the worst possible moment.
      if (!parseOtpauth(secretOrUri)) return false;
      rec.totpSecret = secretOrUri;
    }
    await this.persist();
    return true;
  }

  async addRecord(spec: {
    origin: string;
    username: string;
    password: string;
    totpSecret?: string;
  }): Promise<string> {
    const rp = registrableDomain(spec.origin) ?? spec.origin;
    const id = sodium.to_hex(sodium.randombytes_buf(8));
    this.records.push({
      id,
      rpId: rp,
      username: spec.username,
      password: spec.password,
      totpSecret: spec.totpSecret,
      aliases: [],
      createdAt: new Date().toISOString(),
      lastUsed: null,
    });
    await this.persist();
    return id;
  }

  async updateRecord(
    id: string,
    patch: { username?: string; password?: string; origin?: string },
  ): Promise<boolean> {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;
    if (patch.username !== undefined) rec.username = patch.username;
    if (patch.password !== undefined) rec.password = patch.password;
    if (patch.origin !== undefined) {
      rec.rpId = registrableDomain(patch.origin) ?? patch.origin;
    }
    await this.persist();
    return true;
  }

  async deleteRecord(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    await this.persist();
    return true;
  }

  /** Every entry, for the vault window's list. Metadata only. */
  listAllPublic(): VaultEntryPublic[] {
    if (!this.key) return [];
    return this.records.map((r) => ({
      id: r.id,
      origin: r.rpId,
      username: r.username,
      hasTotp: Boolean(r.totpSecret),
      lastUsed: r.lastUsed,
    }));
  }

  /**
   * Reveal a password to the human, on screen, on explicit request.
   *
   * This is the one function that returns plaintext, and it exists because a
   * password manager you cannot read from is not usable — sometimes you have
   * to type a password into a phone or a terminal.
   *
   * It is safe *only* because of where it can be called from: the vault
   * window's IPC channel, which the agent has no handle to and cannot address.
   * If this were ever exposed through the MCP surface or the page preload, the
   * entire agent-blind property would be void. It must never grow a caller
   * outside the vault window.
   */
  revealForHuman(id: string): string | null {
    if (!this.key) return null;
    return this.records.find((r) => r.id === id)?.password ?? null;
  }

  /**
   * Generate a password.
   *
   * Rejection sampling via libsodium rather than `Math.random()` or a modulo
   * over `randomBytes`, both of which bias the distribution.
   */
  generatePassword(length = 20, opts: { symbols?: boolean } = {}): string {
    const alphabet =
      'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' +
      (opts.symbols === false ? '' : '!@#$%^&*-_=+?');
    let out = '';
    for (let i = 0; i < length; i++) {
      out += alphabet[sodium.randombytes_uniform(alphabet.length)];
    }
    return out;
  }
}

export type FillDenyCode =
  | 'VAULT_LOCKED'
  | 'NO_MATCH'
  | 'ORIGIN_MISMATCH'
  | 'INSECURE_TRANSPORT'
  | 'NODE_NOT_FILLABLE'
  | 'USER_DENIED';

/**
 * Registrable domain (eTLD+1).
 *
 * This is a deliberately conservative placeholder: it uses a bundled short
 * list of multi-part suffixes rather than the full Public Suffix List. A live
 * PSL fetch is explicitly rejected — an attacker who controls your suffix list
 * controls your origin policy. Ship a versioned PSL snapshot before relying on
 * this for anything beyond development.
 */
export function registrableDomain(origin: string): string | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;

  if (host.endsWith('.')) host = host.slice(0, -1);
  const parts = host.split('.');
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join('.');

  // Suffixes under which anyone can register a name. Treating these as a
  // registrable domain would put every tenant in one trust domain: a
  // credential saved for acme.atlassian.net would be offered to — and filled
  // on — evil.atlassian.net, which an attacker can provision for free. Same for
  // github.io, vercel.app, myshopify.com and friends.
  if (MULTI_TENANT_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');

  const lastThree = parts.slice(-3).join('.');
  if (MULTI_TENANT_SUFFIXES.has(lastThree)) return parts.slice(-4).join('.');

  if (CCTLD_SECOND_LEVEL.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * ccTLD second-level suffixes, e.g. `co.uk`.
 *
 * This is a bundled subset, not the full Public Suffix List. A live PSL fetch
 * is deliberately rejected — an attacker who controls your suffix list controls
 * your origin policy — but this list must grow into a versioned PSL snapshot
 * before the vault fill path is wired for real. Tracked in
 * docs/design/security.md.
 */
const CCTLD_SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.za', 'org.za', 'net.za', 'gov.za',
  'com.mx', 'org.mx', 'gob.mx',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.sg', 'com.hk', 'com.tw', 'co.kr', 'co.il', 'com.ar', 'com.co',
  'co.th', 'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.ua', 'com.pl',
  'co.id', 'com.eg', 'com.sa', 'com.ng', 'com.es', 'com.pe',
]);

/**
 * Suffixes where subdomains belong to mutually untrusted parties.
 *
 * The private section of the PSL. Missing one of these is a credential-theft
 * bug, not a cosmetic one, because it silently merges tenants.
 */
const MULTI_TENANT_SUFFIXES = new Set([
  // Code hosting / pages
  'github.io', 'gitlab.io', 'bitbucket.io', 'pages.dev', 'netlify.app',
  'vercel.app', 'now.sh', 'surge.sh', 'neocities.org', 'js.org',
  'github.dev', 'gitpod.io', 'glitch.me', 'repl.co', 'replit.dev',
  'codesandbox.io', 'stackblitz.io',
  // PaaS
  'herokuapp.com', 'herokudns.com', 'appspot.com', 'cloudfunctions.net',
  'run.app', 'web.app', 'firebaseapp.com', 'azurewebsites.net',
  'cloudapp.net', 'trafficmanager.net', 'elasticbeanstalk.com',
  'amazonaws.com', 's3.amazonaws.com', 'cloudfront.net', 'fly.dev',
  'render.com', 'onrender.com', 'railway.app', 'deta.dev', 'workers.dev',
  // SaaS tenants
  'atlassian.net', 'jira.com', 'zendesk.com', 'freshdesk.com',
  'myshopify.com', 'shopifypreview.com', 'squarespace.com', 'wixsite.com',
  'webflow.io', 'bigcartel.com', 'notion.site', 'zohosites.com',
  'salesforce.com', 'force.com', 'lightning.force.com', 'my.salesforce.com',
  'sharepoint.com', 'onmicrosoft.com', 'service-now.com', 'workday.com',
  'statuspage.io', 'discourse.group', 'slack.com',
  // Blogging / user content
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'medium.com',
  'substack.com', 'ghost.io', 'blogger.com', 'livejournal.com',
  // Dynamic DNS / tunnels
  'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'loca.lt',
  'serveo.net', 'localtunnel.me', 'duckdns.org', 'no-ip.com', 'dyndns.org',
  'sslip.io', 'nip.io', 'localhost.run',
  // Misc user content
  'firebaseio.com', 'appspot.com', 'translate.goog', 'cdn.ampproject.org',
]);

function isLocalhost(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

export const vault = new Vault();
