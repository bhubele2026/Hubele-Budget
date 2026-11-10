// ⭐ (AVAL-W) THE WEEKLY AVALANCHE ON THE FORECAST — the most that is safe each
// week, through the real ledger.
//
// A household paid every other Friday from 11/13 (so April 2027 has three paydays),
// rent on the 1st, the other bills on the 15th, seven invented debts, a $500
// buffer, $2,600 a month as the target, weekly on Fridays. Asserted:
//   - one `avalanche:extra` occurrence per Friday with something safe to pay,
//     "Avalanche payment → <debt>", sized from the curve — a thin week pays
//     little, the third-payday month pays a lot — and never a cap at the target;
//   - the curve, with those payments on it, never goes below the buffer;
//   - a paid-off debt's minimum stops after its payoff day (it is inside the
//     weekly figure from then on);
//   - a "skipped" answer takes its week off the curve by its own key, and the
//     cash rolls into the next week;
//   - `GET /avalanche/weekly` serves the same plan; the Forecast register lists
//     the same occurrences; a member cannot switch the cadence;
//   - back on monthly, the month-end extra returns and no minimum is cut.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `aval-weekly-${process.pid}-${randomUUID().slice(0, 8)}`;
const MEMBER = `${OWNER}-member`;
let HH = "";
let ACTOR = OWNER;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = ACTOR;
    req.actualUserId = ACTOR;
    req.householdId = HH;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  recurringItemsTable,
} from "@workspace/db";
import avalancheRouter from "../routes/avalanche";
import forecastRouter from "../routes/forecast";
import { computeCashSignal } from "../lib/cashSignal";
import { AVALANCHE_EXTRA_EVENT_ITEM_ID, AVALANCHE_EXTRA_LABEL } from "../lib/debtMinSchedule";
import { createTestHousehold } from "./_helpers/testHousehold";

// Tuesday 2026-11-10, midday in Chicago.
const NOW = new Date("2026-11-10T18:00:00Z");
const BUFFER = 500;

// Invented figures: four cards tied on the top APR, one with no minimum, one
// due on the 31st, a store loan and a large low-APR loan last.
const DEBTS = [
  { key: "a", name: "Card A", balance: "2000.00", apr: "0.2500", minPayment: "100", dueDay: 10 },
  { key: "b", name: "Card B", balance: "3000.00", apr: "0.2500", minPayment: "200", dueDay: 5 },
  { key: "c", name: "Card C", balance: "4000.00", apr: "0.2500", minPayment: "150", dueDay: 12 },
  { key: "d", name: "Card D", balance: "6000.00", apr: "0.2500", minPayment: "300", dueDay: 31 },
  { key: "e", name: "Card E", balance: "2500.00", apr: "0.2000", minPayment: "0", dueDay: 20 },
  { key: "store", name: "Store loan", balance: "2400.00", apr: "0.1500", minPayment: "120", dueDay: 8 },
  { key: "personal", name: "Personal loan", balance: "20000.00", apr: "0.1000", minPayment: "800", dueDay: 3 },
] as const;
const debtId: Record<string, string> = {};

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(avalancheRouter);
app.use(forecastRouter);
let server: Server;
let baseUrl = "";

async function call<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as T };
}

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, HH));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, HH));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, HH));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, OWNER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.householdId, HH));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.householdId, HH));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, HH));
}

