// ⭐ PR8r — THE EVERYDAY RESERVE HOOKS (plan section A; owner decisions 7 and 12).
//
// The worked numbers from the plan, through the real ledger (`computeCashSignal`
// with `views: true`, the shape `/forecast/cash-signal` answers with):
//
//   Today Fri 9/11; the week runs Sun 9/6 – Sat 9/12; Chase holds $2,000; the
//   Allowances weekly plan is $450; the Weekly Spend bill is linked as the
//   weekly payoff hook.
//
//   (i)   $120 of Amex groceries            → remaining 330, payoff 450 on 9/12, end of 9/12 1,550
//   (ii)  + a $40 checking purchase         → cash 1,960, remaining 290, payoff 410, end of 9/12 1,550
//   (iii) + a $60 unplanned Amex charge     → payoff 470; unplanned 60
//   (iv)  a $120 bill paid $145, flagged weekly → bill resolved, $25 overage, weekly spend unchanged
//   (vi)  a $40 pending posts at $48        → spending 48, never 88
//   the −$120 Amex payment posts next week → cash 1,880 once, and the payoff leaves the curve
//
// Synthetic household, synthetic merchants. Nothing here is production data.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

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
import { computeCashSignal } from "../lib/cashSignal";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const TEST_USER = `pr8r-everyday-${RUN}`;
let HH: string;

const CHASE = `pr8r-chase-${RUN}`;
const PLATINUM = `pr8r-amex-plat-${RUN}`;
const BLUE = `pr8r-amex-blue-${RUN}`;

/** Chicago wall clock (CDT, −05:00 in September). */
const at = (isoLocal: string): Date => new Date(`${isoLocal}-05:00`);
const FRI_0911 = at("2026-09-11T12:00:00");

let WEEKLY_ID: string;
let MONTHLY_ID: string;
let GROCERIES: string;
let HOME: string;

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
afterAll(cleanup);
afterEach(() => {
  vi.useRealTimers();
});

type Hooks = { weekly?: boolean; monthly?: boolean };

/**
 * The household: Chase checking (snapshot $2,000 read Thu 9/10 20:00), Amex
 * Platinum (weekly) and Blue (monthly), Weekly Spend $450 on Saturdays and
 * Monthly Spend $400 on the 1st, Allowances weekly $450 / monthly $400.
 */
async function household(opts: {
  now?: Date;
  hooks?: Hooks;
  weeklyAllowance?: string;
  weeklyBill?: string;
  snapshot?: { balance: string; at: Date };
} = {}): Promise<void> {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(opts.now ?? FRI_0911);
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
      { userId: TEST_USER, householdId: HH, itemId: chaseItem!.id, accountId: CHASE, name: "Checking", mask: "4401", type: "depository", subtype: "checking" },
      { userId: TEST_USER, householdId: HH, itemId: amexItem!.id, accountId: PLATINUM, name: "Platinum Card", mask: "4402", type: "credit", subtype: "credit card" },
      { userId: TEST_USER, householdId: HH, itemId: amexItem!.id, accountId: BLUE, name: "Blue Cash Everyday", mask: "4403", type: "credit", subtype: "credit card" },
    ])
    .returning();
  const snap = opts.snapshot ?? { balance: "2000.00", at: at("2026-09-10T20:00:00") };
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: HH,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: snap.balance,
    bankSnapshotAt: snap.at,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: accounts.find((a) => a.accountId === CHASE)!.id,
    bankSnapshotMask: "4401",
  });

  const cats = await db
    .insert(budgetCategoriesTable)
    .values([
      { userId: TEST_USER, householdId: HH, name: "Groceries", kind: "expense" },
      { userId: TEST_USER, householdId: HH, name: "Home", kind: "expense" },
    ])
    .returning();
  GROCERIES = cats[0]!.id;
  HOME = cats[1]!.id;

  const bills = await db
    .insert(recurringItemsTable)
    .values([
      // Anchored so neither bill has an occurrence before today on its own (an
      // unlinked Monthly Spend on 9/1 would drag onto the curve like any overdue bill).
      { userId: TEST_USER, householdId: HH, name: "Weekly Spend", kind: "bill", amount: opts.weeklyBill ?? "450", frequency: "weekly", anchorDate: "2026-09-12", active: "true" },
      { userId: TEST_USER, householdId: HH, name: "Monthly Spend", kind: "bill", amount: "400", frequency: "monthly", dayOfMonth: 1, anchorDate: "2026-10-01", active: "true" },
    ])
    .returning();
  WEEKLY_ID = bills[0]!.id;
  MONTHLY_ID = bills[1]!.id;

  const hooks = opts.hooks ?? { weekly: true };
  await db.insert(settingsTable).values({
    userId: TEST_USER,
    householdId: HH,
    weeklyAllowanceAmount: opts.weeklyAllowance ?? "450.00",
    monthlyAllowanceAmount: "400.00",
    preferences: {
      everydayHooks: {
        weeklyItemId: hooks.weekly ? WEEKLY_ID : null,
        monthlyItemId: hooks.monthly ? MONTHLY_ID : null,
      },
    },
  });
}

