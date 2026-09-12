// ⭐ PR6 REVIEW — PAID OVERDUE BILLS STAY OFF THE CURVE; UNPAID ONES STILL DRAG.
//
// The independent review of `03815aa` (REQUEST CHANGES) measured the first PR6
// rule — "only an `offCurve` pair counts as paid" — bringing paid-but-unmatched
// bills back as dips. R1–R7 below are its cases, at today = snapshot = Tue
// 2026-05-05, buffer 500, a 90-day horizon, with April and May rows. A monthly
// paycheck covers each month's bills so the max safe extra reads cleanly.
//
// | Case | 9923add (#666) | 03815aa (first PR6) | PR6 review rule | decision 13 |
// | R1 rent by Zelle, no name            | 2,500 | 1,000    | 2,500 | 1,000    |
// | R2 rent by check                     | 2,500 | 1,000    | 2,500 | 1,000    |
// | R3 mortgage "LOAN PMT" + HELOC       | 5,500 | 2,284.21 | 5,500 | 2,284.21 |
// | R4 card minimums, larger payments    | 2,500 | 2,422    | 2,500 | 2,500    |
// | R5 Avalanche extra, no name          | 2,500 | 2,000    | 2,500 | 2,000    |
// | R6 rent actually unpaid              | 2,500 | 1,000    | 1,000 | 1,000    |
// | R7 whole household, all paid (low)   | 6,500 | 3,368.43 | 6,500 | 2,908.43 |
//
// ⭐ (Owner decision 13) "Merchant similarity alone is insufficient proof of
// payment": the PR6 review rule paid an overdue bill on ANY non-ambiguous pair.
// Now only a tier-1/2 pair pays it (see `matchPlansToRows`), so the nameless and
// part-name cases drag again. The card minimums (R4) are paid by PR7's card-payment
// rule, unchanged. With the bills' own categories on the rows, the cases return to
// the review rule's figures (last describe in this file).
//
// Also: the unpaid remainder of an underpaid bill (HIGH 1), old moved-to-date
// resolutions (HIGH 2), the Avalanche extra's start (MEDIUM 1) and the lists'
// bounds (MEDIUM 2). Only Date is mocked; the HTTP server's timers stay real.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `overdue-evidence-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
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
  avalancheSettingsTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { computeCashSignal, type CashSignal } from "../lib/cashSignal";
import forecastRouter from "../routes/forecast";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(forecastRouter);

let server: Server;
let baseUrl: string;

const TUE_MAY_5 = new Date("2026-05-05T17:00:00Z"); // 12:00 in Chicago
const LONG_AGO = new Date("2026-01-05T18:00:00Z");
const CHASE = "chase-overdue-evidence";

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
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

beforeEach(async () => {
  vi.setSystemTime(TUE_MAY_5);
  await cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Balance read at 10:00 CT on the pinned day (or `at`), on Chase. */
async function snapshot(opts: { balance: string; buffer?: string; at?: Date }): Promise<void> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: item!.id, accountId: CHASE, name: "Chase Checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: opts.buffer ?? "500",
    bankSnapshotBalance: opts.balance,
    bankSnapshotAt: opts.at ?? new Date("2026-05-05T15:00:00Z"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
  });
}

async function bill(over: Partial<typeof recurringItemsTable.$inferInsert>): Promise<string> {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Bill",
      kind: "expense",
      amount: "100",
      frequency: "monthly",
      dayOfMonth: 1,
      anchorDate: "2026-01-01",
      active: "true",
      ...over,
    })
    .returning();
  return r!.id;
}

/** A monthly paycheck on the 28th (anchored in January) that covers the month's bills. */
const paycheck = (amount: string, name = "Paycheck") =>
  bill({ name, kind: "income", amount, dayOfMonth: 28, anchorDate: "2026-01-28" });

async function debt(name: string, minPayment: string, dueDay: number, balance = "5000"): Promise<string> {
  const [d] = await db
    .insert(debtsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name, type: "credit_card", balance, minPayment, dueDay, status: "active", createdAt: LONG_AGO })
    .returning();
  return d!.id;
}

async function avalanche(manualExtra: string, updatedAt: Date): Promise<void> {
  await db.insert(avalancheSettingsTable).values({ userId: TEST_USER, manualExtra, updatedAt });
}

async function row(occurredOn: string, amount: string, description: string, debtId: string | null = null): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description,
      amount,
      debtId,
      plaidAccountId: CHASE,
      source: "plaid:chase",
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

/** A payment logged in the app: what `POST /debts/:id/payments` writes (manual, no Plaid account, tagged to the debt). */
async function manualRow(occurredOn: string, amount: string, description: string, debtId: string | null): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description,
      amount,
      debtId,
      source: "manual",
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

async function resolve(status: string, itemId: string, occurrenceDate: string, extra: { txnId?: string; rescheduledTo?: string } = {}) {
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    recurringItemId: itemId,
    occurrenceDate,
    status,
    matchedTxnId: extra.txnId ?? null,
    rescheduledTo: extra.rescheduledTo ?? null,
  });
}

const signal = (horizonDays = 90) => computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays });
const balanceOn = (sig: CashSignal, date: string) => sig.daily?.find((d) => d.date === date)?.balance;
const dragged = (sig: CashSignal) =>
  (sig.events ?? []).filter((e) => e.assumption !== null).map((e) => [e.label, e.date, e.amount, e.assumption]);
const paidList = (sig: CashSignal) =>
  (sig.overdueAssumedPaid ?? []).map((p) => [p.label, p.dueDate, p.confidence, p.unpaidRemainder]);

