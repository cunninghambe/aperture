/**
 * The task set. Wave 3: five tasks over five fixtures, in TWO STRATA.
 *
 * WHY THIS SET, AND WHY THE WAVE-2 ONE IS GONE
 *
 * Wave 1 ran ten tasks at N=5 and returned INCONCLUSIVE on the ceiling guard.
 * Wave 2 rebuilt the set around four measured engine loads (L1-L4 below) and
 * ran seven tasks at N=20 — and six of the seven still ceilinged: 210 of 210
 * episodes on `inbox-archive`, `leaderboard-max`, `vault-code`,
 * `catalog-revive` and the two canaries pooled to 100%, while ONE task,
 * `queue-positional`, separated the arms at all. Pooling three informative
 * tasks with four ceilinged ones is the dilution failure wave 2 documented in
 * its own evaluation (wave2-evaluation.md §4.2): a real penalty concentrated
 * in the hard tasks pools out to nothing, and the suite prints a confident
 * number about a suite that mostly measured nothing.
 *
 * Wave 3 therefore does two things at once, and the STRATUM field is what
 * keeps them apart:
 *
 *   discriminative — the three positional-identity tasks the verdict is
 *                    computed over. Nothing else enters a CI, ever.
 *   canary         — two known-ceiling tasks, five episodes each, kept ONLY as
 *                    apparatus health: if `wizard-submit` (type+click, panel
 *                    replacement) or `ledger-balance` (L4 accumulation) stops
 *                    scoring 100%, something is wrong with the apparatus and
 *                    not with the hypothesis. They license the sentence "the
 *                    apparatus and easy-task floor held" and no other.
 *
 * The four loads the discriminative tasks are built on, each traceable to a
 * measured engine behaviour rather than to a feeling that a task looks hard:
 *
 *   L1  positional identity — ordinal keys (`|#n`) are reassigned when an
 *       earlier sibling is removed, so a stale ref lands on a real, WRONG
 *       element.
 *   L2  forced mid-task resync — MAX_DIFFS_PER_EPOCH restates the whole page
 *       partway through, and the model must discard everything it holds while
 *       retaining a fact it learned before the reset.
 *   L3  die, revive, die — replace ops with `gone:` lists and registry
 *       revival, more than once in a single episode.
 *   L4  cross-diff accumulation — facts that exist ONLY in past diffs and are
 *       never restated. Full re-dumps restate them; diffs do not.
 *
 * ONE CONSTRAINT BINDS EVERY WAVE-3 FIXTURE: REMOVALS ONLY. tier3.md §3.1
 * records the probe — prepending an identical row into a positional family
 * emits exactly one `add`, silently rebinding every ordinal ref the agent
 * holds, and no diff-side rule can fix it (it needs walker-side rebinding
 * detection). A task built on insertion would measure that known engine hole
 * instead of the variable under test. Each fixture's header states the
 * constraint and cites the section.
 *
 * Every field here is load-bearing:
 *
 *   stratum      'discriminative' or 'canary'. The report partitions on it:
 *                verdict arithmetic over the discriminative stratum only,
 *                apparatus guards over everything, canaries in no CI anywhere.
 *
 *   quota        Target episodes per arm for THIS task. `--n` is a phase cap;
 *                a task stops accruing at its quota however large `--n` is, so
 *                the canaries cost 5 each and the discriminative tasks get 45.
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
 *   streamAssert Optional, checked beside `mustObserve` in G2, and called as
 *                `streamAssert(diffStream, episode)` — the second argument is
 *                the G2 episode record, which is how `queue-resync` can assert
 *                on `obsSeq` (that a forced restatement actually engaged
 *                mid-episode) rather than only on the diff bytes. Single-arg
 *                asserts are unaffected. `mustObserve` proves the winning
 *                CONTENT arrives in a diff; streamAssert proves the engine
 *                BEHAVIOUR the task claims to load actually engaged. A fixture
 *                that quietly stopped producing ordinal keys would still solve,
 *                still match its regex, and test nothing.
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
 * on `resolveLabel` in bench/task.mjs. Every wave-3 fixture honours it.
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
    id: 'queue-positional',
    fixture: 'queue.html',
    stratum: 'discriminative',
    quota: 45,
    prompt:
      'Reject the submissions currently 2nd and 5th from the top, then approve every ' +
      'remaining submission.',
    maxSteps: 16,
    allowed: [
      'reject:q2', 'reject:q5',
      'approve:q1', 'approve:q3', 'approve:q4', 'approve:q6', 'approve:q7',
    ],
    // L1, and wave 3's POST-P1 ANCHOR. Every row is content-identical, so every
    // Approve and every Reject button falls through to the walker's S-tier key
    // and is told apart ONLY by a document-order ordinal. Acting removes a row,
    // which renumbers every row below it — the ref the agent holds for "the 5th
    // one" now resolves to a real button on a different submission. The
    // predicate refuses a queue that was emptied with the right counts and the
    // wrong rows.
    //
    // Retained on a stated prediction (tier3.md §3.1): P1 changed the engine on
    // exactly this mechanism, so the diff arm now receives fresh label->ref
    // lines after every removal and this task probably discriminates LESS than
    // it did in wave 2. Its post-P1 level IS the measurement of whether P1
    // worked, the intrinsic ordinal difficulty is untouched by P1, and wave 3
    // does not rest on it alone — twin-queues and queue-resync load what P1 does
    // not neutralise. Any comparison with wave 2's numbers is DIRECTIONAL
    // NARRATIVE only: different engine, never pooled, never CI'd.
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
    // only from looking at a diff it produced.
    //
    // POST-P1 WIRE (corrected 2026-08-02; this comment described the pre-P1
    // wire — "the refs of the LAST row dying" — and was still stale at
    // 3830a34): a removal from a positional family now emits ONE `replace` of
    // the container carrying a full `gone` list. So the destructive ops of the
    // first diff name the whole dead row's refs, plus the survivors' restated
    // lines. The assert is unchanged and still passes on it: replace + `gone`
    // satisfies `destructiveRefs >= 2`. What it rules out is unchanged too — a
    // fixture that had accidentally acquired content-based identity would
    // report a single tidy removal, and this is the check that would say so
    // before any budget was spent.
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
    id: 'twin-queues',
    fixture: 'twinqueue.html',
    stratum: 'discriminative',
    quota: 45,
    prompt:
      'In the Interviews queue, reject the interviews that are currently 2nd and 4th from ' +
      'the top. In the Deliveries queue, reject the delivery that is currently 3rd from ' +
      'the top. Then approve every remaining interview and delivery.',
    maxSteps: 18,
    allowed: [
      'reject:i2', 'reject:i4', 'reject:d3',
      'approve:i1', 'approve:i3', 'approve:i5', 'approve:i6',
      'approve:d1', 'approve:d2', 'approve:d4', 'approve:d5',
    ],
    // L1 x 2. Two independent ordinal spaces, and the load P1 does NOT
    // neutralise: SCOPED RESTATEMENT. A removal in one family restates that
    // family and says nothing about the other, so the diff arm must merge a
    // freshly restated A with a B it was told about once, several turns ago,
    // while the re-dump arm is handed both every turn.
    success: (s) => {
      if (!s || !Array.isArray(s.pendingInterviews) || !Array.isArray(s.pendingDeliveries)) {
        return false;
      }
      const j = (a) => (Array.isArray(a) ? a.slice().sort().join(',') : null);
      return (
        s.pendingInterviews.length === 0 &&
        s.pendingDeliveries.length === 0 &&
        j(s.rejectedInterviews) === 'i2,i4' &&
        j(s.rejectedDeliveries) === 'd3' &&
        j(s.approvedInterviews) === 'i1,i3,i5,i6' &&
        j(s.approvedDeliveries) === 'd1,d2,d4,d5'
      );
    },
    // Reachable only after both interview rejections, and only via the stream:
    // nothing on a surviving row changes, so no row can announce itself
    // (queue.html's argument, verbatim, applied to the Interviews counter).
    mustObserve: /4 interviews pending/,
    // The behaviour this task exists to load, asserted on live bytes rather
    // than assumed (tier3.md §8 lists family separation as DELEGATED to this
    // assert — the walker's treatment of the two levers, distinct button labels
    // and named sections, is not verified anywhere else).
    //
    // The solver acts in Interviews first, so the FIRST block must restate the
    // Interviews family and must NOT mention Deliveries. If `disambiguate`'s
    // walk-global `ctx.seen` had put both families in ONE ordinal sequence, a
    // removal in Interviews would renumber Deliveries too and the second clause
    // would fail here — at --selftest, before any budget is at risk. If it
    // fails, adjust the fixture's levers and re-run: the assert is the
    // contract, the markup is the means.
    streamAssert: (stream) => {
      const first = observationBlocks(stream)[0];
      if (!first) return 'the diff-only stream is empty — no observation to check';
      const refs = destructiveRefs(first);
      const why = [];
      if (refs.size < 2) {
        why.push(
          `the first diff named ${refs.size} ref(s) in its remove/update/replace/gone ops ` +
            '(need >= 2: removing one row must retire a whole row, so fewer than 2 means the ' +
            'rows are not positionally keyed)',
        );
      }
      if (!/interview/i.test(first)) {
        why.push('the first diff never mentions the Interviews family, which is where the act was');
      }
      if (/deliver/i.test(first)) {
        why.push(
          'the first diff MENTIONS Deliveries — a removal in Interviews restated the other ' +
            'family too, so the two ordinal spaces are coupled and this fixture is not loading ' +
            'scoped restatement (see the family-separation levers in twinqueue.html)',
        );
      }
      return why.length ? why.join('; ') : null;
    },
    // Descending within a family, removals-only discipline. Family-distinct
    // labels are also what keep `nth` valid across two lists: post-P1 a family
    // replace re-appends its entries at the END of the shadow model, so a label
    // shared across families would break insertion-order = document-order over
    // the union. Within one restated family the order is the subtree's document
    // order. (Stated in twinqueue.html's header too.)
    solve: [
      clickNth('Reject interview', 4),
      clickNth('Reject interview', 2),
      clickNth('Reject delivery', 3),
      clickNth('Approve interview', 1),
      clickNth('Approve interview', 1),
      clickNth('Approve interview', 1),
      clickNth('Approve interview', 1),
      clickNth('Approve delivery', 1),
      clickNth('Approve delivery', 1),
      clickNth('Approve delivery', 1),
      clickNth('Approve delivery', 1),
    ],
    // For the record (wave2-evaluation §4.3): T2 is the first fixture where
    // `identity_mismatch` is REACHABLE — a stale ref crossing families lands on
    // a differently-labelled button and `labelsAgree` fails. Expect it in the
    // attribution table; it is a finding, not a bug in the harness.
  },

  {
    id: 'queue-resync',
    fixture: 'queue16.html',
    stratum: 'discriminative',
    quota: 45,
    prompt:
      'Reject the submissions currently 2nd, 5th, 9th and 13th from the top, then approve ' +
      'every remaining submission.',
    maxSteps: 24,
    allowed: [
      'reject:q2', 'reject:q5', 'reject:q9', 'reject:q13',
      'approve:q1', 'approve:q3', 'approve:q4', 'approve:q6', 'approve:q7',
      'approve:q8', 'approve:q10', 'approve:q11', 'approve:q12', 'approve:q14',
      'approve:q15', 'approve:q16',
    ],
    // L1 x L2. Sixteen acts against a 12-diff epoch budget: the engine forcibly
    // restates the page mid-task, and the model must carry "which ordinals have
    // I already handled" across its own state reset on a page of identical rows.
    // The sorted joins are spelled out rather than derived so nobody has to
    // re-derive them: lexicographic, so q10 sorts before q3.
    success: (s) => {
      if (!s || !Array.isArray(s.pending) || !Array.isArray(s.approved)) return false;
      if (!Array.isArray(s.rejected)) return false;
      const rejected = s.rejected.slice().sort().join(',');
      const approved = s.approved.slice().sort().join(',');
      return (
        s.pending.length === 0 &&
        rejected === 'q13,q2,q5,q9' &&
        approved === 'q1,q10,q11,q12,q14,q15,q16,q3,q4,q6,q7,q8'
      );
    },
    // First reachable after the fourth rejection (16 -> 15 -> 14 -> 13 -> 12
    // under the solver's rejects-first order), and only through the stream.
    mustObserve: /12 pending/,
    // Two claims, and the failure text says which half failed.
    //
    // 1. Positional keying is live (same argument as queue-positional).
    // 2. The forced restatement actually engaged MID-EPISODE: an act came back
    //    as a FULL SNAPSHOT, and diffing resumed after it. Whether the reset
    //    fires at act 13 or 14 is an engine detail (nextDiffSeq increment
    //    ordering) this deliberately does not pin — crossing it at all is the
    //    claim, and pinning the act number would make the assert fail on a
    //    harmless engine change.
    //
    // The second half reads `obsSeq` from the episode record, which is why
    // streamAssert takes the episode as its second argument.
    streamAssert: (stream, ep) => {
      const why = [];
      const first = observationBlocks(stream)[0];
      if (!first) {
        why.push('the diff-only stream is empty — no observation to check');
      } else {
        const refs = destructiveRefs(first);
        if (refs.size < 2) {
          why.push(
            `POSITIONAL KEYING: the first diff named ${refs.size} ref(s) in its ` +
              'remove/update/replace/gone ops (need >= 2)',
          );
        }
      }
      const seq = ep?.obsSeq ?? [];
      const firstFull = seq.indexOf('a:full');
      if (firstFull === -1) {
        why.push(
          'FORCED RESYNC: no act came back as a FULL SNAPSHOT, so the 12-diff epoch budget was ' +
            `never crossed in ${seq.length} observation(s) — this fixture is not loading L2 ` +
            `(obsSeq: ${seq.join(' ')})`,
        );
      } else if (!(seq.lastIndexOf('a:diff') > firstFull)) {
        why.push(
          'FORCED RESYNC: an act returned a FULL SNAPSHOT but no act after it returned a diff, ' +
            `so diffing did not resume and the episode is not "positional work ACROSS a reset" ` +
            `(obsSeq: ${seq.join(' ')})`,
        );
      }
      return why.length ? why.join('; ') : null;
    },
    solve: [
      clickNth('Reject', 13),
      clickNth('Reject', 9),
      clickNth('Reject', 5),
      clickNth('Reject', 2),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
      clickNth('Approve', 1),
    ],
  },

  {
    id: 'wizard-submit',
    fixture: 'wizard.html',
    stratum: 'canary',
    quota: 5,
    // BYTE-IDENTICAL to wave 2 (and wave 1): prompt, predicate, allowed set,
    // mustObserve and solver are unchanged, which is what makes it a canary
    // rather than a task. It exercises the type+click path and L2 panel
    // replacement. If it leaves 100%, the apparatus is what changed.
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
    id: 'ledger-balance',
    fixture: 'ledger.html',
    stratum: 'canary',
    quota: 5,
    // BYTE-IDENTICAL to wave 2. The hardest of the ceilinged tasks and the one
    // whose failure would be most informative: if L4 accumulation — the arms'
    // honest difference — stops scoring 100% in both arms, investigate the
    // apparatus before believing anything else in the report.
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
 * Retired tasks, kept as documentation and NOT run.
 *
 * Two generations of them now. Wave 1's seven scored 100/100 pooled across both
 * arms; wave 2's four scored 210/210. They are preserved here because "we
 * dropped the easy ones" is a claim a reader should be able to check rather
 * than take on trust, and because the fixtures they name are still on disk
 * (bench/size.mjs's ladder is built from cart.html).
 *
 * There is deliberately no flag that runs them: a verdict pooled over a suite
 * that is mostly ceiling is not the verdict this experiment preregistered — and
 * with the wave-3 canaries, keeping two of them at quota 5 is the ONLY thing
 * ceiling tasks are still good for.
 */