type RowOpts = Partial<typeof transactionsTable.$inferInsert>;

async function row(values: RowOpts & { occurredOn: string; amount: string; description: string }): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: HH,
      createdAt: createdAtStartOfHouseholdDay(values.occurredOn),
      ...values,
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

const amexCharge = (card: string, occurredOn: string, amount: string, extra: RowOpts = {}) =>
  row({ occurredOn, amount, description: "GREEN GROCER 118", plaidAccountId: card, source: "plaid:amex", categoryId: GROCERIES, ...extra });

const chaseRow = (occurredOn: string, amount: string, description: string, extra: RowOpts = {}) =>
  row({ occurredOn, amount, description, plaidAccountId: CHASE, source: "plaid:chase", ...extra });

type Sig = Awaited<ReturnType<typeof computeCashSignal>> & {
  daily?: Array<{ date: string; balance: string; scheduled?: string; expected?: string; conservative?: string }>;
  everyday?: {
    weekly: Record<string, unknown>;
    monthly: Record<string, unknown>;
    billMatched: Array<Record<string, unknown>>;
  };
};

async function signal(horizonDays = 7): Promise<Sig> {
  return (await computeCashSignal(HH, TEST_USER, { horizonDays, views: true } as never)) as Sig;
}

const dayOf = (sig: Sig, iso: string) => sig.daily!.find((d) => d.date === iso)!;
const payoffEvents = (sig: Sig, itemId: string) => (sig.events ?? []).filter((e) => e.itemId === itemId);

