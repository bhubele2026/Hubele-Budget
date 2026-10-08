import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";

// (AI-2) 0050_ask_agent.sql (run in production by the migration runner) and
// lib/db/src/schema/agent.ts (pushed in dev and tests) must describe the same
// five tables, constraints and indexes included. Run the files twice in a
// scratch schema, then compare with what drizzle created in public.

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../../../lib/db/migrations");
const SCRATCH = `ai2_sql_check_${process.pid}`;
const TABLES = ["agent_conversations", "agent_messages", "agent_proposals", "agent_memory", "wishlist_items"];

afterAll(async () => {
  await pool.query(`drop schema if exists ${SCRATCH} cascade`);
});

async function describeSchema(client: { query: typeof pool.query }, schema: string) {
  const cols = await client.query(
    `select table_name, column_name, data_type, udt_name, numeric_precision, numeric_scale, is_nullable, column_default
       from information_schema.columns where table_schema = $1 and table_name = any($2) order by table_name, column_name`,
    [schema, TABLES],
  );
  const idx = await client.query(
    `select tablename, indexname, regexp_replace(indexdef, ' ON [a-z0-9_]+\\.', ' ON ') as def
       from pg_indexes where schemaname = $1 and tablename = any($2) order by tablename, indexname`,
    [schema, TABLES],
  );
  const cons = await client.query(
    `select t.relname as tbl, c.conname, c.contype, regexp_replace(pg_get_constraintdef(c.oid), '[a-z0-9_]+\\.', '', 'g') as def
       from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = $1 and t.relname = any($2) and c.contype in ('c', 'u', 'f') order by 1, 2`,
    [schema, TABLES],
  );
  return { cols: cols.rows, idx: idx.rows, cons: cons.rows };
}

describe("0050_ask_agent.sql", () => {
  it("is idempotent and matches the drizzle schema column for column", async () => {
    const client = await pool.connect();
    try {
      await client.query(`drop schema if exists ${SCRATCH} cascade`);
      await client.query(`create schema ${SCRATCH}`);
      await client.query(`set search_path to ${SCRATCH}`);
      await client.query(`create table households (id uuid primary key default gen_random_uuid())`);
      for (const f of ["0030_agent_runs.sql", "0050_ask_agent.sql"]) {
        const sqlText = readFileSync(path.join(MIGRATIONS, f), "utf8");
        await client.query(sqlText);
        await client.query(sqlText); // a second run changes nothing
      }
      const scratch = await describeSchema(client, SCRATCH);
      await client.query("set search_path to public");
      const pub = await describeSchema(client, "public");
      expect(scratch.cols.length).toBe(6 + 6 + 12 + 14 + 13);
      expect(scratch.cols).toEqual(pub.cols);
      expect(scratch.idx.map((r) => r.def)).toEqual(pub.idx.map((r) => r.def));
      expect(scratch.cons).toEqual(pub.cons);
    } finally {
      await client.query("reset search_path");
      client.release();
    }
  });
});
