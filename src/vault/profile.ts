/**
 * The identity profile — the thing that makes an agentic browser actually
 * useful day to day.
 *
 * A job application asks for the same twelve facts every other job application
 * asked for. This stores them once and lets the agent propose filling them,
 * so the human's job reduces to "yes, use my defaults" plus whatever genuinely
 * needs a human (the CAPTCHA, the cover letter, the salary number).
 *
 * Note the division of labour that implies, and why it is the *right* one:
 * the human proves they are human, the agent does the typing. No evasion is
 * involved, which is precisely why it keeps working.
 */

/** Fields the agent may see in a fill plan. Ordinary contact detail. */
export const OPEN_FIELDS = [
  'givenName', 'familyName', 'fullName', 'email', 'phone',
  'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country',
  'organization', 'jobTitle', 'website', 'linkedin', 'github',
] as const;

/**
 * Fields the agent may know *exist* but never sees the value of. These follow
 * the same agent-blind path as passwords: the plan reports "will fill from
 * your profile", the browser inserts, and the value never enters agent context.
 *
 * The distinction is about blast radius, not squeamishness — a leaked national
 * ID or date of birth is identity-theft material in a way a work email is not.
 */
export const SENSITIVE_FIELDS = [
  'dateOfBirth', 'nationalId', 'taxId', 'bankAccount', 'salaryExpectation',
] as const;

export type OpenField = (typeof OPEN_FIELDS)[number];
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];
export type ProfileField = OpenField | SensitiveField;

export interface Profile {
  id: string;
  label: string;
  values: Partial<Record<ProfileField, string>>;
}

export function isSensitive(f: ProfileField): f is SensitiveField {
  return (SENSITIVE_FIELDS as readonly string[]).includes(f);
}

// ---------------------------------------------------------------------------
// Field matching
// ---------------------------------------------------------------------------

/**
 * The HTML `autocomplete` attribute is a standardized declaration of exactly
 * what a field wants, and a surprising share of real forms set it correctly.
 * It is by far the strongest signal available, so it is tried first and
 * trusted absolutely when present.
 */
const AUTOCOMPLETE_MAP: Record<string, ProfileField> = {
  'given-name': 'givenName',
  'family-name': 'familyName',
  name: 'fullName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  organization: 'organization',
  'organization-title': 'jobTitle',
  'street-address': 'addressLine1',
  'address-line1': 'addressLine1',
  'address-line2': 'addressLine2',
  'address-level2': 'city',
  'address-level1': 'region',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
  url: 'website',
  bday: 'dateOfBirth',
};

/**
 * Label and attribute heuristics, tried only when `autocomplete` is absent.
 *
 * Ordered most-specific first: "first name" must win over "name", or every
 * name field on the web collapses into `fullName`.
 */
const LABEL_PATTERNS: [RegExp, ProfileField][] = [
  [/\b(first|given|fore)[\s_-]*name\b/i, 'givenName'],
  [/\b(last|family|sur)[\s_-]*name\b/i, 'familyName'],
  [/\b(full|your|legal)?[\s_-]*name\b/i, 'fullName'],
  [/\be[\s_-]?mail\b/i, 'email'],
  [/\b(phone|mobile|cell|telephone|contact\s*number)\b/i, 'phone'],
  [/\b(address\s*(line)?\s*2|apt|apartment|suite|unit)\b/i, 'addressLine2'],
  [/\b(street|address\s*(line)?\s*1?|addr)\b/i, 'addressLine1'],
  [/\b(city|town|suburb|locality)\b/i, 'city'],
  [/\b(state|province|region|county)\b/i, 'region'],
  [/\b(zip|postal|post\s*code|postcode)\b/i, 'postalCode'],
  [/\bcountry\b/i, 'country'],
  [/\b(company|employer|organi[sz]ation|current\s*company)\b/i, 'organization'],
  // "role" only when it is clearly a title, never bare: "Why do you want this
  // role?" is an essay question, and answering it with "Director" is the kind
  // of silent wrong-fill that survives all the way to submission.
  [/\b(job\s*title|job\s*role|role\s*title|current\s*role|position\s*title|occupation)\b/i, 'jobTitle'],
  [/^\s*(title|position)\s*\*?\s*$/i, 'jobTitle'],
  [/\blinkedin\b/i, 'linkedin'],
  [/\b(github|git\s*hub)\b/i, 'github'],
  [/\b(website|portfolio|personal\s*site|url|homepage)\b/i, 'website'],
  [/\b(date\s*of\s*birth|birth\s*date|dob)\b/i, 'dateOfBirth'],
  [/\b(ssn|social\s*security|national\s*id|nino)\b/i, 'nationalId'],
  [/\b(tax\s*id|tin|vat)\b/i, 'taxId'],
  [/\b(salary|compensation|expected\s*pay|rate)\b/i, 'salaryExpectation'],
];

