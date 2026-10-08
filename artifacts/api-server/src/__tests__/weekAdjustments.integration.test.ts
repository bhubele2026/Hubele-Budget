// ⭐ (V5) A way back when the week is over — the table, the routes, and the
// money position with a carry-over, every figure worked by hand.
//
// Pinned now: Wed 2026-10-07 12:00 Central (week Sun 10/4 – Sat 10/10), then
// Wed 2026-10-14 (week Sun 10/11 – Sat 10/17) for the carried week. All figures
// are synthetic.
//
// Household A — owner A, member AM.
//   Checking snapshot $3,000.00 (typed in, Sun 10/4 08:00), cash buffer $500,
//   no plans: no payday, the window runs to Saturday; available = 2,500.00.
//   Weekly cap $300 (allowance plan).
//   This week, on the card: Dining 10/5 −150.00 and 10/6 −30.00 (weekly),
//   Groceries 10/6 −120.00 (filed nowhere: counts), Fun 10/7 −40.00 (weekly),
//   Hardware 10/6 −500.00 (unplanned: beside the cap).
//   → counted 180 + 120 + 40 = 340.00; remaining 300 − 340 = −40.00 (over by 40).
//   Dining's 8 weeks before: 10/3 −100.01 · 9/15 −120.00 · 9/8 −80.00 ·
//   8/25 −90.01 · 8/18 −110.00 · 8/11 −70.00 (none in the weeks of 9/20, 8/30)
//   → [0, 0, 70.00, 80.00, 90.01, 100.01, 110.00, 120.00] → usual 85.00.
// Household B — another owner, nothing set up.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const A_OWNER = `v5-wa-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const A_MEMBER = `v5-wa-am-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_OWNER = `v5-wa-b-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      headers: Record<string, string | string[] | undefined>;
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? A_OWNER);
    const hh = HH[who]!;
    req.userId = hh.ownerUserId;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  pool,
  allowancePlansTable,
  budgetCategoriesTable,
  forecastSettingsTable,
  householdMembersTable,
  planAdjustmentsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import moneyRouter from "../routes/money";
import spineRouter from "../routes/spine";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const WEEK1 = new Date("2026-10-07T12:00:00-05:00");
const WEEK2 = new Date("2026-10-14T12:00:00-05:00");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.resolve(HERE, "../../../../lib/db/migrations/0115_plan_adjustments.sql");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(spineRouter);

let server: Server;
let baseUrl: string;
let AMEX = "";
let DINING = "";
let GROCERIES = "";
let FUN = "";

