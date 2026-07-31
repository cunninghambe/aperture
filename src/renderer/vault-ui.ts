import type { VaultEntryPublic } from '@shared/types';
import type { VaultApi } from '../preload/vault.js';
import {
  OPEN_FIELDS,
  SENSITIVE_FIELDS,
  type Profile,
  type ProfileField,
} from '@vault/profile.js';

declare global {
  interface Window {
    vault: VaultApi;
  }
}

const api = window.vault;
const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const gate = $('gate');
const app = $('app');
const passInput = $<HTMLInputElement>('pass');
const pass2Input = $<HTMLInputElement>('pass2');
const gateErr = $('gate-err');

/** True on first run, when we are creating rather than unlocking. */
let creating = false;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

async function initGate(): Promise<void> {
  const { exists, state } = await api.status();
  if (state === 'unlocked') return showApp();

  creating = !exists;
  $('gate-title').textContent = creating ? 'Create your vault' : 'Unlock your vault';
  $('gate-sub').textContent = creating
    ? 'Choose a passphrase. Longer beats complicated.'
    : 'Your passphrase never leaves this window.';
  $<HTMLButtonElement>('gate-go').textContent = creating ? 'Create vault' : 'Unlock';
  pass2Input.hidden = !creating;
  passInput.focus();
}

$<HTMLFormElement>('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  gateErr.hidden = true;

  const pass = passInput.value;
  if (!pass) return;

  if (creating) {
    // A typo in a passphrase with no recovery path costs the whole vault, so
    // confirmation is not optional here.
    if (pass !== pass2Input.value) return fail('Passphrases do not match.');
    if (pass.length < 10) {
      return fail('Use at least 10 characters. A short phrase beats a short password.');
    }
    await api.create(pass);
    clearPassphraseInputs();
    return showApp();
  }

  const ok = await api.unlock(pass);
  clearPassphraseInputs();
  if (!ok) return fail('That passphrase did not open the vault.');
  showApp();
});

function fail(msg: string): void {
  gateErr.textContent = msg;
  gateErr.hidden = false;
}

/**
 * Drop the passphrase from the DOM as soon as it has been used.
 *
 * This does not truly erase it — the string is already an immutable, GC-managed
 * V8 value and cannot be zeroized from JavaScript. It does stop the value
 * sitting in a live input for the rest of the session, which is the part we
 * can actually control.
 */
function clearPassphraseInputs(): void {
  passInput.value = '';
  pass2Input.value = '';
}

async function showApp(): Promise<void> {
  gate.hidden = true;
  app.hidden = false;
  await Promise.all([
    renderLogins(), renderIdentity(), renderFiles(), renderNotion(), renderTelemetry(),
  ]);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

for (const btn of document.querySelectorAll<HTMLButtonElement>('#tabs [data-panel]')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('#tabs [data-panel]')) {
      b.classList.toggle('active', b === btn);
    }
    for (const p of ['logins', 'identity', 'files', 'notion']) {
      $(`panel-${p}`).hidden = p !== btn.dataset['panel'];
    }
  });
}

$('lock-btn').addEventListener('click', async () => {
  await api.lock();
  app.hidden = true;
  gate.hidden = false;
  await initGate();
});

// ---------------------------------------------------------------------------
// Logins
// ---------------------------------------------------------------------------

/** Live TOTP tickers, cleared whenever the list is rebuilt. */
const rowTimers: ReturnType<typeof setInterval>[] = [];

async function renderLogins(): Promise<void> {
  const list = $('logins-list');
  for (const t of rowTimers.splice(0)) clearInterval(t);
  const entries = await api.list();
  list.replaceChildren();
  $('logins-empty').hidden = entries.length > 0;

  for (const e of entries) list.appendChild(loginRow(e));
}

