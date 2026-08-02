/**
 * The three NEUTRAL-LARGE fixtures, generated — the size-sweep precedent
 * (bench/size.mjs `--make-fixtures`), applied to headtohead.md §4.3.
 *
 * WHY GENERATED AND CHECKED IN. §4.2 rule 3 freezes fixture hashes before the
 * first scored episode; a fixture that is regenerated at run time has no hash
 * to freeze. So the generator is the authoring tool, its output is the
 * artifact, and `manifest.json` records which generator version and which
 * parameters produced which bytes. Regenerating with different parameters is a
 * FIXTURE EDIT and belongs in FIXTURE_CHANGELOG.md like any other.
 *
 * WHY THE BULK IS SEEDED AND HAS ITS OWN VOCABULARY. §4.2's size classes exist
 * because the cost question flips with page size, and §6's H5 has to be able to
 * assert that padding NEVER LEAKS INTO A DIFF — an assertion that needs the
 * padding to be recognisable. Every bulk string is drawn from `BULK_WORDS`,
 * invented tokens that appear nowhere in any prompt, label, predicate or
 * allowed id in either task set. If one of them ever shows up in a diff stream,
 * the diff restated something static and the large-class economics number is
 * measuring the wrong thing.
 *
 * WHAT THE BULK IS. Nav links, article links, product links, stat tables —
 * real page furniture, addressable (a real page carries hundreds of refs; HN
 * has 233), and STATIC. It appears in every pw re-dump and in zero Aperture
 * diffs. That asymmetry is not a thumb on the scale; it is the mechanism under
 * measurement, and it is exactly what a real page does.
 *
 *   node bench/headtohead/fixtures/make-fixtures.mjs
 *   node bench/headtohead/fixtures/make-fixtures.mjs --plan   (sizes only)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mulberry32 } from '../../lib/stats.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
export const GENERATOR_VERSION = '2026-08-02.1';

const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// The distinctive bulk vocabulary (H5's tracer dye)
// ---------------------------------------------------------------------------

/**
 * Invented, pure-ASCII, quote-free and backslash-free (both would change the
 * rendered length through the walker's escaping), and — checked by the linter —
 * absent from every task prompt, label, allowed id and predicate string in both
 * task sets. These words are the tracer dye: if H5 finds one in a diff, the
 * padding leaked.
 */
export const BULK_WORDS = [
  'Verrandel', 'Thoskil', 'Palverine', 'Oskomere', 'Fallowdyne', 'Questrel',
  'Marnwick', 'Draverly', 'Sablecourt', 'Hollowmere', 'Brambleton', 'Kestrenn',
  'Ondermill', 'Yarrowfen', 'Calverston', 'Rethingham', 'Wexbury', 'Tarnholt',
  'Merrowgate', 'Pellingsworth', 'Ashgrove', 'Windlecombe', 'Stonebeck',
  'Lambourne', 'Thicketwell', 'Gravensea', 'Orlingham', 'Pindarrow',
];

const BULK_TAILS = [
  'quarterly notes', 'field summary', 'coverage index', 'standing register',
  'annual digest', 'reference table', 'operations log', 'regional outline',
  'planning appendix', 'variance report', 'holdings list', 'schedule extract',
];

/**
 * Deterministic and GLOBALLY unique per fixture.
 *
 * The counter is the whole point. The first version derived the number from a
 * caller-supplied index, and two different call sites reached the same index —
 * so two bulk links ended up with the same accessible name and the linter's R1
 * fired. Caught twice, in two different generators, which is how a rule earns
 * the right to be enforced by a program instead of by care: uniqueness is now
 * a property of the counter, not of every call site remembering.
 *
 * `seed` still varies the WORDS; the trailing number makes the string unique.
 * Call order is deterministic, so regenerating produces identical bytes.
 */
let PHRASE_UID = 0;
function resetPhrases() {
  PHRASE_UID = 0;
}

