// ⭐ (F5) THE LIVE SHAPE, SYNTHETIC — a household that answered every past
// Weekly Spend in Review. Names, amounts and account numbers are made up; only
// the SHAPE is the live one (2026-10-14): a weekly card paid in full, a weekly
// hook with NO weekly plan, Amex payments from checking filed to an ordinary
// expense category with the forecast flag on, a statement-size payment and
// payments covering several weeks, payment credits on the cards' own ledgers
// (one with no checking row), a debt-plan card whose minimum a SEPARATE checking
// payment paid, a one-time "Amex" bill, and — the switch — a Review answer
// (missed / skipped) on every Weekly Spend, Monthly Spend and minimum that was
// due. Before F1 every closed week dragged a stored $300, so the household
// cleared each with Mark missed / Skip; F1 read those answers as "settled" and
// every unpaid purchase left the curve.
//
// Clock: Wed 2026-10-14 12:00 Central. Plans from Tue 9/1 (first of last month).
// Week = Sun–Sat; this week Sun 10/11 – Sat 10/17. Horizon 30 days.
//
// Accounts
//   Checking ••6120 — the snapshot account: 2,400.00 read Sun 10/11 08:00.
//   Amex Platinum ••7101 — weekly; its debt row ARCHIVED → paid IN FULL.
//   Amex Blue Cash ••7102 — monthly; an ACTIVE debt (minimum 45.00, due the
//     4th) → on the DEBT PLAN.
// Plans
//   Weekly Spend — the weekly hook, stored $300 on Saturdays, NO weekly plan.
//   Monthly Spend — the monthly hook, stored $250 on the 1st; monthly plan $400.
//   Paycheck +1,800 every other Friday from 10/23.
//   "Amex" — a one-time bill, 1,000.00 on 8/26 (before the plan window).
//
// Platinum purchases − refunds, by Weekly Spend occurrence
//   9/5   120   (9/2 CORNER MARKET −120)
//   9/12  240   (9/8 HARDWARE DEPOT −180 · 9/11 GREEN GROCER −60)
//   9/19  130   (9/16 GREEN GROCER −130)
//   9/26  210   (9/21 FUEL STOP −70 · 9/24 BISTRO 22 −140)
//   10/3  180   (9/29 HARDWARE DEPOT −200 · 10/1 REFUND +20)
//   10/10 260   (10/5 GREEN GROCER −110 · 10/8 BISTRO 22 −60 pending → posted
//               10/9 −60, once · 10/10 FUEL STOP −90)
//   10/17  90   (open: 10/12 GREEN GROCER −55 · 10/13 FUEL STOP −35)
// Blue purchases: 9/18 PHARMACY −45 · 10/6 OUTDOOR GEAR −80 (debt plan: never a hook's).
//
// Payments (checking rows "Buffer" unless said; card credits "… - THANK YOU")
//   8/25  −700 AMEX EPAYMENT ACH PMT ("Ignore") + Platinum +700 on 8/26 — pre-window
//   9/14   −40 AMEX EPAYMENT ACH PMT, no card credit (any in_full card)
//   9/22  −300 AMERICAN EXPRESS ACH PMT + Blue +300 on 9/23 — Blue's payment
//   9/22  −520 AMERICAN EXPRESS ACH PMT + Platinum +520 — statement-size
//   9/28  −150 American Express payment (Plaid "credit card payment") + Platinum +150
//   10/2        Platinum +50, no checking row (paid from elsewhere)
//   10/8  −150 American Express payment (Plaid "credit card payment") + Platinum +150
//   10/13  −30 AMERICAN EXPRESS, PENDING, Plaid "credit card payment", no credit
//
// Hand-worked (F5 round 2), oldest obligation first; a payment pays the weeks
// closed on its date in full, and a later week only the purchases made by then:
//   9/14  40 → 9/5 40
//   9/22 520 → 9/5 80 · 9/12 240 · 9/19 130 · 9/26 70 (the 9/21 FUEL STOP, made
//              before it — round 1 dropped these 70 as "an older balance")
//   9/28 150 → 9/26 140 (10 left: nothing else bought by 9/28)
//   10/2  50 → 10/3 50 (9/29 −200 + 10/1 refund +20 = 180 made by 10/2)
//   10/8 150 → 10/3 130 · 10/10 20 (110 made by 10/8)
//   10/13 30 → 10/10 30                                     paid 930 of 1,230
//   unpaid: 10/10 260 − 50 = 210 → −210 Thu 10/15 (the rest after its evidence).
//   Blue: the 9/22 −300 (Blue's ledger, credit 9/23) pays 9/4 (late) and 10/4
//   (its statement closed 9/14, the cautious close, due − 20 days).
//   10/17: 90 + (300 − 90) = 300.
// With Platinum's live balance (`platinumBalance`): the card's own figure caps
// what the forecast holds for it (carried + this week), less the pending 10/13
// −30 the card has not received yet; the cut comes off the oldest week first.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  allowancePlansTable,
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
import { createTestHousehold } from "../_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "../_helpers/ledgerCreatedAt";

