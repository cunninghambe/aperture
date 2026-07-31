/**
 * The in-page walker.
 *
 * Runs in the preload's isolated world, so page JavaScript can neither see nor
 * redefine any of it. Produces the semantic tree the rest of the snapshot
 * subsystem consumes.
 *
 * Why walk the DOM ourselves instead of asking CDP for
 * `Accessibility.getFullAXTree`:
 *
 *   1. Incrementality. A MutationObserver tells us which subtrees are dirty,
 *      so re-snapshot cost scales with how much *changed*, not with page size.
 *      getFullAXTree has no incremental mode and forces a full a11y computation
 *      in the renderer on every call.
 *   2. Geometry and live values. We need rects, scroll offsets, viewport
 *      intersection and current input values; the AX tree omits or buries them.
 *   3. Identity. Computing identity keys needs DOM-side attributes
 *      (data-testid, name, id) that the AX tree does not carry.
 *
 * The cost is that we reimplement role and accessible-name computation. That is
 * an accepted trade: the agent needs operational semantics, not WCAG-audit
 * fidelity.
 */

import type { Rect, Role, SnapshotNode, StateBits } from './types.js';
import { State } from './types.js';

const MAX_NAME = 80;
const MAX_DEPTH = 60;

export interface WalkResult {
  root: SnapshotNode;
  url: string;
  title: string;
  viewport: { top: number; height: number; docHeight: number };
  modalKey?: string;
}

export interface WalkContext {
  frameId: number;
  doc: Document;
  win: Window;
  /**
   * Populated with identity key → live element as the walk proceeds, so the
   * main process can later act on a node without us having to mutate the page.
   *
   * Playwright stamps `aria-ref` attributes onto the DOM to solve this.
   * Keeping the index here instead means the page cannot see that it is being
   * observed, and we leave no attributes behind for a site to fingerprint or
   * for a hostile page to forge.
   */
  index?: Map<string, HTMLElement>;
}

/** Roles that get a ref, because an agent can address them. */
const ADDRESSABLE = new Set<Role>([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'slider', 'tab', 'menuitem', 'option', 'iframe', 'scrollable', 'dialog',
  'list', 'table', 'form', 'region', 'nav', 'main', 'banner', 'contentinfo',
]);

/**
 * Ref discipline is where the tokens are. Playwright MCP puts ~789 refs on a
 * GitHub page; a disciplined pass puts ~245 on the same page, and the output
 * is 4.5x smaller. Everything not in ADDRESSABLE stays unref'd until a diff
 * needs to name it.
 */

export function walk(ctx: WalkContext): WalkResult {
  const { doc, win } = ctx;
  const root: SnapshotNode = {
    role: 'generic',
    key: 'root',
    states: 0,
    frameId: ctx.frameId,
    rect: [0, 0, 0, 0],
    children: [],
  };

  const body = doc.body;
  if (body) {
    for (const child of Array.from(body.children)) {
      const n = visit(child as HTMLElement, ctx, 0, []);
      if (n) root.children.push(n);
    }
  }

  const modal = findModal(doc, win);

  return {
    root,
    url: doc.location?.href ?? '',
    title: doc.title ?? '',
    viewport: {
      top: win.scrollY,
      height: win.innerHeight,
      docHeight: doc.documentElement?.scrollHeight ?? win.innerHeight,
    },
    modalKey: modal ?? undefined,
  };
}