function bulkPhrase(seed) {
  const n = ++PHRASE_UID;
  const rnd = mulberry32(seed + n * 2654435761);
  const w = BULK_WORDS[Math.floor(rnd() * BULK_WORDS.length)];
  const t = BULK_TAILS[Math.floor(rnd() * BULK_TAILS.length)];
  return `${w} ${t} ${n}`;
}

function bulkSentence(seed) {
  const n = ++PHRASE_UID;
  const rnd = mulberry32(seed ^ (n * 40503));
  const a = BULK_WORDS[Math.floor(rnd() * BULK_WORDS.length)];
  const b = BULK_WORDS[Math.floor(rnd() * BULK_WORDS.length)];
  const t = BULK_TAILS[Math.floor(rnd() * BULK_TAILS.length)];
  return `Paragraph ${n}. The ${a} ${t} was reconciled against the ${b} ledger and filed without amendment.`;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------------------------------------------------------------------------
// SHAPE HETEROGENEITY — measured, not stylistic
// ---------------------------------------------------------------------------

/**
 * Aperture's renderer collapses a run of FIVE OR MORE consecutive same-shape
 * siblings down to three plus `… N more listitems (link) — read e17`
 * (src/core/snapshot/render.ts, COLLAPSE_RUN = 5, COLLAPSE_SHOW = 3).
 *
 * The first version of this generator built 14 identical <section>s and 144
 * identical product rows, and the live H5 probe measured the result at 671–1267
 * snapshot tokens against §4.2's 5,000–9,500 band: the page was large in HTML
 * and small in the only unit the band is written in. Homogeneous bulk cannot
 * reach the band, because the product is designed not to let it.
 *
 * So the bulk CYCLES through several structural templates, which is also what
 * the real pages the band was measured on look like — RESULTS.md §A's Hacker
 * News landed at 9,512 tokens with 233 refs, which is only possible because its
 * rows are not all the same shape. Nothing here defeats the collapse; the
 * collapse simply does not fire on heterogeneous markup, which is the point.
 *
 * WHAT THIS MEANS FOR THE CLAIM, and it is a scope note the report owes the
 * reader: the neutral-large class therefore does NOT measure Aperture's
 * behaviour on a long homogeneous list, where the collapse is worth an order of
 * magnitude. That is a REAL Aperture advantage this benchmark deliberately does
 * not claim, because a fixture built on it would be measuring one feature, not
 * the observation channel.
 */
const SHAPE_PERIOD = 4;

/**
 * A run of small `<ul>`s separated by `<h3>`s. Two rules, both from
 * COLLAPSE_RUN: no list holds five items, and no five consecutive siblings are
 * the same shape (heading and list alternate, so every run is length one).
 */
function navBlock(L, pad, seed, groups, per, prefix, label) {
  L.push(`${pad}<nav aria-label="${label}">`);
  for (let g = 1; g <= groups; g++) {
    L.push(`${pad}  <h3>${bulkPhrase(seed + g * 17)}</h3>`);
    L.push(`${pad}  <ul>`);
    for (let i = 1; i <= per; i++) {
      const t = bulkPhrase(seed + g * 1000);
      L.push(`${pad}    <li><a href="${prefix}/${slug(t)}">${t}</a></li>`);
    }
    L.push(`${pad}  </ul>`);
  }
  L.push(`${pad}</nav>`);
}

/** One article section, in one of SHAPE_PERIOD structurally distinct shapes. */
function articleSection(L, pad, seed, i) {
  const shape = i % SHAPE_PERIOD;
  L.push(`${pad}<section>`);
  L.push(`${pad}  <h2>${bulkPhrase(seed + 100)}</h2>`);
  if (shape === 0) {
    L.push(`${pad}  <p>${bulkSentence(seed + 200)}</p>`);
    L.push(`${pad}  <p>${bulkSentence(seed + 200)}</p>`);
    L.push(`${pad}  <p>`);
    for (let k = 0; k < 3; k++) {
      const t = bulkPhrase(seed + 300);
      L.push(`${pad}    <a href="/ref/${slug(t)}">${t}</a>`);
    }
    L.push(`${pad}  </p>`);
  } else if (shape === 1) {
    L.push(`${pad}  <blockquote><p>${bulkSentence(seed + 210)}</p></blockquote>`);
    L.push(`${pad}  <p>${bulkSentence(seed + 210)}</p>`);
    L.push(`${pad}  <ul>`);
    for (let k = 0; k < 3; k++) {
      const t = bulkPhrase(seed + 310);
      L.push(`${pad}    <li><a href="/ref/${slug(t)}">${t}</a></li>`);
    }
    L.push(`${pad}  </ul>`);
  } else if (shape === 2) {
    L.push(`${pad}  <dl>`);
    for (let k = 0; k < 3; k++) {
      L.push(`${pad}    <dt>${bulkPhrase(seed + 320)}</dt>`);
      L.push(`${pad}    <dd>${bulkSentence(seed + 220)}</dd>`);
    }
    L.push(`${pad}  </dl>`);
    const t = bulkPhrase(seed + 330);
    L.push(`${pad}  <p><a href="/ref/${slug(t)}">${t}</a></p>`);
  } else {
    L.push(`${pad}  <p>${bulkSentence(seed + 230)}</p>`);
    L.push(`${pad}  <table>`);
    L.push(`${pad}    <tr><th>${bulkPhrase(seed + 340)}</th><th>${bulkPhrase(seed + 341)}</th></tr>`);
    for (let r = 0; r < 3; r++) {
      L.push(`${pad}    <tr><td>${bulkPhrase(seed + 350)}</td><td>${bulkPhrase(seed + 360)}</td></tr>`);
    }
    L.push(`${pad}  </table>`);
    const t2 = bulkPhrase(seed + 370);
    L.push(`${pad}  <p><a href="/ref/${slug(t2)}">${t2}</a></p>`);
  }
  L.push(`${pad}</section>`);
}

// ---------------------------------------------------------------------------
// Size plan — the tuning knobs, and the only thing a resize touches
// ---------------------------------------------------------------------------

/**
 * Target: §4.3's band, 5,000–9,500 Aperture snapshot tokens, aiming at the
 * middle (~7,000 tokens ≈ 28,000 chars at this repo's 4-chars-per-token rule).
 *
 * These counts are ANALYTIC. H5 measures the real untruncated Aperture full
 * snapshot and refuses the cohort if reality lands outside the band — the same
 * discipline the size sweep's P1 preflight uses, for the same reason: a
 * predicted size is a hypothesis.
 */
export const SIZE_PLAN = {
  'journal-comment': { navGroups: 5, navPerGroup: 4, sections: 26, footerGroups: 4, footerPerGroup: 4 },
  'console-quota': { navGroups: 12, navPerGroup: 4, tables: 8, rowsPerTable: 4, colsPerTable: 4, panels: 27 },
  'catalog-order': { navGroups: 3, navPerGroup: 4, categories: 8, productsPerCategory: 34 },
};

// ---------------------------------------------------------------------------
// T4 journal-comment
// ---------------------------------------------------------------------------

function journalComment(p) {
  resetPhrases();
  const L = [];
  const seed = 0x4a01;
  L.push('<!doctype html>');
  L.push('<html lang="en">');
  L.push('  <head>');
  L.push('    <meta charset="utf-8" />');
  L.push('    <title>The reconciliation of standing registers</title>');
  L.push('  </head>');
  L.push('  <!--');
  L.push('    T4 journal-comment - neutral large, content-grounded entry. GENERATED by');
  L.push('    make-fixtures.mjs; edit the generator, not this file. The byline is the');
  L.push('    answer to the name field, so the observation channel is load-bearing for');
  L.push('    the ANSWER and not only for the addressing. Everything between BULK:BEGIN');
  L.push('    and BULK:END is static padding drawn from the tracer vocabulary.');
  L.push('  -->');
  L.push('  <body>');
  L.push('    <header>');
  L.push('      <h1>The reconciliation of standing registers</h1>');
  L.push('      <p>By Carmen Reyes</p>');
  L.push('    </header>');

  L.push('    <!-- BULK:BEGIN -->');
  navBlock(L, '    ', seed, p.navGroups, p.navPerGroup, '/notes', 'Sections');
  L.push('    <!-- BULK:END -->');

  L.push('    <main>');
  L.push('      <article>');
  L.push('        <!-- BULK:BEGIN -->');
  for (let s = 1; s <= p.sections; s++) articleSection(L, '        ', seed, s);
  L.push('        <!-- BULK:END -->');
  L.push('      </article>');

  L.push('      <section id="comments">');
  L.push('        <h2>Leave a comment</h2>');
  L.push('        <form id="comment-form">');
  L.push('          <div>');
  L.push('            <label for="c-name">Your name</label>');
  L.push('            <input type="text" id="c-name" name="c-name" data-bench="c-name" />');
  L.push('          </div>');
  L.push('          <div>');
  L.push('            <label for="c-text">Your comment</label>');
  L.push('            <textarea id="c-text" name="c-text" data-bench="c-text"></textarea>');
  L.push('          </div>');
  L.push('          <fieldset>');
  L.push('            <legend>Rating</legend>');
  for (let r = 1; r <= 5; r++) {
    const name = r === 1 ? '1 star' : `${r} stars`;
    L.push('            <div>');
    L.push(`              <input type="radio" id="star-${r}" name="rating" value="${r}" data-bench="star-${r}" />`);
    L.push(`              <label for="star-${r}">${name}</label>`);
    L.push('            </div>');
  }
  L.push('          </fieldset>');
  L.push('          <button type="button" id="c-submit" data-bench="c-submit">Post comment</button>');
  L.push('        </form>');
  L.push('        <div id="c-panel"></div>');
  L.push('      </section>');
  L.push('    </main>');

  L.push('    <!-- BULK:BEGIN -->');
  L.push('    <footer>');
  navBlock(L, '      ', seed + 400, p.footerGroups, p.footerPerGroup, '/archive', 'Archive');
  L.push('    </footer>');
  L.push('    <!-- BULK:END -->');

  L.push('    <script src="/bench.js"></script>');
  L.push('    <script>');
  L.push('      var posted = null;');
  L.push('      var draft = { name: "", text: "", rating: 0 };');
  L.push('      document.getElementById("c-name").addEventListener("input", function (e) { draft.name = e.target.value; });');
  L.push('      document.getElementById("c-text").addEventListener("input", function (e) { draft.text = e.target.value; });');
  L.push('      for (var r = 1; r <= 5; r++) {');
  L.push('        (function (n) {');
  L.push('          document.getElementById("star-" + n).addEventListener("change", function (e) {');
  L.push('            if (e.target.checked) draft.rating = n;');
  L.push('          });');
  L.push('        })(r);');
  L.push('      }');
  L.push('      document.getElementById("c-submit").addEventListener("click", function () {');
  L.push('        posted = { name: draft.name, text: draft.text, rating: draft.rating };');
  L.push('        document.getElementById("comment-form").remove();');
  L.push('        var h = document.createElement("h3");');
  L.push('        h.textContent = "Comment posted";');
  L.push('        var p = document.createElement("p");');
  L.push('        p.textContent = posted.name + " rated this " + posted.rating + " of 5: " + posted.text;');
  L.push('        document.getElementById("c-panel").replaceChildren(h, p);');
  L.push('      });');
  L.push('      window.bench.register(function () { return { comment: posted }; });');
  L.push('    </script>');
  L.push('  </body>');
  L.push('</html>');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// T5 console-quota
// ---------------------------------------------------------------------------

function consoleQuota(p) {
  resetPhrases();
  const L = [];
  const seed = 0x5c02;
  L.push('<!doctype html>');
  L.push('<html lang="en">');
  L.push('  <head>');
  L.push('    <meta charset="utf-8" />');
  L.push('    <title>Console</title>');
  L.push('  </head>');
  L.push('  <!--');
  L.push('    T5 console-quota - neutral large, iterative adjustment. GENERATED.');
  L.push('    The economics probe: five acts on a page of realistic weight, where the');
  L.push('    re-dump arm restates the whole dashboard each time and the diff arm sends');
  L.push('    one line. The deciding string ($84) exists only in the FOURTH click\'s');
  L.push('    report, so no arm can read the answer out of the opening snapshot.');
  L.push('  -->');
  L.push('  <body>');
  L.push('    <!-- BULK:BEGIN -->');
  navBlock(L, '    ', seed, p.navGroups, p.navPerGroup, '/console', 'Console sections');
  L.push('    <!-- BULK:END -->');

  L.push('    <main>');
  L.push('      <h1>Console</h1>');

  L.push('      <section id="quota">');
  L.push('        <h2>Quota</h2>');
  L.push('        <p id="projection">Projected monthly cost: $36</p>');
  L.push('        <button type="button" id="inc-quota" data-bench="inc-quota">Increase quota</button>');
  L.push('        <button type="button" id="apply" data-bench="apply">Apply changes</button>');
  L.push('        <p role="status" id="quota-status">No changes applied.</p>');
  L.push('      </section>');

  L.push('      <!-- BULK:BEGIN -->');
  // Tables and panels are INTERLEAVED, and the panels cycle shape, so no five
  // consecutive siblings share a shape and nothing collapses. A console really
  // does look like this: a few tables among many differently-built cards.
  let table = 0;
  for (let i = 1; i <= p.panels; i++) {
    if (i % 3 === 0 && table < p.tables) {
      table++;
      L.push('      <section>');
      L.push(`        <h2>${bulkPhrase(seed + 100)}</h2>`);
      L.push('        <table>');
      L.push('          <thead>');
      L.push('            <tr>');
      for (let c = 1; c <= p.colsPerTable; c++) {
        L.push(`              <th>${BULK_WORDS[(table * 3 + c) % BULK_WORDS.length]} ${c}</th>`);
      }
      L.push('            </tr>');
      L.push('          </thead>');
      L.push('          <tbody>');
      for (let r = 1; r <= p.rowsPerTable; r++) {
        L.push('            <tr>');
        for (let c = 1; c <= p.colsPerTable; c++) {
          L.push(`              <td>${bulkPhrase(seed + 200 + table * 10)}</td>`);
        }
        L.push('            </tr>');
      }
      L.push('          </tbody>');
      L.push('        </table>');
      L.push('      </section>');
    } else {
      articleSection(L, '      ', seed + 900, i);
    }
  }
  L.push('      <!-- BULK:END -->');
  L.push('    </main>');

  L.push('    <script src="/bench.js"></script>');
  L.push('    <script>');
  L.push('      var projected = 36;');
  L.push('      var applied = false;');
  L.push('      document.getElementById("inc-quota").addEventListener("click", function () {');
  L.push('        projected += 12;');
  L.push('        document.getElementById("projection").textContent = "Projected monthly cost: $" + projected;');
  L.push('      });');
  L.push('      document.getElementById("apply").addEventListener("click", function () {');
  L.push('        applied = true;');
  L.push('        document.getElementById("quota-status").textContent = "Applied at $" + projected + " per month.";');
  L.push('      });');
  L.push('      window.bench.register(function () { return { projected: projected, applied: applied }; });');
  L.push('    </script>');
  L.push('  </body>');
  L.push('</html>');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// T6 catalog-order
// ---------------------------------------------------------------------------

/**
 * The one named product is `Meridian desk clock`, in `Homeware`. Every other
 * product name comes from the tracer vocabulary, so the target cannot be found
 * by looking for the only readable string — it has to be found by reading the
 * section it is in, which is what "locate-and-act" means.
 */
function catalogOrder(p) {
  resetPhrases();
  const L = [];
  const seed = 0x60a3;
  const CATEGORIES = [
    'Homeware', 'Stationery', 'Outdoor', 'Kitchen',
    'Lighting', 'Textiles', 'Storage', 'Workshop',
  ].slice(0, p.categories);

  L.push('<!doctype html>');
  L.push('<html lang="en">');
  L.push('  <head>');
  L.push('    <meta charset="utf-8" />');
  L.push('    <title>Catalogue</title>');
  L.push('  </head>');
  L.push('  <!--');
  L.push('    T6 catalog-order - neutral large, locate-and-act. GENERATED.');
  L.push('    Every product row is a link plus a uniquely named add button, which is');
  L.push('    what an ordinary storefront looks like and is also why the identical-');
  L.push('    sibling construction cannot form. Only the order widget mutates.');
  L.push('  -->');
  L.push('  <body>');
  L.push('    <!-- BULK:BEGIN -->');
  navBlock(L, '    ', seed, p.navGroups, p.navPerGroup, '/dept', 'Catalogue');
  L.push('    <!-- BULK:END -->');

  L.push('    <main>');
  L.push('      <h1>Catalogue</h1>');

  const products = [];
  // ONE GLOBAL COUNTER, not a per-category one. The first version seeded per
  // category and produced two products with the same name in different
  // sections — caught by the linter's R1 on the first run, which is exactly
  // what R1 is for: a duplicate name would have handed Aperture's ordinal
  // fallback a family the neutral set is supposed to be free of.
  let productIndex = 0;
  CATEGORIES.forEach((cat, ci) => {
    L.push('      <section>');
    L.push(`        <h2>${cat}</h2>`);
    L.push('        <ul>');
    for (let i = 1; i <= p.productsPerCategory; i++) {
      productIndex++;
      const isTarget = cat === 'Homeware' && i === 7;
      const name = isTarget ? 'Meridian desk clock' : bulkPhrase(seed + 500);
      const id = slug(name);
      products.push({ cat, name, id });
      // Rows CYCLE through four shapes — a badge here, a stock note there, a
      // second link on some. Ordinary storefront variation, and the reason the
      // renderer's five-in-a-row collapse never fires on this list.
      const shape = productIndex % SHAPE_PERIOD;
      L.push('          <li>');
      L.push(`            <a href="/p/${id}">${name}</a>`);
      if (shape === 1) L.push(`            <span>${bulkPhrase(seed + 700)}</span>`);
      if (shape === 2) {
        L.push(`            <em>In stock</em>`);
        L.push(`            <a href="/p/${id}/details">More about ${name}</a>`);
      }
      L.push(`            <button type="button" data-bench="add:${id}">Add ${name} to order</button>`);
      if (shape === 3) L.push(`            <span>${bulkPhrase(seed + 800)}</span>`);
      L.push('          </li>');
    }
    L.push('        </ul>');
    L.push('      </section>');
  });

  L.push('      <section id="order-widget">');
  L.push('        <h2>Order</h2>');
  L.push('        <ul id="order-list"></ul>');
  L.push('        <p role="status" id="order-status">Order is empty.</p>');
  L.push('        <button type="button" id="place-order" data-bench="place-order">Place order</button>');
  L.push('      </section>');
  L.push('    </main>');

  L.push('    <script src="/bench.js"></script>');
  L.push('    <script>');
  L.push('      var order = [];');
  L.push('      var placed = false;');
  L.push('      var NAMES = ' + JSON.stringify(Object.fromEntries(products.map((x) => [x.id, x.name]))) + ';');
  L.push('      function entry(id) { for (var i = 0; i < order.length; i++) if (order[i].item === id) return order[i]; return null; }');
  L.push('      function renderOrder() {');
  L.push('        var ul = document.getElementById("order-list");');
  L.push('        var kids = order.map(function (o) {');
  L.push('          var li = document.createElement("li");');
  L.push('          var span = document.createElement("span");');
  L.push('          span.textContent = NAMES[o.item] + " qty " + o.qty;');
  L.push('          li.append(span);');
  L.push('          var inc = document.createElement("button");');
  L.push('          inc.type = "button";');
  L.push('          inc.setAttribute("data-bench", "qty-inc:" + o.item);');
  L.push('          inc.textContent = "Increase " + NAMES[o.item] + " quantity";');
  L.push('          inc.addEventListener("click", function () { entry(o.item).qty += 1; renderOrder(); });');
  L.push('          li.append(inc);');
  L.push('          return li;');
  L.push('        });');
  L.push('        ul.replaceChildren.apply(ul, kids);');
  L.push('        document.getElementById("order-status").textContent = order.length');
  L.push('          ? "Order: " + order.map(function (o) { return NAMES[o.item] + " added, qty " + o.qty; }).join(", ")');
  L.push('          : "Order is empty.";');
  L.push('      }');
  L.push('      Array.prototype.forEach.call(document.querySelectorAll("[data-bench^=\\"add:\\"]"), function (b) {');
  L.push('        var id = b.getAttribute("data-bench").slice(4);');
  L.push('        b.addEventListener("click", function () { if (!entry(id)) order.push({ item: id, qty: 1 }); renderOrder(); });');
  L.push('      });');
  L.push('      document.getElementById("place-order").addEventListener("click", function () {');
  L.push('        placed = true;');
  L.push('        document.getElementById("order-status").textContent = "Order placed.";');
  L.push('      });');
  L.push('      renderOrder();');
  L.push('      window.bench.register(function () {');
  L.push('        return { order: order.map(function (o) { return { item: o.item, qty: o.qty }; }), placed: placed };');
  L.push('      });');
  L.push('    </script>');
  L.push('  </body>');
  L.push('</html>');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------

const BUILDERS = {
  'journal-comment': journalComment,
  'console-quota': consoleQuota,
  'catalog-order': catalogOrder,
};

export function generateAll() {
  const out = {};
  for (const [id, params] of Object.entries(SIZE_PLAN)) out[id] = BUILDERS[id](params);
  return out;
}

export function manifestPath() {
  return join(DIR, 'manifest.json');
}

function main(argv) {
  const planOnly = argv.includes('--plan');
  const html = generateAll();
  const benchJs = readFileSync(join(DIR, 'bench.js'), 'utf8');

  const manifest = {
    generator: GENERATOR_VERSION,
    generatedAt: new Date().toISOString(),
    bulkWords: BULK_WORDS,
    sizePlan: SIZE_PLAN,
    witnessSha: sha16(benchJs),
    fixtures: [],
  };

  for (const [id, body] of Object.entries(html)) {
    const file = `${id}.html`;
    const refs = (body.match(/data-bench=|<a href=|<button/g) ?? []).length;
    manifest.fixtures.push({
      id,
      file,
      htmlBytes: Buffer.byteLength(body, 'utf8'),
      approxRefs: refs,
      sha: sha16(body),
      params: SIZE_PLAN[id],
    });
    if (!planOnly) writeFileSync(join(DIR, file), body, 'utf8');
    console.log(
      `  ${id.padEnd(18)} ${String(Buffer.byteLength(body, 'utf8')).padStart(7)} html bytes  ` +
        `~${String(refs).padStart(4)} addressable  sha ${sha16(body)}`,
    );
  }
  if (!planOnly) {
    writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`\nmanifest: ${manifestPath()}`);
  }
  console.log('\nHTML bytes are NOT snapshot tokens. H5 measures the untruncated Aperture');
  console.log('full snapshot live and refuses the cohort if it lands outside 5,000-9,500');
  console.log('tokens — a predicted size is a hypothesis (bench/size.mjs P1, same rule).');
  return 0;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '\\');
if (invokedDirectly || process.argv[1]?.endsWith('make-fixtures.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
