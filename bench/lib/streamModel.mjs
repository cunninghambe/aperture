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
 * function from text to a Map<ref, {role,label,value,states}>.
 */

export const STATE_WORDS = new Set([
  'checked', 'disabled', 'expanded', 'selected', 'required',
  'focused', 'modal', 'readonly', 'invalid', 'live',
]);

export const unesc = (s) => s.replace(/\\(.)/g, '$1');

/** Full-snapshot / subtree line: `role eN "label" ="value" … states`. */
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
  for (let i = words.length - 1; i >= 0; i--) {
    if (STATE_WORDS.has(words[i])) states.add(words[i]);
    else break;
  }
  return { role, ref, label, value, states, optionCount };
}

/**
 * The agent's mental model, built ONLY from what it was told.
 * ref -> { role, label, value, states:Set }.
 */
export function applyObservation(model, text) {
  for (const line of text.split('\n')) {
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

    // Diff update: `~ e3 "name" ="value" "text" +focused -checked`
    const upd = /^~ (e\d+)(.*)$/.exec(line);
    if (upd) {
      const entry = model.get(upd[1]) ?? { role: '?', label: '', value: '', states: new Set() };
      let rest = upd[2];

      const vm = / ="((?:[^"\\]|\\.)*)"/.exec(rest);
      if (vm) {
        entry.value = unesc(vm[1]);
        rest = rest.slice(0, vm.index) + rest.slice(vm.index + vm[0].length);
      }
      // First remaining quoted string is the new name; a second is the text
      // delta, which a full snapshot cannot verify and is ignored here.
      const nm = / "((?:[^"\\]|\\.)*)"/.exec(rest);
      if (nm) {
        entry.label = unesc(nm[1]);
        rest = rest.slice(0, nm.index) + rest.slice(nm.index + nm[0].length);
      }
      // Strip any remaining quoted segments (the text delta) BEFORE the state
      // token loop — quoted page text containing "+... checked" must not be
      // able to inject state flags into the model.
      rest = rest.replace(/ "((?:[^"\\]|\\.)*)"/g, '');
      let mode = null;
      for (const tok of rest.trim().split(/\s+/)) {
        if (!tok) continue;
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
    if (el) model.set(el.ref, el);
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

/** Refs the model holds whose label equals `label` (optionally role-filtered). */
export function refsByLabel(model, label, roles) {
  return [...model.entries()]
    .filter(([, e]) => e.label === label && (!roles || roles.has(e.role)))
    .map(([r]) => r);
}
