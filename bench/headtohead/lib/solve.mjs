/**
 * Label targeting for the scripted solvers — ONE definition, two dialects.
 *
 * The scripted solver resolves its targets against the SHADOW MODEL, never
 * against hardcoded refs. That is not a convenience: the historical false green
 * in this suite came from a script acting on ref numbers that no longer
 * existed. Resolving against the model means a stream that fails to deliver a
 * label update cannot even be scripted through, so H3 fails loudly instead of
 * quietly measuring nothing.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN IMPORT. `resolveLabel` in bench/task.mjs
 * is module-private, and exporting it would edit a file inside the TASK SUITE's
 * `codeVersion` — moving every stamp in a running cohort for a refactor. So the
 * logic is re-expressed here ONCE and both dialects are derived from it, rather
 * than copied twice inside this harness. The behaviour, the `nth` semantics and
 * the failure text are deliberately identical to task.mjs's, because H3
 * compares arms and two solvers that fail differently would make a shim defect
 * look like a competitor defect.
 *
 * ---------------------------------------------------------------------------
 * CONSTRAINT, inherited verbatim and not a style note: `nth` counts in MODEL
 * INSERTION ORDER, which equals document order ONLY on a page that mutates by
 * REMOVAL. `applyObservation` applies an `add` or `replace` subtree with
 * `model.set()`, which appends at the END regardless of where the element
 * landed in the DOM. Any fixture that uses `nth` must be removals-only. The
 * home set honours it; no neutral task uses `nth` at all.
 * ---------------------------------------------------------------------------
 */

/** Aperture's dialect (bench/task.mjs's sets, unchanged). */
export const APERTURE_CLICK_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'slider',
]);
export const APERTURE_TYPE_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/** Playwright's aria dialect: the same widgets, plus the role names it uses. */
export const ARIA_CLICK_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'slider', 'switch',
]);
export const ARIA_TYPE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function makeResolveLabel(clickRoles, typeRoles) {
  return function resolveLabel(model, step) {
    const roles = step.act === 'type' || step.act === 'clear' ? typeRoles : clickRoles;
    const want = norm(step.label);
    const hits = [...model.entries()].filter(
      ([, e]) => norm(e.label) === want && roles.has(e.role),
    );
    const held = () =>
      [...model.entries()].map(([r, e]) => `    ${r} ${e.role} "${e.label}"`).join('\n');
    if (step.nth) {
      if (hits.length >= step.nth) return { ref: hits[step.nth - 1][0] };
      return {
        error:
          `"${step.label}" nth:${step.nth} — the model holds only ${hits.length} of them. Model holds:\n` +
          held(),
      };
    }
    if (hits.length === 1) return { ref: hits[0][0] };
    return {
      error:
        `"${step.label}" resolves to ${hits.length} elements in the model (need exactly 1). Model holds:\n` +
        held(),
    };
  };
}

export const resolveLabel = makeResolveLabel(APERTURE_CLICK_ROLES, APERTURE_TYPE_ROLES);
export const resolveAriaLabel = makeResolveLabel(ARIA_CLICK_ROLES, ARIA_TYPE_ROLES);