async function call(method: string, p: string, body?: unknown, as: string = A_OWNER): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { "x-test-user": as, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
const get = async (p: string, as: string = A_OWNER) => {
  const r = await call("GET", p, undefined, as);
  if (r.status !== 200) throw new Error(`GET ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
const rowsOf = async (hh: string) =>
  db
    .select({ weekStart: planAdjustmentsTable.weekStart, amountCents: planAdjustmentsTable.amountCents, reason: planAdjustmentsTable.reason, createdBy: planAdjustmentsTable.createdBy })
    .from(planAdjustmentsTable)
    .where(eq(planAdjustmentsTable.householdId, hh))
    .orderBy(planAdjustmentsTable.weekStart);

async function cleanup(): Promise<void> {
  for (const u of [A_OWNER, B_OWNER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, u));
    await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, u));
    await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, u));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
  const ids = Object.values(HH).map((h) => h.householdId);
  if (ids.length) {
    await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, ids));
    await db.delete(planAdjustmentsTable).where(inArray(planAdjustmentsTable.householdId, ids));
  }
}

beforeAll(async () => {
  vi.setSystemTime(WEEK1);
  HH[A_OWNER] = await createTestHousehold(A_OWNER);
  HH[B_OWNER] = await createTestHousehold(B_OWNER);
  await db
    .insert(householdMembersTable)
    .values({ userId: A_MEMBER, householdId: HH[A_OWNER]!.householdId, role: "member" })
    .onConflictDoNothing();
  HH[A_MEMBER] = { householdId: HH[A_OWNER]!.householdId, ownerUserId: A_OWNER };
  await cleanup();
  const A = HH[A_OWNER]!.householdId;
  const base = { userId: A_OWNER, householdId: A };

  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: item!.id, accountId: `acct-chase-${randomUUID()}`, name: "Chase Checking", type: "depository", subtype: "checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: acct!.id,
  });
  const cat = async (name: string) =>
    (await db.insert(budgetCategoriesTable).values({ ...base, name, kind: "expense", groupName: "Everyday" }).returning())[0]!.id;
  DINING = await cat(`Dining ${randomUUID().slice(0, 4)}`);
  GROCERIES = await cat(`Groceries ${randomUUID().slice(0, 4)}`);
  FUN = await cat(`Fun ${randomUUID().slice(0, 4)}`);
  const HARDWARE = await cat(`Hardware ${randomUUID().slice(0, 4)}`);
  AMEX = `acct-amex-${randomUUID()}`;
  const card = (occurredOn: string, description: string, amount: string, categoryId: string, flags: { weeklyAllowance?: boolean; unplannedAllowance?: boolean } = {}) => ({
    ...base,
    occurredOn,
    createdAt: createdAtStartOfHouseholdDay(occurredOn),
    description,
    amount,
    plaidAccountId: AMEX,
    source: "plaid:amex",
    categoryId,
    weeklyAllowance: flags.weeklyAllowance ?? false,
    unplannedAllowance: flags.unplannedAllowance ?? false,
  });
  await db.insert(transactionsTable).values([
    card("2026-10-05", "BISTRO", "-150.00", DINING, { weeklyAllowance: true }),
    card("2026-10-06", "CAFE", "-30.00", DINING, { weeklyAllowance: true }),
    card("2026-10-06", "GROCER", "-120.00", GROCERIES),
    card("2026-10-07", "ARCADE", "-40.00", FUN, { weeklyAllowance: true }),
    card("2026-10-06", "HARDWARE", "-500.00", HARDWARE, { unplannedAllowance: true }),
    card("2026-10-03", "BISTRO", "-100.01", DINING, { weeklyAllowance: true }),
    card("2026-09-15", "BISTRO", "-120.00", DINING, { weeklyAllowance: true }),
    card("2026-09-08", "BISTRO", "-80.00", DINING, { weeklyAllowance: true }),
    card("2026-08-25", "BISTRO", "-90.01", DINING, { weeklyAllowance: true }),
    card("2026-08-18", "BISTRO", "-110.00", DINING, { weeklyAllowance: true }),
    card("2026-08-11", "BISTRO", "-70.00", DINING, { weeklyAllowance: true }),
  ]);
  await db.insert(allowancePlansTable).values({
    householdId: A,
    memberUserId: null,
    period: "weekly",
    amount: "300.00",
    effectiveFrom: "2026-05-01",
    source: "owner",
  });

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, A_MEMBER));
});

describe("GET /money/ways-back — the fixture week (cap 300, spent 340)", () => {
  it("every figure, worked by hand, in whole cents", async () => {
    const pos = await get("/money/position");
    expect([pos.weekCap, pos.spentWeekDiscretionary, pos.remainingWeek, pos.withinPlan]).toEqual(["300.00", "340.00", "-40.00", "over"]);
    expect(pos.availableUntilPayday).toBe("2500.00");
    expect(pos.weekAdjustment).toBeNull();

    const w = await get("/money/ways-back");
    expect(w).toEqual({
      weekStart: "2026-10-04",
      weekEnd: "2026-10-10",
      overBy: 4000,
      daysLeft: 4,
      hold: { perDay: 0, leavesUntilPayday: 250000 },
      trims: [
        { categoryId: DINING, name: expect.stringMatching(/^Dining/), spentWeek: 18000, usualWeek: 8500 },
        { categoryId: GROCERIES, name: expect.stringMatching(/^Groceries/), spentWeek: 12000, usualWeek: 0 },
        { categoryId: FUN, name: expect.stringMatching(/^Fun/), spentWeek: 4000, usualWeek: 0 },
      ],
      carryOver: { nextWeekStart: "2026-10-11", nextWeekCap: 26000, applied: false, adjustment: null },
    });
    // The trims never exceed what counts against the cap.
    expect(w.trims.reduce((s: number, t: { spentWeek: number }) => s + t.spentWeek, 0)).toBeLessThanOrEqual(34000);
  });

  it("is read-only and a member reads the same answer", async () => {
    const before = await rowsOf(HH[A_OWNER]!.householdId);
    expect(await get("/money/ways-back", A_MEMBER)).toEqual(await get("/money/ways-back"));
    expect(await rowsOf(HH[A_OWNER]!.householdId)).toEqual(before);
  });

  it("another household sees none of it", async () => {
    const w = await get("/money/ways-back", B_OWNER);
    expect(w).toMatchObject({ overBy: 0, hold: { perDay: null, leavesUntilPayday: null }, trims: [], carryOver: { nextWeekCap: null, applied: false } });
  });
});

describe("POST / DELETE /money/week-adjustments", () => {
  it("the owner carries the overage into next week: upserted, said in this week's assumptions, no figure moves", async () => {
    const before = await get("/money/position");
    const r = await call("POST", "/money/week-adjustments", { weekStart: "2026-10-11", amountCents: -4000, reason: "Over by $40" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ weekStart: "2026-10-11", kind: "carry_over", amountCents: -4000, reason: "Over by $40", createdAt: expect.any(String) });
    expect(await rowsOf(HH[A_OWNER]!.householdId)).toEqual([{ weekStart: "2026-10-11", amountCents: -4000, reason: "Over by $40", createdBy: A_OWNER }]);

    const after = await get("/money/position");
    expect(after.assumptions).toEqual([...before.assumptions, "Next week starts $40.00 lower (you chose this)"]);
    const { assumptions: _a, ...a } = before;
    const { assumptions: _b, ...b } = after;
    expect(b).toEqual(a);

    const w = await get("/money/ways-back");
    expect(w.carryOver).toEqual({
      nextWeekStart: "2026-10-11",
      nextWeekCap: 26000,
      applied: true,
      adjustment: { weekStart: "2026-10-11", amountCents: -4000, reason: "Over by $40" },
    });
  });

  it("a second choice for the same week replaces the first (one row)", async () => {
    const r = await call("POST", "/money/week-adjustments", { weekStart: "2026-10-11", amountCents: -5000 });
    expect(r.status).toBe(200);
    expect(await rowsOf(HH[A_OWNER]!.householdId)).toEqual([{ weekStart: "2026-10-11", amountCents: -5000, reason: null, createdBy: A_OWNER }]);
    expect((await get("/money/ways-back")).carryOver.nextWeekCap).toBe(25000);
    await call("POST", "/money/week-adjustments", { weekStart: "2026-10-11", amountCents: -4000, reason: "Over by $40" });
  });

  it("a carry-over on THIS week lowers remainingWeek and safeToSpendNow to the cent; delete restores them", async () => {
    expect((await call("POST", "/money/week-adjustments", { weekStart: "2026-10-04", amountCents: -2501 })).status).toBe(200);
    const p = await get("/money/position");
    expect(p.weekAdjustment).toEqual({ amount: "-25.01", reason: null, weekStart: "2026-10-04" });
    expect(p.weekCap).toBe("300.00");
    expect(p.remainingWeek).toBe("-65.01"); // 300 − 25.01 − 340
    expect(p.safeToSpendNow).toBe("0.00");
    expect((await get("/money/ways-back")).overBy).toBe(6501);
    expect(p.assumptions).toContain("This week starts $25.01 lower (you chose this)");

    const del = await call("DELETE", "/money/week-adjustments/2026-10-04");
    expect(del.status).toBe(204);
    expect((await get("/money/position")).remainingWeek).toBe("-40.00");
    expect((await call("DELETE", "/money/week-adjustments/2026-10-04")).status).toBe(404);
  });

  it("refuses anything that is not a negative whole number of cents on a Sunday, this week or later", async () => {
    const bad: unknown[] = [
      { weekStart: "2026-10-18", amountCents: 0 },
      { weekStart: "2026-10-18", amountCents: 4000 },
      { weekStart: "2026-10-18", amountCents: -12.5 },
      { weekStart: "2026-10-18", amountCents: "-4000" },
      { weekStart: "2026-10-18", amountCents: -10000001 },
      { amountCents: -4000 },
      { weekStart: "2026-10-19", amountCents: -4000 }, // a Monday
      { weekStart: "2026-02-30", amountCents: -4000 },
      { weekStart: "2026-09-27", amountCents: -4000 }, // last week
      { weekStart: "2026-10-18", amountCents: -4000, kind: "raise" }, // unknown key
      { weekStart: "2026-10-18", amountCents: -4000, reason: "x".repeat(201) },
    ];
    for (const body of bad) {
      const r = await call("POST", "/money/week-adjustments", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await rowsOf(HH[A_OWNER]!.householdId)).map((x) => x.weekStart)).toEqual(["2026-10-11"]);
    expect((await call("DELETE", "/money/week-adjustments/2026-13-01")).status).toBe(400);
  });

  it("a member is refused with owner_only; the row is untouched", async () => {
    const post = await call("POST", "/money/week-adjustments", { weekStart: "2026-10-18", amountCents: -100 }, A_MEMBER);
    expect(post).toEqual({ status: 403, json: { error: "owner_only" } });
    const del = await call("DELETE", "/money/week-adjustments/2026-10-11", undefined, A_MEMBER);
    expect(del).toEqual({ status: 403, json: { error: "owner_only" } });
    expect((await rowsOf(HH[A_OWNER]!.householdId)).map((x) => x.amountCents)).toEqual([-4000]);
  });

  it("household scoping: B writes and deletes only its own row", async () => {
    expect((await call("POST", "/money/week-adjustments", { weekStart: "2026-10-11", amountCents: -1000 }, B_OWNER)).status).toBe(200);
    expect((await rowsOf(HH[B_OWNER]!.householdId)).map((x) => x.amountCents)).toEqual([-1000]);
    expect((await call("DELETE", "/money/week-adjustments/2026-10-11", undefined, B_OWNER)).status).toBe(204);
    expect((await call("DELETE", "/money/week-adjustments/2026-10-11", undefined, B_OWNER)).status).toBe(404);
    expect(await rowsOf(HH[B_OWNER]!.householdId)).toEqual([]);
    expect((await rowsOf(HH[A_OWNER]!.householdId)).map((x) => x.amountCents)).toEqual([-4000]);
    expect((await get("/money/ways-back")).carryOver.adjustment).toMatchObject({ amountCents: -4000 });
  });
});

describe("the carried week (Wed 2026-10-14) — position, ways back and the spine", () => {
  it("remaining = 300 − 40 − 60 = 200.00; the spine carries the same adjustment", async () => {
    const A = HH[A_OWNER]!.householdId;
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: A_OWNER,
        householdId: A,
        occurredOn: "2026-10-12",
        createdAt: createdAtStartOfHouseholdDay("2026-10-12"),
        description: "BISTRO",
        amount: "-60.00",
        plaidAccountId: AMEX,
        source: "plaid:amex",
        categoryId: DINING,
        weeklyAllowance: true,
      })
      .returning();
    vi.setSystemTime(WEEK2);
    try {
      const p = await get("/money/position");
      expect(p.weekStart).toBe("2026-10-11");
      expect(p.weekCap).toBe("300.00");
      expect(p.weekAdjustment).toEqual({ amount: "-40.00", reason: "Over by $40", weekStart: "2026-10-11" });
      expect(p.spentWeekDiscretionary).toBe("60.00");
      expect(p.remainingWeek).toBe("200.00");
      expect(p.safeToSpendNow).toBe("200.00"); // min(200.00, 2,500.00)
      expect(p.withinPlan).toBe("yes"); // 200 × 7 = 1,400 ≥ 300 × 4 = 1,200
      expect(p.assumptions).toContain("This week starts $40.00 lower (you chose this)");

      const spine = await get("/spine");
      expect(spine.position.weekAdjustment).toEqual(p.weekAdjustment);
      expect(spine.position.remainingWeek).toBe(p.remainingWeek);
      expect(spine.position.safeToSpendNow).toBe(p.safeToSpendNow);

      const w = await get("/money/ways-back");
      expect(w).toMatchObject({
        weekStart: "2026-10-11",
        overBy: 0,
        daysLeft: 4,
        hold: { perDay: 5000, leavesUntilPayday: Math.round(Number(p.availableUntilPayday) * 100) },
        carryOver: { nextWeekStart: "2026-10-18", nextWeekCap: 30000, applied: false, adjustment: null },
      });
      expect(w.trims[0]).toMatchObject({ categoryId: DINING, spentWeek: 6000 });
    } finally {
      vi.setSystemTime(WEEK1);
      await db.delete(transactionsTable).where(eq(transactionsTable.id, row!.id));
    }
  });
});

describe("0115_plan_adjustments.sql", () => {
  const SCRATCH = `v5_sql_check_${process.pid}`;
  const TABLES = ["plan_adjustments"];
  async function describeSchema(client: { query: typeof pool.query }, schema: string) {
    const cols = await client.query(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns where table_schema = $1 and table_name = any($2)
        order by table_name, column_name`,
      [schema, TABLES],
    );
    const idx = await client.query(
      `select regexp_replace(indexdef, ' ON [a-z0-9_]+\\.', ' ON ') as def
         from pg_indexes where schemaname = $1 and tablename = any($2) order by indexname`,
      [schema, TABLES],
    );
    const cons = await client.query(
      `select c.conname, c.contype, pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = $1 and c.conrelid::regclass::text = any($2) and c.contype in ('c', 'f', 'u')
        order by 1`,
      [schema, TABLES.flatMap((t) => [t, `${schema}.${t}`])],
    );
    return {
      cols: cols.rows,
      idx: idx.rows.map((r) => r.def),
      cons: cons.rows.map((r) => `${r.conname} ${r.contype} ${String(r.def).replace(`${schema}.`, "")}`),
    };
  }
  afterAll(async () => {
    await pool.query(`drop schema if exists ${SCRATCH} cascade`);
  });

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
      await client.query(sqlText); // third
      const scratch = await describeSchema(client, SCRATCH);
      await client.query("set search_path to public");
      const pub = await describeSchema(client, "public");
      expect(scratch.cols.length).toBe(8);
      expect(scratch.cols).toEqual(pub.cols);
      expect(scratch.idx).toEqual(pub.idx);
      expect(scratch.cons).toEqual(pub.cons);
      expect(scratch.cons).toHaveLength(4);
    } finally {
      await client.query("reset search_path");
      client.release();
    }
  });

  it("the table refuses a zero or positive amount, an unknown kind and a second row for the same week", async () => {
    const hh = HH[B_OWNER]!.householdId;
    const ins = (amountCents: number, kind = "carry_over", weekStart = "2026-11-01") =>
      db.insert(planAdjustmentsTable).values({ householdId: hh, weekStart, amountCents, kind });
    await expect(ins(0)).rejects.toThrow();
    await expect(ins(100)).rejects.toThrow();
    await expect(ins(-100, "raise")).rejects.toThrow();
    await ins(-100);
    await expect(ins(-200)).rejects.toThrow();
    await db.delete(planAdjustmentsTable).where(and(eq(planAdjustmentsTable.householdId, hh)));
  });
});
