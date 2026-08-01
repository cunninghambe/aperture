import { describe, expect, it } from 'vitest';
import {
  applyObservation,
  isDiff,
  isFullSnapshot,
  isNoChange,
  isTruncated,
  parseElementLine,
} from '../bench/lib/streamModel.mjs';
import { labelsAgree } from '../bench/lib/proxy.mjs';
import { dedupeActions } from '../bench/lib/collector.mjs';

/**
 * The shared stream reader.
 *
 * This module was lifted out of bench/fidelity.mjs so the task-success bench
 * could use the SAME parser as its shadow model. That is the point of these
 * tests: if the two benches ever disagreed about what a line means, the task
 * bench's failure attribution would be describing a parser disagreement while
 * printing the word "model_bookkeeping". One parser, tested once.
 */

describe('parseElementLine', () => {
  it('reads role, ref, label, value and trailing state words', () => {
    const el = parseElementLine('  checkbox e12 "Notify me" ="on" checked required');
    expect(el).toMatchObject({ role: 'checkbox', ref: 'e12', label: 'Notify me', value: 'on' });
    expect([...el!.states].sort()).toEqual(['checked', 'required']);
  });

  it('does not let quoted page text masquerade as a state word', () => {
    // A label may legitimately contain the word "checked". It must not become
    // a state flag — that is a page controlling the agent's model of itself.
    const el = parseElementLine('button e3 "Everything checked"');
    expect(el!.label).toBe('Everything checked');
    expect(el!.states.size).toBe(0);
  });

  it('survives escaped quotes in a label', () => {
    const el = parseElementLine('button e4 "He said \\"go\\"" disabled');
    expect(el!.label).toBe('He said "go"');
    expect([...el!.states]).toEqual(['disabled']);
  });

  it('returns null for lines that are not elements', () => {
    expect(parseElementLine('page "Title" http://x/')).toBeNull();
    expect(parseElementLine('  "some bare text"')).toBeNull();
  });
});

describe('applyObservation', () => {
  it('a FULL SNAPSHOT replaces the whole model', () => {
    const m = new Map();
    applyObservation(m, 'button e1 "Old"');
    applyObservation(m, 'FULL SNAPSHOT #3 — replaces all prior state for this page\nbutton e9 "New"');
    expect([...m.keys()]).toEqual(['e9']);
  });

  it('a removal kills the named ref and everything the gone list names', () => {
    const m = new Map();
    applyObservation(m, ['list e1 "L"', 'button e2 "A"', 'button e3 "B"'].join('\n'));
    applyObservation(m, '- e1 removed (was: list "L") (gone: e2 e3)');
    expect(m.size).toBe(0);
  });

  it('a replace kills the gone list, and the subtree lines that follow revive survivors', () => {
    const m = new Map();
    applyObservation(m, ['list e1 "L"', 'button e2 "A"', 'button e3 "B"'].join('\n'));
    applyObservation(m, ['! e1 replaced (gone: e2 e3):', '  button e4 "C"'].join('\n'));
    expect([...m.keys()].sort()).toEqual(['e1', 'e4']);
  });

  it('an update applies value, name and state deltas', () => {
    const m = new Map();
    applyObservation(m, 'checkbox e5 "Notify" ="off"');
    applyObservation(m, '~ e5 "Notify me" ="on" +checked');
    expect(m.get('e5')).toMatchObject({ label: 'Notify me', value: 'on' });
    expect(m.get('e5').states.has('checked')).toBe(true);
    applyObservation(m, '~ e5 -checked');
    expect(m.get('e5').states.has('checked')).toBe(false);
  });

  it('quoted text in an update cannot inject a state flag', () => {
    const m = new Map();
    applyObservation(m, 'text e7 "x"');
    applyObservation(m, '~ e7 "name" "body text +checked disabled"');
    expect(m.get('e7').states.size).toBe(0);
  });
});

describe('observation shape predicates', () => {
  it('classifies the three headers the engine emits', () => {
    expect(isFullSnapshot('FULL SNAPSHOT #2 — replaces all prior state for this page')).toBe(true);
    expect(isDiff('page #2.1 (diff from #2)')).toBe(true);
    expect(isNoChange('page #2.1 (no visible change)')).toBe(true);
    expect(isDiff('page #2.1 (no visible change)')).toBe(false);
  });

  it('spots a budget-truncated observation', () => {
    expect(isTruncated('…\n… 12 more lines beyond budget — use browser_find or browser_read to reach them')).toBe(true);
    expect(isTruncated('button e1 "Fine"')).toBe(false);
  });
});

describe('dedupeActions', () => {
  const ev = (at: number, bench: string, type: string, value?: string) => ({
    at, kind: 'action', detail: { bench, type, value },
  });

  it('folds the input event a click drags along with it', () => {
    // One click on a checkbox: the browser fires click AND input.
    const out = dedupeActions([ev(1000, 'digest', 'click'), ev(1008, 'digest', 'input', 'on')]);
    expect(out).toHaveLength(1);
    expect(out[0].detail.value).toBe('on'); // the later detail is kept
    expect(out[0].at).toBe(1000); // under the earlier timestamp
  });

  it('does NOT collapse repeated clicks on the same element', () => {
    // The bug this rule replaced: MCP round-trips land ~350ms apart, and a
    // plain same-element time window turned three deliberate clicks into one.
    const out = dedupeActions([
      ev(1000, 'up:alpha', 'click'),
      ev(1350, 'up:alpha', 'click'),
      ev(1700, 'up:alpha', 'click'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('keeps clicks on different elements apart however fast they arrive', () => {
    const out = dedupeActions([ev(1000, 'a', 'click'), ev(1005, 'b', 'input')]);
    expect(out).toHaveLength(2);
  });

  it('does not fold an input that arrives long after the click', () => {
    const out = dedupeActions([ev(1000, 'ref', 'click'), ev(4000, 'ref', 'input', 'x')]);
    expect(out).toHaveLength(2);
  });

  it('counts one `type` as one action however many input bursts it emits', () => {
    // Aperture clears the field before typing, so the witness sees a focus
    // click and then two separate debounced input bursts.
    const out = dedupeActions([
      ev(1000, 'email', 'click'),
      ev(1010, 'email', 'input', ''),
      ev(1600, 'email', 'input', 'dana@example.com'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].detail.value).toBe('dana@example.com');
  });

  it('folds a debounced input that arrived AFTER the next action', () => {
    // The real interleaving, copied from a verbose selftest run: the witness
    // debounces typing, so `input search` lands after `click add:...`.
    const out = dedupeActions([
      ev(1000, 'search', 'click'),
      ev(1226, 'add:usb-c-cable-1m', 'click'),
      ev(1226, 'search', 'input', 'cable'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.detail.bench)).toEqual(['search', 'add:usb-c-cable-1m']);
    expect(out[0].detail.value).toBe('cable');
  });

  it('a click after a typing burst is still its own action', () => {
    const out = dedupeActions([
      ev(1000, 'email', 'click'),
      ev(1010, 'email', 'input', 'x'),
      ev(1400, 'submit', 'click'),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('labelsAgree', () => {
  it('tolerates truncation and whitespace, and still catches a real mismatch', () => {
    expect(labelsAgree('Archive message from Priya Raman', 'Archive message from Priya…')).toBe(true);
    expect(labelsAgree('Select  Marcus   Webb', 'Select Marcus Webb')).toBe(true);
    expect(labelsAgree('Select Marcus Webb', 'Select Nina Holt')).toBe(false);
  });

  it('does not manufacture a mismatch when one side said nothing', () => {
    expect(labelsAgree('Archive', undefined)).toBe(true);
  });
});
