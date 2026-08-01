/**
 * The task set. Ten tasks over nine fixtures.
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
 *   solve        A deterministic, label-targeted script. It must pass in BOTH
 *                arms before a single API token is spent (guard G2).
 */

/** Label-targeted step helpers keep the solver scripts readable. */
const click = (label) => ({ act: 'click', label });
const type = (label, text) => ({ act: 'type', label, text });

export const TASKS = [
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
  if (!t) throw new Error(`unknown task: ${id}`);
  return t;
}