describe("PR8r worked numbers — Fri 9/11, week 9/6–9/12, Chase $2,000, plan $450, weekly hook linked", () => {
  it("(i) $120 of Amex groceries: remaining 330, payoff 450 on 9/12, end of 9/12 1,550", async () => {
    await household();
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const sig = await signal();
    expect(sig.bankToday).toBe("2000.00");
    expect(sig.everyday!.weekly).toMatchObject({ status: "linked", plan: "450.00", spent: "120.00", remaining: "330.00", owed: "120.00", payoff: "450.00" });
    expect(payoffEvents(sig, WEEKLY_ID)).toEqual([
      expect.objectContaining({ date: "2026-09-12", amount: "-450.00", assumption: null, occurrenceKey: `${WEEKLY_ID}|2026-09-12` }),
    ]);
    expect(dayOf(sig, "2026-09-11")).toMatchObject({ balance: "2000.00", expected: "2000.00" });
    expect(dayOf(sig, "2026-09-12")).toMatchObject({ balance: "1550.00", expected: "1550.00" });
  });

  it("(ii) + a $40 checking purchase: cash 1,960, remaining 290, payoff 410, end of 9/12 still 1,550", async () => {
    await household();
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    await chaseRow("2026-09-11", "-40.00", "CORNER MARKET 22", { weeklyAllowance: true, categoryId: GROCERIES });
    const sig = await signal();
    expect(sig.bankToday).toBe("1960.00");
    expect(sig.everyday!.weekly).toMatchObject({ spent: "160.00", remaining: "290.00", owed: "120.00", payoff: "410.00" });
    expect(payoffEvents(sig, WEEKLY_ID).map((e) => [e.date, e.amount])).toEqual([["2026-09-12", "-410.00"]]);
    expect(dayOf(sig, "2026-09-11").balance).toBe("1960.00");
    expect(dayOf(sig, "2026-09-12").balance).toBe("1550.00");
  });

  it("(iii) + a $60 unplanned Amex charge: payoff 470, unplanned 60, remaining still 290", async () => {
    await household();
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    await chaseRow("2026-09-11", "-40.00", "CORNER MARKET 22", { weeklyAllowance: true, categoryId: GROCERIES });
    await amexCharge(PLATINUM, "2026-09-10", "-60.00", { unplannedAllowance: true, description: "HARDWARE BARN", categoryId: HOME });
    const sig = await signal();
    expect(sig.everyday!.weekly).toMatchObject({ remaining: "290.00", unplanned: "60.00", owed: "180.00", payoff: "470.00" });
    expect(dayOf(sig, "2026-09-12").balance).toBe("1490.00");
  });

  it("the week's plan is that week's override: $300 makes remaining 180 and the payoff 300; next week is back to 450", async () => {
    await household();
    await db
      .update(settingsTable)
      .set({
        preferences: {
          everydayHooks: { weeklyItemId: WEEKLY_ID, monthlyItemId: null },
          weeklyAllowanceOverrides: { "2026-09-06": "300.00" },
        },
      })
      .where(eq(settingsTable.userId, TEST_USER));
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const sig = await signal(8);
    // The override is this week's plan; the discrepancy flag compares the standing amount.
    expect(sig.everyday!.weekly).toMatchObject({ plan: "300.00", allowanceAmount: "450.00", discrepancy: false, spent: "120.00", remaining: "180.00", payoff: "300.00" });
    expect(payoffEvents(sig, WEEKLY_ID).map((e) => [e.occurrenceDate, e.amount])).toEqual([
      ["2026-09-12", "-300.00"],
      ["2026-09-19", "-450.00"],
    ]);
  });

  it("remaining 330 / 290 / 290 and payoffs 450 / 410 / 470, step by step on one household", async () => {
    await household();
    const seen: Array<[unknown, unknown]> = [];
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    let sig = await signal();
    seen.push([sig.everyday!.weekly.remaining, sig.everyday!.weekly.payoff]);
    await chaseRow("2026-09-11", "-40.00", "CORNER MARKET 22", { weeklyAllowance: true, categoryId: GROCERIES });
    sig = await signal();
    seen.push([sig.everyday!.weekly.remaining, sig.everyday!.weekly.payoff]);
    await amexCharge(PLATINUM, "2026-09-10", "-60.00", { unplannedAllowance: true, description: "HARDWARE BARN", categoryId: HOME });
    sig = await signal();
    seen.push([sig.everyday!.weekly.remaining, sig.everyday!.weekly.payoff]);
    expect(seen).toEqual([
      ["330.00", "450.00"],
      ["290.00", "410.00"],
      ["290.00", "470.00"],
    ]);
  });

  it("(iv) a $120 bill paid $145, the row flagged weekly: bill resolved, $25 overage shown, weekly spend unchanged", async () => {
    await household();
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const before = await signal();
    const [water] = await db
      .insert(recurringItemsTable)
      .values({ userId: TEST_USER, householdId: HH, name: "City Water", kind: "bill", amount: "120", frequency: "monthly", dayOfMonth: 9, anchorDate: "2026-08-09", active: "true" })
      .returning();
    const paid = await chaseRow("2026-09-09", "-145.00", "CITY WATER UTIL 3310", { weeklyAllowance: true });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: HH,
      recurringItemId: water!.id,
      occurrenceDate: "2026-09-09",
      status: "matched",
      matchedTxnId: paid,
    });
    const sig = await signal();
    expect(sig.everyday!.weekly.spent).toBe(before.everyday!.weekly.spent);
    expect(sig.everyday!.weekly).toMatchObject({ spent: "120.00", remaining: "330.00", payoff: "450.00" });
    expect(sig.everyday!.billMatched).toEqual([
      expect.objectContaining({
        txnId: paid,
        planKey: `${water!.id}|2026-09-09`,
        planAmount: "-120.00",
        txnAmount: "-145.00",
        overage: "25.00",
        conflict: "flag_ignored_matched",
      }),
    ]);
    expect((sig.events ?? []).some((e) => e.itemId === water!.id)).toBe(false);
  });

  it("(vi) a $40 pending charge that posts at $48: spending 48, never 88", async () => {
    await household();
    await amexCharge(PLATINUM, "2026-09-08", "-40.00", {
      weeklyAllowance: true,
      pending: true,
      description: "FARM STAND 7",
      createdAt: at("2026-09-08T10:00:00"),
    });
    // Sync inserts the posted row bare; it inherits the pending row's filing.
    await amexCharge(PLATINUM, "2026-09-09", "-48.00", {
      description: "FARM STAND 7",
      createdAt: at("2026-09-09T10:00:00"),
    });
    const sig = await signal();
    expect(sig.everyday!.weekly).toMatchObject({ spent: "48.00", remaining: "402.00", owed: "48.00", payoff: "450.00" });
  });
});

