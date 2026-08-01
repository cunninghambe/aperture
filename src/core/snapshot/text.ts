/**
 * Quoting and neutralizing page-authored text.
 *
 * Lifted out of `render.ts` so every path carrying page text can reach it —
 * including `selectOption.ts`, which runs in the preload's isolated world and
 * must stay free of the renderer. That was the one page-text path in the
 * product which skipped this treatment, and the gap was measurable: an option
 * label containing a bare double quote plus the literal string `[disabled]`
 * reproduced verbatim in an error message, reading as a second,
 * differently-named, apparently-unusable option — a page writing Aperture's own
 * vocabulary. Bidi overrides survived on that path too, while the snapshot line
 * for the same option escaped them correctly.
 *
 * Nothing here imports anything. That is deliberate: it is the leaf.
 */

/**
 * Longest run of page text any single string may contribute.
 *
 * The cap is what makes the response cost of a page-authored string bounded.
 * Without it a page chooses how many tokens an error costs us.
 */
export const MAX_TEXT = 80;

/**
 * Quote and neutralize page-authored text.
 *
 * Every string that came from the page sits inside double quotes, and our
 * structural tokens only ever appear unquoted at the start of a line. That
 * means a page cannot emit text that parses as snapshot structure — it cannot
 * forge a `FULL SNAPSHOT` header or a `- e5 removed` line.
 *
 * This is framing hygiene, not a claim of prompt-injection immunity. Page text
 * is still untrusted content and is marked as such at the MCP boundary.
 */
export function quote(s: string): string {
  return `"${sanitize(s)}"`;
}

/**
 * Quote and neutralize, WITHOUT the length cap.
 *
 * For the one shape where truncation is itself a bug: a listing whose whole
 * purpose is to let the agent name something exactly. `browser_read` on a
 * native `<select>` is the only way to see inside a long dropdown, and a label
 * cut to 80 characters with an ellipsis cannot be fed back to
 * `action:"select"` — it matches no tier, so the option becomes unselectable.
 *
 * Only safe where the CALLER bounds the total. `browser_read` does, with
 * `maxChars`. An error message does not, which is why errors use `quote`.
 */
export function quoteFull(s: string): string {
  return `"${sanitize(s, Infinity)}"`;
}

/**
 * The neutralized body of a quoted string, without the surrounding quotes.
 *
 * Exposed separately so a call site that builds a larger quoted construction
 * around page text does not have to nest quotes to do it.
 */
export function sanitize(s: string, max = MAX_TEXT): string {
  let t = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Strip control characters and the bidi overrides used to visually reorder
  // text so that what a human reviewer sees differs from what is really there.
  // Written as a code-point predicate rather than a character class:
  // a class of unicode escapes is one careless editor away from holding
  // the literal control characters it is meant to describe.
  t = [...t].filter((ch) => !isStripped(ch.codePointAt(0) ?? 0)).join('');
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  // Backslash must be escaped before the quote, or the encoding is not
  // injective and page text can close the quoted string early, leaving the
  // remainder to parse as snapshot structure.
  return t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Control characters and the bidi overrides, by code point. */
function isStripped(cp: number): boolean {
  return (
    cp <= 0x1f ||
    cp === 0x85 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}