describe("PR6 review, HIGH 1 — the reviewer's R1–R7", () => {
  // ⭐ (Decision 13) R1, R2, R3, R5 and R7 below were "paid for the curve" on a
  // nameless or part-name pair. The owner ruled that is not proof of payment, so
  // those bills drag again until a tier-1/2 signal exists (the bill's own category,
  // its unique full name, a prompt exact named payment, a debt tag) or the user
  // confirms. The last describe in this file shows the category path paying them.
  it("R1 rent paid by Zelle with no name: (decision 13) tier 3, the rent drags — max safe extra 1,000 (was 2,500)", async () => {
    await snapshot({ balance: "3000" });
    const rent = await bill({ name: "Rent", amount: "1500", dayOfMonth: 1 });
    await paycheck("1500");
    await row("2026-04-01", "-1500.00", "ZELLE TO JORDAN LEE");
    const may = await row("2026-05-01", "-1500.00", "ZELLE TO JORDAN LEE");
    await row("2026-04-28", "1500.00", "ACME PAYROLL");
    const sig = await signal();
    expect(sig.bankToday).toBe("3000.00");
    expect(sig.lowestProjected).toBe("1500.00");
    expect(sig.maxSafeExtra).toBe("1000.00");
    expect(dragged(sig)).toEqual([["Rent", "2026-05-06", "-1500.00", "overdue_assumed_unpaid"]]);
    expect(paidList(sig)).toEqual([]);
    expect((sig.overdueOutsideForecast ?? []).map((p) => [p.label, p.dueDate])).toEqual([["Rent", "2026-04-01"]]);
    expect(sig.matches?.find((m) => m.planKey === `${rent}|2026-05-01`)).toMatchObject({ txnId: may, confidence: "low", tier: 3, offCurve: false });
    expect(sig.incomeNotArrived).toEqual([]); // the April paycheck arrived with no name (income keeps PR6's rule)
  });

  it("R2 rent paid by check, two days late: (decision 13) tier 3, drags — 1,000 (was 2,500)", async () => {
    await snapshot({ balance: "3000" });
    await bill({ name: "Rent", amount: "1500", dayOfMonth: 1 });
    await paycheck("1500");
    await row("2026-04-02", "-1500.00", "CHECK 1031");
    await row("2026-05-03", "-1500.00", "CHECK 1043");
    await row("2026-04-28", "1500.00", "ACME PAYROLL");
    const sig = await signal();
    expect(sig.maxSafeExtra).toBe("1000.00");
    expect(dragged(sig)).toEqual([["Rent", "2026-05-06", "-1500.00", "overdue_assumed_unpaid"]]);
    expect(paidList(sig)).toEqual([]);
  });

  it("R3 mortgage 'LOAN PMT' (no name) and a HELOC paid more by 'FIGURE LENDING' (part of the name, no category): (decision 13) both drag — 2,284.21 (was 5,500)", async () => {
    await snapshot({ balance: "6000" });
    await bill({ name: "Mortgage", amount: "2085.79", dayOfMonth: 1 });
    await bill({ name: "Figure HELOC", amount: "1130", dayOfMonth: 1 });
    await paycheck("3215.79");
    for (const m of ["04", "05"]) {
      await row(`2026-${m}-01`, "-2085.79", `LOAN PMT 0${m}12`);
      await row(`2026-${m}-01`, "-1185.19", "FIGURE LENDING");
    }
    await row("2026-04-28", "3215.79", "ACME PAYROLL");
    const sig = await signal();
    // 6,000.00 − 2,085.79 − 1,130.00 on Wed 05-06.
    expect(sig.lowestProjected).toBe("2784.21");
    expect(sig.maxSafeExtra).toBe("2284.21");
    expect(dragged(sig).sort()).toEqual([
      ["Figure HELOC", "2026-05-06", "-1130.00", "overdue_assumed_unpaid"],
      ["Mortgage", "2026-05-06", "-2085.79", "overdue_assumed_unpaid"],
    ]);
    expect(paidList(sig)).toEqual([]);
    expect(sig.matches?.filter((m) => m.planDate === "2026-05-01").map((m) => [m.confidence, m.tier]).sort()).toEqual([
      ["low", 3],
      ["medium", 3],
    ]);
  });

  it("R4 card minimums $40 and $38 paid by $812.40 and $400 card payments (no pair at all): 2,500", async () => {
    await snapshot({ balance: "3000" });
    const capOne = await debt("Capital One Platinum", "40", 1);
    await debt("Discover It", "38", 3);
    await paycheck("78");
    await row("2026-04-01", "-650.00", "CAPITAL ONE MOBILE PYMT");
    await row("2026-04-03", "-300.00", "DISCOVER E-PAYMENT");
    const may = await row("2026-05-01", "-812.40", "CAPITAL ONE MOBILE PYMT");
    await row("2026-05-02", "-400.00", "DISCOVER E-PAYMENT");
    await row("2026-04-28", "78.00", "ACME PAYROLL");
    const sig = await signal();
    expect(sig.maxSafeExtra).toBe("2500.00");
    expect(dragged(sig)).toEqual([]);
    expect(sig.matches?.filter((m) => m.planItemId.startsWith("debt:"))).toEqual([]);
    expect(paidList(sig)).toEqual([
      ["Capital One Platinum minimum", "2026-04-01", "card_payment", "0.00"],
      ["Discover It minimum", "2026-04-03", "card_payment", "0.00"],
      ["Capital One Platinum minimum", "2026-05-01", "card_payment", "0.00"],
      ["Discover It minimum", "2026-05-03", "card_payment", "0.00"],
    ]);
    expect(sig.overdueAssumedPaid?.find((p) => p.dueDate === "2026-05-01")).toMatchObject({
      planKey: `debt:${capOne}|2026-05-01`,
      txnId: may,
      txnAmount: "-812.40",
      planAmount: "-40.00",
    });
  });

  // ⭐ PR6 second review, probe E6: a card's minimum is paid only by a real card
  // payment. Before the fix each of the first three rows took its minimum off the
  // curve (max safe extra 2,460 instead of 2,362).
  it("E6 a Target purchase, an Apple Store receipt, a Capital One car loan and a Discover refund pay no minimum: all four drag", async () => {
    await snapshot({ balance: "3000" });
    await debt("Target RedCard", "35", 1);
    await debt("Apple Card", "25", 2);
    await debt("Capital One Platinum", "38", 3);
    await debt("Discover It", "40", 4);
    await paycheck("138");
    await row("2026-05-01", "-84.12", "TARGET T-2331");
    await row("2026-05-02", "-1299.00", "APPLE STORE");
    await row("2026-05-03", "-452.00", "CAPITAL ONE AUTO CARPAY");
    await row("2026-05-04", "40.00", "DISCOVER CASHBACK");
    await row("2026-04-28", "138.00", "ACME PAYROLL");
    const sig = await signal();
    // 3,000.00 − 35 − 25 − 38 − 40 on Wed 05-06.
    expect(balanceOn(sig, "2026-05-06")).toBe("2862.00");
    expect(sig.maxSafeExtra).toBe("2362.00");
    expect(dragged(sig).map((d) => d[0]).sort()).toEqual([
      "Apple Card minimum",
      "Capital One Platinum minimum",
      "Discover It minimum",
      "Target RedCard minimum",
    ]);
    expect(sig.overdueAssumedPaid).toEqual([]);
  });

  it("R5 Avalanche extra $500 paid 04-30 by 'ONLINE PAYMENT THANK YOU': (decision 13) tier 3, drags — 2,000 (was 2,500); the Sapphire minimum stays paid", async () => {
    await snapshot({ balance: "3000" });
    await debt("Chase Sapphire", "25", 20, "20000");
    await avalanche("500", LONG_AGO);
    await bill({ name: "Paycheck", kind: "income", amount: "525", dayOfMonth: 15, anchorDate: "2026-01-15" });
    await row("2026-04-15", "525.00", "ACME PAYROLL");
    await row("2026-04-20", "-25.00", "CHASE CREDIT CRD AUTOPAY");
    await row("2026-04-30", "-500.00", "ONLINE PAYMENT THANK YOU");
    const sig = await signal();
    expect(sig.maxSafeExtra).toBe("2000.00");
    expect(dragged(sig)).toEqual([["Avalanche extra payment", "2026-05-06", "-500.00", "overdue_assumed_unpaid"]]);
    // "chase" paid exactly on the day: some of the name within max($1, 1%) and 5 days — tier 2.
    expect(paidList(sig)).toEqual([["Chase Sapphire minimum", "2026-04-20", "high", "0.00"]]);
  });

  it("R6 rent actually unpaid: it still drags — max safe extra 1,000 — and April's is listed", async () => {
    await snapshot({ balance: "3000" });
    const rent = await bill({ name: "Rent", amount: "1500", dayOfMonth: 1 });
    await paycheck("1500");
    await row("2026-04-28", "1500.00", "ACME PAYROLL");
    const sig = await signal();
    expect(balanceOn(sig, "2026-05-06")).toBe("1500.00");
    expect(sig.maxSafeExtra).toBe("1000.00");
    expect(dragged(sig)).toEqual([["Rent", "2026-05-06", "-1500.00", "overdue_assumed_unpaid"]]);
    expect(sig.overdueAssumedPaid).toEqual([]);
    expect(sig.overdueOutsideForecast).toEqual([
      { planKey: `${rent}|2026-04-01`, itemId: rent, occurrenceDate: "2026-04-01", dueDate: "2026-04-01", amount: "-1500.00", label: "Rent", daysOverdue: 34 },
    ]);
  });

  it("R7 the whole household, everything paid by nameless rows: (decision 13) rent, car, State Farm and the Avalanche extra drag — low 3,408.43 (was 6,500); the card minimums stay paid", async () => {
    await snapshot({ balance: "6500" });
    await bill({ name: "Rent", amount: "1500", dayOfMonth: 1 });
    await bill({ name: "Hannah's Car", amount: "431.57", dayOfMonth: 2, anchorDate: "2026-01-02" });
    await bill({ name: "State Farm", amount: "660", dayOfMonth: 3, anchorDate: "2026-01-03" });
    await debt("Capital One Platinum", "40", 4);
    await avalanche("500", LONG_AGO);
    await bill({ name: "Brad paycheck", kind: "income", amount: "2000", frequency: "biweekly", dayOfMonth: null, anchorDate: "2026-01-02" });
    await bill({ name: "Hannah paycheck", kind: "income", amount: "1000", dayOfMonth: 15, anchorDate: "2026-01-15" });
    for (const m of ["04", "05"]) {
      await row(`2026-${m}-01`, "-1500.00", "ZELLE TO JORDAN LEE");
      await row(`2026-${m}-02`, "-431.57", "AUTO LOAN PMT 8812");
      await row(`2026-${m}-03`, "-660.00", "SF RO 27 PREM");
    }
    await row("2026-04-04", "-650.00", "CAPITAL ONE MOBILE PYMT");
    await row("2026-05-04", "-812.40", "CAPITAL ONE MOBILE PYMT");
    await row("2026-04-30", "-500.00", "ONLINE PAYMENT THANK YOU");
    await row("2026-04-10", "2000.00", "ACME PAYROLL");
    await row("2026-04-24", "2000.00", "ACME PAYROLL");
    await row("2026-04-15", "1000.00", "EXACT SCIENCES DIR DEP");
    const sig = await signal();
    expect(sig.bankToday).toBe("6500.00");
    // 6,500.00 − 1,500 − 431.57 − 660 − 500 on Wed 05-06 (the first PR6 rule read 3,368.43 here).
    expect(sig.lowestProjected).toBe("3408.43");
    expect(sig.maxSafeExtra).toBe("2908.43");
    expect(dragged(sig).sort()).toEqual([
      ["Avalanche extra payment", "2026-05-06", "-500.00", "overdue_assumed_unpaid"],
      ["Hannah's Car", "2026-05-06", "-431.57", "overdue_assumed_unpaid"],
      ["Rent", "2026-05-06", "-1500.00", "overdue_assumed_unpaid"],
      ["State Farm", "2026-05-06", "-660.00", "overdue_assumed_unpaid"],
    ]);
    // April's nameless payments prove nothing either: listed, off the curve (over 14 days).
    expect((sig.overdueOutsideForecast ?? []).map((p) => [p.label, p.dueDate])).toEqual([
      ["Rent", "2026-04-01"],
      ["Hannah's Car", "2026-04-02"],
      ["State Farm", "2026-04-03"],
    ]);
    expect(sig.incomeNotArrived).toEqual([]); // three paychecks arrived with no name (income keeps PR6's rule)
    expect(paidList(sig)).toEqual([
      ["Capital One Platinum minimum", "2026-04-04", "card_payment", "0.00"],
      ["Capital One Platinum minimum", "2026-05-04", "card_payment", "0.00"],
    ]);
  });

  // ⭐ (Decision 13) REPLACES "a bill a named row paid in part: only the unpaid
  // remainder drags" ($150 bill, a $120 row: 2,970.00 on 05-06, −30.00 dragging).
  // $30 short is outside tier 2's band (plan − max($1, 1%)): the pair is a
  // suggestion and the whole bill drags until the user records "Partial".
  it("(decision 13) a bill a named row underpaid by more than max($1, 1%): tier 3, the whole bill drags (2,970 → 2,850)", async () => {
    await snapshot({ balance: "3000" });
    const water = await bill({ name: "City Water", amount: "150", dayOfMonth: 1 });
    await paycheck("150");
    await row("2026-04-01", "-150.00", "WATER UTILITY PMT");
    const paid = await row("2026-05-01", "-120.00", "WATER UTILITY PMT");
    await row("2026-04-28", "150.00", "ACME PAYROLL");
    const sig = await signal();
    // 3,000.00 − 150.00 on Wed 05-06.
    expect(balanceOn(sig, "2026-05-06")).toBe("2850.00");
    expect(sig.lowestProjected).toBe("2850.00");
    expect(sig.maxSafeExtra).toBe("2350.00");
    expect(sig.events?.filter((e) => e.assumption !== null)).toEqual([
      {
        date: "2026-05-06",
        label: "City Water",
        amount: "-150.00",
        itemId: water,
        originalDate: "2026-05-01",
        assumption: "overdue_assumed_unpaid",
        occurrenceKey: `${water}|2026-05-01`,
        occurrenceDate: "2026-05-01",
      },
    ]);
    expect(sig.overdueAssumedPaid?.find((p) => p.dueDate === "2026-05-01")).toBeUndefined();
    expect(sig.matches?.find((m) => m.planKey === `${water}|2026-05-01`)).toMatchObject({ txnId: paid, difference: "-30.00", tier: 3, offCurve: false });
    // April was paid in full by its name: still paid.
    expect(paidList(sig)).toEqual([["City Water", "2026-04-01", "high", "0.00"]]);
  });

  it("a bill paid within max($1, 1%) short is tier 2: only the unpaid remainder over $1 drags", async () => {
    await snapshot({ balance: "3000" });
    const water = await bill({ name: "City Water", amount: "150", dayOfMonth: 1 });
    await paycheck("150");
    await row("2026-04-01", "-150.00", "WATER UTILITY PMT");
    const paid = await row("2026-05-01", "-148.50", "WATER UTILITY PMT");
    await row("2026-04-28", "150.00", "ACME PAYROLL");
    const sig = await signal();
    // 3,000.00 − 1.50 on Wed 05-06.
    expect(balanceOn(sig, "2026-05-06")).toBe("2998.50");
    expect(sig.lowestProjected).toBe("2998.50");
    expect(sig.maxSafeExtra).toBe("2498.50");
    expect(sig.events?.filter((e) => e.assumption !== null)).toEqual([
      {
        date: "2026-05-06",
        label: "City Water",
        amount: "-1.50",
        itemId: water,
        originalDate: "2026-05-01",
        assumption: "overdue_remainder_assumed_unpaid",
        occurrenceKey: `${water}|2026-05-01`,
        occurrenceDate: "2026-05-01",
      },
    ]);
    expect(sig.overdueAssumedPaid?.find((p) => p.dueDate === "2026-05-01")).toMatchObject({
      txnId: paid,
      planAmount: "-150.00",
      txnAmount: "-148.50",
      confidence: "high",
      unpaidRemainder: "-1.50",
    });
  });
});

