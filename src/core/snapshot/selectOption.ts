/**
 * Matching an agent's option request against a native `<select>`.
 *
 * Pure and dependency-free on purpose: it runs inside the page's isolated
 * world (where the option list actually lives) but every decision it makes is
 * a decision about *safety*, so it has to be testable on its own, without a
 * browser.
 *
 * THE RULE: EXACT BEFORE LOOSE, AND AMBIGUITY IS AN ERROR
 *
 * Five tiers, tried in order, exact ones first. The first tier that matches
 * ANYTHING ends the search — including when what it matched is ambiguous, in
 * which case the call fails with the candidates rather than falling through to
 * a looser tier. Falling through after an ambiguous exact tier is guessing
 * with extra steps.
 *
 * Exact-before-loose is what stops the prefix trap. On a country list,
 * `"United States"` matches tier 1 uniquely and never sees
 * `"United States Minor Outlying Islands"`, which is sitting in tier 5 waiting
 * to make the answer ambiguous. Run the tiers in the other order and the
 * commonest option on the list becomes unselectable.
 *
 * There is no edit distance anywhere in here. A near-miss (`"Victora"`) is an
 * error carrying a suggestion, never a selection: choosing the wrong option in
 * a form the human then submits is a silent, durable wrong answer, and it is
 * strictly worse than a failed call the agent can retry.
 */

export interface OptionInfo {
  /** The option's rendered label. */
  text: string;
  /** The `value` attribute (or the text, when the attribute is absent). */
  value: string;
  /** Position in `select.options`, which is what the caller acts on. */
  index: number;
  disabled?: boolean;
  /** Enclosing `<optgroup label>`, if any. Passive: shown, never matched. */
  group?: string;
}

export type SelectMatch =
  | { ok: true; index: number; tier: number }
  | { ok: false; reason: 'ambiguous'; tier: number; candidates: string[] }
  | { ok: false; reason: 'no-match'; suggestions: string[] }
  | { ok: false; reason: 'disabled'; label: string }
  | { ok: false; reason: 'empty' };

/** Whitespace-normalized, case preserved. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Whitespace-normalized and case-folded. */
function fold(s: string): string {
  return norm(s).toLowerCase();
}

/**
 * The tiers, in the order they are tried.
 *
 * 1-2 are exact and case-sensitive; 3-4 relax case only; 5 is the single loose
 * tier and it is a PREFIX test, not a substring or fuzzy one. A substring tier
 * would make `"States"` select a country, which no human reading the agent's
 * transcript would predict.
 */
const TIERS: { name: string; test: (o: OptionInfo, q: string) => boolean }[] = [
  { name: 'exact label', test: (o, q) => norm(o.text) === norm(q) },
  { name: 'exact value', test: (o, q) => o.value === norm(q) },
  { name: 'label, ignoring case', test: (o, q) => fold(o.text) === fold(q) },
  { name: 'value, ignoring case', test: (o, q) => fold(o.value) === fold(q) },
  {
    name: 'label prefix',
    test: (o, q) => fold(q).length > 0 && fold(o.text).startsWith(fold(q)),
  },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

/**
 * Find the one option the query names, or fail with something the agent can
 * act on.
 */
export function matchOption(options: OptionInfo[], query: string): SelectMatch {
  if (options.length === 0) return { ok: false, reason: 'empty' };

  for (let t = 0; t < TIERS.length; t++) {
    const hits = options.filter((o) => TIERS[t]!.test(o, query));
    if (hits.length === 0) continue;

    if (hits.length > 1) {
      // Stop here. Do NOT try a looser tier: an ambiguous exact match means
      // the page really does have two options the agent could have meant, and
      // picking one of them is the failure mode this module exists to prevent.
      return {
        ok: false,
        reason: 'ambiguous',
        tier: t + 1,
        candidates: hits.map(describe),
      };
    }

    const hit = hits[0]!;
    // A disabled option can be set through the DOM, which is precisely why it
    // has to be refused here: the write would succeed, the snapshot would show
    // the new value, and the page would reject the form later for a reason the
    // agent never saw. A human cannot choose it, so neither can we.
    if (hit.disabled) return { ok: false, reason: 'disabled', label: norm(hit.text) };

    return { ok: true, index: hit.index, tier: t + 1 };
  }

  return { ok: false, reason: 'no-match', suggestions: suggest(options, query) };
}

/**
 * Options worth naming in a no-match error.
 *
 * A shared prefix of three characters, in either direction — deliberately not
 * an edit distance. "Victora" surfaces "Victoria" because both fold to a
 * common `vic`; the rule is explainable in one sentence and cannot quietly
 * promote a near-miss into a match, because it never feeds the matcher.
 */
function suggest(options: OptionInfo[], query: string): string[] {
  const q = fold(query);
  if (q.length < 3) return options.slice(0, 5).map(describe);
  const head = q.slice(0, 3);
  const near = options.filter((o) => {
    const t = fold(o.text);
    return t.startsWith(head) || q.startsWith(t.slice(0, 3));
  });
  return (near.length ? near : options).slice(0, 5).map(describe);
}

/**
 * How an option is named back to the agent.
 *
 * The value rides along only when it differs from the label, because the
 * commonest ambiguity — two options with the same text — is unresolvable
 * without it, and the agent's next call has to be able to name the one it
 * meant.
 */
export function describe(o: OptionInfo): string {
  const label = norm(o.text);
  const parts = [`"${label}"`];
  if (o.value && norm(o.value) !== label) parts.push(`(value "${o.value}")`);
  if (o.group) parts.push(`in "${o.group}"`);
  if (o.disabled) parts.push('[disabled]');
  return parts.join(' ');
}
