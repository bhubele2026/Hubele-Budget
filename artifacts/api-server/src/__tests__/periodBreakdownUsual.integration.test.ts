// ⭐ (F3) A FAIR "USUAL" — GET /money/period-breakdown and GET /money/ways-back
// compare a period still running with the SAME DAYS of the prior periods.
// Synthetic household, made-up amounts. Pinned now: Wed 2026-10-14 12:00 Central.
//
// Month (monthly-flagged Groceries, the brief's worked example):
//   Jul 5 100 · Jul 20 200 · Aug 10 50 · Aug 25 300 · Sep 14 80 · Sep 15 500;
//   October so far: Oct 3 120.
//   To the 14th: Jul 100 · Aug 50 · Sep 80 (the 14th counts) → usual 80.00;
//   full months: Jul 300 · Aug 350 · Sep 580 → usualFullPeriod 350.00;
//   aboveUsual = 120 − 80 = 40.00 (it read 0.00 against the full months).
//   September (a past month) reads whole: Jun 0 · Jul 300 · Aug 350 → 300.00.
// Week (weekly-flagged Dining; the week is Sun 10/11 – Sat 10/17; this week 10/12 60.00):
//   before: 9/6 Sun 20 · 9/16 Wed 30 · 9/19 Sat 70 · 9/27 Sun 40 · 10/4 Sun 10 · 10/8 Thu 90.
//   The 8 weeks from 8/16, read Sunday–Wednesday: [0,0,0,20,30,0,40,10]
//   → sorted [0,0,0,0,10,20,30,40] → floor((0 + 10) / 2) = 5.00; whole weeks
//   [0,0,0,20,100,0,40,100] → floor((0 + 20) / 2) = 10.00; above usual 55.00.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `f3-usual-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HH;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import {
  db,
  allowancePlansTable,
  budgetCategoriesTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { GetPeriodBreakdownResponse, GetWaysBackResponse } from "@workspace/api-zod";
import moneyRouter from "../routes/money";
import spineRouter from "../routes/spine";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-14T12:00:00-05:00");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(spineRouter);
let server: Server;
let baseUrl = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;
async function get(path: string): Promise<Json> {
  const r = await fetch(`${baseUrl}${path}`);
  const body = (await r.json()) as Json;
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

const cat: Record<string, string> = {};
let cardExt = "";

async function cleanup(): Promise<void> {
  if (!HH) return;
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
  await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, HH));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, HH));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  const owned = { userId: OWNER, householdId: HH };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...owned, itemId: `f3u-${randomUUID()}`, accessToken: "t", institutionSlug: "amex", institutionName: "American Express" })
    .returning();
  cardExt = `f3u-card-${randomUUID().slice(0, 8)}`;
  await db
    .insert(plaidAccountsTable)
    .values({ ...owned, itemId: item!.id, accountId: cardExt, name: "Amex Gold", mask: "7007", type: "credit", subtype: "credit card" });
  for (const n of ["Groceries", "Dining"]) {
    const [c] = await db.insert(budgetCategoriesTable).values({ ...owned, name: `${n} ${OWNER.slice(-4)}`, kind: "expense", groupName: "Everyday" }).returning();
    cat[n] = c!.id;
  }
  await db.insert(allowancePlansTable).values([
    { householdId: HH, memberUserId: null, period: "weekly", amount: "300.00", effectiveFrom: "2026-05-01", source: "owner" },
    { householdId: HH, memberUserId: null, period: "monthly", amount: "400.00", effectiveFrom: "2026-05-01", source: "owner" },
  ]);
  const row = (on: string, amount: string, category: "Groceries" | "Dining", flag: "monthly" | "weekly") => ({
    ...owned,
    occurredOn: on,
    createdAt: createdAtStartOfHouseholdDay(on),
    description: category === "Groceries" ? "GREEN GROCER" : "CORNER BISTRO",
    amount,
    plaidAccountId: cardExt,
    source: "plaid:amex",
    categoryId: cat[category]!,
    monthlyAllowance: flag === "monthly",
    weeklyAllowance: flag === "weekly",
  });
  await db.insert(transactionsTable).values([
    row("2026-07-05", "-100.00", "Groceries", "monthly"),
    row("2026-07-20", "-200.00", "Groceries", "monthly"),
    row("2026-08-10", "-50.00", "Groceries", "monthly"),
    row("2026-08-25", "-300.00", "Groceries", "monthly"),
    row("2026-09-14", "-80.00", "Groceries", "monthly"),
    row("2026-09-15", "-500.00", "Groceries", "monthly"),
    row("2026-10-03", "-120.00", "Groceries", "monthly"),
    row("2026-09-06", "-20.00", "Dining", "weekly"),
    row("2026-09-16", "-30.00", "Dining", "weekly"),
    row("2026-09-19", "-70.00", "Dining", "weekly"),
    row("2026-09-27", "-40.00", "Dining", "weekly"),
    row("2026-10-04", "-10.00", "Dining", "weekly"),
    row("2026-10-08", "-90.00", "Dining", "weekly"),
    row("2026-10-12", "-60.00", "Dining", "weekly"),
  ]);
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
});

describe("(F3) usual, read to the same point", () => {
  it("⭐ this month (Oct 14): usual by the 14th 80.00, a full month 350.00, 40.00 above usual", async () => {
    const b = await get("/money/period-breakdown?period=month&start=2026-10-01");
    expect(() => GetPeriodBreakdownResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject({ isCurrent: true, actual: "120.00", usualBasis: "same_days", usualThrough: "2026-10-14" });
    expect(b.categories).toHaveLength(1);
    expect(b.categories[0]).toMatchObject({ categoryId: cat.Groceries, amount: "120.00", usual: "80.00", usualFullPeriod: "350.00", aboveUsual: "40.00" });
    // The figures beside it do not move: the plan comparison and the spine read the same.
    expect(b).toMatchObject({ plan: { amount: "400.00" }, remaining: "280.00", over: "0.00", withinPlan: true });
    const spine = await get("/spine");
    expect(spine.monthAllowance).toEqual({ plan: "400.00", actual: "120.00", status: "within", remaining: "280.00", over: "0.00" });
  });

  it("a past month (September) reads whole months, as before", async () => {
    const b = await get("/money/period-breakdown?period=month&start=2026-09-01");
    expect(b).toMatchObject({ isCurrent: false, actual: "580.00", usualBasis: "full_period", usualThrough: null });
    // Jun 0 · Jul 300 · Aug 350 → 300.
    expect(b.categories[0]).toMatchObject({ usual: "300.00", usualFullPeriod: "300.00", aboveUsual: "280.00" });
  });

  it("this week (Wednesday): each prior week Sunday–Wednesday; ways-back reads the same cut", async () => {
    const b = await get("/money/period-breakdown?period=week&start=2026-10-11");
    expect(b).toMatchObject({ isCurrent: true, usualBasis: "same_days", usualThrough: "2026-10-14" });
    const dining = b.categories.find((c: Json) => c.categoryId === cat.Dining);
    expect(dining).toMatchObject({ amount: "60.00", usual: "5.00", usualFullPeriod: "10.00", aboveUsual: "55.00" });

    const w = await get("/money/ways-back");
    expect(() => GetWaysBackResponse.parse(w)).not.toThrow();
    expect(w).toMatchObject({ usualBasis: "same_days", usualThrough: "2026-10-14" });
    const trim = w.trims.find((t: Json) => t.categoryId === cat.Dining);
    expect(trim).toMatchObject({ spentWeek: 6000, usualWeek: 500, usualFullWeek: 1000 });
  });
});
