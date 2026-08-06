/**
 * The mechanical reader of Aperture's observation stream.
 *
 * This file exists in ONE copy on purpose. `bench/fidelity.mjs` uses it as the
 * thing under test (does the stream describe the page?); `bench/task.mjs` uses
 * it as a SHADOW MODEL beside a language model (did the LLM's mistake have to
 * happen, given what it was told?). If those two ever parsed the stream
 * differently, the attribution the task bench prints would be about a parser
 * disagreement rather than about the agent — so they share, deliberately.
 *
 * Nothing here talks to the network or knows what a task is. It is a pure
 * function from text to a Map<ref, {role,label,value,states,href,dims,rows}>.
 *
 * THE FIELD SET IS NOT A STYLE CHOICE — it is the ceiling on what any bench
 * built on this reader can ever see. For a year it was role/ref/label/value/
 * states, then optionCount; `href`, `dims` and table `rows` were emitted by the
 * renderer and dropped here. Both sides of fidelity.mjs's comparison are built
 * by this function, so a field this reader discards compares stale-against-fresh
 * as EQUAL: the propDelta blind-field bug (tier2b, external review 2026-08-01)
 * was structurally invisible to five green fidelity scenarios for exactly that
 * reason. When the walker's emission set grows, this function is where the
 * ruling gets made — and `test/completeness.test.ts` is what forces someone to
 * make it.
 */

/**
 * WITHOUT AN ENTRY HERE THE READER CANNOT SEE THE WORD, and both sides of
 * every fidelity comparison are built by this file — so a state the renderer
 * emits and this set omits compares stale-against-fresh as EQUAL, silently,
 * forever. That is the propDelta blind-field failure exactly (see the header),
 * one field along. `inert` and `no-pointer` arrive with tier6 §4.
 */
export const STATE_WORDS = new Set([
  'checked', 'disabled', 'expanded', 'selected', 'required',
  'focused', 'modal', 'readonly', 'invalid', 'live',
  'inert', 'no-pointer',
]);

export const unesc = (s) => s.replace(/\\(.)/g, '$1');

/** `3x2` — a flattened table's dimensions, derived from its rows. */
const DIMS_TOKEN = /^(\d+)x(\d+)$/;
/** `(0/1200px)` — a scrollable's offset. EXCLUDED from the contract (tier2b §1). */
const SCROLL_TOKEN = /^\(-?\d+\/-?\d+px\)$/;

/**
 * One rendered table row back into cells.
 *
 * Cells are pipe-joined with ` | ` and each non-empty cell is quoted
 * (render.ts:247-252), so the separator is only a separator OUTSIDE a quoted
 * cell — a cell whose own text contains " | " would otherwise split into two.
 * Scanned rather than `split(' | ')` for that reason.
 */
export function splitRowLine(s) {
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(s.slice(i));
      if (m) {
        cur += unesc(m[1]);
        i += m[0].length;
        continue;
      }
    }
    if (s.startsWith(' | ', i)) {
      cells.push(cur);
      cur = '';
      i += 3;
      continue;
    }
    cur += s[i];
    i++;
  }
  cells.push(cur);
  return cells;
}

/** Leading whitespace of a line, as a count. Row attachment is indentation-based. */
const indentOf = (line) => /^\s*/.exec(line)[0].length;

/**
 * One left-to-right, escape-aware pass over the tail of a `~` update line.
 *
 * WHY A SCANNER AND NOT ANOTHER SEQUENCE OF REGEX EXCISIONS. Excision is
 * exactly what made the old misparse possible: the tail was searched for a
 * `="…"`, then for "the first remaining quoted string", and whatever was left
 * over was assumed to be a text delta nobody could verify. Under that rule a
 * text-only delta on an aria-labelled button (`~ e1 "✕"`) overwrote the LABEL —
 * corruption, not ambiguity, and permanent, because no later observation ever
 * contradicts it (tier6 §3.1).
 *
 * The wire is prefix-disambiguated now (`"…"` = name, `="…"` = value,
 * `text "…"` = inner text, `href=` = target, `RxC:` = rows), and no single-pass
 * regex can read it safely: a NAME whose own content ends in `text `, followed
 * by a real `text "T"` token, defeats any excision order you pick. Reading
 * quoted strings as UNITS and looking at the token immediately before each is
 * unambiguous by construction, whatever the page puts inside the quotes.
 *
 * Returns `{ quoted, words, href, dims }`, where `quoted` is
 * `[{ prefix, value }]` with `prefix` one of `'='`, `'text'`, or null (no
 * prefix), and `words` is every bare token that was NOT consumed as a prefix,
 * an href, or the trailing dims marker — i.e. exactly the candidates for the
 * state loop.
 */
