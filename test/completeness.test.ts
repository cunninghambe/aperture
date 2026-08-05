import { describe, expect, it } from 'vitest';
import { RefRegistry } from '../src/core/snapshot/registry.js';
import { diffSnapshots, propDelta } from '../src/core/snapshot/diff.js';
import {
  REDACTED,
  REDACTED_HREF,
  canonicalNeedle,
  redactObserved,
  scrubUrlish,
} from '../src/core/snapshot/redact.js';
import { renderFull } from '../src/core/snapshot/render.js';
import { sanitize, stripFormat } from '../src/core/snapshot/text.js';
import type { Snapshot, SnapshotNode } from '../src/core/snapshot/types.js';
import { State } from '../src/core/snapshot/types.js';

/**
 * THE CONGRUENCE CONTRACT.
 *
 * `propDelta` is what makes the product's central promise true — "a diff is
 * complete: anything it does not mention is unchanged". The promise is a
 * statement about a FIELD SET, and nothing ever tethered that field set to the
 * one the walker emits. `SnapshotNode` grew `href`, `rows`, `dims`, `scroll`,
 * `optionCount`; `propDelta` kept comparing the original five. No test failed,
 * because no test knew the two sets were supposed to agree.
 *
 * The cost of that gap, measured: a flattened data table whose every cell
 * changed produced ZERO ops, the agent was told "unchanged — the action caused
 * no visible change", and the zero-op path then absorbed the new tree into the
 * baseline, so the change became unreportable for the rest of the session
 * (docs/design/review-external-2026-08-01.md §1, probe-verified against
 * f4cd2e2). The href half of the same gap is a phishing primitive
 * (docs/design/security.md).
 *
 * So the guard is mechanical rather than a resolution to be careful. Every key
 * of `SnapshotNode` carries a ruling here; the table is typed as a total
 * mapping, so ADDING A FIELD FAILS THE TYPECHECK, and the sample node below
 * fails the test at runtime for the same reason. Every `diffed` ruling is then
 * probed against the real `propDelta`. Applied to the pre-fix engine this file
 * is RED on `href` and `rows` — it would have caught the original bug the day
 * `rows` was added.
 *
 * Adding a field to `SnapshotNode`? Record a ruling. If it is `excluded`, the
 * WHY is not optional: an exclusion nobody can defend in a sentence is a bug
 * wearing a ruling's clothes.
 *
 * THE ONE RENDERED-BUT-EXCLUDED FIELD: `headingLevel`. Everything else on the
 * excluded list is either never rendered (autocomplete, inputType), identity
 * plumbing (ref, key, frameId, synthetic), renderer-internal (shape), or
 * geometry the tool description names out loud (rect, scroll). `headingLevel`
 * is the exception — it IS rendered, and it is not diffed, so a pure
 * heading-weight change (h2→h3, same text) is reported as nothing at all.
 *
 * Gate 2 flagged this as the quiet overclaim in `browser_act`'s completeness
 * sentence, and docs/design/tier3.md §4.3 rules on it: fix the SENTENCE, not
 * the engine. The engine ruling stands — the operative fact is the heading's
 * text and that IS diffed, and no failure class has been observed against the
 * weight — but the sentence now admits heading weight alongside scroll and
 * pixel layout, and this file names the field rather than letting it hide in a
 * list of plumbing. If a second rendered field is ever excluded, the sentence
 * has to move again; that is the cost of the promise being literal.
 *
 * THE TETHER NEEDS TSC. The ruling table's totality is a TYPE constraint, and
 * vitest strips types without checking them — so this file's central guarantee
 * is inert under `vitest run` alone. `test/typecheck.test.ts` runs the compiler
 * inside the suite for exactly that reason (tier3 §4.4). Without it, the header
 * claim "adding a field fails the typecheck" is true of the repo and false of
 * the command anyone actually runs.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND AXIS (2026-08-05): CAN THIS FIELD CARRY A SECRET?
 * ---------------------------------------------------------------------------
 *
 * Everything above answers ONE question — *will the agent be told when this
 * changes?* — and the whole vocabulary (`diffed` / `structural` / `excluded`)
 * is built for it. That vocabulary cannot express the other question a field
 * entering agent context raises, and a security review found the gap the
 * expensive way (`docs/design/security-review-2026-08.md` §2).
 *
 * The table was already TOTAL over `keyof Snapshot`. It ruled on `url` and on
 * `title`. Both rulings were correct. And both of those strings went to the
 * model in clear on every full snapshot after a credential fill, because
 * `redactTainted` took a `SnapshotNode` and walked the node tree, and neither
 * field is on that type. The one CI check whose job is stopping a field
 * reaching the model unruled passed a page-controlled plaintext sink
 * indefinitely — the failure class was simply outside its question. Worse,
 * `title`'s ruling of `excluded` READS, to a later reader, as "not delivered
 * to the model", when the renderer emits it on the header line of every full
 * snapshot and on every `browser_tabs` line.
 *
 * So every field now carries a `sink` ruling as well, and the two axes are
 * independent: `excluded` from the diff says nothing about whether the string
 * reaches the model, and `redacted` says nothing about whether a change to it
 * is reported.
 *
 * THE SINK AXIS IS EXECUTABLE, NOT DECLARATIVE. A second table of adjectives
 * would have exactly the failure mode the first one had. So the rulings are
 * probed against the real redactor: `planted()` writes a needle into every
 * field ruled `redacted`, `redactObserved` runs, and the needle must survive
 * neither the data nor `renderFull`'s output. Three ways a new
 * page-controlled string fails this file:
 *
 *   1. no ruling at all              → tsc, on the totality of the table
 *   2. ruled `redacted`, not planted → "plants the needle in every field"
 *   3. planted, not actually scrubbed → "removes it from every one of them"
 *
 * The probe imports `redact.ts` rather than `engine.ts` on purpose. `engine.ts`
 * imports `electron` and therefore cannot be imported by any test in this repo
 * (`docs/design/g29-red-record.md` Appendix A); the redaction was lifted into a
 * pure leaf so that this guard could execute the shipped code instead of a
 * copy of it.
 *
 * ---------------------------------------------------------------------------
 * WHAT "RENDERED" MEANS HERE, AND WHAT THIS FILE STILL CANNOT SEE
 * (corrected 2026-08-05, second gate)
 * ---------------------------------------------------------------------------
 *
 * This header used to end: *"and a rendered field cannot be ruled anything but
 * `redacted` — that check is the one that stops the NEXT `Snapshot.title`."*
 * That was true of SEVEN HARDCODED NAMES and of no future field. An independent
 * gate added a hypothetical `SnapshotNode.placeholder`, rendered it verbatim in
 * `renderLine`, ruled it `sink: 'not-page-text'` with a plausible sentence, and
 * measured the suite at 522/522 GREEN (`docs/design/sink-closure-review.md`
 * §3, case B). The name list did not grow with the type, which is the same
 * failure the diff axis was built to stop.
 *
 * "Rendered" is now MEASURED rather than listed. `renderedFields()` plants a
 * distinct canary in every string-bearing field of `Required<SnapshotNode>` and
 * `Required<Snapshot>`, calls the real `renderFull`, and reports which canaries
 * came out the other side. Three checks hang off that measurement, and each one
 * is total over the type rather than over a list:
 *
 *   4. ruled `never-emitted` but its canary IS in the output → RED
 *   5. ruled `redacted` but its canary is NOT in the output → RED (the ruling
 *      claims a delivery that does not happen, so the scrub proves nothing)
 *   6. rendered, and ruled neither `redacted` nor `never-emitted` → it joins
 *      `RENDERED_NOT_REDACTED`, which must equal a frozen list. A new rendered
 *      page-controlled string ruled `not-page-text` — case B exactly — lands
 *      in that set, the set stops matching, and the test names the field.
 *
 * WHAT IS STILL NOT COVERED, stated plainly because the last version of this
 * header implied otherwise. `not-page-text` is a claim about the DOMAIN of a
 * value ("an integer", "a closed vocabulary", "a ref Aperture minted"), and no
 * test in this file can falsify it: nothing here knows where a string came
 * from. Check 6 forces such a field to be NAMED in the frozen list rather than
 * slipping in unremarked, and that is the whole of the protection. An author
 * who adds a rendered field, rules it `not-page-text`, and adds it to the
 * frozen list has defeated this file — deliberately, in a diff that says so.
 * The three-line list below is the artefact a reviewer should read first.
 */

