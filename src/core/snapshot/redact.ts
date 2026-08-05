import type { SnapshotNode } from './types.js';
// The one value import, and the only one this file may take: `text.ts` is the
// other pure leaf — no imports of its own, no Electron — so the suite can still
// execute every line here. See `decodings` for why the strip is needed on this
// side of the boundary as well as in the walker.
import { stripFormat } from './text.js';

/**
 * Redaction: keeping a value Aperture wrote into a page out of agent context.
 *
 * Lifted out of `engine.ts` for two reasons, and the second is the one that
 * matters.
 *
 * The first is the same reason `text.ts` exists: `engine.ts` imports
 * `electron`, so nothing in the test suite can import it — no unit test in this
 * repo does (`docs/design/g29-red-record.md` Appendix A states the constraint
 * and what it cost). Redaction is pure tree-and-string work with no Electron in
 * it, and a security mechanism that cannot be executed by a unit test is a
 * security mechanism whose only instrument is a live guard.
 *
 * The second is scope. `redactTainted` took a `SnapshotNode` and walked the
 * node tree, and the rule it stated for itself was *"EVERY string on
 * `SnapshotNode` that the renderer can emit is a redaction sink"*. The rule was
 * right and the type was one too narrow: the renderer also emits
 * `Snapshot.title` and `Snapshot.url` on the header line of every full
 * snapshot, and neither is on `SnapshotNode`, so the needles never covered them
 * (`docs/design/security-review-2026-08.md` F1, measured — the header line came
 * back reading `page "TITLESINK guard-pw-93a1" http://…?urlsink=guard-pw-93a1`).
 *
 * So the rule is restated here, in its own file, over its own type:
 *
 *   **EVERY page-controlled string the agent can be shown is a redaction sink,
 *   wherever it lives.**
 *
 * `RedactTarget` is that "wherever" made explicit — one entry point covering
 * both the node tree and the two header strings, so a caller cannot get one and
 * miss the other. `test/completeness.test.ts` rules on every field of both
 * types against exactly this function.
 *
 * ---------------------------------------------------------------------------
 * WHAT THAT RULE DOES AND DOES NOT SAY — corrected 2026-08-05, second gate
 * ---------------------------------------------------------------------------
 *
 * The sentence above was written as a property of the tree and was read as a
 * property of the product. It is neither, on its own, and an independent gate
 * measured two complete bypasses of it on the build that first shipped it
 * (`docs/design/sink-closure-review.md`, F-A and F-B). Both are fixed; the
 * honest statement of the rule now carries its four qualifiers, because every
 * one of them was a leak before it was a qualifier:
 *
 *   1. **SCOPE.** This function scrubs against the needles it is HANDED. It
 *      knows nothing about where they came from. Getting that scope wrong is
 *      not a bug in this file and cannot be caught here: a same-origin tab the
 *      filled page opened has content this function never sees, because its
 *      caller passed an empty needle list. Scope is decided in `engine.ts` —
 *      by ORIGIN, since 2026-08-05 — and it is argued there.
 *   2. **ALPHABET.** Substring matching is only as good as the agreement
 *      between the bytes searched and the bytes delivered. `sanitize()` DELETES
 *      invisible code points rather than escaping them, so a value split by one
 *      matched nothing here and arrived whole at the model. That is fixed
 *      upstream, in `walker.ts`: names, values, text, cells and the title are
 *      stripped at WALK time, so this function reads what the renderer will
 *      write. The url-ish fields carry the other half of the alphabet problem
 *      and it is handled below, in `scrubUrlish`.
 *   3. **TRANSFORMATION.** A page that prints the value reversed, base64'd or
 *      one character per element defeats substring matching and always will.
 *      The line this file draws: transformations APERTURE performs between the
 *      value and the model are matched through (2, and `scrubUrlish`);
 *      transformations the PAGE performs are the documented residual.
 *   4. **COVERAGE.** This function scrubs against values somebody REGISTERED,
 *      and for three gates only one call site did — the credential path. The
 *      profile path wrote a date of birth into a page with the needle branch
 *      unarmed, so every copy of it went out verbatim (F-F,
 *      `docs/design/sink-closure-review-3.md`). Like scope, this is not a bug
 *      that can be caught in this file: nothing here can tell an empty needle
 *      list from a value nobody registered. `test/fillpaths.test.ts` is where it
 *      is caught, by enumerating every call site of the fill funnel.
 *
 * This file imports one type and one function, and the function comes from the
 * other pure leaf (`text.ts`, which imports nothing at all). That is deliberate
 * and it is the property that matters: no Electron on the path, so the suite
 * executes the shipped redactor rather than a copy of it.
 */

