/**
 * The task set. Wave 2: seven tasks over seven fixtures.
 *
 * WHY THIS SET, AND WHY THE OLD ONE IS GONE
 *
 * Wave 1 ran ten tasks x two arms x N=5 and returned INCONCLUSIVE on the
 * ceiling guard: every one of the ten scored 50/50 in BOTH arms with zero
 * wrong-element actions. A suite both arms solve perfectly cannot detect the
 * bookkeeping penalty it exists to look for, however many episodes are spent
 * on it.
 *
 * So the set was rebuilt around the four loads that actually exercise
 * cross-turn delta tracking, each one traceable to a measured engine
 * behaviour rather than to a feeling that a task looks hard:
 *
 *   L1  positional identity — ordinal keys (`|#n`) are reassigned when an
 *       earlier sibling is removed, so a stale ref lands on a real, WRONG
 *       element. Wave 1 had no fixture that forced this at all.
 *   L2  forced mid-task resync — MAX_DIFFS_PER_EPOCH restates the whole page
 *       partway through, and the model must discard everything it holds while
 *       retaining a fact it learned before the reset.
 *   L3  die, revive, die — replace ops with `gone:` lists and registry
 *       revival, more than once in a single episode.
 *   L4  cross-diff accumulation — facts that exist ONLY in past diffs and are
 *       never restated. Full re-dumps restate them; diffs do not. This is the
 *       arms' honest difference and the whole reason for the experiment.
 *
 * Three wave-1 tasks are RETAINED BYTE-IDENTICALLY (`inbox-archive`,
 * `wizard-submit`, `leaderboard-max`) so the two cohorts have a comparable
 * spine. Their prompts are hashed per task into the episode identity, so any
 * drift is named by the integrity guard rather than trusted.
 *
 * The other seven are RETIRED — kept below as documentation, absent from
 * `TASKS`. They are not merely redundant, they are actively harmful to pool:
 * a real 15pp drop concentrated in the hard third of a 14-task suite pools out
 * to about 4pp, which is inside the -5pp parity margin. Keeping them would
 * manufacture a false PARITY by construction.
 *
 * Every field here is load-bearing:
 *
 *   prompt       Byte-identical across arms — the arm is applied at the MCP
 *                proxy, never in the words. Written the way a person would ask,
 *                and deliberately NOT written in terms of refs or snapshots.
 *
 *   success      A predicate over the FIXTURE's own reported state. Not over a
 *                snapshot: half the snapshot pipeline is the variable under
 *                test, and this suite has twice printed a green obtained by
 *                asking the thing under test whether it worked.
 *
 *   allowed      The `data-bench` ids a correct solution may touch. Anything
 *                else the page reports as having been clicked or typed into is
 *                a WRONG-ELEMENT ACTION — the second headline metric. Note it
 *                is scored from the page's report, not from what the agent
 *                believed it was doing.
 *
 *   mustObserve  A regex that must match the DIFF-ONLY observation stream of
 *                the scripted solver. This is the guard that stops the whole
 *                experiment from being vacuous: it proves the information that
 *                decides the task actually travels through a diff, rather than
 *                being sitting in the first full snapshot where both arms would
 *                get it for free.
 *
 *   streamAssert Optional, checked beside `mustObserve` in G2. `mustObserve`
 *                proves the winning CONTENT arrives in a diff; streamAssert
 *                proves the engine BEHAVIOUR the task claims to load actually
 *                engaged. `queue-positional` is worthless if the walker turns
 *                out not to produce ordinal keys on that markup, and the only
 *                way to know is to look at the bytes.
 *
 *   solve        A deterministic, label-targeted script. It must pass in BOTH
 *                arms before a single API token is spent (guard G2).
 */

/** Label-targeted step helpers keep the solver scripts readable. */
const click = (label) => ({ act: 'click', label });
const type = (label, text) => ({ act: 'type', label, text });
/**
 * Pick the nth (1-based) element carrying `label`.
 *
 * ONLY valid on a page that mutates by removal — see the constraint documented
 * on `resolveLabel` in bench/task.mjs. `queue-positional` is built to honour it.
 */