describe("PR8r — the Amex payment and the closed week", () => {
  it("Mon 9/14, last week unpaid: the payoff is the owed charges only, next business day, amex_payoff_not_posted", async () => {
    await household({ now: at("2026-09-14T12:00:00") });
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const sig = await signal();
    const events = payoffEvents(sig, WEEKLY_ID);
    expect(events.filter((e) => e.occurrenceDate === "2026-09-12")).toEqual([
      expect.objectContaining({ date: "2026-09-15", amount: "-120.00", assumption: "amex_payoff_not_posted" }),
    ]);
    expect(events.filter((e) => e.occurrenceDate === "2026-09-19")).toEqual([
      expect.objectContaining({ date: "2026-09-19", amount: "-450.00", assumption: null }),
    ]);
  });

  it("Tue 9/15, the −$120 Amex payment posts and matches: cash 1,880 once, no payoff left for the week", async () => {
    await household({ now: at("2026-09-15T12:00:00") });
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const payment = await chaseRow("2026-09-15", "-120.00", "AMERICAN EXPRESS ACH PMT W4419");
    const sig = await signal();
    expect(sig.bankToday).toBe("1880.00");
    expect(payoffEvents(sig, WEEKLY_ID).filter((e) => e.occurrenceDate === "2026-09-12")).toEqual([]);
    // Nothing else on the curve before Saturday: cash drops once.
    expect(dayOf(sig, "2026-09-18").balance).toBe("1880.00");
    expect(dayOf(sig, "2026-09-19").balance).toBe("1430.00");
    expect(sig.everyday!.weekly).toMatchObject({ periodStart: "2026-09-13", payoff: "450.00" });
    expect(payment).toBeTruthy();
  });

  it("a Saturday: exactly one payoff for the week, moved to Monday (due today, not posted); next week's separately", async () => {
    await household({ now: at("2026-09-12T12:00:00"), snapshot: { balance: "2000.00", at: at("2026-09-12T09:00:00") } });
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    // Friday's checking purchase: the Saturday balance already holds it, and it shrinks the reserve.
    await chaseRow("2026-09-11", "-40.00", "CORNER MARKET 22", { weeklyAllowance: true, categoryId: GROCERIES });
    const sig = await signal();
    expect(payoffEvents(sig, WEEKLY_ID).map((e) => [e.occurrenceDate, e.date, e.amount, e.assumption])).toEqual([
      ["2026-09-12", "2026-09-14", "-410.00", "due_today_not_posted"],
      ["2026-09-19", "2026-09-19", "-450.00", null],
    ]);
    expect(sig.bankToday).toBe("2000.00");
    expect(dayOf(sig, "2026-09-12").balance).toBe("2000.00");
    expect(dayOf(sig, "2026-09-14").balance).toBe("1590.00");
  });

  it("a Sunday: exactly one payoff for the closed week (owed only), and next week's separately", async () => {
    await household({ now: at("2026-09-13T12:00:00"), snapshot: { balance: "2000.00", at: at("2026-09-13T09:00:00") } });
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const sig = await signal();
    const events = payoffEvents(sig, WEEKLY_ID);
    expect(events.map((e) => [e.occurrenceDate, e.date, e.amount, e.assumption])).toEqual([
      ["2026-09-12", "2026-09-14", "-120.00", "amex_payoff_not_posted"],
      ["2026-09-19", "2026-09-19", "-450.00", null],
    ]);
  });

  it("a Saturday snapshot that already holds the Amex payment never takes the payoff again on Sunday", async () => {
    await household({ now: at("2026-09-13T12:00:00"), snapshot: { balance: "1880.00", at: at("2026-09-12T15:00:00") } });
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    // Posted Saturday morning, before the balance was read: the snapshot holds it.
    await chaseRow("2026-09-12", "-120.00", "AMERICAN EXPRESS ACH PMT W4420", { createdAt: at("2026-09-12T09:00:00") });
    const sig = await signal();
    expect(sig.bankToday).toBe("1880.00");
    expect(payoffEvents(sig, WEEKLY_ID).filter((e) => e.occurrenceDate === "2026-09-12")).toEqual([]);
    expect(dayOf(sig, "2026-09-14").balance).toBe("1880.00");
  });
});

