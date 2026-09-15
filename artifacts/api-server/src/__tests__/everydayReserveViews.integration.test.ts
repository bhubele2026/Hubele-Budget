// ⭐ PR8r — the three views, the route and the spine law, and a database-level
// "never reads high" sweep over generated households.
//
//   - With no hook linked, turning the views on changes no other field of the cash
//     signal, and `expected` is `balance` on every day.
//   - Scheduled puts plans on their own due dates (an overdue bill listed, a bill due
//     today on today, income due today counted today); Conservative moves every
//     planned income one business day later. The payoffs are the same in all three.
//   - /forecast/cash-signal carries the views and the `everyday` block; /spine
//     carries no owed, payoff or reserve figure, and its low point is the route's.
//   - Linking the hooks never raises the rest of the curve: on every day, the
//     balance plus the hook items' own outflows is never higher linked than unlinked.
//
// Synthetic household, synthetic merchants.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const TEST_USER = `pr8r-views-${RUN}`;
let HH: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = HH;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, everydayPeriodOf } from "@workspace/avalanche-core";
import spineRouter from "../routes/spine";
import forecastRouter from "../routes/forecast";
import { computeCashSignal } from "../lib/cashSignal";
import { computeWeeklyPayoff } from "../lib/amexAnchor";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const routes = express.Router();
routes.use(spineRouter);
routes.use(forecastRouter);
const { request } = createTestApp(routes);

const CHASE = `pr8r-v-chase-${RUN}`;
const PLATINUM = `pr8r-v-plat-${RUN}`;
const BLUE = `pr8r-v-blue-${RUN}`;
const at = (isoLocal: string): Date => new Date(`${isoLocal}-05:00`);

let WEEKLY_ID: string;
let MONTHLY_ID: string;
let GROCERIES: string;

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  HH = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(async () => {
  vi.useRealTimers();
  await cleanup();
});

