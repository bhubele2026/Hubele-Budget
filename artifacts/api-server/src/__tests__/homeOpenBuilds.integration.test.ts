// ⭐ (PERF) CI GUARD — WHAT ONE HOME OPEN COSTS THE SERVER.
//
// Home asks, at once: the spine, the 90-day cash signal, the weekly avalanche,
// the bank items and the review count; then, idle, the warm-up's
// /forecast?days=90. Measured from Server-Timing (lib/requestTiming.ts) over
// the rich household with the weekly cadence and the data-revision triggers
// (migration 0251) in place:
//   - a cold open builds ONE 90-day ledger and at most one 400-day base;
//   - a warm repeat at the same revision builds none;
//   - the spine stays under a query ceiling.
// A change that adds a build, splits a shared key or bloats the spine fails here.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";

const OWNER = `perf-home-${process.pid}-${randomUUID().slice(0, 8)}`;
let HOUSEHOLD = "";
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HOUSEHOLD;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import { pool } from "@workspace/db";
import fullRouter from "../routes";
import { instrumentPool, requestTiming } from "../lib/requestTiming";
import { _resetLedgerCacheForTests } from "../lib/ledgerCache";
import { findMigrationsDir } from "../lib/migrationsDir";
import { RICH_NOW, cleanupRichHouseholds, seedRichHousehold } from "./_fixtures/richHousehold";

/** Measured 2026-11-12 at scale 1: 190 queries cold (it builds the ledger), 86 warm. Ceilings with ~10 % room. */
const SPINE_QUERIES_COLD_MAX = 210;
const SPINE_QUERIES_WARM_MAX = 95;

const HOME = [
  "/spine",
  "/forecast/cash-signal?horizonDays=90",
  "/avalanche/weekly",
  "/plaid/items",
  "/categorization/review/count",
];
const WARMUP = ["/forecast?days=90", "/debts"];

let server: Server;
let base = "";
const count = (v: string | null, name: string) => {
  const m = (v ?? "").match(new RegExp(`(?:^|, )${name.replace(".", "\\.")};[^,]*desc="(\\d+)`));
  return m ? Number(m[1]) : 0;
};
async function open() {
  const fetchOne = async (p: string) => {
    const r = await fetch(`${base}${p}`);
    await r.arrayBuffer();
    expect(r.status, p).toBe(200);
    return { p, st: r.headers.get("server-timing") };
  };
  const first = await Promise.all(HOME.map(fetchOne));
  const later = [];
  for (const p of WARMUP) later.push(await fetchOne(p));
  const all = [...first, ...later];
  const sum = (name: string) => all.reduce((s, x) => s + count(x.st, name), 0);
  return { ledger: sum("ledger"), base: sum("base400"), spineQueries: count(first[0]!.st, "db") };
}

beforeAll(async () => {
  vi.setSystemTime(RICH_NOW);
  await pool.query(await readFile(path.join(findMigrationsDir(import.meta.url), "0251_household_data_revisions.sql"), "utf8"));
  HOUSEHOLD = (await seedRichHousehold(OWNER, { scale: 1, weekly: true })).householdId;
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
  await new Promise<void>((res) => server.close(() => res()));
  vi.useRealTimers();
  await cleanupRichHouseholds([OWNER]);
});

const rev = async () =>
  Number((await pool.query<{ rev: string }>("SELECT rev::text AS rev FROM household_data_revisions WHERE household_id = $1", [HOUSEHOLD])).rows[0]?.rev ?? 0);

describe("(PERF) one Home open", () => {
  it("cold: one 90-day ledger, at most one 400-day base; warm repeat at the same revision: none; the spine under its query ceiling", async () => {
    _resetLedgerCacheForTests();
    const cold = await open();
    expect(cold.ledger).toBe(1);
    expect(cold.base).toBeLessThanOrEqual(1);
    expect(cold.spineQueries).toBeLessThanOrEqual(SPINE_QUERIES_COLD_MAX);
    // The repeat that starts at the revision the previous open ended at, and ends there too, builds nothing (a cold
    // open may itself write — the day's first answers — so the open right after it can be the first at a revision).
    let warm: Awaited<ReturnType<typeof open>> | null = null;
    const revs: number[] = [await rev()];
    for (let i = 0; i < 4 && !warm; i++) {
      const o = await open();
      revs.push(await rev());
      // This open began at the revision the previous open ended at, and that previous open wrote nothing either.
      const n = revs.length;
      if (n >= 3 && revs[n - 1] === revs[n - 2] && revs[n - 2] === revs[n - 3]) warm = o;
    }

    expect(warm, "an open that wrote nothing").not.toBeNull();
    expect(warm!.ledger).toBe(0);
    expect(warm!.base).toBe(0);
    expect(warm!.spineQueries).toBeLessThanOrEqual(SPINE_QUERIES_WARM_MAX);
  });
});
