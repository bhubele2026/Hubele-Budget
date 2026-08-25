// ⭐ THE PARITY GUARD — the contract that makes "all the tiles agree" a fact
// rather than a hope.
//
// `GET /api/spine` serves one snapshot of the household's core numbers so the
// app can open in a single round trip. The danger of a consolidated endpoint is
// obvious: the day it drifts from the pages it summarises, the app starts
// telling the owner two different stories about his own money, and the front
// door is the surface he trusts most. So every field the spine carries is
// asserted here against the number the OWNING page's endpoint returns, to the
// cent — same household, same request, same instant.
//
// If a future change makes two surfaces disagree, this file fails in CI. That
// is its entire job. When a spine field legitimately changes meaning, the fix
// is to change the shared function BOTH callers use — never to loosen an
// assertion here.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `spine-parity-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
/** The debt carrying the tagged-but-unposted payment (see the C10 seed). */
let VISA_DEBT_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  debtsTable,
  forecastSettingsTable,
  forecastResolutionsTable,
  recurringItemsTable,
  transactionsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { effectiveDebtBalance, payoffPct } from "@workspace/avalanche-core";
import { runwayDaysFrom } from "../lib/cashSignal";
import { pickNextBill, type BillsSummary } from "../lib/billsSummary";
import spineRouter from "../routes/spine";
import forecastRouter from "../routes/forecast";
import billsRouter from "../routes/bills";
import reportsRouter from "../routes/reports";
import debtsRouter from "../routes/debts";
// (C10) `/dashboard` owns the Reports "Total Debt" tile, so it joins the
// parity set — its debt figure must agree with `/debts` on the same basis.
import dashboardRouter from "../routes/dashboard";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(spineRouter);
app.use(forecastRouter);
app.use(billsRouter);
app.use(reportsRouter);
app.use(debtsRouter);
app.use(dashboardRouter);

let server: Server;
let baseUrl: string;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const NOW = new Date();
const TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
const TODAY_ISO = iso(TODAY);
const MONTH_START_ISO = iso(new Date(TODAY.getFullYear(), TODAY.getMonth(), 1));

