# C11b — the dashboard's below-the-fold panels load lazily (2026-10-09)

Branch `restore/c11b-dashboard-bundle`, base `4ca402d8`. No panel was removed or trimmed; no query, server or money change.

## What changed
- First screen stays eager: Today briefing, account cards, cash position, spending, upcoming.
- Cash-flow forecast, Debt, Recent activity and Needs review are one lazy chunk (`BelowFold`), started when the browser is idle after first paint (`requestIdleCallback`, 1.5 s timeout; a 0 ms timer where it does not exist). The recharts chunk is still a further lazy import inside the forecast panel.
- Until the chunk arrives, four skeleton panels stand in (`BelowFoldSkeleton`). `belowFoldSizes.ts` holds one span, minimum height and entrance step per panel and feeds BOTH the real panel and its skeleton, so they are the same size by construction and nothing jumps.
- The three hooks only the lazy panels read (categories, review queue, duplicate count) moved from `queries.ts` to `queriesLazy.ts`, so they join the lazy chunk. The `features` allowance on the entry path is unchanged in shape and is already only what the first screen needs (the recap preview and the money position, both read by the first-screen panels).

## Bundle
Open path before: 635,088 bytes (635.1 KB). After: **627,242 bytes (627.2 KB)**, down 7.8 KB. The cap in `scripts/check-entry-graph.mjs`, `CLAUDE.md` section 2 and `.github/workflows/ci.yml` is lowered 640 to 633 KB (measured + 5 KB), with the written reason updated in the script header and CLAUDE.md. The saving is modest because the heavy parts of the open path are the shell, Clerk and the first screen; the lazy panels were small.

## Tests
- `DashboardPage.test.tsx`: first screen eager, skeletons then panels in order; each skeleton's span and minimum height equal its panel's constant.
- `featuresImportGraph.test.ts`: the five lazy files, `queriesLazy.ts` and `ProjectedBalanceChart.tsx` are not on the open path; the first-screen panels are; nothing on the open path imports `recharts`.
- Existing panel tests pass with the lazy queries module mocked beside `queries`.

## Gates
typecheck clean; vitest UTC 1,630 passed / 4 skipped, America/Chicago 1,632 passed / 2 skipped; build OK; open path 627.2 KB of 633 KB, no recharts on open; audit 1 high, already ignored. `perf-open.spec.ts` unchanged: the chart chunk still must not load before `load`, and now loads later still.
