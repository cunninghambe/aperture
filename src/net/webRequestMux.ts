import type { OnBeforeSendHeadersListenerDetails, Session } from 'electron';

/**
 * THE ONE `onBeforeSendHeaders` REGISTRATION IN THIS CODEBASE.
 *
 * Electron keeps ONE listener per event per session: `webRequest.onBeforeSendHeaders`
 * is a setter, not a subscription, so a second registrant silently EVICTS the
 * first. No error, no warning, no log — the previous handler simply stops being
 * called. That is verification-queue item #4 in `docs/design/security.md`, and
 * this module closes it by construction rather than by answering it: there is
 * one call site in `src/`, `test/botauth.test.ts` asserts there is one
 * receiver-independently, and every future registrant walks through
 * `registerBeforeSendHeaders` instead.
 *
 * Read from the installed package rather than assumed: Ghostery's blocker
 * registers `onBeforeRequest` and `onHeadersReceived` and nothing else, so this
 * event is unclaimed today and there is no eviction interaction to reason
 * about. The mux is what keeps that sentence true tomorrow, when somebody adds
 * a second thing that wants a request header.
 *
 * ---------------------------------------------------------------------------
 * ADDITIVE-ONLY, AND IT IS STRUCTURAL RATHER THAN A CONTRACT
 * ---------------------------------------------------------------------------
 *
 * A handler does not receive the header object. It receives a frozen view of
 * the request and RETURNS the headers it wants added; the mux merges them and
 * refuses any name that is already present. So "a mux handler may add headers,
 * never delete or replace one" is not a rule a handler could break by
 * forgetting it — there is no expression a handler can write that removes a
 * header, because it never holds the map that has them.
 *
 * WHY additive-only at all: §8.2 of `docs/design/webbotauth.md`. Signing must
 * not vary any fingerprint surface, and the cheapest way for that to go wrong
 * is a handler that "tidies" a header on its way past. Blocking and cancelling
 * belong to `onBeforeRequest`, which is Ghostery's and stays library-internal.
 *
 * The residual this does NOT close, stated because it is queue #7: whether
 * Chromium re-serializes header ORDER or CASING once a listener returns a
 * modified `requestHeaders` object at all. That is a property of returning
 * anything, not of what we return, and it is measured at implementation rather
 * than assumed. Note the mux returns the headers UNCHANGED when no handler
 * contributes, which keeps the no-op path as close to the no-listener path as
 * an installed listener can be.
 */

/** The read-only view of a request a mux handler is given. */
export interface MuxRequest {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly webContentsId: number | undefined;
  /** Header names lowercased. A COPY — a handler cannot reach the real map. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A handler: given a request, the headers it wants ADDED, or null for none.
 *
 * Synchronous on purpose. `onBeforeSendHeaders` sits on the critical path of
 * every request in the browser, and a handler that awaits anything stalls
 * navigation for as long as it takes. The signing path does no I/O and no key
 * generation — keys exist before the first request, by §5's lifecycle — so
 * nothing here needs to be async, and making it async would invite something
 * that does.
 */
export type BeforeSendHeadersHandler = (req: MuxRequest) => Record<string, string> | null;

interface Registration {
  id: string;
  handler: BeforeSendHeadersHandler;
}

/**
 * Module-level, so registration is independent of which sessions exist.
 *
 * Containers are created lazily (`containers.sessionFor`), so a registrant that
 * had to name a session would have to know about container lifecycle. Handlers
 * are held here and every session installed at any time runs all of them, in
 * REGISTRATION ORDER — which is deterministic and is the order the list is in,
 * not a map iteration that could change.
 */
const registrations: Registration[] = [];

/** Sessions already carrying the mux, so a second install is a no-op. */
const installed = new WeakSet<Session>();

/**
 * Register a handler. Later registrants run later.
 *
 * A duplicate id throws rather than replacing: two registrants under one name
 * is the eviction bug this module exists to prevent, one layer up.
 */
export function registerBeforeSendHeaders(id: string, handler: BeforeSendHeadersHandler): void {
  if (registrations.some((r) => r.id === id)) {
    throw new Error(`webRequestMux: a handler is already registered as "${id}"`);
  }
  registrations.push({ id, handler });
}

/**
 * Install the mux on one container session.
 *
 * Called from `containers.harden()`, which runs exactly once per container
 * session in `sessionFor` — the `will-download` precedent, and the reason
 * per-session-once is the right idempotence: a session is created once per
 * container, so this cannot double-register as tabs come and go, and there is
 * no tab whose requests it misses.
 *
 * ON THE CONTAINER SESSION, NOT `session.defaultSession`. Every tab is created
 * on a container session; the default session carries only the two trusted
 * windows (E5). Installing there instead would leave every unit test green, the
 * wiring plausible, and NO header anywhere on the wire — which is precisely
 * G33a's second sabotage row.
 */
export function installMux(s: Session): void {
  if (installed.has(s)) return;
  installed.add(s);

  s.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    const additions = collect(details);
    if (additions === null) {
      callback({ requestHeaders: headers });
      return;
    }
    callback({ requestHeaders: { ...headers, ...additions } });
  });
}

/**
 * Run every handler and merge what they ask for, refusing anything that is not
 * strictly additive.
 *
 * A handler that returns a header already present — from the request or from an
 * earlier handler — has its contribution DROPPED and the drop is logged. It is
 * not an exception: this runs on every request in the browser, and a throw here
 * would take navigation down. It is not silent either, because a silently
 * dropped signature header is a feature that is off in a way nothing observes.
 */
function collect(details: OnBeforeSendHeadersListenerDetails): Record<string, string> | null {
  if (registrations.length === 0) return null;

  const lower = new Set(Object.keys(details.requestHeaders).map((k) => k.toLowerCase()));
  const req: MuxRequest = Object.freeze({
    url: details.url,
    method: details.method,
    resourceType: details.resourceType,
    webContentsId: details.webContentsId,
    headers: Object.freeze(
      Object.fromEntries(
        Object.entries(details.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    ),
  });

  let additions: Record<string, string> | null = null;
  for (const { id, handler } of registrations) {
    let produced: Record<string, string> | null;
    try {
      produced = handler(req);
    } catch (err) {
      // A handler that throws must not take the request with it. The request
      // goes out unsigned, which is the safe direction for every handler this
      // module will ever carry: adding a header is an assertion, and failing to
      // make an assertion is never worse than making a wrong one.
      console.error(
        `[aperture] webRequestMux: handler "${id}" threw; request sent unmodified ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    if (!produced) continue;
    for (const [name, value] of Object.entries(produced)) {
      const key = name.toLowerCase();
      if (lower.has(key)) {
        console.error(
          `[aperture] webRequestMux: handler "${id}" tried to replace header "${name}"; ` +
            'the mux is additive-only and the contribution was dropped',
        );
        continue;
      }
      lower.add(key);
      additions ??= {};
      additions[name] = value;
    }
  }
  return additions;
}

/** Test seam: how many handlers are registered. Never returns a handler. */
export function registeredHandlerIds(): string[] {
  return registrations.map((r) => r.id);
}