async function seed(cadence: "weekly" | "monthly"): Promise<void> {
  await db.insert(forecastSettingsTable).values({
    userId: OWNER,
    householdId: HH,
    daysAhead: 90,
    cashBuffer: String(BUFFER),
    bankSnapshotBalance: "2500",
    bankSnapshotAt: new Date("2026-11-10T15:00:00Z"),
    bankSnapshotSource: "manual",
  });
  const item = (over: Partial<typeof recurringItemsTable.$inferInsert>) => ({
    userId: OWNER,
    householdId: HH,
    kind: "expense",
    frequency: "monthly",
    active: "true",
    createdAt: new Date("2026-01-01T18:00:00Z"),
    ...over,
  });
  await db.insert(recurringItemsTable).values([
    // Every other Friday from 11/13: 4/2, 4/16 and 4/30 make April 2027 a three-payday month.
    item({ name: "Paycheck", kind: "income", amount: "4000", frequency: "biweekly", anchorDate: "2026-11-13" }),
    // Set up this month: nothing before today is owed.
    item({ name: "Rent", amount: "2600", dayOfMonth: 1, anchorDate: "2026-12-01" }),
    item({ name: "Mid-month bills", amount: "1450", dayOfMonth: 15, anchorDate: "2026-11-15" }),
  ] as Array<typeof recurringItemsTable.$inferInsert>);
  for (const d of DEBTS) {
    const [row] = await db
      .insert(debtsTable)
      .values({
        userId: OWNER,
        householdId: HH,
        name: d.name,
        type: "credit_card",
        balance: d.balance,
        apr: d.apr,
        minPayment: d.minPayment,
        dueDay: d.dueDay,
        status: "active",
        // Entered today: no minimum before today is owed.
        createdAt: new Date("2026-11-10T15:00:00Z"),
      })
      .returning();
    debtId[d.key] = row!.id;
  }
  await db.insert(avalancheSettingsTable).values({
    userId: OWNER,
    householdId: HH,
    manualExtra: "2600",
    extraCadence: cadence,
    extraWeekday: 5,
    updatedAt: new Date("2026-11-01T18:00:00Z"),
  });
}

