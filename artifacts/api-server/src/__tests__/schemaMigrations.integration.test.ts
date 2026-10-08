// PR-0 · The production migration runner (lib/db/src/migrate.ts) and the
// SQL it runs (lib/db/migrations/*.sql).
//
// Two databases-in-one are in play:
//   - `public`, which `pretest` built with `drizzle-kit push` — the shape the
//     drizzle schema says the tables have.
//   - a scratch schema per test, holding PRE-migration copies of the tables
//     the SQL files alter (built from `public` with the added columns dropped).
//     The runner is pointed at it through `search_path`, so the real files
//     replay exactly as they will on production, and the result is compared
//     column by column with what drizzle built. That is the drift check: a
//     SQL file that defines a column or table differently from the drizzle
//     schema fails here.
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { pool, transactionsTable } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { checksumOf, runMigrations } from "@workspace/db/migrate";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../lib/db/migrations",
);
const DATABASE_URL = process.env.DATABASE_URL!;

// Columns the SQL files ADD to tables that existed before PR-0. The scratch
// copy of each table drops them so the replay starts from the pre-migration
// shape. A package whose migration alters an existing table adds its columns
// here; a table a migration CREATES needs nothing — it is compared anyway.
const ADDED_COLUMNS: Record<string, string[]> = {
  transactions: [
    "category_locked_by_user",
    // PR-A (0020)
    "category_provisional",
    "refund_of_txn_id",
    "plaid_removed_at",
    "splits_invalid",
  ],
};

type ColumnShape = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function columnsOf(schemaName: string, table?: string): Promise<ColumnShape[]> {
  const { rows } = await pool.query<ColumnShape>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND ($2::text IS NULL OR table_name = $2)
      ORDER BY table_name, column_name`,
    [schemaName, table ?? null],
  );
  return rows;
}

async function tablesIn(schemaName: string): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 ORDER BY table_name`,
    [schemaName],
  );
  return rows.map((r) => r.table_name);
}

async function migrationFileNames(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql")).sort();
}

const scratchSchemas: string[] = [];
const tempDirs: string[] = [];

/** A scratch schema holding pre-migration copies of the altered tables. */
async function makeScratch(): Promise<{ name: string; url: string }> {
  const name = `pr0_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  scratchSchemas.push(name);
  await pool.query(`CREATE SCHEMA ${name}`);
  for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
    await pool.query(
      `CREATE TABLE ${name}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES)`,
    );
    for (const col of added) {
      await pool.query(`ALTER TABLE ${name}.${table} DROP COLUMN ${col}`);
    }
  }
  const url = new URL(DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${name},public`);
  return { name, url: url.toString() };
}

async function tempMigrationsDir(extra: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr0-migrations-"));
  tempDirs.push(dir);
  for (const n of await migrationFileNames()) {
    await copyFile(path.join(MIGRATIONS_DIR, n), path.join(dir, n));
  }
  for (const [n, sql] of Object.entries(extra)) {
    await writeFile(path.join(dir, n), sql);
  }
  return dir;
}

