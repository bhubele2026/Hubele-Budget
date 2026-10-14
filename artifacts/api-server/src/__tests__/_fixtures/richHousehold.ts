// ⭐ (P2) A RICH SYNTHETIC HOUSEHOLD — every reader one dashboard load touches,
// with a year of history behind it. Synthetic names, amounts and account ids
// only (the preview kit's "rich" household, plus a generated history).
//
// What it holds:
//   - checking (the snapshot account), savings, Amex Platinum (weekly, linked to
//     a debt), Amex Gold (weekly, in the payoff band), Amex Blue (monthly), a
//     non-Amex Visa;
//   - the bills and the paycheck, the two everyday hooks (Weekly / Monthly
//     Spend) with weekly and monthly allowance plans — so every forecast build
//     sizes several hook periods through `computeWeeklyPayoff`;
//   - answers on this month's bills (matched, needs review, ignored);
//   - a generated history from 2025-10-01 (before tracking began) through
//     today on every account, with pending charges and the posted rows that
//     replaced them (some a day or three later, some with a tip), so the
//     pending pairing has real chains to read across week and month edges.
//
// Clock: pin `RICH_NOW` (Wednesday 2026-10-14, noon in Chicago) before reading.

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
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

/** Wednesday 2026-10-14, noon in Chicago. Week = Sun 10/11 – Sat 10/17. */
export const RICH_NOW = new Date("2026-10-14T12:00:00-05:00");
export const RICH_TODAY = "2026-10-14";
export const RICH_WEEK = { from: "2026-10-11", to: "2026-10-17" } as const;
export const RICH_MONTH = { from: "2026-10-01", to: "2026-10-31" } as const;
const HISTORY_FROM = "2025-10-01";

export interface RichHousehold {
  ownerUserId: string;
  householdId: string;
  accounts: { checking: string; savings: string; platinum: string; gold: string; blue: string; visa: string };
  rowCount: number;
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayOfWeek = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/** mulberry32 — a fixed seed, so every run seeds the same household. */
function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = {
  key?: string;
  on: string;
  desc: string;
  amt: number;
  cat?: string | null;
  acct: string;
  src: string;
  flag?: boolean;
  pending?: boolean;
  weekly?: boolean;
  monthly?: boolean;
  unplanned?: boolean;
  reimb?: boolean;
  /** Arrival time: default the start of its own household day. */
  createdAt?: Date;
};

const CARD_MERCHANTS: Array<[string, string, "weekly" | "monthly" | null]> = [
  ["GREEN GROCER", "groceries", "weekly"],
  ["MARKET FRESH 442", "groceries", "weekly"],
  ["SHELL OIL 5741", "gas", "weekly"],
  ["CORNER BISTRO", "dining", "weekly"],
  ["TRATTORIA ROMA", "dining", null],
  ["HARDWARE DEPOT 220", "home", "monthly"],
  ["NORTHWIND APPAREL #1187", "clothing", null],
  ["RIVERSIDE PHARMACY", "health", "weekly"],
  ["ONLINE MARKETPLACE", "home", "monthly"],
  ["CINEMA 12", "fun", null],
];

/**
 * Seed the household for `ownerUserId` (a fresh synthetic id). `scale`
 * multiplies the generated card history (1 ≈ 1,000 rows; the timing harness
 * uses more).
 */
export async function seedRichHousehold(ownerUserId: string, opts: { scale?: number } = {}): Promise<RichHousehold> {
  const scale = opts.scale ?? 1;
  const tag = randomUUID().slice(0, 8);
  const { householdId } = await createTestHousehold(ownerUserId);
  const base = { userId: ownerUserId, householdId };
  const A = {
    checking: { accountId: `rich-chk-${tag}`, mask: "4417", name: "Everyday Checking" },
    savings: { accountId: `rich-sav-${tag}`, mask: "8801", name: "Rainy Day Savings" },
    platinum: { accountId: `rich-plat-${tag}`, mask: "1001", name: "Amex Platinum" },
    gold: { accountId: `rich-gold-${tag}`, mask: "3007", name: "Amex Gold" },
    blue: { accountId: `rich-blue-${tag}`, mask: "2002", name: "Amex Blue" },
    visa: { accountId: `rich-visa-${tag}`, mask: "3303", name: "Summit Visa" },
  };

  // ── Banks and accounts.
  const [bankItem, amexItem, visaItem] = await db
    .insert(plaidItemsTable)
    .values([
      { ...base, itemId: `item-bank-${tag}`, accessToken: "test-token", institutionName: "Lakeside Bank", institutionSlug: "lakeside" },
      { ...base, itemId: `item-amex-${tag}`, accessToken: "test-token", institutionName: "American Express", institutionSlug: "amex" },
      { ...base, itemId: `item-visa-${tag}`, accessToken: "test-token", institutionName: "Summit Bank", institutionSlug: "summit" },
    ])
    .returning();
  const accountRows = await db
    .insert(plaidAccountsTable)
    .values([
      { ...base, itemId: bankItem!.id, ...A.checking, type: "depository", subtype: "checking" },
      { ...base, itemId: bankItem!.id, ...A.savings, type: "depository", subtype: "savings" },
      {
        ...base, itemId: amexItem!.id, ...A.platinum, type: "credit", subtype: "credit card",
        liabilityKind: "credit", liabilityBalance: "2340.55", liabilityApr: "0.2499", liabilityMinPayment: "65.00", liabilityDueDay: 17, liabilityStatementDay: 22,
      },
      {
        ...base, itemId: amexItem!.id, ...A.gold, type: "credit", subtype: "credit card",
        liabilityKind: "credit", liabilityBalance: "455.10", liabilityApr: "0.2399", liabilityMinPayment: "40.00", liabilityDueDay: 15, liabilityStatementDay: 20,
      },
      {
        ...base, itemId: amexItem!.id, ...A.blue, type: "credit", subtype: "credit card",
        liabilityKind: "credit", liabilityBalance: "612.30", liabilityApr: "0.2199", liabilityMinPayment: "35.00", liabilityDueDay: 20, liabilityStatementDay: 25,
      },
      {
        ...base, itemId: visaItem!.id, ...A.visa, type: "credit", subtype: "credit card",
        liabilityKind: "credit", liabilityBalance: "1180.00", liabilityApr: "0.2299", liabilityMinPayment: "35.00", liabilityDueDay: 9, liabilityStatementDay: 14,
      },
    ])
    .returning();
  const rowOf = (accountId: string) => accountRows.find((a) => a.accountId === accountId)!;

  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "500.00",
    bankSnapshotBalance: "2985.00",
    bankSnapshotAt: new Date("2026-10-14T07:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: rowOf(A.checking.accountId).id,
    bankSnapshotMask: A.checking.mask,
    bankSnapshotName: A.checking.name,
  });