function loginRow(e: VaultEntryPublic): HTMLElement {
  const row = document.createElement('div');
  row.className = 'item';

  const main = document.createElement('div');
  main.className = 'item-main';

  const origin = document.createElement('div');
  origin.className = 'item-origin';
  origin.textContent = e.origin;

  const sub = document.createElement('div');
  sub.className = 'item-sub';
  sub.textContent = e.username || '(no username)';

  main.append(origin, sub);

  const show = document.createElement('button');
  show.textContent = 'Reveal';
  let revealed = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  show.addEventListener('click', async () => {
    if (revealed) return hide();

    const pw = await api.reveal(e.id);
    if (pw === null) return;
    sub.textContent = pw;
    sub.classList.add('revealed');
    show.textContent = 'Hide';
    revealed = true;
    // Auto-hide. A password left on screen is a password on the next
    // screenshot, over someone's shoulder, or in a screen share.
    hideTimer = setTimeout(hide, 15000);
  });

  function hide(): void {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    sub.textContent = e.username || '(no username)';
    sub.classList.remove('revealed');
    show.textContent = 'Reveal';
    revealed = false;
  }

  // Live 2FA code, refreshed each second with the time left in the window. A
  // code with two seconds on it will be rejected by the time it is typed, so
  // showing the countdown is the difference between "it worked" and "this app
  // is broken".
  if (e.hasTotp) {
    const otp = document.createElement('span');
    otp.className = 'otp';
    const tick = async (): Promise<void> => {
      const r = await api.totp(e.id);
      if (!r) return;
      otp.textContent = `${r.code.slice(0, 3)} ${r.code.slice(3)}`;
      otp.dataset['left'] = String(r.secondsRemaining);
      otp.classList.toggle('expiring', r.secondsRemaining <= 5);
      otp.title = `expires in ${r.secondsRemaining}s — click to copy`;
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    otp.addEventListener('click', () => {
      void navigator.clipboard.writeText((otp.textContent ?? '').replace(/\s/g, ''));
    });
    // The row is rebuilt on every render, so the interval must not outlive it.
    rowTimers.push(timer);
    row.appendChild(otp);
  }

  const edit = document.createElement('button');
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openLoginDialog(e));

  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    if (del.dataset['armed'] !== '1') {
      // Two-step rather than a confirm dialog: deleting the only copy of a
      // password is unrecoverable, and a reflexive Enter on a native confirm
      // is exactly how it happens.
      del.dataset['armed'] = '1';
      del.textContent = 'Really delete?';
      setTimeout(() => {
        del.dataset['armed'] = '0';
        del.textContent = 'Delete';
      }, 4000);
      return;
    }
    await api.remove(e.id);
    await renderLogins();
  });

  row.append(main, show, edit, del);
  return row;
}

// -- add / edit dialog ------------------------------------------------------

const dialog = $<HTMLDialogElement>('login-dialog');
let editingId: string | null = null;

function openLoginDialog(entry?: VaultEntryPublic): void {
  editingId = entry?.id ?? null;
  $('login-dialog-title').textContent = entry ? 'Edit login' : 'Add login';
  $<HTMLInputElement>('d-origin').value = entry?.origin ?? '';
  $<HTMLInputElement>('d-user').value = entry?.username ?? '';
  $<HTMLInputElement>('d-pass').value = '';
  $<HTMLInputElement>('d-pass').type = 'password';
  $('d-show').textContent = 'Show';
  // The stored seed is never sent back to the UI; the placeholder just says
  // whether one exists.
  const totpField = $<HTMLInputElement>('d-totp');
  totpField.value = '';
  totpField.placeholder = entry?.hasTotp
    ? '2FA is set — paste a new secret to replace it'
    : 'otpauth://… or base32 secret';
  dialog.showModal();
}

$('add-login').addEventListener('click', () => openLoginDialog());
$('d-cancel').addEventListener('click', () => {
  $<HTMLInputElement>('d-pass').value = '';
  dialog.close();
});

$('d-gen').addEventListener('click', async () => {
  const pw = await api.generate(20);
  const field = $<HTMLInputElement>('d-pass');
  field.value = pw;
  // Show what was generated: a password you cannot see is one you cannot
  // sanity-check before saving.
  field.type = 'text';
  $('d-show').textContent = 'Hide';
});

$('d-show').addEventListener('click', () => {
  const field = $<HTMLInputElement>('d-pass');
  const showing = field.type === 'text';
  field.type = showing ? 'password' : 'text';
  $('d-show').textContent = showing ? 'Show' : 'Hide';
});

