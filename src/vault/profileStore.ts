import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { Profile, ProfileField } from './profile.js';
import { isSensitive } from './profile.js';

/**
 * Persistence for identity profiles.
 *
 * Encrypted with Electron's `safeStorage`, which on Windows is DPAPI at user
 * scope. Be clear about what that buys: the file is useless on another machine
 * or to another user account, which covers a stolen laptop or a synced backup.
 * It does NOT protect against another process running as this same user.
 *
 * That is an acceptable trade for contact details, which the agent is allowed
 * to see anyway. It is emphatically NOT acceptable for passwords, which is why
 * those live in the Argon2id vault behind a passphrase the machine does not
 * hold. Different data, different threat, different protection.
 */

interface ProfileFile {
  version: 1;
  profiles: Profile[];
  defaultId: string | null;
}

class ProfileStore {
  private profiles: Profile[] = [];
  private defaultId: string | null = null;
  private loaded = false;

  private path(): string {
    return join(app.getPath('userData'), 'profiles.dat');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.path());
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8');
      const file = JSON.parse(json) as ProfileFile;
      this.profiles = file.profiles ?? [];
      this.defaultId = file.defaultId ?? null;
    } catch {
      // No profile yet is the normal first-run state, not an error.
      this.profiles = [];
      this.defaultId = null;
    }
  }

  private async save(): Promise<void> {
    const file: ProfileFile = {
      version: 1,
      profiles: this.profiles,
      defaultId: this.defaultId,
    };
    const json = JSON.stringify(file);
    const buf = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf8');

    const p = this.path();
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    await writeFile(tmp, buf, { mode: 0o600 });
    await rename(tmp, p);
  }

  list(): { id: string; label: string; fields: string[] }[] {
    return this.profiles.map((p) => ({
      id: p.id,
      label: p.label,
      // Field *names* only. Sensitive values are never enumerated here, and
      // this method is the one the agent-facing tool calls.
      fields: Object.keys(p.values).filter((k) => p.values[k as ProfileField]),
    }));
  }

  get(id?: string): Profile | null {
    if (id) return this.profiles.find((p) => p.id === id) ?? null;
    if (this.defaultId) {
      return this.profiles.find((p) => p.id === this.defaultId) ?? null;
    }
    return this.profiles[0] ?? null;
  }

  /** Human-only path. Never exposed on the agent surface. */
  async upsert(profile: Profile, makeDefault = false): Promise<void> {
    const i = this.profiles.findIndex((p) => p.id === profile.id);
    if (i >= 0) this.profiles[i] = profile;
    else this.profiles.push(profile);
    if (makeDefault || !this.defaultId) this.defaultId = profile.id;
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.defaultId === id) this.defaultId = this.profiles[0]?.id ?? null;
    await this.save();
  }

  /**
   * Which sensitive fields this profile holds — names, never values. Lets the
   * agent say "your date of birth will be filled from your profile" without
   * ever learning what it is.
   */
  sensitiveFieldsPresent(id?: string): string[] {
    const p = this.get(id);
    if (!p) return [];
    return Object.keys(p.values).filter(
      (k) => isSensitive(k as ProfileField) && p.values[k as ProfileField],
    );
  }
}

export const profiles = new ProfileStore();
