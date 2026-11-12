// (PERF-0) Server-Timing on the real router over the rich household with the
// WEEKLY avalanche cadence: the header is there on /spine with sane fields,
// and each request's counts are its own when two run at once.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";

const OWNER = `perf0-timing-${process.pid}-${randomUUID().slice(0, 8)}`;
let HOUSEHOLD_ID = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HOUSEHOLD_ID;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import { pool } from "@workspace/db";
import fullRouter from "../routes";
import { instrumentPool, requestTiming } from "../lib/requestTiming";
import { RICH_NOW, cleanupRichHouseholds, seedRichHousehold } from "./_fixtures/richHousehold";

type Metric = { name: string; dur?: number; desc?: string };
function parseServerTiming(v: string | null): Map<string, Metric> {
  const out = new Map<string, Metric>();
  for (const part of (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [name, ...params] = part.split(";");
    const m: Metric = { name: name! };
    for (const p of params) {
      const [k, raw] = p.split("=");
      if (k === "dur") m.dur = Number(raw);
      if (k === "desc") m.desc = raw!.replace(/^"|"$/g, "");
    }
    out.set(m.name, m);
  }
  return out;
}
const count = (m: Metric | undefined) => Number((m?.desc ?? "").split(" ")[0]);

let server: Server;
let base = "";

beforeAll(async () => {
  // These tests count builds; the result cache (lib/ledgerCache.ts) is tested on its own.
  process.env.LEDGER_CACHE = "off";
  vi.setSystemTime(RICH_NOW);
  const rich = await seedRichHousehold(OWNER, { scale: 1, weekly: true });
  HOUSEHOLD_ID = rich.householdId;
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
  delete process.env.LEDGER_SHARING;
  delete process.env.LEDGER_CACHE;
  await new Promise<void>((res) => server.close(() => res()));
  vi.useRealTimers();
  await cleanupRichHouseholds([OWNER]);
});

async function get(path: string) {
  const r = await fetch(`${base}${path}`);
  await r.arrayBuffer();
  expect(r.status).toBe(200);
  return parseServerTiming(r.headers.get("server-timing"));
}

describe("(PERF-0) Server-Timing", () => {
  it("is on /spine with every field, sane values, and nothing but durations and counts", async () => {
    const t = await get("/spine");
    for (const k of ["total", "db", "poolwait", "ledger", "base400", "share", "auth", "sp.cash", "sp.position", "sp.bills"]) {
      expect(t.has(k), k).toBe(true);
    }
    const total = t.get("total")!.dur!;
    expect(total).toBeGreaterThan(0);
    expect(count(t.get("db"))).toBeGreaterThan(10);
    expect(t.get("db")!.desc).toMatch(/^\d+ queries$/);
    // Every query checks a connection out of the pool once.
    expect(count(t.get("poolwait"))).toBe(count(t.get("db")));
    // The 90-day ledger, and — weekly cadence — the 400-day base it prices the weekly plan on.
    expect(count(t.get("ledger"))).toBeGreaterThanOrEqual(1);
    expect(count(t.get("base400"))).toBeGreaterThanOrEqual(1);
    expect(t.get("ledger")!.dur!).toBeGreaterThanOrEqual(t.get("base400")!.dur! / count(t.get("base400")));
    // A branch cannot take longer than the request.
    expect(t.get("sp.cash")!.dur!).toBeLessThanOrEqual(total);
    // No amount, no id: only the known shape.
    const raw = (await fetch(`${base}/spine`)).headers.get("server-timing")!;
    for (const part of raw.split(", ")) expect(part).toMatch(/^[A-Za-z0-9._-]+(;dur=\d+(\.\d)?)?(;desc="\d+ [a-z]+")?$/);
  });

  it("is on a small read too, with no ledger build", async () => {
    const t = await get("/avalanche/settings");
    expect(count(t.get("ledger"))).toBe(0);
    expect(count(t.get("base400"))).toBe(0);
    expect(count(t.get("db"))).toBeGreaterThan(0);
  });

  it("keeps each request's counts its own: two spines at once each count what one alone counts (sharing off)", async () => {
    process.env.LEDGER_SHARING = "off";
    await get("/spine");
    const solo = await get("/spine");
    const [a, b] = await Promise.all([get("/spine"), get("/spine")]);
    for (const t of [a, b]) {
      expect(count(t.get("db"))).toBe(count(solo.get("db")));
      expect(count(t.get("ledger"))).toBe(count(solo.get("ledger")));
      expect(count(t.get("base400"))).toBe(count(solo.get("base400")));
      expect(count(t.get("share"))).toBe(0);
    }
    delete process.env.LEDGER_SHARING;
  });

  it("with sharing on, a build two requests share counts once, for the one that started it", async () => {
    const solo = await get("/forecast/cash-signal?horizonDays=90");
    const [a, b] = await Promise.all([get("/forecast/cash-signal?horizonDays=90"), get("/forecast/cash-signal?horizonDays=90")]);
    const builds = count(a.get("ledger")) + count(b.get("ledger"));
    const joined = count(a.get("share")) + count(b.get("share"));
    expect(builds).toBe(count(solo.get("ledger")));
    expect(joined).toBeGreaterThanOrEqual(1);
  });
});