export const MISSED_NOW = new Date("2026-10-14T12:00:00-05:00");

type Acct = "checking" | "platinum" | "blue";
type Row = {
  key: string;
  on: string;
  desc: string;
  amt: string;
  acct: Acct;
  pending?: boolean;
  category?: "buffer" | "ignore";
  pfc?: string;
  /** (F5 round 3) When H2 stored the row; default: the start of its household day. */
  createdAt?: Date;
  /** (F5 round 3) The debt (by fixture name) the household tagged the row to. */
  tag?: "platinum" | "blue";
};

export const MISSED_ROWS: Row[] = [
  // Platinum purchases − refunds.
  { key: "p0", on: "2026-09-02", desc: "CORNER MARKET", amt: "-120.00", acct: "platinum" },
  { key: "p1", on: "2026-09-08", desc: "HARDWARE DEPOT", amt: "-180.00", acct: "platinum" },
  { key: "p2", on: "2026-09-11", desc: "GREEN GROCER", amt: "-60.00", acct: "platinum" },
  { key: "p3", on: "2026-09-16", desc: "GREEN GROCER", amt: "-130.00", acct: "platinum" },
  { key: "p4", on: "2026-09-21", desc: "FUEL STOP", amt: "-70.00", acct: "platinum" },
  { key: "p5", on: "2026-09-24", desc: "BISTRO 22", amt: "-140.00", acct: "platinum" },
  { key: "p6", on: "2026-09-29", desc: "HARDWARE DEPOT", amt: "-200.00", acct: "platinum" },
  { key: "r1", on: "2026-10-01", desc: "HARDWARE DEPOT REFUND", amt: "20.00", acct: "platinum" },
  { key: "p7", on: "2026-10-05", desc: "GREEN GROCER", amt: "-110.00", acct: "platinum" },
  { key: "p8pending", on: "2026-10-08", desc: "BISTRO 22", amt: "-60.00", acct: "platinum", pending: true },
  { key: "p8", on: "2026-10-09", desc: "BISTRO 22", amt: "-60.00", acct: "platinum" },
  { key: "p9", on: "2026-10-10", desc: "FUEL STOP", amt: "-90.00", acct: "platinum" },
  { key: "p10", on: "2026-10-12", desc: "GREEN GROCER", amt: "-55.00", acct: "platinum" },
  { key: "p11", on: "2026-10-13", desc: "FUEL STOP", amt: "-35.00", acct: "platinum" },
  // Blue purchases (debt plan).
  { key: "b1", on: "2026-09-18", desc: "PHARMACY", amt: "-45.00", acct: "blue" },
  { key: "b2", on: "2026-10-06", desc: "OUTDOOR GEAR", amt: "-80.00", acct: "blue" },
  // Payment credits on the cards' own ledgers.
  { key: "kP0", on: "2026-08-26", desc: "ONLINE PAYMENT - THANK YOU", amt: "700.00", acct: "platinum" },
  { key: "kB", on: "2026-09-23", desc: "ONLINE PAYMENT - THANK YOU", amt: "300.00", acct: "blue" },
  { key: "kP1", on: "2026-09-22", desc: "ONLINE PAYMENT - THANK YOU", amt: "520.00", acct: "platinum" },
  { key: "kP2", on: "2026-09-28", desc: "ONLINE PAYMENT - THANK YOU", amt: "150.00", acct: "platinum" },
  { key: "kP3", on: "2026-10-02", desc: "MOBILE PAYMENT - THANK YOU", amt: "50.00", acct: "platinum" },
  { key: "kP4", on: "2026-10-08", desc: "MOBILE PAYMENT - THANK YOU", amt: "150.00", acct: "platinum" },
  // Checking: the payments, filed to an ordinary category, forecast flag on.
  { key: "c0", on: "2026-08-25", desc: "AMEX EPAYMENT ACH PMT", amt: "-700.00", acct: "checking", category: "ignore" },
  { key: "c1", on: "2026-09-14", desc: "AMEX EPAYMENT ACH PMT", amt: "-40.00", acct: "checking", category: "buffer" },
  { key: "cBlue", on: "2026-09-22", desc: "AMERICAN EXPRESS ACH PMT", amt: "-300.00", acct: "checking", category: "buffer" },
  { key: "cStmt", on: "2026-09-22", desc: "AMERICAN EXPRESS ACH PMT", amt: "-520.00", acct: "checking", category: "buffer" },
  { key: "c2", on: "2026-09-28", desc: "American Express payment", amt: "-150.00", acct: "checking", category: "buffer", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
  { key: "c3", on: "2026-10-08", desc: "American Express payment", amt: "-150.00", acct: "checking", category: "buffer", pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
  { key: "c4", on: "2026-10-13", desc: "AMERICAN EXPRESS", amt: "-30.00", acct: "checking", category: "buffer", pending: true, pfc: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
];

export interface MissedHousehold {
  ownerUserId: string;
  householdId: string;
  weeklySpendId: string;
  monthlySpendId: string;
  amexBillId: string;
  accounts: Record<Acct, string>;
  debts: { platinum: string; blue: string };
  txn: Record<string, string>;
}

/** The Review answers the live household holds: every due Weekly Spend, Monthly Spend and Blue minimum. */
export async function answerEveryDueOccurrence(h: MissedHousehold): Promise<void> {
  const base = { userId: h.ownerUserId, householdId: h.householdId };
  await db.insert(forecastResolutionsTable).values([
    ...["2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26", "2026-10-10"].map((d) => ({ ...base, recurringItemId: h.weeklySpendId, occurrenceDate: d, status: "missed" })),
    { ...base, recurringItemId: h.weeklySpendId, occurrenceDate: "2026-10-03", status: "skipped" },
    ...["2026-09-01", "2026-10-01"].map((d) => ({ ...base, recurringItemId: h.monthlySpendId, occurrenceDate: d, status: "missed" })),
    ...["2026-09-04", "2026-10-04"].map((d) => ({ ...base, recurringItemId: `debt:${h.debts.blue}`, occurrenceDate: d, status: "missed" })),
  ]);
}

export type MissedRow = Row;

/**
 * Seed the household for a fresh synthetic owner. With `answered`, the live
 * answers too. (F5 round 2) `rows` filters the rows, `extra` adds rows,
 * `platinumBalance` sets Platinum's live (Plaid) balance and when it was read;
 * (round 3) `pendingAtRead`: the rows (fixture keys) that were pending at that
 * read, as the liability fetch keeps them — (round 4) a hand-set list stands for
 * a read right after a transactions sync (round 6: flagged so); absent: none kept.
 */
export async function seedMissedHousehold(
  ownerUserId: string,
  opts: {
    answered?: boolean;
    rows?: (r: Row) => boolean;
    extra?: Row[];
    platinumBalance?: { balance: string; at: Date; pendingAtRead?: string[] };
  } = {},
): Promise<MissedHousehold> {
  const tag = randomUUID().slice(0, 8);
  const { householdId } = await createTestHousehold(ownerUserId);
  const base = { userId: ownerUserId, householdId };
  const ext: Record<Acct, string> = {
    checking: `mis-chk-${tag}`,
    platinum: `mis-plat-${tag}`,
    blue: `mis-blue-${tag}`,
  };
  const [bank, amex] = await db
    .insert(plaidItemsTable)
    .values([
      { ...base, itemId: `item-bank-${tag}`, accessToken: "t", institutionName: "Lakeside Bank", institutionSlug: "lakeside" },
      { ...base, itemId: `item-amex-${tag}`, accessToken: "t", institutionName: "American Express", institutionSlug: "amex" },
    ])
    .returning();
  const accts = await db
    .insert(plaidAccountsTable)
    .values([
      { ...base, itemId: bank!.id, accountId: ext.checking, name: "Everyday Checking", mask: "6120", type: "depository", subtype: "checking" },
      {
        ...base,
        itemId: amex!.id,
        accountId: ext.platinum,
        name: "Amex Platinum",
        mask: "7101",
        type: "credit",
        subtype: "credit card",
        ...(opts.platinumBalance ? { liabilityBalance: opts.platinumBalance.balance, liabilityLastFetchedAt: opts.platinumBalance.at } : {}),
      },
      { ...base, itemId: amex!.id, accountId: ext.blue, name: "Amex Blue Cash", mask: "7102", type: "credit", subtype: "credit card" },
    ])
    .returning();
  const internal = (e: string) => accts.find((a) => a.accountId === e)!.id;
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2400.00",
    bankSnapshotAt: new Date("2026-10-11T08:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: internal(ext.checking),
    bankSnapshotMask: "6120",
  });
  const created = new Date("2026-08-01T12:00:00-05:00");
  const [ws, ms, pay, bill] = await db
    .insert(recurringItemsTable)
    .values([
      { ...base, name: "Weekly Spend", kind: "bill", amount: "300", frequency: "weekly", anchorDate: "2026-10-17", active: "true", createdAt: created },
      { ...base, name: "Monthly Spend", kind: "bill", amount: "250", frequency: "monthly", dayOfMonth: 1, anchorDate: "2026-08-01", active: "true", createdAt: created },
      { ...base, name: "Paycheck", kind: "income", amount: "1800", frequency: "biweekly", anchorDate: "2026-10-23", active: "true", createdAt: new Date("2026-10-14T09:00:00-05:00") },
      { ...base, name: "Amex", kind: "bill", amount: "1000", frequency: "onetime", anchorDate: "2026-08-26", active: "true", createdAt: created },
    ])
    .returning();
  await db.insert(settingsTable).values({
    ...base,
    preferences: { everydayHooks: { weekly: { recurringItemId: ws!.id }, monthly: { recurringItemId: ms!.id } } },
  });
  await db.insert(allowancePlansTable).values({ householdId, memberUserId: null, period: "monthly", amount: "400.00", effectiveFrom: "2026-08-01", source: "owner" });
  const [platDebt, blueDebt] = await db
    .insert(debtsTable)
    .values([
      { ...base, name: "Amex Platinum", balance: "900.00", originalBalance: "2500.00", apr: "0.2499", minPayment: "40.00", payment: "40.00", type: "credit_card", status: "archived", sortOrder: 0, dueDay: 17, plaidAccountId: internal(ext.platinum), createdAt: created },
      { ...base, name: "Amex Blue Cash", balance: "2600.00", originalBalance: "4000.00", apr: "0.2299", minPayment: "45.00", payment: "45.00", type: "credit_card", status: "active", sortOrder: 1, dueDay: 4, plaidAccountId: internal(ext.blue), createdAt: created },
    ])
    .returning();
  const [buffer, ignore] = await db
    .insert(budgetCategoriesTable)
    .values([
      { ...base, name: `Buffer ${tag}`, kind: "expense" },
      { ...base, name: `Ignore ${tag}`, kind: "expense", excludeFromBudget: true },
    ])
    .returning();
  const rows = [...MISSED_ROWS.filter(opts.rows ?? (() => true)), ...(opts.extra ?? [])];
  const out = await db
    .insert(transactionsTable)
    .values(
      rows.map((r, i) => ({
        ...base,
        occurredOn: r.on,
        description: r.desc,
        amount: r.amt,
        plaidAccountId: ext[r.acct],
        source: r.acct === "checking" ? "plaid:lakeside" : "plaid:amex",
        plaidTransactionId: `mis-${tag}-${i}`,
        pending: r.pending ?? false,
        forecastFlag: r.acct === "checking",
        categoryId: r.category === "buffer" ? buffer!.id : r.category === "ignore" ? ignore!.id : null,
        pfcDetailed: r.pfc ?? null,
        debtId: r.tag === "platinum" ? platDebt!.id : r.tag === "blue" ? blueDebt!.id : null,
        createdAt: r.createdAt ?? createdAtStartOfHouseholdDay(r.on),
      })),
    )
    .returning({ id: transactionsTable.id });
  const txn: Record<string, string> = {};
  rows.forEach((r, i) => (txn[r.key] = out[i]!.id));
  if (opts.platinumBalance?.pendingAtRead) {
    await db
      .update(plaidAccountsTable)
      .set({ liabilityPendingTxnIds: opts.platinumBalance.pendingAtRead.map((k) => txn[k]!), liabilityPendingAfterSync: true })
      .where(eq(plaidAccountsTable.id, internal(ext.platinum)));
  }
  const h: MissedHousehold = {
    ownerUserId,
    householdId,
    weeklySpendId: ws!.id,
    monthlySpendId: ms!.id,
    amexBillId: bill!.id,
    accounts: ext,
    debts: { platinum: platDebt!.id, blue: blueDebt!.id },
    txn,
  };
  void pay;
  if (opts.answered) await answerEveryDueOccurrence(h);
  return h;
}

export async function cleanupMissedHouseholds(owners: string[], householdIds: string[]): Promise<void> {
  if (owners.length === 0) return;
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.userId, owners));
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, owners));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, owners));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, owners));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, owners));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, owners));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, owners));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, owners));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, owners));
  if (householdIds.length > 0) await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, householdIds));
}
