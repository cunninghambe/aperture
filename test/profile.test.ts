import { describe, expect, it } from 'vitest';
import {
  ACCEPT_THRESHOLD,
  buildFillPlan,
  fillableEntries,
  isSensitive,
  matchField,
  type FieldCandidate,
  type Profile,
} from '../src/vault/profile.js';

function field(p: Partial<FieldCandidate>): FieldCandidate {
  return {
    ref: 'e1',
    key: 'k1',
    label: '',
    hasValue: false,
    ...p,
  };
}

const profile: Profile = {
  id: 'p1',
  label: 'Default',
  values: {
    givenName: 'Brad',
    familyName: 'Cunningham',
    fullName: 'Brad Cunningham',
    email: 'brad@example.com',
    phone: '+61 400 000 000',
    addressLine1: '1 Example St',
    city: 'Melbourne',
    postalCode: '3000',
    organization: 'PlusLife',
    jobTitle: 'Director',
    dateOfBirth: '1980-01-01',
    nationalId: 'SECRET-ID',
  },
};

describe('matchField — autocomplete attribute', () => {
  it('trusts a declared autocomplete token above all else', () => {
    const m = matchField(field({ autocomplete: 'given-name', label: 'Nickname' }));
    expect(m?.field).toBe('givenName');
    expect(m?.source).toBe('autocomplete');
    expect(m!.confidence).toBeGreaterThan(0.9);
  });

  it('handles the multi-token form (e.g. "shipping postal-code")', () => {
    expect(matchField(field({ autocomplete: 'shipping postal-code' }))?.field).toBe(
      'postalCode',
    );
  });

  it('maps address-level1/2 to region and city', () => {
    expect(matchField(field({ autocomplete: 'address-level1' }))?.field).toBe('region');
    expect(matchField(field({ autocomplete: 'address-level2' }))?.field).toBe('city');
  });
});

describe('matchField — label heuristics', () => {
  const cases: [string, string][] = [
    ['First name', 'givenName'],
    ['Given Name', 'givenName'],
    ['Last name *', 'familyName'],
    ['Surname', 'familyName'],
    ['Email address', 'email'],
    ['E-mail', 'email'],
    ['Mobile number', 'phone'],
    ['Street address', 'addressLine1'],
    ['Apartment, suite, etc.', 'addressLine2'],
    ['Town / City', 'city'],
    ['State / Province', 'region'],
    ['ZIP code', 'postalCode'],
    ['Postcode', 'postalCode'],
    ['Current company', 'organization'],
    ['Job title', 'jobTitle'],
    ['LinkedIn profile', 'linkedin'],
    ['Date of birth', 'dateOfBirth'],
    ['Expected salary', 'salaryExpectation'],
  ];

  for (const [label, expected] of cases) {
    it(`maps "${label}" to ${expected}`, () => {
      expect(matchField(field({ label }))?.field).toBe(expected);
    });
  }

  it('prefers the specific name match over the generic one', () => {
    // If "name" won here, every first-name field on the web would be filled
    // with the person's full name.
    expect(matchField(field({ label: 'First name' }))?.field).toBe('givenName');
    expect(matchField(field({ label: 'Last name' }))?.field).toBe('familyName');
  });

  it('scores a bare "Name" below the fill threshold', () => {
    const m = matchField(field({ label: 'Name' }));
    expect(m?.field).toBe('fullName');
    // Ambiguous: it could be full name, company name, or reference name. It
    // gets surfaced for confirmation rather than filled.
    expect(m!.confidence).toBeLessThan(ACCEPT_THRESHOLD);
  });

  it('returns null for something it does not recognize', () => {
    expect(matchField(field({ label: 'How did you hear about us?' }))).toBeNull();
  });
});

describe('matchField — type fallback', () => {
  it('uses input type when there is no label or autocomplete', () => {
    expect(matchField(field({ inputType: 'email' }))?.field).toBe('email');
  });
});