/**
 * PR6 review, HIGH 2 — Storage is due the 28th. April 28 was moved to 05-02, and
 * the pre-PR6 Past-due card wrote its answer on 05-02. The answer belongs to
 * April; it must never land on May 28. Balance 2,400.00, buffer 0.
 */
describe("PR6 review, HIGH 2 — an old moved-to-date answer never moves onto next month's bill", () => {
  async function storage(todayISO: string, answer: "matched" | "missed" | "move"): Promise<string> {
    vi.setSystemTime(new Date(`${todayISO}T17:00:00Z`));
    await snapshot({ balance: "2400", buffer: "0", at: new Date(`${todayISO}T15:00:00Z`) });
    const id = await bill({ name: "Storage", amount: "300", dayOfMonth: 28, anchorDate: "2026-01-28" });
    await resolve("rescheduled", id, "2026-04-28", { rescheduledTo: "2026-05-02" });
    if (answer === "move") await resolve("rescheduled", id, "2026-05-02", { rescheduledTo: "2026-05-10" });
    else await resolve(answer, id, "2026-05-02");
    return id;
  }

  it.each(["matched", "missed"] as const)(
    "on 05-14, a %s on 05-02 closes April; May 28 is still due (2,400 until 05-27, then 2,100)",
    async (answer) => {
      await storage("2026-05-14", answer);
      const sig = await signal(30);
      expect(balanceOn(sig, "2026-05-15")).toBe("2400.00");
      expect(balanceOn(sig, "2026-05-27")).toBe("2400.00");
      expect(balanceOn(sig, "2026-05-28")).toBe("2100.00");
      expect(sig.lowestProjected).toBe("2100.00");
      expect(sig.endingBalance).toBe("2100.00");
      expect((sig.events ?? []).map((e) => [e.date, e.assumption])).toEqual([["2026-05-28", null]]);
      expect(sig.overdueOutsideForecast).toEqual([]);
    },
  );

  it.each(["matched", "missed"] as const)("on 05-17, a %s on 05-02: May 28 is still due (low 2,100)", async (answer) => {
    await storage("2026-05-17", answer);
    const sig = await signal(30);
    expect(sig.lowestProjected).toBe("2100.00");
    expect(sig.lowestDate).toBe("2026-05-28");
    expect(sig.maxSafeExtra).toBe("2100.00");
    expect(sig.overdueOutsideForecast).toEqual([]);
  });

  it("on 05-14, a Move written on 05-02 stays on 05-02: April still drags (05-15 2,100) and May 28 is due (1,800)", async () => {
    await storage("2026-05-14", "move");
    const sig = await signal(30);
    expect(balanceOn(sig, "2026-05-15")).toBe("2100.00");
    expect(balanceOn(sig, "2026-05-28")).toBe("1800.00");
    expect((sig.events ?? []).map((e) => [e.date, e.originalDate, e.occurrenceDate, e.assumption])).toEqual([
      ["2026-05-15", "2026-05-02", "2026-04-28", "overdue_assumed_unpaid"],
      ["2026-05-28", "2026-05-28", "2026-05-28", null],
    ]);
  });

  it("on 05-17, a Move written on 05-02: April is listed (15 days), May 28 is due (low 2,100)", async () => {
    const id = await storage("2026-05-17", "move");
    const sig = await signal(30);
    expect(sig.lowestProjected).toBe("2100.00");
    // On May 28 itself — the bug moved May's bill to 05-10 and dragged it onto 05-18.
    expect(sig.lowestDate).toBe("2026-05-28");
    expect((sig.events ?? []).map((e) => [e.date, e.originalDate, e.occurrenceDate])).toEqual([
      ["2026-05-28", "2026-05-28", "2026-05-28"],
    ]);
    expect(sig.overdueOutsideForecast).toEqual([
      { planKey: `${id}|2026-04-28`, itemId: id, occurrenceDate: "2026-04-28", dueDate: "2026-05-02", amount: "-300.00", label: "Storage", daysOverdue: 15 },
    ]);
  });

  it("the register agrees: the bundle keeps the old answer on 05-02, not on May 28", async () => {
    const id = await storage("2026-05-14", "missed");
    const res = await fetch(`${baseUrl}/forecast`);
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as { resolutions: Array<{ recurringItemId: string | null; occurrenceDate: string | null; status: string }> };
    expect(
      bundle.resolutions
        .filter((r) => r.recurringItemId === id)
        .map((r) => [r.status, r.occurrenceDate])
        .sort(),
    ).toEqual([
      ["missed", "2026-05-02"],
      ["rescheduled", "2026-04-28"],
    ]);
  });
});

