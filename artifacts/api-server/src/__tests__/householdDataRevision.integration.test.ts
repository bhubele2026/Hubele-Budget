// ⭐ (PERF) EVERY TABLE A CACHED BUILD CAN READ MOVES THE HOUSEHOLD'S DATA REVISION.
//
// The ledger cache (lib/ledgerCache.ts) is only as honest as the triggers of
// migration 0251: a table the forecast ledger, the cash signal or the weekly
// plan reads WITHOUT a trigger would let a write go unseen for up to five
// minutes. Two nets, so a new read cannot slip in:
//   1. STATIC — every drizzle table imported from @workspace/db by any module the
//      cached builds can reach (their local import closure) has its INSERT,
//      UPDATE and DELETE triggers, and is in LEDGER_READ_TABLES, the list the
//      cache checks before it runs at all;
//   2. LIVE — every table named in the SQL those builds actually send (weekly
//      and monthly cadence, several horizons) is in that list too.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName, isTable } from "drizzle-orm";
import * as schema from "@workspace/db";
import { pool } from "@workspace/db";
import { computeCashSignalDetailed } from "../lib/cashSignal";
import { loadWeeklyAvalanchePlan } from "../lib/avalancheWeeklyPlan";
import { findSupersededPendingForRange } from "../lib/supersededPending";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { readUnresolvedBankRows } from "../lib/unresolvedBankRows";
import { LEDGER_READ_TABLES } from "../lib/ledgerCache";
import { findMigrationsDir } from "../lib/migrationsDir";
import { RICH_NOW, cleanupRichHouseholds, seedRichHousehold } from "./_fixtures/richHousehold";

/** The revision table itself. */
const EXEMPT = new Set(["household_data_revisions"]);
const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib");
const ROOTS = ["forecastLedger.ts", "cashSignal.ts", "avalancheWeeklyPlan.ts", "supersededPending.ts", "spendingFacts.ts", "unresolvedBankRows.ts"];

const W = `perf-rev-w-${process.pid}-${randomUUID().slice(0, 8)}`;
const M = `perf-rev-m-${process.pid}-${randomUUID().slice(0, 8)}`;
const hh: Record<string, string> = {};

beforeAll(async () => {
  vi.setSystemTime(RICH_NOW);
  const sql = await readFile(path.join(findMigrationsDir(import.meta.url), "0251_household_data_revisions.sql"), "utf8");
  await pool.query(sql);
  hh[W] = (await seedRichHousehold(W, { scale: 1, weekly: true })).householdId;
  hh[M] = (await seedRichHousehold(M, { scale: 1 })).householdId;
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  await cleanupRichHouseholds([W, M]);
});

async function triggered(): Promise<Set<string>> {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = 'h2_data_rev_row' AND t.tgdeferrable AND t.tginitdeferred AND c.relnamespace = to_regnamespace(current_schema())`,
  );
  return new Set(rows.map((r) => r.relname));
}

/** The local modules (src/lib) reachable from the cached builds by static and dynamic imports. */
function closure(): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, "utf8");
    seen.set(file, src);
    for (const m of src.matchAll(/(?:from\s+|import\()\s*["'](\.\.?\/[^"']+)["']/g)) {
      const base = path.resolve(path.dirname(file), m[1]!);
      for (const cand of [`${base}.ts`, path.join(base, "index.ts")]) {
        if (cand.startsWith(LIB) && existsSync(cand) && !cand.endsWith(".test.ts")) {
          visit(cand);
          break;
        }
      }
    }
  };
  for (const r of ROOTS) visit(path.join(LIB, r));
  return seen;
}

describe("(PERF) household data revision — no unseen read", () => {
  it("STATIC: every table the cached builds' modules import has its triggers and is in LEDGER_READ_TABLES", async () => {
    const tables = new Map<string, string[]>();
    for (const [file, src] of closure()) {
      for (const block of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@workspace\/db["']/g)) {
        for (const raw of block[1]!.split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, "");
          const t = (schema as Record<string, unknown>)[name];
          if (t && isTable(t)) {
            const sqlName = getTableName(t);
            tables.set(sqlName, [...(tables.get(sqlName) ?? []), path.basename(file)]);
          }
        }
      }
      // Hand-written SQL in those modules: FROM / JOIN a table name.
      for (const m of src.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_][a-z0-9_]+)"?/g)) {
        const n = m[1]!;
        if (Object.values(schema).some((t) => isTable(t) && getTableName(t) === n)) tables.set(n, [...(tables.get(n) ?? []), path.basename(file)]);
      }
    }
    expect(tables.size).toBeGreaterThan(5);
    const have = await triggered();
    const missing = [...tables].filter(([t]) => !EXEMPT.has(t) && (!have.has(t) || !(LEDGER_READ_TABLES as readonly string[]).includes(t)));
    expect(missing.map(([t, f]) => `${t} (read in ${[...new Set(f)].join(", ")})`)).toEqual([]);
  });

  it("LIVE: every table the builds send SQL to is in LEDGER_READ_TABLES", async () => {
    const seen = new Set<string>();
    const orig = pool.query;
    (pool as unknown as { query: unknown }).query = function (this: unknown, ...a: unknown[]) {
      const t = typeof a[0] === "string" ? a[0] : ((a[0] as { text?: string } | undefined)?.text ?? "");
      for (const m of t.matchAll(/\b(?:from|join)\s+"?([a-z_][a-z0-9_]*)"?/gi)) seen.add(m[1]!.toLowerCase());
      return (orig as (...x: unknown[]) => unknown).apply(this, a);
    };
    process.env.LEDGER_CACHE = "off";
    process.env.LEDGER_SHARING = "off";
    try {
      for (const owner of [W, M]) {
        for (const opts of [{ horizonDays: 90 }, { horizonDays: 365, fromDate: "2026-10-01" }, {}]) {
          await computeCashSignalDetailed(hh[owner]!, owner, opts);
        }
        await loadWeeklyAvalanchePlan(hh[owner]!, owner);
        await findSupersededPendingForRange(hh[owner]!, "2026-10-01", "2026-10-14");
        await buildSpendingFacts(hh[owner]!, "2026-10-01", "2026-10-14");
        await readUnresolvedBankRows(hh[owner]!, owner);
      }
    } finally {
      (pool as unknown as { query: unknown }).query = orig;
      delete process.env.LEDGER_CACHE;
      delete process.env.LEDGER_SHARING;
    }
    const known = new Set<string>(Object.values(schema).filter((t) => isTable(t)).map((t) => getTableName(t as never) as string));
    const read = [...seen].filter((t) => known.has(t) && !EXEMPT.has(t));
    expect(read.length).toBeGreaterThan(5);
    expect(read.filter((t) => !(LEDGER_READ_TABLES as readonly string[]).includes(t))).toEqual([]);
  });
});
