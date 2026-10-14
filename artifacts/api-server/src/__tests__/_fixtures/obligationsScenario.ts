// ⭐ (F1) THE OBLIGATIONS SCENARIO — every cash obligation of the everyday
// hooks, worked by hand. Synthetic names, amounts and account numbers only.
//
// Clock: Wed 2026-10-14 12:00 Central. Window (the ledger's plan window): from
// Tue 9/1. Week = Sun–Sat; this week Sun 10/11 – Sat 10/17. Horizon 30 days
// (10/14 → 11/13).
//
// Accounts
//   Checking ••4417 — the snapshot account: 3,000.00 read Sun 10/11 08:00.
//   Amex Platinum ••2207 — weekly; its debt row ARCHIVED (balance 1,200, APR,
//     minimum 40) → paid IN FULL by default ("debt_not_active").
//   Amex Gold ••3307 — weekly; no debt row → IN FULL ("no_debt").
//   Amex Blue Cash ••1106 — monthly; an ACTIVE debt (minimum 143.05, due the
//     20th) → on the DEBT PLAN ("debt_active").
// Plans
//   Weekly Spend — the weekly everyday hook, stored $450 on Saturdays.
//   Paycheck +2,000 every other Friday from 10/23.
//   No allowance plan (the household's live state); the tests add one.
//
// Rows (card purchases negative; "w" = filed to the weekly allowance)
//   wk 9/13–9/19   Plat 9/15 CORNER MARKET −80 w
//   wk 9/20–9/26   Plat 9/22 CORNER MARKET −90 w · Gold 9/23 SHELL OIL −30 w
//   wk 9/27–10/3   Plat 9/29 HARDWARE DEPOT −150 (unfiled) · Plat 10/2 HARDWARE
//                  DEPOT REFUND +20 · Blue 10/2 OUTDOOR GEAR −60
//   wk 10/4–10/10  Plat 10/5 GREEN GROCER −110 w · Plat 10/8 BISTRO 22 −45
//                  PENDING → posted 10/9 −45 (one purchase) · Plat 10/10 FUEL
//                  STOP −45 · Gold 10/6 GREEN GROCER −40 w
//   wk 10/11–10/17 Plat 10/12 GREEN GROCER −60 w · Plat 10/13 TARGET 0012 −40
//                  (unfiled) · Gold 10/13 BISTRO 22 −20 w · Blue 10/12
//                  PHARMACY −35 w · Checking 10/13 SHELL OIL 5741 −25 w
//   Checking payments
//     9/20 AMEX EPAYMENT ACH PMT −143.05, tagged to Blue's debt (pays Blue's
//          9/20 minimum — never Platinum's purchases)
//     9/21 AMEX EPAYMENT ACH PMT −80
//     10/5 ONLINE TRANSFER 7781 −50, tagged to Platinum's ARCHIVED debt (a
//          partial payment, Platinum only)
//     10/12 AMERICAN EXPRESS ACH PMT −150 (covers parts of two weeks)
//
// Hand-worked obligations (in_full cards: Platinum + Gold), oldest first:
//   occ 9/19   own  80 (Plat 80)            ← 9/21 −80 pays 80          → paid
//   occ 9/26   own 120 (Gold 30, Plat 90)   ← 10/5 −50 (Plat only) 50;
//                                            10/12 −150: Gold 30, Plat 40 → paid
//   occ 10/3   own 130 (Plat 150 − 20)      ← 10/12 the rest: 80        → 50 unpaid
//   occ 10/10  own 240 (Gold 40, Plat 200)  ← nothing left              → 240 unpaid
//   The latest due occurrence (10/10) carries 10/3's 50: 240 + 50 = 290, on
//   the next business day (Thu 10/15). Blue's purchases are in none of them.
//   occ 10/17  own 120 (Gold 20, Plat 100); spent this week (weekly pool) =
//              60 + 40 + 20 + 35 + 25 = 180.
//     no plan    120 + max(0, 450 − 120) = 450
//     plan $300  120 + max(0, 300 − 180) = 240
//     plan $150  120 + max(0, 150 − 180) = 120  (before F1: 20 — Platinum lost)
//   later weeks: 450 (no plan) / the plan.

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  db,
  allowancePlansTable,
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