type DiffRuling =
  /** `propDelta` must report a change in this field. */
  | { ruling: 'diffed' }
  /** Reported by the children/registry machinery instead. */
  | { ruling: 'structural'; by: string }
  /** Deliberately never reported. */
  | { ruling: 'excluded'; why: string };

type SinkRuling =
  /**
   * Page-controlled text that reaches agent context. `scrubbedBy` names the
   * mechanism that removes a filled secret from it — and the probes below
   * check that the mechanism is real.
   */
  | { sink: 'redacted'; scrubbedBy: string }
  /**
   * Reaches agent context and cannot carry page-chosen bytes: a harness-minted
   * id, an integer, a bitmask, a fixed vocabulary, or a container whose
   * contents carry their own rulings. `whyNot` has to say which.
   */
  | { sink: 'not-page-text'; whyNot: string }
  /**
   * Never reaches agent context at all. The cheapest ruling to write and the
   * easiest to get wrong, so it is the one the render probe re-checks.
   */
  | { sink: 'never-emitted'; whyNot: string };

/** Both axes, on every field. Distinct property names so neither `by` nor
 *  `why` can be made to serve two questions at once. */
type Ruling = DiffRuling & SinkRuling;

// A total mapping: `keyof SnapshotNode` is the domain, so tsc rejects an
// unruled field before the test ever runs.
const NODE_RULINGS: Record<keyof SnapshotNode, Ruling> = {
  role: {
    ruling: 'structural',
    by: 'a role change changes the key, so it arrives as remove+add',
    sink: 'not-page-text',
    whyNot: 'a closed vocabulary: walker.roleOf checks an explicit role= attribute against KNOWN_ROLES and falls back to a computed role otherwise, so a page chooses FROM the set and never supplies the bytes',
  },
  name: {
    ruling: 'diffed',
    sink: 'redacted',
    scrubbedBy: 'redactObserved — the tainted branch replaces it outright, the needle branch scrubs it',
  },
  value: {
    ruling: 'diffed',
    sink: 'redacted',
    scrubbedBy: 'redactObserved — the field Aperture writes into, so both branches cover it',
  },
  text: {
    ruling: 'diffed',
    sink: 'redacted',
    scrubbedBy: 'redactObserved — the copy-into-a-div shape (F9); also redactFreeText, for browser_read',
  },
  states: {
    ruling: 'diffed',
    sink: 'not-page-text',
    whyNot: 'a bitmask over a fixed name table (STATE_NAMES); the page sets bits, never words',
  },
  href: {
    ruling: 'diffed',
    sink: 'redacted',
    scrubbedBy: 'redactObserved, with REDACTED_HREF because the line is unquoted — the c375415 finding',
  },
  rows: {
    ruling: 'diffed',
    sink: 'redacted',
    scrubbedBy: 'redactObserved, cell by cell — a flattened table is page text like any other',
  },

  optionCount: {
    ruling: 'structural',
    by: 'optionSetTurnedOver — covers the count AND same-count enumeration turnover; a propDelta copy would double-report',
    sink: 'not-page-text',
    whyNot: 'an integer. The option LABELS are page text, and they never enter a snapshot at all — browser_read and the select errors are where they surface, and both scrub',
  },
  children: {
    ruling: 'structural',
    by: 'reconcileChildren',
    sink: 'not-page-text',
    whyNot: 'a container, not a string; redactObserved walks into it, so every string inside is covered by its own ruling',
  },

  dims: {
    ruling: 'excluded',
    why: 'derived from rows (walker.ts computes one from the other), restated with them and never compared alone — rows equality implies dims equality',
    sink: 'not-page-text',
    whyNot: 'two integers, and they are counts of rows the cells of which carry their own ruling',
  },
  scroll: {
    ruling: 'excluded',
    why: 'churns on every scroll by agent, user, or page; the agent\'s own scroll actions already return an observation, and the semantic consequence (Offscreen) is masked for the same reason',
    sink: 'not-page-text',
    whyNot: 'two numbers, rounded to pixels by the renderer before they are printed',
  },
  rect: {
    ruling: 'excluded',
    why: 'geometry; agents act by ref, not coordinates, and it moves on every layout shift',
    sink: 'not-page-text',
    whyNot: 'four numbers, and the renderer prints none of them',
  },
  headingLevel: {
    ruling: 'excluded',
    why: 'presentation weight; the heading\'s text is the operative fact and IS diffed, and no failure class has been observed against the level. The one RENDERED field on this list — tier3 §4.3 keeps the exclusion and makes the tool sentence admit it (see header)',
    sink: 'not-page-text',
    whyNot: 'an integer 1-6, emitted as h1..h6 — the page cannot widen the alphabet',
  },
  autocomplete: {
    ruling: 'excluded',
    why: 'never rendered (types.ts) — the model never held it, so there is nothing to keep faithful',
    sink: 'never-emitted',
    whyNot: 'page-authored, and it would be a sink the day anything printed it. renderLine does not, and the render probe below re-checks that rather than trusting this sentence',
  },
  inputType: {
    ruling: 'excluded',
    why: 'never rendered — same reasoning as autocomplete',
    sink: 'never-emitted',
    whyNot: 'page-authored (the type= attribute), never printed; same re-check as autocomplete',
  },
  shape: {
    ruling: 'excluded',
    why: 'renderer-internal collapse hint, not a page fact',
    sink: 'never-emitted',
    whyNot: 'built from child roles and never printed. describeShape does print a collapsed run\'s prose, but from child NAMES through quote(), and those carry their own redacted ruling',
  },
  ref: {
    ruling: 'excluded',
    why: 'identity plumbing; the registry owns ref lifetime',
    sink: 'not-page-text',
    whyNot: 'printed, but minted by Aperture — eN, from a counter the page cannot influence',
  },
  key: {
    ruling: 'excluded',
    why: 'identity plumbing; never serialized to the model',
    sink: 'never-emitted',
    whyNot: 'page-DERIVED (role|frame|name|…), so this is the sharpest of the never-emitted rulings: printing a key anywhere would put page bytes in front of the model with no scrub on the path',
  },
  frameId: {
    ruling: 'excluded',
    why: 'identity plumbing; it is part of the key, so a node cannot change frame without changing identity',
    sink: 'never-emitted',
    whyNot: 'an integer, and not printed even as one',
  },
  synthetic: {
    ruling: 'excluded',
    why: 'identity plumbing; walker-manufactured nodes carry no ref',
    sink: 'never-emitted',
    whyNot: 'a boolean Aperture sets on nodes it manufactured; the page never supplies it',
  },
};