export function scanUpdateTail(rest) {
  const quoted = [];
  const words = [];
  let href;
  let dims;
  let prefix = null; // the bare token immediately before the next quoted string
  let i = 0;

  while (i < rest.length) {
    if (rest[i] === ' ') {
      i++;
      continue;
    }
    // `="…"` — the value, whose `=` is attached rather than a separate token.
    if (rest[i] === '=' && rest[i + 1] === '"') {
      const m = /^="((?:[^"\\]|\\.)*)"/.exec(rest.slice(i));
      if (m) {
        quoted.push({ prefix: '=', value: unesc(m[1]) });
        prefix = null;
        i += m[0].length;
        continue;
      }
    }
    if (rest[i] === '"') {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(rest.slice(i));
      if (m) {
        quoted.push({ prefix, value: unesc(m[1]) });
        // A token consumed as a PREFIX is not also a state-word candidate.
        if (prefix !== null) words.pop();
        prefix = null;
        i += m[0].length;
        continue;
      }
      // An unterminated quote is not a quoted string; fall through and eat it
      // as a bare token, so the scan always terminates.
    }
    let j = i;
    while (j < rest.length && rest[j] !== ' ') j++;
    const tok = rest.slice(i, j);
    i = j;

    // hrefs hold no whitespace and no quotes (`sanitizeHref`, walker.ts), so a
    // token-level read of them cannot be broken by page content.
    const hm = /^href=(\S+)$/.exec(tok);
    if (hm) {
      href = hm[1];
      prefix = null;
      continue;
    }
    // `RxC:` — a rows restatement, and only ever the LAST token on the line;
    // the rows themselves follow, indented, on the lines after it. "Last" has
    // to tolerate trailing whitespace, exactly as the regex this replaced did
    // (` (\d+)x(\d+):\s*$`) — a trailing space would otherwise drop the dims on
    // the floor AND leave the indented rows unconsumed, in silence.
    const dm = /^(\d+)x(\d+):$/.exec(tok);
    if (dm && rest.slice(i).trim() === '') {
      dims = { rows: Number(dm[1]), cols: Number(dm[2]) };
      prefix = null;
      continue;
    }
    words.push(tok);
    prefix = tok;
  }

  return { quoted, words, href, dims };
}

/**
 * Full-snapshot / subtree line:
 * `role eN "label" ="value" href [N options] RxC (top/heightpx) states`.
 *
 * The bare (unquoted, unbracketed) tokens are read POSITIONALLY, in the
 * renderer's emission order (render.ts:230-238): href, then `RxC` dims, then
 * the scroll offset. Scroll is parsed only so it cannot be mistaken for
 * something else — it is an excluded field and is not returned.
 *
 * hrefs are `sanitizeHref`-guaranteed to hold no whitespace and no quotes
 * (walker.ts:697-699), so a token-level read cannot be broken by page content.
 */
export function parseElementLine(line) {
  const m = /^\s*(\w+) (e\d+)(.*)$/.exec(line);
  if (!m) return null;
  const [, role, ref, restRaw] = m;
  let rest = restRaw;
  let label = '';
  let value = '';

  const nm = /^ "((?:[^"\\]|\\.)*)"/.exec(rest);
  if (nm) {
    label = unesc(nm[1]);
    rest = rest.slice(nm[0].length);
  }
  const vm = / ="((?:[^"\\]|\\.)*)"/.exec(rest);
  if (vm) {
    value = unesc(vm[1]);
    rest = rest.slice(0, vm.index) + rest.slice(vm.index + vm[0].length);
  }

  // `[N options]` is the ONLY thing distinguishing a native <select> (which
  // needs action:"select") from a custom ARIA combobox (which needs clicks),
  // and the reader used to drop it on the floor — so no scenario could ever
  // turn red on a stale one, however wrong the model's belief about the list.
  let optionCount;
  const om = / \[(\d+) options\]/.exec(rest);
  if (om) {
    optionCount = Number(om[1]);
    rest = rest.slice(0, om.index) + rest.slice(om.index + om[0].length);
  }

  const states = new Set();
  const words = rest.trim().split(/\s+/).filter(Boolean);
  let bareEnd = words.length;
  for (let i = words.length - 1; i >= 0; i--) {
    if (STATE_WORDS.has(words[i])) {
      states.add(words[i]);
      bareEnd = i;
    } else break;
  }

  // What is left, in emission order: [href] [RxC] [(top/heightpx)].
  const bare = words.slice(0, bareEnd).filter((t) => !SCROLL_TOKEN.test(t));
  let href;
  let dims;
  if (bare.length >= 2) {
    // Both present: order decides, and no shape test can be fooled by an href
    // that happens to look like `3x2`.
    href = bare[0];
    const dm = DIMS_TOKEN.exec(bare[1]);
    if (dm) dims = { rows: Number(dm[1]), cols: Number(dm[2]) };
  } else if (bare.length === 1) {
    const dm = DIMS_TOKEN.exec(bare[0]);
    if (dm) dims = { rows: Number(dm[1]), cols: Number(dm[2]) };
    else href = bare[0];
  }

  return { role, ref, label, value, states, optionCount, href, dims };
}