describe("PR8r — what PR-H deferred: the tier-2 pairs, and one payment paying once", () => {
  it("a tier-2 pair from the ledger's match tiers keeps an unflagged bill payment out of the weekly plan (and the payoff)", async () => {
    await household();
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    await db.insert(recurringItemsTable).values({
      userId: TEST_USER, householdId: HH, name: "City Water", kind: "bill", amount: "89.99", frequency: "monthly", dayOfMonth: 10, anchorDate: "2026-08-10", active: "true",
    });
    // No flag, no category: without the pair it would need classification and use up the plan.
    const paid = await chaseRow("2026-09-10", "-89.99", "CITY WATER UTIL");
    const sig = await signal();
    expect(sig.matches).toEqual([expect.objectContaining({ txnId: paid, tier: 2 })]);
    expect(sig.everyday!.weekly).toMatchObject({ spent: "120.00", needsClassification: "0.00", remaining: "330.00", payoff: "450.00" });
    expect(sig.everyday!.billMatched).toEqual([]);
  });

  it("an Amex payment that settles a payoff is claimed: it never also pays a bill (linked vs unlinked, same household)", async () => {
    await household({ now: at("2026-09-15T12:00:00"), hooks: {} });
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const [legacy] = await db
      .insert(recurringItemsTable)
      .values({ userId: TEST_USER, householdId: HH, name: "American Express", kind: "bill", amount: "120", frequency: "monthly", dayOfMonth: 15, anchorDate: "2026-08-15", active: "true" })
      .returning();
    const payment = await chaseRow("2026-09-15", "-120.00", "AMERICAN EXPRESS ACH PMT W4419");

    // Unlinked: the payment is that bill's evidence — the bill is paid, off the curve.
    const unlinked = await signal();
    expect(unlinked.overdueAssumedPaid).toEqual([expect.objectContaining({ itemId: legacy!.id, txnId: payment })]);
    expect((unlinked.events ?? []).some((e) => e.itemId === legacy!.id)).toBe(false);

    // Linked: the payment settles last week's payoff instead, so the bill stays unpaid (it reads low, never twice).
    await db
      .update(settingsTable)
      .set({ preferences: { everydayHooks: { weeklyItemId: WEEKLY_ID, monthlyItemId: null } } })
      .where(eq(settingsTable.userId, TEST_USER));
    const linked = await signal();
    expect(payoffEvents(linked, WEEKLY_ID).filter((e) => e.occurrenceDate === "2026-09-12")).toEqual([]);
    expect(linked.overdueAssumedPaid).toEqual([]);
    expect((linked.events ?? []).filter((e) => e.itemId === legacy!.id)).toEqual([
      expect.objectContaining({ date: "2026-09-16", amount: "-120.00", assumption: "due_today_not_posted" }),
    ]);
  });
});

