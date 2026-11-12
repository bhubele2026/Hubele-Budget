// ⭐ (PERF) THE LEDGER CACHE IS KEPT HONEST BY THE DATABASE'S DATA REVISION.
//
// lib/ledgerCache.ts serves a computed ledger / weekly plan again only at the
// household's revision it was built at; triggers (migration 0251) move the
// revision on every write. These tests apply the migration to the test
// database, then check: a repeat at the same revision builds nothing; every
// kind of write — a route, a direct write with no request around it (a job, a
// script) — makes the next read build again and show it; two households never
// share; a write during a build leaves nothing cached; a new day is a new key;
// the kill switch and a database without triggers both mean "no cache".

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";

const A = `perf-cache-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const B = `perf-cache-b-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, string> = {};
let ACTOR = A;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = ACTOR;
    req.actualUserId = ACTOR;
    req.householdId = HH[ACTOR];
    req.householdOwnerId = ACTOR;
    next();
  },
}));

import { pool } from "@workspace/db";
import fullRouter from "../routes";
import { instrumentPool, requestTiming } from "../lib/requestTiming";
import {
  _resetLedgerCacheForTests,
  cachedLedgerRead,
  ledgerCacheSize,
  ledgerCacheStats,
  readHouseholdRevision,
  revisionTriggersReady,
} from "../lib/ledgerCache";
import { findMigrationsDir } from "../lib/migrationsDir";
import { RICH_NOW, cleanupRichHouseholds, seedRichHousehold } from "./_fixtures/richHousehold";

