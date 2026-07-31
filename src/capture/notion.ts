/**
 * Notion destination for captures.
 *
 * ⚠ The request shapes below are written against Notion's File Upload
 * reference, but I could not verify them end to end without a workspace token
 * — and two pages of Notion's own docs disagree on the field names
 * (`upload_url` vs `file_upload_url`, and the block's file type). So this path
 * is written to **fail loudly and fall back to disk** rather than to be
 * trusted. Validate against a real workspace before relying on it; the
 * fallback chain in capture.ts means a wrong guess here costs you a Notion
 * page, never the screenshot itself.
 */

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionConfig {
  token: string;
  /** Page captures land under when no Notion page is open. */
  inboxPageId?: string;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

/** Extract a page id from a Notion URL. Ids are 32 hex chars, dashed or not. */
export function pageIdFromUrl(url: string): string | null {
  if (!/^https?:\/\/(www\.)?notion\.(so|site)\//i.test(url)) return null;
  const m = /([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    url,
  );
  if (!m) return null;
  const raw = (m[0] ?? '').replace(/-/g, '');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** Upload bytes and return the file_upload id. */
async function uploadFile(
  cfg: NotionConfig,
  bytes: Buffer,
  filename: string,
): Promise<string> {
  const create = await fetch(`${API}/file_uploads`, {
    method: 'POST',
    headers: headers(cfg.token),
    body: JSON.stringify({ filename, content_type: 'image/png' }),
  });
  if (!create.ok) {
    throw new Error(`notion: create upload failed (${create.status})`);
  }

  const created = (await create.json()) as { id?: string; upload_url?: string };
  if (!created.id || !created.upload_url) {
    throw new Error('notion: upload response missing id or upload_url');
  }

  const form = new FormData();
  // Copy into a plain Uint8Array: a Node Buffer may be backed by a
  // SharedArrayBuffer, which Blob does not accept.
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    filename,
  );

  const send = await fetch(created.upload_url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Notion-Version': NOTION_VERSION,
    },
    body: form,
  });
  if (!send.ok) throw new Error(`notion: byte upload failed (${send.status})`);

  return created.id;
}

/** Append a captioned image block to a page. */
export async function appendCapture(
  cfg: NotionConfig,
  pageId: string,
  bytes: Buffer,
  caption: string,
  filename: string,
): Promise<void> {
  const fileUploadId = await uploadFile(cfg, bytes, filename);

  const res = await fetch(`${API}/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: headers(cfg.token),
    body: JSON.stringify({
      children: [
        {
          object: 'block',
          type: 'image',
          image: {
            type: 'file_upload',
            file_upload: { id: fileUploadId },
            caption: [{ type: 'text', text: { content: caption.slice(0, 2000) } }],
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`notion: append block failed (${res.status})`);
  }
}

/**
 * Find or create today's capture page under the inbox.
 *
 * One page per day rather than per capture, so a week of screenshots is seven
 * entries in the sidebar instead of ninety.
 */
export async function datedPage(cfg: NotionConfig, date: string): Promise<string> {
  if (!cfg.inboxPageId) throw new Error('notion: no inbox page configured');

  const existing = await fetch(`${API}/blocks/${cfg.inboxPageId}/children?page_size=100`, {
    headers: headers(cfg.token),
  });
  if (existing.ok) {
    const body = (await existing.json()) as {
      results?: { id: string; type: string; child_page?: { title: string } }[];
    };
    const hit = body.results?.find(
      (b) => b.type === 'child_page' && b.child_page?.title === date,
    );
    if (hit) return hit.id;
  }

  const create = await fetch(`${API}/pages`, {
    method: 'POST',
    headers: headers(cfg.token),
    body: JSON.stringify({
      parent: { page_id: cfg.inboxPageId },
      properties: { title: [{ type: 'text', text: { content: date } }] },
    }),
  });
  if (!create.ok) throw new Error(`notion: create page failed (${create.status})`);

  const page = (await create.json()) as { id: string };
  return page.id;
}