describe("PR6 review, MEDIUM 1 — the Avalanche extra starts when it was set", () => {
  it("an extra saved on 05-05 never drags the 04-30 payment; one saved in January does", async () => {
    await snapshot({ balance: "3000" });
    await debt("Chase Sapphire", "25", 20, "20000");
    await bill({ name: "Paycheck", kind: "income", amount: "525", dayOfMonth: 15, anchorDate: "2026-01-15" });
    await row("2026-04-15", "525.00", "ACME PAYROLL");
    await row("2026-04-20", "-25.00", "CHASE CREDIT CRD AUTOPAY");
    await avalanche("500", new Date("2026-05-05T16:00:00Z"));

    const setToday = await signal();
    expect(setToday.maxSafeExtra).toBe("2500.00");
    expect(dragged(setToday)).toEqual([]);
    expect(setToday.overdueOutsideForecast).toEqual([]);
    expect(balanceOn(setToday, "2026-05-31")).toBe("3000.00"); // 05-15 +525, 05-20 −25, 05-31 −500

    await db.update(avalancheSettingsTable).set({ updatedAt: LONG_AGO }).where(eq(avalancheSettingsTable.userId, TEST_USER));
    const setInJanuary = await signal();
    expect(setInJanuary.maxSafeExtra).toBe("2000.00");
    expect(dragged(setInJanuary)).toEqual([["Avalanche extra payment", "2026-05-06", "-500.00", "overdue_assumed_unpaid"]]);
  });
});

