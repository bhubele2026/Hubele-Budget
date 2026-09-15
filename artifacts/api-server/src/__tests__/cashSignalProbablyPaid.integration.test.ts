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
  // (round 3) An earlier occurrence counted as paid for the hold-back only when
  // its own pair was tier 1/2, or named and not ambiguous (`confidence !== "low"`).
  // (PR-B2, owner decision 2026-09-15) Only tier 1/2 counts now; the named branch
  // is gone (see the meter-fee case below). HOME DEPOT is nameless and tier 3, so
  // this case reads the same under both rules: April stays unpaid, May's pairing
  // is held back, and May keeps dragging (the PR5-second-review figure, 700.00).
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

  // ⭐ (Round 4, DECIDED — candidate C) Residual 5 from round 3: a tier ≤ 2
  // pair on a FUTURE plan that underpays used to keep the FULL plan dragging
  // until the user recorded Partial — on top of the row already having left
  // the bank, understating projected cash by the paid part. The remainder-
  // only drag (previously overdue-only) now also applies before the due
  // date: the plan leaves the curve, only the unpaid remainder drags, dated
  // on the plan's OWN date (never dragged to a business day like the overdue
  // sibling). Only rules (a) category and (d) confirmed descriptor in range
  // reach this — the name rules (b)/(c)/(c′) already require paying at least
  // plan − max($1, 1%), so they never produce an underpaid tier-2 pair.
  describe("(round 4, decided C) the remainder-only drag also applies before the due date", () => {
    it("Verizon $430 due 05-16 (future), confirmed 425–434 across two months, paid $425 two days early: only the $5 remainder drags", async () => {
      await snapshotOnChase();
      const verizon = await plan("Verizon Wireless", "430", 16);
      // Two confirmed months spanning the 425–434 range (round 3, MEDIUM 1):
      // resolving them as `matched` also removes them from the earlier-
      // occurrence hold-back (round 3, HIGH) — they're accounted for.
      const jan = await row("2026-01-16", "-425.00", "VERIZON WIRELESS PAYMENTS");
      await resolve("matched", verizon, "2026-01-16", { txnId: jan });
      const apr = await row("2026-04-16", "-434.00", "VERIZON WIRELESS PAYMENTS");
      await resolve("matched", verizon, "2026-04-16", { txnId: apr });
      // Paid $5 short of $430, two days before the 05-16 due date.
      const may = await row("2026-05-14", "-425.00", "VERIZON WIRELESS PAYMENTS");

      const sig = await signal();

      // Only the row's $425 leaves the bank; the plan's remainder is off the
      // curve for its own $425, and drags only the $5 still assumed unpaid.
      expect(sig.bankToday).toBe("575.00");
      expect(matchFor(sig, `${verizon}|2026-05-16`)).toMatchObject({
        txnId: may,
        tier: 2,
        offCurve: false,
        remainderAmount: "-5.00",
      });
      expect((sig.events ?? []).find((e) => e.label === "Verizon Wireless")).toMatchObject({
        date: "2026-05-16",
        amount: "-5.00",
        assumption: "remainder_assumed_unpaid",
      });
      // 575.00 − 5.00 (was 575.00 − 430.00 = 145.00 before this fix).
      expect(balanceOn(sig, "2026-05-16")).toBe("570.00");
      // The spine reads its low point and max safe extra off the same daily
      // series — a short horizon so June's Verizon (unpaid, drags in full)
      // doesn't also enter the window and mask the remainder's own effect.
      const short = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 3 });
      expect(short.lowestProjected).toBe("570.00");
      expect(short.maxSafeExtra).toBe("570.00");
    });

    it("State Farm Insurance $180, sole in its category, paid $165 before the due date: only the $15 remainder drags", async () => {
      await snapshotOnChase();
      const CAT = randomUUID();
      const sfIns = await plan("State Farm Insurance", "180", 20, { categoryId: CAT });
      // April's occurrence is already handled, so it never triggers the
      // earlier-occurrence hold-back for May's pairing.
      const aprilRow = await row("2026-04-20", "-180.00", "STATE FARM RO 27 SFPP", { categoryId: CAT });
      await resolve("matched", sfIns, "2026-04-20", { txnId: aprilRow });
      // Paid $15 short of $180, eight days before the 05-20 due date.
      const paidRow = await row("2026-05-12", "-165.00", "STATE FARM RO 27 SFPP", { categoryId: CAT });

      const sig = await signal();

      expect(matchFor(sig, `${sfIns}|2026-05-20`)).toMatchObject({
        txnId: paidRow,
        tier: 2,
        offCurve: false,
        remainderAmount: "-15.00",
      });
      expect((sig.events ?? []).find((e) => e.label === "State Farm Insurance")).toMatchObject({
        date: "2026-05-20",
        amount: "-15.00",
        assumption: "remainder_assumed_unpaid",
      });
      // 1000.00 − 165.00 (the row, dated after the snapshot) − 15.00 (the
      // remainder) = 820.00 (was 1000 − 165 − 180 = 655.00 before this fix).
      expect(sig.bankToday).toBe("835.00");
      expect(balanceOn(sig, "2026-05-20")).toBe("820.00");
    });
  });

  // ⭐ (PR-B2, owner decision 2026-09-15) THE HOLD-BACK NEEDS PROOF. An earlier
  // occurrence counts as paid for the hold-back only on tier-1/2 evidence; the
  // "named and not ambiguous" branch is gone. REPLACES round 4's residual pin,
  // which asserted the bug: May off the curve at 850.00, reading HIGH by $150.
  // An unrelated "CITY WATER METER FEE" −140, five days before April's due date,
  // is named ("water") and not ambiguous, but it is tier 3 ($10 short): a
  // suggestion, not proof April was paid. So April stays unpaid for the
  // hold-back. April's real $150 posts late on 05-12 — 22 days after April's due
  // date, outside April's pairing window, so it can only pair with May — and that
  // pair is held back: the row is read as April's late payment (it left the bank
  // once), and May stays on the curve until the owner answers in Review.
  it("(PR-B2) a coincidental same-payee named charge no longer clears April: the late $150 is April's, May stays on the curve (700, not 850)", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    const fee = await row("2026-04-15", "-140", "CITY WATER METER FEE");
    const late = await row("2026-05-12", "-150", "CITY WATER");

    const sig = await signal();

    // April: the fee is still offered as a suggestion (the close call to confirm or reject).
    expect(matchFor(sig, `${water}|2026-04-20`)).toMatchObject({
      txnId: fee,
      confidence: "medium",
      ambiguous: false,
      tier: 3,
      offCurve: false,
    });
    // April stays unpaid: listed overdue, never assumed paid.
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${water}|2026-04-20`)).toBeUndefined();
    expect(sig.overdueOutsideForecast?.find((p) => p.planKey === `${water}|2026-04-20`)).toBeDefined();
    // May: the late row's pair is held back for April — a suggestion, not proof.
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ txnId: late, tier: 3, offCurve: false });
    // The late $150 left the bank once; May's own $150 still drags.
    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("700.00");
  });

  // (PR-B2, unchanged) A TIER-2 earlier pair is still proof, with or without a
  // name. The same meter fee posts, but April is paid on its due date by a
  // nameless autopay row in the bill's own category (the only bill in it: tier 2,
  // rule a). April pairs with that row — a pair that proves ranks ahead of the
  // fee, which is left unpaired — so April is paid, and May's own exact payment
  // takes May off the curve.
  it("(PR-B2, unchanged) a tier-2 earlier pair still frees the later row: April paid by a nameless autopay in its own category beside the meter fee, May's payment clears May (850)", async () => {
    await snapshotOnChase();
    const CAT = randomUUID();
    const water = await plan("City Water", "150", 20, { categoryId: CAT });
    await row("2026-04-15", "-140", "CITY WATER METER FEE");
    const april = await row("2026-04-20", "-150", "ACH AUTOPAY 0420", { categoryId: CAT });
    const may = await row("2026-05-12", "-150", "CITY WATER");

    const sig = await signal();

    expect(matchFor(sig, `${water}|2026-04-20`)).toMatchObject({ txnId: april, confidence: "low", tier: 2, offCurve: true });
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ txnId: may, tier: 2, offCurve: true });
    expect(sig.bankToday).toBe("850.00");
    expect(balanceOn(sig, "2026-05-20")).toBe("850.00");
  });
});

/** An "Acme Payroll" paycheck (income). A monthly one lands on its anchor's day of the month. */
async function paycheck(frequency: "monthly" | "biweekly", anchorDate: string, amount = "2000"): Promise<string> {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Acme Payroll",
      kind: "income",
      amount,
      frequency,
      dayOfMonth: frequency === "monthly" ? Number(anchorDate.slice(8, 10)) : null,
      anchorDate,
      active: "true",
    })
    .returning();
  return r!.id;
}

// ⭐ (PR-B2 round 2) OUTFLOWS NEED PROOF; INCOME KEEPS ITS ARRIVAL RULE. The owner's
// principle is "the forecast may read low, never high". For a bill, holding a later
// row back keeps the bill on the curve, which can only read low. For income it runs
// the other way: a held-back paycheck stays on the curve while its deposit is
// already in cash, so the paycheck counts twice. So the tier ≤ 2 requirement applies
// to outflows only; an earlier INCOME occurrence counts as received for the hold-back
// on the rule main `2731077` used (tier ≤ 2, or named and not ambiguous), which agrees
// with the income-arrival rule for a named deposit.
describe("(PR-B2 round 2) the hold-back reads income by its arrival rule, so a paycheck is never counted twice", () => {
  it("(round 2) April's $2,000 paycheck arrived $100 short (named, tier 3): May's exact deposit a day early counts once (05-15: 3,000, not 5,000)", async () => {
    await snapshotOnChase();
    const pay = await paycheck("monthly", "2026-01-15");
    const april = await row("2026-04-15", "1900", "ACME PAYROLL");
    const may = await row("2026-05-14", "2000", "ACME PAYROLL");

    const sig = await signal();

    expect(matchFor(sig, `${pay}|2026-04-15`)).toMatchObject({ txnId: april, confidence: "medium", ambiguous: false, tier: 3 });
    // The arrival rule counts April received, and the hold-back agrees.
    expect(sig.incomeNotArrived?.find((p) => p.planKey === `${pay}|2026-04-15`)).toBeUndefined();
    expect(matchFor(sig, `${pay}|2026-05-15`)).toMatchObject({ txnId: may, tier: 2, offCurve: true });
    expect(sig.bankToday).toBe("3000.00");
    // May's paycheck counts once: in cash, off the curve (round 1 read 5,000.00 — counted twice).
    expect(balanceOn(sig, "2026-05-15")).toBe("3000.00");
  });

  // ⚠️ KNOWN ISSUE — pre-existing on main `2731077`, NOT fixed in PR-B2; for PR9 (income
  // states). This test pins TODAY'S WRONG VALUE so the repro stays checked; PR9 should
  // flip it to 3,000.00.
  // A BIWEEKLY paycheck deposited early counts twice when the previous paycheck arrived
  // off-amount. Mechanism, in `matchPlansToRows` (planMatch.ts), not in the hold-back:
  //   - the 05-14 deposit is 13 days after the 05-01 occurrence, inside its +14-day
  //     window, so it is a candidate for BOTH 05-01 and 05-15; it pairs with 05-15
  //     (the better score);
  //   - 05-01 then pairs with its own $1,900 deposit, which cannot be tier 2 ($100
  //     short), so it ranks below the 05-14 candidate — and a pair is marked
  //     `ambiguous` whenever a same-or-better-ranked candidate for its plan scores
  //     better, even though that candidate's row already went to 05-15;
  //   - ambiguous means not arrived (`incomeNotArrived` lists 05-01) and not received
  //     for the hold-back, so 05-15's pair is held back: +$2,000 stays on the curve
  //     while the deposit is already in cash.
  it("(KNOWN ISSUE, PR9) biweekly: 05-01 arrived $100 short, 05-15 deposited a day early — pinned at today's value, counted twice (05-15: 5,000.00; right answer 3,000.00)", async () => {
    await snapshotOnChase();
    const pay = await paycheck("biweekly", "2026-04-17");
    await row("2026-04-17", "2000", "ACME PAYROLL");
    const short = await row("2026-05-01", "1900", "ACME PAYROLL");
    const early = await row("2026-05-14", "2000", "ACME PAYROLL");

    const sig = await signal();

    expect(matchFor(sig, `${pay}|2026-05-01`)).toMatchObject({ txnId: short, confidence: "medium", ambiguous: true, tier: 3 });
    expect(sig.incomeNotArrived?.find((p) => p.planKey === `${pay}|2026-05-01`)).toBeDefined();
    expect(matchFor(sig, `${pay}|2026-05-15`)).toMatchObject({ txnId: early, tier: 3, offCurve: false });
    expect(sig.bankToday).toBe("3000.00");
    expect(balanceOn(sig, "2026-05-15")).toBe("5000.00");
  });

  it("(control for the known issue) the same biweekly household with 05-01 paid exactly: no pair is ambiguous, and 05-15 counts once (3,000.00)", async () => {
    await snapshotOnChase();
    const pay = await paycheck("biweekly", "2026-04-17");
    await row("2026-04-17", "2000", "ACME PAYROLL");
    const exact = await row("2026-05-01", "2000", "ACME PAYROLL");
    const early = await row("2026-05-14", "2000", "ACME PAYROLL");

    const sig = await signal();

    expect(matchFor(sig, `${pay}|2026-05-01`)).toMatchObject({ txnId: exact, ambiguous: false, tier: 2 });
    expect(sig.incomeNotArrived?.find((p) => p.planKey === `${pay}|2026-05-01`)).toBeUndefined();
    expect(matchFor(sig, `${pay}|2026-05-15`)).toMatchObject({ txnId: early, tier: 2, offCurve: true });
    expect(balanceOn(sig, "2026-05-15")).toBe("3000.00");
  });

  // ⚠️ KNOWN ISSUE — pre-existing on main `2731077`, NOT fixed in PR-B2 (open for the lead).
  // Round 2 gives income main's hold-back rule back, and that rule leaves out a NAMELESS
  // earlier deposit (`confidence: "low"`). The income-arrival rule (`isEvidence`: not
  // ambiguous, any confidence) counts April received; the hold-back does not, so May's
  // early deposit is held back and May's paycheck counts twice. Pins today's wrong value.
  it("(KNOWN ISSUE, open) April's $2,000 paycheck arrived exactly but nameless ('DIRECT DEP 7781'), May deposited a day early by name — counted twice (05-15: 5,000.00; right answer 3,000.00)", async () => {
    await snapshotOnChase();
    const pay = await paycheck("monthly", "2026-01-15");
    const april = await row("2026-04-15", "2000", "DIRECT DEP 7781");
    const may = await row("2026-05-14", "2000", "ACME PAYROLL");

    const sig = await signal();

    expect(matchFor(sig, `${pay}|2026-04-15`)).toMatchObject({ txnId: april, confidence: "low", ambiguous: false, tier: 3 });
    // Arrived, by the arrival rule…
    expect(sig.incomeNotArrived?.find((p) => p.planKey === `${pay}|2026-04-15`)).toBeUndefined();
    // …but not received for the hold-back.
    expect(matchFor(sig, `${pay}|2026-05-15`)).toMatchObject({ txnId: may, tier: 3, offCurve: false });
    expect(sig.bankToday).toBe("3000.00");
    expect(balanceOn(sig, "2026-05-15")).toBe("5000.00");
  });
});