/** A day inside the current month that is safely in the past (or today). */
function dayThisMonth(day: number): string {
  const last = new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0).getDate();
  return `${TODAY.getFullYear()}-${pad(TODAY.getMonth() + 1)}-${pad(Math.min(day, last))}`;
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();

  // ── A linked checking account + a bank snapshot to anchor the roll-forward.
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionSlug: "chase",
    })
    .returning();
  const externalId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalId,
      name: "Chase Checking",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "4200.00",
    // Anchor the snapshot at the start of the month so the ledger rows below
    // roll forward on top of it — this is the Chase-tab derivation, and it is
    // the one the spine must reproduce exactly.
    bankSnapshotAt: new Date(TODAY.getFullYear(), TODAY.getMonth(), 1),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: acct!.id,
  });

  // ── A real expense category, so the seeded spend counts as REAL spend
  // (uncategorized rows land in their own bucket and would make the spend
  // assertions vacuously 0 === 0).
  const [cat] = await db
    .insert(budgetCategoriesTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: `Groceries ${randomUUID().slice(0, 6)}`,
      kind: "expense",
      groupName: "Living",
    })
    .returning();

  // ── Ledger: outflows earlier in the month and one today (this week).
  await db.insert(transactionsTable).values([
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: dayThisMonth(2),
      description: "Market run",
      amount: "-120.55",
      categoryId: cat!.id,
      account: "checking",
      plaidAccountId: externalId,
      source: "plaid",
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: dayThisMonth(3),
      description: "Hardware store",
      amount: "-64.10",
      categoryId: cat!.id,
      account: "checking",
      plaidAccountId: externalId,
      source: "plaid",
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: TODAY_ISO,
      description: "Groceries today",
      amount: "-88.25",
      categoryId: cat!.id,
      account: "checking",
      plaidAccountId: externalId,
      source: "plaid",
    },
    // Forecast-flagged, unmatched, on the checking account => Review inbox.
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: dayThisMonth(4),
      description: "Electric bill posted",
      amount: "-210.00",
      categoryId: cat!.id,
      account: "checking",
      plaidAccountId: externalId,
      source: "plaid",
      forecastFlag: true,
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: dayThisMonth(5),
      description: "Water bill posted",
      amount: "-75.00",
      categoryId: cat!.id,
      account: "checking",
      plaidAccountId: externalId,
      source: "plaid",
      forecastFlag: true,
    },
  ]);

  // ── Recurring plan: two bills + one income row.
  await db.insert(recurringItemsTable).values([
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Rent",
      kind: "bill",
      amount: "1850.00",
      frequency: "monthly",
      dayOfMonth: 1,
      anchorDate: dayThisMonth(1),
      active: "true",
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Internet",
      kind: "bill",
      amount: "89.99",
      frequency: "monthly",
      dayOfMonth: 15,
      anchorDate: dayThisMonth(15),
      active: "true",
    },
    {
      // Anchored on the LAST day of the month so that on almost every calendar
      // day there is still a bill outstanding — otherwise `billsDueCount`
      // exercises only its zero path.
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Phone",
      kind: "bill",
      amount: "72.00",
      frequency: "monthly",
      dayOfMonth: new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0).getDate(),
      anchorDate: dayThisMonth(31),
      active: "true",
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Paycheck",
      kind: "income",
      amount: "3200.00",
      frequency: "monthly",
      dayOfMonth: 10,
      anchorDate: dayThisMonth(10),
      active: "true",
    },
  ]);

  // ── Debts: two anchored actives, one paid-off, one with NO anchor (which
  // must be excluded from both sides of the ratio rather than counted as 0%).
  const seededDebts = await db.insert(debtsTable).values([
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Visa",
      balance: "3000.00",
      originalBalance: "5000.00",
      apr: "0.2249",
      minPayment: "85.00",
      status: "active",
      dueDay: 18,
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Car loan",
      balance: "7250.40",
      originalBalance: "12000.00",
      apr: "0.0599",
      minPayment: "310.00",
      status: "active",
      dueDay: 22,
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Retired card",
      balance: "0.00",
      originalBalance: "900.00",
      apr: "0.1899",
      minPayment: "0.00",
      status: "paid_off",
    },
  ]).returning();
  VISA_DEBT_ID = seededDebts.find((d) => d.name === "Visa")!.id;

  // ── (C10) A tagged payment the creditor has NOT reported yet.
  //
  // ⭐ THIS ROW IS THE POINT OF THE DEBT PARITY TEST. Without it both sides of
  // the assertion below net zero, the test passes on raw balances, and it
  // cannot tell a netted server from an un-netted one — which is exactly how
  // the spine shipped a "% paid" that disagreed with the Debts page.
  //
  // Neither seeded debt sets `lastBalanceUpdate` or `plaidLastSyncedAt`, so
  // `pendingCutoffForDebt` returns null and every tagged payment counts as
  // pending. Shape copied from `debtsPendingPaymentDecrement.integration.test`:
  // debt-tagged, positive (payment-direction), `source: "manual"`, and
  // deliberately NOT on the checking account — this is the creditor side of
  // the payment, so it must not disturb the bank roll-forward or spend facts
  // the other parity assertions in this file depend on.
  await db.insert(transactionsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    occurredOn: dayThisMonth(6),
    description: "Payment — Visa",
    amount: "300.00",
    debtId: VISA_DEBT_ID,
    source: "manual",
  });

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

type Spine = {
  asOf: string;
  bank: { balance: string; asOfDate: string | null };
  spentMonth: number;
  spentWeek: number;
  nextBill: { name: string; amount: string; dueDate: string } | null;
  billsDueCount: number;
  forecast: {
    lowPoint: string;
    lowPointDate: string | null;
    runwayDays: number | null;
    cashBuffer: string;
    status: string;
  };
  debt: { payoffPct: number | null };
  reviewCount: number;
};

type CashSignal = {
  bankToday: string;
  lowestProjected: string;
  lowestDate: string | null;
  cashBuffer: string;
  status: string;
  snapshotAt: string | null;
  daily?: Array<{ date: string; balance: string }>;
};