describe('buildFillPlan', () => {
  it('plans a realistic job-application form', () => {
    const plan = buildFillPlan(
      [
        field({ ref: 'e1', key: 'k1', label: 'First name', autocomplete: 'given-name' }),
        field({ ref: 'e2', key: 'k2', label: 'Last name', autocomplete: 'family-name' }),
        field({ ref: 'e3', key: 'k3', label: 'Email', inputType: 'email' }),
        field({ ref: 'e4', key: 'k4', label: 'Current company' }),
        field({ ref: 'e5', key: 'k5', label: 'Why do you want this role?' }),
      ],
      profile,
    );

    // The free-text question is not a profile field and is left alone.
    expect(plan).toHaveLength(4);
    const fillable = fillableEntries(plan);
    expect(fillable.map((e) => e.field)).toEqual([
      'givenName', 'familyName', 'email', 'organization',
    ]);
  });

  it('never puts a sensitive value in the plan', () => {
    const plan = buildFillPlan(
      [field({ ref: 'e9', key: 'k9', label: 'Date of birth' })],
      profile,
    );
    const entry = plan[0]!;
    expect(entry.sensitive).toBe(true);
    expect(entry.preview).toBeUndefined();
    // The value must not appear anywhere in what the agent receives.
    expect(JSON.stringify(plan)).not.toContain('1980-01-01');
  });

  it('keeps national ID out of the plan entirely', () => {
    const plan = buildFillPlan(
      [field({ ref: 'e10', key: 'k10', label: 'Social security number' })],
      profile,
    );
    expect(JSON.stringify(plan)).not.toContain('SECRET-ID');
    expect(plan[0]!.sensitive).toBe(true);
  });

  it('exposes ordinary contact details, which the agent may see', () => {
    const plan = buildFillPlan(
      [field({ ref: 'e1', key: 'k1', autocomplete: 'email' })],
      profile,
    );
    expect(plan[0]!.preview).toBe('brad@example.com');
    expect(plan[0]!.sensitive).toBe(false);
  });

  it('does not overwrite a field the human already filled', () => {
    const plan = buildFillPlan(
      [field({ ref: 'e1', key: 'k1', autocomplete: 'email', hasValue: true })],
      profile,
    );
    expect(plan[0]!.skip).toBe('already-filled');
    expect(fillableEntries(plan)).toHaveLength(0);
  });

  it('overwrites when explicitly asked to', () => {
    const plan = buildFillPlan(
      [field({ ref: 'e1', key: 'k1', autocomplete: 'email', hasValue: true })],
      profile,
      { overwrite: true },
    );
    expect(fillableEntries(plan)).toHaveLength(1);
  });

  it('reports a low-confidence match but refuses to fill it', () => {
    const plan = buildFillPlan([field({ ref: 'e1', key: 'k1', label: 'Name' })], profile);
    expect(plan[0]!.skip).toBe('low-confidence');
    expect(fillableEntries(plan)).toHaveLength(0);
  });

  it('keeps skipped entries visible with a reason', () => {
    // "It didn't fill my postcode" has to be answerable, so skips stay in the
    // plan rather than silently vanishing.
    const sparse: Profile = { id: 'p2', label: 'Sparse', values: { email: 'a@b.c' } };
    const plan = buildFillPlan(
      [
        field({ ref: 'e1', key: 'k1', autocomplete: 'email' }),
        field({ ref: 'e2', key: 'k2', autocomplete: 'postal-code' }),
      ],
      sparse,
    );
    expect(plan).toHaveLength(2);
    expect(plan[1]!.skip).toBe('no-value');
  });
});

describe('sensitivity classification', () => {
  it('treats identity-theft material as sensitive', () => {
    expect(isSensitive('nationalId')).toBe(true);
    expect(isSensitive('dateOfBirth')).toBe(true);
    expect(isSensitive('bankAccount')).toBe(true);
  });

  it('treats ordinary contact details as open', () => {
    expect(isSensitive('email')).toBe(false);
    expect(isSensitive('city')).toBe(false);
    expect(isSensitive('organization')).toBe(false);
  });
});