/**
 * The one marker, defined once. `tools.ts` imports it rather than repeating it.
 *
 * WHAT THIS SENTENCE ASSERTS, AND WHAT IT USED TO ASSERT FALSELY — 2026-08-05,
 * third gate. It read `(filled, value withheld)`, which is not a statement
 * about redaction at all; it is a statement about PROVENANCE — *Aperture filled
 * this value into this place*. On the origin that was filled that is true. Off
 * it, it can be false, and the third gate measured it being false: a six-digit
 * one-time code filled on one origin turned a legitimate order number on an
 * unrelated origin into `(filled, value withheld)`, so the agent was told a
 * credential sat in that table cell. **That is worse than a missing value,
 * because it is a claim the agent may act on.**
 *
 * A needle is a substring match against a value Aperture filled SOMEWHERE in
 * this tab's origin scope (`engine.ts`, `OriginScope`) — the tab's current
 * origin, the origins it has left, and the scope of whoever opened it. Scope
 * that wide is what closes F-A, F-D and F-E, and it is exactly why the marker
 * cannot claim the value belongs here. So the marker now says what is true on
 * every surface: *something here matched a value Aperture filled*. It asserts a
 * MATCH, not a location, and it no longer tells the agent whose value it is.
 *
 * The word `withheld` is load-bearing in the other direction and is kept: the
 * agent must read this as Aperture removing text, not as the page's own
 * content, or it will treat the string as data and try to use it.
 */
export const REDACTED = '(withheld: matches a filled value)';

/**
 * The same words, with no whitespace, for the fields that are rendered
 * UNQUOTED and read as a single token: `href` on a snapshot line, and the URL
 * on the `page …` header and in `browser_tabs`. Putting spaces back would undo
 * `walker.ts`'s `sanitizeHref`, which strips whitespace on the way in precisely
 * so that every reader of those lines — `render.ts`'s format and the bench
 * stream reader alike — can take them as one whitespace-free token.
 */
export const REDACTED_HREF = '(withheld:matches-a-filled-value)';

export function scrub(s: string, needles: string[], marker = REDACTED): string {
  let out = s;
  for (const needle of needles) {
    if (out.includes(needle)) out = out.split(needle).join(marker);
  }
  return out;
}

/**
 * The scrub for a field APERTURE PERCENT-ENCODES on the way out: `href` and
 * `Snapshot.url`.
 *
 * `walker.ts`'s `hrefOf` builds the rendered target with `new URL(raw, base)`
 * and emits `u.pathname + u.search`. The URL parser is an ENCODER: a page that
 * writes the value it holds straight into `a.href` gets `?pw=my%20pass` back
 * out, and the needle is `my pass`. Same for `Snapshot.url` after a
 * `history.replaceState` the browser normalises. So the match has to be tried
 * in the decoded alphabet too, for the same reason the invisible-code-point
 * strip moved into the walker: this is APERTURE's transformation, not the
 * page's, and the rule is that Aperture's own transformations are matched
 * through.
 *
 * Two decodings are tried because two constructions are common and they
 * disagree on `+`: a template string with `encodeURIComponent`, and
 * `URLSearchParams`, which encodes a space as `+`. If a decoding matches, the
 * DECODED and scrubbed form is what is emitted — it is still a legible target
 * for the agent, and the alternative (replacing the whole field) would throw
 * away a URL the agent needs on a page whose only sin is a query parameter.
 *
 * A page that percent-encodes the value ITSELF before writing it is the
 * documented transformation residual, not this: the difference is who did the
 * encoding, and the answer here is that we did.
 *
 * ---------------------------------------------------------------------------
 * THIS FUNCTION IS NOT A CALL-SITE DECISION — 2026-08-05, second gate
 * ---------------------------------------------------------------------------
 *
 * The sentence above ("a page that writes the value straight into `a.href`
 * gets `?pw=my%20pass` back out") is true of FIVE agent-facing or
 * machine-leaving URL surfaces, and this function was wired to two of them:
 * `Snapshot.url` and `SnapshotNode.href`, both in this file. `browser_tabs
 * list`, `browser_navigate`'s `loaded …` line and `browser_capture`'s Notion
 * source URL used the plain scrub, which does not decode
 * (`docs/design/sink-closure-review-2.md` F-C, measured). A sixth turned up in
 * the same pass: the human's toolbar capture, which reaches the same Notion
 * upload with no scrub of any kind.
 *
 * So callers no longer choose. `engine.ts` exposes exactly one `redactUrl`,
 * `redactFreeText` has lost the `marker` parameter that made "right marker,
 * wrong scrub" a spellable mistake, and `test/urlsurfaces.test.ts` fails if a
 * third file so much as names `REDACTED_HREF`. Reach for that entry point, not
 * for this function.
 */
