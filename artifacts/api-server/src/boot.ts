// Boot order for the API server: apply pending SQL migrations, THEN listen.
//
// Render runs `dist/migrate.mjs` as a Pre-Deploy Command only if the service
// has one configured in the dashboard; the service was created through the
// API, so render.yaml is informational and cannot be relied on to set it.
// Running the same idempotent runner at boot makes every build safe on its
// own: the new instance migrates before it serves, and if a migration fails
// it exits 1, never passes Render's health check, and the old build keeps
// serving. Migrations are additive only (lib/db/migrations/README.md), so the
// old build is fine on the new schema in between. One runner at a time:
// numInstances is 1 and the runner holds a Postgres advisory lock.
//
// `MIGRATE_ON_BOOT=false` turns the boot step off — set it only once the
// service's Pre-Deploy Command runs `node artifacts/api-server/dist/migrate.mjs`.
export type BootLog = {
  info: (msg: string) => void;
  error: (msg: string, err: unknown) => void;
};

export type StartServerOptions = {
  migrateOnBoot: boolean;
  migrate: () => Promise<{ applied: string[]; skipped: number }>;
  listen: () => void;
  exit: (code: number) => void;
  log: BootLog;
};

export function migrateOnBootEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIGRATE_ON_BOOT !== "false";
}

/** Migrate (unless disabled), then listen. Returns whether it listened. */
export async function startServer(opts: StartServerOptions): Promise<boolean> {
  if (opts.migrateOnBoot) {
    try {
      const { applied, skipped } = await opts.migrate();
      opts.log.info(
        applied.length
          ? `[migrate] applied ${applied.length} at boot: ${applied.join(", ")} (already applied: ${skipped})`
          : `[migrate] nothing to apply at boot (already applied: ${skipped})`,
      );
    } catch (err) {
      opts.log.error("[migrate] boot migration failed — refusing to serve", err);
      opts.exit(1);
      return false;
    }
  } else {
    opts.log.info("[migrate] MIGRATE_ON_BOOT=false — boot migrations skipped (pre-deploy runs them)");
  }
  opts.listen();
  return true;
}