function visit(
  el: HTMLElement,
  ctx: WalkContext,
  depth: number,
  ancestry: string[],
): SnapshotNode | null {
  if (depth > MAX_DEPTH) return null;
  if (!isRendered(el, ctx.win)) return null;

  const role = roleOf(el);
  const name = accessibleName(el);

  const kids: SnapshotNode[] = [];
  const nextAncestry = isSemanticContainer(role)
    ? [...ancestry, `${role}${name ? `:${norm(name)}` : ''}`]
    : ancestry;

  // Shadow roots are pierced silently. A shadow boundary is an implementation
  // detail of the page; it has no bearing on what the agent can do.
  const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  const childSource: Element[] = shadow
    ? Array.from(shadow.children)
    : Array.from(el.children);

  for (const c of childSource) {
    const n = visit(c as HTMLElement, ctx, depth + 1, nextAncestry);
    if (n) kids.push(n);
  }

  const ownText = directText(el);

  // Presentational wrappers are the bulk of a modern page. A div with no role,
  // no name, no handler and one child contributes nothing an agent can use, so
  // the child is promoted in its place. Chains of them vanish entirely — this
  // single rule removes 60-80% of nodes on a typical page.
  if (role === 'generic' && !name && !ownText && !isInteractive(el)) {
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0]!;
  }

  const rect = rectOf(el);
  const key = identityKey(el, role, name, ancestry, ctx.frameId);
  if (ctx.index && ADDRESSABLE.has(role)) ctx.index.set(key, el);

  const node: SnapshotNode = {
    role,
    key,
    states: statesOf(el, ctx.win, rect),
    frameId: ctx.frameId,
    rect,
    children: kids,
  };

  if (name) node.name = name;
  if (ownText) node.text = truncate(ownText);

  const level = headingLevel(el);
  if (level) node.headingLevel = level;

  const href = hrefOf(el);
  if (href) node.href = href;

  const value = valueOf(el);
  if (value !== undefined) node.value = value;

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    const ac = el.getAttribute('autocomplete');
    if (ac && ac !== 'off') node.autocomplete = ac;
    if (el instanceof HTMLInputElement) node.inputType = el.type.toLowerCase();
  }

  if (el instanceof HTMLSelectElement) {
    // Enumerating 51 US states costs more than telling the agent there are 51.
    if (el.options.length <= 4) {
      node.children = Array.from(el.options).map((o) => ({
        role: 'option' as Role,
        name: o.text,
        key: `${node.key}|opt|${o.value}`,
        states: o.selected ? State.Selected : 0,
        frameId: ctx.frameId,
        rect,
        children: [],
      }));
    } else {
      node.optionCount = el.options.length;
    }
  }

  if (el instanceof HTMLTableElement) {
    const rows = tableRows(el);
    if (rows.length) {
      node.rows = rows;
      node.dims = { rows: rows.length, cols: rows[0]?.length ?? 0 };
      node.children = [];
    }
  }

  if (isScrollable(el)) {
    node.scroll = { top: el.scrollTop, height: el.scrollHeight };
  }

  node.shape = shapeHash(node);
  return node;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The identity key decides whether `e42` still means the same button after a
 * re-render replaced every DOM node on the page.
 *
 * Tier 1 uses handles the page author gave us on purpose. Tier 2 falls back to
 * semantics plus *semantic* position — the roles of meaningful ancestors only,
 * never generic wrappers, so div-soup churn doesn't break identity. The anchor
 * (nearest named ancestor) is what tells ten identical "Add to cart" buttons
 * apart: each one is anchored by its own product card's heading.
 */
export function identityKey(
  el: HTMLElement,
  role: Role,
  name: string | undefined,
  ancestry: string[],
  frameId: number,
): string {
  const testid =
    el.getAttribute('data-testid') ??
    el.getAttribute('data-test') ??
    el.getAttribute('data-qa') ??
    el.getAttribute('data-cy');
  if (testid) return `T|${frameId}|${role}|${testid}`;

  const nameAttr = el.getAttribute('name');
  if (nameAttr && isFormControl(role)) return `N|${frameId}|${role}|${nameAttr}`;

  const id = el.id;
  if (id && !looksGenerated(id)) return `I|${frameId}|${role}|${id}`;

  const anchor = ancestry.length ? ancestry[ancestry.length - 1]! : '';
  const path = ancestry.join('>');
  return `S|${frameId}|${role}|${norm(name ?? '')}|${anchor}|${path}`;
}

/**
 * Framework-generated ids change on every render, so keying on them would make
 * every ref unstable — exactly the failure mode we exist to avoid.
 */
export function looksGenerated(id: string): boolean {
  if (/^:[a-z0-9]+:$/i.test(id)) return true;           // React useId, ":r1:"
  if (/^(ember|radix-|mui-|rc[-_]|headlessui-)/i.test(id)) return true;
  if (/[0-9a-f]{8,}/i.test(id)) return true;            // embedded hashes
  if (/_{1,2}[A-Za-z0-9]{5,}$/.test(id)) return true;   // CSS-modules suffix
  const digits = (id.match(/\d/g) ?? []).length;
  return id.length > 0 && digits / id.length > 0.4;
}

function isFormControl(role: Role): boolean {
  return (
    role === 'textbox' || role === 'searchbox' || role === 'combobox' ||
    role === 'checkbox' || role === 'radio' || role === 'slider'
  );
}

function isSemanticContainer(role: Role): boolean {
  return (
    role === 'main' || role === 'nav' || role === 'banner' || role === 'form' ||
    role === 'dialog' || role === 'list' || role === 'listitem' ||
    role === 'table' || role === 'region' || role === 'contentinfo' ||
    role === 'tabpanel' || role === 'group'
  );
}