const SNAPSHOT_RULINGS: Record<keyof Snapshot, Ruling> = {
  url: {
    ruling: 'structural',
    by: 'the `navigated` hoist in engine.ts, which forces a full snapshot',
    sink: 'redacted',
    // The ruling that was correct and insufficient. `structural` is a true
    // statement about diff fidelity and says nothing about disclosure; the
    // hoist it names is the very mechanism that DELIVERED the secret, because
    // a URL change forces the full snapshot that prints this string.
    scrubbedBy: 'redactObserved, with REDACTED_HREF — the URL is rendered unquoted on the header line, in browser_tabs, and in browser_navigate\'s `loaded …`. Page-writable without navigating, via history.replaceState, which keeps documentReplaced false so the needles stay armed',
  },
  root: {
    ruling: 'structural',
    by: 'the tree walk itself',
    sink: 'not-page-text',
    whyNot: 'the container the walk descends into; every string under it carries its own ruling',
  },
  modal: {
    ruling: 'structural',
    by: 'the dialog subtree\'s own add/remove',
    sink: 'never-emitted',
    whyNot: 'holds an identity KEY, which is page-derived. Nothing renders it — the render probe below checks that, and if anything ever does, this ruling becomes `redacted` and the redactor grows a branch',
  },
  seq: {
    ruling: 'excluded',
    why: 'the diff names the state it applies to; the id is framing, not a page fact',
    sink: 'not-page-text',
    whyNot: 'printed, but it is Aperture\'s own epoch.step counter',
  },
  epoch: {
    ruling: 'excluded',
    why: 'same — bookkeeping for the resync cap',
    sink: 'not-page-text',
    whyNot: 'an integer Aperture increments; the page cannot reach it',
  },
  viewport: {
    ruling: 'excluded',
    why: 'full-only by design; scroll position is the excluded field family',
    sink: 'not-page-text',
    whyNot: 'three numbers, rounded to pixels on the one line that prints them',
  },
  title: {
    ruling: 'excluded',
    // Reworded 2026-08-05. The old sentence was true about diff fidelity and
    // read, to anyone scanning this table for what the model receives, as "not
    // delivered" — which is how a plaintext sink sat under a correct ruling.
    // `excluded` here means EXCLUDED FROM THE DIFF ONLY: the title is printed
    // in full on the header line of every full snapshot and on every
    // browser_tabs line.
    why: 'excluded from the DIFF, not from delivery — it is printed on every full snapshot header and every browser_tabs line. Tab-badge counters make it a live region ("(3) Inbox" ticking) and the meaningful correlate, a route change, is the navigated check. Considered and rejected: diffing title',
    sink: 'redacted',
    scrubbedBy: 'redactObserved — page-writable at any moment through document.title, with no navigation and no DOM change',
  },
};