export const OBL_NOW = new Date("2026-10-14T12:00:00-05:00");
export const OBL_THIS_SUNDAY = "2026-10-11";

export interface ObligationsHousehold {
  ownerUserId: string;
  householdId: string;
  weeklySpendId: string;
  paycheckId: string;
  accounts: { checking: string; platinum: string; gold: string; blue: string };
  internal: { platinum: string; gold: string; blue: string };
  debts: { platinum: string; blue: string };
  txn: Record<string, string>;
}

type Row = {
  key: string;
  on: string;
  desc: string;
  amt: string;
  acct: "checking" | "platinum" | "gold" | "blue";
  weekly?: boolean;
  pending?: boolean;
  debt?: "platinum" | "blue";
};

export const OBL_ROWS: Row[] = [
  { key: "p1", on: "2026-09-15", desc: "CORNER MARKET", amt: "-80.00", acct: "platinum", weekly: true },
  { key: "p2", on: "2026-09-22", desc: "CORNER MARKET", amt: "-90.00", acct: "platinum", weekly: true },
  { key: "g1", on: "2026-09-23", desc: "SHELL OIL", amt: "-30.00", acct: "gold", weekly: true },
  { key: "p3", on: "2026-09-29", desc: "HARDWARE DEPOT", amt: "-150.00", acct: "platinum" },
  { key: "r1", on: "2026-10-02", desc: "HARDWARE DEPOT REFUND", amt: "20.00", acct: "platinum" },
  { key: "b1", on: "2026-10-02", desc: "OUTDOOR GEAR", amt: "-60.00", acct: "blue" },
  { key: "p4", on: "2026-10-05", desc: "GREEN GROCER", amt: "-110.00", acct: "platinum", weekly: true },
  { key: "p5pending", on: "2026-10-08", desc: "BISTRO 22", amt: "-45.00", acct: "platinum", pending: true },
  { key: "p5", on: "2026-10-09", desc: "BISTRO 22", amt: "-45.00", acct: "platinum" },
  { key: "p6", on: "2026-10-10", desc: "FUEL STOP", amt: "-45.00", acct: "platinum" },
  { key: "g2", on: "2026-10-06", desc: "GREEN GROCER", amt: "-40.00", acct: "gold", weekly: true },
  { key: "p7", on: "2026-10-12", desc: "GREEN GROCER", amt: "-60.00", acct: "platinum", weekly: true },
  { key: "p8", on: "2026-10-13", desc: "TARGET 0012", amt: "-40.00", acct: "platinum" },
  { key: "g3", on: "2026-10-13", desc: "BISTRO 22", amt: "-20.00", acct: "gold", weekly: true },
  { key: "b2", on: "2026-10-12", desc: "PHARMACY", amt: "-35.00", acct: "blue", weekly: true },
  { key: "c4", on: "2026-10-13", desc: "SHELL OIL 5741", amt: "-25.00", acct: "checking", weekly: true },
  { key: "c0", on: "2026-09-20", desc: "AMEX EPAYMENT ACH PMT", amt: "-143.05", acct: "checking", debt: "blue" },
  { key: "c1", on: "2026-09-21", desc: "AMEX EPAYMENT ACH PMT", amt: "-80.00", acct: "checking" },
  { key: "c2", on: "2026-10-05", desc: "ONLINE TRANSFER 7781", amt: "-50.00", acct: "checking", debt: "platinum" },
  { key: "c3", on: "2026-10-12", desc: "AMERICAN EXPRESS ACH PMT", amt: "-150.00", acct: "checking" },
];

