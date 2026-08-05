/**
 * The one spelling of "which origin is this URL on".
 *
 * There were two. `src/mcp/envelope.ts`'s `safeOrigin` produced the label the
 * agent is shown and the string `registerNeedles` keys the needle store by;
 * `src/main/tabs.ts`'s `originOf` produced the key `originScope` looks that
 * store up with. Two implementations of the ONE fact the whole redaction store
 * is keyed by, and they disagreed in shape already (`'unknown'` versus `null`).
 *
 * The failure mode if they ever disagree on a real origin is not a wrong label:
 * it is `needles.get(origin)` missing on every lookup, which is a **silent,
 * total** failure of redaction with no error anywhere — the opposite of how
 * every other part of this mechanism fails. Flagged by the second sink-closure
 * gate (`docs/design/sink-closure-review-2.md` §8) and closed here by deleting
 * one of them rather than by testing that they agree.
 *
 * A pure leaf with no imports at all, for the same reason `redact.ts` is one:
 * the suite executes the shipped function rather than a copy of it, and neither
 * `main` nor `mcp` has to import the other to share it.
 */

/**
 * The origin of `url`, or `null` for anything that will not parse or has no
 * meaningful origin.
 *
 * `'null'` — what a URL with an opaque origin serialises to — is treated as no
 * origin, because keying a needle store by the string `"null"` would pool every
 * opaque-origin document in the browser into one bucket.
 */
export function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : null;
  } catch {
    return null;
  }
}

/**
 * The same answer as a display label. `unknown` rather than an empty string, so
 * an envelope header always names something and a reader can tell "we could not
 * parse this" from "this came from nowhere".
 */
export function originLabel(url: string): string {
  return originOf(url) ?? 'unknown';
}
