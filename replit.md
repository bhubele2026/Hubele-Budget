# Workspace

## Overview

Pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.
Currently hosts the **H2 Family Budget** application — a personal/family budgeting app ported from a Lovable + Supabase prototype.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React 18 + Vite 7, Tailwind v4, shadcn-style UI, wouter router, TanStack Query
- **Auth**: Clerk (Replit-managed). **Invite-only — deployment prerequisite**: in the Clerk dashboard, set User & Authentication → Restrictions → **Sign-up mode = Restricted** so that only users with a Clerk invitation can create an account. The app's `/sign-up` route also blocks direct visits client-side, but Restricted Mode is the authoritative server-side enforcement and must be enabled before deploy. Owner is identified by primary email matching the `OWNER_EMAIL` env var (defaults to `h2hubele@gmail.com`).
  - **`APP_URL` is required for invitations to work in production.** It must be the public app URL (e.g. `https://h2budget.example.com`) — the same value already used for Plaid reconnect emails. Invite emails sent by Clerk bake the redirect URL into the email at send time, so without `APP_URL` the server would mail dead links pointing at the ephemeral, gated `*.replit.dev` workspace dev host. As a safety net, `POST /invitations` and `POST /invitations/:id/resend` refuse with a 4xx and a clear message ("This server isn't configured with a public app URL yet…") whenever the only resolvable host is a workspace dev host (`*.replit.dev`, `*.repl.co`) or `localhost`. `INVITATION_REDIRECT_URL` may be set to override the full URL explicitly; otherwise the server uses `APP_URL` + `/sign-up`. Once `APP_URL` is set, the owner can simply hit "Resend" on the previously broken invitation to send the recipient a fresh, working link.
- **XLSX import**: `xlsx` + `multer`

## Artifacts

- `artifacts/api-server` — Express API at `/api/*`. Auth via Clerk middleware + per-request `requireAuth` (auto-inserts `profiles` row).
- `artifacts/h2budget` — H2 Family Budget web UI. Pages: `/`, `/sign-in`, `/sign-up`, `/dashboard` (cards + allowance buckets + reimbursables + bulk-mark-paid), `/forecast` (event/txn triage + monthly closeout + rescheduled overrides panel), `/transactions` (BucketBubbles, running balance, category URL param filter), `/amex` (owedBy auto-suggest datalist, bulk reimbursable, source breakdown badges), `/debts`, `/avalanche` (focus highlight from Bills, archived debts card), `/recurring`, `/budget` (actuals popover, clickable category→transactions nav), `/bills` (archived debts card, debt-min→avalanche nav), `/reports` (cashflow, budget vs actual, category mix), `/mapping-rules` (search/filter, inline edit), `/settings`. Phase 2 added tables `forecast_resolutions`, `forecast_closed_months`, `forecast_settings`, `dashboard_budgets` and endpoints `/forecast`, `/forecast/settings`, `/forecast/resolutions`, `/forecast/closed-months`, `/dashboard-budgets`. Phase 3 features: Plaid webhook, auto-create debts, auto-refresh bank snapshot, balance trend chart on Forecast.
- `artifacts/mockup-sandbox` — design sandbox for component variants.

## Domain Conventions

- All money columns are `numeric(12,2)` and exchanged as **strings** in JSON.
- `transactions.amount` sign convention: positive = income/credit, negative = expense/debit. The dashboard, importer and budget actuals all rely on this.
- Dates are ISO `YYYY-MM-DD` strings. `budget_months.month_start` is always the first of the month.
- `userId` is the Clerk user id (text). Every table is user-scoped; `requireAuth` is mandatory on every API route.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Plaid OAuth redirect URI

Plaid requires the `redirect_uri` we send in `linkTokenCreate` to match
an entry on the Plaid dashboard's "Allowed redirect URIs" list **exactly**.
The H2 Family Budget app's OAuth return route is `/plaid-oauth` (see
`artifacts/h2budget/src/App.tsx` and `artifacts/h2budget/src/pages/plaid-oauth.tsx`).
Non-OAuth banks bypass this and still link successfully, which is why
misconfiguration here is silent — but every OAuth institution will fail
to return to the app.

Set the env var and dashboard entry to one of these canonical values:

- **Production**: `PLAID_REDIRECT_URI=https://<your-deployment-host>/plaid-oauth`
- **Replit dev**: `PLAID_REDIRECT_URI=https://<your-repl-domain>/plaid-oauth`
  (the same value also goes into the Plaid dashboard for the sandbox client)

The exact string you set in `PLAID_REDIRECT_URI` must be added — character
for character, including scheme and trailing path with no extra slash —
to the Plaid dashboard at **Team Settings → API → Allowed redirect URIs**
for the matching environment (Sandbox / Development / Production).

The API server logs a loud warning at boot if `PLAID_REDIRECT_URI` is set
to a value that does not end in `/plaid-oauth`, so this misconfiguration
cannot sit silently. Leaving it unset is allowed (Plaid Link skips OAuth
mode entirely), but in that case OAuth banks like Chase will not work.

## Plaid product configuration

This app runs with **`transactions` only** by default. Optional products
(notably `liabilities`) are gated behind the `PLAID_OPTIONAL_PRODUCTS_CSV`
env var because Plaid hard-fails `/link/token/create` with
`INVALID_PRODUCT` when an *optional* product is listed but the calling
client isn't approved for it. To re-enable liabilities once the Plaid
Dashboard approves the product, set
`PLAID_OPTIONAL_PRODUCTS_CSV=liabilities` (comma-separated for multiple)
in Secrets — no code change required. The lib/plaid.ts constant
`PLAID_OPTIONAL_PRODUCTS` reads that var at startup and silently drops
unknown product names. When liabilities isn't enabled, the
`fetchLiabilitiesForItem` helper still returns balances via
`/accounts/get` and skips the APR/min-payment enrichment, so debt sync
degrades gracefully instead of crashing the link flow.

## One-shot cleanups

- `artifacts/api-server/scripts/clear-non-checking-forecast-flag.ts` (task #120) — clears legacy `forecast_flag = true` on any transaction whose account isn't the user's configured Chase checking account. Safe to re-run; mirrors the read-time `isBankRow` filter in `routes/forecast.ts` and `lib/cashSignal.ts`. Going forward this state is impossible: `plaidSync.ts` only sets `forecastFlag` on the configured checking account, and the Forecast read paths re-filter at query time. Run with `./scripts/node_modules/.bin/tsx artifacts/api-server/scripts/clear-non-checking-forecast-flag.ts [--apply]`.

## Workbook Import

Sample workbook lives at `artifacts/h2budget/public/sample/Hubele_Family_Budget_v36.xlsx` and is downloadable from the Settings page. Upload uses `POST /api/import/workbook` (multipart `file` field). Import is per-user destructive: it wipes the caller's transactions/budget/recurring/mapping/debts/categories and re-seeds from the workbook.

See the `pnpm-workspace`, `clerk-auth`, and `react-vite` skills for workspace structure, auth, and frontend conventions.