describe("PR6 review, MEDIUM 2 — the lists", () => {
  it("are bounded by the first of last month, not by an old snapshot", async () => {
    vi.setSystemTime(new Date("2026-05-14T17:00:00Z"));
    await snapshot({ balance: "1000", buffer: "0", at: new Date("2026-01-10T15:00:00Z") });
    await bill({ name: "Gym", amount: "40", dayOfMonth: 15, anchorDate: "2025-12-15" });
    const sig = await signal(30);
    // Jan 15, Feb 15 and Mar 15 are expanded (the snapshot is 01-10) but never listed.
    expect((sig.overdueOutsideForecast ?? []).map((p) => [p.dueDate, p.daysOverdue])).toEqual([["2026-04-15", 29]]);
  });

  it("a bill 56 days overdue, older than the matching window, is not listed when a named row paid it", async () => {
    vi.setSystemTime(new Date("2026-05-31T17:00:00Z"));
    await snapshot({ balance: "1000", buffer: "0", at: new Date("2026-05-31T15:00:00Z") });
    await bill({ name: "Comcast", amount: "89.99", dayOfMonth: 5, anchorDate: "2026-01-05" });
    await row("2026-04-05", "-89.99", "COMCAST CABLE COMM");
    await row("2026-05-05", "-89.99", "COMCAST CABLE COMM");
    const sig = await signal(30);
    expect(sig.overdueOutsideForecast).toEqual([]);
    expect((sig.overdueAssumedPaid ?? []).map((p) => [p.dueDate, p.daysOverdue, p.confidence])).toEqual([
      ["2026-04-05", 56, "high"],
      ["2026-05-05", 26, "high"],
    ]);
    // The older pair is for the list only: it never reaches `matches`.
    expect((sig.matches ?? []).map((m) => m.planDate)).toEqual(["2026-05-05"]);
  });
});

// ⭐ PR6 third look, LOW 2 — A ROW THE USER TAGGED TO A DEBT PAYS THAT DEBT'S
// OVERDUE MINIMUM. "CHASE ONLINE PAYMENT" is not a card payment by PR7's phrases,
// so before this change a payment the user had tagged to Chase Sapphire still
// dragged its $40 minimum. Today = snapshot = Tue 05-05, balance 3,000, buffer 500.
describe("debt tag — a row tagged to a debt pays that debt's overdue minimum", () => {
  it("C5 'CHASE ONLINE PAYMENT' −600 tagged to Chase Sapphire pays the $40 minimum: max safe extra 2,460 → 2,500", async () => {
    await snapshot({ balance: "3000" });
    const sapphire = await debt("Chase Sapphire", "40", 1);
    await paycheck("40");
    await row("2026-04-01", "-550.00", "CHASE ONLINE PAYMENT", sapphire);
    const may = await row("2026-05-01", "-600.00", "CHASE ONLINE PAYMENT", sapphire);
    await row("2026-04-28", "40.00", "ACME PAYROLL");
    const sig = await signal();
    expect(sig.bankToday).toBe("3000.00");
    // Before: 3,000.00 − 40 on Wed 05-06, max safe extra 2,460.00, April listed as unpaid.
    expect(balanceOn(sig, "2026-05-06")).toBe("3000.00");
    expect(sig.lowestProjected).toBe("3000.00");
    expect(sig.maxSafeExtra).toBe("2500.00");
    expect(dragged(sig)).toEqual([]);
    expect(sig.overdueOutsideForecast).toEqual([]);
    expect(paidList(sig)).toEqual([
      ["Chase Sapphire minimum", "2026-04-01", "debt_tag", "0.00"],
      ["Chase Sapphire minimum", "2026-05-01", "debt_tag", "0.00"],
    ]);
    expect(sig.overdueAssumedPaid?.find((p) => p.dueDate === "2026-05-01")).toMatchObject({
      planKey: `debt:${sapphire}|2026-05-01`,
      txnId: may,
      txnAmount: "-600.00",
      planAmount: "-40.00",
    });
    // Overdue evidence only: nothing reaches `matches`.
    expect(sig.matches?.filter((m) => m.planItemId.startsWith("debt:"))).toEqual([]);
  });

  it("a row tagged to Chase Freedom pays Freedom's minimum, never Sapphire's: Sapphire's $40 still drags", async () => {
    await snapshot({ balance: "3000" });
    const sapphire = await debt("Chase Sapphire", "40", 1);
    const freedom = await debt("Chase Freedom", "30", 3);
    await paycheck("70");
    await row("2026-05-01", "-600.00", "CHASE ONLINE PAYMENT", freedom);
    await row("2026-04-28", "70.00", "ACME PAYROLL");
    const sig = await signal();
    // 3,000.00 − 40 on Wed 05-06 (before: − 40 − 30 = 2,930.00).
    expect(balanceOn(sig, "2026-05-06")).toBe("2960.00");
    expect(sig.maxSafeExtra).toBe("2460.00");
    expect(dragged(sig)).toEqual([["Chase Sapphire minimum", "2026-05-06", "-40.00", "overdue_assumed_unpaid"]]);
    expect(paidList(sig).filter((p) => p[1] >= "2026-05-01")).toEqual([
      ["Chase Freedom minimum", "2026-05-03", "debt_tag", "0.00"],
    ]);
    expect(sig.overdueAssumedPaid?.some((p) => p.planKey.startsWith(`debt:${sapphire}|`))).toBe(false);
  });

  it("a row tagged to Freedom that the matcher pairs with Sapphire's minimum is not evidence for Sapphire; the pair stays a suggestion", async () => {
    await snapshot({ balance: "3000" });
    const sapphire = await debt("Chase Sapphire", "40", 1);
    const freedom = await debt("Chase Freedom", "30", 3);
    await paycheck("70");
    // The shared word "chase", $5 over the $40 minimum and a day late: a medium pair with Sapphire.
    const pay = await row("2026-05-02", "-45.00", "CHASE ONLINE PAYMENT", freedom);
    await row("2026-04-28", "70.00", "ACME PAYROLL");
    const sig = await signal();
    // Before: Sapphire paid by the pair and Freedom dragging, 2,970.00. After: Sapphire drags, Freedom paid.
    expect(balanceOn(sig, "2026-05-06")).toBe("2960.00");
    expect(sig.maxSafeExtra).toBe("2460.00");
    expect(dragged(sig)).toEqual([["Chase Sapphire minimum", "2026-05-06", "-40.00", "overdue_assumed_unpaid"]]);
    expect(paidList(sig).filter((p) => p[1] >= "2026-05-01")).toEqual([
      ["Chase Freedom minimum", "2026-05-03", "debt_tag", "0.00"],
    ]);
    // The matcher is unchanged: the pair is still offered as a suggestion.
    expect(sig.matches?.find((m) => m.planItemId === `debt:${sapphire}`)).toMatchObject({ txnId: pay, confidence: "medium", ambiguous: false, offCurve: false });
  });
});

