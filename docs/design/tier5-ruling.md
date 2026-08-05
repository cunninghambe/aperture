# Tier 5 §9.1.1 tripwire — the adjudication

Status: RULING, final. Written 2026-08-05 by an independent adjudicator who did
not write `docs/design/tier5.md` and did not build the change it specifies —
the coordinator declined to rule because the fix's survival is their interest,
and that independence is the point. Engine adjudicated: the tier5 landing at
`1d13e0b`, whose `src/` is byte-identical at current `master` (every commit
since is docs-only; shipped `out/main/index.js` still
`c3970981617b…`, the hash `g29-red-record.md` records for the post-fix build).

Evidence discipline: everything below was measured this session on
sha-verified builds — probes and free preflights only. **No scored cohort was
run, no commit was made, no `src/` file in this repo was edited.** Prototypes
were built in throwaway git worktrees under the session scratchpad
(`wt-prefix` at `e9e460a`, `wt-probe` at `1d13e0b` + throwaway edits), both
deleted after; the pre-fix worktree build reproduced the RED record's pre-fix
bundle **byte-for-byte** (`d0ff6c6c…`, 229,572 bytes) before anything was
measured against it.

---

## 0. The ruling

1. **(a) ACCEPT. Tier5 stands as landed.** No revert, no narrowing lands now,
   and §9.1.2's owed cohort proceeds on this build. §9.3.3 (the tripwire
   stop-ship) is discharged by this document. The preregistration for the
   cohort is §7 below — §9.2's economics expectation is REPLACED there,
   because this adjudication falsified it in advance of any cohort.
2. **(b) is REJECTED ON MEASUREMENT, not on argument.** An ADDRESSABLE-only
   pre-pass was prototyped and run: journal-comment still costs **45,404
   chars / 6 steps — byte-identical to the unpatched fix** (§4). The families
   that fire on the neutral stratum are radios and lists — ADDRESSABLE roles
   both. The narrowing as specified in `bench/RESULTS.md` excludes only the
   one family that never fires.
