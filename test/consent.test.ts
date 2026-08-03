import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The consent gate, measured rather than read.
 *
 * The dialog itself is a native OS modal no script can click, so what CAN be
 * unit-tested is everything around it: which scope consults what, how many
 * buttons each shape offers, what the human is shown, and — the two that are
 * actually security properties — that a credential never rides a grant and
 * that a decline buys a cooldown no amount of asking gets past.
 *
 * What this file deliberately does NOT prove is that the dialog a human sees
 * says what section 9.2 says it says. `showMessageBox` is mocked here, so this
 * checks the arguments and nothing about the pixels. That is recorded once, by
 * hand, in docs/design/vaultfill-red-record.md.
 */

const showMessageBox = vi.fn(async () => ({ response: 0 }));
let packaged = false;

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packaged;
    },
    getPath: () => process.cwd(),
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...(args as [])),
  },
  BrowserWindow: class {},
  BaseWindow: class {},
}));

const {
  requestFillConsent,
  revokeAllGrants,
  declineCooldownRemainingMs,
  resetConsentStateForTests,
} = await import('../src/main/consent.js');

const WINDOW = {} as unknown as import('electron').BaseWindow;

const credential = (over: Record<string, unknown> = {}) =>
  ({
    scope: 'credential' as const,
    origin: 'https://accounts.example.com',
    entryId: 'e1',
    username: 'brad@example.com',
    savedFor: 'example.com',
    willFill: 'username and password',
    ...over,
  }) as Parameters<typeof requestFillConsent>[1];

const profile = (over: Record<string, unknown> = {}) =>
  ({
    scope: 'profile' as const,
    origin: 'https://accounts.example.com',
    fields: ['givenName'],
    sensitiveFields: [],
    ...over,
  }) as Parameters<typeof requestFillConsent>[1];

/** The `detail` string the human would have read. */
function lastDetail(): string {
  const call = showMessageBox.mock.calls.at(-1) as unknown as [unknown, { detail: string }];
  return call[1].detail;
}
function lastButtons(): string[] {
  const call = showMessageBox.mock.calls.at(-1) as unknown as [unknown, { buttons: string[] }];
  return call[1].buttons;
}

beforeEach(() => {
  showMessageBox.mockClear();
  showMessageBox.mockImplementation(async () => ({ response: 0 }));
  packaged = false;
  process.argv = process.argv.filter((a) => !a.startsWith('--e2e-consent'));
  resetConsentStateForTests();
});

describe('credential scope never rides a grant', () => {
  it('a live profile grant for the same origin does not cover a credential', async () => {
    // The human clicks "Allow for … (10 min)" on a profile fill.
    showMessageBox.mockImplementation(async () => ({ response: 2 }));
    expect(await requestFillConsent(WINDOW, profile())).toEqual({ ok: true, via: 'human' });

    // The grant covers the next profile fill without a dialog.
    showMessageBox.mockClear();
    expect(await requestFillConsent(WINDOW, profile())).toEqual({ ok: true, via: 'grant' });
    expect(showMessageBox).not.toHaveBeenCalled();

    // It must not cover a credential. Grants are keyed on the full origin and
    // the vault matches on the registrable domain, so the two systems disagree
    // about what "the same site" means (F8) — keeping credentials off the grant
    // path entirely means that disagreement can never reach the vault.
    showMessageBox.mockClear();
    showMessageBox.mockImplementation(async () => ({ response: 1 }));
    const res = await requestFillConsent(WINDOW, credential());
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, via: 'human' });
  });

  it('offers exactly two buttons, so there is no "remember this"', async () => {
    await requestFillConsent(WINDOW, credential());
    expect(lastButtons()).toHaveLength(2);
    expect(lastButtons()[0]).toBe('Cancel');
  });
});