const clickNth = (label, nth) => ({ act: 'click', label, nth });

/**
 * Refs named by the destructive ops of one diff block.
 *
 * Deliberately parses the wire format rather than the shadow model: the point
 * of a streamAssert is to look at the bytes the agent was actually handed.
 */
function destructiveRefs(block) {
  const refs = new Set();
  for (const line of block.split('\n')) {
    let m = /^- (e\d+) removed/.exec(line);
    if (m) refs.add(m[1]);
    m = /^~ (e\d+)/.exec(line);
    if (m) refs.add(m[1]);
    m = /^! (e\d+) replaced/.exec(line);
    if (m) refs.add(m[1]);
    m = /^- gone: (.*)$/.exec(line);
    if (m) for (const r of m[1].trim().split(/\s+/)) refs.add(r);
    m = /\(gone: ([^)]*)\)/.exec(line);
    if (m) for (const r of m[1].trim().split(/\s+/)) refs.add(r);
  }
  refs.delete('');
  return refs;
}

/**
 * Split a joined observation stream back into one block per observation.
 *
 * Both diff and unchanged observations open with `page #E.S`, so this survives
 * the wording of the unchanged notice — which is exactly the sort of thing a
 * guard should not be coupled to.
 *
 * The `/^page #/` filter is not tidying. An act's observation does not BEGIN at
 * the `page #` line: it opens with the act result (`ok click e33`) and the
 * untrusted-content envelope, so the first split segment is a preamble carrying
 * no ops at all. Without the filter, `streamAssert` inspected that preamble,
 * found zero refs and failed a fixture whose diff was in fact exactly right —
 * measured, on the first run of the guard against real bytes.
 */