// ⭐ Review of `800ac47`, MEDIUM 1 — ONE TAGGED ROW PAID TWO CARDS. A row tagged to
// Freedom paid Freedom's overdue minimum by tag AND took Sapphire's upcoming minimum
// off the curve (`offCurve`). A pair whose row is tagged to another debt is never
// `offCurve` now, and a row used by an `offCurve` or evidence pair pays nothing else.
describe("review M1 — a row tagged to one debt never takes another debt's minimum off the curve", () => {
  it("Freedom $30 overdue, Sapphire $40 due 05-08: the Freedom-tagged row pays Freedom, Sapphire stays on the curve (2,500 → 2,460; base 2,470)", async () => {
    await snapshot({ balance: "3000" });
    const sapphire = await debt("Chase Sapphire", "40", 8);
    const freedom = await debt("Chase Freedom", "30", 28);
    await paycheck("70");
    await row("2026-04-08", "-40.00", "CHASE SAPPHIRE ONLINE PAYMENT");
    const pay = await row("2026-05-04", "-40.00", "CHASE SAPPHIRE ONLINE PAYMENT", freedom);
    await row("2026-04-28", "70.00", "ACME PAYROLL");
    const sig = await signal();
    // 800ac47: 2,500 (neither card on the curve). 500473e: 2,470 (Freedom's $30 dragging, Sapphire off).
    // Now Sapphire's $40 is on 05-08 — the card the row did NOT pay.
    expect(balanceOn(sig, "2026-05-06")).toBe("3000.00");
    expect(balanceOn(sig, "2026-05-08")).toBe("2960.00");
    expect(sig.lowestProjected).toBe("2960.00");
    expect(sig.maxSafeExtra).toBe("2460.00");
    expect(dragged(sig)).toEqual([]);
    expect(sig.overdueAssumedPaid?.find((p) => p.dueDate === "2026-04-28")).toMatchObject({
      planKey: `debt:${freedom}|2026-04-28`,
      txnId: pay,
      confidence: "debt_tag",
    });
    // The pair stays a suggestion, never off the curve.
    expect(sig.matches?.find((m) => m.planKey === `debt:${sapphire}|2026-05-08`)).toMatchObject({ txnId: pay, confidence: "high", offCurve: false });
    expect((sig.events ?? []).some((e) => e.itemId === `debt:${sapphire}` && e.date === "2026-05-08")).toBe(true);

    // T6c, the same row untagged: unchanged from base — it pays Sapphire's 05-08 (off the curve), Freedom drags.
    await db.update(transactionsTable).set({ debtId: null }).where(eq(transactionsTable.id, pay));
    const untagged = await signal();
    expect(balanceOn(untagged, "2026-05-06")).toBe("2970.00");
    expect(untagged.maxSafeExtra).toBe("2470.00");
    expect(dragged(untagged)).toEqual([["Chase Freedom minimum", "2026-05-06", "-30.00", "overdue_assumed_unpaid"]]);
    expect(untagged.matches?.find((m) => m.planKey === `debt:${sapphire}|2026-05-08`)).toMatchObject({ txnId: pay, offCurve: true });
  });

  it("future only (nothing overdue): a Freedom-tagged row never takes Sapphire's 05-08 minimum off the curve (2,470 → 2,430)", async () => {
    await snapshot({ balance: "3000" });
    const sapphire = await debt("Chase Sapphire", "40", 8);
    const freedom = await debt("Chase Freedom", "30", 20);
    // Both cards opened 05-01: no April minimums, nothing due before today.
    await db.update(debtsTable).set({ createdAt: new Date("2026-05-01T17:00:00Z") }).where(eq(debtsTable.userId, TEST_USER));
    await paycheck("70");
    const pay = await row("2026-05-04", "-40.00", "CHASE SAPPHIRE ONLINE PAYMENT", freedom);
    const sig = await signal();
    // 500473e and 800ac47: 2,470 (Sapphire 05-08 off the curve on the Freedom-tagged row).
    // Now: 05-08 −40 (2,960), 05-20 −30 (2,930). Freedom's 05-20 stays on the curve too: the
    // tag rule pays overdue minimums only (errs low by $30).
    expect(balanceOn(sig, "2026-05-08")).toBe("2960.00");
    expect(sig.lowestProjected).toBe("2930.00");
    expect(sig.maxSafeExtra).toBe("2430.00");
    expect(dragged(sig)).toEqual([]);
    expect(sig.overdueAssumedPaid).toEqual([]);
    expect(sig.matches?.find((m) => m.planKey === `debt:${sapphire}|2026-05-08`)).toMatchObject({ txnId: pay, offCurve: false });
  });
});