async function household(opts: {
  today: string;
  weeklyAnchor?: string;
  monthlyAnchor?: string;
  weeklyBill?: string;
  weeklyAllowance?: string;
}): Promise<void> {
  vi.setSystemTime(at(`${opts.today}T12:00:00`));
  await cleanup();
  const [chaseItem] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: HH, itemId: `item-chase-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  const [amexItem] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: HH, itemId: `item-amex-${randomUUID()}`, accessToken: "test-token", institutionName: "American Express", institutionSlug: "amex" })
    .returning();
  const accounts = await db
    .insert(plaidAccountsTable)
    .values([
      { userId: TEST_USER, householdId: HH, itemId: chaseItem!.id, accountId: CHASE, name: "Checking", mask: "5501", type: "depository", subtype: "checking" },
      { userId: TEST_USER, householdId: HH, itemId: amexItem!.id, accountId: PLATINUM, name: "Platinum Card", mask: "5502", type: "credit", subtype: "credit card" },
      { userId: TEST_USER, householdId: HH, itemId: amexItem!.id, accountId: BLUE, name: "Blue Cash Everyday", mask: "5503", type: "credit", subtype: "credit card" },
    ])
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: HH,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2000.00",
    bankSnapshotAt: at(`${addDaysISO(opts.today, -1)}T20:00:00`),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: accounts.find((a) => a.accountId === CHASE)!.id,
    bankSnapshotMask: "5501",
  });
  const [groceries] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: HH, name: "Groceries", kind: "expense" })
    .returning();
  GROCERIES = groceries!.id;
  const bills = await db
    .insert(recurringItemsTable)
    .values([
      { userId: TEST_USER, householdId: HH, name: "Weekly Spend", kind: "bill", amount: opts.weeklyBill ?? "450", frequency: "weekly", anchorDate: opts.weeklyAnchor ?? "2026-09-12", active: "true" },
      { userId: TEST_USER, householdId: HH, name: "Monthly Spend", kind: "bill", amount: "400", frequency: "monthly", dayOfMonth: 1, anchorDate: opts.monthlyAnchor ?? "2026-10-01", active: "true" },
    ])
    .returning();
  WEEKLY_ID = bills[0]!.id;
  MONTHLY_ID = bills[1]!.id;
  await db.insert(settingsTable).values({
    userId: TEST_USER,
    householdId: HH,
    weeklyAllowanceAmount: opts.weeklyAllowance ?? "450.00",
    monthlyAllowanceAmount: "400.00",
    preferences: { everydayHooks: { weeklyItemId: null, monthlyItemId: null } },
  });
}

async function link(weekly: boolean, monthly: boolean): Promise<void> {
  await db
    .update(settingsTable)
    .set({ preferences: { everydayHooks: { weeklyItemId: weekly ? WEEKLY_ID : null, monthlyItemId: monthly ? MONTHLY_ID : null } } })
    .where(eq(settingsTable.userId, TEST_USER));
}

type RowOpts = Partial<typeof transactionsTable.$inferInsert>;
async function row(values: RowOpts & { occurredOn: string; amount: string; description: string }): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({ userId: TEST_USER, householdId: HH, createdAt: createdAtStartOfHouseholdDay(values.occurredOn), ...values })
    .returning({ id: transactionsTable.id });
  return t!.id;
}
const amexCharge = (card: string, occurredOn: string, amount: string, extra: RowOpts = {}) =>
  row({ occurredOn, amount, description: "GREEN GROCER 118", plaidAccountId: card, source: "plaid:amex", categoryId: GROCERIES, ...extra });
const chaseRow = (occurredOn: string, amount: string, description: string, extra: RowOpts = {}) =>
  row({ occurredOn, amount, description, plaidAccountId: CHASE, source: "plaid:chase", ...extra });

async function bill(name: string, kind: string, amount: string, dayOfMonth: number, anchorDate: string): Promise<string> {
  const [b] = await db
    .insert(recurringItemsTable)
    .values({ userId: TEST_USER, householdId: HH, name, kind, amount, frequency: "monthly", dayOfMonth, anchorDate, active: "true" })
    .returning({ id: recurringItemsTable.id });
  return b!.id;
}

type Day = { date: string; balance: string; scheduled?: string; expected?: string; conservative?: string };
type Sig = Awaited<ReturnType<typeof computeCashSignal>> & { daily?: Day[]; everyday?: unknown; incomeExpectedToday?: Array<Record<string, unknown>> };
const signal = async (horizonDays: number, views = true): Promise<Sig> =>
  (await computeCashSignal(HH, TEST_USER, { horizonDays, views } as never)) as Sig;
const on = (sig: Sig, date: string, view: keyof Day) => sig.daily!.find((d) => d.date === date)![view];

/** Fri 9/11: a bill overdue since 9/9, one due today, one on 9/15; a paycheck due today, a side payment on Fri 9/18. */
async function viewsHousehold(): Promise<{ paycheck: string }> {
  await household({ today: "2026-09-11" });
  await bill("Phone", "bill", "95", 9, "2026-08-09");
  await bill("Gym", "bill", "30", 11, "2026-08-11");
  await bill("Rent", "bill", "1200", 15, "2026-08-15");
  const paycheck = await bill("Paycheck", "income", "1000", 11, "2026-08-11");
  await bill("Side payment", "income", "500", 18, "2026-08-18");
  await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
  await chaseRow("2026-09-11", "-40.00", "CORNER MARKET 22", { weeklyAllowance: true, categoryId: GROCERIES });
  return { paycheck };
}

describe("PR8r views — no hook linked", () => {
  it("the views change no other field; expected is balance on every day", async () => {
    await viewsHousehold();
    const plain = await signal(14, false);
    const views = await signal(14, true);
    const { daily, everyday, incomeExpectedToday, ...rest } = views;
    const { daily: plainDaily, ...plainRest } = plain;
    expect(rest).toEqual(plainRest);
    expect(daily!.map((d) => ({ date: d.date, balance: d.balance }))).toEqual(plainDaily);
    expect(daily!.every((d) => d.expected === d.balance)).toBe(true);
    expect(everyday).toBeDefined();
    expect(incomeExpectedToday).toBeDefined();
    expect("everyday" in plain).toBe(false);
    expect("incomeExpectedToday" in plain).toBe(false);
    expect(Object.keys(plainDaily![0]!)).toEqual(["date", "balance"]);
  });

  it("Expected drags the overdue bill and the bill due today to Monday; income due today is listed, not counted", async () => {
    const { paycheck } = await viewsHousehold();
    const sig = await signal(14);
    expect(sig.bankToday).toBe("1960.00");
    expect(["2026-09-11", "2026-09-12", "2026-09-14", "2026-09-15", "2026-09-18", "2026-09-19"].map((d) => on(sig, d, "expected"))).toEqual([
      "1960.00", "1510.00", "1385.00", "185.00", "685.00", "235.00",
    ]);
    expect(sig.incomeExpectedToday).toEqual([expect.objectContaining({ itemId: paycheck, dueDate: "2026-09-11", amount: "1000.00", daysOverdue: 0 })]);
  });

  it("Scheduled: plans on their own dates — the overdue bill listed, the gym today, the paycheck today", async () => {
    await viewsHousehold();
    const sig = await signal(14);
    expect(["2026-09-11", "2026-09-12", "2026-09-14", "2026-09-15", "2026-09-18", "2026-09-19"].map((d) => on(sig, d, "scheduled"))).toEqual([
      "2930.00", "2480.00", "2480.00", "1280.00", "1780.00", "1330.00",
    ]);
    // The overdue bill is still listed (its event, with its assumption), never dropped.
    expect(sig.events!.some((e) => e.label === "Phone" && e.assumption === "overdue_assumed_unpaid")).toBe(true);
  });

  it("Conservative: every planned income one business day later — Friday 9/18 lands Monday 9/21", async () => {
    await viewsHousehold();
    const sig = await signal(14);
    expect(["2026-09-11", "2026-09-15", "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21"].map((d) => on(sig, d, "conservative"))).toEqual([
      "1960.00", "185.00", "185.00", "-265.00", "-265.00", "235.00",
    ]);
  });
});

describe("PR8r views — the weekly hook linked", () => {
  it("the payoff is the same in all three views: each view moves by exactly the same amount", async () => {
    await viewsHousehold();
    const unlinked = await signal(14);
    await link(true, false);
    const linked = await signal(14);
    expect(linked.everyday).toMatchObject({ weekly: { payoff: "410.00" } });
    for (const view of ["scheduled", "expected", "conservative"] as const) {
      for (const date of ["2026-09-12", "2026-09-14", "2026-09-19", "2026-09-21"]) {
        // The $450 bill became a $410 payoff this week and a $450 payoff next week.
        const delta = Number(on(linked, date, view)) - Number(on(unlinked, date, view));
        expect(delta, `${view} ${date}`).toBe(40);
      }
    }
    expect(on(linked, "2026-09-12", "expected")).toBe("1550.00");
  });
});

describe("PR8r views — a payoff due today", () => {
  it("a Saturday: the payoff moved to Monday stays on Monday in Scheduled and Conservative too", async () => {
    await household({ today: "2026-09-12" });
    await link(true, false);
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const sig = await signal(9);
    expect(sig.events!.filter((e) => e.itemId === WEEKLY_ID).map((e) => [e.date, e.amount, e.assumption])).toEqual([
      ["2026-09-14", "-450.00", "due_today_not_posted"],
      ["2026-09-19", "-450.00", null],
    ]);
    // Nothing else is planned, so all three views are the one curve.
    for (const d of sig.daily!) {
      expect(d.scheduled, `scheduled ${d.date}`).toBe(d.balance);
      expect(d.conservative, `conservative ${d.date}`).toBe(d.balance);
    }
    expect(on(sig, "2026-09-12", "scheduled")).toBe("2000.00");
    expect(on(sig, "2026-09-14", "scheduled")).toBe("1550.00");
  });
});

describe("PR8r — the route carries the views; the spine carries no everyday figure", () => {
  it("/forecast/cash-signal has the views and the everyday block; /spine has no owed, payoff or reserve, and the same low point", async () => {
    await viewsHousehold();
    await link(true, true);
    const route = await request("GET", "/forecast/cash-signal?horizonDays=90");
    expect(route.status).toBe(200);
    const sig = route.json as Sig & { everyday: { weekly: { status: string } } };
    expect(Object.keys(sig.daily![0]!)).toEqual(["date", "balance", "scheduled", "expected", "conservative"]);
    expect(sig.everyday.weekly.status).toBe("linked");

    const spine = await request("GET", "/spine");
    expect(spine.status).toBe(200);
    // Every key the spine carries, at any depth. (`debt.payoffPct` is the debt
    // payoff PERCENTAGE the landing law allows; the everyday `payoff` is not.)
    const keys = new Set<string>();
    const collect = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          collect(x);
        }
      }
    };
    collect(spine.json);
    for (const banned of ["everyday", "payoff", "owed", "reserve", "remaining", "plan", "spent", "billMatched", "discrepancy", "scheduled", "expected", "conservative", "incomeExpectedToday"]) {
      expect(keys.has(banned), banned).toBe(false);
    }
    expect(JSON.stringify(spine.json)).not.toContain("owed");
    expect((spine.json as { forecast: { lowPoint: string } }).forecast.lowPoint).toBe(sig.lowestProjected);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("PR8r — linking the hooks never raises the rest of the curve (generated households, through the real ledger)", () => {
  const HOUSEHOLDS = 12;

  it(`${HOUSEHOLDS} households, every day of 30: balance + the hook items' own outflows is never higher linked than unlinked`, async () => {
    let changed = 0;
    let withLegacyBill = 0;
    let settledByPayment = 0;
    for (let k = 0; k < HOUSEHOLDS; k += 1) {
      const rnd = mulberry32(4242 + k);
      const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
      const today = addDaysISO("2026-09-06", Math.floor(rnd() * 14));
      await household({
        today,
        weeklyAnchor: "2026-08-29",
        monthlyAnchor: "2026-08-01",
        weeklyBill: String(300 + Math.floor(rnd() * 300)),
        weeklyAllowance: `${250 + Math.floor(rnd() * 300)}.00`,
      });
      for (let i = Math.floor(rnd() * 8); i > 0; i -= 1) {
        const flag = pick<RowOpts>([{ weeklyAllowance: true }, { monthlyAllowance: true }, { unplannedAllowance: true }, {}]);
        const amount = (5 + Math.floor(rnd() * 15_000) / 100).toFixed(2);
        await amexCharge(rnd() < 0.7 ? PLATINUM : BLUE, addDaysISO(today, -Math.floor(rnd() * 20)), `-${amount}`, {
          ...flag,
          ...(rnd() < 0.2 ? { categoryId: null } : {}),
        });
      }
      for (let i = Math.floor(rnd() * 3); i > 0; i -= 1) {
        const amount = (5 + Math.floor(rnd() * 8_000) / 100).toFixed(2);
        await chaseRow(addDaysISO(today, -Math.floor(rnd() * 5)), `-${amount}`, "CORNER MARKET 22", { weeklyAllowance: true, categoryId: GROCERIES });
      }
      if (rnd() < 0.7) {
        // An Amex payment: last week's owed charges exactly when there are any.
        const lastWeek = everydayPeriodOf("weekly", addDaysISO(today, -7));
        const owed = (await computeWeeklyPayoff(HH, lastWeek.start, TEST_USER)).combinedWeekCharges;
        const amount = (owed > 0 && rnd() < 0.8 ? owed : 50 + Math.floor(rnd() * 400)).toFixed(2);
        const paidOn = addDaysISO(today, -Math.floor(rnd() * 3));
        await chaseRow(paidOn, `-${amount}`, `AMERICAN EXPRESS ACH PMT K${k}`);
        if (rnd() < 0.5) {
          // A legacy bill the payment pays by name when the hooks do not claim it.
          await bill("American Express", "bill", amount, Number(paidOn.slice(8, 10)), "2026-06-01");
          withLegacyBill += 1;
        }
      }

      const unlinked = await signal(30);
      await link(true, true);
      const linked = await signal(30);
      const hookIds = new Set([WEEKLY_ID, MONTHLY_ID]);
      const hookOut = (sig: Sig, day: string) =>
        (sig.events ?? []).filter((e) => hookIds.has(e.itemId) && e.date <= day).reduce((s, e) => s - Number(e.amount), 0);
      const payoffDiffers =
        JSON.stringify((linked.events ?? []).filter((e) => hookIds.has(e.itemId))) !==
        JSON.stringify((unlinked.events ?? []).filter((e) => hookIds.has(e.itemId)));
      if (payoffDiffers) changed += 1;
      if ((linked.everyday as { weekly: { payment: unknown } } | undefined)?.weekly.payment) settledByPayment += 1;
      for (let i = 0; i < linked.daily!.length; i += 1) {
        const day = linked.daily![i]!.date;
        const withHooks = Number(linked.daily![i]!.balance) + hookOut(linked, day);
        const without = Number(unlinked.daily![i]!.balance) + hookOut(unlinked, day);
        expect(withHooks, `household ${k} (today ${today}) ${day}`).toBeLessThanOrEqual(without + 0.005);
      }
      expect(linked.bankToday, `household ${k}: cash today never moves`).toBe(unlinked.bankToday);
    }
    // Not vacuous: the payoffs really replaced the bills, and the claimed-payment path ran.
    expect(changed).toBeGreaterThanOrEqual(HOUSEHOLDS - 2);
    expect(withLegacyBill).toBeGreaterThan(0);
    expect(settledByPayment + withLegacyBill).toBeGreaterThan(0);
  });
});
