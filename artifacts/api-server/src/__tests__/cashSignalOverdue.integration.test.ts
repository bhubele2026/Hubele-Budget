// ⭐ PR6 — OVERDUE BILLS ARE ASSUMED UNPAID, NEVER DROPPED SILENTLY.
//
// The pre-snapshot drop (#666/#688) hid every unpaid bill due before the last
// Sync. Now a plan occurrence that nothing resolved and no bank row confidently
// paid (`offCurve`) is:
//   - due in [today−14, today) → the next business day, `overdue_assumed_unpaid`;
//   - due today → the next business day, `due_today_not_posted` (day 0 = bank);
//   - older → `overdueOutsideForecast`, off the curve;
//   - income due before today → `incomeNotArrived`, off the curve.
// Weekly-cadence expenses keep the old rule until PR8 (last describe).
//
// Balance 1,000.00 read at 10:00 CT on Thu 2026-05-14, on Chase; today is pinned
// to 2026-05-14 unless a test says otherwise. Only Date is mocked, so the HTTP
// server's timers stay real.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `overdue-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

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
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { computeCashSignal, type CashSignal } from "../lib/cashSignal";
import { buildBillsSummary } from "../lib/billsSummary";
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

const PINNED_NOW = new Date("2026-05-14T12:00:00Z");
const CHASE = "chase-overdue";

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
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
  vi.setSystemTime(PINNED_NOW);
  await cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

async function snapshot(at = new Date("2026-05-14T15:00:00Z")): Promise<void> {
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
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: item!.id, accountId: CHASE, name: "Chase Checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "1000",
    bankSnapshotAt: at,
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
      dayOfMonth: 15,
      anchorDate: "2026-01-15",
      active: "true",
      ...over,
    })
    .returning();
  return r!.id;
}

async function bankRow(occurredOn: string, amount: string, description: string): Promise<string> {
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

async function resolve(
  status: string,
  itemId: string,
  occurrenceDate: string,
  extra: { txnId?: string; rescheduledTo?: string } = {},
): Promise<void> {
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

const signal = (horizonDays = 30) => computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays });
const balanceOn = (sig: CashSignal, date: string) => sig.daily?.find((d) => d.date === date)?.balance;

