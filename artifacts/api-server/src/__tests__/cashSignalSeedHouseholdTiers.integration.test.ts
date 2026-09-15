// ⭐ DECISION 13 ON A SEED-SHAPED HOUSEHOLD — NEITHER OVERSTATE NOR UNDERSTATE CASH.
//
// The PR-B review measured the first evidence-tier head (`cfe7b955`) understating
// cash on the household `budgetSeed.ts` describes: bills sharing categories
// (Utilities ×3, Insurance ×3, Misc / Buffer ×3, Car Payments ×2), each row in its
// bill's seed category, and real bank descriptors. This file is that household.
// Two amounts differ from the seed so the reviewer's cases exist: Verizon Wireless
// is $430.00 (seed $342.00) and State Farm Insurance $180.00 (seed $128.59).
//
// Every case: balance 10,000.00 read at 10:00 CT on "today", buffer 500, a short
// horizon so each figure can be worked by hand. Rows are Plaid rows on checking,
// dated on or before today (the snapshot holds them), unless a case says otherwise.
// Only Date is mocked.
//
// Hand-worked figures (lowest balance / max safe extra; ending balance for income):
// see each case. The before/after table is in
// docs/reviews/2026-09-11-match-evidence-tiers.md.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const TEST_USER = `seed-tiers-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HOUSEHOLD: string;
const CHASE = "chase-seed-tiers";

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
  HOUSEHOLD = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
});

const CATEGORY: Record<string, string> = Object.fromEntries(
  [
    "Other Income",
    "Hannah's paycheck (Exact)",
    "Brad's paycheck (KFI)",
    "Subscriptions",
    "Car Payments",
    "Gas, Maintenance & Parking",
    "Misc / Buffer",
    "Insurance",
    "Mortgage (Lakeview)",
    "Utilities",
    "Home Maintenance & Warranty",
    "HELOC (Figure)",
  ].map((name) => [name, randomUUID()]),
);

type Seed = {
  name: string;
  kind: "income" | "bill";
  amount: string;
  frequency: "monthly" | "weekly" | "biweekly";
  dayOfMonth: number | null;
  anchorDate: string;
  category: string;
  /** The bank's description of a payment of this item. */
  descriptor?: string;
};