type Metric = { dur?: number; n: number };
function timing(v: string | null): Record<string, Metric> {
  const out: Record<string, Metric> = {};
  for (const part of (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [name, ...ps] = part.split(";");
    const m: Metric = { n: NaN };
    for (const p of ps) {
      const [k, raw] = p.split("=");
      if (k === "dur") m.dur = Number(raw);
      if (k === "desc") m.n = Number(raw!.replace(/"/g, "").split(" ")[0]);
    }
    out[name!] = m;
  }
  return out;
}

let server: Server;
let base = "";
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, t: timing(r.headers.get("server-timing")) };
}
const get = async (p: string) => {
  const r = await call("GET", p);
  expect(r.status, `${p} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
  return r;
};

beforeAll(async () => {
  vi.setSystemTime(RICH_NOW);
  // The revision table and triggers, as production gets them (idempotent; the suite's schema comes from drizzle push).
  const sql = await readFile(path.join(findMigrationsDir(import.meta.url), "0251_household_data_revisions.sql"), "utf8");
  await pool.query(sql);
  HH[A] = (await seedRichHousehold(A, { scale: 1, weekly: true })).householdId;
  HH[B] = (await seedRichHousehold(B, { scale: 1, weekly: true, manualExtra: "900" })).householdId;
  instrumentPool(pool);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", requestTiming());
  app.use("/api", fullRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}/api`;
}, 120_000);

afterAll(async () => {
  delete process.env.LEDGER_CACHE;
  await new Promise<void>((res) => server.close(() => res()));
  vi.useRealTimers();
  await cleanupRichHouseholds([A, B]);
});

beforeEach(() => {
  ACTOR = A;
  delete process.env.LEDGER_CACHE;
  vi.setSystemTime(RICH_NOW);
  _resetLedgerCacheForTests();
});

describe("(PERF) the household data revision", () => {
  it("is in place on every table the cached builds read, and moves on a write", async () => {
    expect(await revisionTriggersReady()).toBe(true);
    const r0 = await readHouseholdRevision(HH[A]!);
    await pool.query("UPDATE recurring_items SET name = name WHERE household_id = $1", [HH[A]]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 1);
    // One statement over many rows moves it once; another household's write does not move it.
    await pool.query("UPDATE transactions SET description = description WHERE household_id = $1", [HH[A]]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2);
    const rb = await readHouseholdRevision(HH[B]!);
    await pool.query("UPDATE debts SET name = name WHERE household_id = $1", [HH[B]]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2);
    expect(await readHouseholdRevision(HH[B]!)).toBe(rb + 1);
    // A rolled-back write leaves it where it was.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE debts SET name = name WHERE household_id = $1", [HH[A]]);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2);
  });
});

describe("(PERF) the weekly avalanche plan and its 400-day base, cached", () => {
  it("a repeat at the same revision prices the plan once; a write makes the next read price it again", async () => {
    const first = await get("/avalanche/weekly");
    expect(first.t.base400!.n).toBe(1);
    const again = await get("/avalanche/weekly");
    expect(again.t.base400!.n).toBe(0);
    expect(again.t.cache!.n).toBeGreaterThanOrEqual(1);
    expect(again.body).toEqual(first.body);
    // A direct write, with no request around it (a job, a script): the next read builds again.
    await pool.query("UPDATE avalanche_settings SET manual_extra = '1200' WHERE user_id = $1", [A]);
    const after = await get("/avalanche/weekly");
    expect(after.t.base400!.n).toBe(1);
    expect(after.body).not.toEqual(first.body);
  });

  it("never crosses households", async () => {
    const a = await get("/avalanche/weekly");
    ACTOR = B;
    const b = await get("/avalanche/weekly");
    expect(b.t.base400!.n).toBe(1);
    expect(b.body).not.toEqual(a.body);
  });

  it("a new household day is a new key", async () => {
    await get("/avalanche/weekly");
    vi.setSystemTime(new Date(RICH_NOW.getTime() + 24 * 3600_000));
    const next = await get("/avalanche/weekly");
    expect(next.t.base400!.n).toBe(1);
  });

  it("LEDGER_CACHE=off builds every time", async () => {
    process.env.LEDGER_CACHE = "off";
    await get("/avalanche/weekly");
    const again = await get("/avalanche/weekly");
    expect(again.t.base400!.n).toBe(1);
    expect(ledgerCacheSize()).toBe(0);
  });
});

describe("(PERF) cachedLedgerRead", () => {
  it("keeps nothing when the household was written while it built, and serves only the revision it was built at", async () => {
    let builds = 0;
    const build = async () => {
      builds += 1;
      // A write lands while this build runs.
      await pool.query("UPDATE recurring_items SET name = name WHERE household_id = $1", [HH[A]]);
      return { n: builds };
    };
    await cachedLedgerRead("probe", HH[A]!, "k", build);
    expect(ledgerCacheSize()).toBe(0);
    expect(ledgerCacheStats.discarded).toBe(1);
    const quiet = async () => ({ n: ++builds });
    const v1 = await cachedLedgerRead("probe", HH[A]!, "k", quiet);
    const v2 = await cachedLedgerRead("probe", HH[A]!, "k", quiet);
    expect(v2).toBe(v1);
    await pool.query("UPDATE forecast_settings SET cash_buffer = cash_buffer WHERE user_id = $1", [A]);
    const v3 = await cachedLedgerRead("probe", HH[A]!, "k", quiet);
    expect(v3).not.toBe(v1);
    // Same key text, other household: its own entry.
    const vb = await cachedLedgerRead("probe", HH[B]!, "k", quiet);
    expect(vb).not.toBe(v3);
  });

  it("with the triggers gone, nothing is cached", async () => {
    await pool.query("ALTER TABLE debts DISABLE TRIGGER h2_data_rev_upd");
    try {
      _resetLedgerCacheForTests();
      expect(await revisionTriggersReady()).toBe(false);
      let n = 0;
      await cachedLedgerRead("probe", HH[A]!, "k", async () => ++n);
      await cachedLedgerRead("probe", HH[A]!, "k", async () => ++n);
      expect(n).toBe(2);
    } finally {
      await pool.query("ALTER TABLE debts ENABLE TRIGGER h2_data_rev_upd");
      _resetLedgerCacheForTests();
    }
  });
});
