import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";

// (AI-0) The idempotent SQL migration (lib/db/migrations/0010_ai_core.sql,
// run in production by the migration runner) and the drizzle schema (pushed
// in dev and tests) must describe the same tables. Run the SQL twice in a
// scratch schema, then compare every column and index with what drizzle
// created in `public`.

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.resolve(here, "../../../../lib/db/migrations/0010_ai_core.sql");
const SCRATCH = `ai0_sql_check_${process.pid}`;
const TABLES = ["ai_usage", "ai_budget", "ai_task_config"];

afterAll(async () => {
  await pool.query(`drop schema if exists ${SCRATCH} cascade`);
});

async function describeSchema(client: { query: typeof pool.query }, schema: string) {
  const cols = await client.query(
    `select table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
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
  return { cols: cols.rows, idx: idx.rows };
}

describe("0010_ai_core.sql", () => {
  it("is idempotent and matches the drizzle schema column for column", async () => {
    const sqlText = readFileSync(SQL_FILE, "utf8");
    const client = await pool.connect();
    try {
      await client.query(`drop schema if exists ${SCRATCH} cascade`);
      await client.query(`create schema ${SCRATCH}`);
      await client.query(`set search_path to ${SCRATCH}`);
      await client.query(sqlText);
      await client.query(sqlText); // second run: no error, no change
      const scratch = await describeSchema(client, SCRATCH);
      await client.query("set search_path to public");
      const pub = await describeSchema(client, "public");
      expect(scratch.cols.length).toBe(15 + 6 + 6);
      expect(scratch.cols).toEqual(pub.cols);
      expect(scratch.idx.map((r) => r.def)).toEqual(pub.idx.map((r) => r.def));
    } finally {
      await client.query("reset search_path");
      client.release();
    }
  });
});
