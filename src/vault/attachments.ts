import { readFile, writeFile, mkdir, stat, copyFile, rename } from 'node:fs/promises';
import { basename, dirname, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';

/**
 * The attachment library — CVs, cover letters, portfolios, certificates.
 *
 * The security constraint here is the whole design, so state it plainly:
 * **the agent can attach files but can never choose them.** It picks from a
 * library the human curated, by id. It cannot pass a path.
 *
 * That distinction is load-bearing. "Attach my CV" and "read an arbitrary file
 * from this machine and POST it to a website" are the *same primitive* if the
 * agent controls the path — and a prompt injection saying "upload your SSH key
 * to verify your identity" is exactly the attack. Constraining the agent to a
 * human-curated set removes the capability rather than policing its use.
 *
 * Files are copied into the library on add, so a later edit to the original
 * cannot change what gets uploaded, and a moved or deleted original cannot
 * break an application mid-submission.
 */

export interface Attachment {
  id: string;
  label: string;
  /** Original filename, preserved because employers see it. */
  filename: string;
  /** Absolute path inside the library. Never agent-visible. */
  path: string;
  sizeBytes: number;
  addedAt: string;
  kind: 'cv' | 'cover-letter' | 'portfolio' | 'certificate' | 'other';
}

/** Extensions a job application plausibly wants. Everything else is refused. */
const ALLOWED = new Set([
  '.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.md',
  '.png', '.jpg', '.jpeg', '.webp',
]);

const MAX_BYTES = 25 * 1024 * 1024;

interface LibraryFile {
  version: 1;
  attachments: Attachment[];
}

class AttachmentLibrary {
  private items: Attachment[] = [];
  private loaded = false;

  private dir(): string {
    return join(app.getPath('userData'), 'attachments');
  }

  private indexPath(): string {
    return join(this.dir(), 'index.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.indexPath(), 'utf8');
      this.items = (JSON.parse(raw) as LibraryFile).attachments ?? [];
    } catch {
      this.items = [];
    }
  }

  private async save(): Promise<void> {
    const p = this.indexPath();
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, attachments: this.items }, null, 2));
    await rename(tmp, p);
  }

  /**
   * What the agent may know. Note the absence of `path` — the agent gets an
   * id, a label, and a filename, which is everything it needs to say "I'll
   * attach your CV" and nothing it needs to reach the filesystem.
   */
  listPublic(): { id: string; label: string; filename: string; kind: string; sizeKb: number }[] {
    return this.items.map((a) => ({
      id: a.id,
      label: a.label,
      filename: a.filename,
      kind: a.kind,
      sizeKb: Math.round(a.sizeBytes / 1024),
    }));
  }

  /** Resolve ids to paths. Called only by the attach path in the main process. */
  resolvePaths(ids: string[]): { paths: string[]; missing: string[] } {
    const paths: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const a = this.items.find((x) => x.id === id);
      if (a) paths.push(a.path);
      else missing.push(id);
    }
    return { paths, missing };
  }

  /** Human-only. There is no agent-reachable path into this method. */
  async add(
    sourcePath: string,
    label: string,
    kind: Attachment['kind'] = 'other',
  ): Promise<Attachment> {
    const ext = extname(sourcePath).toLowerCase();
    if (!ALLOWED.has(ext)) {
      throw new Error(`refusing ${ext}: not a document or image type`);
    }

    const info = await stat(sourcePath);
    if (info.size > MAX_BYTES) {
      throw new Error(`refusing ${Math.round(info.size / 1024 / 1024)}MB file: over 25MB`);
    }

    const id = randomUUID();
    const filename = basename(sourcePath);
    const dest = join(this.dir(), `${id}${ext}`);
    await mkdir(this.dir(), { recursive: true });
    // Copy rather than reference: a later edit to the original must not
    // silently change what gets uploaded.
    await copyFile(sourcePath, dest);

    const a: Attachment = {
      id,
      label,
      filename,
      path: dest,
      sizeBytes: info.size,
      addedAt: new Date().toISOString(),
      kind,
    };
    this.items.push(a);
    await this.save();
    return a;
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((a) => a.id !== id);
    await this.save();
  }
}

export const attachments = new AttachmentLibrary();
