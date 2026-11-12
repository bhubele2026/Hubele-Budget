/**
 * PERF HARNESS — seed the local perf database with the rich synthetic household at two sizes, weekly avalanche cadence.
 *
 *   PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH" \
 *   pnpm --filter @workspace/scripts exec tsx ./perf/seed.mts [PERF_DB=h2budget_perf] [SCALES=3,8]
 *
 * - The database is local and its name MUST end in `_perf` (created if missing; schema pushed with drizzle-kit, as
 *   the tests do).
 * - Each scale gets its own owner (`perf-owner-s<scale>`), re-seeded from scratch on every run.
 * - The fixture is dated around 2026-10-14; every date it wrote is moved forward to TODAY so the forecast, the
 *   week and the bank snapshot read as current (bank snapshot 07:00 today).
 * - Writes the owners to /private/tmp/claude-501/perf/households.json for run.mts and server-bench.mts.
 *
 * Synthetic names and amounts only. Nothing here touches any other database.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DB = process.env.PERF_DB ?? "h2budget_perf";
if (!/_perf$/.test(DB)) throw new Error("PERF_DB must end in _perf");
const PGUSER = process.env.PGUSER ?? process.env.USER ?? "postgres";
const DATABASE_URL = `postgres://${PGUSER}@localhost:5432/${DB}`;
const SCALES = (process.env.SCALES ?? "3,8").split(",").map(Number);
const OUT = process.env.PERF_OUT ?? "/private/tmp/claude-501/perf";

const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").slice(-600)}`);
  return r.stdout;
};

// 1. The database and its schema.
const exists = sh("psql", ["-h", "localhost", "-d", "postgres", "-Atc", `select 1 from pg_database where datname='${DB}'`]).trim() === "1";
if (!exists) sh("createdb", ["-h", "localhost", DB]);
sh("pnpm", ["--filter", "@workspace/db", "run", "push"], { ...process.env, DATABASE_URL });
// drizzle-kit push makes tables only: the data-revision triggers the ledger cache needs come from their migration
// (idempotent). Without them the server simply runs with no cache.
for (const f of ["0251_household_data_revisions.sql"]) {
  sh("psql", ["-h", "localhost", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", join(ROOT, "lib/db/migrations", f)]);
}
console.log(`schema pushed → ${DB}`);

// 2. The households (the db client reads DATABASE_URL when it loads).
process.env.DATABASE_URL = DATABASE_URL;
const fixture = (await import(pathToFileURL(join(ROOT, "artifacts/api-server/src/__tests__/_fixtures/richHousehold.ts")).href)) as typeof import("../../artifacts/api-server/src/__tests__/_fixtures/richHousehold");
const { db, pool, householdsTable, householdMembersTable } = await import("@workspace/db");
const { inArray } = await import("drizzle-orm");

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const shiftDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${fixture.RICH_TODAY}T00:00:00Z`)) / 86_400_000);

const households: Array<{ scale: number; ownerUserId: string; householdId: string; rows: number; accounts: Record<string, string> }> = [];
for (const scale of SCALES) {
  const owner = `perf-owner-s${scale}`;
  await fixture.cleanupRichHouseholds([owner]);
  await db.delete(householdMembersTable).where(inArray(householdMembersTable.userId, [owner]));
  await db.delete(householdsTable).where(inArray(householdsTable.ownerUserId, [owner]));
  const rich = await fixture.seedRichHousehold(owner, { scale, weekly: true });
  const hh = rich.householdId;
  // Move every date the fixture wrote forward by `shiftDays`, so "today" in the data is today.
  const q = (text: string) => pool.query(text, [hh, shiftDays]);
  await q(`update transactions set occurred_on = occurred_on + $2::int, created_at = created_at + make_interval(days => $2::int) where household_id = $1`);
  await q(`update recurring_items set anchor_date = anchor_date + $2::int,
             day_of_month = case when day_of_month is null then null else extract(day from anchor_date + $2::int)::int end
           where household_id = $1`);
  await q(`update forecast_resolutions set occurrence_date = occurrence_date + $2::int where household_id = $1`);
  await q(`update forecast_settings set bank_snapshot_at = bank_snapshot_at + make_interval(days => $2::int) where household_id = $1`);
  households.push({ scale, ownerUserId: owner, householdId: hh, rows: rich.rowCount, accounts: rich.accounts });
  console.log(`scale ${scale}: ${rich.rowCount} transactions, owner ${owner}, dates +${shiftDays} days`);
}
await pool.end();

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "households.json"), JSON.stringify({ db: DB, databaseUrl: DATABASE_URL, today, shiftDays, households }, null, 2));
console.log(`→ ${join(OUT, "households.json")}`);
