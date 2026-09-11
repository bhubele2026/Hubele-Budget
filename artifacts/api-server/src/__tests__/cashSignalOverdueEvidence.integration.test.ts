// ⭐ PR6 REVIEW — PAID OVERDUE BILLS STAY OFF THE CURVE; UNPAID ONES STILL DRAG.
//
// The independent review of `03815aa` (REQUEST CHANGES) measured the first PR6
// rule — "only an `offCurve` pair counts as paid" — bringing paid-but-unmatched
// bills back as dips. R1–R7 below are its cases, at today = snapshot = Tue
// 2026-05-05, buffer 500, a 90-day horizon, with April and May rows. A monthly
// paycheck covers each month's bills so the max safe extra reads cleanly.
//
// | Case | 9923add (#666) | 03815aa (first PR6) | this rule |
// | R1 rent by Zelle, no name            | 2,500 | 1,000    | 2,500 |
// | R2 rent by check                     | 2,500 | 1,000    | 2,500 |
// | R3 mortgage "LOAN PMT" + HELOC       | 5,500 | 2,284.21 | 5,500 |
// | R4 card minimums, larger payments    | 2,500 | 2,422    | 2,500 |
// | R5 Avalanche extra, no name          | 2,500 | 2,000    | 2,500 |
// | R6 rent actually unpaid              | 2,500 | 1,000    | 1,000 |
// | R7 whole household, all paid (low)   | 6,500 | 3,368.43 | 6,500 |
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