export const RETIRED = [
  {
    id: 'inbox-archive',
    fixture: 'inbox.html',
    retired:
      'Wave 2: 30/30 in both arms. Content-addressed rows announce themselves, so it never ' +
      'loaded positional identity — retired after wave 2.',
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
    mustObserve: /- e\d+ removed \(was: button "Archive message from Priya Raman/,
    solve: [
      click('Archive message from Priya Raman about Q3 forecast'),
      click('Archive message from Priya Raman about Re: Q3 forecast'),
      click('Archive message from Priya Raman about Board pack'),
    ],
  },

  {
    id: 'leaderboard-max',
    fixture: 'leaderboard.html',
    retired:
      'Wave 2: 30/30 in both arms. Three re-renders of a small table is accumulation both ' +
      'arms find trivial — retired after wave 2.',
    prompt:
      'Look through every page of this leaderboard and select the person with the highest ' +
      'score.',
    maxSteps: 16,
    allowed: ['next', 'prev', 'select:marcus-webb'],
    success: (s) => !!s && s.selected === 'Marcus Webb',
    mustObserve: /Score 98/,
    solve: [click('Next page'), click('Next page'), click('Select Marcus Webb')],
  },

  {
    id: 'vault-code',
    fixture: 'vault.html',
    retired:
      'Wave 2: 30/30 in both arms. Its forced resync is real, but the fact carried across it ' +
      'is a static code — queue-resync loads the same reset with POSITIONAL work after it, ' +
      'which is what wave 3 needs.',
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
    retired:
      'Wave 2: 30/30 in both arms. Die/revive/die is announced by the agent\'s own typing, so ' +
      'neither arm has to remember anything — retired after wave 2.',
    prompt:
      "In this parts catalogue, search for 'steel' and add the cheapest matching part to " +
      "the shortlist. Then search for 'oak' instead, and add the cheapest matching part " +
      'to the shortlist as well.',
    maxSteps: 12,
    allowed: ['search', 'add:steel-bracket', 'add:oak-dowel'],
    success: (s) =>
      !!s &&
      Array.isArray(s.shortlist) &&
      s.shortlist.length === 2 &&
      s.shortlist[0] === 'Steel bracket' &&
      s.shortlist[1] === 'Oak dowel',
    mustObserve: /\$4\.25/,
    solve: [
      type('Search the catalogue', 'steel'),
      click('Add Steel bracket to shortlist'),
      type('Search the catalogue', 'oak'),
      click('Add Oak dowel to shortlist'),
    ],
  },

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
    // The delivery controls do not exist until notifications are on. There is
    // no stale ref to recover from — the agent has to learn they arrived.
    mustObserve: /Weekly digest/,
    success: (s) =>
      !!s && s.notifications === true && s.method === 'sms' && s.digest === true && s.marketing === false,
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

/** Total episodes the quota table asks for, both arms. Printed by --plan. */
export const QUOTA_TOTAL = TASKS.reduce((a, t) => a + t.quota, 0) * 2;

export function taskById(id) {
  const t = TASKS.find((x) => x.id === id);
  if (t) return t;
  const r = RETIRED.find((x) => x.id === id);
  if (r) {
    throw new Error(
      `${id} is RETIRED and is not in TASKS. ` +
        (r.retired ??
          'It sat at 100/100 in both arms after wave 1 and pooling it dilutes the delta this ' +
            'suite exists to measure.'),
    );
  }
  throw new Error(`unknown task: ${id}`);
}