export function scrubUrlish(s: string, needles: string[], marker = REDACTED_HREF): string {
  const direct = scrub(s, needles, marker);
  if (direct !== s) return direct;
  // Nothing was encoded, so there is no second reading to try. `+` counts:
  // `URLSearchParams` spells a space that way and never emits a `%20`.
  if (!s.includes('%') && !s.includes('+')) return s;
  for (const decoded of decodings(s)) {
    const hit = scrub(decoded, needles, marker);
    if (hit !== decoded) return hit;
  }
  return s;
}

/**
 * Decoded readings of a URL-ish string; malformed escapes yield nothing.
 *
 * `stripFormat` is applied to each decoding, and that is the second half of a
 * measured residual rather than belt-and-braces. `walker.ts` strips the
 * invisible code points from every OTHER field at walk time, but an href is
 * built by `new URL(...)` first, which percent-encodes `U+202D` into three
 * ASCII characters — so the strip finds nothing and the encoded separator
 * survives. The shipped build rendered
 * `/leak?pw=guard-pw%E2%80%AD-93a1`, which is the password to any reader
 * willing to do the two decodings Aperture itself would have done
 * (`docs/design/sink-closure-review.md` F-B, closing paragraph). Both
 * transformations on that path are ours, so both are matched through.
 */
function decodings(s: string): string[] {
  const out: string[] = [];
  for (const candidate of [s, s.replace(/\+/g, ' ')]) {
    try {
      const d = decodeURIComponent(candidate);
      for (const form of [d, stripFormat(d)]) {
        if (form !== s && !out.includes(form)) out.push(form);
      }
    } catch {
      // A lone `%` is not an escape. Nothing to read here.
    }
  }
  return out;
}

/**
 * The whitespace half of the alphabet rule, applied to the NEEDLE.
 *
 * `walker.ts` collapses every run of whitespace to one space and trims, before
 * this file ever sees the string. A value that contains a tab, a newline or two
 * consecutive spaces therefore cannot match its own copy in a snapshot: the
 * text was normalised and the needle was not. `engine.ts` registers this form
 * alongside the raw value so both alphabets are covered — over-redaction if the
 * two forms differ, which is the trade this mechanism takes everywhere.
 *
 * `stripFormat`'s job (the invisible code points) is done in the walker, so it
 * is deliberately NOT repeated here: a needle is a value Aperture typed, not
 * page text, and stripping it would silently shorten a legitimate secret.
 */