const isAvalanche = (e: { itemId: string }) => e.itemId === AVALANCHE_EXTRA_EVENT_ITEM_ID;
/** The signal's amounts are cents strings; money out is negative. */
const paidOf = (e: { amount: string | number }) => -Number(e.amount);

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  ACTOR = OWNER;
  await cleanup();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AVAL-W — weekly cadence on the forecast", () => {
  it("pays the most that is safe each Friday: a lot in the three-payday month, little in a thin week, never below the buffer", async () => {
    await seed("weekly");
    const sig = await computeCashSignal(HH, OWNER, { horizonDays: 200 });
    const pays = sig.events!.filter(isAvalanche);
    expect(pays.length).toBeGreaterThan(6);
    for (const p of pays) {
      expect(new Date(`${p.date}T12:00:00Z`).getUTCDay()).toBe(5);
      expect(p.date >= "2026-11-13").toBe(true);
      expect(p.label.startsWith("Avalanche payment → ")).toBe(true);
      expect(paidOf(p)).toBeGreaterThan(0);
    }
    expect(sig.events!.some((e) => e.label === AVALANCHE_EXTRA_LABEL)).toBe(false);
    // This Friday is payday: what checking holds above the buffer and every
    // bill until the next low — enough to clear Card A and start on Card B.
    expect(pays[0]).toMatchObject({ date: "2026-11-13", label: "Avalanche payment → Card A + Card B" });
    expect(paidOf(pays[0]!)).toBe(4180);
    const later = pays.slice(1);
    const april = later.filter((p) => p.date.startsWith("2027-04")).map(paidOf);
    const twoPaydayMonths = later.filter((p) => !p.date.startsWith("2027-04")).map(paidOf);
    // Not a flat share of the target, and never capped at it: the three-payday
    // month carries the largest payment, a thin week pays less than the pace.
    expect(new Set(later.map(paidOf)).size).toBeGreaterThan(3);
    expect(Math.max(...april)).toBeGreaterThan(3000);
    expect(Math.max(...april)).toBeGreaterThan(Math.max(...twoPaydayMonths));
    expect(Math.min(...later.map(paidOf))).toBeLessThan(600);
    // The curve with the payments on it never dips below the buffer.
    const fromFirst = sig.daily!.filter((d) => d.date >= "2026-11-13").map((d) => Number(d.balance));
    expect(Math.min(...fromFirst)).toBeGreaterThanOrEqual(BUFFER);
  });

  it("stops a paid-off debt's minimum after its payoff day, and keeps every other minimum", async () => {
    await seed("weekly");
    const { body: plan } = await call("GET", "/avalanche/weekly");
    const aOff = plan.payoffs.find((p: { debtId: string }) => p.debtId === debtId.a);
    expect(aOff).toBeTruthy();
    const sig = await computeCashSignal(HH, OWNER, { horizonDays: 120 });
    const aMins = sig.events!.filter((e) => e.itemId === `debt:${debtId.a}`).map((e) => e.date);
    expect(aMins.length).toBeGreaterThan(0);
    expect(aMins.every((d) => d <= aOff.date)).toBe(true);
    // The personal loan is not paid off inside the window: every month's minimum stays.
    const loanMins = sig.events!.filter((e) => e.itemId === `debt:${debtId.personal}`).map((e) => e.date);
    expect(loanMins).toEqual(["2026-12-03", "2027-01-03", "2027-02-03", "2027-03-03"]);
  });

  it("GET /avalanche/weekly is the plan on the curve: every occurrence is a week's due, with its targets and payoffs", async () => {
    await seed("weekly");
    const { status, body: plan } = await call("GET", "/avalanche/weekly");
    expect(status).toBe(200);
    expect(plan).toMatchObject({ cadence: "weekly", weekday: 5, monthlyTarget: 2600, targetWeekly: 600, cashBuffer: 500 });
    expect(plan.weeks[0]).toMatchObject({ date: "2026-11-13", room: 4180, due: 4180, paid: 4180, basis: "curve", answered: false });
    expect(plan.payoffs.map((p: { debtId: string }) => p.debtId)).toEqual(
      ["a", "b", "c", "d", "e", "store", "personal"].map((k) => debtId[k]),
    );
    expect(plan.payoffs.map((p: { date: string }) => p.date)).toEqual([
      "2026-11-13",
      "2026-12-11",
      "2027-01-08",
      "2027-03-05",
      "2027-04-02",
      "2027-04-16",
      "2027-08-06",
    ]);
    expect(plan.debtFreeDate).toBe("2027-08-06");
    const sig = await computeCashSignal(HH, OWNER, { horizonDays: 120 });
    const onCurve = sig.events!.filter(isAvalanche).map((e) => [e.date, paidOf(e)]);
    const fromPlan = plan.weeks
      .filter((w: { basis: string; due: number; date: string }) => w.basis === "curve" && w.due > 0 && w.date <= sig.toDate!)
      .map((w: { date: string; due: number }) => [w.date, w.due]);
    expect(onCurve).toEqual(fromPlan);
    // The 90-day and the 12-month forecasts price the same Fridays the same way.
    const year = await computeCashSignal(HH, OWNER, { horizonDays: 365 });
    const firstNinety = year.events!.filter((e) => isAvalanche(e) && e.date <= sig.toDate!).map((e) => [e.date, paidOf(e)]);
    expect(firstNinety).toEqual(onCurve);
  });

  it("a skipped week leaves the curve by its own key, and its cash rolls into the next Friday", async () => {
    await seed("weekly");
    const before = (await computeCashSignal(HH, OWNER, { horizonDays: 120 })).events!.filter(isAvalanche);
    const skipped = before[1]!;
    await db.insert(forecastResolutionsTable).values({
      userId: OWNER,
      householdId: HH,
      recurringItemId: AVALANCHE_EXTRA_EVENT_ITEM_ID,
      occurrenceDate: skipped.date,
      status: "skipped",
    });
    const sig = await computeCashSignal(HH, OWNER, { horizonDays: 120 });
    const after = sig.events!.filter(isAvalanche);
    expect(after.some((e) => e.date === skipped.date)).toBe(false);
    const next = after.find((e) => e.date > skipped.date)!;
    const nextBefore = before.find((e) => e.date === next.date);
    expect(paidOf(next)).toBeGreaterThan(nextBefore ? paidOf(nextBefore) : 0);
    const fromFirst = sig.daily!.filter((d) => d.date >= "2026-11-13").map((d) => Number(d.balance));
    expect(Math.min(...fromFirst)).toBeGreaterThanOrEqual(BUFFER);
    const { body: plan } = await call("GET", "/avalanche/weekly");
    expect(plan.weeks.find((w: { date: string }) => w.date === skipped.date)).toMatchObject({ answered: true, paid: 0 });
  });

  it("the Forecast register lists the same weekly occurrences and the cut minimums", async () => {
    await seed("weekly");
    const { status, body } = await call("GET", "/forecast?days=120");
    expect(status).toBe(200);
    const sig = await computeCashSignal(HH, OWNER, { horizonDays: 120 });
    const fromSignal = sig.events!.filter(isAvalanche).map((e) => [e.date, paidOf(e), e.label]);
    const fromRegister = (body.events as Array<{ itemId: string; date: string; amount: number; label: string }>)
      .filter((e) => isAvalanche(e) && e.date <= sig.toDate!)
      .map((e) => [e.date, paidOf(e), e.label]);
    expect(fromRegister).toEqual(fromSignal);
    const aInRegister = (body.events as Array<{ itemId: string; date: string }>).filter((e) => e.itemId === `debt:${debtId.a}` && e.date > "2026-11-01");
    const aOnCurve = sig.events!.filter((e) => e.itemId === `debt:${debtId.a}`);
    // The register lists each occurrence on its own day (the curve may have moved
    // one due today to the next business day).
    expect(aInRegister.map((e) => e.date)).toEqual(aOnCurve.map((e) => e.occurrenceDate ?? e.date));
  });

  it("settings: the owner switches the cadence and the day; a member is refused", async () => {
    await seed("monthly");
    const read = await call("GET", "/avalanche/settings");
    expect(read.body).toMatchObject({ extraCadence: "monthly", extraWeekday: 5 });
    const put = await call("PUT", "/avalanche/settings", { extraCadence: "weekly", extraWeekday: 4 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ extraCadence: "weekly", extraWeekday: 4, manualExtra: "2600.00" });
    expect((await call("PUT", "/avalanche/settings", { extraWeekday: 2.5 })).status).toBe(400);
    expect((await call("PUT", "/avalanche/settings", { extraCadence: "daily" })).status).toBe(400);
    ACTOR = MEMBER;
    const refused = await call("PUT", "/avalanche/settings", { extraCadence: "monthly" });
    expect(refused).toMatchObject({ status: 403, body: { error: "owner_only" } });
    ACTOR = OWNER;
    const sig = await computeCashSignal(HH, OWNER, { horizonDays: 30 });
    const pays = sig.events!.filter(isAvalanche);
    expect(pays.length).toBeGreaterThan(0);
    // Thursdays now.
    for (const p of pays) expect(new Date(`${p.date}T12:00:00Z`).getUTCDay()).toBe(4);
  });

  it("monthly cadence: the month-end extra, every minimum, and no weeks", async () => {
    await seed("monthly");
    const sig = await computeCashSignal(HH, OWNER, { horizonDays: 120 });
    const pays = sig.events!.filter(isAvalanche);
    expect(pays.map((p) => [p.date, paidOf(p), p.label])).toEqual([
      ["2026-11-30", 2600, AVALANCHE_EXTRA_LABEL],
      ["2026-12-31", 2600, AVALANCHE_EXTRA_LABEL],
      ["2027-01-31", 2600, AVALANCHE_EXTRA_LABEL],
      ["2027-02-28", 2600, AVALANCHE_EXTRA_LABEL],
    ]);
    const aMins = sig.events!.filter((e) => e.itemId === `debt:${debtId.a}`).map((e) => e.date);
    // Due today (the 10th) and not yet paid: it lands on the next business day, as for any bill.
    expect(aMins).toEqual(["2026-11-11", "2026-12-10", "2027-01-10", "2027-02-10", "2027-03-10"]);
    const { body: plan } = await call("GET", "/avalanche/weekly");
    expect(plan).toMatchObject({ cadence: "monthly", monthlyTarget: 2600, targetWeekly: 600, weeks: [], debtFreeDate: null });
  });
});