describe("PR8r — the forecast may read low, never high", () => {
  it("an uncategorized Amex charge is outside the existing owed figure: it uses up the plan, but never shrinks the payoff", async () => {
    await household();
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    // `computeWeeklyPayoff` counts categorized charges only (PR-G1 unifies the owed figure).
    await amexCharge(PLATINUM, "2026-09-09", "-30.00", { weeklyAllowance: true, categoryId: null, description: "MARKET STALL 4" });
    const sig = await signal();
    expect(sig.everyday!.weekly).toMatchObject({ spent: "150.00", remaining: "300.00", owed: "120.00", payoff: "450.00" });
  });

  it("a weekly-flagged charge on the monthly card shrinks the weekly payoff only once the monthly hook pays that card", async () => {
    await household();
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    await amexCharge(BLUE, "2026-09-09", "-50.00", { weeklyAllowance: true });
    const weeklyOnly = await signal();
    // Nothing on the curve pays Blue yet, so the $50 does not come out of the reserve.
    expect(weeklyOnly.everyday!.weekly).toMatchObject({ spent: "170.00", remaining: "280.00", owed: "120.00", payoff: "450.00" });

    await db
      .update(settingsTable)
      .set({ preferences: { everydayHooks: { weeklyItemId: WEEKLY_ID, monthlyItemId: MONTHLY_ID } } })
      .where(eq(settingsTable.userId, TEST_USER));
    const both = await signal();
    // Now the monthly payoff carries Blue's $50, and the weekly reserve no longer holds it too.
    expect(both.everyday!.weekly).toMatchObject({ remaining: "280.00", payoff: "400.00" });
    expect(both.everyday!.monthly).toMatchObject({ status: "linked", owed: "50.00", spent: "0.00", payoff: "450.00" });
  });

  it("a hook naming a paused bill reads invalid: nothing is replaced, and the curve is exactly the unlinked one", async () => {
    await household({ hooks: {} });
    await amexCharge(PLATINUM, "2026-09-08", "-120.00", { weeklyAllowance: true });
    const unlinked = await signal();
    const [paused] = await db
      .insert(recurringItemsTable)
      .values({ userId: TEST_USER, householdId: HH, name: "Old Weekly Spend", kind: "bill", amount: "300", frequency: "weekly", anchorDate: "2026-09-12", active: "false" })
      .returning();
    await db
      .update(settingsTable)
      .set({ preferences: { everydayHooks: { weeklyItemId: paused!.id, monthlyItemId: null } } })
      .where(eq(settingsTable.userId, TEST_USER));
    const invalid = await signal();
    expect(invalid.everyday!.weekly).toMatchObject({ status: "invalid", itemId: paused!.id, owed: null, payoff: null });
    expect(invalid.daily).toEqual(unlinked.daily);
    expect(invalid.events).toEqual(unlinked.events);
  });
});

describe("PR8r — before a hook is linked", () => {
  it("a $450 bill against a $400 allowance: discrepancy flagged, the curve unchanged until linked", async () => {
    await household({ hooks: {}, weeklyAllowance: "400.00", weeklyBill: "450" });
    const unlinked = await signal();
    expect(unlinked.everyday!.weekly).toMatchObject({
      status: "unlinked",
      itemId: WEEKLY_ID,
      billAmount: "450.00",
      allowanceAmount: "400.00",
      discrepancy: true,
      payoff: null,
    });
    // The bill still drives the curve, exactly as without the views.
    expect(dayOf(unlinked, "2026-09-12").balance).toBe("1550.00");
    const plain = await computeCashSignal(HH, TEST_USER, { horizonDays: 7 });
    expect(plain.daily).toEqual(unlinked.daily!.map((d) => ({ date: d.date, balance: d.balance })));

    await db
      .update(settingsTable)
      .set({ preferences: { everydayHooks: { weeklyItemId: WEEKLY_ID, monthlyItemId: null } } })
      .where(eq(settingsTable.userId, TEST_USER));
    const linked = await signal();
    expect(linked.everyday!.weekly).toMatchObject({ status: "linked", discrepancy: true, payoff: "400.00" });
    expect(dayOf(linked, "2026-09-12").balance).toBe("1600.00");
  });
});

describe("PR8r — the monthly hook", () => {
  it("Blue: last month's charges on the next business day, this month's charges + remaining plan on the 1st", async () => {
    await household({ hooks: { monthly: true } });
    await amexCharge(BLUE, "2026-08-20", "-200.00", { monthlyAllowance: true });
    await amexCharge(BLUE, "2026-09-05", "-50.00", { monthlyAllowance: true });
    const sig = await signal(30);
    expect(payoffEvents(sig, MONTHLY_ID).map((e) => [e.occurrenceDate, e.date, e.amount, e.assumption])).toEqual([
      ["2026-09-01", "2026-09-14", "-200.00", "amex_payoff_not_posted"],
      ["2026-10-01", "2026-10-01", "-400.00", null],
    ]);
    expect(sig.everyday!.monthly).toMatchObject({ status: "linked", plan: "400.00", spent: "50.00", remaining: "350.00", owed: "50.00", payoff: "400.00" });
  });
});
