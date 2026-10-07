# lib/db/migrations — the SQL production runs

Every schema change ships here as a numbered SQL file. On each deploy, Render's
`preDeployCommand` runs `node artifacts/api-server/dist/migrate.mjs`, which
applies the files the `schema_migrations` ledger has not seen, in file-name
order, each in its own transaction together with its ledger row. A failing file
rolls back, the command exits 1, and **the deploy is cancelled — the old build
keeps serving on the old schema.** Run it locally the same way after
`pnpm run build`; it is safe to run any number of times.

Dev databases and the API test suite still use `drizzle-kit push`
(`pnpm --filter @workspace/db run push`). `lib/db/drizzle/*.sql` is legacy
history: nothing runs those files.

## Rules

1. **Every statement is idempotent.** `CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
   `INSERT … ON CONFLICT DO NOTHING`. A file must be safe on a database where
   `drizzle-kit push` already created the objects (every dev and test DB).
2. **Additive only.** The old build keeps serving until the new one is healthy,
   and it serves against the new schema in between — so new columns are
   nullable or carry a default, and nothing is renamed or dropped. **Never DROP
   in the same release as the code that stops reading it**; the drop ships in a
   later release, once nothing reads the column.
3. **Backfills live in the same file** as the column they fill, written so a
   second run changes nothing (`WHERE new_col IS DISTINCT FROM …` / `= false`).
4. **Never edit a file that has been merged.** The runner stores each file's
   sha256 and refuses to run at all if an applied file changed. Fix forward in
   a new file.
5. **The drizzle schema must match the SQL.** `lib/db/src/schema` stays the
   type source. Every table and column a file creates is declared there with
   the same type, nullability and default — `drizzle-kit push` drops public
   tables it does not know, and the runner's own ledger is declared for that
   reason. `schemaMigrations.integration.test.ts` checks the drizzle columns
   exist and replays `0002` against a pre-migration copy of `transactions`.
6. **One transaction per file, so no `CONCURRENTLY`.** `CREATE INDEX
   CONCURRENTLY` cannot run inside a transaction; on tables this size a plain
   `CREATE INDEX IF NOT EXISTS` is fine. Each file runs with a 15 s
   `lock_timeout`, so a statement queued behind live traffic fails the deploy
   instead of stalling the app.
7. **No real data.** This repo is public: no merchants, amounts, names or ids
   from the household in a migration or its comments.

## Naming and reserved ranges

`NNNN_short_description.sql`, four digits, applied in name order. Each package
of the reinvention owns a range so parallel branches never collide:

| Range | Package | Range | Package |
|---|---|---|---|
| 0001–0009 | PR-0 | 0090s | AI-4a |
| 0010–0019 | AI-0 | 0100s | AI-4b |
| 0020s | PR-A | 0110s | PR-E |
| 0030s | AI-1 | 0120s | PR-F |
| 0040s | PR-B | 0130s | PR-G |
| 0050s | AI-2 | 0140s | AI-5 |
| 0060s | PR-D | 0150s | PR-H |
| 0070s | AI-3 | 0160s | AI-6 |
| 0080s | PR-C | | |

Packages may merge out of numeric order. The runner applies any file it has not
recorded, whatever its number, so a lower-numbered file that lands later still
runs — which is one more reason every file must stand on its own.