/**
 * Every optional field populated, so `Object.keys` enumerates the real domain.
 *
 * `Required<SnapshotNode>` is the point: a new field cannot be added to the
 * type without appearing here, and it cannot appear here without a ruling.
 */
const SAMPLE: Required<SnapshotNode> = {
  role: 'table',
  name: 'Shipments',
  ref: 'e7',
  key: 'I|0|table|shipments',
  value: 'v',
  href: '/checkout',
  text: 'some text',
  states: State.Selected,
  headingLevel: 2,
  frameId: 0,
  rect: [0, 0, 10, 10],
  scroll: { top: 0, height: 100 },
  dims: { rows: 1, cols: 2 },
  rows: [['Order', 'Status']],
  optionCount: 3,
  synthetic: false,
  autocomplete: 'email',
  inputType: 'text',
  shape: 'text',
  children: [],
};

const SAMPLE_SNAPSHOT: Required<Snapshot> = {
  seq: '1.0',
  epoch: 1,
  url: 'https://example.com/',
  title: 'Example',
  root: SAMPLE,
  viewport: { top: 0, height: 800, docHeight: 800 },
  modal: 'e9',
};

// -- helpers ----------------------------------------------------------------

function base(extra: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    role: 'table',
    name: 'Shipments',
    key: 'I|0|table|shipments',
    states: 0,
    frameId: 0,
    rect: [0, 0, 100, 40],
    children: [],
    ...extra,
  };
}

/** A pair differing in exactly one field, and nothing else. */
function pair(field: Partial<SnapshotNode>, changed: Partial<SnapshotNode>) {
  return [base(field), base(changed)] as const;
}

// -- the ruling table is total ----------------------------------------------

describe('every SnapshotNode field carries a ruling', () => {
  it('rules on every own key of a fully-populated node', () => {
    const unruled = Object.keys(SAMPLE).filter((k) => !(k in NODE_RULINGS));
    // If this fails you added a field to SnapshotNode. Decide what it means for
    // completeness and record it in NODE_RULINGS — see the header.
    expect(unruled).toEqual([]);
  });

  it('rules on every own key of a snapshot', () => {
    expect(Object.keys(SAMPLE_SNAPSHOT).filter((k) => !(k in SNAPSHOT_RULINGS))).toEqual([]);
  });

  it('gives every exclusion a defensible reason', () => {
    for (const [field, r] of Object.entries({ ...NODE_RULINGS, ...SNAPSHOT_RULINGS })) {
      if (r.ruling === 'excluded') expect(r.why.length, field).toBeGreaterThan(20);
      if (r.ruling === 'structural') expect(r.by.length, field).toBeGreaterThan(5);
    }
  });

  it('gives every sink ruling a defensible reason too', () => {
    for (const [field, r] of Object.entries({ ...NODE_RULINGS, ...SNAPSHOT_RULINGS })) {
      // "it is not page text" and "nothing prints it" are both claims someone
      // has to be able to defend in a sentence, for the same reason an
      // exclusion is. `title` was defensible on the diff axis and indefensible
      // on this one, and nothing in this file could say so.
      if (r.sink === 'redacted') expect(r.scrubbedBy.length, field).toBeGreaterThan(5);
      else expect(r.whyNot.length, field).toBeGreaterThan(20);
    }
  });

  it('no RENDERED page-controlled string is ruled anything but a sink', () => {
    // Kept as the instance check, under the structural one below. These seven
    // are the fields three separate findings have already been about, and a
    // regression on any of them should say so by name rather than by set
    // difference.
    for (const f of ['name', 'value', 'text', 'href', 'rows'] as const) {
      expect(NODE_RULINGS[f].sink, f).toBe('redacted');
    }
    for (const f of ['url', 'title'] as const) {
      expect(SNAPSHOT_RULINGS[f].sink, f).toBe('redacted');
    }
  });

  it('names the exclusions the tool description promises', () => {
    // The shipped sentence is "Scroll positions, pixel layout and heading
    // weight are not tracked; everything rendered … is." That is only honest
    // while the excluded set stays inside what the sentence admits to — which
    // is why headingLevel had to be added to the sentence rather than left as
    // the one rendered field quietly missing from it (tier3 §4.3).
    const excluded = Object.entries(NODE_RULINGS)
      .filter(([, r]) => r.ruling === 'excluded')
      .map(([f]) => f);
    expect(excluded).toContain('scroll');
    expect(excluded).toContain('rect');
    expect(excluded).toContain('headingLevel');
    // …and nothing RENDERED may join them. These are the rendered fields; if a
    // future change excludes one, the tool description becomes a lie.
    for (const rendered of ['name', 'value', 'text', 'states', 'href', 'rows']) {
      expect(NODE_RULINGS[rendered as keyof SnapshotNode].ruling, rendered).toBe('diffed');
    }
  });
});

