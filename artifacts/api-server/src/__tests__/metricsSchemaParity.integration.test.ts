import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";

// (PR-E) lib/db/migrations/0110_household_metrics_daily.sql (run in production
// by the migration runner) and the drizzle schema (pushed in dev and tests) must
// describe the same table. Run the SQL twice in a scratch schema that has the
// one table it references (households), then compare every column, index and
// constraint with what drizzle created in `public`.

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.resolve(here, "../../../../lib/db/migrations/0110_household_metrics_daily.sql");
const SCRATCH = `pre_sql_check_${process.pid}`;
const TABLES = ["household_metrics_daily"];

afterAll(async () => {
  await pool.query(`drop schema if exists ${SCRATCH} cascade`);
});

async function describeSchema(client: { query: typeof pool.query }, schema: string) {
  const cols = await client.query(
    `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = $1 and table_name = any($2)
      order by table_name, column_name`,
    [schema, TABLES],
  );
  const idx = await client.query(
    `select tablename, indexname, regexp_replace(indexdef, ' ON [a-z0-9_]+\\.', ' ON ') as def
       from pg_indexes where schemaname = $1 and tablename = any($2)
      order by tablename, indexname`,
    [schema, TABLES],
  );
  const cons = await client.query(
    `select c.conrelid::regclass::text as tbl, c.conname, c.contype, pg_get_constraintdef(c.oid) as def
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname = $1 and c.conrelid::regclass::text = any($2) and c.contype in ('c', 'f', 'u')
      order by 1, 2`,
    [schema, TABLES],
  );
  return { cols: cols.rows, idx: idx.rows, cons: cons.rows.map((r) => ({ ...r, tbl: String(r.tbl).replace(`${schema}.`, "") })) };
}

describe("0110_household_metrics_daily.sql", () => {
  it("is idempotent and matches the drizzle schema column for column", async () => {
    const sqlText = readFileSync(SQL_FILE, "utf8");
    const client = await pool.connect();
    try {
      await client.query(`drop schema if exists ${SCRATCH} cascade`);
      await client.query(`create schema ${SCRATCH}`);
      await client.query(`set search_path to ${SCRATCH}`);
      await client.query("create table households (id uuid primary key default gen_random_uuid())");
      await client.query(sqlText);
      await client.query(sqlText); // second run: no error, no change
      const scratch = await describeSchema(client, SCRATCH);
      await client.query("set search_path to public");
      const pub = await describeSchema(client, "public");
      expect(scratch.cols.length).toBe(6);
      expect(scratch.cols).toEqual(pub.cols);
      expect(scratch.idx.map((r) => r.def)).toEqual(pub.idx.map((r) => r.def));
      expect(scratch.cons.map((r) => `${r.tbl} ${r.conname} ${r.contype} ${r.def}`)).toEqual(
        pub.cons.map((r) => `${r.tbl} ${r.conname} ${r.contype} ${r.def}`),
      );
    } finally {
      await client.query("reset search_path");
      client.release();
    }
  });

  it("refuses a second row for the same household and day", async () => {
    const { db, householdsTable, householdMetricsDailyTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const owner = `schema-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const [h] = await db.insert(householdsTable).values({ ownerUserId: owner }).returning();
    try {
      const row = { householdId: h!.id, asOf: "2026-10-07", metrics: {} };
      await db.insert(householdMetricsDailyTable).values(row);
      await expect(db.insert(householdMetricsDailyTable).values(row)).rejects.toThrow();
      await db.insert(householdMetricsDailyTable).values({ ...row, asOf: "2026-10-08" });
    } finally {
      await db.delete(householdsTable).where(eq(householdsTable.id, h!.id));
    }
  });
});