export function canonicalNeedle(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

/** Values too short to register. A four-character needle redacts the web. */
const MIN_NEEDLE_LENGTH = 6;

/**
 * Is this value worth a needle?
 *
 * A PURE PREDICATE, in the pure leaf, so the suite executes the shipped rule
 * rather than a copy of it — the same reason `redactObserved` lives here. It is
 * policy about redaction, not bookkeeping about the store, and `engine.ts`'s
 * `registerNeedles` is its one caller.
 *
 * ONE BAR, AND IT IS ABOUT LENGTH — the digit bar was reverted 2026-08-05,
 * fourth gate. See `originBoundNeedle` for what replaced it and why.
 */
export function registrableNeedle(v: string): boolean {
  return v.length >= MIN_NEEDLE_LENGTH;
}

/** Below this, an all-digit value collides with ordinary page content. */
const MIN_WIDE_DIGIT_LENGTH = 9;

/**
 * Should this needle match ONLY on the origin it was filled into?
 *
 * ---------------------------------------------------------------------------
 * THE INSTRUMENT WAS WRONG, AND THIS IS THE CORRECTION — 2026-08-05, fourth gate
 * ---------------------------------------------------------------------------
 *
 * The third gate measured a real cost. A six-digit one-time code was filled on
 * one origin; the same tab then visited an UNRELATED origin whose legitimate
 * content contained that string, and the agent was shown
 * `"ORDER-B" | "(withheld: matches a filled value)"` while the same page in a
 * tab with no carried scope read `"377350"`. Precise rather than blanket — the
 * neighbouring order numbers survived — and still wrong in the way that costs
 * most: the same URL read differently in two tabs, with nothing in the output
 * saying so, and a marker that is a claim the agent may act on.
 *
 * The fix shipped for that was a SHAPE rule: refuse to register an all-digit
 * value shorter than nine. The fourth gate measured what that cost and it is
 * more than the one-time code it was aimed at
 * (`docs/design/sink-closure-review-4.md` §4). Filled on the SAME origin, one
 * line of page script:
 *
 *     leaklink.href = '/leak?pw=' + pw.value + '&c=' + otp.value;
 *
 * came back as `link e1 "Continue to checkout" /leak?pw=&c=108140` — the code
 * in clear, on the origin it was filled into, on the very next snapshot. And
 * the shape rule does not only unneedle one-time codes: a 6-to-8 digit
 * `nationalId`, `bankAccount`, `taxId`, or a `salaryExpectation` of `120000`,
 * are all sensitive by this product's own ruling, all long-lived, and were all
 * left with taint coverage and no needle.
 *
 * **The collision the third gate measured was on a CARRIED origin.** That is
 * the whole diagnosis: the problem was never the shape of the value, it was
 * the REACH of the needle. So the rule is scope rather than shape — a short
 * all-digit needle is registered like any other, and matched only where the
 * value provably belongs: the origin it was filled into. On that origin a short
 * numeric string is not "an order number that happens to collide"; it is the
 * value Aperture just wrote, and the marker's claim is true.
 *
 * WHAT IS STILL LOST, stated exactly, because it is the residual and not a
 * closure: a short all-digit value copied onto an origin the tab merely CARRIES
 * — a foreign carrier tab the filled page opened, or a self-navigation away
 * with the digits in the URL — is not scrubbed there. That is not an oversight
 * to be fixed later: on a carried origin, nothing distinguishes those six
 * digits from the page's own order number, which is exactly what the third gate
 * measured. Trading a marker that is sometimes a lie for coverage that is
 * sometimes absent is the trade this predicate exists to make, and it is made
 * at the narrowest place it can be.
 *
 * Guarded in both directions: G31 (the code must NOT rewrite an unrelated
 * origin, while a co-filled username on the same page still must) and G32 (the
 * code must not survive a copy the page makes on the FILLED origin).
 */
export function originBoundNeedle(v: string): boolean {
  return /^\d+$/.test(v) && v.length < MIN_WIDE_DIGIT_LENGTH;
}

/**
 * Everything one observation can hand the renderer that the page controls.
 *
 * Structurally satisfied by `Snapshot` and by the walker's own result payload,
 * which is what lets `observe()` redact BEFORE it builds the `Snapshot` and
 * before the `navigated` comparison — so the forced full snapshot that a URL
 * change triggers renders the scrubbed strings, and both sides of that
 * comparison are in the same alphabet.
 */
export interface RedactTarget {
  root: SnapshotNode;
  url: string;
  title: string;
}

/**
 * Replace the values of tainted fields, and any registered needle, with a fixed
 * marker.
 *
 * A fixed marker rather than a length-accurate mask: `••••••` of the right
 * length still leaks the length, which is real information about a secret.
 *
 * Needles are applied HERE as well as in `redactFreeText`, and that is the
 * second half of the F9 fix: a value the page copied into a `<div>` has to be
 * redacted in SNAPSHOTS, not only in `browser_read`.
 */
export function redactObserved(
  t: RedactTarget,
  tainted: Set<string>,
  needles: string[],
): void {
  if (tainted.size === 0 && needles.length === 0) return;
  redactNodes(t.root, tainted, needles);
  if (!needles.length) return;

  // THE TWO STRINGS THAT ARE NOT ON A NODE.
  //
  // Both are page-writable without navigating — `document.title = …` and
  // `history.replaceState(null, '', '/x?pw=' + …)` — and a same-document URL
  // change keeps `documentReplaced` false, so `invalidate()` deliberately
  // KEEPS the needles alive. The redaction state was fully armed and simply
  // did not reach here.
  //
  // Taint plays no part: taint names FIELDS Aperture wrote into, and neither
  // of these is a field. Needles are the whole mechanism for both.
  t.title = scrub(t.title, needles);
  // `scrubUrlish`, because the URL is the one header string the browser itself
  // percent-encodes — see that function.
  t.url = scrubUrlish(t.url, needles);
}

function redactNodes(root: SnapshotNode, tainted: Set<string>, needles: string[]): void {
  const stack: SnapshotNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (tainted.has(n.key)) {
      // `value` is not enough. A node that is not an input carries its content
      // in `text` or `name`, so copying a filled value into a <div> produced an
      // unredacted line. All three are rendered, so all three are redacted.
      //
      // Taint is what covers a page that flips a password input to
      // `type="text"` after the fill: the walker would then serialise the real
      // value, and this replaces it regardless of type.
      if (n.value !== undefined && n.value !== '') n.value = REDACTED;
      if (n.text) n.text = REDACTED;
      if (n.name) n.name = REDACTED;
    } else if (needles.length) {
      if (n.value) n.value = scrub(n.value, needles);
      if (n.text) n.text = scrub(n.text, needles);
      if (n.name) n.name = scrub(n.name, needles);
      if (n.rows) n.rows = n.rows.map((row) => row.map((cell) => scrub(cell, needles)));
      // `href` is the FIFTH serialised, page-controlled field, and it was the
      // one this function forgot. An independent review measured it: after a
      // successful fill, a page that writes `a.href = '/leak?pw=' + value`
      // produced `link e7 "Continue to checkout" /leak?pw=<the password>` on
      // the very next full snapshot, and in the diff too (`render.ts` emits it
      // in both). This codebase has now had three findings on this class —
      // "a link's href could change under a stable label" was the first, the
      // href leak the second, and `Snapshot.title`/`Snapshot.url` the third.
      //
      // Its own marker, because an href is rendered UNQUOTED and every reader
      // of that line takes it as one whitespace-free token.
      //
      // Only the needle branch, deliberately: the tainted branch is about
      // FIELDS Aperture wrote into, and an <input> has no href. Guarded by G19b
      // (and by G19, whose whole-snapshot check covers this line too).
      //
      // `scrubUrlish` since 2026-08-05: the rendered target is built by
      // `new URL(...)`, which percent-encodes, so the raw needle can miss a
      // value the page wrote in clear. That encoding is ours, not the page's.
      if (n.href) n.href = scrubUrlish(n.href, needles);
    }
    for (const c of n.children) stack.push(c);
  }
}

/** The live values behind tainted keys, for redacting text that never came
 *  through the tree. Pure, so the suite can exercise it. */
export function collectTaintedValues(root: SnapshotNode, tainted: Set<string>): string[] {
  const vals: string[] = [];
  const stack: SnapshotNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (tainted.has(n.key)) {
      for (const v of [n.value, n.text, n.name]) {
        if (v && v !== REDACTED) vals.push(v);
      }
    }
    for (const c of n.children) stack.push(c);
  }
  return vals;
}