export interface FieldCandidate {
  /** Agent-facing ref, e.g. "e21". */
  ref: string;
  /** Identity key, used page-side to resolve the element. */
  key: string;
  /** Accessible name / label text. */
  label: string;
  /** The field's own `autocomplete` token, if it declared one. */
  autocomplete?: string;
  /** Input type attribute. */
  inputType?: string;
  /** Whether the field already has a value. */
  hasValue: boolean;
}

export interface FieldMatch {
  ref: string;
  key: string;
  label: string;
  field: ProfileField;
  /** 0-1. Below ACCEPT_THRESHOLD the match is reported but not filled. */
  confidence: number;
  source: 'autocomplete' | 'label' | 'type';
}

/**
 * Deliberately conservative. Filling the wrong field is worse than filling
 * nothing: it is silent, the human may not notice before submitting, and on a
 * job application the cost is a real-world embarrassment rather than a retry.
 */
export const ACCEPT_THRESHOLD = 0.7;

/**
 * Is this label a prose question rather than a field name?
 *
 * Job applications are full of these ("Why do you want this role?", "Describe
 * a time you..."), and they sit right next to the identity fields we do want.
 * Length and question-shape separate them reliably; a real field label is a
 * short noun phrase.
 */
export function isFreeTextPrompt(label: string): boolean {
  const t = label.trim();
  if (!t) return false;
  if (t.includes('?')) return true;
  if (t.length > 45) return true;
  // Five or more words is a sentence, not a field name. "Apartment, suite,
  // etc." is four.
  if (t.split(/\s+/).length >= 6) return true;
  return /^(why|how|what|describe|tell us|explain|please describe)\b/i.test(t);
}

export function matchField(c: FieldCandidate): FieldMatch | null {
  const mk = (field: ProfileField, confidence: number, source: FieldMatch['source']) =>
    ({ ref: c.ref, key: c.key, label: c.label, field, confidence, source });

  // 1. The field told us what it wants.
  if (c.autocomplete) {
    const token = c.autocomplete.split(/\s+/).pop() ?? '';
    const f = AUTOCOMPLETE_MAP[token.toLowerCase()];
    if (f) return mk(f, 0.98, 'autocomplete');
  }

  // 2. Its label looks like something we recognize.
  //
  // Free-text prompts are excluded first. An identity field is labelled with a
  // noun ("Last name"); a question or a long sentence is asking for prose, and
  // pattern-matching a stray keyword inside one produces exactly the failure
  // that matters most here — a plausible wrong value that survives to submit.
  const haystack = isFreeTextPrompt(c.label) ? '' : c.label.toLowerCase();
  if (haystack) {
    for (const [re, field] of LABEL_PATTERNS) {
      if (re.test(haystack)) {
        // A generic "name" match is much weaker than a specific one, so it
        // lands below the fill threshold and gets surfaced for confirmation.
        const generic = field === 'fullName' && !/\b(full|legal)\b/i.test(haystack);
        return mk(field, generic ? 0.6 : 0.85, 'label');
      }
    }
  }

  // 3. Fall back to the input type, which is weak but occasionally decisive.
  if (c.inputType === 'email') return mk('email', 0.8, 'type');
  if (c.inputType === 'tel') return mk('phone', 0.8, 'type');

  return null;
}

export interface FillPlanEntry {
  ref: string;
  key: string;
  label: string;
  field: ProfileField;
  confidence: number;
  /** Present only for non-sensitive fields. */
  preview?: string;
  sensitive: boolean;
  /** Why this entry will not be filled, if it will not be. */
  skip?: 'low-confidence' | 'no-value' | 'already-filled';
}

/**
 * Build a fill plan.
 *
 * The plan is what the human approves, so it has to be legible: every entry
 * names the field, what will go in it, and how confident the match is. Entries
 * that will be skipped stay in the plan with a reason rather than silently
 * vanishing — "it didn't fill my postcode" should be answerable.
 */
export function buildFillPlan(
  candidates: FieldCandidate[],
  profile: Profile,
  opts: { overwrite?: boolean } = {},
): FillPlanEntry[] {
  const plan: FillPlanEntry[] = [];

  for (const c of candidates) {
    const m = matchField(c);
    if (!m) continue;

    const sensitive = isSensitive(m.field);
    const value = profile.values[m.field];

    const entry: FillPlanEntry = {
      ref: m.ref,
      key: m.key,
      label: m.label,
      field: m.field,
      confidence: m.confidence,
      sensitive,
    };

    if (!value) entry.skip = 'no-value';
    else if (c.hasValue && !opts.overwrite) entry.skip = 'already-filled';
    else if (m.confidence < ACCEPT_THRESHOLD) entry.skip = 'low-confidence';

    // Sensitive values never appear in the plan, because the plan is handed to
    // the agent. The human sees the real value in the browser's own dialog.
    if (!sensitive && value) entry.preview = value;

    plan.push(entry);
  }

  return plan;
}

export function fillableEntries(plan: FillPlanEntry[]): FillPlanEntry[] {
  return plan.filter((e) => !e.skip);
}
