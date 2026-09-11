// ⭐ PR5 — "probably paid": a planned payment a bank row confidently paid leaves
// the forecast curve, so the bill is not counted twice; every other pair is a
// suggestion and the plan still counts. The bank row always counts; cash today
// never moves. Balance 1,000.00 read at 10:00 CT on 2026-05-01; today is pinned
// to 2026-05-14.

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

async function plan(name: string, amount: string, day = 20): Promise<string> {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name,
      kind: "expense",
      amount,
      frequency: "monthly",
      dayOfMonth: day,
      anchorDate: `2026-01-${String(day).padStart(2, "0")}`,
      active: "true",
    })
    .returning();
  return r!.id;
}

async function row(
  occurredOn: string,
  amount: string,
  description: string,
  opts: { pending?: boolean; manual?: boolean } = {},
): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description,
      amount,
      plaidAccountId: opts.manual ? null : CHASE,
      source: opts.manual ? "manual" : "plaid:chase",
      pending: opts.pending ?? false,
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

const signal = () => computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 90 });
const balanceOn = (sig: CashSignal, date: string) => sig.daily?.find((d) => d.date === date)?.balance;
const matchFor = (sig: CashSignal, planKey: string) => sig.matches?.find((m) => m.planKey === planKey);

describe("(PR5) a plan a bank row confidently paid leaves the curve", () => {
  it("$150 plan paid $150 eight days early (April's bill paid in April): the bill is not counted twice", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    await row("2026-04-20", "-150", "CITY WATER UTIL"); // April paid on time (before the snapshot)
    const txn = await row("2026-05-12", "-150", "CITY WATER UTIL");

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("850.00");
    expect(balanceOn(sig, "2026-06-20")).toBe("700.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toEqual({
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
      offCurve: true,
    });
  });

  it("$150 plan paid $173 with the payee's name: the curve carries −$173 once, never −$323", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    await row("2026-04-20", "-150", "CITY WATER UTIL");
    await row("2026-05-12", "-173", "CITY WATER UTIL");

    const sig = await signal();

    expect(sig.bankToday).toBe("827.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("827.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ difference: "23.00", dayDelta: -8, offCurve: true });
  });

  it("'Not this' puts the plan back on the curve and the pair never returns", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    await row("2026-04-20", "-150", "CITY WATER UTIL");
    const txn = await row("2026-05-12", "-150", "CITY WATER UTIL");
    await resolve("not_match", water, "2026-05-20", { txnId: txn });

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("700.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toBeUndefined();
  });

  it("a partial confirmation leaves the unpaid remainder scheduled: $500 plan, $250 paid", async () => {
    await snapshotOnChase();
    const rent = await plan("Oak Street Rent", "500");
    const txn = await row("2026-05-12", "-250", "OAK STREET PROPERTIES");
    await resolve("partial", rent, "2026-05-20", { txnId: txn });

    const sig = await signal();

    expect(sig.bankToday).toBe("750.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("500.00");
    expect(matchFor(sig, `${rent}|2026-05-20`)).toBeUndefined();
  });

  it("(PR5 review) a partial on a rescheduled plan keeps the remainder on the new date", async () => {
    await snapshotOnChase();
    const rent = await plan("Oak Street Rent", "500", 5);
    const txn = await row("2026-05-12", "-250", "OAK STREET PROPERTIES");
    await resolve("rescheduled", rent, "2026-05-05", { rescheduledTo: "2026-05-20" });
    await resolve("partial", rent, "2026-05-05", { txnId: txn });

    const sig = await signal();

    expect(sig.bankToday).toBe("750.00");
    expect(balanceOn(sig, "2026-05-19")).toBe("750.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("500.00");
  });

  it("two −$50 rows do not pay a −$100 plan: the plan stays and nothing counts twice", async () => {
    await snapshotOnChase();
    const util = await plan("Utility", "100");
    await row("2026-05-12", "-50", "UTILITY CO");
    await row("2026-05-13", "-50", "UTILITY CO");

    const sig = await signal();

    expect(sig.bankToday).toBe("900.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("800.00");
    expect(matchFor(sig, `${util}|2026-05-20`)).toBeUndefined();
  });

  it("a row already matched to another plan is not a candidate", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    const other = await plan("Garden Service", "150");
    const txn = await row("2026-05-12", "-150", "CITY WATER UTIL");
    await resolve("matched", other, "2026-05-20", { txnId: txn });

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("700.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toBeUndefined();
  });

  it("a pending row its posted row replaced is not a separate candidate: the posted row is the match", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    await row("2026-04-20", "-150", "CITY WATER UTIL");
    await row("2026-05-10", "-150", "CITY WATER UTIL", { pending: true });
    const posted = await row("2026-05-11", "-150", "CITY WATER UTIL");

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("850.00");
    expect(matchFor(sig, `${water}|2026-05-20`)?.txnId).toBe(posted);
  });
});