afterEach(async () => {
  for (const s of scratchSchemas.splice(0)) {
    await pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  }
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

describe("migration runner — on the test database", () => {
  it("is idempotent: a second run applies nothing and the ledger holds every file", async () => {
    const files = await migrationFileNames();
    expect(files).toEqual(
      expect.arrayContaining(["0001_schema_migrations.sql", "0002_category_locked_by_user.sql"]),
    );

    const first = await runMigrations({ databaseUrl: DATABASE_URL, dir: MIGRATIONS_DIR });
    expect(first.applied.length + first.skipped).toBe(files.length);

    const second = await runMigrations({ databaseUrl: DATABASE_URL, dir: MIGRATIONS_DIR });
    expect(second).toEqual({ applied: [], skipped: files.length });

    const { rows } = await pool.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM schema_migrations WHERE name = ANY($1) ORDER BY name`,
      [files],
    );
    expect(rows.map((r) => r.name)).toEqual(files);
  });

  it("transactions.category_locked_by_user is boolean, NOT NULL, default false", async () => {
    const [col] = await columnsOf("public", "transactions").then((cs) =>
      cs.filter((c) => c.column_name === "category_locked_by_user"),
    );
    expect(col).toMatchObject({
      data_type: "boolean",
      is_nullable: "NO",
      column_default: "false",
    });
  });

  it("every column of every drizzle table exists in the database", async () => {
    const dbColumns = new Set(
      (await columnsOf("public")).map((c) => `${c.table_name}.${c.column_name}`),
    );
    const missing: string[] = [];
    let tables = 0;
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      tables++;
      const cfg = getTableConfig(value);
      for (const c of cfg.columns) {
        if (!dbColumns.has(`${cfg.name}.${c.name}`)) missing.push(`${cfg.name}.${c.name}`);
      }
    }
    expect(tables).toBeGreaterThan(20);
    expect(missing).toEqual([]);
    // Named explicitly so a lost export cannot pass vacuously.
    expect(getTableConfig(transactionsTable).columns.map((c) => c.name)).toContain(
      "category_locked_by_user",
    );
  });
});

describe("migration runner — replayed on a pre-migration copy", () => {
  it("applies every file in order, backfills, and matches the drizzle schema column for column", async () => {
    const s = await makeScratch();
    const cat = randomUUID();
    const seed = async (overridden: boolean, categoryId: string | null) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO ${s.name}.transactions
           (user_id, occurred_on, description, amount, category_id, is_transfer_user_overridden)
         VALUES ('pr0-test', '2026-01-05', 'Test row', '-1.00', $1, $2) RETURNING id`,
        [categoryId, overridden],
      );
      return rows[0]!.id;
    };
    const handFiled = await seed(true, cat);
    const flagOnly = await seed(true, null);
    const ruleFiled = await seed(false, cat);

    const files = await migrationFileNames();
    const first = await runMigrations({ databaseUrl: s.url, dir: MIGRATIONS_DIR });
    expect(first).toEqual({ applied: files, skipped: 0 });

    const ledger = await pool.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${s.name}.schema_migrations ORDER BY name`,
    );
    expect(ledger.rows.map((r) => r.name)).toEqual(files);
    for (const r of ledger.rows) {
      expect(r.checksum).toBe(checksumOf(await readFile(path.join(MIGRATIONS_DIR, r.name), "utf8")));
    }

    const locked = async () =>
      new Map(
        (
          await pool.query<{ id: string; category_locked_by_user: boolean }>(
            `SELECT id, category_locked_by_user FROM ${s.name}.transactions`,
          )
        ).rows.map((r) => [r.id, r.category_locked_by_user]),
      );
    expect(await locked()).toEqual(
      new Map([
        [handFiled, true],
        [flagOnly, false],
        [ruleFiled, false],
      ]),
    );

    // Second run: nothing applied, nothing moved.
    const second = await runMigrations({ databaseUrl: s.url, dir: MIGRATIONS_DIR });
    expect(second).toEqual({ applied: [], skipped: files.length });
    expect((await locked()).get(handFiled)).toBe(true);

    // Drift: every table the replay built equals what drizzle pushed.
    const strip = (cs: ColumnShape[]) =>
      cs.map(({ table_name, column_name, data_type, is_nullable, column_default }) => ({
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default,
      }));
    for (const table of await tablesIn(s.name)) {
      expect(strip(await columnsOf(s.name, table)), table).toEqual(
        strip(await columnsOf("public", table)),
      );
    }
  });

  it("an edited, already-applied file stops the run before ANY pending file applies", async () => {
    const s = await makeScratch();
    await runMigrations({ databaseUrl: s.url, dir: MIGRATIONS_DIR });
    await pool.query(
      `UPDATE ${s.name}.schema_migrations SET checksum = 'edited' WHERE name = '0002_category_locked_by_user.sql'`,
    );
    // One pending file sorts BEFORE the edited one (a lower number merged
    // late) and one after: history is verified first, so neither runs.
    const dir = await tempMigrationsDir({
      "0001a_probe.sql": "CREATE TABLE IF NOT EXISTS pr0_probe_early (id int);",
      "9990_probe.sql": "CREATE TABLE IF NOT EXISTS pr0_probe_late (id int);",
    });

    await expect(runMigrations({ databaseUrl: s.url, dir })).rejects.toThrow(
      /0002_category_locked_by_user\.sql was already applied with checksum edited/,
    );
    const tables = await tablesIn(s.name);
    expect(tables).not.toContain("pr0_probe_early");
    expect(tables).not.toContain("pr0_probe_late");
    const { rows } = await pool.query(
      `SELECT name FROM ${s.name}.schema_migrations WHERE name LIKE '%probe%'`,
    );
    expect(rows).toEqual([]);
  });

  it("a failing file rolls back alone and records nothing", async () => {
    const s = await makeScratch();
    await runMigrations({ databaseUrl: s.url, dir: MIGRATIONS_DIR });
    const dir = await tempMigrationsDir({
      "9990_half.sql": "CREATE TABLE pr0_half (id int);\nSELECT * FROM pr0_no_such_table;",
      "9991_after.sql": "CREATE TABLE pr0_after (id int);",
    });

    await expect(runMigrations({ databaseUrl: s.url, dir })).rejects.toThrow(
      /9990_half\.sql failed and was rolled back/,
    );
    const tables = await tablesIn(s.name);
    expect(tables).not.toContain("pr0_half");
    expect(tables).not.toContain("pr0_after");
    const { rows } = await pool.query(
      `SELECT name FROM ${s.name}.schema_migrations WHERE name LIKE '999%'`,
    );
    expect(rows).toEqual([]);
  });

  it("two runners at once apply each file exactly once (advisory lock)", async () => {
    const s = await makeScratch();
    const files = await migrationFileNames();
    const [a, b] = await Promise.all([
      runMigrations({ databaseUrl: s.url, dir: MIGRATIONS_DIR }),
      runMigrations({ databaseUrl: s.url, dir: MIGRATIONS_DIR }),
    ]);
    expect([...a.applied, ...b.applied].sort()).toEqual(files);
    expect(a.skipped + b.skipped).toBe(files.length);
  });
});
