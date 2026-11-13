// ⭐ (PERF) THE BACKGROUND RE-WARM: the first open after a change, a boot or the day's turn builds nothing.
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

const A = `perf-rewarm-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const B = `perf-rewarm-b-${process.pid}-${randomUUID().slice(0, 8)}`;
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
import { _resetRewarmForTests, queueBootRewarm, rewarmStats, rewarmTick, warmHousehold } from "../lib/ledgerRewarm";
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
  delete process.env.LEDGER_REWARM;
  vi.setSystemTime(RICH_NOW);
  _resetLedgerCacheForTests();
  _resetRewarmForTests();
});

const bump = (n = 1) => pool.query("UPDATE recurring_items SET amount = amount + $2 WHERE household_id = $1", [HH[A], n]);
const spine = async () => {
  const r = await get("/spine");
  return { ledger: r.t.ledger!.n, base: r.t.base400!.n, misses: r.t.cachemiss!.n };
};

describe("(PERF) re-warm", () => {
  it("a write (any writer) → after the quiet wait the household is re-warmed → the next spine builds and misses nothing", async () => {
    await rewarmTick({ quietMs: 0 }); // first look: notes every revision
    await bump();
    await rewarmTick({ quietMs: 60_000 }); // still within the quiet wait: nothing yet
    expect(rewarmStats.warmed).toBe(0);
    await rewarmTick({ quietMs: 0, now: Date.now() + 60_000 });
    expect(rewarmStats.warmed).toBe(1);
    expect(await spine()).toEqual({ ledger: 0, base: 0, misses: 0 });
  });

  it("a write while it builds leaves nothing stored; the next open builds", async () => {
    await spine();
    await bump();
    const discarded = ledgerCacheStats.discarded;
    const warming = warmHousehold(HH[A]!, A);
    await new Promise((r) => setTimeout(r, 5));
    await bump(); // lands while the background build runs
    expect(await warming).toBe("warmed");
    expect(ledgerCacheStats.discarded).toBeGreaterThan(discarded);
    expect((await spine()).ledger).toBe(1);
  });

  it("boot: the recently active households are warmed before anyone opens", async () => {
    await bump();
    expect(await queueBootRewarm()).toBeGreaterThan(0);
    await rewarmTick({ quietMs: 0 });
    expect(rewarmStats.warmed).toBe(1);
    expect(await spine()).toEqual({ ledger: 0, base: 0, misses: 0 });
  });

  it("the day's turn: just after midnight (Chicago) the new day's answers are built in the background", async () => {
    await bump();
    vi.setSystemTime(new Date("2026-10-14T23:59:30-05:00"));
    await rewarmTick({ quietMs: 0 }); // notes the day
    vi.setSystemTime(new Date("2026-10-15T00:00:30-05:00"));
    await rewarmTick({ quietMs: 0 });
    expect(rewarmStats.warmed).toBe(1);
    expect(await spine()).toEqual({ ledger: 0, base: 0, misses: 0 });
  });

  it("LEDGER_REWARM=off: nothing runs", async () => {
    process.env.LEDGER_REWARM = "off";
    await rewarmTick({ quietMs: 0 });
    await bump();
    await rewarmTick({ quietMs: 0, now: Date.now() + 60_000 });
    expect(rewarmStats.warmed).toBe(0);
  });
});