describe("PR6 — the overdue window", () => {
  it("an expense due 15 days ago is listed outside the forecast; one due 14 days ago still drags", async () => {
    await snapshot();
    const water = await bill({ name: "Water", frequency: "onetime", anchorDate: "2026-04-29", amount: "60" });
    await bill({ name: "Trash", frequency: "onetime", anchorDate: "2026-04-30", amount: "25" });
    const sig = await signal();
    expect(sig.bankToday).toBe("1000.00");
    expect(balanceOn(sig, "2026-05-14")).toBe("1000.00");
    expect(balanceOn(sig, "2026-05-15")).toBe("975.00");
    expect(sig.endingBalance).toBe("975.00");
    expect((sig.events ?? []).map((e) => [e.label, e.date, e.originalDate, e.assumption])).toEqual([
      ["Trash", "2026-05-15", "2026-04-30", "overdue_assumed_unpaid"],
    ]);
    expect(sig.overdueOutsideForecast).toEqual([
      {
        planKey: `${water}|2026-04-29`,
        itemId: water,
        occurrenceDate: "2026-04-29",
        dueDate: "2026-04-29",
        amount: "-60.00",
        label: "Water",
        daysOverdue: 15,
      },
    ]);
  });

  it("a bill due today lands on the next business day, so day 0 equals the bank", async () => {
    await snapshot();
    const phone = await bill({ name: "Phone", frequency: "onetime", anchorDate: "2026-05-14", amount: "95" });
    const sig = await signal();
    expect(sig.bankToday).toBe("1000.00");
    expect(sig.daily?.[0]).toEqual({ date: "2026-05-14", balance: "1000.00" });
    expect(sig.daily?.[1]).toEqual({ date: "2026-05-15", balance: "905.00" });
    expect(sig.events).toEqual([
      {
        date: "2026-05-15",
        label: "Phone",
        amount: "-95.00",
        itemId: phone,
        originalDate: "2026-05-14",
        assumption: "due_today_not_posted",
        occurrenceKey: `${phone}|2026-05-14`,
        occurrenceDate: "2026-05-14",
      },
    ]);
  });

  it("a skipped overdue occurrence is neither on the curve nor listed", async () => {
    await snapshot();
    const gym = await bill({ name: "Gym", dayOfMonth: 8, anchorDate: "2026-01-08", amount: "40" });
    await resolve("skipped", gym, "2026-05-08");
    await resolve("skipped", gym, "2026-04-08");
    const sig = await signal();
    expect(balanceOn(sig, "2026-05-15")).toBe("1000.00");
    expect(balanceOn(sig, "2026-06-08")).toBe("960.00");
    expect((sig.events ?? []).map((e) => e.date)).toEqual(["2026-06-08"]);
    expect(sig.overdueOutsideForecast).toEqual([]);
  });

  it("an overdue bill with only a low suggestion still drags — an unconfirmed guess never overstates cash", async () => {
    await snapshot();
    const water = await bill({ name: "Water", frequency: "onetime", anchorDate: "2026-05-10", amount: "60" });
    // No payee name, same amount, a day later: a "low" pair, never `offCurve`.
    const txn = await bankRow("2026-05-11", "-60.00", "ACH DEBIT 88213");
    const sig = await signal();
    expect(sig.bankToday).toBe("1000.00"); // the row is dated before the snapshot day
    expect(balanceOn(sig, "2026-05-15")).toBe("940.00");
    expect(sig.events?.[0]).toMatchObject({ occurrenceKey: `${water}|2026-05-10`, assumption: "overdue_assumed_unpaid" });
    // The web joins the suggestion to the dragged plan by this key.
    expect(sig.matches).toEqual([
      expect.objectContaining({ planKey: `${water}|2026-05-10`, txnId: txn, confidence: "low", offCurve: false }),
    ]);
  });

  it("income that has not arrived stays off the curve and is listed", async () => {
    await snapshot();
    const pay = await bill({ name: "Paycheck", kind: "income", dayOfMonth: 8, anchorDate: "2026-01-08", amount: "2000" });
    const sig = await signal();
    expect(sig.daily?.[0]).toEqual({ date: "2026-05-14", balance: "1000.00" });
    expect(balanceOn(sig, "2026-05-15")).toBe("1000.00");
    expect(balanceOn(sig, "2026-06-08")).toBe("3000.00");
    expect(sig.endingBalance).toBe("3000.00");
    expect(sig.events).toEqual([]);
    expect(sig.incomeNotArrived).toEqual([
      { planKey: `${pay}|2026-04-08`, itemId: pay, occurrenceDate: "2026-04-08", dueDate: "2026-04-08", amount: "2000.00", label: "Paycheck", daysOverdue: 36 },
      { planKey: `${pay}|2026-05-08`, itemId: pay, occurrenceDate: "2026-05-08", dueDate: "2026-05-08", amount: "2000.00", label: "Paycheck", daysOverdue: 6 },
    ]);
    expect(sig.overdueOutsideForecast).toEqual([]);
  });

  it("occurrences from before an item existed are never overdue: a semimonthly bill, a new debt's minimum, a weekly income", async () => {
    await snapshot();
    // Semimonthly ignores its anchor: 04-01, 04-15 and 05-01 are expanded, all before 05-12.
    await bill({ name: "Lawn care", frequency: "semimonthly", dayOfMonth: 1, anchorDate: "2026-05-12", amount: "50" });
    // Its 04-09 and 05-09 minimums are from before the debt was added (05-11).
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "New Card",
      type: "credit_card",
      balance: "900",
      minPayment: "35",
      dueDay: 9,
      status: "active",
      createdAt: new Date("2026-05-11T17:00:00Z"),
    });
    // Weekly expansion walks back past the anchor (04-07 … 05-05); 05-12 itself is due.
    const gig = await bill({ name: "Side gig", kind: "income", frequency: "weekly", dayOfMonth: null, anchorDate: "2026-05-12", amount: "100" });
    const sig = await signal();
    // 05-15 −50 · 05-19 +100 · 05-26 +100 · 06-01 −50 · 06-02 +100 · 06-09 −35 +100
    expect(balanceOn(sig, "2026-05-15")).toBe("950.00");
    expect(balanceOn(sig, "2026-06-01")).toBe("1100.00");
    expect(sig.endingBalance).toBe("1265.00");
    expect((sig.events ?? []).map((e) => [e.label, e.date, e.assumption])).toEqual([
      ["Lawn care", "2026-05-15", null],
      ["Lawn care", "2026-06-01", null],
      ["New Card minimum", "2026-06-09", null],
    ]);
    expect(sig.overdueOutsideForecast).toEqual([]);
    expect((sig.incomeNotArrived ?? []).map((p) => [p.planKey, p.daysOverdue])).toEqual([[`${gig}|2026-05-12`, 2]]);
  });
});

