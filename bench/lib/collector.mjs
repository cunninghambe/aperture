/**
 * The loopback witness collector.
 *
 * Ground truth for this benchmark is the fixture's own JavaScript, not the
 * snapshot pipeline — one half of that pipeline is the variable under test, and
 * this suite has already shipped two greens obtained by asking the thing under
 * test whether it worked. Everything scored downstream comes from here.
 */
import { createServer } from 'node:http';

export const COLLECTOR_PORT = 8898;

export async function startCollector(port = COLLECTOR_PORT) {
  /** @type {{at:number, seq:number, kind:string, detail:any, state:any, page:string}[]} */
  let events = [];

  const server = createServer((req, res) => {
    // The fixture posts cross-origin (page on :8899, collector on :8898). It
    // uses text/plain so the request stays a CORS "simple request" and never
    // preflights; these headers are belt to that braces.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        events.push({ at: Date.now(), ...parsed });
      } catch {
        // A malformed post is a bug in the fixture, not something to hide.
        events.push({ at: Date.now(), kind: 'malformed', raw: body.slice(0, 200) });
      }
      res.writeHead(204);
      res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port,
    reset() {
      events = [];
    },
    all() {
      return events.slice();
    },
    /** Interactions only — `load` is the baseline, not an action. */
    actions() {
      return dedupeActions(events.filter((e) => e.kind === 'action'));
    },
    /** Undeduplicated, for diagnosing the witness itself. */
    rawActions() {
      return events.filter((e) => e.kind === 'action');
    },
    /** The last state the PAGE reported. Undefined if it never spoke. */
    lastState() {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].state !== undefined) return events[i].state;
      }
      return undefined;
    },
    loaded() {
      return events.some((e) => e.kind === 'load');
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * One browser action, one counted action.
 *
 * Measured rather than assumed: one click on a checkbox produces BOTH a `click`
 * and an `input` event, and Aperture's `type` focuses the field first, so
 * typing produces a click and an input too. Counted raw, one wrong click on a
 * checkbox scores two wrong-element actions and one on a button scores one — a
 * metric whose units depend on what you hit.
 *
 * The rule folds ONLY an `input` that rides in on the back of a `click` to the
 * same element. The first version of this used a plain 500ms same-element
 * window and was wrong in a way the selftest caught immediately: consecutive
 * MCP round-trips land ~350ms apart, so `steppers-balance` had three deliberate
 * clicks on one button silently collapsed into one, and its seven real actions
 * printed as four. Two clicks are two clicks however fast they arrive.
 */
export function dedupeActions(list, windowMs = 2000) {
  const out = [];
  for (const e of list) {
    if (e.detail?.type !== 'input') {
      out.push(e);
      continue;
    }
    // An `input` folds onto the most recent earlier event for the SAME element,
    // searching backwards rather than looking only at the immediate predecessor.
    //
    // Measured, and the reason matters: the witness debounces typing, so an
    // input report routinely lands AFTER the next action's click —
    //   +0ms click search · +226ms click add:usb-c-cable-1m · +226ms input search
    // — and a rule that only inspects the previous event would never fold it.
    // The same interleaving is why the proxy picks its attribution event by
    // action kind instead of taking whatever arrived last.
    let target = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (e.at - out[i].at >= windowMs) break;
      if (out[i].detail?.bench !== e.detail?.bench) continue;
      if (out[i].detail?.type === 'click' || out[i].detail?.type === 'input') {
        target = i;
        break;
      }
    }
    if (target >= 0) out[target] = { ...e, at: out[target].at };
    else out.push(e);
  }
  return out;
}

/**
 * Wait until the collector has been quiet for `quietMs`, or `maxMs` elapses.
 * The witness debounces typing by 150ms, so reading state immediately after an
 * action can read it one event too early.
 */
export async function settle(collector, quietMs = 250, maxMs = 3000) {
  const start = Date.now();
  let last = collector.all().length;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    const n = collector.all().length;
    if (n !== last) {
      last = n;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
  }
}