describe("(PR5 review) an unconfirmed guess never overstates projected cash", () => {
  it("$1,500 rent and an unrelated $1,500 Zelle with no name: a suggestion only, the rent still counts", async () => {
    await snapshotOnChase();
    const rent = await plan("Oak Street Rent", "1500", 15);
    await row("2026-05-13", "-1500", "ZELLE TO J SMITH");

    const sig = await signal();

    expect(sig.bankToday).toBe("-500.00");
    expect(balanceOn(sig, "2026-05-15")).toBe("-2000.00");
    expect(matchFor(sig, `${rent}|2026-05-15`)).toMatchObject({ confidence: "low", offCurve: false });
  });

  it("a $15.49 subscription and a $15.00 lunch: the subscription still counts", async () => {
    await snapshotOnChase();
    await plan("Netflix", "15.49", 15);
    await row("2026-05-13", "-15", "CHIPOTLE 2231");

    const sig = await signal();

    expect(sig.bankToday).toBe("985.00");
    expect(balanceOn(sig, "2026-05-15")).toBe("969.51");
  });

  it("'rent' inside 'PARENTS' is not the payee's name: no match, the rent still counts", async () => {
    await snapshotOnChase();
    const rent = await plan("Rent", "1500");
    await row("2026-05-12", "-1200", "ZELLE TO PARENTS");

    const sig = await signal();

    expect(sig.bankToday).toBe("-200.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("-1700.00");
    expect(matchFor(sig, `${rent}|2026-05-20`)).toBeUndefined();
  });

  it("a logged Avalanche payment plus its bank debit do not take two different card minimums off the curve", async () => {
    await snapshotOnChase();
    await plan("Chase Freedom minimum", "50");
    await plan("Chase Sapphire minimum", "40");
    await row("2026-05-12", "-50", "Payment — Chase Freedom", { manual: true });
    await row("2026-05-13", "-50", "CHASE CREDIT CRD AUTOPAY");

    const sig = await signal();

    expect(sig.bankToday).toBe("900.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("810.00");
    expect(sig.matches?.filter((m) => m.planDate === "2026-05-20").every((m) => !m.offCurve)).toBe(true);
  });

  it("(PR5 second review) 'VERIZON FIOS' −130 never takes the 'Verizon Wireless' $120 plan off the curve", async () => {
    await snapshotOnChase();
    const vzw = await plan("Verizon Wireless", "120");
    await row("2026-04-20", "-120", "VERIZON WIRELESS PAYMENTS");
    await row("2026-05-12", "-130", "VERIZON FIOS");

    const sig = await signal();

    expect(sig.bankToday).toBe("870.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("750.00");
    expect(matchFor(sig, `${vzw}|2026-05-20`)).toMatchObject({ confidence: "medium", offCurve: false });
  });

  it("(PR5 second review) a nameless pair never marks last month paid: April 'paid' by HOME DEPOT, its late payment can't take May off", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    await row("2026-04-21", "-150", "HOME DEPOT 4411");
    await row("2026-05-11", "-150", "CITY WATER UTIL");

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("700.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ offCurve: false });
  });

  it("last month's bill paid late never takes this month's bill off the curve", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    await row("2026-05-11", "-150", "CITY WATER UTIL"); // pays April 20, 21 days late

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("700.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ offCurve: false });
  });
});
