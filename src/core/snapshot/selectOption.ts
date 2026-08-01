import { quote, quoteFull } from './text.js';

/**
 * Matching an agent's option request against a native `<select>`.
 *
 * Pure on purpose, and its one import is the leaf text sanitizer: it runs
 * inside the page's isolated world (where the option list actually lives) but
 * every decision it makes is a decision about *safety*, so it has to be
 * testable on its own, without a browser.
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
  | {
      ok: false;
      reason: 'ambiguous';
      tier: number;
      /** Capped at MAX_LISTED. */
      candidates: string[];
      /** How many options actually matched, so the count stays honest. */
      matched: number;
    }
  | { ok: false; reason: 'no-match'; suggestions: string[] }
  | { ok: false; reason: 'disabled'; label: string }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'blank-query' };

/**
 * Most options ever named back to the agent in one error.
 *
 * Measured before the cap: an ambiguous single-character query against an
 * 800-option select returned 36,031 chars (~9k tokens), and a no-match on six
 * long labels returned 20,380 — both larger than a `browser_read` of the same
 * element, which *is* capped, and both on a page whose entire snapshot is 762
 * chars. The page chose the size of our response. Five suggestions were already
 * capped; the candidate list was not, and neither was any individual label.
 */
const MAX_LISTED = 8;

/** Most options ever named in a no-match suggestion. */
const MAX_SUGGESTED = 5;

/**
 * Whitespace-normalized and unicode-normalized, case preserved.
 *
 * NFC matters because a page may serve a decomposed label while the agent
 * (reading it from our own snapshot, or from a human) sends the composed form.
 * Byte comparison then misses every tier and the no-match suggestion names a
 * label that is screen-identical to the query — a loop the agent cannot get
 * out of. Canonical equivalence is exactly what NFC is for: it can only ever
 * merge spellings of the SAME string, so it cannot promote a near-miss.
 */
function norm(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
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

  // A blank query names nothing, and the exact-VALUE tier will happily match
  // it against the `<option value="">` that every country, state and title
  // picker on the web starts with — silently resetting a field the human is
  // about to submit, which is the precise failure this module exists to
  // prevent. Only the prefix tier was guarded, and the unit test that looked
  // like it covered this passed for the wrong reason: its fixture gave every
  // option a value equal to its label, so no option had an empty value.
  //
  // `empty` means "the select has no options"; this is a different fact and
  // gets its own reason, because the agent's remedy is different.
  if (norm(query) === '') return { ok: false, reason: 'blank-query' };

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
        // Capped, but the COUNT is the true one: "matches 800 options, here
        // are 8 of them" is actionable; "matches 8 options" is a lie that
        // makes the agent think it has seen the whole problem.
        candidates: hits.slice(0, MAX_LISTED).map((o) => describe(o)),
        matched: hits.length,
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
  // `.map((o) => describe(o))`, never `.map(describe)`: Array.map passes the
  // INDEX as the second argument, and describe's second parameter is an
  // options bag.
  const named = (list: OptionInfo[]): string[] =>
    list.slice(0, MAX_SUGGESTED).map((o) => describe(o));
  const q = fold(query);
  if (q.length < 3) return named(options);
  const head = q.slice(0, 3);
  const near = options.filter((o) => {
    const t = fold(o.text);
    return t.startsWith(head) || q.startsWith(t.slice(0, 3));
  });
  return named(near.length ? near : options);
}

/**
 * How an option is named back to the agent.
 *
 * The value rides along only when it differs from the label, because the
 * commonest ambiguity — two options with the same text — is unresolvable
 * without it, and the agent's next call has to be able to name the one it
 * meant.
 */
export function describe(o: OptionInfo, opts: { full?: boolean } = {}): string {
  const q = opts.full ? quoteFull : quote;
  const label = norm(o.text);
  // `quote()`, not raw interpolation. Every other page-text path in Aperture
  // gets this treatment and this one did not: a label containing a bare double
  // quote plus the literal text `[disabled]` rendered as a second,
  // differently-named, apparently-unusable option — the page authoring
  // Aperture's own error vocabulary — and bidi overrides passed through
  // untouched while the snapshot line for the SAME option escaped them.
  //
  // `quote` also caps each label, which is what makes an error list bounded in
  // TOTAL rather than only in item count. `full` drops that cap, and exactly
  // one caller may ask for it: the `browser_read` listing, which is the only
  // way to see inside a long dropdown and is therefore the one place where
  // truncating a label makes the option unnameable — nothing matches a string
  // ending in an ellipsis. That caller bounds its own total with `maxChars`;
  // an error message has no such bound, so errors keep the cap.
  const parts = [q(label)];
  if (o.value && norm(o.value) !== label) parts.push(`(value ${q(o.value)})`);
  if (o.group) parts.push(`in ${q(o.group)}`);
  if (o.disabled) parts.push('[disabled]');
  return parts.join(' ');
}