// `budgetSeed.ts` SEED_RECURRING_ITEMS, with anchors so no occurrence predates the item.
const SEED = {
  mom: { name: "Mom — Verizon reimbursement", kind: "income", amount: "88.00", frequency: "monthly", dayOfMonth: 15, anchorDate: "2026-01-15", category: "Other Income" },
  hannahPay: { name: "Hannah's paycheck (Exact)", kind: "income", amount: "4499.99", frequency: "biweekly", dayOfMonth: null, anchorDate: "2026-05-08", category: "Hannah's paycheck (Exact)", descriptor: "EXACT SCIENCES PAYROLL" },
  bradPay: { name: "Brad's paycheck (KFI)", kind: "income", amount: "8100.00", frequency: "biweekly", dayOfMonth: null, anchorDate: "2026-05-01", category: "Brad's paycheck (KFI)", descriptor: "KFI STAFFING PAYROLL" },
  psn5: { name: "PlayStation Network", kind: "bill", amount: "18.98", frequency: "monthly", dayOfMonth: 5, anchorDate: "2026-01-05", category: "Subscriptions", descriptor: "PLAYSTATION NETWORK" },
  psn16: { name: "PlayStation Network", kind: "bill", amount: "18.98", frequency: "monthly", dayOfMonth: 16, anchorDate: "2026-01-16", category: "Subscriptions", descriptor: "PLAYSTATION NETWORK" },
  uw: { name: "Hannah's Car (UW Credit Union)", kind: "bill", amount: "651.55", frequency: "monthly", dayOfMonth: 6, anchorDate: "2026-01-06", category: "Car Payments", descriptor: "UW CREDIT UNION LOAN PMT" },
  toyota: { name: "Toyota Lease", kind: "bill", amount: "672.80", frequency: "monthly", dayOfMonth: 7, anchorDate: "2026-01-07", category: "Car Payments", descriptor: "TOYOTA MOTOR CREDIT" },
  kwik9: { name: "Kwik Trip / gas", kind: "bill", amount: "200.00", frequency: "monthly", dayOfMonth: 9, anchorDate: "2026-01-09", category: "Gas, Maintenance & Parking" },
  kwik24: { name: "Kwik Trip / gas", kind: "bill", amount: "200.00", frequency: "monthly", dayOfMonth: 24, anchorDate: "2026-01-24", category: "Gas, Maintenance & Parking" },
  weekly: { name: "Weekly Spend", kind: "bill", amount: "450.00", frequency: "weekly", dayOfMonth: null, anchorDate: "2026-05-02", category: "Misc / Buffer" },
  monthly: { name: "Monthly Spend", kind: "bill", amount: "440.45", frequency: "monthly", dayOfMonth: 1, anchorDate: "2026-01-01", category: "Misc / Buffer" },
  trustage: { name: "TruStage / Ethos", kind: "bill", amount: "95.00", frequency: "monthly", dayOfMonth: 15, anchorDate: "2026-01-15", category: "Insurance", descriptor: "TRUSTAGE INS PREM" },
  mortgage: { name: "Mortgage (Lakeview)", kind: "bill", amount: "1989.81", frequency: "monthly", dayOfMonth: 14, anchorDate: "2026-01-14", category: "Mortgage (Lakeview)", descriptor: "LAKEVIEW LOAN SERVICING MORTGAGE" },
  verizon: { name: "Verizon Wireless", kind: "bill", amount: "430.00", frequency: "monthly", dayOfMonth: 16, anchorDate: "2026-01-16", category: "Utilities", descriptor: "VERIZON WIRELESS PAYMENTS" },
  mge: { name: "MGE Electric & Gas", kind: "bill", amount: "241.00", frequency: "monthly", dayOfMonth: 20, anchorDate: "2026-01-20", category: "Utilities", descriptor: "MADISON GAS EL" },
  water: { name: "Water/Sewer", kind: "bill", amount: "101.02", frequency: "monthly", dayOfMonth: 24, anchorDate: "2026-01-24", category: "Utilities", descriptor: "CITY OF MADISON" },
  nelnet: { name: "Student Loan (Nelnet)", kind: "bill", amount: "237.58", frequency: "monthly", dayOfMonth: 29, anchorDate: "2026-01-29", category: "Misc / Buffer", descriptor: "NELNET STUDENT LN" },
  dog: { name: "Dog Waste Removal", kind: "bill", amount: "80.00", frequency: "monthly", dayOfMonth: 1, anchorDate: "2026-01-01", category: "Home Maintenance & Warranty", descriptor: "DOODY CALLS" },
  sf: { name: "State Farm", kind: "bill", amount: "121.54", frequency: "monthly", dayOfMonth: 3, anchorDate: "2026-01-03", category: "Insurance", descriptor: "STATE FARM RO 27 SFPP" },
  sfIns: { name: "State Farm Insurance", kind: "bill", amount: "180.00", frequency: "monthly", dayOfMonth: 3, anchorDate: "2026-01-03", category: "Insurance", descriptor: "STATE FARM RO 27 SFPP" },
  heloc: { name: "HELOC (Figure)", kind: "bill", amount: "677.40", frequency: "monthly", dayOfMonth: 3, anchorDate: "2026-01-03", category: "HELOC (Figure)", descriptor: "FIGURE LENDING" },
} satisfies Record<string, Seed>;
type Key = keyof typeof SEED;

let ids: Record<Key, string>;

