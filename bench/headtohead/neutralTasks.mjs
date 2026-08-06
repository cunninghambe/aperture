/**
 * The six NEUTRAL task specs, transcribed from headtohead.md §4.3.
 *
 * SPEC-BEFORE-FIXTURE IS THE WHOLE POINT (§4.2 rule 1). Prompt, predicate,
 * allowed set, solve script and size target were fixed in the design document
 * and committed BEFORE any of these six fixtures existed and before either
 * engine had ever loaded one. Git history is the proof, and this file is the
 * transcription — every field below is the spec's text, not an author's later
 * second thought. Where a fixture had to be authored to satisfy a spec regex
 * (T2's `mustObserve`), the FIXTURE moved, never the spec.
 *
 * `category` names the Mind2Web-style task shape (§4.2 rule 4): the shapes come
 * from a public taxonomy rather than from either engine's mechanics, which is
 * the part of neutrality that authorial intent cannot supply.
 *
 * Field semantics are bench/tasks.mjs's, unchanged, so one runner scores both
 * sets: `prompt` byte-identical across arms, `success` a predicate over the
 * FIXTURE's own reported state (never over a snapshot), `allowed` the
 * `data-bench` ids a correct solution may touch, `mustObserve` a regex the
 * arm's own observation stream must match, `solve` a deterministic
 * label-targeted script that must pass in EVERY arm before a token is spent.
 *
 * ONE FIELD IS NEW: `class`. The report never pools `neutral-small` with
 * `neutral-large`, because §0's cost question flips with page size and wave 1
 * measured a per-observation saving inverting into a per-dollar loss on small
 * pages. A single pooled economics number would hide exactly that.
 */

const click = (label) => ({ act: 'click', label });
const type = (label, text) => ({ act: 'type', label, text });

