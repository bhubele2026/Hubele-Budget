# PR-0 — laws, migration runner, locked-category column

Branch `reinvent/pr0-laws-migrations` off `main` `8148f2a1`. First package of the 2026-10-07 reinvention; AI-0
and S0 build beside it and own the jobs/AI code and the new web app. Nothing here reads the new column yet.

## The owner's decision

On 2026-10-07 the owner approved the reinvention plan. For this package that means:

- The "no AI" rule is replaced by **"code computes every figure"**: a model may classify, extract, draft or propose,
  never compute a money figure, write an amount, or raise a budget or goal; every output is validated by code.
- A new design system ("Paper & rule") for the new app `artifacts/h2` at `/`; the current app becomes **classic**,
  frozen at `/classic`, deleted at the end.
- Schema changes ship as **idempotent SQL files run by Render's `preDeployCommand`**, with a `schema_migrations`
  ledger; dev and tests keep `drizzle-kit push`.
- The categorizer (PR-A) needs to know which categories a person chose: `transactions.category_locked_by_user`,
  backfilled from `is_transfer_user_overridden AND category_id IS NOT NULL`.

## What changed

| Area | Change |
|---|---|
| `CLAUDE.md` | §1 new law (verbatim from the brief); kept: no financial-calc changes, confirm totals, north star, % paid never owed. §2 entry-graph budget and `routePrefetch`/`App.tsx` lockstep now per app (classic 580 KB, h2 400 KB). §3 the two-app rule, Paper & rule laws, reduced-motion rule written generically, spine law unchanged, other UI rules unchanged; classic's navy/orange laws kept in a short "inside it only" block. §4 two new rules (SQL migrations; pg-boss). Quick reference: `artifacts/h2`, `lib/db/migrations`, migrate command, two web apps. |
| `lib/db/src/migrate.ts` | `runMigrations({ databaseUrl, dir, log?, lockTimeoutMs? }) → { applied, skipped }`, bare `pg`, exported as `@workspace/db/migrate` (not imported by `src/index.ts`). Takes `pg_advisory_lock(7212)`, creates the ledger, reads it **after** the lock, **verifies every applied file's sha256 before running anything**, then runs each pending file in its own transaction with its ledger row (`SET LOCAL lock_timeout = 15 s`). A failing file rolls back alone and stops the run. |
| `artifacts/api-server/src/migrate.ts`, `build.mjs`, `package.json` | Entry → `dist/migrate.mjs` (second esbuild entry, same options, no splitting). Dir = `$CWD/lib/db/migrations`, else resolved from `import.meta.url`. Exit 0 / exit 1. `pnpm --filter @workspace/api-server run migrate`. |
| `render.yaml` | `preDeployCommand: node artifacts/api-server/dist/migrate.mjs`; header explains a failing migration cancels the deploy. |
| `lib/db/migrations/` | `0001_schema_migrations.sql` (ledger only), `0002_category_locked_by_user.sql` (column + idempotent backfill), `README.md` (rules, reserved ranges, legacy `lib/db/drizzle/*.sql` note). |
| `lib/db/src/schema` | `categoryLockedByUser` on `transactionsTable`; **`schemaMigrationsTable`** in `schema/migrations.ts` (see Residual 2 — required, not optional). |
| `routes/transactions.ts` | Lock written by POST (only when the body names a category), PATCH and bulk-update (`categoryId` → lock = non-null; `null` → unlock), recategorize-by-pattern (lock), uncategorize-by-ids (unlock). |
| `openapi.yaml` + codegen | `Transaction.categoryLockedByUser`: `boolean`, `readOnly`, optional. Input schemas unchanged. Generated `api-zod` / `api-client-react` committed. |
| Tests | `schemaMigrations` (7), `categoryLockedByUser` (10), `plaidSyncCategoryLock` (3). |

## Figures that move