// ⭐ Review of `800ac47`, MEDIUM 2 — A LOGGED PAYMENT AND ITS BANK DEBIT PAID TWO
// MINIMUMS. `POST /debts/:id/payments` writes a manual row tagged to the debt; the
// bank shows the same payment as its own row. Only a Plaid row on the checking
// account pays by its tag now; a manual row's tag pays nothing.
describe("review M2 — only a checking-account bank row pays a minimum by its tag", () => {
  it("a $500 Sapphire payment logged in the app plus its untagged bank debit pay Sapphire only: Freedom drags (2,500 → 2,470)", async () => {
    await snapshot({ balance: "3000" });
    const sapphire = await debt("Chase Sapphire", "40", 1);
    await debt("Chase Freedom", "30", 3);
    await paycheck("70");
    await manualRow("2026-05-01", "-500.00", "Payment — Chase Sapphire", sapphire);
    const debit = await row("2026-05-01", "-500.00", "PAYMENT TO CHASE CARD ENDING IN 1234");
    await row("2026-04-28", "70.00", "ACME PAYROLL");
    const sig = await signal();
    // 800ac47: 3,000 on 05-06 and 2,500 — the log paid Sapphire by tag, the debit Freedom by name.
    expect(balanceOn(sig, "2026-05-06")).toBe("2970.00");
    expect(sig.maxSafeExtra).toBe("2470.00");
    expect(dragged(sig)).toEqual([["Chase Freedom minimum", "2026-05-06", "-30.00", "overdue_assumed_unpaid"]]);
    expect(paidList(sig).filter((p) => p[1] >= "2026-05-01")).toEqual([
      ["Chase Sapphire minimum", "2026-05-01", "card_payment", "0.00"],
    ]);
    expect(sig.overdueAssumedPaid?.find((p) => p.dueDate === "2026-05-01")).toMatchObject({ txnId: debit });
  });

  it("a payment logged in the app alone pays nothing by its tag: the $40 minimum drags (2,500 → 2,460; errs low)", async () => {
    await snapshot({ balance: "3000" });
    const sapphire = await debt("Chase Sapphire", "40", 1);
    await paycheck("40");
    await manualRow("2026-05-01", "-500.00", "Payment — Chase Sapphire", sapphire);
    await row("2026-04-28", "40.00", "ACME PAYROLL");
    const sig = await signal();
    expect(balanceOn(sig, "2026-05-06")).toBe("2960.00");
    expect(sig.maxSafeExtra).toBe("2460.00");
    expect(dragged(sig)).toEqual([["Chase Sapphire minimum", "2026-05-06", "-40.00", "overdue_assumed_unpaid"]]);
    expect(paidList(sig).filter((p) => p[1] >= "2026-05-01")).toEqual([]);
  });

  it("the bank debit tagged to Sapphire pays Sapphire by tag; the logged payment still pays nothing (Freedom drags, 2,470)", async () => {
    await snapshot({ balance: "3000" });
    const sapphire = await debt("Chase Sapphire", "40", 1);
    await debt("Chase Freedom", "30", 3);
    await paycheck("70");
    await manualRow("2026-05-01", "-500.00", "Payment — Chase Sapphire", sapphire);
    const debit = await row("2026-05-01", "-500.00", "CHASE ONLINE PAYMENT", sapphire);
    await row("2026-04-28", "70.00", "ACME PAYROLL");
    const sig = await signal();
    expect(balanceOn(sig, "2026-05-06")).toBe("2970.00");
    expect(sig.maxSafeExtra).toBe("2470.00");
    expect(dragged(sig)).toEqual([["Chase Freedom minimum", "2026-05-06", "-30.00", "overdue_assumed_unpaid"]]);
    expect(sig.overdueAssumedPaid?.find((p) => p.dueDate === "2026-05-01")).toMatchObject({ txnId: debit, confidence: "debt_tag" });
  });
});

