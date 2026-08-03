import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import sodium from 'libsodium-wrappers-sumo';
import type { FillDenyCode, VaultEntryPublic, VaultState } from '@shared/types';
import { parse } from 'tldts';
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

/** How many seconds a one-time code must have left to be worth inserting. */
const TOTP_FRESHNESS_FLOOR_S = 5;

export class Vault {
  private key: Uint8Array | null = null;
  private records: VaultRecord[] = [];
  private lockTimer: NodeJS.Timeout | null = null;
  private ready = false;
  /**
   * Dev-seeded, in-memory only. `persist()` short-circuits, so `seedForDev`
   * can never touch a human's vault file even if the guard above it is
   * bypassed — two independent reasons for the same safety.
   */
  private inMemory = false;
  /**
   * Which TOTP counter window each entry has already had a code inserted for.
   *
   * Most verifiers burn a code on first use. Without this, an agent calling
   * `apply` twice inside one 30-second window inserts the same digits, the
   * server rejects them, the agent concludes the code was wrong and tries
   * again — a loop that ends in a lockout. Process-local, cleared on lock,
   * never persisted: a restart is not a replay risk worth writing
   * plaintext-adjacent state to disk for.
   */
  private lastIssued = new Map<string, number>();
  /**
   * Things that must happen when the vault locks, however it locked.
   *
   * The reason this is a registry rather than a direct call: `revokeAllGrants`
   * lives in `main/consent.ts` and needle clearing lives in
   * `core/snapshot/engine.ts`, and importing either from here would create an
   * import cycle. `main/index.ts` registers them, which is also the one place
   * that can see both. Before this, `revokeAllGrants` had NO callers at all
   * while its own doc comment said it was "called when the vault locks" —
   * docs/design/vaultfill.md F1.
   */
  private lockHooks: (() => void)[] = [];
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
    this.lastIssued.clear();
    this.inMemory = false;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    // Every path into a lock comes through here, including the idle timer
    // below, which is exactly why the hooks hang off this function and not off
    // the explicit callers.
    for (const fn of this.lockHooks) {
      try {
        fn();
      } catch {
        // A misbehaving hook must not leave the vault half-locked. The key is
        // already zeroed above; the rest is best-effort cleanup.
      }
    }
  }

  /**
   * Register something to run whenever the vault locks.
   *
   * Idempotence is the caller's problem; `main/index.ts` registers once at
   * startup.
   */
  onLock(fn: () => void): void {
    this.lockHooks.push(fn);
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
    // A dev-seeded vault has no file and must never acquire one.
    if (this.inMemory) return;
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
   * Everything about an entry a fill decision needs, and nothing secret.
   *
   * SPLIT FROM `resolveForFill`, WHICH THIS REPLACES, FOR TWO REASONS.
   *
   * First, it ran BEFORE the fill and stamped `lastUsed` anyway, so a refused,
   * failed, or human-declined fill marked the record as used (F3) — and it
   * never called `persist()`, so the stamp was lost at lock regardless (F2).
   * Resolving is not using. `noteUsed` below is the use.
   *
   * Second, the checks and the secrets are wanted at different moments. This
   * runs at pipeline step 4, BEFORE any page work at all, so a wrong-origin
   * request never even reads the DOM: the page cannot influence the decision
   * because the decision is taken before the page is consulted.
   *
   * Deliberately NOT exported to MCP or IPC. Its result carries no password,
   * but the discipline is the point — this class's surface toward anything the
   * agent can reach is `listPublic` and nothing else.
   */
  resolveEntryFor(
    entryId: string,
    committedOrigin: string,
  ):
    | {
        ok: true;
        id: string;
        username: string;
        hasTotp: boolean;
        /**
         * The entry's TOTP step in seconds, when it has a seed.
         *
         * Clock arithmetic, not secret material — it is in the otpauth URI a
         * site prints beside its QR code. It exists so the consent dialog can
         * say how long a code will be good for WITHOUT generating one, which is
         * what lets code generation stay at step 10 where it belongs.
         */
        totpStep?: number;
        /** The record's own site. NEVER put this on the wire — section 10. */
        rpId: string;
        /** The page's registrable domain, which the human may name. */
        pageRpId: string;
        /** True when the match came from a human-approved alias. */
        viaAlias: boolean;
      }
    | { ok: false; error: VaultDenyCode } {
    if (!this.key) return { ok: false, error: 'VAULT_LOCKED' };

    const rec = this.records.find((r) => r.id === entryId);
    if (!rec) return { ok: false, error: 'NO_MATCH' };

    const rp = registrableDomain(committedOrigin);
    if (!rp) return { ok: false, error: 'ORIGIN_MISMATCH' };

    // Origin mismatch is terminal. There is no force flag and no override,
    // because the agent is exactly the component we have assumed is
    // manipulable — giving it a way to say "do it anyway" would reduce the
    // whole design to the agent's judgement under adversarial input.
    if (rec.rpId !== rp && !rec.aliases.includes(rp)) {
      return { ok: false, error: 'ORIGIN_MISMATCH' };
    }

    if (!committedOrigin.startsWith('https://') && !isLocalhost(committedOrigin)) {
      return { ok: false, error: 'INSECURE_TRANSPORT' };
    }

    const step = rec.totpSecret ? (parseOtpauth(rec.totpSecret)?.step ?? 30) : undefined;
    return {
      ok: true,
      id: rec.id,
      username: rec.username,
      hasTotp: Boolean(rec.totpSecret),
      ...(step === undefined ? {} : { totpStep: step }),
      rpId: rec.rpId,
      pageRpId: rp,
      viaAlias: rec.rpId !== rp,
    };
  }

  /**
   * The secrets, resolved at the last possible moment.
   *
   * Called at pipeline step 10 — after the human has approved, immediately
   * before the write. Never at plan time and never at consent time: a one-time
   * code generated before a human reads a dialog can be several seconds into
   * its window by the time it lands.
   *
   * Re-runs the full origin check rather than trusting the caller's earlier
   * one. The caller does hold a `resolveEntryFor` result, but a secret handed
   * out on the strength of a check made somewhere else is exactly the shape of
   * bug this design exists to make impossible.
   *
   * Not registered on any MCP tool, not on any `vaultui:` channel, not
   * reachable from the page preload. The seed never moves: `totpCode()` stays
   * the human-only path and this returns only the derived code.
   */
  async secretsForFill(
    entryId: string,
    committedOrigin: string,
    want: { username: boolean; password: boolean; otp: boolean },
  ): Promise<
    | {
        ok: true;
        username?: string;
        password?: string;
        otp?: { code: string; secondsRemaining: number; waitedMs: number };
      }
    | { ok: false; error: VaultDenyCode | 'TOTP_UNAVAILABLE' }
    | { ok: false; error: 'TOTP_ALREADY_ISSUED'; secondsUntilNext: number }
  > {
    const resolved = this.resolveEntryFor(entryId, committedOrigin);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const rec = this.records.find((r) => r.id === entryId);
    if (!rec) return { ok: false, error: 'NO_MATCH' };

    const out: {
      ok: true;
      username?: string;
      password?: string;
      otp?: { code: string; secondsRemaining: number; waitedMs: number };
    } = { ok: true };

    if (want.username) out.username = rec.username;
    if (want.password) out.password = rec.password;

    if (want.otp) {
      if (!rec.totpSecret) return { ok: false, error: 'TOTP_UNAVAILABLE' };
      const parsed = parseOtpauth(rec.totpSecret);
      if (!parsed) return { ok: false, error: 'TOTP_UNAVAILABLE' };
      const step = parsed.step ?? 30;

      let now = Date.now();
      let counter = Math.floor(now / 1000 / step);
      const already = this.lastIssued.get(entryId);
      if (already === counter) {
        const secondsUntilNext = step - Math.floor((now / 1000) % step);
        return { ok: false, error: 'TOTP_ALREADY_ISSUED', secondsUntilNext };
      }

      let code: { code: string; secondsRemaining: number };
      try {
        code = totp(parsed.secret, now, {
          digits: parsed.digits,
          step: parsed.step,
          algorithm: parsed.algorithm,
        });
      } catch {
        return { ok: false, error: 'TOTP_UNAVAILABLE' };
      }

      // THE FRESHNESS FLOOR. A code with two seconds left is rejected by the
      // server, and a rejected second factor costs an attempt against a lockout
      // counter — strictly worse than a one-second delay. The wait is bounded
      // by the floor itself: it can never exceed TOTP_FRESHNESS_FLOOR_S.
      let waitedMs = 0;
      if (code.secondsRemaining < TOTP_FRESHNESS_FLOOR_S) {
        waitedMs = code.secondsRemaining * 1000 + 250;
        await new Promise((r) => setTimeout(r, waitedMs));
        now = Date.now();
        counter = Math.floor(now / 1000 / step);
        if (this.lastIssued.get(entryId) === counter) {
          const secondsUntilNext = step - Math.floor((now / 1000) % step);
          return { ok: false, error: 'TOTP_ALREADY_ISSUED', secondsUntilNext };
        }
        try {
          code = totp(parsed.secret, now, {
            digits: parsed.digits,
            step: parsed.step,
            algorithm: parsed.algorithm,
          });
        } catch {
          return { ok: false, error: 'TOTP_UNAVAILABLE' };
        }
      }

      this.lastIssued.set(entryId, counter);
      out.otp = { ...code, waitedMs };
    }

    return out;
  }

  /**
   * Record that an entry was actually USED — after the write, not before it.
   *
   * Persisting, unlike its predecessor, and best-effort: a failed disk write
   * must not turn a successful fill into a failure the agent reports to the
   * human. The consequence of losing it is a stale "last used" date.
   */
  async noteUsed(entryId: string): Promise<void> {
    const rec = this.records.find((r) => r.id === entryId);
    if (!rec) return;
    rec.lastUsed = new Date().toISOString();
    try {
      await this.persist();
    } catch {
      // See above: metadata, not the fill.
    }
  }

  /**
   * A vault with known contents, for the live guards. Dev builds only.
   *
   * GATED TWICE, and neither gate is a comment. It throws unless the app is
   * unpackaged AND `--seed-vault` is on the main process's own command line —
   * which is not an MCP parameter, not an IPC channel, not an environment
   * variable, and not anything a page or an agent can set. It refuses outright
   * if a real vault file exists, so it can never stand in front of a human's
   * data, and `persist()` short-circuits so it can never create one.
   */
  async seedForDev(): Promise<void> {
    if (app.isPackaged) throw new Error('seedForDev is not available in a packaged build');
    if (!process.argv.includes('--seed-vault')) {
      throw new Error('seedForDev requires --seed-vault on the command line');
    }
    if (await this.exists()) {
      throw new Error('seedForDev refuses to run beside a real vault file');
    }

    await this.init();
    this.inMemory = true;
    this.key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    this.kdf = null;
    this.lastIssued.clear();
    this.records = [
      {
        id: sodium.to_hex(sodium.randombytes_buf(8)),
        rpId: '127.0.0.1',
        username: 'guard@example.com',
        password: 'guard-pw-93a1',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        aliases: [],
        createdAt: new Date().toISOString(),
        lastUsed: null,
      },
      {
        id: sodium.to_hex(sodium.randombytes_buf(8)),
        rpId: '127.0.0.2',
        username: 'transport@example.com',
        password: 'transport-pw-5c72',
        aliases: [],
        createdAt: new Date().toISOString(),
        lastUsed: null,
      },
    ];
    this.touch();
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
    // Falling back to the raw input here stored an rpId that no lookup could
    // ever produce — a human typing "www.github.com" got a permanently
    // invisible entry with no error. Refuse instead, so the UI can say so.
    const rp = resolveOriginForStorage(spec.origin);
    if (!rp) throw new Error(`not a usable site: ${spec.origin}`);

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
      const rp = resolveOriginForStorage(patch.origin);
      if (!rp) throw new Error(`not a usable site: ${patch.origin}`);
      rec.rpId = rp;
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

/**
 * The subset of `FillDenyCode` the vault itself can produce.
 *
 * `Extract` rather than a hand-written union: the wire-string table in
 * `src/mcp/tools.ts` is keyed on the full union, so a code spelled slightly
 * differently here would be a code with no string, and this makes that a
 * typecheck failure instead of a runtime `undefined`.
 */
export type VaultDenyCode = Extract<
  FillDenyCode,
  'VAULT_LOCKED' | 'NO_MATCH' | 'ORIGIN_MISMATCH' | 'INSECURE_TRANSPORT'
>;

/**
 * Registrable domain (eTLD+1) — the unit of origin identity for the vault.
 *
 * Backed by the Public Suffix List, bundled via `tldts` rather than fetched at
 * runtime. A live fetch is deliberately rejected: an attacker who controls your
 * suffix list controls your origin policy, and the vault's only real guarantee
 * is correct routing.
 *
 * **`allowPrivateDomains` is the load-bearing option.** Without it the PSL's
 * ICANN section alone is used, and every tenant of a shared host collapses into
 * one identity — `victim.github.io` and `attacker.github.io` both reduce to
 * `github.io`, so a credential saved for one is offered to the other. With it,
 * the private section is honoured and tenants stay separate.
 */
export function registrableDomain(origin: string): string | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  // Strip the root label; `github.com.` and `github.com` are the same host but
  // only the latter is in the PSL.
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return null;

  // Literal addresses have no registrable domain; they are their own identity.
  if (host === 'localhost') return host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  if (host.startsWith('[') || host.includes(':')) return host;

  const supplemented = applySupplementalSuffixes(host);
  if (supplemented !== undefined) return supplemented;

  const parsed = parse(host, { allowPrivateDomains: true });

  // The suffix must actually be in the PSL. tldts otherwise treats an
  // unrecognised final label as a valid one-label suffix, so
  // `a.b.notarealtld` would yield `b.notarealtld` — letting an unknown or
  // internal TLD establish an identity we cannot reason about.
  if (!parsed.isIcann && !parsed.isPrivate) return null;

  // Null here means the host IS a public suffix with no registrable part
  // (`github.io` itself). There is no site to bind a credential to, so fail
  // closed — a null means "no credential matches", which costs usability, not
  // security.
  return parsed.domain ?? null;
}

/**
 * Resolve what the human typed in the vault UI into a storable rpId.
 *
 * People type `github.com`, `www.github.com` and `https://github.com/login`
 * interchangeably. All three should land on the same entry, so this tolerates
 * a missing scheme rather than making the human know the difference.
 */
export function resolveOriginForStorage(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  return registrableDomain(withScheme);
}

/**
 * Multi-tenant hosts the PSL does not cover.
 *
 * The PSL's private section is opt-in — a vendor has to submit their own
 * suffix — so several large multi-tenant platforms are absent. Atlassian is the
 * clearest example: `acme.atlassian.net` and `evil.atlassian.net` are different
 * customers, anyone can provision the latter for free, and the PSL does not
 * separate them.
 *
 * Entries here are a supplement to the PSL, never a replacement. Each one means
 * "treat one more label as part of the suffix".
 */
const SUPPLEMENTAL_SUFFIXES = new Set([
  'atlassian.net',
  'jira.com',
  'zendesk.com',
  'freshdesk.com',
  'statuspage.io',
  'service-now.com',
  'my.salesforce.com',
  'lightning.force.com',
  'sharepoint.com',
  'onmicrosoft.com',
  'workday.com',
  'zohosites.com',
  'discourse.group',
  'sslip.io',
  'nip.io',
]);

/**
 * Returns the registrable domain if a supplemental suffix applies, `null` if
 * the host IS a bare supplemental suffix (no registrable part, so nothing to
 * bind a credential to), or `undefined` if none applies and the PSL should
 * decide.
 */
function applySupplementalSuffixes(host: string): string | null | undefined {
  const parts = host.split('.');
  // Longest match first, so `my.salesforce.com` beats `salesforce.com`.
  for (let take = Math.min(4, parts.length); take >= 2; take--) {
    const suffix = parts.slice(-take).join('.');
    if (!SUPPLEMENTAL_SUFFIXES.has(suffix)) continue;
    // Matches tldts: a bare public suffix has no registrable domain.
    if (parts.length === take) return null;
    return parts.slice(-(take + 1)).join('.');
  }
  return undefined;
}

function isLocalhost(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

export const vault = new Vault();
