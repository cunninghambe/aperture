# Tier 1 designs — decisions of record

Three designs architected 2026-07-31. Each is decision-complete; this file
records the **load-bearing calls and their reasoning** so an implementer can
proceed and a reviewer can tell a deviation from a decision.

Implementation order is forced: **envelope → select → task-success**. The first
two both rewrite large parts of `src/mcp/tools.ts`, and the benchmark consumes
both.

---

## 1. Untrusted-content envelope — shrink the per-response cost

**Status: handed to implementation.**

### The call

**There is no "first form" and no "continuation form". One uniform, minimal,
nonce-bearing envelope, and the explanation moves into the tool descriptions.**

Why that dissolves the problem: the snapshot system needs its in-band
`FULL SNAPSHOT` reset header because its state lives *in the transcript*, where
compaction can destroy it. The envelope's only state is its *meaning*, and
meaning can live in tool descriptions — which the client re-sends with every API
request and which therefore **survive compaction by construction**. A
verbose-first-response scheme is strictly worse: it needs server-side "have I
explained yet" state that is wrong after compaction, wrong after reconnect, and
wrong with two clients.

### Wire format

```
<untrusted-page-content id=9f3a1c58 origin=https://example.com>
{body}
</untrusted-page-content id=9f3a1c58>
```

422 chars → 104. ~79 tokens saved per wrapped response; a typed action drops
~124 → ~45.

### Decisions worth not re-litigating

- **Nonce is per-call, 8 hex.** Lifetime does not affect token cost at all — the
  string prints in both tags regardless — so per-session/per-tab buy nothing and
  create a stable target. The cost lever was *length*, not lifetime.
- **Shrinking 16 → 8 hex is safe because breakout never depended on secrecy.**
  The true closing tag contains the nonce; the nonce is stripped from the body;
  therefore the true closer cannot appear in the body *even if the attacker knows
  it*. The strip is the hard guarantee; unpredictability is defence-in-depth.
- **Strip case-insensitively** — a forged `ID=9F3A1C58` must not survive to
  fuzzy-match.
- **Wrong-nonce forgeries pass through untouched.** Stripping attacker-chosen
  non-nonce text would itself be an edit oracle.
- **Harness speech moves outside the envelope.** Three call sites wrapped `ok …`
  acknowledgements *inside* — the browser impersonating page content, the exact
  confusion the envelope exists to prevent, inverted.

### What the audit found, which was worth more than the saving

`browser_tabs` list and the `browser_fill_form` plan were **not wrapped at all**
— page-authored titles and field labels flowing bare into agent context. The
obstruction error interpolated page-authored `r.obstructor` bare. Net security
direction is positive, not neutral.

### Honest floor

A 15-token diff still pays a ~26-token envelope. That is the floor for a
nonce-bearing, self-describing, origin-labelled boundary; lower means dropping
one of the three. Recommendation: don't.

---

## 2. `select` action — make dropdowns usable

**Status: designed, queued behind the envelope (both rewrite `tools.ts`).**

### The calls

| Question | Call |
|---|---|
| Native `<select>` mechanism | Isolated-world `HTMLOptionElement.prototype.selected` setter + `input` then `change`. **No CDP, no popup, no keyboard.** |
| One action for native + custom? | **No.** `select` is native-only; ARIA comboboxes use existing `click`, enabled by restoring `option` to `ADDRESSABLE` behind a `synthetic` guard |
| How the agent tells them apart | Native selects **always** emit `[N options]`; nothing else ever does |
| Matching | 5 exact-first tiers; ambiguity **errors with candidates, never guesses**; no edit distance anywhere |
| Discovering a 51-option list | Extend the existing `browser_read ref` scoped read |
| Multi-select | Supported, replace semantics, said aloud in the result. Additive deferred |
| Optgroups | Passive (shown in listings/errors). Qualified `"group > label"` deferred |

### Why the prototype setter, specifically

`select.value = x` fails on React: React instruments the **instance** `value`
property, so writing through it updates React's cached value, React sees "no
change", the event is deduplicated, and the controlled component snaps back.
Mutating the *option* bypasses that instrumentation entirely, so the tracker
goes stale and the dispatched `change` reads as genuine. This is the path
Playwright and Puppeteer have used against the production web for years.

Keyboard/CDP was rejected on evidence, not taste: arrow keys on a closed select
are platform-divergent (Windows changes value, macOS opens the popup), and
whether CDP key events reach an open native popup in Electron is **unverified
and doubtful** — the popup is a separate OS window outside the `WebContents`.

**Owned divergence:** `act.ts` says everything goes through CDP because
synthetic events are untrusted and detectable. That reasoning is about *input
dispatch*, where a trusted path exists. For an OS popup none does, so `select`
is state-mutation-plus-notification — same class as `aperture:fill`, and it
lives on that IPC path.

### Matching safety

Exact-before-loose is what stops the prefix trap: `"United States"` hits tier 1
uniquely and never sees `"United States Minor Outlying Islands"` waiting in
tier 5. Ambiguity at *any* tier stops the search rather than falling through —
falling through after an ambiguous exact tier is guessing with extra steps.
`"Victora"` is an error *with a suggestion*, not a selection.