// ⭐ OWNER DECISION 13 — MATCH EVIDENCE TIERS. "A different charge from the same
// company must not hide an unpaid bill. Merchant similarity alone is insufficient
// proof of payment." An overdue plan counts as paid only on a tier-1 or tier-2
// pair (an explicit tag, the bill's own category, its unique full name, or some
// of its name paid exactly and promptly on the checking account). A tier-3 pair
// is a suggestion: the plan drags and the pair stays in `matches`.
// Today = snapshot = Tue 05-05, buffer 500.
describe("decision 13 — only tier-1/2 evidence pays an overdue bill", () => {
  async function catRow(occurredOn: string, amount: string, description: string, categoryId: string): Promise<string> {
    const id = await row(occurredOn, amount, description);
    await db.update(transactionsTable).set({ categoryId }).where(eq(transactionsTable.id, id));
    return id;
  }
  const may = (sig: CashSignal, itemId: string) => sig.matches?.find((m) => m.planKey === `${itemId}|2026-05-01`);

  it("HELOC: FIGURE LENDING −1,185.19 in 'HELOC (Figure)', a category on that bill only → tier 2, paid, +55.19 (max safe extra 5,500)", async () => {
    await snapshot({ balance: "6000" });
    const H = randomUUID();
    const heloc = await bill({ name: "Figure HELOC", amount: "1130", dayOfMonth: 1, categoryId: H });
    await paycheck("1130");
    await catRow("2026-04-01", "-1185.19", "FIGURE LENDING", H);
    const txn = await catRow("2026-05-01", "-1185.19", "FIGURE LENDING", H);
    await row("2026-04-28", "1130.00", "ACME PAYROLL");
    const sig = await signal();
    expect(sig.lowestProjected).toBe("6000.00");
    expect(sig.maxSafeExtra).toBe("5500.00");
    expect(dragged(sig)).toEqual([]);
    expect(may(sig, heloc)).toMatchObject({ txnId: txn, difference: "55.19", confidence: "medium", ambiguous: false, tier: 2, offCurve: true });
    expect(paidList(sig)).toEqual([
      ["Figure HELOC", "2026-04-01", "medium", "0.00"],
      ["Figure HELOC", "2026-05-01", "medium", "0.00"],
    ]);
  });

  it("HELOC: the same category also on a second active bill → tier 3: the $1,130 drags (5,500 → 4,370) and the pair stays a suggestion", async () => {
    await snapshot({ balance: "6000" });
    const H = randomUUID();
    const heloc = await bill({ name: "Figure HELOC", amount: "1130", dayOfMonth: 1, categoryId: H });
    // Active, one-time in December: no occurrence in the window, but it shares the category.
    await bill({ name: "Figure annual fee", amount: "75", frequency: "onetime", dayOfMonth: null, anchorDate: "2026-12-01", categoryId: H });
    await paycheck("1130");
    await catRow("2026-04-01", "-1185.19", "FIGURE LENDING", H);
    const txn = await catRow("2026-05-01", "-1185.19", "FIGURE LENDING", H);
    await row("2026-04-28", "1130.00", "ACME PAYROLL");
    const sig = await signal();
    // 6,000.00 − 1,130.00 on Wed 05-06.
    expect(balanceOn(sig, "2026-05-06")).toBe("4870.00");
    expect(sig.lowestProjected).toBe("4870.00");
    expect(sig.maxSafeExtra).toBe("4370.00");
    expect(dragged(sig)).toEqual([["Figure HELOC", "2026-05-06", "-1130.00", "overdue_assumed_unpaid"]]);
    expect(may(sig, heloc)).toMatchObject({ txnId: txn, difference: "55.19", tier: 3, offCurve: false });
    expect(sig.overdueAssumedPaid).toEqual([]);
    expect((sig.overdueOutsideForecast ?? []).map((p) => [p.label, p.dueDate])).toEqual([["Figure HELOC", "2026-04-01"]]);
  });

  it("HELOC due after today: the unique-category row paid early takes it off the curve; with the category shared it stays", async () => {
    await snapshot({ balance: "6000" });
    const H = randomUUID();
    const heloc = await bill({ name: "Figure HELOC", amount: "1130", dayOfMonth: 10, categoryId: H });
    await catRow("2026-04-10", "-1185.19", "FIGURE LENDING", H);
    const txn = await catRow("2026-05-04", "-1185.19", "FIGURE LENDING", H);
    const unique = await signal();
    expect(balanceOn(unique, "2026-05-10")).toBe("6000.00");
    expect(unique.matches?.find((m) => m.planKey === `${heloc}|2026-05-10`)).toMatchObject({ txnId: txn, dayDelta: -6, difference: "55.19", tier: 2, offCurve: true });

    await bill({ name: "Figure annual fee", amount: "75", frequency: "onetime", dayOfMonth: null, anchorDate: "2026-12-01", categoryId: H });
    const shared = await signal();
    expect(balanceOn(shared, "2026-05-10")).toBe("4870.00");
    expect(shared.matches?.find((m) => m.planKey === `${heloc}|2026-05-10`)).toMatchObject({ txnId: txn, tier: 3, offCurve: false });
  });

  it("Verizon: overdue 'Verizon Fios' $120 (Utilities, on three bills), 'VERIZON WIRELESS' −98 → tier 3: the full $120 drags (was −22.00; max safe extra 2,478 → 2,380)", async () => {
    await snapshot({ balance: "3000" });
    const U = randomUUID();
    const fios = await bill({ name: "Verizon Fios", amount: "120", dayOfMonth: 1, categoryId: U });
    await bill({ name: "City Water", amount: "60", frequency: "onetime", dayOfMonth: null, anchorDate: "2026-12-01", categoryId: U });
    await bill({ name: "Evergy Electric", amount: "150", frequency: "onetime", dayOfMonth: null, anchorDate: "2026-12-01", categoryId: U });
    await paycheck("120");
    await catRow("2026-04-01", "-120.00", "VERIZON FIOS", U);
    const txn = await catRow("2026-05-01", "-98.00", "VERIZON WIRELESS", U);
    await row("2026-04-28", "120.00", "ACME PAYROLL");
    const sig = await signal();
    // Before: paid on a medium pair, only the $22 remainder dragged (2,978.00 on 05-06, max safe extra 2,478.00).
    expect(balanceOn(sig, "2026-05-06")).toBe("2880.00");
    expect(sig.maxSafeExtra).toBe("2380.00");
    expect(dragged(sig)).toEqual([["Verizon Fios", "2026-05-06", "-120.00", "overdue_assumed_unpaid"]]);
    expect(may(sig, fios)).toMatchObject({ txnId: txn, difference: "-22.00", confidence: "medium", tier: 3, offCurve: false });
    // April was paid by its full name (unique among the household's bills): tier 2.
    expect(paidList(sig)).toEqual([["Verizon Fios", "2026-04-01", "high", "0.00"]]);

    // −85 is too far from $120 to pair at all: unchanged, the $120 drags.
    await db.update(transactionsTable).set({ amount: "-85.00" }).where(eq(transactionsTable.id, txn));
    const far = await signal();
    expect(balanceOn(far, "2026-05-06")).toBe("2880.00");
    expect(may(far, fios)).toBeUndefined();
  });

  it("Verizon: bill 'Verizon Wireless' $85 paid 'VERIZON WIRELESS' −85 → tier 2, paid; 'Verizon Fios' $120 beside it is not paid by it", async () => {
    await snapshot({ balance: "3000" });
    const wireless = await bill({ name: "Verizon Wireless", amount: "85", dayOfMonth: 1 });
    await bill({ name: "Verizon Fios", amount: "120", dayOfMonth: 1 });
    await paycheck("205");
    await row("2026-04-01", "-85.00", "VERIZON WIRELESS");
    await row("2026-04-01", "-120.00", "VERIZON FIOS");
    const txn = await row("2026-05-01", "-85.00", "VERIZON WIRELESS");
    await row("2026-04-28", "205.00", "ACME PAYROLL");
    const sig = await signal();
    expect(may(sig, wireless)).toMatchObject({ txnId: txn, tier: 2, offCurve: true });
    expect(dragged(sig)).toEqual([["Verizon Fios", "2026-05-06", "-120.00", "overdue_assumed_unpaid"]]);
    expect(balanceOn(sig, "2026-05-06")).toBe("2880.00");
  });

  it("rent by a nameless Zelle: tier 3 and drags (R1); the same Zelle in the rent's own category is tier 2 and paid", async () => {
    await snapshot({ balance: "3000" });
    const R = randomUUID();
    const rent = await bill({ name: "Rent", amount: "1500", dayOfMonth: 1, categoryId: R });
    await paycheck("1500");
    const april = await row("2026-04-01", "-1500.00", "ZELLE TO JORDAN LEE");
    const txn = await row("2026-05-01", "-1500.00", "ZELLE TO JORDAN LEE");
    await row("2026-04-28", "1500.00", "ACME PAYROLL");
    const nameless = await signal();
    expect(balanceOn(nameless, "2026-05-06")).toBe("1500.00");
    expect(nameless.maxSafeExtra).toBe("1000.00");
    expect(may(nameless, rent)).toMatchObject({ txnId: txn, confidence: "low", tier: 3, offCurve: false });

    await db.update(transactionsTable).set({ categoryId: R }).where(eq(transactionsTable.id, april));
    await db.update(transactionsTable).set({ categoryId: R }).where(eq(transactionsTable.id, txn));
    const categorised = await signal();
    expect(balanceOn(categorised, "2026-05-06")).toBe("3000.00");
    expect(categorised.maxSafeExtra).toBe("2500.00");
    expect(dragged(categorised)).toEqual([]);
    expect(may(categorised, rent)).toMatchObject({ txnId: txn, tier: 2, offCurve: true });
  });
});