/**
 * The agent's mental model, built ONLY from what it was told.
 * ref -> { role, label, value, states:Set, href?, dims?, rows? }.
 *
 * The loop is indexed rather than a for…of over lines because a flattened
 * table's rows are LINES OF THEIR OWN, indented under the table's element line
 * (render.ts:247-252). They carry no `role eN` head, so nothing but their
 * position attaches them to their table — which is exactly why they used to
 * fall on the floor.
 */
export function applyObservation(model, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^FULL SNAPSHOT #/.test(line)) {
      model.clear();
      continue;
    }

    // Replace destroys refs: `! e3 replaced (gone: e8 e9):` — subtree lines
    // that follow re-add the survivors and newcomers.
    const rep = /^! (e\d+) replaced(?: \(gone: ([^)]*)\))?:/.exec(line);
    if (rep) {
      if (rep[2]) for (const r of rep[2].trim().split(/\s+/)) model.delete(r);
      continue;
    }

    // A removal destroys a SUBTREE: `- e3 removed (was: list "Colours")
    // (gone: e8 e9)`. The gone list names the refs that died inside it, which
    // no reader can infer — nothing else in the stream says what the removed
    // node contained.
    const rm = /^- (e\d+) removed/.exec(line);
    if (rm) {
      model.delete(rm[1]);
      const inside = /\(gone: ([^)]*)\)/.exec(line);
      if (inside) for (const r of inside[1].trim().split(/\s+/)) model.delete(r);
      continue;
    }

    // Refs that died inside a removed container which had no ref of its own:
    // `- gone: e2 e3`. A <div> panel is `generic` and a row is `listitem`, so
    // neither is addressable and neither can head a `- eN removed` line — but
    // the refs beneath them are just as dead.
    const bare = /^- gone: (.*)$/.exec(line);
    if (bare) {
      for (const r of bare[1].trim().split(/\s+/)) model.delete(r);
      continue;
    }

    if (/^> e\d+ moved/.test(line)) continue; // position is not tracked

    // Diff update:
    // `~ e3 "name" ="value" text "inner" href=/p 3x2: +focused -checked`
    //
    // `href=` and the `RxC:` + indented rows tail are the wire form tier2b P0
    // adds for the two fields propDelta was blind to; the `text` token is
    // tier6 §3's disambiguator. Reading any of them here has to land in the
    // SAME change set as the renderer emitting them — the `isNoChange` note
    // below is the precedent and the reason.
    const upd = /^~ (e\d+)(.*)$/.exec(line);
    if (upd) {
      const entry = model.get(upd[1]) ?? { role: '?', label: '', value: '', states: new Set() };
      const { quoted, words, href, dims } = scanUpdateTail(upd[2]);

      if (href !== undefined) entry.href = href;
      // `~ e7 3x2:` — a rows restatement. The rows follow, indented, in exactly
      // the element-line row format.
      if (dims !== undefined) {
        entry.dims = dims;
        const rows = [];
        const base = indentOf(line);
        while (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > base) {
          rows.push(splitRowLine(lines[++i].trim()));
        }
        entry.rows = rows;
      }

      for (const q of quoted) {
        if (q.prefix === '=') entry.value = q.value;
        // NO PREFIX = THE NEW ACCESSIBLE NAME. That is now the whole rule for a
        // bare string, and the corruption it replaces is why: a text delta used
        // to arrive bare and overwrite the label of an element whose name had
        // not changed at all.
        else if (q.prefix === null) entry.label = q.value;
        else if (q.prefix === 'text') {
          // The displayed string of a TEXT line IS its text, so for that role
          // the two are one fact and the label moves. For everything else the
          // inner text is recorded and NOT compared — a full snapshot renders
          // no inner text for a non-text node, so nothing could verify it. Same
          // posture as before; now without the misapply.
          if (entry.role === 'text') entry.label = q.value;
          else entry.text = q.value;
        }
        // Any OTHER prefix is a token this reader does not know, on a wire it
        // is supposed to understand completely. Falling back to bare-string
        // semantics here is precisely how the old misapply worked, so an
        // unknown prefix applies NOTHING and the disagreement stays visible in
        // the comparison rather than being laundered into the model.
      }

      // The state loop runs over the bare tokens only — after every quoted
      // string has been consumed as a unit — so quoted page text reading
      // `+checked disabled` can never inject a state flag.
      let mode = null;
      for (const tok of words) {
        if (tok.startsWith('+')) mode = 'on';
        else if (tok.startsWith('-')) mode = 'off';
        const word = tok.replace(/^[+-]/, '');
        if (mode && STATE_WORDS.has(word)) {
          if (mode === 'on') entry.states.add(word);
          else entry.states.delete(word);
        }
      }
      model.set(upd[1], entry);
      continue;
    }

    // Anything else that looks like an element line (full snapshots, add and
    // replace subtrees) restates the element outright.
    const el = parseElementLine(line);
    if (el) {
      // A flattened table's rows are the indented lines directly beneath it —
      // on full snapshots, `+ add` subtrees and `! replace` subtrees alike.
      // Consumed until the indentation returns to the table's level or
      // shallower, which is also where the table's siblings resume.
      if (el.role === 'table') {
        const base = indentOf(line);
        let j = i;
        const rows = [];
        let flattened = true;
        while (j + 1 < lines.length && lines[j + 1].trim() && indentOf(lines[j + 1]) > base) {
          const next = lines[++j];
          // A table that was NOT flattened (it holds links or buttons, so the
          // walker kept its subtree — walker.ts:277) renders element lines under
          // itself. Those are children, not rows, and mistaking one for the
          // other would both invent a row and lose an element.
          if (parseElementLine(next) || /^\s*…/.test(next)) {
            flattened = false;
            break;
          }
          rows.push(splitRowLine(next.trim()));
        }
        if (flattened && rows.length) {
          el.rows = rows;
          i = j;
        }
      }
      model.set(el.ref, el);
    }
  }
  return model;
}

