import { describe, expect, it } from 'vitest';
import { attributeAct, labelsAgree, INPUT_LOSS } from '../bench/lib/proxy.mjs';

/**
 * Failure attribution — the two-line ternary that decides which component gets
 * blamed for every failure in the store.
 *
 * WHY THIS FILE EXISTS (docs/design/tier3.md §4.1, gate2-review.md): wave 2
 * shipped a change to this routing UNTESTED, and it is the exact class of thing
 * this project keeps getting bitten by. Before that change, `error: unsupported
 * key: s` — a malformed argument that names no ref and loses no ref — was filed
 * as `engine_ref_loss`, so half of the single most incriminating metric in the
 * whole suite was noise from the agent (wave2-evaluation.md §5).
 *
 * The `engine_input_loss` case is ATOMICITY SEAM 1 (tier3.md §5): the error
 * clause is emitted by src/mcp/tools.ts, and its own unit test pins that the
 * product still says it. This file pins that the bench still classifies it —
 * neither side of the seam is checked by the other's test, so both exist.
 */

/** The shape `doAct` hands to `attributeAct`, with only the interesting bits. */
const ev = (bench: string, label = 'Approve') => ({ detail: { bench, label, type: 'click' } });

const attribute = (o: Record<string, unknown>) =>
  attributeAct({
    errored: false,
    text: '',
    shadowHad: true,
    landedEvents: [],
    allowed: new Set(['approve:q1']),
    ...o,
  } as Parameters<typeof attributeAct>[0]);

describe('attributeAct — error routing', () => {
  it('files a malformed key as the agent\'s, not the engine\'s', () => {
    expect(
      attribute({ errored: true, text: 'error: unsupported key: s', shadowHad: true }),
    ).toBe('invalid_action');
  });

  it('files a missing argument as the agent\'s, not the engine\'s', () => {
    expect(
      attribute({ errored: true, text: 'error: text required for type', shadowHad: true }),
    ).toBe('invalid_action');
  });

  it('files a ref-gone error the model SHOULD have known about as engine_ref_loss', () => {
    expect(
      attribute({
        errored: true,
        text: 'error: e12 is not a known element on this page',
        shadowHad: true,
      }),
    ).toBe('engine_ref_loss');
  });

  it('files the same error as model_bookkeeping when the model was not holding the ref', () => {
    expect(
      attribute({
        errored: true,
        text: 'error: e12 is not a known element on this page',
        shadowHad: false,
      }),
    ).toBe('model_bookkeeping');
  });
});

describe('attributeAct — the W1 input-loss contract (seam 1)', () => {
  // The exact wording tier3.md §1.3 specifies for the revised error. Only the
  // pinned CLAUSE matters; the rest is here so the test reads like the wire.
  const w1Error =
    'error: input was dispatched but never reached the page. The click was sent and no ' +
    'trusted input event was observed in the page within 2.5s (checked twice). Aperture\'s ' +
    'input path to this tab is not working — retrying will not take effect. The page was ' +
    'not changed by this call. Tell the human; this needs the browser restarted.';

  it('classifies the engine\'s input-loss report as the ENGINE\'s', () => {
    expect(attribute({ errored: true, text: w1Error, shadowHad: true })).toBe('engine_input_loss');
  });

  it('checks input loss FIRST — it names no ref, so the ref test would misfile it', () => {
    // This is the whole reason for the ordering. Without the early return this
    // error fails REF_ERROR and lands in `invalid_action`, polluting the one
    // category the wave-2 fix just cleaned.
    expect(/is not a known element|could not be acted on|no longer|has gone|not found/i.test(w1Error))
      .toBe(false);
    expect(attribute({ errored: true, text: w1Error, shadowHad: false })).toBe('engine_input_loss');
  });

  it('pins the contract substring itself', () => {
    expect(INPUT_LOSS.test(w1Error)).toBe(true);
    expect(INPUT_LOSS.source).toBe('input was dispatched but never reached the page');
  });
});

describe('attributeAct — witnessed acts', () => {
  it('files an acknowledged act the witness never saw as no_page_effect', () => {
    expect(attribute({ errored: false, landedEvents: [] })).toBe('no_page_effect');
  });

  it('files a witnessed act on a disallowed element as wrong_choice', () => {
    expect(attribute({ errored: false, landedEvents: [ev('approve:q4')] })).toBe('wrong_choice');
  });

  it('files a label disagreement as identity_mismatch, before the allowed-set test', () => {
    expect(
      attribute({
        errored: false,
        landedEvents: [ev('approve:q1', 'Reject')],
        labelsAgreeFn: (pageLabel: string) => labelsAgree(pageLabel, 'Approve'),
      }),
    ).toBe('identity_mismatch');
  });

  it('files a witnessed, allowed, agreeing act as ok', () => {
    expect(
      attribute({
        errored: false,
        landedEvents: [ev('approve:q1')],
        labelsAgreeFn: (pageLabel: string) => labelsAgree(pageLabel, 'Approve'),
      }),
    ).toBe('ok');
  });

  it('attributes the LAST event in the window, which is the act\'s own', () => {
    expect(
      attribute({ errored: false, landedEvents: [ev('approve:q1'), ev('approve:q4')] }),
    ).toBe('wrong_choice');
  });

  it('accepts the allowed set as an array as well as a Set', () => {
    expect(
      attribute({ errored: false, landedEvents: [ev('approve:q1')], allowed: ['approve:q1'] }),
    ).toBe('ok');
  });
});