**None.** No read path, query or calculation reads the column, and the backfill writes `category_locked_by_user`
and nothing else. Evidence: the whole API suite (spine parity to
the cent, forecast golden, every money test) is green; the web `dist/public` is **byte-identical** to the parent's
(100 files, sha256, both built with `APP_BUILD_ID=pr0-compare`); the server bundle diff is exactly the schema column,
the ledger table, the five route writes and the generated response-schema fields.

## Must not change

- Plaid sync's upserts (`lib/plaidSync.ts` cursor and gap-backfill `onConflictDoUpdate`) never write `category_id`
  or the lock — confirmed by reading both conflict sets; pinned by `plaidSyncCategoryLock`.
- `dist/index.mjs` and `startCommand` — unchanged; the bundle boots (`/api/healthz` 200, `/api/version` 200,
  unauthenticated `/api/transactions` 401).
- A client cannot set the lock: the input schemas strip it (tested).

## Tests

### Fails before (new tests run on parent `8148f2a1`, DB pushed from the parent schema)

| Test file | Result on parent | Symptom |
|---|---|---|
| `schemaMigrations.integration.test.ts` (7) | file fails to load | `Missing "./migrate" specifier in "@workspace/db" package` |
| `categoryLockedByUser.integration.test.ts` (10) | 10 / 10 fail | POST/PATCH response `categoryLockedByUser` is `undefined` (expected `true`); reading the column: `TypeError: Cannot convert undefined or null to object` (no such drizzle column) |
| `plaidSyncCategoryLock.integration.test.ts` (3) | 3 / 3 fail | same `TypeError` — the column does not exist |

### Mutations (each applied alone on this branch, then reverted)

| Mutation | Caught by |
|---|---|
| M1 `0002` column nullable | replay drift check (`is_nullable` YES ≠ NO) |
| M2 `0002` backfill removed | replay backfill assertion |
| M3 advisory lock removed | two-runners test |
| M4 checksum checked inline instead of up front | "edited file stops the run before ANY pending file" (a lower-numbered pending file ran first) |
| W1–W5 drop the lock write in POST / PATCH / bulk / recategorize / uncategorize | the matching writer test, one each |
| W6 sync conflict set writes `categoryLockedByUser: false` | sync re-send test |
| W7 sync conflict set writes `categoryId` | sync re-send test |
| W8 PATCH locks on every edit | 3 PATCH tests |

How the drift check works: a scratch schema gets a pre-migration copy of `transactions` (`LIKE public.transactions`,
the added column dropped, seeded rows); the runner is pointed at it via `search_path`, replays the real files, and
every table it built is compared column for column (type, nullability, default) with what `drizzle-kit push` built in
`public`. `ADDED_COLUMNS` in the test lists columns migrations add to pre-existing tables; tables a migration
creates are compared automatically.

## Gates

Local, Node 24.18.0, pnpm 10.34.3, Postgres 16.14, DB `h2budget_test_pr0` (baseline on `h2budget_test_pr0_before`).

| Gate | Parent `8148f2a1` | This branch |
|---|---|---|
| `pnpm run typecheck` | — | pass |
| codegen + `git status --porcelain lib/api-zod lib/api-client-react` (dist deleted first, as CI does) | — | clean, no untracked |
| web `CI=true TZ=America/Chicago pnpm --filter ./artifacts/h2budget exec vitest run` | — | 141 files, 1250 passed, 2 skipped |
| web, `TZ=UTC` | — | 141 files, 1249 passed, 3 skipped |
| API `pnpm --filter ./artifacts/api-server run test` (serial) | 151 files, 1606 passed, 7 todo | **154 files, 1626 passed, 7 todo** (+20 new) |
| `pnpm run build` + `node scripts/check-entry-graph.mjs` | 575.7 KB / 580 KB | 575.7 KB / 580 KB; web dist byte-identical |
| `dist/index.mjs` | 7,438,362 B | 7,443,136 B |
| `dist/migrate.mjs` | — | 182,567 B (178.3 KB) |
| `node artifacts/api-server/dist/migrate.mjs` | — | empty ledger → applies 0001, 0002; rerun → "nothing to apply (already applied: 2)"; via the pnpm script (other cwd) same; tampered checksum → exit 1, nothing applied; no `DATABASE_URL` → exit 1. On the parent-schema DB → adds the column, rerun no-op. |
| `drizzle-kit push` after migrate | — | "No changes detected"; ledger rows survive |
| `pnpm audit --prod` | **3 (1 critical, 2 high)** | **3, identical** — see Residual 6 |