describe("GET /spine — parity with the endpoints that own each number", () => {
  it("bank balance + as-of match /forecast/cash-signal (the roll-forward)", async () => {
    const spine = await get<Spine>("/spine");
    const signal = await get<CashSignal>("/forecast/cash-signal?horizonDays=90");

    expect(spine.bank.balance).toBe(signal.bankToday);
    expect(spine.bank.asOfDate).toBe(signal.snapshotAt);
    // Not vacuous: the snapshot rolled forward over real ledger rows.
    expect(Number(spine.bank.balance)).toBeGreaterThan(0);
    expect(Number(spine.bank.balance)).not.toBe(4200);
  });

  it("forecast low point + runway match /forecast/cash-signal", async () => {
    const spine = await get<Spine>("/spine");
    const signal = await get<CashSignal>("/forecast/cash-signal?horizonDays=90");

    expect(spine.forecast.lowPoint).toBe(signal.lowestProjected);
    expect(spine.forecast.lowPointDate).toBe(signal.lowestDate);
    // Runway is derived from the SAME daily series the Forecast page walks.
    expect(spine.forecast.runwayDays).toBe(runwayDaysFrom(signal.daily));
  });

  it("cash buffer + verdict match /forecast/cash-signal", async () => {
    const spine = await get<Spine>("/spine");
    const signal = await get<CashSignal>("/forecast/cash-signal?horizonDays=90");

    // Reports shows the verdict, the buffer and the low point in ONE tile.
    // They have to come from one reading of the household or the word can
    // contradict the number standing beside it.
    expect(spine.forecast.cashBuffer).toBe(signal.cashBuffer);
    expect(spine.forecast.status).toBe(signal.status);
    expect(["ready", "tight", "not_yet", "no_data"]).toContain(
      spine.forecast.status,
    );
    // Not vacuous: the verdict is the one the buffer and low point imply.
    const lowest = Number(spine.forecast.lowPoint);
    const buffer = Number(spine.forecast.cashBuffer);
    if (spine.forecast.status === "ready") {
      expect(lowest).toBeGreaterThanOrEqual(buffer);
    } else if (spine.forecast.status === "not_yet") {
      expect(lowest).toBeLessThan(buffer);
    }
  });

  it("spentMonth + spentWeek match /reports/spending-facts for the same windows", async () => {
    const spine = await get<Spine>("/spine");

    const month = await get<{ realSpend: { total: number } }>(
      `/reports/spending-facts?from=${MONTH_START_ISO}&to=${TODAY_ISO}`,
    );
    expect(spine.spentMonth).toBe(month.realSpend.total);

    // Week window = the server's own Sun–Sat helpers, which is what the spine
    // asks for; re-deriving them here would only test my arithmetic.
    const { weekStartFor, weekEndFor } = await import("../lib/cashSignal");
    const week = await get<{ realSpend: { total: number } }>(
      `/reports/spending-facts?from=${weekStartFor(TODAY)}&to=${weekEndFor(TODAY)}`,
    );
    expect(spine.spentWeek).toBe(week.realSpend.total);

    // Not vacuous, and internally coherent: a week cannot outspend its month.
    expect(spine.spentMonth).toBeGreaterThan(0);
    expect(spine.spentMonth).toBeGreaterThanOrEqual(spine.spentWeek);
  });

  it("nextBill + billsDueCount match /bills/summary", async () => {
    const spine = await get<Spine>("/spine");
    const summary = await get<BillsSummary>("/bills/summary");

    const expected = pickNextBill(summary, TODAY);
    expect(spine.nextBill).toEqual(expected.nextBill);
    expect(spine.billsDueCount).toBe(expected.billsDueCount);

    // ⭐ Independent check — not just "same function, same input". The bill the
    // spine names must genuinely be the earliest upcoming one in the summary,
    // and it must never be an income row.
    const upcoming = [
      ...summary.bills
        .filter((r) => r.item.active === "true")
        .map((r) => r.nextOccurrence),
      ...summary.debtMins.map((r) => r.nextOccurrence),
    ].filter((d): d is string => !!d && d >= TODAY_ISO);

    // The seeded plan always has a next occurrence, so this test can never go
    // vacuous without someone noticing.
    expect(upcoming.length).toBeGreaterThan(0);

    const earliest = upcoming.slice().sort()[0];
    expect(spine.nextBill).not.toBeNull();
    expect(spine.nextBill!.dueDate).toBe(earliest);

    // A paycheck is not a bill.
    const incomeNames = new Set(summary.income.map((r) => r.item.name));
    expect(incomeNames.has(spine.nextBill!.name)).toBe(false);

    // ⚠️ Recomputed from the summary independently, NOT asserted as "> 0".
    // `billsDueCount` is what is LEFT THIS MONTH, so on a month whose bills
    // have all already fallen it is legitimately zero — an eyeballed "> 0"
    // vacuity check fails on the 23rd for a plan billed on the 1st and 15th
    // and teaches you to loosen the real assertion. This compares the count to
    // the exact set it claims to describe, on every calendar day.
    const dueThisMonth = upcoming.filter((d) => d <= summary.monthly.monthEnd);
    expect(spine.billsDueCount).toBe(dueThisMonth.length);
  });

  it("debt.payoffPct matches the derivation over /debts' own rows", async () => {
    const spine = await get<Spine>("/spine");
    // ⚠️ `pendingPaymentTotal` IS PART OF THIS SHAPE. It used to be annotated
    // away here, which quietly defeated the whole assertion: `payoffPct` nets
    // whatever pending it is handed, so stripping the field made the expected
    // side fall back to raw balances and agree with a raw spine. The type must
    // carry every field the basis depends on or the parity is theatre.
    const debts = await get<
      Array<{
        id: string;
        balance: string;
        originalBalance?: string | null;
        status?: string;
        pendingPaymentTotal?: string | null;
      }>
    >("/debts");

    expect(spine.debt.payoffPct).toBe(payoffPct(debts));

    // Not vacuous: 17,000 anchored; 10,250.40 posted less a 300.00 tagged-
    // unposted payment => 9,950.40 effectively owed => ~41.47% paid.
    expect(spine.debt.payoffPct).not.toBeNull();
    expect(spine.debt.payoffPct!).toBeGreaterThan(0);
    expect(spine.debt.payoffPct!).toBeLessThan(100);
    expect(spine.debt.payoffPct!).toBeCloseTo(41.4682, 3);
  });

  it("⭐ debt.payoffPct NETS tagged-unposted payments — the C10 basis", async () => {
    // Brad's 2026-08-23 call: net pending payments on every surface. The spine
    // feeds the landing's "% paid" and the Avalanche hero, and it reads debt
    // rows with a plain SELECT that cannot see tagged payments — so unless it
    // enriches them first it quotes a LOWER percentage than the Debts and
    // Avalanche pages standing next to it. This test fails if that enrichment
    // is removed.
    const spine = await get<Spine>("/spine");
    const debts = await get<
      Array<{
        id: string;
        balance: string;
        originalBalance?: string | null;
        status?: string;
        pendingPaymentTotal?: string | null;
      }>
    >("/debts");

    // The fixture's pending payment is actually visible on the owning endpoint.
    const visa = debts.find((d) => d.id === VISA_DEBT_ID);
    expect(visa).toBeDefined();
    expect(Number(visa!.pendingPaymentTotal)).toBeCloseTo(300, 2);

    // ⭐ THE DISCRIMINATING ASSERTION. Re-derive on the OLD raw basis by
    // blanking the pending field, and require the spine to disagree with it.
    // A spine that forgot to net would land exactly on `rawBasis` and fail.
    const rawBasis = payoffPct(
      debts.map((d) => ({ ...d, pendingPaymentTotal: null })),
    );
    expect(rawBasis).toBeCloseTo(39.7035, 3);
    expect(spine.debt.payoffPct!).toBeGreaterThan(rawBasis!);
    expect(spine.debt.payoffPct!).toBeCloseTo(41.4682, 3);
  });

  it("dashboard.totalDebt is netted too, and ties to /debts to the cent", async () => {
    // `/api/dashboard` feeds the Reports "Total Debt" tile. It summed
    // `debts.balance` in SQL, which cannot see pending — so that tile quoted a
    // household MORE than it owed while /avalanche quoted less, on numbers a
    // reader can hold side by side.
    const dashboard = await get<{ totalDebt: string; activeDebtCount: number }>(
      "/dashboard",
    );
    const debts = await get<
      Array<{
        balance: string;
        status?: string;
        pendingPaymentTotal?: string | null;
      }>
    >("/debts");

    const expected = debts
      .filter((d) => d.status === "active")
      .reduce((s, d) => s + effectiveDebtBalance(d), 0);
    expect(Number(dashboard.totalDebt)).toBeCloseTo(expected, 2);

    // Not vacuous, and specifically netted: 3000 + 7250.40 posted, less the
    // 300.00 pending payment.
    expect(Number(dashboard.totalDebt)).toBeCloseTo(9950.4, 2);
    expect(dashboard.activeDebtCount).toBe(2);
  });

  it("reviewCount matches /forecast/review-count", async () => {
    const spine = await get<Spine>("/spine");
    const badge = await get<{ count: number }>("/forecast/review-count");

    expect(spine.reviewCount).toBe(badge.count);
    expect(spine.reviewCount).toBe(2); // the two forecast-flagged bank rows
  });

  it("⚠️ never carries a debt balance or amount owed — landing law", async () => {
    // The landing paints this payload. The standing rule is that the front door
    // shows progress, never what is owed. This asserts the SHAPE, so the rule
    // survives someone helpfully adding "totalDebt" to the debt object later.
    const spine = await get<Spine>("/spine");

    expect(Object.keys(spine.debt)).toEqual(["payoffPct"]);

    // `bank.balance` is the household's own cash and is allowed; nothing else
    // in the payload may look like a debt figure.
    const serialized = JSON.stringify({ ...spine, bank: undefined });
    for (const banned of [
      "totalDebt",
      "amountOwed",
      "owed",
      "originalBalance",
      "debtBalance",
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it("is one snapshot: asOf is present and every field is populated together", async () => {
    const spine = await get<Spine>("/spine");
    expect(new Date(spine.asOf).toString()).not.toBe("Invalid Date");
    expect(spine).toMatchObject({
      bank: { balance: expect.any(String) },
      spentMonth: expect.any(Number),
      spentWeek: expect.any(Number),
      billsDueCount: expect.any(Number),
      forecast: {
        lowPoint: expect.any(String),
        cashBuffer: expect.any(String),
        status: expect.any(String),
      },
      reviewCount: expect.any(Number),
    });
  });
});