  // ── Categories.
  const cat: Record<string, string> = {};
  for (const [key, name, kind] of [
    ["groceries", "Groceries", "expense"],
    ["gas", "Gas", "expense"],
    ["home", "Home", "expense"],
    ["misc", "Misc / Buffer", "expense"],
    ["dining", "Dining", "expense"],
    ["clothing", "Clothing", "expense"],
    ["health", "Health", "expense"],
    ["fun", "Fun", "expense"],
    ["paycheck", "Paycheck", "income"],
  ] as const) {
    const [c] = await db.insert(budgetCategoriesTable).values({ ...base, name, kind, groupName: "Scenario" }).returning();
    cat[key] = c!.id;
  }

  // ── Bills, the paycheck and the two everyday hooks.
  const plan: Record<string, string> = {};
  for (const [key, name, kind, amount, frequency, anchorDate] of [
    ["weeklySpend", "Weekly Spend", "bill", "450", "weekly", "2026-10-10"],
    ["monthlySpend", "Monthly Spend", "bill", "400", "monthly", "2026-10-28"],
    ["paycheck", "Paycheck", "income", "2400", "biweekly", "2026-10-09"],
    ["mortgage", "Mortgage", "bill", "1650", "monthly", "2026-10-01"],
    ["electric", "Electric", "bill", "140", "monthly", "2026-10-06"],
    ["internet", "Internet", "bill", "80", "monthly", "2026-10-03"],
    ["phone", "Phone", "bill", "95", "monthly", "2026-10-12"],
    ["gym", "Gym", "bill", "45", "monthly", "2026-10-10"],
    ["autoLoan", "Auto loan", "bill", "312", "monthly", "2026-10-20"],
  ] as const) {
    const [p] = await db
      .insert(recurringItemsTable)
      .values({ ...base, name, kind, amount, frequency, dayOfMonth: Number(anchorDate.slice(8, 10)), anchorDate, active: "true" })
      .returning();
    plan[key] = p!.id;
  }
  await db.insert(allowancePlansTable).values([
    { householdId, memberUserId: null, period: "weekly", amount: "300.00", effectiveFrom: "2026-05-01", source: "owner" },
    { householdId, memberUserId: null, period: "monthly", amount: "400.00", effectiveFrom: "2026-05-01", source: "owner" },
  ]);
  await db.insert(settingsTable).values({
    ...base,
    preferences: {
      everydayHooks: {
        weekly: { recurringItemId: plan.weeklySpend },
        monthly: { recurringItemId: plan.monthlySpend },
      },
    },
  });