// ---------------------------------------------------------------------------
// Roles and names
// ---------------------------------------------------------------------------

const TAG_ROLES: Record<string, Role> = {
  A: 'link', BUTTON: 'button', NAV: 'nav', MAIN: 'main', HEADER: 'banner',
  FOOTER: 'contentinfo', FORM: 'form', TABLE: 'table', UL: 'list', OL: 'list',
  LI: 'listitem', IMG: 'img', IFRAME: 'iframe', SELECT: 'combobox',
  TEXTAREA: 'textbox', DIALOG: 'dialog', SECTION: 'region', ARTICLE: 'region',
  H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading',
  H6: 'heading', SUMMARY: 'button', OPTION: 'option',
};

export function roleOf(el: HTMLElement): Role {
  const explicit = el.getAttribute('role');
  if (explicit) {
    const r = explicit.split(/\s+/)[0]!.toLowerCase();
    if (isKnownRole(r)) return r as Role;
  }

  if (el instanceof HTMLInputElement) {
    const t = el.type.toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'range') return 'slider';
    if (t === 'search') return 'searchbox';
    if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
    if (t === 'hidden') return 'generic';
    return 'textbox';
  }

  if (el.isContentEditable) return 'textbox';

  const byTag = TAG_ROLES[el.tagName];
  if (byTag) {
    // A link without an href is not navigable, so calling it a link would
    // promise the agent something it cannot do.
    if (byTag === 'link' && !el.getAttribute('href')) return 'generic';
    return byTag;
  }

  if (isScrollable(el)) return 'scrollable';
  return 'generic';
}

const KNOWN_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'slider', 'list', 'listitem', 'table', 'row', 'dialog', 'form', 'img',
  'iframe', 'heading', 'banner', 'nav', 'main', 'contentinfo', 'region',
  'group', 'scrollable', 'text', 'tab', 'tabpanel', 'menu', 'menuitem',
  'option', 'generic',
]);

function isKnownRole(r: string): boolean {
  return KNOWN_ROLES.has(r);
}

/**
 * Accessible name, following the precedence the W3C spec defines, in the order
 * that matters in practice. Not a complete implementation of accname — it is
 * the subset that determines what an agent can recognize an element by.
 */
export function accessibleName(el: HTMLElement): string | undefined {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .filter(Boolean);
    if (parts.length) return truncate(parts.join(' '));
  }

  const label = el.getAttribute('aria-label');
  if (label?.trim()) return truncate(label);

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const t = Array.from(labels).map((l) => l.textContent ?? '').join(' ');
      if (t.trim()) return truncate(t);
    }
    const ph = el.getAttribute('placeholder');
    if (ph?.trim()) return truncate(ph);
  }

  if (el instanceof HTMLImageElement) {
    const alt = el.getAttribute('alt');
    return alt?.trim() ? truncate(alt) : undefined;
  }

  // textContent before title, per the spec's precedence.
  const text = (el.textContent ?? '').trim();
  if (text && text.length <= 200) return truncate(text);

  const title = el.getAttribute('title');
  if (title?.trim()) return truncate(title);

  return undefined;
}

// ---------------------------------------------------------------------------
// State and geometry
// ---------------------------------------------------------------------------

function statesOf(el: HTMLElement, win: Window, rect: Rect): StateBits {
  let s = 0;
  const aria = (n: string): string | null => el.getAttribute(`aria-${n}`);

  if (
    (el as HTMLInputElement).checked === true ||
    aria('checked') === 'true'
  ) s |= State.Checked;
  if ((el as HTMLInputElement).disabled === true || aria('disabled') === 'true') {
    s |= State.Disabled;
  }
  if (aria('expanded') === 'true') s |= State.Expanded;
  if (aria('selected') === 'true' || (el as HTMLOptionElement).selected === true) {
    s |= State.Selected;
  }
  if ((el as HTMLInputElement).required === true || aria('required') === 'true') {
    s |= State.Required;
  }
  if (aria('invalid') === 'true') s |= State.Invalid;
  if ((el as HTMLInputElement).readOnly === true) s |= State.Readonly;
  if (aria('modal') === 'true') s |= State.Modal;
  if (el.ownerDocument.activeElement === el) s |= State.Focused;

  const inView = rect[1] < win.innerHeight && rect[1] + rect[3] > 0;
  if (!inView) s |= State.Offscreen;

  return s;
}

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
}

