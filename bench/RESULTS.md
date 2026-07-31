# Benchmark results

Measured 2026-07-31. Aperture at commit `034ed1d` + the layout-table fix,
against `@playwright/mcp@latest` headless, same URLs, same day.

Reproduce: `npm run bench` for the synthetic diff model; `bench/real-sites.md`
for the method used below.

## Full snapshot, real sites

Tokens estimated at chars/4 for both, so the two are directly comparable.

| Site | Aperture | playwright-mcp | ratio | Aperture refs | pw refs |
|---|---|---|---|---|---|
| Hacker News (front page) | **9,561** | 11,993 | 1.25× | 233 | 616 |
| GitHub (anthropics/claude-code) | **5,430** | 9,523 | 1.75× | 97 | 446 |
| Wikipedia (Model Context Protocol) | **6,605** | 18,269 | 2.77× | 206 | 611 |

**Per-snapshot, Aperture is ~1.25–2.8× smaller — call it ~1.9× on average.**

### Correction to an earlier claim

The README previously said ref discipline made output "4.5× smaller," citing a
third-party measurement of a different tool (WebClaw). Aperture's own measured
figure is **1.9×**. The ref-count difference is real and large (2.6–6.3× fewer
refs than playwright-mcp) but it does not translate into a proportional token
saving, because refs are a small part of each line.

## Where the actual win is

Per-snapshot size is the smaller half of the story. The compounding factor is
that playwright-mcp re-dumps on every action while Aperture emits a diff.

For a 20-action task on the Wikipedia page:

| | playwright-mcp | Aperture |
|---|---|---|
| Initial observe | 18,269 | 6,605 |
| Per action | 18,269 (re-dump) | ~40–150 (diff) |
| **20-action total** | **~383,600** | **~9,600** |

≈ **40×**, of which ~1.9× is snapshot size and the rest is not re-dumping.

That number still rests on the diff staying small on a real site across a real
action sequence, which the synthetic bench models but this table does not yet
measure. Treat 40× as the ceiling and the 7–10× from `npm run bench` as the
conservative floor.

## What this does NOT measure

**Task success rate.** None of the above says whether an agent completes a task
as reliably reading deltas as it does re-reading the page. If it does not, the
token saving is worthless. This remains the single most important unmeasured
claim in the project.

**Ref stability under real re-renders.** The GitHub and Wikipedia pages are
largely static. A React SPA that re-renders its list on every keystroke is the
real test of the identity-key scheme, and it has not been run.

## Bug this benchmark found

Hacker News initially measured **206 tokens with 1 ref** — the entire front
page, 30 stories and several hundred links, collapsed into 4 rows of
concatenated text. `tableRows()` flattened *any* `<table>` into text and
cleared its children, and HN uses tables for layout. An agent could not click
anything on the site.

Fixed by only flattening tables with no interactive descendants. HN went from
206 tokens/1 ref to 9,561 tokens/233 refs.

This is exactly the class of failure that "verified on one form" cannot catch,
and it is the argument for running this benchmark against more real sites.
