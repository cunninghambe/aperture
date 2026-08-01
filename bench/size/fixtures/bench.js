/**
 * The witness.
 *
 * Ground truth for the task benchmark is NOT the snapshot pipeline — one half
 * of that pipeline is the thing under test, and this suite has already printed
 * two greens that came from asking the thing under test whether it was working.
 * So every fixture reports its own full state, from its own JavaScript, to a
 * loopback collector. Nothing the walker, the differ or the renderer does can
 * change what lands here.
 *
 * Two kinds of event:
 *   load    — the page came up; carries the initial state (the null-agent
 *             guard needs a baseline that no agent has touched).
 *   action  — something with [data-bench] was clicked or typed into. Carries
 *             the element's identity AND the label the PAGE gives it, which is
 *             what makes `identity_mismatch` detectable: if the agent acted on
 *             the ref it thought was "Archive Priya Raman" and the page says it
 *             was "Archive Tom Bexley", only the page can say so.
 *
 * Fixture rules this file assumes, from the design: no Math.random, no
 * Date-derived content, no clock-shaped text, no <select>, lists rebuilt with
 * replaceChildren, and `data-bench` — never `data-testid`, which is Tier-1
 * input to Aperture's identity-key scheme and would change the very behaviour
 * being measured.
 */
(function () {
  var ENDPOINT = 'http://127.0.0.1:8898/e';
  var seq = 0;
  var stateFn = function () { return {}; };
  var debounce = {};

  function post(body) {
    try {
      // text/plain keeps this a CORS "simple request", so there is no preflight
      // to be blocked and no OPTIONS handler to get wrong. A witness that goes
      // quiet for a protocol reason would look exactly like a task that failed.
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      /* the fixture must never break because the collector is down */
    }
  }

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function labelOf(el) {
    var a = el.getAttribute('aria-label');
    if (a) return norm(a);
    if (el.labels && el.labels.length) return norm(el.labels[0].textContent);
    var t = norm(el.textContent || '');
    if (t) return t;
    return norm(el.getAttribute('placeholder') || el.value || '');
  }

  function report(kind, detail) {
    post({
      seq: ++seq,
      kind: kind,
      detail: detail || {},
      state: stateFn(),
      page: location.pathname,
    });
  }

  // Identity is taken in the CAPTURE phase — a handler that calls
  // stopPropagation cannot hide an action from the witness. The STATE is read
  // one turn later, after the fixture's own handler has run and rebuilt
  // whatever it rebuilds.
  document.addEventListener(
    'click',
    function (ev) {
      var t = ev.target;
      var el = t && t.closest ? t.closest('[data-bench]') : null;
      if (!el) return;
      var id = el.getAttribute('data-bench');
      var label = labelOf(el);
      setTimeout(function () {
        report('action', { type: 'click', bench: id, label: label });
      }, 0);
    },
    true,
  );

  document.addEventListener(
    'input',
    function (ev) {
      var t = ev.target;
      var el = t && t.closest ? t.closest('[data-bench]') : null;
      if (!el) return;
      var id = el.getAttribute('data-bench');
      // Typing arrives one character at a time. One event per keystroke would
      // swamp every other event and make "actions per run" meaningless, so a
      // field coalesces to a single event once it goes quiet.
      //
      // 100ms, not 150: the collector waits 260ms of quiet before attributing an
      // action, and the debounce has to fit inside that. At 150ms the report
      // arrived after the NEXT action's click and was attributed to it.
      clearTimeout(debounce[id]);
      debounce[id] = setTimeout(function () {
        report('action', {
          type: 'input',
          bench: id,
          label: labelOf(el),
          value: el.value,
        });
      }, 100);
    },
    true,
  );

  window.bench = {
    register: function (fn) {
      stateFn = fn;
      report('load', {});
    },
    report: report,
  };
})();
