# C11 — The dashboard is the landing (2026-10-09)

Branch `restore/c11-landing-dashboard`, base `b47d0997`. Parity doc §8 C11. No server, spec or query change; the spine is untouched (no balance added to it).

## What changed
- `/home` renders the dashboard page (`pages/next/Dashboard.tsx`), statically imported by `App.tsx` (eager, like the old landing). The six-tile door (`pages/landing.tsx`, `landing.test.tsx`) is deleted; its routes live on in the ribbon. `/next/dashboard` redirects to `/home`. `/` still redirects to `/home`.
- Header and ribbon now show on `/home`; the full-bleed special case is gone (`layout.tsx`). `/home` is in no area, so the ribbon is the five destinations. The preview banner no longer links the Dashboard.
- `DashboardSkeleton` (zero numbers, panel-shaped) replaces `LandingSkeleton` while Clerk answers on a returning visit.
- `useLandingWarmup` now runs from the dashboard and warms only the next clicks (area chunks, the forecast bundle for Forecast and Review). The old first stage warmed `getDashboard`, which nothing on the landing or `/banking` read, and is gone. The layout's hover warm-up no longer fires it for `/home`.
- `/banking` and `/forecast/overview` are unchanged and keep working.

## Gap closure (command center and overview figures the dashboard lacked)
- Refresh banner with Retry (CC-01): a failed spine refresh was invisible behind the panels' `Gate`; `dash-refresh-banner` shows it.
- Runway (CC-06, FO-03): "negative in N days" or "stays positive, next 90 days" in the Cash panel's low point (`dash-runway`).
- Household spent this week and month from the spine (CC-04): `dash-spent-week`, `dash-spent-month` in the Spending panel. These differ from the panel's discretionary meters, so both are shown and labelled.
- Biggest one-off charges: top 8, not 5 (CC-13).
- Already on the dashboard, kept: low point, "Why this number?" (`BankBalanceWhy`), freshness line, per-bank Sync and reconnect states, allowances used, the debt panel's total balance (read from the debts endpoint, never the spine) beside % paid.
- Build version label (LND-09): `dash-version` at the foot of the page.
- Not ported, because `/banking` and `/forecast/overview` stay: the spending strip (CC-07), the allowance week/month pagers and `?view=` links (CC-11/12), sync-all (CC-09), biggest bills ahead (FO-07). Nothing is lost; they remain on those pages.

## Bundle
Landing JS measured with the dashboard eager: **628,631 bytes (628.6 KB)**, up from 564.2 KB. Recharts is not on the open path (the forecast panel's chart stays lazy). The cap in `scripts/check-entry-graph.mjs`, `CLAUDE.md` section 2 and `.github/workflows/ci.yml` is raised 580 to 634 KB (measured + 5 KB), with the written reason in the script header and in CLAUDE.md: the landing is now a full dashboard, not a door, and nothing was trimmed to fit.
- `featuresImportGraph.test.ts` gains one named allowance: `pages/next/dashboard/queries.ts` may import `/features` on the entry path (the recap preview and money position). Only the hooks it uses join the entry chunk. Every other entry-path file, and `/ledger`, are still held to the old rule.

## e2e
`perf-open.spec.ts` rewritten for the new landing with a written reason: vendor-charts still must not load during the open window; `/api/transactions` may fire on `/home` but only as at most two bounded reads (`from`, `to`, `limit` at most 100: the Spending and Activity windows). Typechecks; not run (needs Clerk and a DB). `a11y-smoke` still visits `/home`.

## Tests
`DashboardPage.test.tsx` (panel order, launcher, version, warm-up, refresh banner with Retry, skeleton has no numbers), three new dashboard panel tests (runway, spine spent, top 8), `routes.test.tsx` rows (`/`, `/home` to the dashboard in no area; `/next/dashboard` lands `/home`), `appShell.test.tsx` (header present on `/home`), `featuresImportGraph.test.ts` (allowance).

## Gates
typecheck clean; vitest UTC 1,547 passed / 4 skipped, America/Chicago 1,549 passed / 2 skipped; build OK; landing 628.6 KB of 634 KB, no recharts on open; audit 1 high, already ignored.