  // ── This month's rows (the preview kit's rich household).
  const chk = A.checking.accountId;
  const rows: Row[] = [
    { key: "mortgage", on: "2026-10-01", desc: "HOMEFIRST MORTGAGE PMT", amt: -1650, cat: "home", acct: chk, src: "plaid:lakeside", flag: true },
    { key: "electric", on: "2026-10-06", desc: "CITY ELECTRIC UTIL", amt: -152, cat: "home", acct: chk, src: "plaid:lakeside", flag: true },
    { key: "internet", on: "2026-10-09", desc: "BRIGHT FIBER INTERNET", amt: -80, cat: "home", acct: chk, src: "plaid:lakeside", flag: true },
    { key: "pay", on: "2026-10-09", desc: "ACME CO PAYROLL", amt: 2400, cat: "paycheck", acct: chk, src: "plaid:lakeside", flag: true },
    { key: "phone", on: "2026-10-12", desc: "WIRELESS CO BILL PAY", amt: -95, cat: "home", acct: chk, src: "plaid:lakeside", flag: true },
    { key: "amexPay", on: "2026-10-08", desc: "AMERICAN EXPRESS ACH PMT", amt: -250, acct: chk, src: "plaid:lakeside", flag: true },
    { key: "zelle", on: "2026-10-10", desc: "ZELLE PAYMENT TO R MARTIN", amt: -75, acct: chk, src: "plaid:lakeside", flag: true },
    { key: "gymRow", on: "2026-10-11", desc: "RIVERSIDE FITNESS CLUB", amt: -49, cat: "misc", acct: chk, src: "plaid:lakeside", flag: true },
    { key: "dental", on: "2026-10-12", desc: "DENTAL ASSOCIATES", amt: -85, cat: "health", acct: chk, src: "plaid:lakeside", flag: true },
    { key: "atm", on: "2026-10-13", desc: "ATM WITHDRAWAL 0042", amt: -60, acct: chk, src: "plaid:lakeside", flag: true },
    { key: "interest", on: "2026-10-01", desc: "INTEREST PAYMENT", amt: 3.41, acct: A.savings.accountId, src: "plaid:lakeside" },
    { on: "2026-10-11", desc: "WHOLE FOODS MARKET", amt: -86.4, cat: "groceries", acct: A.platinum.accountId, src: "plaid:amex", weekly: true },
    { on: "2026-10-12", desc: "SHELL OIL 5741", amt: -52.1, cat: "gas", acct: A.platinum.accountId, src: "plaid:amex", weekly: true },
    { on: "2026-10-12", desc: "TARGET 0012", amt: -64.25, acct: A.platinum.accountId, src: "plaid:amex" },
    { on: "2026-10-13", desc: "CORNER BISTRO", amt: -38.75, cat: "dining", acct: A.platinum.accountId, src: "plaid:amex", unplanned: true },
    { on: "2026-10-13", desc: "RIVERSIDE PHARMACY", amt: -38, cat: "health", acct: A.platinum.accountId, src: "plaid:amex", reimb: true },
    { on: "2026-10-14", desc: "HARDWARE DEPOT 220", amt: -64, cat: "home", acct: A.platinum.accountId, src: "plaid:amex", monthly: true },
    { on: "2026-10-13", desc: "MARKET FRESH #442", amt: -41.2, cat: "groceries", acct: A.platinum.accountId, src: "plaid:amex", pending: true },
    { on: "2026-10-14", desc: "MARKET FRESH 442", amt: -41.2, cat: "groceries", acct: A.platinum.accountId, src: "plaid:amex", weekly: true },
    { on: "2026-10-13", desc: "ONLINE MARKETPLACE", amt: 22.99, cat: "home", acct: A.platinum.accountId, src: "plaid:amex" },
    { on: "2026-10-12", desc: "SHELL OIL 5741", amt: -44.3, cat: "gas", acct: A.gold.accountId, src: "plaid:amex", weekly: true },
    { on: "2026-10-13", desc: "CORNER BISTRO", amt: -27.15, cat: "dining", acct: A.gold.accountId, src: "plaid:amex", pending: true },
    { on: "2026-10-11", desc: "GREEN GROCER", amt: -57.8, cat: "groceries", acct: A.blue.accountId, src: "plaid:amex", weekly: true },
    { on: "2026-10-13", desc: "BUILDERS SUPPLY", amt: -33.1, cat: "home", acct: A.blue.accountId, src: "plaid:amex", weekly: true },
    { on: "2026-10-12", desc: "TRATTORIA ROMA", amt: -48.6, cat: "dining", acct: A.visa.accountId, src: "plaid:summit", weekly: true },
    { on: "2026-10-13", desc: "NORTHWIND APPAREL #1187", amt: 29.99, cat: "clothing", acct: A.visa.accountId, src: "plaid:summit" },
  ];

