// ⭐ PR5 — "probably paid": a planned payment a bank row probably paid leaves the
// forecast curve, so the bill is not counted twice. The bank row always counts;
// cash today never moves. Balance 1,000.00 read at 10:00 CT on 2026-05-01; today
// is pinned to 2026-05-14; each plan is due on the 20th.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { computeCashSignal, type CashSignal } from "../lib/cashSignal";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const TEST_USER = `probably-paid-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
const PINNED_NOW = new Date("2026-05-14T12:00:00Z");

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
  await cleanup();
});
afterEach(() => {
  vi.useRealTimers();
});

const CHASE = "chase-probably-paid";

async function snapshotOnChase(): Promise<void> {
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
    bankSnapshotAt: new Date("2026-05-01T15:00:00Z"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
  });
}

async function plan(name: string, amount: string): Promise<string> {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name,
      kind: "expense",
      amount,
      frequency: "monthly",
      dayOfMonth: 20,
      anchorDate: "2026-01-20",
      active: "true",
    })
    .returning();
  return r!.id;
}

async function row(occurredOn: string, amount: string, description: string, pending = false): Promise<string> {
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
      pending,
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

async function resolve(status: string, itemId: string, occurrenceDate: string, txnId: string): Promise<void> {
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    recurringItemId: itemId,
    occurrenceDate,
    status,
    matchedTxnId: txnId,
  });
}

const signal = () => computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 90 });
const balanceOn = (sig: CashSignal, date: string) => sig.daily?.find((d) => d.date === date)?.balance;

describe("(PR5) a plan a bank row probably paid leaves the curve", () => {
  it("$150 plan paid $150 eight days early: the bill is not counted twice", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    const txn = await row("2026-05-12", "-150", "CITY WATER UTIL");

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("850.00");
    expect(balanceOn(sig, "2026-06-20")).toBe("700.00");
    expect(sig.matches).toEqual([
      {
        planKey: `${water}|2026-05-20`,
        planItemId: water,
        planDate: "2026-05-20",
        txnId: txn,
        planAmount: "-150.00",
        txnAmount: "-150.00",
        difference: "0.00",
        dayDelta: -8,
        confidence: "medium",
        ambiguous: false,
      },
    ]);
  });

  it("$150 plan paid $173: the curve carries −$173 once, never −$323", async () => {
    await snapshotOnChase();
    await plan("City Water", "150");
    await row("2026-05-12", "-173", "CITY WATER UTIL");

    const sig = await signal();

    expect(sig.bankToday).toBe("827.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("827.00");
    expect(sig.matches?.[0]).toMatchObject({ difference: "23.00", dayDelta: -8 });
  });

  it("'Not this' puts the plan back on the curve and the pair never returns", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    const txn = await row("2026-05-12", "-150", "CITY WATER UTIL");
    await resolve("not_match", water, "2026-05-20", txn);

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("700.00");
    expect(sig.matches).toEqual([]);
  });

  it("a partial confirmation leaves the unpaid remainder scheduled: $500 plan, $250 paid", async () => {
    await snapshotOnChase();
    const rent = await plan("Oak Street Rent", "500");
    const txn = await row("2026-05-12", "-250", "OAK STREET PROPERTIES");
    await resolve("partial", rent, "2026-05-20", txn);

    const sig = await signal();

    expect(sig.bankToday).toBe("750.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("500.00");
    expect(sig.matches).toEqual([]);
  });

  it("two −$50 rows do not pay a −$100 plan: the plan stays and nothing counts twice", async () => {
    await snapshotOnChase();
    await plan("Utility", "100");
    await row("2026-05-12", "-50", "UTILITY CO");
    await row("2026-05-13", "-50", "UTILITY CO");

    const sig = await signal();

    expect(sig.bankToday).toBe("900.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("800.00");
    expect(sig.matches).toEqual([]);
  });

  it("a row already matched to another plan is not a candidate", async () => {
    await snapshotOnChase();
    await plan("City Water", "150");
    const other = await plan("Garden Service", "150");
    const txn = await row("2026-05-12", "-150", "CITY WATER UTIL");
    await resolve("matched", other, "2026-05-20", txn);

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    // Garden Service is matched (off the curve); City Water still weighs on the 20th.
    expect(balanceOn(sig, "2026-05-20")).toBe("700.00");
    expect(sig.matches).toEqual([]);
  });

  it("a pending row its posted row replaced is not a separate candidate: the posted row is the match", async () => {
    await snapshotOnChase();
    await plan("City Water", "150");
    await row("2026-05-10", "-150", "CITY WATER UTIL", true);
    const posted = await row("2026-05-11", "-150", "CITY WATER UTIL");

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("850.00");
    expect(sig.matches?.map((m) => m.txnId)).toEqual([posted]);
  });
});