/** The seed household on `todayISO`: balance 10,000.00 read at 10:00 CT, buffer 500. */
async function household(todayISO: string): Promise<void> {
  vi.setSystemTime(new Date(`${todayISO}T17:00:00Z`));
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: HOUSEHOLD, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: HOUSEHOLD, itemId: item!.id, accountId: CHASE, name: "Chase Checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: HOUSEHOLD,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "500",
    bankSnapshotBalance: "10000",
    bankSnapshotAt: new Date(`${todayISO}T15:00:00Z`),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
  });
  const out = {} as Record<Key, string>;
  for (const [key, s] of Object.entries(SEED) as Array<[Key, Seed]>) {
    const [r] = await db
      .insert(recurringItemsTable)
      .values({
        userId: TEST_USER,
        householdId: HOUSEHOLD,
        name: s.name,
        kind: s.kind,
        amount: s.amount,
        frequency: s.frequency,
        dayOfMonth: s.dayOfMonth,
        anchorDate: s.anchorDate,
        active: "true",
        categoryId: CATEGORY[s.category]!,
      })
      .returning({ id: recurringItemsTable.id });
    out[key] = r!.id;
  }
  ids = out;
}

/** A payment of `key`: its descriptor, in its seed category (a manual row carries no category). */
async function paid(key: Key, occurredOn: string, amount: string, opts: { manual?: boolean } = {}): Promise<string> {
  const s: Seed = SEED[key];
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      occurredOn,
      description: s.descriptor!,
      amount,
      categoryId: opts.manual ? null : CATEGORY[s.category]!,
      plaidAccountId: opts.manual ? null : CHASE,
      source: opts.manual ? "manual" : "plaid:chase",
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

/** A month the user already confirmed: the row, and a `matched` answer for that occurrence. */
async function confirmed(key: Key, occurrenceDate: string, amount: string): Promise<void> {
  const txn = await paid(key, occurrenceDate, amount);
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: HOUSEHOLD,
    recurringItemId: ids[key],
    occurrenceDate,
    status: "matched",
    matchedTxnId: txn,
  });
}

/** The owner's `matched` answer for an occurrence, on a row already in the ledger. */
async function answerMatched(key: Key, occurrenceDate: string, txnId: string): Promise<void> {
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: HOUSEHOLD,
    recurringItemId: ids[key],
    occurrenceDate,
    status: "matched",
    matchedTxnId: txnId,
  });
}

const signal = (horizonDays: number) => computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays });
const figures = (sig: CashSignal) => ({ lowest: sig.lowestProjected, maxSafeExtra: sig.maxSafeExtra });
const pairOf = (sig: CashSignal, key: Key, occurrenceDate: string) =>
  sig.matches?.find((m) => m.planKey === `${ids[key]}|${occurrenceDate}`);

/** 08-21, everything paid on its due date. */
async function augustOnTime(): Promise<void> {
  await paid("toyota", "2026-08-07", "-672.80");
  await paid("mortgage", "2026-08-14", "-1989.81");
  await paid("trustage", "2026-08-15", "-95.00");
  await paid("verizon", "2026-08-16", "-430.00");
  await paid("psn16", "2026-08-16", "-18.98");
  await paid("mge", "2026-08-20", "-241.00");
}