// --- Shape predicates over an observation ----------------------------------
// One definition of "this is a diff" / "this is a full snapshot", used by the
// fidelity bench's step accounting and by the task bench's arm-purity guards.
// Two spellings of these drifted apart once already.

export const isFullSnapshot = (text) => /^FULL SNAPSHOT #/m.test(text);
export const isDiff = (text) => /^page #\d+\.\d+ \(diff from/m.test(text);
/**
 * Both engine wordings — the diagnostic one an action gets, and the redundant
 * one a voluntary snapshot gets — share the `(unchanged` prefix precisely so
 * ONE regex classifies them. This must move in the SAME change set as the
 * engine's wording: with the old spelling, a new-format observation classifies
 * as `other`, which pollutes `unclassified` and breaks G4's share arithmetic in
 * the diff arm.
 */
export const isNoChange = (text) => /^page #\d+\.\d+ \(unchanged/m.test(text);
/** The budget dropped lines. A truncated observation is not a fair one. */
export const isTruncated = (text) => text.includes('more lines beyond budget');

/** A dispatch-free engine validation reply: page-byte-free by
 *  construction (every page-embedding reply is multi-line with an
 *  untrusted(...) envelope; single-line is the tools.ts validation
 *  vocabulary — wave3-evaluation §1.2/§1.4). */
export const isBareError = (text) =>
  text.startsWith('error: ') && !text.includes('\n');

/** THE observation taxonomy, in precedence order. Page-shaped bytes win:
 *  a reply that contains a FULL SNAPSHOT or diff header classifies as
 *  that, whatever its first line says — neither arm-purity route ever
 *  excuses a reply carrying page-shaped bytes. */
export function classifyObservation(text) {
  if (isFullSnapshot(text)) return 'full';
  if (isDiff(text)) return 'diff';
  if (isNoChange(text)) return 'nochange';
  if (isBareError(text)) return 'error';
  return 'other';
}

/** Refs the model holds whose label equals `label` (optionally role-filtered). */
export function refsByLabel(model, label, roles) {
  return [...model.entries()]
    .filter(([, e]) => e.label === label && (!roles || roles.has(e.role)))
    .map(([r]) => r);
}