async function row(occurredOn: string, amount: string, description: string): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description,
      amount,
      plaidAccountId: CHASE,
      source: "plaid:chase",
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
  it("R1 rent paid by Zelle with no name: paid for the curve, max safe extra back to 2,500", async () => {
    await snapshot({ balance: "3000" });
    await bill({ name: "Rent", amount: "1500", dayOfMonth: 1 });
    await paycheck("1500");
    await row("2026-04-01", "-1500.00", "ZELLE TO JORDAN LEE");
    await row("2026-05-01", "-1500.00", "ZELLE TO JORDAN LEE");
    await row("2026-04-28", "1500.00", "ACME PAYROLL");
    const sig = await signal();
    expect(sig.bankToday).toBe("3000.00");
    expect(sig.lowestProjected).toBe("3000.00");
    expect(sig.maxSafeExtra).toBe("2500.00");
    expect(dragged(sig)).toEqual([]);
    expect(paidList(sig)).toEqual([
      ["Rent", "2026-04-01", "low", "0.00"],
      ["Rent", "2026-05-01", "low", "0.00"],
    ]);
    expect(sig.overdueOutsideForecast).toEqual([]);
    expect(sig.incomeNotArrived).toEqual([]); // the April paycheck arrived with no name
  });

  it("R2 rent paid by check, two days late: 2,500", async () => {
    await snapshot({ balance: "3000" });
    await bill({ name: "Rent", amount: "1500", dayOfMonth: 1 });
    await paycheck("1500");
    await row("2026-04-02", "-1500.00", "CHECK 1031");
    await row("2026-05-03", "-1500.00", "CHECK 1043");
    await row("2026-04-28", "1500.00", "ACME PAYROLL");
    const sig = await signal();
    expect(sig.maxSafeExtra).toBe("2500.00");
    expect(dragged(sig)).toEqual([]);
    expect(paidList(sig)).toEqual([
      ["Rent", "2026-04-01", "low", "0.00"],
      ["Rent", "2026-05-01", "low", "0.00"],
    ]);
  });

  it("R3 mortgage 'LOAN PMT' (no name) and a HELOC paid more by 'FIGURE LENDING' (part of the name): 5,500", async () => {
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
    expect(sig.lowestProjected).toBe("6000.00");
    expect(sig.maxSafeExtra).toBe("5500.00");
    expect(dragged(sig)).toEqual([]);
    expect(paidList(sig).filter((p) => p[1] === "2026-05-01").sort()).toEqual([
      ["Figure HELOC", "2026-05-01", "medium", "0.00"],
      ["Mortgage", "2026-05-01", "low", "0.00"],
    ]);
  });

  it("R4 card minimums $40 and $38 paid by $812.40 and $400 card payments (no pair at all): 2,500", async () => {
    await snapshot({ balance: "3000" });
    const capOne = await debt("Capital One Platinum", "40", 1);
    await debt("Discover It", "38", 3);
    await paycheck("78");
    await row("2026-04-01", "-650.00", "CAPITAL ONE MOBILE PMT");
    await row("2026-04-03", "-300.00", "DISCOVER E-PAYMENT");
    const may = await row("2026-05-01", "-812.40", "CAPITAL ONE MOBILE PMT");
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

  it("R5 Avalanche extra $500 paid 04-30 by 'ONLINE PAYMENT THANK YOU': 2,500", async () => {
    await snapshot({ balance: "3000" });
    await debt("Chase Sapphire", "25", 20, "20000");
    await avalanche("500", LONG_AGO);
    await bill({ name: "Paycheck", kind: "income", amount: "525", dayOfMonth: 15, anchorDate: "2026-01-15" });
    await row("2026-04-15", "525.00", "ACME PAYROLL");
    await row("2026-04-20", "-25.00", "CHASE CREDIT CRD AUTOPAY");
    await row("2026-04-30", "-500.00", "ONLINE PAYMENT THANK YOU");
    const sig = await signal();
    expect(sig.maxSafeExtra).toBe("2500.00");
    expect(dragged(sig)).toEqual([]);
    expect(paidList(sig)).toEqual([
      ["Chase Sapphire minimum", "2026-04-20", "high", "0.00"],
      ["Avalanche extra payment", "2026-04-30", "low", "0.00"],
    ]);
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

  it("R7 the whole household, everything paid: low 6,500, max safe extra 6,000; nothing listed as unpaid", async () => {
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
    await row("2026-04-04", "-650.00", "CAPITAL ONE MOBILE PMT");
    await row("2026-05-04", "-812.40", "CAPITAL ONE MOBILE PMT");
    await row("2026-04-30", "-500.00", "ONLINE PAYMENT THANK YOU");
    await row("2026-04-10", "2000.00", "ACME PAYROLL");
    await row("2026-04-24", "2000.00", "ACME PAYROLL");
    await row("2026-04-15", "1000.00", "EXACT SCIENCES DIR DEP");
    const sig = await signal();
    expect(sig.bankToday).toBe("6500.00");
    expect(sig.lowestProjected).toBe("6500.00");
    expect(sig.maxSafeExtra).toBe("6000.00");
    expect(dragged(sig)).toEqual([]);
    expect(sig.overdueOutsideForecast).toEqual([]); // Hannah's Car 04-02 was paid with no name
    expect(sig.incomeNotArrived).toEqual([]); // three paychecks arrived with no name
    expect(paidList(sig)).toEqual([
      ["Rent", "2026-04-01", "low", "0.00"],
      ["Hannah's Car", "2026-04-02", "low", "0.00"],
      ["State Farm", "2026-04-03", "low", "0.00"],
      ["Capital One Platinum minimum", "2026-04-04", "card_payment", "0.00"],
      ["Avalanche extra payment", "2026-04-30", "low", "0.00"],
      ["Rent", "2026-05-01", "low", "0.00"],
      ["Hannah's Car", "2026-05-02", "low", "0.00"],
      ["State Farm", "2026-05-03", "low", "0.00"],
      ["Capital One Platinum minimum", "2026-05-04", "card_payment", "0.00"],
    ]);
  });

  it("a bill a named row paid in part: only the unpaid remainder drags", async () => {
    await snapshot({ balance: "3000" });
    const water = await bill({ name: "City Water", amount: "150", dayOfMonth: 1 });
    await paycheck("150");
    await row("2026-04-01", "-150.00", "WATER UTILITY PMT");
    const paid = await row("2026-05-01", "-120.00", "WATER UTILITY PMT");
    await row("2026-04-28", "150.00", "ACME PAYROLL");
    const sig = await signal();
    // 3,000.00 − 30.00 on Wed 05-06.
    expect(balanceOn(sig, "2026-05-06")).toBe("2970.00");
    expect(sig.lowestProjected).toBe("2970.00");
    expect(sig.maxSafeExtra).toBe("2470.00");
    expect(sig.events?.filter((e) => e.assumption !== null)).toEqual([
      {
        date: "2026-05-06",
        label: "City Water",
        amount: "-30.00",
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
      txnAmount: "-120.00",
      confidence: "low",
      unpaidRemainder: "-30.00",
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
