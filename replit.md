# Workspace

## Overview

Pnpm workspace monorepo (TypeScript). Hosts the **H2 Family Budget** app — a personal/family budgeting app ported from a Lovable + Supabase prototype.

## Stack

- **Monorepo**: pnpm workspaces, Node 24, TypeScript 5.9
- **API**: Express 5 + Drizzle ORM + PostgreSQL, Zod (`zod/v4`) + `drizzle-zod`, Orval codegen from OpenAPI
- **Frontend**: React 18 + Vite 7, Tailwind v4, shadcn-style UI, wouter, TanStack Query
- **Auth**: Clerk (Replit-managed); see Clerk section below
- **XLSX import**: `xlsx` + `multer`

## Artifacts

- `artifacts/api-server` — Express API at `/api/*`. Clerk middleware + per-request `requireAuth` (auto-inserts `profiles` row).
- `artifacts/h2budget` — H2 Family Budget web UI (dashboard, forecast, transactions, amex, debts, avalanche, recurring, budget, bills, reports, mapping-rules, settings).
- `artifacts/mockup-sandbox` — design sandbox for component variants.

## Domain Conventions

- Money columns are `numeric(12,2)` and exchanged as **strings** in JSON.
- `transactions.amount` sign: positive = income/credit, negative = expense/debit.
- Dates are ISO `YYYY-MM-DD`. `budget_months.month_start` is always the 1st.
- `userId` is the Clerk user id (text). Every table is user-scoped; `requireAuth` is mandatory on every route.

## Key Commands

- `pnpm run typecheck` — typecheck all packages
- `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — regen API hooks + Zod from OpenAPI
- `pnpm --filter @workspace/db run push` — push DB schema (dev only)

## Auth (Clerk)

Invite-only. **Deployment prerequisite**: in the Clerk dashboard set User & Authentication → Restrictions → **Sign-up mode = Restricted** — this is the authoritative server-side enforcement (the client-side `/sign-up` block is a courtesy). Owner is identified by primary email matching `OWNER_EMAIL` (defaults to `h2hubele@gmail.com`).

`APP_URL` is **required in production** for invitations — Clerk bakes the redirect into the email at send time, so without it invites mail dead links to the ephemeral `*.replit.dev` host. `POST /invitations` and `/invitations/:id/resend` refuse with a 4xx whenever the only resolvable host is a workspace dev host or `localhost`. `INVITATION_REDIRECT_URL` overrides the full URL explicitly; otherwise the server uses `APP_URL` + `/sign-up`.

## Plaid

- **Redirect URI**: OAuth return route is `/plaid-oauth`. Set `PLAID_REDIRECT_URI=https://<host>/plaid-oauth` and add the **exact** same string to the Plaid dashboard (Team Settings → API → Allowed redirect URIs) for the matching environment. The API server logs a loud warning at boot if the value doesn't end in `/plaid-oauth`. Leaving it unset disables OAuth banks (e.g. Chase) but non-OAuth banks still link.
- **Products**: `transactions` only by default. Optional products (e.g. `liabilities`) are gated behind `PLAID_OPTIONAL_PRODUCTS_CSV` because Plaid hard-fails `/link/token/create` with `INVALID_PRODUCT` when an optional product is listed but the client isn't approved. `lib/plaid.ts` reads the var at startup and silently drops unknown names; `fetchLiabilitiesForItem` degrades to balances-only via `/accounts/get` when liabilities isn't enabled.

## Workbook Import

Sample at `artifacts/h2budget/public/sample/Hubele_Family_Budget_v36.xlsx`, downloadable from Settings. Upload via `POST /api/import/workbook` (multipart `file`). Import is **per-user destructive**: wipes the caller's transactions/budget/recurring/mapping/debts/categories and re-seeds.

See the `pnpm-workspace`, `clerk-auth`, and `react-vite` skills for workspace structure, auth, and frontend conventions.
