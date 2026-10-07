// Entry for `dist/migrate.mjs`, run by Render's `preDeployCommand` after the
// build and before the new build serves:
//
//   node artifacts/api-server/dist/migrate.mjs
//
// Applies the pending `lib/db/migrations/*.sql` files to DATABASE_URL and
// exits 0, or prints the error and exits 1 — which cancels the deploy, so the
// old build keeps serving. Safe to run any number of times.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "@workspace/db/migrate";

function migrationsDir(): string {
  // Render (and a local run from the repo root) start in the repo root.
  const fromCwd = path.resolve(process.cwd(), "lib/db/migrations");
  if (existsSync(fromCwd)) return fromCwd;
  // Otherwise resolve from this file: src/ or dist/ → artifacts/api-server
  // → repo root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../lib/db/migrations");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set to run migrations.");
  const dir = migrationsDir();
  if (!existsSync(dir)) throw new Error(`Migrations directory not found: ${dir}`);
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
