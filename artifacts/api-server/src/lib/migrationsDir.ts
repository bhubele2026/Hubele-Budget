import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where `lib/db/migrations` lives, for the migration runner (boot and
 * `dist/migrate.mjs`). Render and a local run start in the repo root, so the
 * working directory wins; otherwise walk up from the caller's own file
 * (`src/…` under tsx/vitest, `dist/…` when bundled) to the repo root.
 */
export function findMigrationsDir(fromUrl: string): string {
  const fromCwd = path.resolve(process.cwd(), "lib/db/migrations");
  if (existsSync(fromCwd)) return fromCwd;
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "lib/db/migrations");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `lib/db/migrations not found from ${process.cwd()} or above ${fileURLToPath(fromUrl)}`,
  );
}