describe("PR6 — moved bills and the occurrence key", () => {
  it("a bill moved beyond the window leaves the overdue window; one moved into it drags from its moved-to date", async () => {
    await snapshot();
    const deposit = await bill({ name: "Deposit", frequency: "onetime", anchorDate: "2026-05-06", amount: "300" });
    await resolve("rescheduled", deposit, "2026-05-06", { rescheduledTo: "2026-07-01" });
    const fee = await bill({ name: "Late fee", frequency: "onetime", anchorDate: "2026-04-20", amount: "45" });
    await resolve("rescheduled", fee, "2026-04-20", { rescheduledTo: "2026-05-12" });

    const sig = await signal(); // through 06-13
    expect(balanceOn(sig, "2026-05-15")).toBe("955.00");
    expect(sig.endingBalance).toBe("955.00");
    expect(sig.events).toEqual([
      expect.objectContaining({
        label: "Late fee",
        date: "2026-05-15",
        originalDate: "2026-05-12",
        occurrenceDate: "2026-04-20",
        occurrenceKey: `${fee}|2026-04-20`,
        assumption: "overdue_assumed_unpaid",
      }),
    ]);
    expect(sig.overdueOutsideForecast).toEqual([]);

    const longer = await signal(60); // through 07-13
    expect(balanceOn(longer, "2026-07-01")).toBe("655.00");
  });

  it("Mark missed on a moved-then-overdue bill, sent with the occurrence key, clears it from the curve", async () => {
    await snapshot();
    const internet = await bill({ name: "Internet", frequency: "onetime", anchorDate: "2026-05-05", amount: "80" });
    await resolve("rescheduled", internet, "2026-05-05", { rescheduledTo: "2026-05-11" });
    const before = await signal();
    expect(balanceOn(before, "2026-05-15")).toBe("920.00");
    const ev = before.events![0]!;
    expect(ev).toMatchObject({ originalDate: "2026-05-11", occurrenceDate: "2026-05-05", occurrenceKey: `${internet}|2026-05-05` });

    // What the Past-due card and the chart tooltip now send.
    await resolve("missed", internet, ev.occurrenceDate);
    const after = await signal();
    expect(balanceOn(after, "2026-05-15")).toBe("1000.00");
    expect(after.events).toEqual([]);
  });

  it("a Mark missed the pre-PR6 card sent on the moved-to date still closes the moved bill", async () => {
    await snapshot();
    const internet = await bill({ name: "Internet", frequency: "onetime", anchorDate: "2026-05-05", amount: "80" });
    await resolve("rescheduled", internet, "2026-05-05", { rescheduledTo: "2026-05-11" });
    await resolve("missed", internet, "2026-05-11");
    const sig = await signal();
    expect(balanceOn(sig, "2026-05-15")).toBe("1000.00");
    expect(sig.events).toEqual([]);
  });

  it("…but not when the moved-to date is an occurrence of the bill in its own right", async () => {
    await snapshot();
    const cable = await bill({ name: "Cable", dayOfMonth: 11, anchorDate: "2026-01-11", amount: "50" });
    await resolve("rescheduled", cable, "2026-04-11", { rescheduledTo: "2026-05-11" });
    await resolve("missed", cable, "2026-05-11"); // May's own occurrence
    const sig = await signal();
    expect(balanceOn(sig, "2026-05-15")).toBe("950.00"); // April's, moved to 05-11, is still unpaid
    expect(balanceOn(sig, "2026-06-11")).toBe("900.00");
    expect((sig.events ?? []).map((e) => [e.date, e.originalDate, e.occurrenceDate])).toEqual([
      ["2026-05-15", "2026-05-11", "2026-04-11"],
      ["2026-06-11", "2026-06-11", "2026-06-11"],
    ]);
  });
});