$('d-save').addEventListener('click', async () => {
  const origin = $<HTMLInputElement>('d-origin').value.trim();
  const username = $<HTMLInputElement>('d-user').value.trim();
  const password = $<HTMLInputElement>('d-pass').value;
  if (!origin) return;

  const totpSecret = $<HTMLInputElement>('d-totp').value.trim();

  let targetId = editingId;
  if (editingId) {
    const patch: Record<string, string> = { origin, username };
    // An empty password field on edit means "leave it alone", not "erase it".
    if (password) patch['password'] = password;
    await api.update(editingId, patch);
  } else {
    targetId = await api.add({ origin, username, password });
  }

  if (totpSecret && targetId) {
    const ok = await api.setTotp(targetId, totpSecret);
    if (!ok) {
      // A seed that does not parse is a 2FA lockout discovered at the worst
      // possible moment, so say so now rather than saving it.
      alert('That 2FA secret could not be read. The rest was saved.');
    }
  }

  $<HTMLInputElement>('d-pass').value = '';
  $<HTMLInputElement>('d-totp').value = '';
  dialog.close();
  await renderLogins();
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const FIELD_LABELS: Partial<Record<ProfileField, string>> = {
  givenName: 'First name', familyName: 'Last name', fullName: 'Full name',
  email: 'Email', phone: 'Phone', addressLine1: 'Street address',
  addressLine2: 'Apt / suite', city: 'City', region: 'State / region',
  postalCode: 'Postcode', country: 'Country', organization: 'Company',
  jobTitle: 'Job title', website: 'Website', linkedin: 'LinkedIn',
  github: 'GitHub', dateOfBirth: 'Date of birth', nationalId: 'National ID',
  taxId: 'Tax ID', bankAccount: 'Bank account', salaryExpectation: 'Salary expectation',
};

let profile: Profile = { id: 'default', label: 'Default', values: {} };

async function renderIdentity(): Promise<void> {
  const loaded = await api.profileGet();
  if (loaded) profile = loaded;

  const grid = $('identity-form');
  grid.replaceChildren();

  const all = [...OPEN_FIELDS, ...SENSITIVE_FIELDS] as ProfileField[];
  for (const f of all) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const label = document.createElement('label');
    label.setAttribute('for', `f-${f}`);
    label.textContent = FIELD_LABELS[f] ?? f;
    if ((SENSITIVE_FIELDS as readonly string[]).includes(f)) {
      const pill = document.createElement('span');
      pill.className = 'pill sensitive';
      pill.textContent = 'sensitive';
      pill.style.marginLeft = '6px';
      label.appendChild(pill);
    }

    const input = document.createElement('input');
    input.id = `f-${f}`;
    input.value = profile.values[f] ?? '';
    input.addEventListener('input', () => {
      profile.values[f] = input.value;
    });

    wrap.append(label, input);
    grid.appendChild(wrap);
  }
}

$('save-profile').addEventListener('click', async () => {
  // Drop empties so the fill planner reports "no-value" rather than writing
  // blank strings into forms.
  for (const k of Object.keys(profile.values) as ProfileField[]) {
    if (!profile.values[k]) delete profile.values[k];
  }
  await api.profileSave(profile);
  const btn = $<HTMLButtonElement>('save-profile');
  btn.textContent = 'Saved';
  setTimeout(() => (btn.textContent = 'Save'), 1500);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function renderFiles(): Promise<void> {
  const list = $('files-list');
  const files = await api.attachments();
  list.replaceChildren();
  $('files-empty').hidden = files.length > 0;

  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'item';

    const main = document.createElement('div');
    main.className = 'item-main';
    const t = document.createElement('div');
    t.className = 'item-origin';
    t.textContent = f.label;
    const s = document.createElement('div');
    s.className = 'item-sub';
    s.textContent = `${f.filename} · ${f.sizeKb}KB`;
    main.append(t, s);

    const kind = document.createElement('span');
    kind.className = 'pill';
    kind.textContent = f.kind;

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await api.attachmentRemove(f.id);
      await renderFiles();
    });

    row.append(main, kind, del);
    list.appendChild(row);
  }
}

$('add-file').addEventListener('click', async () => {
  const label = prompt('Label for this file (e.g. "CV 2026")');
  if (label === null) return;
  const kind = prompt('Kind: cv, cover-letter, portfolio, certificate, other', 'cv');
  if (kind === null) return;
  await api.attachmentAdd(label, kind);
  await renderFiles();
});

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

async function renderNotion(): Promise<void> {
  const cfg = await api.notionGet();
  $('n-state').textContent = cfg.configured
    ? 'A secret is saved. Leave the field blank to keep it.'
    : 'Not configured — captures will be saved as PNGs.';
  $<HTMLInputElement>('n-inbox').value = cfg.inboxPageId;
}

$('notion-save').addEventListener('click', async () => {
  const tokenField = $<HTMLInputElement>('n-token');
  const ok = await api.notionSave(
    tokenField.value.trim(),
    $<HTMLInputElement>('n-inbox').value.trim(),
  );
  // Clear the field immediately: a secret sitting in a live input is a secret
  // in the next screenshot of this window.
  tokenField.value = '';
  const btn = $<HTMLButtonElement>('notion-save');
  btn.textContent = ok ? 'Saved' : 'Need a secret';
  setTimeout(() => (btn.textContent = 'Save'), 1600);
  await renderNotion();
});

$('notion-test').addEventListener('click', async () => {
  const out = $('n-test-result');
  out.textContent = 'testing…';
  const r = await api.notionTest();
  out.textContent = r.detail;
  out.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
});

// ---------------------------------------------------------------------------
// Crash reporting
// ---------------------------------------------------------------------------

async function renderTelemetry(): Promise<void> {
  const t = await api.telemetryGet();
  $<HTMLInputElement>('t-enabled').checked = t.enabled;
  $<HTMLInputElement>('t-dsn').value = t.dsn;
  $('t-stats').textContent = t.enabled
    ? `${t.sent} sent, ${t.dropped} dropped this session`
    : 'disabled';
}

$('telemetry-save').addEventListener('click', async () => {
  await api.telemetrySave(
    $<HTMLInputElement>('t-enabled').checked,
    $<HTMLInputElement>('t-dsn').value.trim(),
  );
  const btn = $<HTMLButtonElement>('telemetry-save');
  btn.textContent = 'Saved';
  setTimeout(() => (btn.textContent = 'Save'), 1500);
  await renderTelemetry();
});

// External links open in the user's real browser, not inside the vault window,
// which must never navigate anywhere.
for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-ext]')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    void api.openExternal(a.dataset['ext'] ?? '');
  });
}

void initGate();