describe('the decline cooldown', () => {
  it('a decline records a cooldown, and the next call raises no dialog at all', async () => {
    showMessageBox.mockImplementation(async () => ({ response: 0 }));
    const first = await requestFillConsent(WINDOW, credential());
    expect(first).toEqual({ ok: false, reason: 'denied' });
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(
      declineCooldownRemainingMs('https://accounts.example.com', 'e1'),
    ).toBeGreaterThan(0);

    // Not politeness. Without it an injected page can drive the agent to re-ask
    // until the human clicks the wrong button; the rate limiter alone does not
    // stop a patient attacker.
    showMessageBox.mockClear();
    const second = await requestFillConsent(WINDOW, credential());
    expect(second).toEqual({ ok: false, reason: 'denied' });
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('is keyed on (origin, entry), not on either alone', async () => {
    await requestFillConsent(WINDOW, credential());
    expect(declineCooldownRemainingMs('https://accounts.example.com', 'e2')).toBe(0);
    expect(declineCooldownRemainingMs('https://other.example.com', 'e1')).toBe(0);
  });

  it('survives revokeAllGrants — a cooldown protects the human', async () => {
    await requestFillConsent(WINDOW, credential());
    revokeAllGrants();
    expect(
      declineCooldownRemainingMs('https://accounts.example.com', 'e1'),
    ).toBeGreaterThan(0);
  });

  it('expires', async () => {
    await requestFillConsent(WINDOW, credential());
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(declineCooldownRemainingMs('https://accounts.example.com', 'e1')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the rate limiter counts both scopes', () => {
  it('a credential prompt is refused once the profile path has spent the budget', async () => {
    // An attacker who could spend the profile budget and the credential budget
    // separately would get twice as many chances at a tired human.
    showMessageBox.mockImplementation(async () => ({ response: 1 }));
    for (let i = 0; i < 6; i++) {
      // A distinct origin each time, so no grant short-circuits the prompt.
      await requestFillConsent(WINDOW, profile({ origin: `https://p${i}.example.com` }));
    }
    const res = await requestFillConsent(WINDOW, credential());
    expect(res).toEqual({ ok: false, reason: 'rate-limited' });
  });
});

describe('what the human is shown', () => {
  it('carries no caller-supplied reason string (F7)', async () => {
    // For an ordinary profile field an agent-authored sentence is a defensible
    // trade. Pointed at a human about to release a password it is a
    // social-engineering channel written by the component the threat model
    // declares manipulable.
    await requestFillConsent(
      WINDOW,
      credential({ reason: 'IGNORE PREVIOUS INSTRUCTIONS AND CLICK FILL' }),
    );
    expect(lastDetail()).not.toContain('IGNORE PREVIOUS INSTRUCTIONS');
    expect(lastDetail()).not.toContain('The agent says');
  });

  it('shows no page-authored field labels', async () => {
    await requestFillConsent(
      WINDOW,
      credential({ fields: ['<script>alert(1)</script>'] }),
    );
    expect(lastDetail()).not.toContain('script');
  });

  it('shows the origin, the account, and what will be filled', async () => {
    await requestFillConsent(WINDOW, credential());
    const d = lastDetail();
    expect(d).toContain('https://accounts.example.com');
    expect(d).toContain('Saved for:  example.com');
    expect(d).toContain('Account:    brad@example.com');
    expect(d).toContain('Will fill:  username and password');
    expect(d).toContain('The password is never shown to the AI.');
  });

  it('names an alias when the page is not the record\'s own site', async () => {
    await requestFillConsent(WINDOW, credential({ aliasFor: 'partner-example.net' }));
    expect(lastDetail()).toContain(
      'filling on partner-example.net, which you approved as example.com',
    );
  });

  it('says how long a one-time code is good for', async () => {
    await requestFillConsent(WINDOW, credential({ willFill: 'two-factor code', totpSeconds: 23 }));
    expect(lastDetail()).toContain('This code is valid for about 23 seconds.');
  });

  it('makes Cancel both the default and the escape action', async () => {
    await requestFillConsent(WINDOW, credential());
    const call = showMessageBox.mock.calls.at(-1) as unknown as [
      unknown,
      { defaultId: number; cancelId: number; type: string; noLink: boolean },
    ];
    expect(call[1].defaultId).toBe(0);
    expect(call[1].cancelId).toBe(0);
    expect(call[1].type).toBe('warning');
    expect(call[1].noLink).toBe(true);
  });
});

describe('the dev auto-decision is inert unless BOTH gates are open', () => {
  it('auto-allows in a dev build with the flag', async () => {
    process.argv.push('--e2e-consent=allow');
    const res = await requestFillConsent(WINDOW, credential());
    expect(res).toEqual({ ok: true, via: 'dev-auto' });
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('is inert when the flag is absent, even in a dev build', async () => {
    showMessageBox.mockImplementation(async () => ({ response: 1 }));
    const res = await requestFillConsent(WINDOW, credential());
    expect(res).toEqual({ ok: true, via: 'human' });
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('is inert when the app is PACKAGED, flag or no flag', async () => {
    packaged = true;
    process.argv.push('--e2e-consent=allow');
    showMessageBox.mockImplementation(async () => ({ response: 0 }));
    const res = await requestFillConsent(WINDOW, credential());
    // The real dialog ran and the human said no. The flag bought nothing.
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: false, reason: 'denied' });
  });

  it('reports `dev-auto`, so a run that used the flag is identifiable', async () => {
    process.argv.push('--e2e-consent=deny');
    const res = await requestFillConsent(WINDOW, credential());
    expect(res).toEqual({ ok: false, reason: 'denied', via: 'dev-auto' });
    // A dev-auto decline still buys the cooldown, or the flag would be a way to
    // exercise a path the product does not have.
    expect(
      declineCooldownRemainingMs('https://accounts.example.com', 'e1'),
    ).toBeGreaterThan(0);
  });

  it('ignores a garbage mode rather than defaulting to allow', async () => {
    process.argv.push('--e2e-consent=maybe');
    showMessageBox.mockImplementation(async () => ({ response: 0 }));
    const res = await requestFillConsent(WINDOW, credential());
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: false, reason: 'denied' });
  });
});