describe("PR6 — a schedule edit after a match", () => {
  it("due day 14 → 20 after a match leaves no phantom 20th, on the curve or in the register", async () => {
    vi.setSystemTime(new Date("2026-05-24T17:00:00Z")); // Sunday
    await snapshot(new Date("2026-05-24T15:00:00Z"));
    const gym = await bill({ name: "Gym", dayOfMonth: 14, anchorDate: "2026-01-14", amount: "40" });
    const paid = await bankRow("2026-05-14", "-40.00", "GYM MEMBERSHIP");
    await resolve("matched", gym, "2026-05-14", { txnId: paid });
    await resolve("matched", gym, "2026-04-14");
    // What PATCH /recurring-items/:id writes.
    await db.update(recurringItemsTable).set({ dayOfMonth: 20, anchorDate: "2026-01-20" }).where(eq(recurringItemsTable.id, gym));

    const sig = await signal(); // through 06-23
    expect(balanceOn(sig, "2026-05-25")).toBe("1000.00");
    expect(sig.endingBalance).toBe("960.00");
    expect((sig.events ?? []).map((e) => e.date)).toEqual(["2026-06-20"]);
    expect(sig.overdueOutsideForecast).toEqual([]);

    const res = await fetch(`${baseUrl}/forecast`);
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as { resolutions: Array<{ recurringItemId: string | null; occurrenceDate: string | null }> };
    expect(
      bundle.resolutions
        .filter((r) => r.recurringItemId === gym)
        .map((r) => r.occurrenceDate)
        .sort(),
    ).toEqual(["2026-04-20", "2026-05-20"]);
    // Read-only: the stored rows keep their dates.
    const stored = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.recurringItemId, gym));
    expect(stored.map((r) => r.occurrenceDate).sort()).toEqual(["2026-04-14", "2026-05-14"]);
  });
});