/** Seed the household for a fresh synthetic owner. `rows` filters the rows (default: all). */
export async function seedObligationsHousehold(ownerUserId: string, opts: { rows?: (r: Row) => boolean } = {}): Promise<ObligationsHousehold> {
  const tag = randomUUID().slice(0, 8);
  const { householdId } = await createTestHousehold(ownerUserId);
  const base = { userId: ownerUserId, householdId };
  const ext = {
    checking: `obl-chk-${tag}`,
    platinum: `obl-plat-${tag}`,
    gold: `obl-gold-${tag}`,
    blue: `obl-blue-${tag}`,
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
      { ...base, itemId: bank!.id, accountId: ext.checking, name: "Everyday Checking", mask: "4417", type: "depository", subtype: "checking" },
      { ...base, itemId: amex!.id, accountId: ext.platinum, name: "Amex Platinum", mask: "2207", type: "credit", subtype: "credit card" },
      { ...base, itemId: amex!.id, accountId: ext.gold, name: "Amex Gold", mask: "3307", type: "credit", subtype: "credit card" },
      { ...base, itemId: amex!.id, accountId: ext.blue, name: "Amex Blue Cash", mask: "1106", type: "credit", subtype: "credit card" },
    ])
    .returning();
  const internal = (e: string) => accts.find((a) => a.accountId === e)!.id;
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-11T08:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: internal(ext.checking),
    bankSnapshotMask: "4417",
  });
  const [ws, pay] = await db
    .insert(recurringItemsTable)
    .values([
      { ...base, name: "Weekly Spend", kind: "bill", amount: "450", frequency: "weekly", anchorDate: "2026-10-17", active: "true", createdAt: new Date("2026-08-01T12:00:00-05:00") },
      { ...base, name: "Paycheck", kind: "income", amount: "2000", frequency: "biweekly", anchorDate: "2026-10-23", active: "true", createdAt: new Date("2026-10-14T09:00:00-05:00") },
    ])
    .returning();
  await db.insert(settingsTable).values({ ...base, preferences: { everydayHooks: { weekly: { recurringItemId: ws!.id }, monthly: null } } });
  const [platDebt, blueDebt] = await db
    .insert(debtsTable)
    .values([
      { ...base, name: "Amex Platinum", balance: "1200.00", originalBalance: "3000.00", apr: "0.2499", minPayment: "40.00", payment: "40.00", type: "credit_card", status: "archived", sortOrder: 0, dueDay: 17, plaidAccountId: internal(ext.platinum), createdAt: new Date("2026-08-01T12:00:00-05:00") },
      { ...base, name: "Amex Blue Cash", balance: "4100.00", originalBalance: "5000.00", apr: "0.2299", minPayment: "143.05", payment: "143.05", type: "credit_card", status: "active", sortOrder: 1, dueDay: 20, plaidAccountId: internal(ext.blue), createdAt: new Date("2026-08-01T12:00:00-05:00") },
    ])
    .returning();
  const debtId = { platinum: platDebt!.id, blue: blueDebt!.id };
  const rows = OBL_ROWS.filter(opts.rows ?? (() => true));
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
        plaidTransactionId: `obl-${tag}-${i}`,
        pending: r.pending ?? false,
        forecastFlag: r.acct === "checking",
        weeklyAllowance: r.weekly ?? false,
        debtId: r.debt ? debtId[r.debt] : null,
        createdAt: createdAtStartOfHouseholdDay(r.on),
      })),
    )
    .returning({ id: transactionsTable.id });
  const txn: Record<string, string> = {};
  rows.forEach((r, i) => (txn[r.key] = out[i]!.id));
  return {
    ownerUserId,
    householdId,
    weeklySpendId: ws!.id,
    paycheckId: pay!.id,
    accounts: ext,
    internal: { platinum: internal(ext.platinum), gold: internal(ext.gold), blue: internal(ext.blue) },
    debts: debtId,
    txn,
  };
}

export async function cleanupObligationsHouseholds(owners: string[], householdIds: string[]): Promise<void> {
  if (owners.length === 0) return;
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.userId, owners));
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, owners));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, owners));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, owners));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, owners));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, owners));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, owners));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, owners));
  if (householdIds.length > 0) await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, householdIds));
}