// -- the sink axis, executed against the shipped redactor --------------------

/**
 * A value Aperture filled into the page, in the shape the needle store holds.
 * Long enough to clear MIN_NEEDLE_LENGTH, distinctive enough that a substring
 * match cannot be coincidental.
 */
const NEEDLE = 'needle-pw-93a1';

/** A snapshot carrying that value in EVERY field ruled a redaction sink. */
function planted(): Required<Snapshot> {
  return {
    seq: '1.0',
    epoch: 1,
    url: `https://example.com/checkout?pw=${NEEDLE}`,
    title: `Inbox ${NEEDLE}`,
    viewport: { top: 0, height: 800, docHeight: 800 },
    modal: 'e9',
    root: {
      role: 'table',
      name: `Shipments ${NEEDLE}`,
      ref: 'e7',
      key: 'I|0|table|shipments',
      value: `v ${NEEDLE}`,
      href: `/leak?pw=${NEEDLE}`,
      text: `some text ${NEEDLE}`,
      states: State.Selected,
      headingLevel: 2,
      frameId: 0,
      rect: [0, 0, 10, 10],
      scroll: { top: 0, height: 100 },
      dims: { rows: 1, cols: 2 },
      rows: [['Order', `Status ${NEEDLE}`]],
      optionCount: 3,
      synthetic: false,
      autocomplete: 'email',
      inputType: 'text',
      shape: 'text',
      children: [],
    },
  };
}

const carries = (v: unknown): boolean => JSON.stringify(v ?? null).includes(NEEDLE);

// -- "rendered" as a measurement, not a list ---------------------------------

/**
 * Fields that reach the rendered text and are NOT redaction sinks.
 *
 * Frozen deliberately. Every entry is a string Aperture mints and a page cannot
 * influence, and each one is the kind of claim only a human can check — so the
 * cost of making that claim is adding a line here, in a diff, where a reviewer
 * sees it. A new rendered page-controlled field ruled `not-page-text` shows up
 * as an unexpected member and fails the test by name (the review's case B).
 */
const RENDERED_NOT_REDACTED = [
  'Snapshot.seq', // Aperture's own epoch.step counter, in the reset header
  'SnapshotNode.ref', // eN, minted from a counter the page cannot reach
  'SnapshotNode.role', // a closed vocabulary; the page picks FROM it
].sort();

/** A canary distinctive enough that a substring hit cannot be coincidental. */
const canary = (kind: 'Snapshot' | 'SnapshotNode', field: string): string =>
  `qcanary-${kind}-${field}-8f21`;

/**
 * One snapshot carrying a distinct canary in every string-bearing field, each
 * planted in the node whose ROLE causes that field to be rendered.
 *
 * The per-role split matters: `renderLine` only emits `text` for a node whose
 * role is `text`, so planting everything on one node would measure `text` as
 * unrendered and quietly weaken check 5.
 */
function canaried(): Required<Snapshot> {
  const node = (extra: Partial<SnapshotNode>): SnapshotNode => ({
    role: 'generic',
    key: 'I|0|generic|k',
    states: 0,
    frameId: 0,
    rect: [0, 0, 1, 1],
    children: [],
    ...extra,
  });

  const textNode = node({ role: 'text', text: canary('SnapshotNode', 'text') });
  const main = node({
    // Cast: the whole point is to plant bytes a Role never holds and see
    // whether the renderer prints them.
    role: canary('SnapshotNode', 'role') as SnapshotNode['role'],
    ref: canary('SnapshotNode', 'ref'),
    name: canary('SnapshotNode', 'name'),
    value: canary('SnapshotNode', 'value'),
    href: canary('SnapshotNode', 'href'),
    key: canary('SnapshotNode', 'key'),
    shape: canary('SnapshotNode', 'shape'),
    autocomplete: canary('SnapshotNode', 'autocomplete'),
    inputType: canary('SnapshotNode', 'inputType'),
    // `rows` is the one string-BEARING field that is not itself a string.
    rows: [[canary('SnapshotNode', 'rows')]],
    dims: { rows: 1, cols: 1 },
    headingLevel: 2,
    scroll: { top: 0, height: 10 },
    optionCount: 3,
    synthetic: false,
    children: [textNode],
  });

  return {
    seq: canary('Snapshot', 'seq'),
    epoch: 1,
    url: canary('Snapshot', 'url'),
    title: canary('Snapshot', 'title'),
    modal: canary('Snapshot', 'modal'),
    viewport: { top: 0, height: 800, docHeight: 800 },
    root: node({ children: [main] }),
  };
}