function isRendered(el: HTMLElement, win: Window): boolean {
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' ||
      tag === 'NOSCRIPT' || tag === 'META' || tag === 'LINK') return false;

  // A <label> bound to a control contributes nothing: the control already
  // carries that text as its accessible name, so emitting the label too
  // doubles the line count of every form on the web.
  if (el instanceof HTMLLabelElement && el.control) return false;

  const cs = win.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  if (cs.opacity === '0') return false;
  return true;
}

function isScrollable(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight + 8) return false;
  const overflow = el.ownerDocument.defaultView
    ?.getComputedStyle(el).overflowY;
  return overflow === 'auto' || overflow === 'scroll';
}

function isInteractive(el: HTMLElement): boolean {
  if (el.hasAttribute('onclick')) return true;
  if (el.tabIndex >= 0) return true;
  const role = el.getAttribute('role');
  return role === 'button' || role === 'link';
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/** Text belonging to this element itself, not to its element children. */
function directText(el: HTMLElement): string | undefined {
  let out = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) out += n.nodeValue ?? '';
  }
  const t = out.replace(/\s+/g, ' ').trim();
  return t || undefined;
}

function hrefOf(el: HTMLElement): string | undefined {
  if (!(el instanceof HTMLAnchorElement)) return undefined;
  const raw = el.getAttribute('href');
  if (!raw) return undefined;
  try {
    const u = new URL(raw, el.ownerDocument.location?.href);
    // Origin is already on the page line, so path-only is enough and much
    // cheaper across a results page with 50 links.
    let s = u.pathname + (u.search.length <= 40 ? u.search : '?…');
    if (u.origin !== el.ownerDocument.location?.origin) s = u.origin + s;
    return sanitizeHref(s);
  } catch {
    // The parse-failure path returned the raw attribute, newlines intact —
    // and href is rendered UNQUOTED, so `href="//[<newline>FULL SNAPSHOT #9"`
    // forged a snapshot reset header at column 0. Anchors chain, so this gave
    // a page arbitrary multi-line control of the rendered snapshot.
    return sanitizeHref(raw);
  }
}

/**
 * hrefs are rendered unquoted, so nothing that could start a new line — or be
 * treated as one by a downstream tokenizer — may survive.
 */
function sanitizeHref(s: string): string {
  return s.replace(/[\s\u0000-\u001f\u0085\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, '').slice(0, 60);
}

function valueOf(el: HTMLElement): string | undefined {
  if (el instanceof HTMLInputElement) {
    const t = el.type.toLowerCase();
    if (t === 'checkbox' || t === 'radio' || t === 'submit' || t === 'button') {
      return undefined;
    }
    // Password values never leave the page. Not even their length, which is
    // itself a useful hint to an attacker.
    if (t === 'password') return el.value ? '••••••' : '';
    return truncate(el.value);
  }
  if (el instanceof HTMLTextAreaElement) return truncate(el.value);
  if (el instanceof HTMLSelectElement) {
    return el.selectedOptions[0]?.text ?? '';
  }
  return undefined;
}

function headingLevel(el: HTMLElement): 1 | 2 | 3 | 4 | 5 | 6 | undefined {
  const m = /^H([1-6])$/.exec(el.tagName);
  if (m) return Number(m[1]) as 1 | 2 | 3 | 4 | 5 | 6;
  const aria = el.getAttribute('aria-level');
  if (aria) {
    const n = Number(aria);
    if (n >= 1 && n <= 6) return n as 1 | 2 | 3 | 4 | 5 | 6;
  }
  return undefined;
}

function tableRows(t: HTMLTableElement): string[][] {
  const out: string[][] = [];
  for (const row of Array.from(t.rows).slice(0, 50)) {
    out.push(
      Array.from(row.cells).map((c) =>
        truncate((c.textContent ?? '').replace(/\s+/g, ' ').trim()),
      ),
    );
  }
  return out;
}

/**
 * A hash over child roles, ignoring text. Runs of siblings sharing a shape are
 * what let the renderer say "…21 more listitems (same shape)" instead of
 * emitting all of them.
 */
export function shapeHash(n: SnapshotNode): string {
  return n.children.map((c) => c.role).join(',');
}

/**
 * Find a modal that is obscuring the page. Without this an agent happily
 * clicks "through" a cookie banner at an element it cannot actually reach.
 */
function findModal(doc: Document, win: Window): string | null {
  const candidates = doc.querySelectorAll<HTMLElement>(
    '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]',
  );
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  for (const el of Array.from(candidates)) {
    const r = el.getBoundingClientRect();
    if (r.width * r.height > vw * vh * 0.15) {
      return el.id || el.getAttribute('aria-label') || 'modal';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
}

function truncate(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_NAME ? `${t.slice(0, MAX_NAME - 1)}…` : t;
}
