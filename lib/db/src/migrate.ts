// The production migration runner. Applies every `*.sql` file in
// `lib/db/migrations/` that the `schema_migrations` ledger has not seen yet,
// in file-name order, each inside its own transaction with its ledger row.
//
// Deliberately bare `pg` (no drizzle) and NOT imported by `src/index.ts`:
// that module opens a pool and throws without DATABASE_URL at import time,
// and Render runs this from `preDeployCommand` before the server exists.
//
// Rules it enforces:
// - A file already in the ledger whose sha256 no longer matches is a hard
//   error, checked for EVERY applied file before anything runs: an edited
//   migration means production and the repo disagree about history, and
//   guessing is how data gets lost. Write a new file instead.
// - One runner at a time: `pg_advisory_lock(7212)` serialises concurrent
//   deploys; the ledger is read only after the lock is held.
// - A failing file rolls back alone and stops the run (later files are not
//   attempted), so the deploy is cancelled with nothing half-applied.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

/** Arbitrary, fixed key for the runner's session-level advisory lock. */
export const MIGRATION_LOCK_KEY = 7212;

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export type RunMigrationsOptions = {
  databaseUrl: string;
  /** Directory holding the `NNNN_*.sql` files. */
  dir: string;
  log?: (msg: string) => void;
  /**
   * `lock_timeout` for each file's transaction. An `ALTER TABLE` queued
   * behind the live server's queries would otherwise block every later query
   * on that table while it waits; failing fast cancels the deploy instead.
   */
  lockTimeoutMs?: number;
};

export type RunMigrationsResult = { applied: string[]; skipped: number };

type MigrationFile = { name: string; sql: string; checksum: string };

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(dir, name), "utf8");
    files.push({ name, sql, checksum: checksumOf(sql) });
  }
  return files;
}

export async function runMigrations(
  opts: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const log = opts.log ?? (() => {});
  const lockTimeoutMs = opts.lockTimeoutMs ?? 15_000;
  const files = await readMigrationFiles(opts.dir);

  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    locked = true;
    await client.query(LEDGER_DDL);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const ledger = new Map(rows.map((r) => [r.name, r.checksum]));

    // Verify all history first, so a tampered ledger applies nothing at all.
    for (const f of files) {
      const recorded = ledger.get(f.name);
      if (recorded !== undefined && recorded !== f.checksum) {
        throw new Error(
          `Migration ${f.name} was already applied with checksum ${recorded}, ` +
            `but the file on disk now hashes to ${f.checksum}. Applied ` +
            `migrations must never be edited — revert the file and put the ` +
            `change in a new migration. Nothing was applied.`,
        );
      }
    }

    const applied: string[] = [];
    let skipped = 0;
    for (const f of files) {
      if (ledger.has(f.name)) {
        skipped++;
        continue;
      }
      log(`applying ${f.name}`);
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL lock_timeout = ${Math.trunc(lockTimeoutMs)}`);
        await client.query(f.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [f.name, f.checksum],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${f.name} failed and was rolled back: ${msg}`, {
          cause: err,
        });
      }
      applied.push(f.name);
    }
    return { applied, skipped };
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
        .catch(() => {});
    }
    await client.end().catch(() => {});
  }
}