/** Every field of either type that can carry page bytes at all. */
function stringBearing(sample: Record<string, unknown>): string[] {
  return Object.keys(sample).filter((k) => {
    const v = sample[k];
    // `rows` — an array of arrays of strings — is the one non-string carrier.
    return typeof v === 'string' || (k === 'rows' && Array.isArray(v));
  });
}

/** The fields whose canary survives into what the model is handed. */
function renderedFields(): Set<string> {
  const out = new Set<string>();
  const text = renderFull(canaried());
  for (const [kind, sample] of [
    ['Snapshot', SAMPLE_SNAPSHOT],
    ['SnapshotNode', SAMPLE],
  ] as const) {
    for (const f of stringBearing(sample as unknown as Record<string, unknown>)) {
      if (text.includes(canary(kind, f))) out.add(`${kind}.${f}`);
    }
  }
  return out;
}

describe('which fields are RENDERED is measured, not listed', () => {
  it('plants a canary in every string-bearing field of both types', () => {
    // The tether. A new string field on either type appears in SAMPLE (tsc
    // requires it) and must appear in `canaried()` too, or the measurement
    // below silently stops covering it.
    const planted = JSON.stringify(canaried());
    const missing: string[] = [];
    for (const [kind, sample] of [
      ['Snapshot', SAMPLE_SNAPSHOT],
      ['SnapshotNode', SAMPLE],
    ] as const) {
      for (const f of stringBearing(sample as unknown as Record<string, unknown>)) {
        if (!planted.includes(canary(kind, f))) missing.push(`${kind}.${f}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a field ruled never-emitted is not in the rendered text', () => {
    // Failure mode 4. `never-emitted` is the cheapest ruling to write and the
    // easiest to be wrong about, and being wrong means page bytes in front of
    // the model with no scrub anywhere on the path.
    const rendered = renderedFields();
    const wrong = [...rendered].filter((qualified) => {
      const [kind, f] = qualified.split('.') as ['Snapshot' | 'SnapshotNode', string];
      const r = kind === 'Snapshot'
        ? SNAPSHOT_RULINGS[f as keyof Snapshot]
        : NODE_RULINGS[f as keyof SnapshotNode];
      return r?.sink === 'never-emitted';
    });
    expect(wrong).toEqual([]);
  });

  it('a field ruled a sink really is delivered — otherwise the scrub proves nothing', () => {
    // Failure mode 5. A `redacted` ruling on a field nothing renders would make
    // the scrub assertions vacuous for that field, and would read to the next
    // author as evidence the surface is covered.
    const rendered = renderedFields();
    const undelivered: string[] = [];
    for (const [f, r] of Object.entries(SNAPSHOT_RULINGS)) {
      if (r.sink === 'redacted' && !rendered.has(`Snapshot.${f}`)) {
        undelivered.push(`Snapshot.${f}`);
      }
    }
    for (const [f, r] of Object.entries(NODE_RULINGS)) {
      if (r.sink === 'redacted' && !rendered.has(`SnapshotNode.${f}`)) {
        undelivered.push(`SnapshotNode.${f}`);
      }
    }
    expect(undelivered).toEqual([]);
  });

  it('every OTHER rendered field is on the frozen list, by name', () => {
    // Failure mode 6, and the one that replaces the seven hardcoded names.
    // This is what a new rendered page-controlled string ruled `not-page-text`
    // trips: it is rendered, it is not a sink, so it lands here and the frozen
    // list stops matching. See the header for what this does NOT prove.
    const rendered = renderedFields();
    const notSinks = [...rendered]
      .filter((qualified) => {
        const [kind, f] = qualified.split('.') as ['Snapshot' | 'SnapshotNode', string];
        const r = kind === 'Snapshot'
          ? SNAPSHOT_RULINGS[f as keyof Snapshot]
          : NODE_RULINGS[f as keyof SnapshotNode];
        return r?.sink !== 'redacted';
      })
      .sort();
    expect(notSinks).toEqual(RENDERED_NOT_REDACTED);
  });
});

describe('every field ruled a redaction sink is actually redacted', () => {
  it('the sample plants the needle in every field ruled one', () => {
    // Failure mode 2 of 3 (see the header): a new page-controlled string ruled
    // `redacted` and never planted would sail through the scrub assertion
    // below by never being tested at all. This is the tether between the table
    // and the probe, and it is why the probe is worth more than the adjective.
    const s = planted();
    const unplanted: string[] = [];
    for (const [f, r] of Object.entries(SNAPSHOT_RULINGS)) {
      if (r.sink === 'redacted' && !carries(s[f as keyof Snapshot])) {
        unplanted.push(`Snapshot.${f}`);
      }
    }
    for (const [f, r] of Object.entries(NODE_RULINGS)) {
      if (r.sink === 'redacted' && !carries(s.root[f as keyof SnapshotNode])) {
        unplanted.push(`SnapshotNode.${f}`);
      }
    }
    expect(unplanted).toEqual([]);
  });

  it('the unredacted snapshot really does hand the needle to the model', () => {
    // The non-vacuity half. If `renderFull` stopped emitting one of these the
    // assertion below would pass for the wrong reason, so the render is
    // checked BEFORE the scrub as well as after — and the header line is
    // checked on its own, because it is the line `redactTainted` could not see.
    const raw = renderFull(planted());
    expect(raw).toContain(NEEDLE);
    const header = raw.split('\n').find((l) => l.startsWith('page "')) ?? '';
    expect(header, 'the `page "title" url` header line').toContain(`Inbox ${NEEDLE}`);
    expect(header).toContain(`?pw=${NEEDLE}`);
  });

  it('redactObserved removes it from the data — RED against the pre-fix engine', () => {
    // RED on `url` and `title` before 2026-08-05: the function took a
    // SnapshotNode and could not reach either one.
    const s = planted();
    redactObserved(s, new Set(), [NEEDLE]);
    expect(JSON.stringify(s)).not.toContain(NEEDLE);
  });

  it('…and from the text the agent is handed', () => {
    const s = planted();
    redactObserved(s, new Set(), [NEEDLE]);
    const rendered = renderFull(s);
    expect(rendered).not.toContain(NEEDLE);
    // The URL takes the whitespace-free marker, because that line is read as
    // one token. Getting this wrong would not leak, but it would break every
    // reader of the header line, which is a different kind of bug in the same
    // place.
    expect(rendered).toContain('(filled,value-withheld)');
  });

  it('the fields ruled never-emitted really are absent from the rendered text', () => {
    // Failure mode 3's mirror. `never-emitted` is the cheapest ruling to write
    // and the easiest to be wrong about, and being wrong about it means page
    // bytes reaching the model with no scrub anywhere on the path — `key` in
    // particular is page-derived. So the claim is measured rather than
    // asserted, for the string-typed ones (the rest are integers and booleans).
    const s = planted();
    const MARK = 'never-emitted-canary-8f21';
    s.root.autocomplete = MARK;
    s.root.inputType = MARK;
    s.root.shape = MARK;
    s.root.key = MARK;
    s.modal = MARK;
    expect(renderFull(s)).not.toContain(MARK);
  });

  it('a tainted field is replaced outright rather than scrubbed', () => {
    // The other branch: taint covers the FIELD Aperture wrote into, which is
    // what catches a page that flips a password input to type="text" after the
    // fill. No needle is registered here at all.
    const s = planted();
    s.root.value = 'hunter2-the-real-value';
    redactObserved(s, new Set([s.root.key]), []);
    expect(s.root.value).toBe('(filled, value withheld)');
    expect(s.root.name).toBe('(filled, value withheld)');
    expect(s.root.text).toBe('(filled, value withheld)');
  });

  it('a needle the renderer would have re-joined is matched — F-B, at unit level', () => {
    // The alphabet rule, from the redactor's side. The walker now hands over
    // strings that have already been through `stripFormat`, so a value split by
    // `U+202D` arrives whole and matches. Before the fix the walk emitted the
    // separator, the scrub missed, and `quote()` -> `sanitize()` deleted it on
    // the way out — four fields at once, measured
    // (docs/design/sink-closure-review.md F-B).
    const split = `${NEEDLE.slice(0, 8)}‭${NEEDLE.slice(8)}`;
    expect(split).not.toContain(NEEDLE); // the scrub genuinely cannot match this
    expect(stripFormat(split)).toBe(NEEDLE); // …and this is what the model got

    const s = planted();
    s.root.name = `label ${stripFormat(split)}`;
    s.root.rows = [['cell', stripFormat(split)]];
    s.title = `Inbox ${stripFormat(split)}`;
    redactObserved(s, new Set(), [NEEDLE]);
    expect(renderFull(s)).not.toContain(NEEDLE);
  });

  it('sanitize is unchanged by the strip moving upstream', () => {
    // `stripFormat` keeps tab, CR and LF where the old inline filter removed
    // them. `sanitize` normalises those to spaces BEFORE stripping, so its
    // output must be byte-identical — otherwise every rendered line in the
    // repo just moved and no test would say so.
    for (const s of ['a\tb', 'a\r\nb', ' a  b ', 'a‭b', 'a b⁩c', '']) {
      expect(sanitize(s)).toBe(sanitize(stripFormat(s)));
    }
    expect(sanitize('a\tb')).toBe('a b');
    expect(sanitize('a‭b')).toBe('ab');
    // Idempotent, which is what lets the walker apply it and the renderer
    // apply it again without the two disagreeing.
    expect(stripFormat(stripFormat('a‭bc'))).toBe(stripFormat('a‭bc'));
  });

  it('a needle Aperture percent-encoded on the way out is still matched', () => {
    // `walker.ts`'s `hrefOf` builds the rendered target with `new URL(...)`,
    // which is an ENCODER: a page that writes the value in clear gets it back
    // escaped, and the raw needle misses. Both readings are ours, so both are
    // searched — including the one where the escape hides a separator the
    // walker's strip never saw, because the URL parse ran first.
    const spaced = 'pass phrase 9931';
    expect(scrubUrlish('/leak?pw=pass%20phrase%209931', [spaced])).toBe(
      `/leak?pw=${REDACTED_HREF}`,
    );
    // URLSearchParams spells a space `+`.
    expect(scrubUrlish('/leak?pw=pass+phrase+9931', [spaced])).toBe(
      `/leak?pw=${REDACTED_HREF}`,
    );
    // The encoded invisible separator: `%E2%80%AD` is U+202D.
    expect(scrubUrlish(`/leak?pw=${NEEDLE.slice(0, 8)}%E2%80%AD${NEEDLE.slice(8)}`, [NEEDLE]))
      .toBe(`/leak?pw=${REDACTED_HREF}`);
    // A lone `%` is not an escape, and an ordinary target is untouched.
    expect(scrubUrlish('/sale?off=50%', [NEEDLE])).toBe('/sale?off=50%');
    expect(scrubUrlish('/checkout', [NEEDLE])).toBe('/checkout');
  });

  it('the canonical needle covers the whitespace the walker collapses', () => {
    // The other direction of the same alphabet problem: the TEXT was
    // normalised (walker.ts collapses every run of whitespace and trims) and
    // the NEEDLE was not, so a value holding a tab or two spaces could not
    // match its own copy on the page. `engine.ts` registers this form too.
    expect(canonicalNeedle('pass\tphrase  9931')).toBe('pass phrase 9931');
    expect(canonicalNeedle('  padded  ')).toBe('padded');
    // Unchanged for a value with nothing to canonicalise, so the ordinary case
    // registers exactly one needle and the scrub does no extra work.
    expect(canonicalNeedle(NEEDLE)).toBe(NEEDLE);

    const s = planted();
    s.root.text = 'echo pass phrase 9931';
    redactObserved(s, new Set(), [canonicalNeedle('pass\tphrase  9931')]);
    expect(s.root.text).toBe(`echo ${REDACTED}`);
  });

  it('leaves a snapshot with nothing to hide byte-identical', () => {
    // Redaction that fired on a clean page would move every benchmark cohort
    // and every fidelity baseline. Neither branch has anything to do here, and
    // this is the assertion that says so.
    const s = planted();
    const before = JSON.stringify(s);
    redactObserved(s, new Set(), []);
    expect(JSON.stringify(s)).toBe(before);
  });
});

// -- every 'diffed' field is actually diffed ---------------------------------

describe('propDelta reports every field ruled diffed', () => {
  it('name', () => {
    const [o, n] = pair({ name: 'Save' }, { name: 'Saved' });
    expect(propDelta(o, n)?.name).toEqual(['Save', 'Saved']);
  });

  it('value', () => {
    const [o, n] = pair({ value: 'a' }, { value: 'b' });
    expect(propDelta(o, n)?.value).toBe('b');
  });

  it('text', () => {
    const [o, n] = pair({ text: 'one' }, { text: 'two' });
    expect(propDelta(o, n)?.text).toEqual(['one', 'two']);
  });

  it('states', () => {
    const [o, n] = pair({ states: 0 }, { states: State.Checked });
    expect(propDelta(o, n)?.statesOn).toBe(State.Checked);
  });

  it('href — RED against the pre-fix engine', () => {
    const [o, n] = pair({ href: '/checkout' }, { href: '/checkout-v2' });
    expect(propDelta(o, n)?.href).toEqual(['/checkout', '/checkout-v2']);
  });

  it('rows — RED against the pre-fix engine', () => {
    const [o, n] = pair(
      { rows: [['#1001', 'Pending']], dims: { rows: 1, cols: 2 } },
      { rows: [['#1001', 'SHIPPED']], dims: { rows: 1, cols: 2 } },
    );
    const d = propDelta(o, n);
    expect(d?.rows).toEqual([['#1001', 'SHIPPED']]);
    // dims rides with rows and is never emitted alone.
    expect(d?.dims).toEqual({ rows: 1, cols: 2 });
  });
});

describe('the structural rulings are honoured by diffSnapshots', () => {
  const parent = (kids: SnapshotNode[]): SnapshotNode => ({
    role: 'main', name: 'main', key: 'I|0|main|m', states: 0, frameId: 0,
    rect: [0, 0, 100, 100], children: kids,
  });
  const kid = (key: string, name: string): SnapshotNode => ({
    role: 'button', name, key, states: 0, frameId: 0, rect: [0, 0, 10, 10], children: [],
  });

  it('children', () => {
    const reg = new RefRegistry();
    const before = parent([kid('I|0|button|a', 'A')]);
    const after = parent([kid('I|0|button|a', 'A'), kid('I|0|button|b', 'B')]);
    expect(diffSnapshots(before, after, reg).ops.length).toBeGreaterThan(0);
  });

  it('optionCount', () => {
    const reg = new RefRegistry();
    const sel = (count: number): SnapshotNode => ({
      role: 'combobox', name: 'State', key: 'N|0|combobox|state', states: 0,
      frameId: 0, rect: [0, 0, 10, 10], optionCount: count, children: [],
    });
    expect(diffSnapshots(parent([sel(3)]), parent([sel(51)]), reg).ops.length).toBeGreaterThan(0);
  });
});

// -- the exclusions are exclusions, not accidents ----------------------------

describe('the excluded fields stay excluded', () => {
  it('a scroll offset alone is not a diff', () => {
    const [o, n] = pair({ scroll: { top: 0, height: 900 } }, { scroll: { top: 400, height: 900 } });
    expect(propDelta(o, n)).toBeNull();
  });

  it('Offscreen alone is not a diff', () => {
    const [o, n] = pair({ states: 0 }, { states: State.Offscreen });
    expect(propDelta(o, n)).toBeNull();
  });

  it('geometry alone is not a diff', () => {
    const [o, n] = pair({ rect: [0, 0, 10, 10] }, { rect: [0, 700, 10, 10] });
    expect(propDelta(o, n)).toBeNull();
  });

  it('a heading level alone is not a diff', () => {
    const [o, n] = pair({ headingLevel: 2 }, { headingLevel: 3 });
    expect(propDelta(o, n)).toBeNull();
  });

  it('identical nodes produce nothing at all', () => {
    // The complement of every assertion above: completeness is worthless if
    // bought with false positives, because a diff that fires on nothing is a
    // diff the agent learns to discount.
    expect(propDelta(base({ rows: [['a', 'b']], href: '/x' }), base({ rows: [['a', 'b']], href: '/x' }))).toBeNull();
  });
});
