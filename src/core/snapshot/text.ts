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
  // The line above has already turned every tab, CR and LF into a space, so
  // `stripFormat`'s preservation of those three is a no-op here and this is
  // byte-for-byte what a single all-controls filter produced.
  t = stripFormat(t);
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  // Backslash must be escaped before the quote, or the encoding is not
  // injective and page text can close the quoted string early, leaving the
  // remainder to parse as snapshot structure.
  return t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Remove the invisible code points, and NOTHING else.
 *
 * THE ALPHABET RULE, AND WHY THIS FUNCTION IS EXPORTED (2026-08-05).
 *
 * The needle scrub is substring matching, so it is only as good as the
 * agreement between the bytes it searches and the bytes the model is handed.
 * `sanitize()` **removes** these code points rather than escaping them, and it
 * ran AFTER the redaction — so a page that wrote `guard-pw<U+202D>-93a1`
 * presented bytes that matched no needle, and Aperture itself then deleted the
 * separator on the way out and handed the model the secret whole
 * (`docs/design/sink-closure-review.md` F-B, measured on four fields at once:
 * `Snapshot.title`, `SnapshotNode.value`, `.name` and `.rows`).
 *
 * The fix is not a second scrub after the renderer. It is to make the walk
 * emit strings that are ALREADY in the renderer's alphabet, which is what
 * `walker.ts`'s `sanitizeHref` has always done for `href` — and `href` is the
 * one field that held under the probe, for exactly that reason. So the strip
 * moved upstream, `walker.ts` calls this on every name, value, text, table
 * cell and the document title, and `redactObserved` therefore searches the
 * same bytes `quote()` will later emit.
 *
 * Tab, CR and LF are deliberately KEPT here although `sanitize` removes them:
 * this function is also applied to `browser_read`'s body, which is a
 * multi-line document whose line structure is the whole point. They are
 * whitespace, not invisible formatting, and the whitespace half of the
 * alphabet is handled by normalisation on both sides rather than by deletion.
 */
export function stripFormat(s: string): string {
  return [...s].filter((ch) => !isStripped(ch.codePointAt(0) ?? 0)).join('');
}

/**
 * Control characters and the bidi overrides, by code point.
 *
 * Written as a code-point predicate rather than a character class: a class of
 * unicode escapes is one careless editor away from holding the literal control
 * characters it is meant to describe.
 */
function isStripped(cp: number): boolean {
  // Tab, LF and CR are whitespace. Every caller either normalises them to a
  // space first (`sanitize`, the walker) or needs them intact (`browser_read`).
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
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
