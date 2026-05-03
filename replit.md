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
- **Auth**: Clerk (Replit-managed)
- **XLSX import**: `xlsx` + `multer`

## Artifacts

- `artifacts/api-server` — Express API at `/api/*`. Auth via Clerk middleware + per-request `requireAuth` (auto-inserts `profiles` row).
- `artifacts/h2budget` — H2 Family Budget web UI. Pages: `/`, `/sign-in`, `/sign-up`, `/dashboard` (cards + allowance buckets + reimbursables), `/forecast` (event/txn triage + monthly closeout), `/transactions`, `/debts`, `/recurring`, `/budget`, `/reports` (cashflow, budget vs actual, category mix), `/mapping-rules`, `/settings`. Phase 2 added tables `forecast_resolutions`, `forecast_closed_months`, `forecast_settings`, `dashboard_budgets` and endpoints `/forecast`, `/forecast/settings`, `/forecast/resolutions`, `/forecast/closed-months`, `/dashboard-budgets`. Phase 3 (avalanche/debt-payoff coupling) deferred.
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

## One-shot cleanups

- `artifacts/api-server/scripts/clear-non-checking-forecast-flag.ts` (task #120) — clears legacy `forecast_flag = true` on any transaction whose account isn't the user's configured Chase checking account. Safe to re-run; mirrors the read-time `isBankRow` filter in `routes/forecast.ts` and `lib/cashSignal.ts`. Going forward this state is impossible: `plaidSync.ts` only sets `forecastFlag` on the configured checking account, and the Forecast read paths re-filter at query time. Run with `./scripts/node_modules/.bin/tsx artifacts/api-server/scripts/clear-non-checking-forecast-flag.ts [--apply]`.

## Workbook Import

Sample workbook lives at `artifacts/h2budget/public/sample/Hubele_Family_Budget_v36.xlsx` and is downloadable from the Settings page. Upload uses `POST /api/import/workbook` (multipart `file` field). Import is per-user destructive: it wipes the caller's transactions/budget/recurring/mapping/debts/categories and re-seeds from the workbook.

See the `pnpm-workspace`, `clerk-auth`, and `react-vite` skills for workspace structure, auth, and frontend conventions.