## Residuals

1. **⚠️ Production ordering — read before merging.** Render's notes say the service was created through the API, not
   a Blueprint, and a Blueprint sync must not be run (it would create a second database). So **`render.yaml`'s
   `preDeployCommand` does not take effect by itself.** If this merges and deploys without the migration having run,
   every route that selects full transaction rows fails (`column "category_locked_by_user" does not exist`). Safe
   orders: (a) set Pre-Deploy Command = `node artifacts/api-server/dist/migrate.mjs` on the service, then merge —
   but only after the pending security-pin deploy, because a build without `dist/migrate.mjs` fails a pre-deploy
   command that names it; or (b) run `migrate.mjs` once against production before merging (additive, so the
   current build is unaffected). Either is a production change that needs the owner's explicit OK.
2. **The ledger is declared in drizzle too.** `drizzle-kit push` silently **dropped** `schema_migrations` in testing
   because the drizzle schema did not know it. Every table a SQL file creates must also be declared in drizzle
   (README rule 5). pg-boss's own `pgboss` schema is outside push's default `public` filter.
3. **The backfill is an approximation.** `is_transfer_user_overridden` is also set when a person only toggles the
   transfer flag on a rule-filed row (locked by the backfill), and is not set by a hand-typed create with a category
   (not locked historically). From here on every path writes the lock exactly.
4. **Write paths left alone (by design, flag for PR-A):** debt-payment inserts and `budget.ts` category backfill /
   consolidation (system writes); workbook import; `dedupeTransactions` and `supersededPending` carry
   `is_transfer_user_overridden` from a loser/pending row but not the lock; "Reset to auto"
   (`clear-transfer-override`) does not unlock; the recategorize-by-pattern Undo locks the rows it moves back;
   deleting a category leaves a dangling `category_id` with its lock (no FK).
5. **`categoryLockedByUser` is optional in the spec**, not required: some Transaction-shaped responses may be built
   by hand rather than from the full row. PR-A can make it required once every builder carries it.
6. **`pnpm audit --prod` is not 0 on `main` either**: advisories published after the 10/02 pins —
   `proxy-addr` (critical, via express, fixed ≥ 2.0.8), `compression` (high, direct, fixed ≥ 1.8.2), `braces` (high,
   via http-proxy-middleware → micromatch, **no patched version**). No dependency changed here; CI does not run
   audit. Needs its own security PR.
7. The drift check covers tables migrations create and the columns listed in `ADDED_COLUMNS`; a future file that
   alters another existing table must add its columns there. A stronger guard is a CI job that builds a DB from a
   production schema snapshot plus the migrations and diffs it against push.
8. `CLAUDE.md` assigns roles to `ochre` (caution) and `slate` (secondary) — S0 should confirm against its tokens.
   The `render.yaml` header still describes the node-cron prune (AI-0 retires it).
9. Checksums hash the raw file bytes; a CRLF checkout would read as edited. Render and CI are Linux; a
   `.gitattributes` `eol=lf` for `lib/db/migrations/*.sql` would close it.

## Questions for the owner

1. Production ordering (Residual 1): may I (a) set the Pre-Deploy Command on the Render service after the
   security-pin deploy, or (b) run the migration once against the production database before merging?
2. Backfill (Residual 3): lock every categorized row that carries the transfer-override flag (as built), or lock
   nothing historically and only from now on?
3. Should "Reset to auto" also unlock the category, and should categories brought in by a workbook import count as
   chosen by a person?
