# scripts/perf — where the open's time goes, measured locally

Measurement only. Nothing here changes a figure, and nothing here runs in the deploy or in `pnpm run build`.

## What is measured, and where it comes from

| Layer | Source |
|---|---|
| Each API request's own time | `Server-Timing` on every `/api` response (`artifacts/api-server/src/lib/requestTiming.ts`): `total`, `db` (summed query time + count), `poolwait` (waiting for a pooled connection), `ledger` (90-day-style forecast-ledger builds this request started, + ms), `base400` (the weekly avalanche's 400-day base builds, + ms), `share` (builds joined instead of started), `auth` (Clerk middleware + `requireAuth`), and the spine's branches (`sp.*`). Durations and counts only. The same fields go to one `debug` log line per request (`LOG_LEVEL=debug`). |
| When the real numbers are on screen | `performance.mark`s from `artifacts/h2budget/src/lib/perfMarks.ts`: `h2:home-numbers-ready`, `h2:weekly-pay-ready`, `h2:page-ready:<path>` (/forecast, /review, /transactions, /amex, /reports, /banking), `h2:entry-eval`, `h2:warmup-start`, `h2:theme-repaint`, `h2:nav` per route change. LCP/CLS/INP in `window.__h2perf`. Nothing is sent anywhere. |
| The browser waterfall | Navigation + resource timing per `/api` call (with its Server-Timing) in a headless Chromium. |

In production the same header and marks are visible in DevTools (Network → Timing shows Server-Timing; Performance shows the marks).

## Running it (macOS, Postgres.app)

```sh
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$HOME/.local/node/bin:$PATH"
# 1. Seed the local perf DB (name must end in _perf; created if missing): the rich synthetic household at
#    scale 3 and 8, WEEKLY avalanche cadence, dates moved to today.
pnpm --filter @workspace/scripts exec tsx ./perf/seed.mts            # [PERF_DB=h2budget_perf] [SCALES=3,8]
# 2. Server only: each endpoint alone, the spine's branches, Home's real set together.
caffeinate -i pnpm --filter @workspace/scripts exec tsx ./perf/server-bench.mts   # [RUNS=15] → server-bench.md
# 3. The browser: cold, warm reload, cached navigation, throttled phone, two tabs, theme re-mount.
caffeinate -i pnpm --filter @workspace/scripts exec tsx ./perf/run.mts            # [ITER=15] [SCALE=8] [JOBS=off,on] [ONLY=…]
```

Outputs default to `/private/tmp/claude-501/perf/`: `households.json`, `server-bench.md`, `local-before-client.md`, and
`local-before/<jobs>/` (one HAR + one Chrome trace per scenario, `runs.json` with every run, `server.log`).

## How the local server signs in without Clerk

There are no Clerk development keys on this machine, so the harness cannot sign a real Clerk session in.
Instead (`build-server.mjs`) it bundles the REAL server (`artifacts/api-server/src/index.ts`, unchanged) with
`@clerk/express` aliased to `stubs/clerk-express.ts`, into its own folder. The stub says who is signed in from an
`x-perf-user` header; the real `requireAuth` then resolves the household from `household_members` as in production.
`server-entry.ts` refuses any database that is not local and named `*_perf`, refuses `NODE_ENV=production`, and binds
127.0.0.1. The web build (`vite.perf.config.mjs`) swaps Clerk's browser SDK for the theme guard's signed-in stand-in
and is served by that server from the same origin, exactly as Render serves the real one.

**Not measurable this way:** Clerk's own boot in the browser (clerk-js from Clerk's CDN, session refresh) and the
JWT check (`auth` reads ~0 here). `/me`'s Clerk Backend API call is instant unless `PERF_CLERK_API_MS` is set. With
Clerk dev keys in the environment (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`), the
e2e helpers (`artifacts/h2budget/e2e/helpers/clerk.ts`) could drive a real sign-in instead.

## Reading the numbers

- This laptop is much faster than production (Render: 0.5 CPU). Compare shapes (what waits on what, how many builds,
  how much is pool wait) more than absolute milliseconds; production's own `Server-Timing` gives its absolute numbers.
- `db` is a SUM over queries that often run together, so it can exceed `total`. Query time includes the event loop's
  lag in noticing a finished query: when CPU work (a ledger build) holds the loop, `db` grows too. `server-bench`
  reports the process's CPU time per request alongside.
- A shared ledger build (`lib/ledgerShare.ts`) counts once, for the request that started it; the others show
  `share;desc="1 joined"`. A 90-day build that prices the weekly plan includes its 400-day base's time.