### The trap the change creates, and its fix

Re-adding `option` to `ADDRESSABLE` would give refs to the walker's **synthetic**
option nodes for native selects — refs with no backing element, i.e. exactly the
guaranteed-failing bait the original exclusion prevented. Closed with a
`synthetic` flag honoured in `assignRefs` and at both `ensureRef` call sites in
`diff.ts`.

---

## 3. Task-success benchmark — the claim everything rests on

**Status: designed, queued last (consumes the other two).**

### What it measures

Whether an LLM completes the same fixed task set as often, with no more
wrong-element actions, observing via **diffs** versus **full re-dumps** —
everything else byte-identical.

`fidelity.mjs` proved the stream is information-complete *for a mechanical
reader*. This measures whether a **language model** does the bookkeeping. The
mechanical reader stays in the loop as a **shadow model** for failure
attribution, never for scoring.

### Architecture calls

- **Direct Anthropic API, manual tool loop.** Claude Code headless was rejected
  for a decisive reason: it ships filesystem tools, so the agent could **read the
  fixture HTML from disk and bypass observation entirely**. Not sealed, not
  reproducible.
- **Sealed 3-tool surface**: `browser_act`, `browser_snapshot`, `task_done`.
  `browser_navigate` and `browser_read` are withheld — the latter because
  innerText re-reads let the agent route around diff bookkeeping, diluting the
  variable under test. Flagged as a v2 arm.
- **One product change**, and an honest one: `observe: 'diff'|'full'` on
  `browser_act`, riding the existing `opts.full` path. Rejected an env var
  because its worst failure — silently unset — produces two identical arms and a
  false "no difference".
- **Intention-to-treat scoring**: a diff-arm run that rescues itself with
  voluntary full snapshots still scores as diff-arm, and its cost includes the
  rescues. That is production reality.

### Ground truth is NOT the snapshot pipeline

One side of it is the thing under test, and this suite's history (collapsed
ground truth, empty-model green) forbids it. The witness is **the fixture's own
JavaScript**, reporting full state to a loopback collector on `:8898`.

**Fixtures use `data-bench`, never `data-testid`** — `data-testid` is Tier-1
identity input to Aperture's ref scheme, so using it would change the very
behaviour being measured. This is the sharpest catch in the design.

### Verdict rule, preregistered before the first scored run

- **PARITY (exit 0):** success-delta CI lower bound ≥ −0.05 **and**
  wrong-element-delta CI upper bound ≤ +0.20/run.
- **REGRESSION (exit 1):** either CI entirely past its margin.
- **INCONCLUSIVE (exit 2):** anything else — licenses no README claim.

N = 20/task/arm, hard floor 5. Honest power statement to be printed: at N=20
pooled, smallest detectable drop ≈ 10 pp; per-task numbers are directional
colour, not findings.

### Eleven guards, each with an exit code

Two pre-flights spend no API budget and catch the worst vectors:

- **G1 null-agent:** every predicate must be **false** on an untouched page.
- **G2 scripted solver:** a deterministic script must pass every task in both
  arms, and each task's `mustObserve` regex must match the diff-arm observation
  stream — proving the winning information actually arrives *via diffs*.

Then: G3 re-dump arm receiving a diff → abort. G4 diff arm degenerating to fulls
below 60% → abort. G6 success with zero page actions → abort. G7 diff arm not
cheaper than re-dump (arms mislabelled) → abort. G9 wrong model served → infra.

Exit codes: `0 PARITY · 1 REGRESSION · 2 INCONCLUSIVE · 3 INFRA · 4 VACUOUS ·
5 SELFTEST`. Nonzero must never be read as "roughly green".

### Failure attribution

Every act is attributed at the moment its fixture event lands:

| Evidence | Attribution |
|---|---|
| Shadow model lacks the ref, Aperture errors | `model_bookkeeping` — the LLM missed a kill. **The interesting failure.** |
| Shadow holds it, Aperture errors anyway | `engine_ref_loss` — engine bug |
| Act lands, fixture label ≠ shadow label | `identity_mismatch` — the positional-ref hazard, live |
| Labels agree, target out of allowed set | `wrong_choice` — planning, not bookkeeping |
| Within 2 steps of a `FULL SNAPSHOT` | additionally `post_resync` |

The **difference between arms** in each category, not raw counts, says *why*
diffs hurt if they do. Categories appearing in both arms indict the engine, not
the diff design.

### What a PARITY result licenses

Exactly one sentence, model-qualified, suite-qualified, with CIs. It does **not**
license claims about other models, real websites, longer tasks, larger pages,
the budget-truncation regime, `browser_read` workflows, iframes, or any general
"agents work fine on diffs".

---

## The rule that produced all three

From the fidelity pass, and it applies to every one of these:

> When this benchmark first goes green, spend a day trying to make it lie.

Six things in one session were broken the moment they were measured end to end.
Every time, the unit tests and the assumption agreed with each other, and only
the real output disagreed.