describe("PR6 — one-time bills stay until resolved", () => {
  it("a one-time bill overdue after a page load is not archived: it drags, a moved one is recovered, and the Bills totals do not count it", async () => {
    await snapshot();
    const plumber = await bill({ name: "Plumber", frequency: "onetime", anchorDate: "2026-05-10", amount: "250" });
    await bill({ name: "Old invoice", frequency: "onetime", anchorDate: "2026-03-01", amount: "400" }); // 74 days
    const settled = await bill({ name: "Settled invoice", frequency: "onetime", anchorDate: "2026-05-11", amount: "70" });
    await resolve("missed", settled, "2026-05-11");
    const moved = await bill({ name: "Moved invoice", frequency: "onetime", anchorDate: "2026-03-10", amount: "125" });
    await resolve("rescheduled", moved, "2026-03-10", { rescheduledTo: "2026-05-20" });

    // The page load: GET /forecast runs the archive sweep.
    const res = await fetch(`${baseUrl}/forecast`);
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as { events: Array<{ itemId: string; date: string }> };
    const rows = await db.select().from(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
    expect(Object.fromEntries(rows.map((r) => [r.name, r.active]))).toEqual({
      Plumber: "true",
      "Old invoice": "false",
      "Settled invoice": "false",
      "Moved invoice": "true",
    });
    // The register still lists the unpaid bill.
    expect(bundle.events.some((e) => e.itemId === plumber && e.date === "2026-05-10")).toBe(true);

    const sig = await signal();
    expect(balanceOn(sig, "2026-05-15")).toBe("750.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("625.00");
    expect(sig.overdueOutsideForecast).toEqual([]);

    // The Bills page totals are what they were when these were archived.
    const summary = await buildBillsSummary(TEST_HOUSEHOLD_ID, TEST_USER);
    expect(summary.monthly.bills).toBe("0.00");
    expect(summary.monthly.active).toBe(0);
  });
});

/**
 * ⚠️ WEEKLY-CADENCE EXPENSES KEEP THE PRE-PR6 RULE UNTIL PR8 (`keepsPreSnapshotRule`).
 * The Weekly Spend reserve is a plain weekly bill no bank row ever pays; the
 * overdue rule would drag two weeks of it onto one day. Sunday 2026-05-17,
 * balance 1,000.00 read at 10:00 CT; Weekly Spend $300 anchored Saturday 05-09.
 * The 05-16 occurrence (the day before the snapshot, #688) drags to Mon 05-18;
 * everything earlier is dropped (#666). These are the figures `f40c4b0` gives.
 */
describe("⚠️ weekly-cadence expenses keep the pre-snapshot rule until PR8", () => {
  async function weeklySpend(): Promise<string> {
    vi.setSystemTime(new Date("2026-05-17T18:00:00Z"));
    await snapshot(new Date("2026-05-17T15:00:00Z"));
    return bill({ name: "Weekly Spend", frequency: "weekly", dayOfMonth: null, anchorDate: "2026-05-09", amount: "300" });
  }

  it("a Sunday snapshot with an unresolved weekly $300 expense: the same daily figures as before PR6", async () => {
    await weeklySpend();
    const sig = await signal(); // 05-17 … 06-16
    expect(sig.bankToday).toBe("1000.00");
    expect(sig.daily).toHaveLength(31);
    const moves = (sig.daily ?? []).filter((d, i, all) => i === 0 || d.balance !== all[i - 1]!.balance);
    expect(moves).toEqual([
      { date: "2026-05-17", balance: "1000.00" },
      { date: "2026-05-18", balance: "700.00" },
      { date: "2026-05-23", balance: "400.00" },
      { date: "2026-05-30", balance: "100.00" },
      { date: "2026-06-06", balance: "-200.00" },
      { date: "2026-06-13", balance: "-500.00" },
    ]);
    expect(sig.endingBalance).toBe("-500.00");
    expect(sig.lowestProjected).toBe("-500.00");
    expect(sig.lowestDate).toBe("2026-06-13");
    expect((sig.events ?? []).map((e) => [e.date, e.amount, e.originalDate])).toEqual([
      ["2026-05-18", "-300.00", "2026-05-16"],
      ["2026-05-23", "-300.00", "2026-05-23"],
      ["2026-05-30", "-300.00", "2026-05-30"],
      ["2026-06-06", "-300.00", "2026-06-06"],
      ["2026-06-13", "-300.00", "2026-06-13"],
    ]);
  });

  it("…tagged dragged_past_due, and never dragged or listed as overdue", async () => {
    const spend = await weeklySpend();
    const sig = await signal();
    expect(sig.events?.[0]).toMatchObject({ assumption: "dragged_past_due", occurrenceKey: `${spend}|2026-05-16` });
    expect((sig.events ?? []).slice(1).map((e) => e.assumption)).toEqual([null, null, null, null]);
    expect(sig.overdueOutsideForecast).toEqual([]);
  });
});
