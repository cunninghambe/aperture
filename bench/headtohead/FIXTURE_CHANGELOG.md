# Neutral fixture changelog

§4.2 rule 3 of `docs/design/headtohead.md`:

> **Freeze-and-changelog:** fixture hashes are recorded in the store's cohort
> file before the first scored episode. G1/G2-class preflights DO drive fixtures
> with both engines before scoring — that is unavoidable and correct (an
> unsolvable fixture measures nothing) — so post-first-contact edits are
> permitted **only** to restore mechanical solvability, and every one lands in
> `bench/headtohead/FIXTURE_CHANGELOG.md` with a diff summary. An edit that adds
> difficulty after first contact voids the fixture's neutrality claim; the
> changelog is how a skeptic checks.

Every entry below happened during **phase 0**, before any cohort file existed
and before a single scored episode ran. No edit adds difficulty; the additions
are page furniture outside the allowed set, and the removals are none.

---

## 2026-08-02 — initial authoring

Six fixtures written to the §4.3 specs, which were fixed in the design document
on 2026-08-01, before any of these files existed and before either engine had
ever loaded one.

| fixture | class | how |
|---|---|---|
| `booking-form.html` | neutral-small | hand-written |
| `inventory-pick.html` | neutral-small | hand-written |
| `account-prefs.html` | neutral-small | hand-written |
| `journal-comment.html` | neutral-large | generated (`fixtures/make-fixtures.mjs`) |
| `console-quota.html` | neutral-large | generated |
| `catalog-order.html` | neutral-large | generated |

`bench.js` is a byte-identical copy of `bench/fixtures/bench.js`
(sha256 `d17fea2bfeea926c…`), checked by the linter's R8 and by H5.

## 2026-08-02 — R1 collision in the generator (twice)

**What.** `bulkPhrase` derived its unique suffix from a caller-supplied index,
and two different call sites reached the same index. Two products in different
catalogue sections got the same accessible name; then, after the first fix, two
nav links did.

**Found by.** The linter's R1, both times, before any engine saw the file.

**Fix.** A single module-level counter, reset per fixture, so uniqueness is a
property of the generator rather than of every call site remembering. Bytes of
every generated fixture changed; nothing about task difficulty did.

## 2026-08-02 — heterogeneous bulk, to reach §4.2's size band

**What.** The first generator built 14 structurally identical `<section>`s and
144 structurally identical product rows. Measured live against the untruncated
Aperture full snapshot, the three neutral-large fixtures came out at **671,
1,089 and 1,267 tokens** against §4.2's 5,000–9,500 band.

**Why.** `src/core/snapshot/render.ts` collapses a run of five or more
consecutive same-shape siblings to three plus `… N more listitems (link) — read
e17` (`COLLAPSE_RUN = 5`, `COLLAPSE_SHOW = 3`). Homogeneous bulk cannot reach the
band, because the product is designed not to let it. The band is defined ON THE
APERTURE SNAPSHOT (§4.2), so a page that collapses to 700 tokens *is* a small
page by the spec's own unit, whatever its HTML weighs.

**Fix.** The bulk now cycles through four structural templates (paragraphs,
blockquote+list, definition list, table), nav lists are split into groups of
four under headings, and product rows carry varying badges and secondary links.
This is what the real pages the band was measured on look like — RESULTS.md §A's
Hacker News reaches 9,512 tokens with 233 refs, which is only possible because
its rows are not all one shape.

**Scope note this creates, and the report owes the reader:** the neutral-large
class therefore does **not** measure Aperture's behaviour on a long homogeneous
list, where the collapse is worth roughly an order of magnitude. That is a real
Aperture advantage this benchmark deliberately does not claim, because a fixture
built on it would be measuring one renderer feature rather than the observation
channel.

**Measured after the change** (untruncated Aperture full snapshot,
4 chars/token):

| fixture | tokens | band | collapsed runs |
|---|---|---|---|
| `journal-comment.html` | 5,557 | 5,000–9,500 | 1 |
| `console-quota.html` | 5,957 | 5,000–9,500 | 0 |
| `catalog-order.html` | 6,009 | 5,000–9,500 | 1 |

## 2026-08-02 — page furniture on two small fixtures

**What.** `booking-form.html` measured 249 tokens and `account-prefs.html` 125,
against §4.2's small class of "~300–600 snapshot tokens".

**Fix.** Ordinary page furniture added to both: a small `<nav>`, one or two
descriptive paragraphs, a short "before you arrive" / "elsewhere in your
account" section, and a `<footer>` of three links. Every added control is a link
that is **not** in the task's allowed set, so an agent that wanders into it
scores a wrong-element action — which is the correct consequence, not a trap.
No task step, predicate, prompt or `mustObserve` changed.

**Measured after the change:** `booking-form.html` 426 tokens,
`account-prefs.html` 357 tokens, `inventory-pick.html` 307 tokens (untouched).

## 2026-08-02 — comment wording

**What.** The linter's R7 (no tool vocabulary in ids, classes or comments) fired
on the word "snapshot" inside the calibration comments this changelog describes.

**Fix.** Reworded to "page size". Zero effect on rendered markup; recorded
because R7 firing on the author is exactly as informative as R7 firing on the
fixture.