describe("decision 13 — the seed household (hand-worked figures)", () => {
  // Fri 08-21, horizon 3 (to Mon 08-24). Unpaid within 14 days: Kwik Trip 08-09 (an
  // allowance, no row) drags onto 08-24. On the curve: Weekly Spend 08-22 −450,
  // Water 08-24 −101.02, Kwik Trip 08-24 −200. Brad's 08-21 paycheck is due today:
  // off the curve. Paid: Toyota, Mortgage, TruStage, Verizon, PSN, and MGE when its
  // row is evidence.
  //   all paid: 10,000 − 450 − 200 − 101.02 − 200 = 9,048.98 → max safe 8,548.98.

  it("A0 08-21, all on time, MGE never confirmed: 'MADISON GAS EL' names no one — tier 3, MGE drags (8,807.98 / 8,307.98)", async () => {
    await household("2026-08-21");
    await augustOnTime();
    const sig = await signal(3);
    // 9,048.98 − 241.00.
    expect(figures(sig)).toEqual({ lowest: "8807.98", maxSafeExtra: "8307.98" });
    expect(pairOf(sig, "mge", "2026-08-20")).toMatchObject({ confidence: "low", tier: 3, offCurve: false });
  });

  it("A 08-21, all on time, July's MGE confirmed: (fix 2) the confirmed descriptor makes August tier 2 (9,048.98 / 8,548.98)", async () => {
    await household("2026-08-21");
    await confirmed("mge", "2026-07-20", "-241.00");
    await augustOnTime();
    const sig = await signal(3);
    expect(figures(sig)).toEqual({ lowest: "9048.98", maxSafeExtra: "8548.98" });
    expect(pairOf(sig, "mge", "2026-08-20")).toMatchObject({ tier: 2, offCurve: true });
  });

  it("B 08-21, Toyota +6, TruStage +5, Mortgage +3, Verizon +2: (fix 1) Toyota's exact 'TOYOTA' six days late is tier 2 (9,048.98 / 8,548.98)", async () => {
    await household("2026-08-21");
    await confirmed("mge", "2026-07-20", "-241.00");
    await paid("toyota", "2026-08-13", "-672.80");
    await paid("mortgage", "2026-08-17", "-1989.81");
    await paid("trustage", "2026-08-20", "-95.00");
    await paid("verizon", "2026-08-18", "-430.00");
    await paid("psn16", "2026-08-16", "-18.98");
    await paid("mge", "2026-08-20", "-241.00");
    const sig = await signal(3);
    expect(figures(sig)).toEqual({ lowest: "9048.98", maxSafeExtra: "8548.98" });
    expect(pairOf(sig, "toyota", "2026-08-07")).toMatchObject({ dayDelta: 6, tier: 2, offCurve: true });
    expect(pairOf(sig, "trustage", "2026-08-15")).toMatchObject({ dayDelta: 5, tier: 2 });
  });

  // ⭐ (Round 3, MEDIUM 1 trade-off) Superseded by the fix for a real OVERSTATEMENT:
  // a confirmed descriptor now also needs the row inside the CONFIRMED ROWS' own
  // amount range (± max($1, 1%)) — "MADISON GAS EL" confirming August at $85 off
  // the July amount was exactly this bug (docs/reviews/2026-09-11-match-evidence-
  // tiers.md, Round 3). $425 is $5 under the $430 confirmed exactly once, past its
  // $4.30 tolerance; Verizon shares "Utilities" with MGE and Water so rule (a)
  // (sole category) does not rescue it either. The descriptor alone can no longer
  // authorize a five-dollar guess — the WHOLE bill drags until the user answers,
  // where round 2 dragged only the $5.00 gap. Owner trade-off: this is more
  // conservative (never overstates) but now needs a confirm click for a shortfall
  // this small, same as any other unnamed row.
  it("C 08-21, Verizon $425.00 on the $430 bill, July's Verizon confirmed: (round 3) outside the confirmed amount's range, not sole in its category — a suggestion, the whole $430 drags (8,618.98 / 8,118.98)", async () => {
    await household("2026-08-21");
    await confirmed("mge", "2026-07-20", "-241.00");
    await confirmed("verizon", "2026-07-16", "-430.00");
    await paid("toyota", "2026-08-07", "-672.80");
    await paid("mortgage", "2026-08-14", "-1989.81");
    await paid("trustage", "2026-08-15", "-95.00");
    const verizon = await paid("verizon", "2026-08-16", "-425.00");
    await paid("psn16", "2026-08-16", "-18.98");
    await paid("mge", "2026-08-20", "-241.00");
    const sig = await signal(3);
    // 9,048.98 − 430.00 (round 2: 9,048.98 − 5.00 = 9,043.98).
    expect(figures(sig)).toEqual({ lowest: "8618.98", maxSafeExtra: "8118.98" });
    expect(pairOf(sig, "verizon", "2026-08-16")).toMatchObject({ txnId: verizon, difference: "-5.00", tier: 3, offCurve: false });
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${ids.verizon}|2026-08-16`)).toBeUndefined();
    expect((sig.events ?? []).filter((e) => e.assumption === "overdue_remainder_assumed_unpaid")).toEqual([]);
    expect((sig.events ?? []).filter((e) => e.label === "Verizon Wireless").map((e) => [e.date, e.amount, e.assumption])).toEqual([
      ["2026-08-24", "-430.00", "overdue_assumed_unpaid"],
    ]);
  });

  // Wed 08-05, horizon 2 (to Fri 08-07). Unpaid within 14 days: Kwik Trip 07-24 −200
  // and Monthly Spend 08-01 −440.45 drag onto 08-06. On the curve: UW car 08-06
  // −651.55. Paid: Water 07-24 (June confirmed), Nelnet 07-29, Dog Waste 08-01
  // (its own category), State Farm 08-03, HELOC 08-03, PSN 08-05 (paid 08-04).
  // Toyota 08-07 was paid early on 08-04 and July's Toyota was paid 07-13.
  // ⭐ (Round 3, MEDIUM 1 trade-off) State Farm Insurance renewed at $165.00 is
  // $15.00 under its $180.00 July confirmation — past the confirmed amount's own
  // $1.80 tolerance, and Insurance holds three bills (trustage, sf, sfIns) so rule
  // (a) does not rescue it either. Round 2 let the descriptor's STRONG evidence
  // carry a $15 gap; round 3 requires the row inside the confirmed range, so this
  // is now a suggestion and the WHOLE $180.00 drags (round 2: only $15.00).
  //   08-06: 10,000 − 200 − 440.45 − 180.00 − 651.55 = 8,528.00 → max safe 8,028.00.
  //   08-07: Brad's paycheck +8,100 lands and Toyota is off the curve → 16,628.00 (the
  //   ending balance). Held back by July, Toyota would take 672.80 more that day.
  /** Returns July's Toyota row. */
  async function earlyAugust(julyToyota: string): Promise<string> {
    await household("2026-08-05");
    await confirmed("water", "2026-06-24", "-101.02");
    await confirmed("sf", "2026-07-03", "-121.54");
    await confirmed("sfIns", "2026-07-03", "-180.00");
    await paid("water", "2026-07-24", "-101.02");
    await paid("nelnet", "2026-07-29", "-237.58");
    await paid("dog", "2026-08-01", "-80.00");
    await paid("sf", "2026-08-03", "-121.54");
    await paid("sfIns", "2026-08-03", "-165.00");
    await paid("heloc", "2026-08-03", "-677.40");
    await paid("psn5", "2026-08-04", "-18.98");
    const july = await paid("toyota", "2026-07-13", julyToyota);
    await paid("toyota", "2026-08-04", "-672.80");
    return july;
  }

  it("D 08-05, July Toyota +6, State Farm renewed at $165, Water exact: (round 3) the $165 renewal is outside its confirmed range — the whole $180 drags (8,528.00 / 8,028.00)", async () => {
    await earlyAugust("-672.80");
    const sig = await signal(2);
    expect({ ...figures(sig), ending: sig.endingBalance }).toEqual({ lowest: "8528.00", maxSafeExtra: "8028.00", ending: "16628.00" });
    expect(pairOf(sig, "water", "2026-07-24")).toMatchObject({ tier: 2 });
    expect(pairOf(sig, "sfIns", "2026-08-03")).toMatchObject({ difference: "-15.00", tier: 3, offCurve: false });
    expect(pairOf(sig, "toyota", "2026-07-07")).toMatchObject({ dayDelta: 6, tier: 2 });
    expect(pairOf(sig, "toyota", "2026-08-07")).toMatchObject({ tier: 2, offCurve: true });
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${ids.sfIns}|2026-08-03`)).toBeUndefined();
  });

  // ⭐ (PR-B2, owner decision 2026-09-15 — the stricter direction) REPLACES round 3's
  // D2 assertion (August off the curve, ending 16,628.00). July's $685.00 pair is
  // named and not ambiguous, but it is tier 3 ($12.20 over): a suggestion, not proof
  // July was paid. So July stays unpaid for the hold-back, August's exact $672.80 on
  // 08-04 is held back (it may be July's bill, paid late), and August's Toyota stays
  // on the curve until the owner confirms July (D3). The forecast may read low, never
  // high.
  //   08-06 is unchanged: 8,528.00 / 8,028.00 (Toyota is due 08-07, the paycheck's day).
  //   08-07: 8,528.00 + 8,100.00 − 672.80 = 15,955.20 (was 16,628.00).
  it("D2 08-05, July Toyota paid $685.00 (a late fee: tier 3): (PR-B2) a tier-3 July is not proof, so August's early exact payment is held back and drags until July is confirmed (8,528.00 / 8,028.00, ending 15,955.20)", async () => {
    await earlyAugust("-685.00");
    const sig = await signal(2);
    expect({ ...figures(sig), ending: sig.endingBalance }).toEqual({ lowest: "8528.00", maxSafeExtra: "8028.00", ending: "15955.20" });
    expect(pairOf(sig, "toyota", "2026-07-07")).toMatchObject({ difference: "12.20", ambiguous: false, tier: 3, offCurve: false });
    expect(pairOf(sig, "toyota", "2026-08-07")).toMatchObject({ dayDelta: -3, tier: 3, offCurve: false });
  });

  // (PR-B2) The way out of D2: the owner confirms July. A `matched` answer is tier-1
  // evidence, and an answered occurrence never reaches the matcher, so July no longer
  // holds anything back. August's exact payment is free again and clears August —
  // back to D's figures. Read twice on one household so the answer is the only change.
  it("D3 08-05, the D2 household, then July's $685.00 confirmed as matched (tier 1): August drags before the answer and clears after it (ending 15,955.20 → 16,628.00)", async () => {
    const julyRow = await earlyAugust("-685.00");
    const before = await signal(2);
    expect(before.endingBalance).toBe("15955.20");
    expect(pairOf(before, "toyota", "2026-08-07")).toMatchObject({ tier: 3, offCurve: false });

    await answerMatched("toyota", "2026-07-07", julyRow);
    const after = await signal(2);
    expect({ ...figures(after), ending: after.endingBalance }).toEqual({ lowest: "8528.00", maxSafeExtra: "8028.00", ending: "16628.00" });
    expect(pairOf(after, "toyota", "2026-07-07")).toBeUndefined();
    expect(pairOf(after, "toyota", "2026-08-07")).toMatchObject({ dayDelta: -3, tier: 2, offCurve: true });
  });

  it("E 08-10, both State Farm policies +6 (July confirmed), HELOC +6, UW car +4: 9,359.55 / 8,859.55", async () => {
    // Mon 08-10, horizon 1 (to Tue 08-11). Unpaid within 14 days: Monthly Spend 08-01
    // −440.45 and Kwik Trip 08-09 −200 drag onto 08-11. Everything else is paid.
    //   10,000 − 440.45 − 200 = 9,359.55 → max safe 8,859.55.
    await household("2026-08-10");
    await confirmed("sf", "2026-07-03", "-121.54");
    await confirmed("sfIns", "2026-07-03", "-180.00");
    await paid("nelnet", "2026-07-29", "-237.58");
    await paid("dog", "2026-08-01", "-80.00");
    await paid("sf", "2026-08-09", "-121.54");
    await paid("sfIns", "2026-08-09", "-180.00");
    await paid("heloc", "2026-08-09", "-677.40");
    await paid("psn5", "2026-08-05", "-18.98");
    await paid("uw", "2026-08-10", "-651.55");
    await paid("toyota", "2026-08-07", "-672.80");
    const sig = await signal(1);
    expect(figures(sig)).toEqual({ lowest: "9359.55", maxSafeExtra: "8859.55" });
    expect(pairOf(sig, "sf", "2026-08-03")).toMatchObject({ dayDelta: 6, tier: 2 });
    expect(pairOf(sig, "sfIns", "2026-08-03")).toMatchObject({ dayDelta: 6, tier: 2 });
    expect(pairOf(sig, "heloc", "2026-08-03")).toMatchObject({ dayDelta: 6, tier: 2 });
    expect(pairOf(sig, "uw", "2026-08-06")).toMatchObject({ dayDelta: 4, tier: 2 });
  });

  it("F1 08-20, Brad's $8,100 KFI paycheck deposited a day early: (fix 5) its own category makes it tier 2 — counted once (ending 9,800.00, lowest 9,800.00 / 9,300.00)", async () => {
    // Thu 08-20, horizon 1 (to Fri 08-21). Kwik Trip 08-09 −200 drags onto 08-21; every
    // other bill is paid (MGE due today, July confirmed). Brad's earlier paychecks all
    // arrived, so none of them holds the 08-21 one back.
    //   Brad's 08-21 plan off the curve: 10,000 − 200 = 9,800.00 on 08-21.
    await household("2026-08-20");
    await confirmed("mge", "2026-07-20", "-241.00");
    for (const d of ["2026-07-10", "2026-07-24", "2026-08-07"]) await paid("bradPay", d, "8100.00");
    const early = await paid("bradPay", "2026-08-20", "8100.00");
    await paid("uw", "2026-08-06", "-651.55");
    await paid("toyota", "2026-08-07", "-672.80");
    await paid("mortgage", "2026-08-14", "-1989.81");
    await paid("trustage", "2026-08-15", "-95.00");
    await paid("verizon", "2026-08-16", "-430.00");
    await paid("psn16", "2026-08-16", "-18.98");
    await paid("mge", "2026-08-20", "-241.00");
    const sig = await signal(1);
    expect({ ending: sig.endingBalance, ...figures(sig) }).toEqual({ ending: "9800.00", lowest: "9800.00", maxSafeExtra: "9300.00" });
    expect(pairOf(sig, "bradPay", "2026-08-21")).toMatchObject({ txnId: early, dayDelta: -1, tier: 2, offCurve: true });
  });

  it("F2 08-27, Hannah's $4,499.99 paycheck deposited a day early on a MANUAL row: (fix 4) a manual checking row is cash and evidence — counted once (ending 9,800.00, lowest 9,800.00 / 9,300.00)", async () => {
    // Thu 08-27, horizon 1 (to Fri 08-28). Kwik Trip 08-24 −200 drags onto 08-28; every
    // other bill is paid (MGE and Water July confirmed). Hannah's earlier paychecks
    // all arrived.
    //   Hannah's 08-28 plan off the curve: 10,000 − 200 = 9,800.00 on 08-28.
    await household("2026-08-27");
    await confirmed("mge", "2026-07-20", "-241.00");
    await confirmed("water", "2026-07-24", "-101.02");
    for (const d of ["2026-07-17", "2026-07-31", "2026-08-14"]) await paid("hannahPay", d, "4499.99");
    const early = await paid("hannahPay", "2026-08-27", "4499.99", { manual: true });
    await paid("mortgage", "2026-08-14", "-1989.81");
    await paid("trustage", "2026-08-15", "-95.00");
    await paid("verizon", "2026-08-16", "-430.00");
    await paid("psn16", "2026-08-16", "-18.98");
    await paid("mge", "2026-08-20", "-241.00");
    await paid("water", "2026-08-24", "-101.02");
    const sig = await signal(1);
    expect({ ending: sig.endingBalance, ...figures(sig) }).toEqual({ ending: "9800.00", lowest: "9800.00", maxSafeExtra: "9300.00" });
    expect(pairOf(sig, "hannahPay", "2026-08-28")).toMatchObject({ txnId: early, dayDelta: -1, tier: 2, offCurve: true });
  });
});
