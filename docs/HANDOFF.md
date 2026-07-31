# Handoff — the one thing blocking everything else

## Current state

175 tests pass. The browser runs, the MCP server works, `browser_act` closes
the act-observe loop, and Claude Code can drive it end to end.

**One benchmark is RED, and it gates the project's central claim.**

```bash
npm run bench:fidelity -- <token> form       # GREEN
npm run bench:fidelity -- <token> rerender   # RED — 6 phantom refs
```

## Why this specific red matters more than it looks

A *phantom* is a ref the agent believes exists, per the diff stream it was
given, that does not exist on the page. It is the precondition for a
wrong-element click, and **it fails silently**: actions succeed, diffs stay
small, refs look stable, and the agent's model drifts away from reality with
no error anywhere.

Until `rerender` is green:

- **Do not use Aperture agentically against re-rendering pages.** Static pages
  and forms are fine and measured green.
- **The task-success benchmark is not worth running.** Measuring whether a
  model succeeds on an unfaithful diff stream tells you nothing about the
  design, only about the bug.

## How to reproduce

```bash
npx http-server test/fixtures -p 8899 --silent &
npx electron . > /tmp/ap.log 2>&1 &
sleep 15
TOK=$(grep -oE "Bearer [A-Za-z0-9_-]+" /tmp/ap.log | head -1 | cut -d' ' -f2)
node bench/fidelity.mjs "$TOK" rerender
```

Fixture: `test/fixtures/rerender.html` — every keystroke calls
`replaceChildren()` and rebuilds the list. No ids, no `data-testid`, no node
reuse. Three successive filters: `anker`, `dock`, `a`.

## Already fixed — do not re-litigate

| fix | file | effect |
|---|---|---|
| `! replaced` now names destroyed refs via `gone:` | `diff.ts`, `render.ts` | phantoms 8 → 6 |
| Identical siblings key on a distinguishing neighbour | `walker.ts` `siblingDiscriminator` | button follows its product through a filter |
| Containers take only an explicit name | `walker.ts` `explicitName` | container identity no longer changes when its contents do |

## Leading hypothesis — unverified, be skeptical

`RefRegistry.ensureRef` **revives** a dead ref when its identity key reappears.
That exists so a tabbed UI returning to a previous view keeps its refs. Across
three successive filters a ref can die, revive, and die again, and the diff
stream may not narrate that cycle unambiguously.

There is a real open design question underneath: **is revival compatible with a
diff stream at all?** If a ref can come back from the dead without an explicit
announcement, no model can maintain an accurate mental model by construction.

Other candidates not yet ruled out:
- The retained old tree may be mutated in place between observations
  (`redactTainted` and friends mutate nodes in `engine.ts`).
- The harness itself may have a parsing gap — refs nested inside a
  `! replaced` block are parsed by the same regex as top-level lines. **If the
  harness is wrong, the engine may be fine and this RED is spurious.** That is
  a legitimate outcome and should be checked first, not last.

## Method that has actually worked on this codebase

Five times this session something marked "working" turned out broken the moment
it was measured end to end: the crash pipeline, the HN snapshot, the UA client
hints, and the benchmark harness twice. The pattern was always the same — the
unit tests and the assumption agreed with each other, and only the real output
disagreed.

**Instrument and compare against ground truth. Do not reason from the code
alone.** For this bug: dump, per step, the ops emitted, the `gone:` list, the
refs in the new subtree, the harness model, and the true refs. Find the exact
step and ref where they diverge. The six phantoms may not share one cause.

## Invariants any fix must preserve

- A ref must never appear in `gone:` and in the new subtree of the same op.
- A ref that is revived must be announced in a way a model can act on.
- `form` must stay GREEN.
- Refs must remain stable for named elements through a full re-render
  (measured, see `bench/RESULTS.md`).

## After this is green

1. Task-success benchmark: diff mode vs re-dump mode over a fixed task set,
   scoring completion **and wrong-element actions**. The second metric is the
   interesting one.
2. Shorten the `<untrusted-page-content>` envelope on continuation responses —
   measured at ~109 tokens against a ~15-token diff payload, so it dominates
   small observations (`bench/RESULTS.md`).
3. Vault fill path — unblocked now that the consent dialog exists.
4. Web Bot Auth, before the 2026-09-15 Cloudflare deadline the README cites.