function observationBlocks(stream) {
  return stream.split(/^(?=page #)/m).filter((b) => /^page #/.test(b));
}

export const TASKS = [
  {
    id: 'inbox-archive',
    fixture: 'inbox.html',
    prompt:
      'Archive every message from Priya Raman in this inbox. Do not archive anything else.',
    maxSteps: 14,
    allowed: ['archive:m1', 'archive:m3', 'archive:m6'],
    success: (s) => {
      if (!s || !Array.isArray(s.inbox) || !Array.isArray(s.archived)) return false;
      const arch = s.archived.map((m) => m.from).sort();
      return (
        s.archived.length === 3 &&
        arch.every((f) => f === 'Priya Raman') &&
        s.inbox.length === 3 &&
        s.inbox.every((m) => m.from !== 'Priya Raman')
      );
    },
    // Measured, not assumed. The first regex tried here was /Alice Fenn/ — the
    // senders that SURVIVE — and G2 refused it: surviving rows do not change,
    // so nothing restates them and they never appear in a diff at all. What
    // does arrive, and what actually decides this task, is which Archive refs
    // just died: an agent that misses these three lines is holding three refs
    // to buttons that no longer exist, on a page where every button looks the
    // same. The guard corrected the experiment before any budget was spent.
    mustObserve: /- e\d+ removed \(was: button "Archive message from Priya Raman/,
    solve: [
      click('Archive message from Priya Raman about Q3 forecast'),
      click('Archive message from Priya Raman about Re: Q3 forecast'),
      click('Archive message from Priya Raman about Board pack'),
    ],
  },

  {
    id: 'wizard-submit',
    fixture: 'wizard.html',
    prompt:
      'Complete this sign-up form. The full name is Dana Reed, the email address is ' +
      'dana@example.com, and the plan is Standard. Submit the application when you are done.',
    maxSteps: 16,
    allowed: ['fullname', 'email', 'next-1', 'plan-standard', 'next-2', 'submit', 'back-2', 'back-3'],
    success: (s) =>
      !!s &&
      s.submitted === true &&
      s.fullname === 'Dana Reed' &&
      s.email === 'dana@example.com' &&
      s.plan === 'standard',
    // Each step replaces the entire panel: every ref from step 1 is dead by
    // step 2, and the only announcement of the replacement is the diff.
    mustObserve: /Standard plan|Continue to review/,
    solve: [
      type('Full name', 'Dana Reed'),
      type('Email address', 'dana@example.com'),
      click('Continue to plan'),
      click('Standard plan'),
      click('Continue to review'),
      click('Submit application'),
    ],
  },

  {
    id: 'leaderboard-max',
    fixture: 'leaderboard.html',
    prompt:
      'Look through every page of this leaderboard and select the person with the highest ' +
      'score.',
    maxSteps: 16,
    allowed: ['next', 'prev', 'select:marcus-webb'],
    success: (s) => !!s && s.selected === 'Marcus Webb',
    // The winning score is on page three. No single observation contains the
    // answer; it has to be accumulated across three re-renders.
    mustObserve: /Score 98/,
    solve: [click('Next page'), click('Next page'), click('Select Marcus Webb')],
  },

  {
    id: 'queue-positional',
    fixture: 'queue.html',
    prompt:
      'Reject the submissions currently 2nd and 5th from the top, then approve every ' +
      'remaining submission.',
    maxSteps: 16,
    allowed: [
      'reject:q2', 'reject:q5',
      'approve:q1', 'approve:q3', 'approve:q4', 'approve:q6', 'approve:q7',
    ],
    // L1. Every row is content-identical, so every Approve and every Reject
    // button falls through to the walker's S-tier key and is told apart ONLY by
    // a document-order ordinal. Acting removes a row, which renumbers every row
    // below it — the ref the agent holds for "the 5th one" now resolves to a
    // real button on a different submission. The predicate refuses a queue that
    // was emptied with the right counts and the wrong rows.
    success: (s) => {
      if (!s || !Array.isArray(s.pending) || !Array.isArray(s.approved)) return false;
      if (!Array.isArray(s.rejected)) return false;
      const rejected = s.rejected.slice().sort().join(',');
      const approved = s.approved.slice().sort().join(',');
      return (
        s.pending.length === 0 &&
        rejected === 'q2,q5' &&
        approved === 'q1,q3,q4,q6,q7'
      );
    },
    // Nothing on a row ever changes, so no row can announce itself. What the
    // stream does carry is the pending count, and it only reaches 5 after two
    // correct rejections.
    mustObserve: /5 pending/,
    // The fixture is only testing L1 if the walker really does fall through to
    // ordinals on this markup — which cannot be known from reading the walker,
    // only from looking at a diff it produced. After the first removal the diff
    // must retire at least two refs: under ordinal keying the row that dies is
    // the LAST one (its ordinals no longer exist), never the row that was
    // clicked, and it takes both of its buttons with it. A fixture that had
    // accidentally acquired content-based identity would report something else,
    // and this is the check that would say so before any budget was spent.
    streamAssert: (stream) => {
      const first = observationBlocks(stream)[0];
      if (!first) return 'the diff-only stream is empty — no observation to check';
      const refs = destructiveRefs(first);
      if (refs.size >= 2) return null;
      return (
        `the first diff after a removal named ${refs.size} ref(s) in its ` +
        'remove/update/replace/gone ops. Removing one row must retire the ordinal ' +
        'keys of a whole row (two buttons), so fewer than 2 means the rows are not ' +
        'positionally keyed and this fixture is not testing L1.'
      );
    },
    // Descending, then from the top: under removals-only mutation each step's
    // target is unambiguous at the moment it runs. Rejecting the 5th first
    // leaves the 2nd where it was; approving the 1st five times over drains
    // what is left without ever having to name a moving row.
    solve: [
      clickNth('Reject', 5),
      clickNth('Reject', 2),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
    ],
  },

  {
    id: 'vault-code',
    fixture: 'vault.html',
    prompt:
      'Open this vault. Reveal the security code, then work through both panels of ' +
      'safeguards — every safeguard on a panel has to be enabled before it will let you ' +
      'continue — and finally enter the security code and unlock the vault.',
    maxSteps: 22,
    allowed: [
      'reveal', 'begin',
      't:alpha', 't:bravo', 't:charlie', 't:delta', 't:echo', 'continue-2',
      't:foxtrot', 't:golf', 't:hotel', 't:india', 't:juliet', 'continue-3',
      'code', 'unlock',
    ],
    // L2 + L3. Sixteen page actions is more than MAX_DIFFS_PER_EPOCH, so the
    // engine stops diffing partway through and restates the entire page. The
    // code is revealed by the first click and appears on no later panel, so it
    // survives neither the forced resync nor a voluntary full snapshot: the
    // model either carried it across its own state reset or it cannot finish.
    success: (s) => {
      if (!s || s.unlocked !== true || s.code !== 'VC-83QK') return false;
      const t = s.toggles;
      if (!t) return false;
      const names = [
        'alpha', 'bravo', 'charlie', 'delta', 'echo',
        'foxtrot', 'golf', 'hotel', 'india', 'juliet',
      ];
      return names.every((n) => t[n] === true);
    },
    mustObserve: /VC-83QK/,
    solve: [
      click('Reveal code'),
      click('Begin'),
      click('Enable alpha safeguard'),
      click('Enable bravo safeguard'),
      click('Enable charlie safeguard'),
      click('Enable delta safeguard'),
      click('Enable echo safeguard'),
      click('Continue to stage two'),
      click('Enable foxtrot safeguard'),
      click('Enable golf safeguard'),
      click('Enable hotel safeguard'),
      click('Enable india safeguard'),
      click('Enable juliet safeguard'),
      click('Continue to the vault'),
      type('Security code', 'VC-83QK'),
      click('Unlock'),
    ],
  },

  {
    id: 'catalog-revive',
    fixture: 'catalog.html',
    prompt:
      "In this parts catalogue, search for 'steel' and add the cheapest matching part to " +
      "the shortlist. Then search for 'oak' instead, and add the cheapest matching part " +
      'to the shortlist as well.',
    maxSteps: 12,
    allowed: ['search', 'add:steel-bracket', 'add:oak-dowel'],
    // L3. The first filter kills every ref in the list; the implicit clear
    // inside the second `type` revives the whole catalogue and then kills it
    // again, all inside one act. Order is part of the predicate because doing
    // the second search first and back-filling is a different task.
    success: (s) =>
      !!s &&
      Array.isArray(s.shortlist) &&
      s.shortlist.length === 2 &&
      s.shortlist[0] === 'Steel bracket' &&
      s.shortlist[1] === 'Oak dowel',
    // The unfiltered list collapses to "… 9 more", so no price is visible until
    // the agent's own typing re-renders it. $4.25 can only arrive in a diff.
    mustObserve: /\$4\.25/,
    solve: [
      type('Search the catalogue', 'steel'),
      click('Add Steel bracket to shortlist'),
      type('Search the catalogue', 'oak'),
      click('Add Oak dowel to shortlist'),
    ],
  },

  {
    id: 'ledger-balance',
    fixture: 'ledger.html',
    prompt:
      'This ledger starts at a balance of zero. Apply adjustments one at a time until the ' +
      'balance is exactly +10, then close the ledger. Stop as soon as it reaches +10 — do ' +
      'not apply any adjustment after that.',
    maxSteps: 14,
    allowed: ['apply', 'close'],
    // L4, as hard as this suite loads it. The running balance is never on the
    // page at all, and only the last four adjustments are visible: the re-dump
    // arm re-reads most of the history for free every turn, while the diff arm
    // is told each adjustment exactly once, in the turn it happened. The
    // deltas' prefix sums are 4, 2, 7, 8, 10, 7, 10 — +10 first arrives on the
    // fifth application, and an agent one entry out stops in the wrong place.
    success: (s) => !!s && s.closed === true && s.balance === 10,
    // The fifth delta. It exists in the fifth click's diff and nowhere else —
    // by the time anything restates the page it is one line among four, and the
    // sum that matters was never displayed in the first place.
    mustObserve: /applied \+2/,
    solve: [
      click('Apply next adjustment'),
      click('Apply next adjustment'),
      click('Apply next adjustment'),
      click('Apply next adjustment'),
      click('Apply next adjustment'),
      click('Close ledger'),
    ],
  },
];

/**
 * Wave 1's other seven tasks, kept as documentation and NOT run.
 *
 * Every one of them scored 100/100 pooled across both arms. They are preserved
 * here because "we dropped the easy ones" is a claim a reader should be able to
 * check rather than take on trust, and because the fixtures they name are still
 * on disk (bench/size.mjs's ladder is built from cart.html).
 *
 * There is deliberately no flag that runs them: a verdict pooled over a suite
 * that is two-thirds ceiling is not the verdict this experiment preregistered.
 */
export const RETIRED = [
  {
    id: 'todo-complete',
    fixture: 'todo.html',
    prompt:
      "On this task list, mark the tasks 'Renew passport' and 'Book dentist' as done. " +
      'Leave every other task exactly as it is.',
    maxSteps: 10,
    allowed: ['toggle:renew-passport', 'toggle:book-dentist'],
    // "Book dentist follow-up" is the near miss. A model that has lost track of
    // which ref is which after the list was rebuilt has a 50/50 shot here, and
    // the predicate refuses both-of-them as well as the wrong one.
    success: (s) => {
      if (!s || !Array.isArray(s.items) || s.items.length !== 7) return false;
      const done = s.items.filter((i) => i.done).map((i) => i.title).sort();
      return done.length === 2 && done[0] === 'Book dentist' && done[1] === 'Renew passport';
    },
    mustObserve: /Reopen: Renew passport|Reopen: Book dentist/,
    solve: [click('Mark done: Renew passport'), click('Mark done: Book dentist')],
  },

  {
    id: 'todo-replace',
    fixture: 'todo.html',
    prompt:
      "On this task list, delete the task 'Water plants', then add a new task called " +
      "'Call plumber'.",
    maxSteps: 12,
    allowed: ['del:water-plants', 'new-task', 'add-task'],
    success: (s) => {
      if (!s || !Array.isArray(s.items)) return false;
      const titles = s.items.map((i) => i.title);
      return (
        titles.length === 7 &&
        !titles.includes('Water plants') &&
        titles.filter((t) => t === 'Call plumber').length === 1 &&
        s.items.every((i) => !i.done)
      );
    },
    mustObserve: /1 of 7 done|7 of 7|Delete: Call plumber|Mark done: Call plumber/,
    solve: [
      click('Delete: Water plants'),
      type('New task title', 'Call plumber'),
      click('Add task'),
    ],
  },

  {
    id: 'cart-adjust',
    fixture: 'cart.html',
    prompt:
      "In this shopping cart, change the quantity of the Desk Lamp to 4, and remove the " +
      'Notebook from the cart entirely. Do not change anything else.',
    maxSteps: 12,
    allowed: ['inc:desk-lamp', 'dec:desk-lamp', 'rm:notebook'],
    success: (s) => {
      if (!s || !Array.isArray(s.lines)) return false;
      const by = Object.fromEntries(s.lines.map((l) => [l.name, l.qty]));
      return (
        s.lines.length === 3 &&
        by['Desk Lamp'] === 4 &&
        by['Notebook'] === undefined &&
        by['Blue Widget'] === 1 &&
        by['USB Hub'] === 1
      );
    },
    // The quantity exists in exactly one place on the page. Reaching 4 requires
    // having read it get to 3 first.
    mustObserve: /Quantity: 4/,
    solve: [click('Add one Desk Lamp'), click('Add one Desk Lamp'), click('Delete Notebook from cart')],
  },

  {
    id: 'finder-cheapest',
    fixture: 'finder.html',
    prompt:
      "Search this catalogue for 'cable', then add the cheapest matching product to the " +
      'shortlist.',
    maxSteps: 12,
    allowed: ['search', 'add:usb-c-cable-1m'],
    success: (s) =>
      !!s && Array.isArray(s.shortlist) && s.shortlist.length === 1 && s.shortlist[0] === 'USB-C cable 1m',
    // The initial list collapses to "… 9 more", so no price is visible until
    // the agent's own typing re-renders it. $7.50 can only arrive in a diff.
    mustObserve: /\$7\.50/,
    solve: [type('Search the catalogue', 'cable'), click('Add USB-C cable 1m to shortlist')],
  },

  {
    id: 'tabs-carry',
    fixture: 'tabs.html',
    prompt:
      'Find the account reference code in this portal, then open the Support section and ' +
      "enter that code in the Reference code field. Set the message to 'Please check my " +
      "account.' and submit the ticket.",
    maxSteps: 16,
    allowed: ['tab-account', 'tab-support', 'tab-billing', 'ref', 'message', 'submit-ticket'],
    success: (s) =>
      !!s &&
      s.submitted === true &&
      s.ref === 'RF-4827' &&
      s.message === 'Please check my account.',
    // Billing is the default tab and carries a decoy code of the same shape.
    // RF-4827 is not in the first full snapshot in either arm; it can only be
    // learned from the observation that follows the agent's own tab click.
    mustObserve: /RF-4827/,
    solve: [
      click('Account'),
      click('Support'),
      type('Reference code', 'RF-4827'),
      type('Message', 'Please check my account.'),
      click('Submit ticket'),
    ],
  },

  {
    id: 'settings-config',
    fixture: 'settings.html',
    prompt:
      'In these settings, turn on notifications, set the delivery method to SMS, and switch ' +
      'on the weekly digest.',
    maxSteps: 12,
    allowed: ['notifications', 'method-sms', 'digest'],
    success: (s) =>
      !!s && s.notifications === true && s.method === 'sms' && s.digest === true && s.marketing === false,
    // The delivery controls do not exist until notifications are on. There is
    // no stale ref to recover from — the agent has to learn they arrived.
    mustObserve: /Weekly digest/,
    solve: [click('Enable notifications'), click('SMS delivery'), click('Weekly digest')],
  },

  {
    id: 'steppers-balance',
    fixture: 'steppers.html',
    prompt: 'Set every dial on this page to exactly 5.',
    maxSteps: 20,
    allowed: [
      'up:alpha', 'down:alpha', 'up:bravo', 'down:bravo',
      'up:charlie', 'down:charlie', 'up:delta', 'down:delta',
    ],
    success: (s) =>
      !!s && !!s.dials && s.dials.alpha === 5 && s.dials.bravo === 5 &&
      s.dials.charlie === 5 && s.dials.delta === 5,
    // Seven correct actions, each conditional on a number that only the stream
    // reports. An agent that stops reading can still press buttons; it just
    // will not know when to stop.
    mustObserve: /Alpha: 5/,
    solve: [
      click('Increase Alpha'), click('Increase Alpha'), click('Increase Alpha'),
      click('Decrease Bravo'), click('Decrease Bravo'),
      click('Increase Charlie'),
      click('Decrease Delta'),
    ],
  },
];

export const FIXTURES = [...new Set(TASKS.map((t) => t.fixture))];

export function taskById(id) {
  const t = TASKS.find((x) => x.id === id);
  if (t) return t;
  if (RETIRED.some((x) => x.id === id)) {
    throw new Error(
      `${id} was retired after wave 1 — it sat at 100/100 in both arms and pooling it ` +
        'dilutes the delta this suite exists to measure. It is not in TASKS.',
    );
  }
  throw new Error(`unknown task: ${id}`);
}