3. **(c) is REJECTED.** No §9.3 revert condition obtains: §9.3.1/9.3.2 are
   cohort questions that have not been asked yet, and §9.3.3's firing is ruled
   here to be a mis-specified tripwire catching a real-but-bounded, disclosed,
   warm-revisit-only cost (§5). Reverting would reinstate a measured,
   preregistered-primary-failing, silently-state-mutating defect (`ok click
   e30` → `took: r5`, the RED record's own words) to avoid a cost the
   benchmark's doctrine says belongs in the number.
4. **The tripwire is honored, not void** — its premise was false and it
   caught exactly that, which is what a tripwire is for. But it was
   mis-specified twice over, and it caught *less than it should have*: §5
   states what it should have been.
5. **A corrected narrowing (tier5.1, "same-set reappearance revives") is
   recorded in §6, prototype-verified, and deliberately NOT landed here.** It
   does not gate the cohort. It becomes mandatory only if the cohort fails
   the economics bound preregistered in §7.

---

## 1. The coordinator's framing is wrong in three load-bearing places

This ruling was asked for on a record (`bench/RESULTS.md` "Pending
re-measurement"; `g29-red-record.md` Appendix B) whose causal account is
incorrect. Corrections first, because candidate (b) was aimed by that account.

**1a. Wrong family.** The builder attributes the firing to the star group's
"unnamed `generic` wrappers". Instrumented probe (throwaway `console.log` in
`retirePositionalRebinds`, worktree build, `--tasks journal-comment`), the
retirements on that fixture, verbatim:

```
[T5-RETIRE] base="N|0|radio|rating" old=0 new=5
[T5-RETIRE]   key="N|0|radio|rating|#4" ref=e129
[T5-RETIRE]   key="N|0|radio|rating|#3" ref=e128
[T5-RETIRE]   key="N|0|radio|rating|#2" ref=e127
[T5-RETIRE]   key="N|0|radio|rating|#1" ref=e126
[T5-RETIRE]   key="N|0|radio|rating"    ref=e125
[T5-RETIRE] base="S|0|list||nav:archive|contentinfo>nav:archive|~rethingham quarterly notes 226" old=0 new=4
```

The firing family is **the five radios themselves**. They have unique ids
(`star-1`…`star-5`), unique values, unique accessible names — and one shared
`name="rating"` attribute, which is not optional: shared `name` is how an HTML
radio group *works*. `identityKey` (walker.ts:408-409) ranks the name-attr
tier (`N|frame|role|nameattr`) above the id tier for form controls, so all
five collapse to one key base and `disambiguate` makes them ordinal — **every
conventional radio group on every page is a positional family under the
shipped identity scheme.** The wrapper family the builder blamed exists but
never fires: wrappers are non-addressable, never received refs, so the
pre-pass's "nothing held" gate (diff.ts:119) skips them every time. This is
why (b) was dead on arrival: it excludes precisely and only the family that
already cannot fire.

**1b. Wrong scope.** "It is really only journal-comment" is false at the
mechanism level. Instrumented full-set run: retirement fires on **all six
neutral fixtures** — `N|0|radio|slot` (booking-form), `N|0|radio|method`
(account-prefs), `N|0|radio|rating` plus two bulk-nav `S|…|list` families
(journal-comment), one `S|…|list` family each on console-quota and
catalog-order, and an `S|…|listitem` family on inventory-pick. Five of the six
are costless (±3-18 chars — the builder's char-delta check could not see
them). §9.1.1 says "zero retirement events on the six neutral fixtures"; the
literal count is six-of-six firing, not one. Only journal-comment's costs
anything, because only there does retirement flip a `COLLAPSE_RUN` rendering
decision the consumer depends on.

**1c. Wrong delta class — and this is the decisive fact.** Every neutral
firing in the full-set log is `old=0`: a family **reappearing** after absence
(shared-tab re-visit) **with exactly the membership it had before**. Not one
neutral firing is a live membership change. Two consequences:

- **First-contact cost is unchanged by tier5.** On a cold page both builds
  collapse the five-star run and both pay the expand — the builder's own
  hazard probe shows `star4=e128 (via expand)` on the PRE-fix build's step 1
  (g29-red-record.md, "### PRE-FIX d0ff6c6"). The +96% is entirely the
  **warm-revisit** case: pre-fix, refs emitted on an earlier visit revived
  carrying `needsReannounce`, `runOwesReannounce` (render.ts:195) forced the
  run open, and the solver skipped the expand it pays cold.
- The pre-fix cheapness was therefore **manufactured by the revival channel
  tier5 exists to close** — dead positional refs re-binding by position
  across an absence. On this static radio group the revival happened to be
  benign; the engine cannot know that, and on the home stratum the same
  channel is the measured +0.173 wrong-el/run. The coordinator's option-(a)
  rationale survives, but for a sharper reason than "the fixture should cost
  an expand": the discount was interest paid by the defect.

## 2. The reproduction (mandate item 1)

Both bundles sha-verified against the RED record before measurement
(pre-fix rebuilt from `e9e460a` source, byte-identical `d0ff6c6c…`; post-fix
shipped `c3970981…`). `h2h.mjs --selftest --store <scratchpad> --arms
aperture-diff,aperture-redump`, scratchpad stores, $0, no cohort. Diff-arm
scripted streams, observation chars — my runs, matching the builder's
recorded table **to the byte on all 11 fixtures, both builds**:

| fixture | class | pre-fix (`d0ff6c6c`) | post-fix (`c3970981`) | Δ |
|---|---|---|---|---|
| booking-form | neutral-small | 3069 · 1F/4D+2 | 3087 | +18 |
| inventory-pick | neutral-small | 2078 | 2074 | −4 |
| account-prefs | neutral-small | 2624 | 2636 | +12 |
| **journal-comment** | **neutral-large** | **23276 · 5 steps · 1F/4D** | **45607 · 6 steps · 2F/4D** | **+22331 (+95.9%)** |
| console-quota | neutral-large | 24953 | 24965 | +12 |
| catalog-order | neutral-large | 24944 | 24947 | +3 |
| queue-positional | home | 5133 | 5385 | +252 |
| twin-queues | home | 7884 | 8184 | +300 |
| queue-resync | home | 19970 | 20906 | +936 |
| wizard-submit | home | 2782 | 2782 | 0 |
| ledger-balance | home | 1970 | 1970 | 0 |

Re-dump arm on journal-comment: 133,589 → 133,611 (builder: 133,133 →
133,054) — invariant, so the delta is a diff-arm cost, on the arm the 0.313×
claim is made of. Confirmed. Home churn is the designed severance (§5 of the
spec). The extra post-fix step is one `browser_snapshot {expand:true}` on a
~22K-char page — the solver re-paying warm what it always pays cold. Also
verified independently this session: 512/512 vitest on the shipped build;
post-fix selftest PREFLIGHTS GREEN end-to-end on the aperture arms; the
`H3\G7` invariant (diff < redump) held on every fixture including the fired
one (45,607 vs 133,611 ≈ 0.34× even at the tripwire's worst).

## 3. Mechanism, stated once

Shared tab, one registry, refs persist across navigations (the revival
feature). Visit 1: full snapshot collapses the 5-run; solver expands; radios'
refs emitted. Submit: `c-panel.replaceChildren` removes the group; burial
sets `needsReannounce` on emitted refs. Re-visit: the group returns with the
identical key set {base, #1..#4}.

- **Pre-fix:** `assignRefs` revives the old refs; `needsReannounce` forces
  the run to render expanded; star-4 addressable; no expand paid. Cheap — via
  the exact revival semantics whose home-stratum cost is the failed precision
  primary.
- **Post-fix:** the pre-pass sees absent→present as a membership delta
  (old={} vs new={5}), retires the family; fresh refs owe no re-announcement;
  the run collapses as `COLLAPSE_RUN` specifies; the consumer pays the expand.

## 4. Candidate (b), executed and dead (mandate item 2)

Prototype in the throwaway worktree: `collect()` in
`retirePositionalRebinds` skips every node whose role fails
`isAddressableRole` — non-ADDRESSABLE nodes can neither form nor join a
retirement family. Rebuilt, re-run:

- journal-comment: **6 steps · 2F/4D · 45,404 chars — byte-identical to the
  unpatched single-task run.** The same `N|0|radio|rating` and `S|…|list`
  families fire, because `radio` and `list` are both in `ADDRESSABLE`
  (walker.ts:85-90).
- What (b) *would* change: the inventory-pick `listitem` family (costless)
  stops firing. Nothing else.

(b) does not kill the +96%, does not reduce it, and buys nothing. The
precision-preservation half of the test is moot — it fails its primary
purpose. REJECTED. (The G29 legs were left unrun for this variant: a
narrowing that removes none of the cost cannot dominate anything, whatever
its guard results.)

## 5. Ruling on the tripwire itself (mandate item 3)

**Honored, not void.** A tripwire whose premise is false is void only if the
false premise exhausts its content. This one had two jobs conflated into one
number, and the false premise touches only the first:

1. *Diagnostic job:* "§2.2's stratum argument holds — the mechanism cannot
   fire on neutral markup." Falsified, and more thoroughly than the builder
   reported: the inference "no identical-sibling interactive elements (§4.2
   rule 2) ⇒ no families" ignores that (i) the identity key for form controls
   is the `name` attribute, which radio groups share *by construction* — the
   §4.2 lint checks unique accessible names, a property the key never looks
   at, so the lint is green while the family is guaranteed — and (ii)
   unnamed same-shape containers (nav lists, wrappers, listitems) key
   ordinally regardless of rule 2. Six of six neutral fixtures carry firing
   families. The tripwire caught a wrong spec argument before a cohort was
   bought on it. That is a tripwire working.
2. *Stop-ship job:* "a firing means the economics claim is damaged, stop
   everything." Mis-specified. A mechanism-count is the wrong observable for
   a cost claim: five of the six firings cost ~nothing (and were invisible to
   the builder's char-delta operationalization — an instrument that cannot
   see five of six events of its named mechanism is mis-instrumented), and
   the one that costs is confined to warm revisits, bounded at one expand
   round-trip per family reappearance, and lands on a path where
   `headtohead.md` §4.3 ("if it costs an expand round-trip, that cost is real
   and belongs in the number") and `h2h.mjs`'s solver comment (h2h.mjs:758-766)
   already pre-ruled such costs real-and-owed. A disclosed, priceable cost on
   a conceded-unmeasured claim is a *cohort* question, not a stop-ship.

**What §9.1.1 should have been** — two clauses, separated: *(cost, stop-ship)*
per neutral fixture, scripted-stream observation chars within ±2% of the
pre-fix baseline and step composition unchanged (no added F); any breach
stops the ship for diagnosis. *(mechanism, diagnostic)* log every retirement
event on neutral streams at landing; expected zero; any firing is a spec
erratum in §2.2 that must be re-derived and recorded — but a costless firing
does not stop anything. And the stratum argument itself should never have
been trusted unprobed: one grep of the neutral fixtures for shared
form-control `name` attributes, or one instrumented walk of key bases, would
have falsified it at spec time for free.

## 6. The corrected narrowing — tier5.1, recorded, not landed

The delta-class fact (§1c) implies a narrowing (b′) that (b) should have
been: **a positional family that reappears after absence with exactly the
key set the registry still holds revives; any true membership delta — live
change, grown or shrunk reappearance — retires.** For positional families
the key set is a pure function of family size, so "same set" is "same size";
same-size-across-absence churn thereby lands in precisely the hazard class
tier4 §1.4 residual 1 already accepts between consecutive live walks — b′
does not create a new silent class, it aligns the across-absence policy with
the accepted between-walks policy. Note the spec's own motivation for
covering absence (§2.3) says "reappears with **different** membership"; the
landed code quietly generalized to *any* reappearance, and 100% of the
measured neutral cost lives in that generalization.

Prototyped (throwaway worktree; dense ordinal probe of held keys; skip
retirement iff `old=∅` ∧ held-count = returning-count ∧ every returning key
held). Measured:

- **journal-comment: 5 steps · 1F/4D · 23,276 chars — the pre-fix number
  exactly.** All six neutral fixtures return to pre-fix bytes (± ref-width);
  the radio and nav-list families log `same-set reappearance, revive`.
- **Home stratum: 5385 / 8184 / 20906 — the post-fix numbers exactly.**
  Every live-delta retirement in the queue tasks still fires. The two
  residual `old=0` retirements (inventory-pick's partially-held listitems,
  queue-resync's post-churn revisit) fail the held-set check **toward
  retirement** — the conservative direction — and cost nothing.
- `test/diff-retire.test.ts` + `test/diff-rebinding.test.ts`: **19/19 green
  unmodified** — nothing in the shipped battery pins same-set-reappearance
  retirement; unit case 5 (changed-set reappearance) still retires under b′.

This is prototype-grade evidence, not a landing. A landing owes its own
mini-spec: RED-first unit pins for same-set revival and changed-set refusal,
a G29e leg (revive-across-revisit stays addressable; shrunk-set reappearance
still refuses), the full battery, and a decision on the dense-probe
edge (partially-held families). **It does not gate the cohort** (§7). Also
recorded, separately and NOT as tier5.1: the root defect for radio groups
specifically is `identityKey`'s tier order — the shared `name` attribute
outranks a unique non-generated id, so radios are positional that need never
be (keying radios by name+value would content-key every conventional radio
group). Blast radius is an identity migration for every named form control;
it needs its own probe and tier; it is not prerequisite to anything here.

## 7. Preregistration for the owed cohort (mandate: exact terms)

Measurement: §9.1.2 verbatim — ONE fresh cohort, unchanged 13-task set,
unchanged arms/model/seal/bounds (headtohead.md as amended by tier4 §7), H0
pinning the shipped post-tier5 build. The archived `dfa962c3` store is never
re-scored, never pooled. **One apparatus term is now pinned rather than
inherited silently: tab policy.** The runner keeps the archived cohort's
shared-tab-per-run protocol, and the report DISCLOSES it: warm-revisit
economics (engine-side ref persistence across episodes) is a real,
asymmetric, now-measured factor — pw arms have no warm state to reuse — and
this cohort prices it rather than hiding it.

Expected directions, both primaries, before any number exists:

- **Precision (the failed primary): §9.2 inherited verbatim.** Pooled
  wrong-el delta CI upper ≤ +0.2 (bound HOLDS); diff-arm home `wrong_choice`
  (was 27) at least halves; aperture refused-stale acts rise toward
  pw-sealed's order (75); redump−sealed (was +0.27 [0.08, 0.49]) expected to
  include 0. **Fix failed iff** §9.3.1: the primary still fails AND
  `wrong_choice` has not halved → revert tier5, reopen tier3 §3.1 with the
  new store.
- **Reliability: §9.2 inherited.** Pooled −10pp bound must hold; §9.3.2's
  refusal-loop revert condition stands unmodified.
- **Economics — REPLACES §9.2's third bullet, which is falsified in advance**
  (it predicted neutral-large "UNCHANGED within CI overlap, because the
  mechanism cannot fire there"; §1-§2 measured it firing): neutral-large is
  expected to WORSEN, attributable to journal-comment warm-revisit expand
  round-trips only (plausible band ~0.31-0.46× against pw-sealed, from the
  warm-episode fraction; the two other large fixtures within noise;
  neutral-small within noise). **Fix failed economically iff** the fresh
  neutral-large diff/pw-sealed cost ratio's CI upper is ≥ 0.5, or the diff
  arm's mean cost meets/exceeds the re-dump arm's on any neutral fixture. An
  economics failure with precision passing triggers the tier5.1 (b′) cycle
  of §6 and a re-measurement — it does NOT revert tier5; the precision
  verdict stands on its own evidence. Home economics: no bound, reported
  beside the neutral number every time (§9.2 inherited).

What `RESULTS.md`/`README` may say afterward: if precision passes, the
failing precision sentence is retired and replaced by the new cohort's
numbers citing tier5 and this ruling; economics claims are restated ONLY from
the new store and must carry (i) the shared-tab/warm-revisit disclosure and
(ii) the home number beside the neutral one. If precision fails per §9.3.1,
revert per spec. Until the cohort is adjudicated, §9.4's freeze continues
unmodified — with one bookkeeping correction permitted now: RESULTS.md's
"Pending re-measurement" causal sentence ("the fixture's star-group
*wrappers*…") is factually wrong per §1a and should cite this ruling instead;
that is record repair, not claim movement.

## 8. The cost of being wrong, both directions (mandate item 4)

**Accepting wrongly** (the regression is worse than priced): the damage is to
the only licensed advantage — but it is bounded (one expand round-trip per
positional-family reappearance per warm revisit; first contact unchanged),
it is disclosed, the cohort measures it before any claim moves, and §7's
economics bound converts "worse than priced" into a mandatory, already-
prototyped remediation (tier5.1) without touching the precision fix. Failure
mode: a delayed claim, never a false one.

**Reverting wrongly** (the tripwire honored as written): reinstates a
preregistered-primary failure of +0.173 [0.018, 0.345] wrong-el/run — landed
actions that mutate real state, silently, one row off, demonstrated on demand
(`ok click e30` → `took: r5`) — and un-guards it (G29 green requires the
fix). Failure mode: the product's controlling hazard class, shipped, to
protect a cost figure on a stratum whose claim is frozen anyway.

The asymmetry is not close, and it decides (a).

---

*Adjudication artifacts: all stores/logs under the session scratchpad;
worktrees removed; instrumented builds never entered this repo's `out/`;
main tree verified clean of adjudicator edits (this file is the sole
deliverable). Free-battery status relied on: this session's 512/512 vitest +
GREEN aperture-arm selftest on the shipped build, plus `g29-red-record.md`'s
guard record (43/43 + 3/3 + 2/2), which was not re-run.*
