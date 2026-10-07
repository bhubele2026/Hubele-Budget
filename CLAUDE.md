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
  Landing-facing surfaces show **% paid, never the amount owed** — the spine is
  tested to refuse to carry a balance at all (see §3, spine law).

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
- **The open path is budgeted per app, and CI enforces it.**
  `node scripts/check-entry-graph.mjs` runs against each web app's build:
  **classic caps landing JS at 580 KB, h2 at 400 KB.** It fails the build if
  landing JS exceeds its cap, if react-dom lands outside `vendor-react`, or if
  a chart library reaches a preloaded chunk. **Never add a chart to the open
  path.** Charts are lazy and never imported by anything the landing route
  pulls in (classic: recharts, in `vendor-charts`; h2: small SVG only).
- **`routePrefetch.ts` and `App.tsx` move in lockstep on any route change —
  in each app.**

## 3. UI — two apps during the transition

### The two-app rule

- **`artifacts/h2` is the new app, served at `/`.** All new UI work lands
  here, on the **"Paper & rule"** design system below.
- **`artifacts/h2budget` is CLASSIC: frozen.** Hotfixes only (a wrong figure,
  a broken flow) — no features, no redesign, no new dependencies. It is served
  at **`/classic`** and is **deleted at the end of the reinvention program**.
  Its old design laws (see "Classic, inside it only" below) apply **only inside
  `artifacts/h2budget`**. Never import across the two apps; shared logic moves
  to `lib/` or is ported.

### Paper & rule — the design system for `artifacts/h2`

There is one kit, `artifacts/h2/src/kit/`, and it is small. Reuse it; do not
invent a second one.

- **Semantic colour tokens only:** `paper` (the ground), `ink` (text), `moss`
  (the accent), `clay` (needs attention), `ochre` (caution), `slate`
  (secondary text and rules). Components use the token utilities — **no raw
  hex, no arbitrary colour literals, no Tailwind palette colours** (`red-*`,
  `green-*`, `blue-*`, …). If you need a colour, add a token.
- **Three faces, each with one job:** **Public Sans** for UI text; **Source
  Serif 4** for headlines and section labels; **IBM Plex Mono with tabular
  numerals** for money and counts. Digits that don't line up are the loudest
  "nobody designed this" signal on a financial screen.
- **Hairline rules, not cards.** Sections are separated by a rule and a label,
  not boxes, shadows or stat-card grids.
- **Light only.** No `dark:` variants and no theme toggle. The tokens are
  semantic so a dark theme can be added later without touching components.
- **Status is never colour alone.** A word says the state; colour only
  reinforces it.
- **One hero figure per screen** — the one number the screen exists to answer.
  A screen gets one or none.
- **Word diet.** No sentence where a label works; explanations go behind a
  disclosure. Zero exclamation marks, zero cute copy.
- **Voice:** calm, supportive, plain. The app calls itself **"H2"**, never
  "I".

### Motion — reduced motion (both apps)

- ⚠️ **The reduced-motion switch has two halves and both are load-bearing.**
  The `prefers-reduced-motion: reduce` override of the motion dials MUST stay
  **unlayered and below the base `:root`**: unlayered CSS beats layered CSS
  outright, so a `:root` override inside `@layer` is silently dead. And any
  animation written with a literal duration (per-child stagger delays, a
  skeleton sweep) needs its own `!important` kill, because no dial reaches it.
  Each app pins both halves in a CSS test.
- Animation driven from JS (charts, scripted transitions) cannot see CSS media
  queries; gate it on `matchMedia("(prefers-reduced-motion: reduce)")` in code.

### ⭐ The spine — one snapshot, many surfaces

`GET /api/spine` computes the shared household snapshot server-side in one pass
(bank roll-forward, spend windows, next bill, forecast low point/runway/cash
buffer/verdict, debt payoff %, review count). Every field is produced by **the
same function the owning page's endpoint calls** — never reimplemented.

- **Any number the spine carries is read from `useSpine()`, never recomputed
  locally** — in either app. A page that re-derives its own copy is how two
  tiles come to disagree, which is exactly what this endpoint exists to make
  impossible.
