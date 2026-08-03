import { describe, expect, it, vi } from 'vitest';
import { planCredentialFill, describeTargets } from '../src/vault/fillPlan.js';
import type { SnapshotNode } from '../src/core/snapshot/types.js';

/**
 * Every decision the fill path can make FROM DATA, made against data.
 *
 * `fillPlan.ts` is pure for exactly this reason: field selection is the half of
 * the routing decision that decides which box a password goes into, and a
 * security boundary that can only be exercised through a live Electron process
 * is a boundary nobody exercises. What is NOT here is everything that needs a
 * page — connectivity, obstruction, maskedness at write time, the deferred
 * landing check. Those are `bench/guards.mjs` G16-G28, measured end to end
 * against a fixture's own witness.
 */

// `tools.ts` pulls in the whole main-process graph. The mock is wide rather
// than deep: nothing below actually drives Electron, it only has to import.
vi.mock('electron', () => {
  class Stub {
    on(): void {}
    once(): void {}
  }
  return {
    app: { getPath: () => process.cwd(), isPackaged: false, on: () => {}, getVersion: () => '0' },
    ipcMain: { on: () => {}, handle: () => {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    shell: { openExternal: () => {} },
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: true, on: () => {} },
    net: { request: () => new Stub() },
    session: {
      fromPartition: () => ({
        setUserAgent: () => {},
        setPermissionRequestHandler: () => {},
        webRequest: { onBeforeSendHeaders: () => {} },
        protocol: { handle: () => {} },
      }),
    },
    BrowserWindow: Stub,
    BaseWindow: Stub,
    WebContentsView: Stub,
  };
});

const { DENY_STRINGS, denyString, VAULT_FILL_SCHEMA_KEYS } = await import(
  '../src/mcp/tools.js'
);

// ---------------------------------------------------------------------------
// Tree builders. The shapes are the walker's, minus everything the plan
// deliberately does not look at.
// ---------------------------------------------------------------------------

let n = 0;
function textbox(opts: {
  label?: string;
  inputType?: string;
  autocomplete?: string;
  value?: string;
  synthetic?: boolean;
  ref?: string | null;
}): SnapshotNode {
  n += 1;
  const node: SnapshotNode = {
    role: 'textbox',
    key: `N|0|textbox|f${n}`,
    states: 0,
    frameId: 0,
    rect: [0, 0, 200, 24],
    children: [],
  };
  if (opts.ref !== null) node.ref = opts.ref ?? `e${n}`;
  if (opts.label !== undefined) node.name = opts.label;
  if (opts.inputType !== undefined) node.inputType = opts.inputType;
  if (opts.autocomplete !== undefined) node.autocomplete = opts.autocomplete;
  if (opts.value !== undefined) node.value = opts.value;
  if (opts.synthetic) node.synthetic = true;
  return node;
}

function form(...children: SnapshotNode[]): SnapshotNode {
  return {
    role: 'form',
    key: 'root',
    states: 0,
    frameId: 0,
    rect: [0, 0, 400, 400],
    children,
  };
}

const PASSWORD = { label: 'Password', inputType: 'password' };
const USERNAME = { label: 'Email or username', inputType: 'text', autocomplete: 'username' };

describe('field selection — Aperture chooses, the agent never does', () => {
  it('1. selects the single type=password field', () => {
    const plan = planCredentialFill(form(textbox(USERNAME), textbox(PASSWORD)), {
      hasTotp: false,
    });
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.targets.map((t) => t.kind)).toEqual(['username', 'password']);
  });

  it('2. refuses two password fields, and names both candidates', () => {
    // A sign-up or change-password form. Filling a SAVED password into "new
    // password" is wrong in a way the human does not notice until later.
    const plan = planCredentialFill(
      form(
        textbox(USERNAME),
        textbox({ label: 'Password', inputType: 'password' }),
        textbox({ label: 'Confirm password', inputType: 'password' }),
      ),
      { hasTotp: false },
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.code).toBe('AMBIGUOUS_FIELDS');
    expect(!plan.ok && plan.candidates).toEqual(['Password', 'Confirm password']);
  });

  it('3. fills an OTP-only page when the entry has a seed', () => {
    const plan = planCredentialFill(
      form(textbox({ label: 'Enter your code', autocomplete: 'one-time-code', inputType: 'text' })),
      { hasTotp: true },
    );
    expect(plan.ok && plan.targets.map((t) => t.kind)).toEqual(['otp']);
  });

  it('4. refuses an OTP-only page when the entry has no seed', () => {
    const plan = planCredentialFill(
      form(textbox({ label: 'Enter your code', autocomplete: 'one-time-code', inputType: 'text' })),
      { hasTotp: false },
    );
    expect(!plan.ok && plan.code).toBe('OTP_NO_SEED');
  });

  it('5. refuses two OTP candidates (the one-box-per-digit shape)', () => {
    const plan = planCredentialFill(
      form(
        textbox({ label: 'Verification code', autocomplete: 'one-time-code', inputType: 'text' }),
        textbox({ label: 'Backup code', autocomplete: 'one-time-code', inputType: 'text' }),
      ),
      { hasTotp: true },
    );
    expect(!plan.ok && plan.code).toBe('AMBIGUOUS_FIELDS');
  });

  it('6. refuses to overwrite a password field that already has a value', () => {
    // The walker renders a non-empty password as the bullet mask, so this is
    // all that is knowable from the tree — and all that is needed.
    const plan = planCredentialFill(
      form(textbox(USERNAME), textbox({ ...PASSWORD, value: '••••••' })),
      { hasTotp: false },
    );
    expect(!plan.ok && plan.code).toBe('ALREADY_FILLED');
  });

  it('7. autocomplete="username" beats a label-matched candidate', () => {
    const declared = textbox({ label: 'Who are you', autocomplete: 'username', inputType: 'text' });
    const guessed = textbox({ label: 'Login', inputType: 'text' });
    const plan = planCredentialFill(form(guessed, declared, textbox(PASSWORD)), {
      hasTotp: false,
    });
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.targets[0]!.key).toBe(declared.key);
  });

  it('8. refuses two fields tied at the top username tier', () => {
    const plan = planCredentialFill(
      form(
        textbox({ label: 'Email', autocomplete: 'username', inputType: 'text' }),
        textbox({ label: 'Account', autocomplete: 'username', inputType: 'text' }),
        textbox(PASSWORD),
      ),
      { hasTotp: false },
    );
    expect(!plan.ok && plan.code).toBe('AMBIGUOUS_FIELDS');
    expect(!plan.ok && plan.candidates).toEqual(['Email', 'Account']);
  });

  it('9. never treats a free-text prompt as a username candidate', () => {
    // "Why do you want this role?" sits right beside the identity fields on a
    // job application. `isFreeTextPrompt` is reused verbatim from profile.ts so
    // the two paths cannot disagree about what a prose question looks like.
    const plan = planCredentialFill(
      form(
        textbox({ label: 'Why do you want this role? Tell us about your email', inputType: 'text' }),
        textbox(PASSWORD),
      ),
      { hasTotp: false },
    );
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.targets.map((t) => t.kind)).toEqual(['password']);
  });

  it('10. never selects a synthetic node', () => {
    // Synthetic nodes are manufactured by the walker and have no element behind
    // them, so the page-side index has no entry for their key — a write aimed
    // at one could never resolve.
    const plan = planCredentialFill(
      form(
        textbox({ ...USERNAME, synthetic: true }),
        textbox({ ...PASSWORD, synthetic: true }),
      ),
      { hasTotp: false },
    );
    expect(!plan.ok && plan.code).toBe('NO_FIELDS');
  });

  it('10b. never selects a node with no ref', () => {
    const plan = planCredentialFill(
      form(textbox({ ...PASSWORD, ref: null })),
      { hasTotp: false },
    );
    expect(!plan.ok && plan.code).toBe('NO_FIELDS');
  });

  it('11. answers NO_FIELDS when there is no password and no OTP box', () => {
    const plan = planCredentialFill(
      form(textbox({ label: 'Search', inputType: 'text' }), textbox(USERNAME)),
      { hasTotp: true },
    );
    expect(!plan.ok && plan.code).toBe('NO_FIELDS');
  });

  it('12. writes username, then password, then otp — whatever the document order', () => {
    // A page whose username `change` handler reveals the password field will
    // have run it before the password write.
    const plan = planCredentialFill(
      form(
        textbox({ label: 'Verification code', autocomplete: 'one-time-code', inputType: 'text' }),
        textbox(PASSWORD),
        textbox(USERNAME),
      ),
      { hasTotp: true },
    );
    expect(plan.ok && plan.targets.map((t) => t.kind)).toEqual([
      'username',
      'password',
      'otp',
    ]);
  });

  it('fills username and password when the page also wants a code we cannot make', () => {
    const plan = planCredentialFill(
      form(
        textbox(USERNAME),
        textbox(PASSWORD),
        textbox({ label: 'Verification code', autocomplete: 'one-time-code', inputType: 'text' }),
      ),
      { hasTotp: false },
    );
    expect(plan.ok && plan.targets.map((t) => t.kind)).toEqual(['username', 'password']);
  });

  it('a plain-text field labelled "Password" is not a password candidate', () => {
    // "type=password. Nothing else, ever." A plain text field's value IS
    // serialised by the walker, so a label heuristic here would put a saved
    // password straight into the next snapshot.
    const plan = planCredentialFill(
      form(textbox({ label: 'Password', inputType: 'text' })),
      { hasTotp: false },
    );
    expect(!plan.ok && plan.code).toBe('NO_FIELDS');
  });

  it('describeTargets speaks only the fixed vocabulary', () => {
    const mk = (kinds: ('username' | 'password' | 'otp')[]) =>
      kinds.map((kind, i) => ({ ref: `e${i}`, key: `k${i}`, label: '', kind }));
    expect(describeTargets(mk(['username', 'password']))).toBe('username and password');
    expect(describeTargets(mk(['password']))).toBe('password');
    expect(describeTargets(mk(['otp']))).toBe('two-factor code');
    expect(describeTargets(mk(['username', 'password', 'otp']))).toBe(
      'username, password and two-factor code',
    );
  });
});

