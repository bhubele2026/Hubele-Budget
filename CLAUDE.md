# CLAUDE.md — Engineering guardrails for H2 Budget

Standing rules for all work in this repo. Read before changing anything. These
override convenience: when a rule and a shortcut conflict, the rule wins. If a
task seems to require breaking one, **stop and ask.**

H2 Budget is a personal/family budgeting app (pnpm monorepo). Its single goal is
to get the household out of debt; correctness and trust beat everything.

---

## 1. Money & correctness (non-negotiable)

- **Code computes every figure.** Every number on screen is computed in
  application code from verified records. A language model may classify a
  transaction, extract fields from a receipt, draft text, or propose a change;
  it **never computes a money figure, never writes an amount, never raises a
  budget or goal**, and every model output is validated by code (schema and
  business rules) before it touches a row. Model calls are bounded (timeouts,
  retries, per-household caps) and logged with redaction. (Owner's decision,
  2026-10-07; it replaces the 2026-08 "no AI" rule.)
- **Never change financial calculations, queries, or stored data values** while
  doing UI, routing, performance, or copy work. UI consumes existing hooks/data
  unchanged. If a change genuinely requires touching financial logic, **stop and
  ask first.**
- After any change that could affect displayed numbers, **confirm no financial
  totals changed.**
- **The north star is being out of debt.** Judge features by payoff impact.
  On landing-facing surfaces **% paid leads**; the amount left may follow as a
  **smaller, secondary line**, and its **scope is always named** ("$X left
  across <the debts it covers>"). The amount comes from the debts endpoint
  through the one shared total (`remainingDebtTotal` / `remainingDebtScope`
  in `lib/debtBalance.ts`, the same call the Avalanche and Reports Debt pages
  make, parity-tested), never from the spine: the spine is still tested to
  refuse to carry a balance at all (see §3, spine law). (Owner's decision,
  2026-10-09; it replaces "% paid, never the amount owed".)

## 2. Data fetching & performance (hard rules)

- **Never fetch unbounded transaction lists.** Every `/api/transactions` query
  must be scoped with `from`/`to` and a **small `limit` (default ≤ 100** for
  list views). Summary/aggregate pages request **server-computed aggregates**,
  not raw rows. **The `limit=5000` pattern is banned.**
- **Filter in SQL, not in the browser.** If a page keeps only some of what it
  asked for, it asked wrong — `/api/transactions` takes `uncategorized`,
  `source`, `categoryId`, `excludeTransfers`, `reimbursable`, `search` and an
  amount range. The Reports → Spending popover pulled a whole window to keep
  the uncategorized rows out of it; it now asks for those rows.
- **A capped pull discloses its cap.** The server answers newest-first and cuts
  at the limit, so a window that overflows silently loses its OLDEST rows — a
  compare-to-previous quietly drawn against half a period. A page that cannot
  move to an aggregate (Reports → Cash flow charts rows individually) says on
  screen that it is showing the most recent N. It never just truncates.
- **Every `useQuery` has an explicit, sensible `staleTime`/`gcTime`.** Slow-
  changing data (settings, version, mapping-rules, forecast)
  gets a **generous `staleTime`** so navigation doesn't refetch.
- **No duplicate or overlapping queries** for the same data. Global / slow-
  changing data is fetched **once at app level** and reused, not per page.
  Normalize query keys so identical data never loads under two keys.
- **Prefer stale-while-revalidate:** render cached data immediately, revalidate
  in the background. **Skeletons are for genuine cold loads only.**
- **Prefetch** a route's primary queries on nav-link **hover/focus** or on idle.
- **The open path is budgeted, and CI enforces it.**
  `node scripts/check-entry-graph.mjs` runs against the app's build:
  **h2budget caps landing JS at 622 KB.** It fails the build if
  landing JS exceeds its cap, if react-dom lands outside `vendor-react`, or if
  a chart library reaches a preloaded chunk. **Never add a chart to the open
  path.** Charts are lazy and never imported by anything the landing route
  pulls in (recharts, in `vendor-charts`).
  *Cap history:* raised 580 → 640 KB on 2026-10-09 (C11; 635 KB measured on main with the settings, Amex and plan panels merged beside it): the landing is now the
  full dashboard, not a six-tile door, and the measured open path is 628.6 KB
  (cap = measured + 5 KB). No panel was trimmed to fit; charts stay lazy.
  Lowered 640 → 633 KB the same day (C11b): the four below-the-fold panels load
  as one lazy chunk after first paint, and the open path measured 627.2 KB.
  Lowered 633 → 622 KB the same day (F3b): the dashboard's queries file imported
  two `features` operations, which kept the whole generated sub-module in the
  entry chunk; they now come from the main module, the sub-module is its own
  lazy chunk, and the open path measured 616.6 KB (cap = measured + 5 KB).
- **`routePrefetch.ts` and `App.tsx` move in lockstep on any route change.**
  Old links from the interim app (`/today`, `/activity`, `/plan/*`,
  `/household/*`, `/recap`, `/design`) are mapped in `lib/legacyRoutes.ts`,
  read by the lazy not-found page; they are not routes.

## 3. UI — one app, modernized (direction set by the owner on 2026-10-08)

### Which app

- **`artifacts/h2budget` IS the app, the only one.** It holds the mature
  product (forecast, review and reconciliation, Chase and Amex views, reports,
  budget, allowances, bills, debts, mapping rules, settings), modernized in
  place: new design system, real dashboard, expanded forecast, account
  identity, and the automation screens folded in. It is built with
  `BASE_PATH=/` and served at `/` (`artifacts/api-server/src/webMounts.ts`);
  its preview address `/classic/*` 301s to the same path at the root.
- **The interim stripped-down app (`artifacts/h2`) was deleted at the switch
  (2026-10-09).** Its pure logic had already been ported into `h2budget/src/lib`
  with its tests. Do not bring a second web app back: a new screen is a route
  here.
- **A fresh appearance never reduces functionality or financial visibility.**
  Every capability in `docs/reviews/2026-10-08-parity-inventory.md` must stay
  accessible in the modernized app; a link to the old page is a temporary
  fallback, not parity. Do not rewrite mature functionality to fit a layout;
  restyle it.

### "H2 evolved" — the design system (`src/index.css`, `src/ui.tsx`, `src/lib/chartTokens.ts`)

- **Identity:** navy `#19315b` / `#22406e` is the primary; orange `#f68d2e` is
  the call to action and attention accent; `#e16d3e` means something is wrong.
  **Account accents** identify money: checking/Chase in navy, the Amex card in
  the teal-green token, other cards in the third token — on chips, panel edges,
  chart series and the forecast legend. Colour reinforces identity; a label
  always says it too. **Never brown.** No Tailwind palette utilities
  (`red-*`, `green-*`, …), no arbitrary colour literals: add a token.
- **Layout:** a 12-column responsive grid — desktop two or three columns of
  panels, tablet two, phone one. Panels and cards are allowed and expected;
  so are multiple figures per screen. Useful detail beats whitespace: compact
  transaction tables (36–40 px rows), account chips with masked digits on every
  row, balances shown on account panels and the dashboard. The 720 px reading
  column and "one figure per screen" are gone.
- **Charts:** large and readable — recharts in `vendor-charts`, lazy, never on
  the landing path; readable axes and a legend; actual values visibly distinct
  from projections; hover on desktop, tap/scrub on phone; a selected day stays
  selected across refetches (key by date, never by index). `CssBars` for small
  inline bars. The chart animation must not restart on unrelated renders
  (`lib/chartAnim.ts` + the fingerprint memo in `ProjectedBalanceChart.tsx`).
- **Type:** Inter Variable, the scale in `index.css` (`--text-hero` for the one
  number a screen exists for, at most one per screen; `--text-kpi` for a tile's
  headline figure where a screen has several, e.g. the dashboard's summary row);
  mono tabular numerals for money and counts. A new step must also be taught to
  `cn()` (`lib/utils.ts`), or tailwind-merge drops it beside a text colour.
- **Motion:** purposeful and fast — horizon crossfades, stable chart updates,
  tooltip and selection markers, expand/collapse, hover/focus/press feedback,
  progress meters that count up only after data settles. Dials live in
  `index.css :root`; keep `--anim-speed` equal to `SPEED` in `chartTokens.ts`;
  `--ease-enter` for arriving, `--ease-move` for travelling. Never animate a
  payment or an improvement that did not happen. Respect reduced motion.
- **Voice:** calm, supportive, plain; the app is "H2", never "I"; no sass.

### Motion — reduced motion

- ⚠️ **The reduced-motion switch has two halves and both are load-bearing.**
  The `prefers-reduced-motion: reduce` override of the motion dials MUST stay
  **unlayered and below the base `:root`**: unlayered CSS beats layered CSS
  outright, so a `:root` override inside `@layer` is silently dead. And any
  animation written with a literal duration (per-child stagger delays, a
  skeleton sweep) needs its own `!important` kill, because no dial reaches it.
  `index.css.test.ts` pins both halves.
- Animation driven from JS (charts, scripted transitions) cannot see CSS media
  queries; gate it on `matchMedia("(prefers-reduced-motion: reduce)")` in code.

### ⭐ The spine — one snapshot, many surfaces

`GET /api/spine` computes the shared household snapshot server-side in one pass
(bank roll-forward, spend windows, next bill, forecast low point/runway/cash
buffer/verdict, debt payoff %, position, review count). Every field is produced
by **the same function the owning page's endpoint calls** — never reimplemented.

- **Any number the spine carries is read from `useSpine()`, never recomputed
  locally.** A page that re-derives its own copy is how two tiles come to
  disagree.
- **The parity contract is tested, not hoped for.**
  `api-server/src/__tests__/spineParity.integration.test.ts` asserts each spine
  field equals its owning endpoint **to the cent**, and asserts the spine never
  carries a debt balance or amount owed (the landing leads with % paid, and its
  secondary "$X left across …" line reads the debts endpoint through the shared
  total; account panels show balances from the account endpoints). If you add a spine field,
  add its parity assertion in the same PR.
- Mutations invalidate the spine centrally through the `mutationCache` in
  `App.tsx` (`lib/mutationInvalidation.ts`) — not with hand-written
  invalidations.

### Other UI rules

- **User identity/name comes from a single source of truth** (Clerk
  `user.firstName`). Copy stays name-neutral or uses that one source.
- **No route may render a blank screen.** Unfinished/loading routes show a
  placeholder or skeleton **inside the shared layout**, never a white page.
- **Account identity is unmissable:** every transaction row shows institution,
  account or card name, masked digits where useful, pending/posted, and the
  category separately. Missing balance fields (statement balance, minimum, due
  date) stay blank — never zero, never an estimate.
- **Send-to-Forecast is a single flow.** Sent = in review = on the curve. Never
  re-add a separate review gate.
- **Bundle:** the landing path is budgeted (`scripts/check-entry-graph.mjs`,
  h2budget 622 KB). Investigate chunking (route-level chunks, lazy panels,
  `vendor-charts`) before removing a capability; a cap may rise only with a
  written justification in the PR.

## 4. Workflow

- **Branch per task; PR per task.** Never commit directly to `main`; never
  force-push. Keep PRs small and focused.
- After each change run **typecheck + build** (and tests where they apply); CI
  must pass. **Wait for review before merge.**
- New/changed API: edit `lib/api-spec/openapi.yaml`, run codegen, implement the
  route, consume the **generated** hook. Never hand-write client hooks. The
  committed generated `api-zod`/`api-client-react` must match the spec (codegen
  is not in the deploy build).
- **Commit `pnpm-lock.yaml` on any dependency change**, regenerated with pnpm
  10.34.3 exactly.
- **Adding a dependency needs a named justification.** The overhaul removed
  dozens; the entry-graph guard exists because weight is a feature here.
- **Schema changes ship as idempotent SQL files in `lib/db/migrations/`.**
  Migrations run at server boot, before listen (`src/boot.ts`, on unless
  `MIGRATE_ON_BOOT=false`), or by the pre-deploy command
  (`node artifacts/api-server/dist/migrate.mjs`); both use the same idempotent
  runner, and a failure keeps the old build serving. **Additive only; never
  DROP in the same release as the code that stops reading;** backfills are
  idempotent and live in the same file. Dev and tests keep `drizzle-kit push`, and the drizzle schema
  remains the type source and **must match the SQL** (tested). Conventions and
  reserved number ranges: `lib/db/migrations/README.md`.
- **Background jobs run on pg-boss** (Postgres-backed, idempotent handlers);
  node-cron is retired.

---

## Repo quick reference

- **Stack:** pnpm workspaces, Node 24, TS 5.9. API = Express 5 + Drizzle +
  PostgreSQL + Zod + Orval. Web = React + Vite + TanStack Query + wouter + Clerk.
- **Packages:** `artifacts/api-server` (Express `/api/*`, and it serves the
  web build), `artifacts/h2budget` (THE web app, at `/`), `lib/api-spec`
  (OpenAPI), `lib/api-zod` + `lib/api-client-react` (generated), `lib/db`
  (Drizzle schema + `migrate.ts` runner, exported as `@workspace/db/migrate`),
  `lib/db/migrations` (the SQL that production runs), `lib/avalanche-core`
  (shared payoff maths). `lib/db/drizzle/*.sql` is legacy history; nothing runs
  it.
- **Commands:**
  - `pnpm run typecheck` — singleton-dep check + typecheck all packages (the green gate)
  - `pnpm run build` — typecheck + build every package
  - `node scripts/check-entry-graph.mjs` — open-path weight guard (run after a build)
  - `pnpm --filter @workspace/api-spec run codegen` — regen API hooks + Zod
  - `pnpm --filter @workspace/db run push` — push DB schema (dev and tests only)
  - `node artifacts/api-server/dist/migrate.mjs` (or `pnpm --filter
    @workspace/api-server run migrate`) — apply pending `lib/db/migrations`
    files to `DATABASE_URL`; idempotent (after a build). The server does the
    same at boot unless `MIGRATE_ON_BOOT=false`.
- **Tests:** `pnpm --filter h2budget exec vitest run` (the web app, jsdom) and
  `pnpm --filter api-server exec vitest run` (API
  integration — needs a real Postgres and `DATABASE_URL` + `ALLOW_TEST_DB=1`).
  Parallel agents must use **separate test databases**. The API suite runs
  **serially** (`fileParallelism: false`): `singleFork` alone still let Vitest
  interleave files against one Postgres, which flaked `plaidRefreshUserRetry`
  about one run in three. Do not turn it back on to buy the ~60s back.
- **Two dependencies carry a story** (`pnpm audit --prod` must stay at 0 high):
  `xlsx` is installed from the **SheetJS CDN tarball**, not npm — npm's last
  publish (0.18.5) has two unfixable highs. ⚠️ A tarball URL has no registry
  metadata, so pnpm records **no `integrity`** for it and
  `install --frozen-lockfile` then refuses the package (CI and Render both die
  at install). The `integrity: sha512-…` in `pnpm-lock.yaml` is therefore
  **hand-computed**: if you ever move that URL, recompute it
  (`sha512-$(openssl dgst -sha512 -binary file.tgz | base64)`) or CI will fail
  before it runs a single test. `js-cookie` is pinned by override for
  GHSA-qjx8-664m-686j; Clerk ships the fix on `@clerk/shared` >=4.20.
- **Deploy:** GitHub `main` is the source of truth; **Render** auto-deploys
  `main` (single Web Service `h2budget` serving both web apps + `/api`, health
  check `/api/healthz`, live at https://h2budget.onrender.com). Pending
  migrations run when the new build boots, before it listens (and by the
  Pre-Deploy Command once it is set in the Render dashboard — the service was
  created through the API, so `render.yaml` is informational and a Blueprint
  sync must never be run). **A failing migration keeps the old build
  serving.** Pinned `packageManager: pnpm@10.34.3`, Node 24. Verify
  `/api/version` matches the merge SHA after deploy. (Replit remains only as a
  dormant rollback.) Never deploy unreviewed work.