- **The parity contract is tested, not hoped for.**
  `api-server/src/__tests__/spineParity.integration.test.ts` asserts each spine
  field equals its owning endpoint **to the cent**, and asserts the spine never
  carries a debt balance or amount owed. If you add a spine field, add its
  parity assertion in the same PR.
- Mutations invalidate the spine centrally through the `mutationCache` in each
  app's `App.tsx` — not with thirty hand-written invalidations.

### Other UI rules (both apps)

- **User identity/name comes from a single source of truth** (Clerk
  `user.firstName`). No "Brad" vs "Hannah" drift; user-facing copy stays
  name-neutral or uses that one source.
- **No route may render a blank screen.** Unfinished/loading routes show a
  placeholder or skeleton **inside the shared layout**, never a white page.
- **Voice (UI microcopy):** serious, supportive, professional — calm, clear,
  genuinely helpful. **No sass, no profanity, no roasting** (the owner
  explicitly reversed the earlier savage voice in 2026-07). Tie copy to real
  numbers and next actions; frame partial periods as "so far".
- **Send-to-Forecast is a single flow.** Sent = in review = on the curve. Never
  re-add a separate review gate.

### Classic, inside it only (`artifacts/h2budget`, frozen)

These laws bind a classic hotfix and nothing else:

- The kit: `src/ui.tsx` (page furniture), `src/lib/chartTokens.ts` (palette and
  chart maths), `src/lib/charts.tsx` (recharts, lazy only), `src/lib/cssBars.tsx`
  (hover-scrubbed lists are CSS bars, never recharts), `src/index.css` (every
  token), `src/components/viz/*`.
- Navy + orange only (`#19315b` / `#22406e`, `#f68d2e` accent, `#e16d3e` means
  something is wrong), the platinum ramp, `NAVY_RAMP` by rank, `CAT8` capped at
  8. No banned Tailwind colour utilities, no arbitrary colour literals, no
  colour aliases (`chartTokens.test.ts` asserts this).
- Inter Variable and the 6-step type scale only; mono tabular numerals for money
  and counts; no dark mode.
- Motion dials in `index.css :root`; keep `--anim-speed` equal to `SPEED` in
  `chartTokens.ts`; `--ease-enter` for arriving, `--ease-move` for travelling;
  recharts gated by `PREFERS_REDUCED_MOTION`; `index.css.test.ts` pins the
  reduced-motion halves.

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
- **Packages:** `artifacts/api-server` (Express `/api/*`), **two web apps
  during the transition** — `artifacts/h2` (the new app, `/`) and
  `artifacts/h2budget` (classic, frozen, `/classic`) — `lib/api-spec`
  (OpenAPI), `lib/api-zod` + `lib/api-client-react` (generated), `lib/db`
  (Drizzle schema + `migrate.ts` runner, exported as `@workspace/db/migrate`),
  `lib/db/migrations` (the SQL that production runs), `lib/avalanche-core`
  (shared payoff maths). `lib/db/drizzle/*.sql` is legacy history; nothing runs
  it.
- **Commands:**
  - `pnpm run typecheck` — singleton-dep check + typecheck all packages (the green gate)
  - `pnpm run build` — typecheck + build every package
  - `node scripts/check-entry-graph.mjs` — open-path weight guard (run after a build, per app)
  - `pnpm --filter @workspace/api-spec run codegen` — regen API hooks + Zod
  - `pnpm --filter @workspace/db run push` — push DB schema (dev and tests only)
  - `node artifacts/api-server/dist/migrate.mjs` (or `pnpm --filter
    @workspace/api-server run migrate`) — apply pending `lib/db/migrations`
    files to `DATABASE_URL`; idempotent (after a build). The server does the
    same at boot unless `MIGRATE_ON_BOOT=false`.
- **Tests:** `pnpm --filter ./artifacts/h2 exec vitest run` (new web) and
  `pnpm --filter h2budget exec vitest run` (classic web), both jsdom, and
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