export const NEUTRAL_TASKS = [
  {
    id: 'booking-form',
    fixture: 'booking-form.html',
    class: 'neutral-small',
    category: 'form completion',
    prompt:
      'Book an appointment on this page. The name is Alex Morgan, the email address is ' +
      'alex.morgan@example.com, the phone number is 555-0142, the preferred slot is Afternoon, ' +
      'and ask for email confirmation. Then submit the booking.',
    maxSteps: 12,
    allowed: ['name', 'email', 'phone', 'slot-afternoon', 'confirm-email', 'submit'],
    // `notes` is a real free-text field and is deliberately NOT allowed: an
    // agent that fills it has acted on an element the task never asked for,
    // and that is what the wrong-element metric is for.
    success: (s) =>
      !!s &&
      s.submitted === true &&
      s.name === 'Alex Morgan' &&
      s.email === 'alex.morgan@example.com' &&
      s.phone === '555-0142' &&
      s.slot === 'afternoon' &&
      s.confirm === true,
    mustObserve: /Booking confirmed/,
    solve: [
      type('Full name', 'Alex Morgan'),
      type('Email address', 'alex.morgan@example.com'),
      type('Phone number', '555-0142'),
      click('Afternoon'),
      click('Send confirmation by email'),
      click('Book appointment'),
    ],
  },

  {
    id: 'inventory-pick',
    fixture: 'inventory-pick.html',
    class: 'neutral-small',
    category: 'filter / locate-and-pick',
    prompt:
      'Add the cheapest part in the Fasteners section to the requisition, then set its ' +
      'quantity to 3.',
    maxSteps: 10,
    allowed: ['add:hex-bolt', 'inc:hex-bolt'],
    success: (s) =>
      !!s &&
      Array.isArray(s.requisition) &&
      s.requisition.length === 1 &&
      s.requisition[0]?.part === 'hex-bolt' &&
      s.requisition[0]?.qty === 3,
    // §4.3's regex, unchanged. The fixture's status line was authored to
    // satisfy it — "Requisition: Hex bolt — qty 3" — because the spec is the
    // fixed point and the fixture is the thing being written to it.
    mustObserve: /Hex bolt.*qty 3|quantity 3/,
    solve: [
      click('Add hex bolt to requisition'),
      click('Increase hex bolt quantity'),
      click('Increase hex bolt quantity'),
    ],
    // §4.3 records this on purpose: ten same-shape rows may run-collapse in
    // Aperture's initial full snapshot. That is Aperture's shipped behaviour on
    // conventional markup, and if it costs an expand round-trip, the cost is
    // real and belongs in the number.
    note: 'ten same-shape rows may run-collapse in the initial full snapshot; any expand round-trip is a real cost',
  },

  {
    id: 'account-prefs',
    fixture: 'account-prefs.html',
    class: 'neutral-small',
    category: 'dependent controls',
    prompt:
      'Enable notifications, choose SMS delivery, set the digest frequency to weekly, and save ' +
      'the changes.',
    maxSteps: 10,
    allowed: ['notifications', 'method-sms', 'frequency', 'save'],
    // Unsaved edits are not state: the witness reports the SAVED object, so a
    // run that sets every control and never presses Save scores false. That is
    // the dependent-controls shape doing its job.
    //
    // CASE-NORMALISED AT THE PREDICATE (h2h obligation 6; harness-debt.md WO-A4).
    // The page's select reports `Weekly`, so `=== 'weekly'` failed a task every
    // arm had completed — a fixture defect that read as a capability finding
    // until it was struck by hand (h2h-evaluation §0.4), and that came within a
    // three-ground sub-ruling of firing tier5's economics-failure clause
    // literally (h2h-post-tier5-evaluation §1.3).
    //
    // Normalised HERE and not in the fixture's state fn — a deliberate deviation
    // from h2h-evaluation §8.3's parenthetical — so the witness keeps recording
    // the raw page state and the tolerance stays visible at the point where the
    // judgment is made. Same effect, better evidence trail.
    //
    // The other five neutral predicates are deliberately NOT touched: only this
    // one is ruled. Inspection found no sibling of this class among them (the
    // rest compare booleans, numbers, or strings the agent types itself rather
    // than strings the page chooses).
    success: (s) =>
      !!s && s.notifications === true && s.method === 'sms' &&
      String(s.frequency).toLowerCase() === 'weekly',
    mustObserve: /SMS|Digest frequency/,
    solve: [
      click('Enable notifications'),
      click('SMS'),
      type('Digest frequency', 'weekly'),
      click('Save changes'),
    ],
  },

  {
    id: 'journal-comment',
    fixture: 'journal-comment.html',
    class: 'neutral-large',
    category: 'content-grounded entry',
    prompt:
      'Post a comment on this article: the name field should be the article author\'s name as ' +
      'shown in the byline, the comment text is "Insightful piece.", give it a 4-star rating, ' +
      'and submit.',
    maxSteps: 12,
    allowed: ['c-name', 'c-text', 'star-4', 'c-submit'],
    // The byline forces the agent to OBSERVE page content, not just target
    // controls: the observation channel is load-bearing for the ANSWER, not
    // only for the addressing. That is the one thing a pure control-targeting
    // task cannot test, and it is why this task is in the set.
    success: (s) =>
      !!s &&
      !!s.comment &&
      s.comment.name === 'Carmen Reyes' &&
      s.comment.text === 'Insightful piece.' &&
      s.comment.rating === 4,
    mustObserve: /Comment posted/,
    solve: [
      type('Your name', 'Carmen Reyes'),
      type('Your comment', 'Insightful piece.'),
      click('4 stars'),
      click('Post comment'),
    ],
  },

  {
    id: 'console-quota',
    fixture: 'console-quota.html',
    class: 'neutral-large',
    category: 'iterative adjustment',
    prompt:
      'Increase the API quota until the projected monthly cost shown reaches exactly $84, then ' +
      'apply the changes.',
    maxSteps: 12,
    allowed: ['inc-quota', 'apply'],
    success: (s) => !!s && s.applied === true && s.projected === 84,
    // $36 + 4 x $12. The string exists only in the FOURTH click's report, so
    // the deciding information provably travels through the observation
    // channel rather than sitting in the opening snapshot where both arms get
    // it free.
    mustObserve: /\$84/,
    solve: [
      click('Increase quota'),
      click('Increase quota'),
      click('Increase quota'),
      click('Increase quota'),
      click('Apply changes'),
    ],
    // §4.3's WHY, kept with the task: five acts on a 7k-token page is where
    // re-dump economics compound. This is the cleanest single measurement of
    // the product's pitch on realistic weight.
    note: 'the economics probe: five acts on a ~7k-token page',
  },

  {
    id: 'catalog-order',
    fixture: 'catalog-order.html',
    class: 'neutral-large',
    category: 'locate-and-act, multi-step',
    prompt:
      'Find the product called "Meridian desk clock" in the Homeware section, add it to the ' +
      'order, set the quantity to 2, and place the order.',
    maxSteps: 12,
    allowed: ['add:meridian-desk-clock', 'qty-inc:meridian-desk-clock', 'place-order'],
    success: (s) =>
      !!s &&
      s.placed === true &&
      Array.isArray(s.order) &&
      s.order.length === 1 &&
      s.order[0]?.item === 'meridian-desk-clock' &&
      s.order[0]?.qty === 2,
    mustObserve: /Meridian desk clock.*(added|qty 2)/,
    solve: [
      click('Add Meridian desk clock to order'),
      click('Increase Meridian desk clock quantity'),
      click('Place order'),
    ],
  },
];

export const NEUTRAL_FIXTURES = [...new Set(NEUTRAL_TASKS.map((t) => t.fixture))];

/**
 * §4.3: "large targeted at the measured real-page band — full Aperture
 * snapshot 5,000–9,500 tokens (GitHub-repo to Hacker-News size, RESULTS.md
 * §A)", verified by preflight against the UNTRUNCATED Aperture full snapshot,
 * band ±20%.
 *
 * The band is expressed in CHARS at this bench's standing 4-chars-per-token
 * rule (bench/tokens.mjs `CHARS_PER_TOKEN`), because chars are what the harness
 * can measure without a tokenizer and every other size number in this repo is
 * quoted the same way.
 */
export const CHARS_PER_TOKEN = 4;
export const SIZE_BANDS = {
  'neutral-small': { minTokens: 250, maxTokens: 750 },   // §4.2: "~300-600 snapshot tokens", ±20%
  'neutral-large': { minTokens: 5000, maxTokens: 9500 }, // §4.2: the measured real-page band
};

export function sizeVerdict(cls, chars) {
  const band = SIZE_BANDS[cls];
  if (!band) return { ok: true, tokens: Math.ceil(chars / CHARS_PER_TOKEN), band: null };
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  return { ok: tokens >= band.minTokens && tokens <= band.maxTokens, tokens, band };
}

export const taskById = (id) => NEUTRAL_TASKS.find((t) => t.id === id) ?? null;