describe('the tool surface holds still', () => {
  it('13. has exactly four keys, forever', () => {
    // A future "just one more lever" — `only`, `overwrite`, `fieldRef`,
    // `force`, `skipConsent` — fails here rather than in review. This is
    // precisely the surface where levers accumulate, and every one of them is a
    // way for a manipulated agent to aim a credential.
    expect([...VAULT_FILL_SCHEMA_KEYS].sort()).toEqual([
      'action',
      'entryId',
      'submit',
      'tabId',
    ]);
  });
});

describe('the deny-string table', () => {
  it('14. is total, and no string is empty', () => {
    const codes = Object.keys(DENY_STRINGS);
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) {
      const s = DENY_STRINGS[code as keyof typeof DENY_STRINGS];
      expect(typeof s).toBe('string');
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('14b. leaves no interpolation marker unresolved in a rendered string', () => {
    expect(denyString('ORIGIN_MISMATCH', { origin: 'https://x.test' })).not.toMatch(/«|»/);
    expect(denyString('FILL_REVERTED', { n: 1, m: 2 })).not.toMatch(/«|»/);
    expect(denyString('TOTP_ALREADY_ISSUED', { n: 12 })).not.toMatch(/«|»/);
    expect(denyString('AMBIGUOUS_FIELDS', { n: 2, candidates: 'x' })).not.toMatch(/«|»/);
    expect(
      denyString('FILL_INTERRUPTED', {
        n: 1,
        m: 2,
        why: 'field is not a masked password field',
      }),
    ).not.toMatch(/«|»/);
  });

  it('14c. the one refusal that can follow a partial write never claims nothing was inserted', () => {
    // The preload can now stop MID-write, because a page can mutate a later
    // target from an earlier one's event handlers. Every OTHER refusal on this
    // path is decided before the first write and several of them say so in
    // those words; this one cannot, and a wrong "nothing was inserted" on a
    // form that has a value in it is the false-report class this whole design
    // is built against.
    const s = denyString('FILL_INTERRUPTED', { n: 1, m: 2, why: 'x' });
    expect(s).not.toMatch(/[Nn]othing was inserted/);
    expect(s).toMatch(/1 of 2 fields were written/);
    expect(s).toMatch(/NOT filled/);
  });

  it('15. ORIGIN_MISMATCH names the PAGE, never the record', () => {
    // Naming the record's origin would tell a page — through the agent — which
    // site a guessed id belongs to. Ids are eight random bytes so enumeration
    // is not the threat; an id the agent already spoke aloud in the transcript
    // is.
    const out = denyString('ORIGIN_MISMATCH', { origin: 'https://evil.com' });
    expect(out).toContain('evil.com');
    expect(out).not.toContain('chase.com');
    // Structural, not incidental: the template has exactly one slot, and it is
    // the page's origin. There is nowhere for a record-derived value to go.
    const markers = DENY_STRINGS.ORIGIN_MISMATCH.match(/«[a-z]+»/g) ?? [];
    expect(markers).toEqual(['«origin»']);
  });

  it('says there is no override, and offers no lever that could be one', () => {
    const out = denyString('ORIGIN_MISMATCH', { origin: 'https://evil.com' });
    expect(out).toMatch(/no override/);
    expect(out).not.toMatch(/\bforce\s*[:=]/);
  });

  it('no refusal string carries an envelope of its own', () => {
    // Rule 2: no refusal string is ever wrapped in an envelope, and no
    // page-authored text is ever outside one. AMBIGUOUS_FIELDS is the single
    // string that carries page bytes, and it SPLITS — the envelope is
    // substituted into the middle by the caller.
    for (const [code, s] of Object.entries(DENY_STRINGS)) {
      if (code === 'AMBIGUOUS_FIELDS') {
        expect(s).toContain('«candidates»');
        continue;
      }
      expect(s).not.toContain('untrusted-page-content');
      expect(s).not.toContain('«candidates»');
    }
  });
});
