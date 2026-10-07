// Entry for `dist/migrate.mjs`, run by Render's `preDeployCommand` after the
// build and before the new build serves:
//
//   node artifacts/api-server/dist/migrate.mjs
//
// Applies the pending `lib/db/migrations/*.sql` files to DATABASE_URL and
// exits 0, or prints the error and exits 1 — which cancels the deploy, so the
// old build keeps serving. Safe to run any number of times. The server runs
// the same runner at boot too (src/boot.ts) unless MIGRATE_ON_BOOT=false.
import { runMigrations } from "@workspace/db/migrate";
import { findMigrationsDir } from "./lib/migrationsDir";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set to run migrations.");
  const dir = findMigrationsDir(import.meta.url);
  console.log(`[migrate] ${dir}`);
  const { applied, skipped } = await runMigrations({
    databaseUrl,
    dir,
    log: (msg) => console.log(`[migrate] ${msg}`),
  });
  console.log(
    applied.length
      ? `[migrate] applied ${applied.length}: ${applied.join(", ")} (already applied: ${skipped})`
      : `[migrate] nothing to apply (already applied: ${skipped})`,
  );
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error("[migrate] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