  // ── The generated history: HISTORY_FROM through yesterday, before this month's rows.
  const rand = prng(20261014);
  const money = (n: number) => Math.round(n * 100) / 100;
  for (let day = HISTORY_FROM; day < "2026-10-01"; day = addDays(day, 1)) {
    const dom = Number(day.slice(8, 10));
    // Checking: the bills on their days, the paycheck every other Friday, card payments on Mondays.
    if (dom === 1) rows.push({ on: day, desc: "HOMEFIRST MORTGAGE PMT", amt: -1650, cat: "home", acct: chk, src: "plaid:lakeside", flag: true });
    if (dom === 3) rows.push({ on: day, desc: "BRIGHT FIBER INTERNET", amt: -80, cat: "home", acct: chk, src: "plaid:lakeside", flag: true });
    if (dom === 6) rows.push({ on: day, desc: "CITY ELECTRIC UTIL", amt: -money(110 + rand() * 60), cat: "home", acct: chk, src: "plaid:lakeside", flag: true });
    if (dom === 12) rows.push({ on: day, desc: "WIRELESS CO BILL PAY", amt: -95, cat: "home", acct: chk, src: "plaid:lakeside", flag: true });
    if (dom === 20) rows.push({ on: day, desc: "AUTO LENDER PAYMENT", amt: -312, acct: chk, src: "plaid:lakeside", flag: true });
    if (dayOfWeek(day) === 5 && Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse("2026-10-09T00:00:00Z")) / 86_400_000) % 14 === 0) {
      rows.push({ on: day, desc: "ACME CO PAYROLL", amt: 2400, cat: "paycheck", acct: chk, src: "plaid:lakeside", flag: true });
    }
    if (dayOfWeek(day) === 1) rows.push({ on: day, desc: "AMERICAN EXPRESS ACH PMT", amt: -money(150 + rand() * 250), acct: chk, src: "plaid:lakeside", flag: true });
    if (rand() < 0.25) rows.push({ on: day, desc: "DEBIT CARD PURCHASE", amt: -money(8 + rand() * 60), cat: "misc", acct: chk, src: "plaid:lakeside", flag: true });

    // Cards: purchases, a quarter of them first seen pending and replaced by a posted row.
    for (const [acct, perDay] of [
      [A.platinum.accountId, 0.6],
      [A.gold.accountId, 0.7],
      [A.blue.accountId, 0.45],
      [A.visa.accountId, 0.3],
    ] as const) {
      const src = acct === A.visa.accountId ? "plaid:summit" : "plaid:amex";
      let n = 0;
      for (let x = rand() * perDay * scale * 2; x > 0.5; x -= 1) n += 1;
      for (let i = 0; i < n; i += 1) {
        const [desc, c, filing] = CARD_MERCHANTS[Math.floor(rand() * CARD_MERCHANTS.length)]!;
        const amt = -money(6 + rand() * 90);
        const filed = { weekly: filing === "weekly", monthly: filing === "monthly" };
        if (rand() < 0.25) {
          const postedOn = addDays(day, 1 + Math.floor(rand() * 3));
          const tip = rand() < 0.3 ? money(-amt * rand() * 0.2) : 0;
          rows.push({ on: day, desc, amt, cat: c, acct, src, pending: true, ...filed });
          if (postedOn < "2026-10-01") rows.push({ on: postedOn, desc, amt: money(amt - tip), cat: c, acct, src, ...filed });
        } else {
          rows.push({ on: day, desc, amt, cat: c, acct, src, ...filed });
        }
      }
    }
  }

  const ids: Record<string, string> = {};
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const out = await db
      .insert(transactionsTable)
      .values(
        chunk.map((r, j) => ({
          ...base,
          occurredOn: r.on,
          description: r.desc,
          amount: r.amt.toFixed(2),
          categoryId: r.cat ? cat[r.cat]! : null,
          plaidAccountId: r.acct,
          source: r.src,
          plaidTransactionId: `rich-${tag}-${i + j}`,
          pending: r.pending ?? false,
          forecastFlag: r.flag ?? false,
          weeklyAllowance: r.weekly ?? false,
          monthlyAllowance: r.monthly ?? false,
          unplannedAllowance: r.unplanned ?? false,
          reimbursable: r.reimb ?? false,
          createdAt: r.createdAt ?? createdAtStartOfHouseholdDay(r.on),
        })),
      )
      .returning({ id: transactionsTable.id });
    chunk.forEach((r, j) => {
      if (r.key) ids[r.key] = out[j]!.id;
    });
  }

  // ── Answers on this month's checking rows.
  const res = (status: string, planKey: string | null, occ: string | null, txnKey: string) => ({
    ...base,
    status,
    recurringItemId: planKey ? plan[planKey]! : null,
    occurrenceDate: occ,
    matchedTxnId: ids[txnKey]!,
  });
  await db.insert(forecastResolutionsTable).values([
    res("matched", "mortgage", "2026-10-01", "mortgage"),
    res("matched", "electric", "2026-10-06", "electric"),
    res("matched", "internet", "2026-10-03", "internet"),
    res("matched", "paycheck", "2026-10-09", "pay"),
    res("matched", "phone", "2026-10-12", "phone"),
    res("needs_review", "gym", "2026-10-10", "gymRow"),
    res("ignored_unforecasted", null, null, "dental"),
  ]);

  // ── Debts: the Platinum is linked to its account.
  await db.insert(debtsTable).values([
    { ...base, name: "Amex Platinum", balance: "2340.55", originalBalance: "4100.00", apr: "0.2499", minPayment: "65.00", payment: "250.00", type: "credit_card", status: "active", sortOrder: 0, dueDay: 17, statementDay: 22, plaidAccountId: rowOf(A.platinum.accountId).id },
    { ...base, name: "HELOC", balance: "18500.00", originalBalance: "25000.00", apr: "0.0750", minPayment: "180.00", payment: "400.00", type: "heloc", status: "active", sortOrder: 1, dueDay: 1 },
    { ...base, name: "Auto loan", balance: "9400.00", originalBalance: "16000.00", apr: "0.0649", minPayment: "312.00", payment: "312.00", type: "auto", status: "active", sortOrder: 2, dueDay: 20 },
    { ...base, name: "Student loan", balance: "14250.00", originalBalance: "22000.00", apr: "0.0450", minPayment: "140.00", payment: "140.00", type: "student", status: "active", sortOrder: 3, dueDay: 25 },
    { ...base, name: "Summit Visa", balance: "1180.00", originalBalance: "2400.00", apr: "0.2299", minPayment: "35.00", payment: "60.00", type: "credit_card", status: "active", sortOrder: 4, dueDay: 9 },
  ]);

  return {
    ownerUserId,
    householdId,
    accounts: {
      checking: A.checking.accountId,
      savings: A.savings.accountId,
      platinum: A.platinum.accountId,
      gold: A.gold.accountId,
      blue: A.blue.accountId,
      visa: A.visa.accountId,
    },
    rowCount: rows.length,
  };
}

/** Remove everything `seedRichHousehold` wrote for these owners. */
export async function cleanupRichHouseholds(ownerUserIds: string[]): Promise<void> {
  if (ownerUserIds.length === 0) return;
  const hh = await db
    .select({ householdId: forecastSettingsTable.householdId })
    .from(forecastSettingsTable)
    .where(inArray(forecastSettingsTable.userId, ownerUserIds));
  const householdIds = hh.map((h) => h.householdId).filter((x): x is string => !!x);
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.userId, ownerUserIds));
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, ownerUserIds));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, ownerUserIds));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, ownerUserIds));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, ownerUserIds));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, ownerUserIds));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, ownerUserIds));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, ownerUserIds));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, ownerUserIds));
  if (householdIds.length > 0) await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, householdIds));
}
