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
  debtsTable,
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
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
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

async function snapshotOnChase(balance = "1000"): Promise<void> {
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
    bankSnapshotBalance: balance,
    bankSnapshotAt: new Date("2026-05-01T15:00:00Z"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
  });
}

async function plan(name: string, amount: string, day = 20, opts: { categoryId?: string } = {}): Promise<string> {
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
      categoryId: opts.categoryId ?? null,
    })
    .returning();
  return r!.id;
}

async function row(
  occurredOn: string,
  amount: string,
  description: string,
  opts: { pending?: boolean; manual?: boolean; categoryId?: string } = {},
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
      categoryId: opts.categoryId ?? null,
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
      // (Decision 13) The bill's full name, unique in the household: tier 2.
      tier: 2,
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
    // (Decision 13) Still holds: the full name is unique in the household, so tier 2.
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ difference: "23.00", dayDelta: -8, tier: 2, offCurve: true });
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
    expect(matchFor(sig, `${rent}|2026-05-15`)).toMatchObject({ confidence: "low", tier: 3, offCurve: false });
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
    const freedomBill = await plan("Chase Freedom minimum", "50");
    await plan("Chase Sapphire minimum", "40");
    // What `POST /debts/:id/payments` writes: a manual row tagged to the debt.
    // (Decision 13) Such a logged payment is never evidence; an untagged manual
    // checking row is cash and would be. The bill is linked to the debt, so the
    // debt adds no second minimum of its own.
    const [freedom] = await db
      .insert(debtsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Chase Freedom", type: "credit_card", balance: "900", minPayment: "50", dueDay: 20, status: "active" })
      .returning({ id: debtsTable.id });
    await db.update(recurringItemsTable).set({ debtId: freedom!.id }).where(eq(recurringItemsTable.id, freedomBill));
    const logged = await row("2026-05-12", "-50", "Payment — Chase Freedom", { manual: true });
    await db.update(transactionsTable).set({ debtId: freedom!.id }).where(eq(transactionsTable.id, logged));
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

  // ⭐ (Round 3, HIGH) REVERTS 46262e80's "(decision 13, fix 3)" case: the second
  // review of round 2 measured OVERSTATEMENT here. April's water is genuinely
  // unpaid; the nameless HOME DEPOT row proves nothing about it. Treating "any
  // non-ambiguous pair of ANY tier" as evidence let a nameless coincidence clear
  // April, so "CITY WATER" on 05-11 (April paid late) was free to pair with May
  // instead and take it fully off the curve — a bill counted paid that wasn't.
  // (round 3) An earlier occurrence now counts as paid for the hold-back only when
  // its own pair is tier 1/2, or named and not ambiguous (`confidence !== "low"`).
  // HOME DEPOT is nameless (`confidence: "low"`), so April stays unpaid, May's
  // pairing is held back, and May keeps dragging (back to the PR5-second-review
  // figure, 700.00 — the July/August Toyota case below is why "any tier" was tried
  // and is now proven wrong instead: a NAMED late pair is what should rescue it).
  it("(round 3) a nameless earlier pair never marks last month paid: April 'paid' by HOME DEPOT, its late payment can't take May off (700, not 850)", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    await row("2026-04-21", "-150", "HOME DEPOT 4411");
    await row("2026-05-11", "-150", "CITY WATER UTIL");

    const sig = await signal();

    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("700.00");
    expect(matchFor(sig, `${water}|2026-04-20`)).toMatchObject({ confidence: "low", ambiguous: false, tier: 3, offCurve: false });
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ tier: 3, offCurve: false });
  });

  // (Round 3, HIGH — the review's own repro) Same mechanism, worked at the review's
  // numbers: balance 3,150.00, "CITY WATER" on 05-12 (not 05-11). Today 05-14, May
  // due 05-20. The 05-12 row is conceptually April paid late, so the correct 05-20
  // balance is 2,850.00 (bankToday 3,000.00, May still drags −150.00); the round-2
  // bug gave 3,000.00 (May wrongly taken off the curve entirely).
  it("(round 3) the review's repro: April 'paid' by HOME DEPOT, May still drags (2,850, not 3,000)", async () => {
    await snapshotOnChase("3150");
    const water = await plan("City Water", "150");
    await row("2026-04-21", "-150", "HOME DEPOT 4411");
    await row("2026-05-12", "-150", "CITY WATER");

    const sig = await signal();

    expect(sig.bankToday).toBe("3000.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("2850.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ tier: 3, offCurve: false });
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

  // ⭐ (Round 3, LOW) An overdue tier-2 pair that PAID LESS than the plan (offCurve
  // stays false — decision 13) must expose how much is still assumed unpaid, so a
  // caller reading only `offCurve` never mistakes it for "still due in full": the
  // web used to show "Still in forecast" and offer Move, which would have re-added
  // the FULL plan while the server counts only the remainder.
  it("(round 3, LOW) an overdue underpayment inside the bill's own category exposes remainderAmount, signed like the plan; overdueAssumedPaid agrees", async () => {
    await snapshotOnChase();
    const CAT = randomUUID();
    // Named (shares "figure lending" with the row) so it is a candidate at all;
    // graded on its own category (sole in it), which tolerates the $15 gap.
    const figure = await plan("Figure Lending", "95", 10, { categoryId: CAT });
    const under = await row("2026-05-10", "-80", "FIGURE LENDING SVC", { categoryId: CAT });

    const sig = await signal();

    const m = matchFor(sig, `${figure}|2026-05-10`);
    expect(m).toMatchObject({ txnId: under, tier: 2, offCurve: false, remainderAmount: "-15.00" });
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${figure}|2026-05-10`)).toMatchObject({
      txnId: under,
      unpaidRemainder: "-15.00",
    });
  });

  it("(round 3, LOW) paid in full overdue: remainderAmount is '0.00', not absent", async () => {
    await snapshotOnChase();
    const CAT = randomUUID();
    const figure = await plan("Figure Lending", "95", 10, { categoryId: CAT });
    const paidFull = await row("2026-05-10", "-95", "FIGURE LENDING SVC", { categoryId: CAT });

    const sig = await signal();

    expect(matchFor(sig, `${figure}|2026-05-10`)).toMatchObject({ txnId: paidFull, tier: 2, remainderAmount: "0.00" });
  });
});
