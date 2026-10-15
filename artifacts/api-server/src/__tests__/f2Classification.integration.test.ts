// ⭐ (F2) EVIDENCE-BASED CLASSIFICATION — the live week, synthetic. Every name,
// amount and account number is made up; the shapes follow the owner's 10/14
// evidence (a HELOC-like loan payment, an insurance debit the forecast only
// suggests for a bill, a savings transfer filed as a subscription, a payroll
// credit filed under Dining, genuine purchases beside them).
//
// Today is Wed 2026-10-14 12:00 America/Chicago; the household week is Sun
// 10/11 – Sat 10/17. Household F: Chase checking ••4321 (the forecast's,
// snapshot $5,000 at 10/1 08:00) and an Amex card ••1009. Weekly plan $300,
// monthly $400.
//
//   This week, checking (unfiled unless said):
//     LRK LOANS (pending)          −1,150.40  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT  → unresolved (loan payment)
//     SHIELDLINE INS               −95.00     GENERAL_SERVICES_INSURANCE, Health   → unresolved (the forecast suggests
//                                                                                     "Shieldline Life", tier 3)
//     PEAR GS SAVINGS (pending)    −20.00     TRANSFER_OUT_SAVINGS, Subscriptions  → unresolved (transfer to savings)
//     VALLEY LOAN SVC (posted)     −50.00     no Plaid category of its own; its pending row (replaced) said
//                                             LOAN_PAYMENTS                        → unresolved (carried)
//     BEAN COUNTER COFFEE (pending) −25.00    FOOD_AND_DRINK_COFFEE                → known (purchase category)
//     PAYPAL *GADGETS (pending)    −14.76     no Plaid category                    → known (no contrary evidence)
//     ATM WITHDRAWAL 0042          −60.00     TRANSFER_OUT_WITHDRAWAL              → known (ATM)
//     ZELLE PAYMENT TO JANE ROE    −40.00     TRANSFER_OUT_ACCOUNT_TRANSFER        → known (person to person)
//     AMEX EPAYMENT ACH PMT        −250.00    the card payment                     → payments (not spending)
//     ONLINE TRANSFER TO SAV       −100.00    transfer                             → payments (not spending)
//   This week, the card (weekly · Groceries): GROCERY MART −150.00, a $10.00 credit back → 140.00 known.
//
//   By hand:  actual  1,595.16 = 1,150.40 + 95 + 20 + 50 + 25 + 14.76 + 60 + 40 + 140  (the money position's)
//             known     279.76 = 25 + 14.76 + 60 + 40 + 140
//             unresolved 1,315.40 (provisional: > max($25, 5% of $300))
//             remaining  300 − 279.76 = 20.24 (within)   — the position still reads 300 − 1,595.16 = −1,295.16
//             payments    350.00 (2 rows)
//   The month (October): HOME GOODS −120.00 monthly → actual = known = 120.00 of $400.
//
// Proposals (last 120 days, nothing written), largest first:
//   loan_payment     LARKSPUR LENDING 8/13 + 9/14 (filed "Other income") and LRK LOANS 10/13 — one series of
//                    1,150.40 → the HELOC bill (its category "HELOC (Larkspur)" names "larkspur";
//                    1,150.40 within max($25, 25%) of 1,130) = 3,451.20
//   income_category  the MAPLEWORKS payroll +2,391.40 filed Dining (INCOME_SALARY) → "Pat's paycheck (Mapleworks)"'s
//                    category Paycheck
//   loan_payment     UPLAND LOAN PMT 9/20 −250.00 → the Upland Loan debt (its name; ≥ its $200 minimum)
//   bill_match       SHIELDLINE INS → confirm the match to "Shieldline Life" 10/20
//   transfer         PEAR GS SAVINGS → Transfer
//   never:           RIDGEWAY FINANCE 9/16 −300.00 fits TWO bills ("Ridgeway Boat", "Ridgeway Camper"): no guess.
//
// Household G (the categorizer): the review queue's direction guard and sign-aware memory.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, count, eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const F = `f2-f-${tag}`;
const MEMBER = `f2-m-${tag}`;
const G = `f2-g-${tag}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      headers: Record<string, string | string[] | undefined>;
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? F);
    // A member of F's household: signed in as themselves, the household is F's.
    const hh = who === MEMBER ? HH[F]! : HH[who]!;
    req.userId = hh.ownerUserId;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  allowancePlansTable,
  budgetCategoriesTable,
  categoryDecisionsTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  merchantMemoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { GetBankingReviewResponse, GetPeriodBreakdownResponse, GetReviewProposalsResponse } from "@workspace/api-zod";
import moneyRouter from "../routes/money";
import spineRouter from "../routes/spine";
import bankingRouter from "../routes/banking";
import reviewProposalsRouter from "../routes/reviewProposals";
import categorizationRouter from "../routes/categorization";
import learnedRulesRouter from "../routes/learnedRules";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { recordHandFiling } from "../lib/categorizer/userDecisions";
import { loadEngineContext } from "../lib/categorizer/context";
import { memoryStage } from "../lib/categorizer/stages/memory";
import type { EngineRow } from "../lib/categorizer/types";

const NOW = new Date("2026-10-14T12:00:00-05:00");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(spineRouter);
app.use(bankingRouter);
app.use(reviewProposalsRouter);
app.use(categorizationRouter);
app.use(learnedRulesRouter);

let server: Server;
let baseUrl: string;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, as: string = F, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-test-user": as, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
async function get(path: string, as: string = F): Promise<Json> {
  const r = await call("GET", path, as);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const cents = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 100);
const ids: Record<string, string> = {};
const acct: Record<string, { rowId: string; ext: string }> = {};
const cat: Record<string, string> = {};
const item: Record<string, string> = {};
let uplandDebt = "";

async function cleanup(): Promise<void> {
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length === 0) return;
  await db.delete(categoryDecisionsTable).where(inArray(categoryDecisionsTable.householdId, hhIds));
  await db.delete(merchantMemoryTable).where(inArray(merchantMemoryTable.householdId, hhIds));
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.householdId, hhIds));
  await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, hhIds));
  await db.delete(transactionsTable).where(inArray(transactionsTable.householdId, hhIds));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.householdId, hhIds));
  await db.delete(debtsTable).where(inArray(debtsTable.householdId, hhIds));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.householdId, hhIds));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, [F, G]));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.householdId, hhIds));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.householdId, hhIds));
}

async function seedAccount(user: string, key: string, inst: string, name: string, mask: string, type: string, subtype: string): Promise<void> {
  const owned = { userId: user, householdId: HH[user]!.householdId };
  const [it] = await db
    .insert(plaidItemsTable)
    .values({
      ...owned,
      itemId: `f2-item-${key}-${randomUUID()}`,
      accessToken: "t",
      institutionName: inst,
      institutionSlug: type === "credit" ? "amex" : "chase",
      lastSyncedAt: new Date("2026-10-14T09:00:00-05:00"),
    })
    .returning();
  const ext = `f2-${key}-${randomUUID().slice(0, 8)}`;
  const [r] = await db
    .insert(plaidAccountsTable)
    .values({ ...owned, itemId: it!.id, accountId: ext, name, mask, type, subtype })
    .returning();
  acct[key] = { rowId: r!.id, ext };
}

async function seedCategory(user: string, key: string, name: string, kind: "expense" | "income"): Promise<void> {
  const [c] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: user, householdId: HH[user]!.householdId, name, kind, groupName: "F2" })
    .returning();
  cat[key] = c!.id;
}

type TxnSpec = {
  key: string;
  on: string;
  desc: string;
  amount: string;
  account: string;
  category?: string;
  weekly?: boolean;
  monthly?: boolean;
  transfer?: boolean;
  pending?: boolean;
  pfcPrimary?: string;
  pfcDetailed?: string;
};

async function seedTxns(user: string, rows: TxnSpec[]): Promise<void> {
  for (const r of rows) {
    const a = acct[r.account]!;
    const [t] = await db
      .insert(transactionsTable)
      .values({
        userId: user,
        householdId: HH[user]!.householdId,
        occurredOn: r.on,
        createdAt: createdAtStartOfHouseholdDay(r.on),
        description: r.desc,
        amount: r.amount,
        plaidAccountId: a.ext,
        plaidTransactionId: `f2-${r.key}-${randomUUID().slice(0, 8)}`,
        source: r.account.endsWith("amex") ? "plaid:amex" : "plaid:chase",
        categoryId: r.category ? cat[r.category]! : null,
        weeklyAllowance: r.weekly ?? false,
        monthlyAllowance: r.monthly ?? false,
        isTransfer: r.transfer ?? false,
        pending: r.pending ?? false,
        pfcPrimary: r.pfcPrimary ?? null,
        pfcDetailed: r.pfcDetailed ?? null,
      })
      .returning({ id: transactionsTable.id });
    ids[r.key] = t!.id;
  }
}

async function seedBill(user: string, key: string, name: string, kind: "bill" | "income", amount: string, freq: string, day: number | null, anchor: string, category?: string): Promise<void> {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: user,
      householdId: HH[user]!.householdId,
      name,
      kind,
      amount,
      frequency: freq,
      dayOfMonth: day,
      anchorDate: anchor,
      active: "true",
      categoryId: category ? cat[category]! : null,
    })
    .returning();
  item[key] = r!.id;
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  for (const u of [F, G]) HH[u] = await createTestHousehold(u);
  await cleanup();
  const f = { userId: F, householdId: HH[F]!.householdId };

  // ── Household F
  await seedAccount(F, "chase", "Chase", "Total Checking", "4321", "depository", "checking");
  await seedAccount(F, "amex", "American Express", "Blue Card", "1009", "credit", "credit card");
  await db.insert(forecastSettingsTable).values({
    ...f,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "500.00",
    bankSnapshotBalance: "5000.00",
    bankSnapshotAt: new Date("2026-10-01T08:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct.chase!.rowId,
    bankSnapshotMask: "4321",
  });
  await seedCategory(F, "groceries", "Groceries", "expense");
  await seedCategory(F, "dining", "Dining & Coffee", "expense");
  await seedCategory(F, "subs", "Subscriptions", "expense");
  await seedCategory(F, "health", "Health", "expense");
  await seedCategory(F, "insurance", "Insurance", "expense");
  await seedCategory(F, "heloc", "HELOC (Larkspur)", "expense");
  await seedCategory(F, "home", "Home", "expense");
  await seedCategory(F, "transfer", "Transfer", "expense");
  await seedCategory(F, "otherIncome", "Other income", "income");
  await seedCategory(F, "paycheck", "Paycheck", "income");
  await db.insert(allowancePlansTable).values([
    { ...{ householdId: f.householdId }, memberUserId: null, period: "weekly", amount: "300.00", effectiveFrom: "2026-05-01", source: "owner" },
    { ...{ householdId: f.householdId }, memberUserId: null, period: "monthly", amount: "400.00", effectiveFrom: "2026-05-01", source: "owner" },
  ]);
  await seedBill(F, "heloc", "HELOC", "bill", "1110", "monthly", 3, "2026-05-03", "heloc");
  await seedBill(F, "shieldLife", "Shieldline Life", "bill", "95", "monthly", 20, "2026-10-20", "insurance");
  await seedBill(F, "shieldAuto", "Shieldline Auto", "bill", "210", "monthly", 25, "2026-10-25", "insurance");
  await seedBill(F, "ridgeBoat", "Ridgeway Boat", "bill", "300", "monthly", 1, "2026-10-01");
  await seedBill(F, "ridgeCamper", "Ridgeway Camper", "bill", "300", "monthly", 1, "2026-10-01");
  await seedBill(F, "paycheck", "Pat's paycheck (Mapleworks)", "income", "2500", "biweekly", null, "2026-10-09", "paycheck");
  const [d] = await db
    .insert(debtsTable)
    .values({ ...f, name: "Upland Loan", balance: "5000.00", originalBalance: "5000.00", apr: "0.0900", minPayment: "200", payment: "0", dueDay: 20, type: "personal_loan", createdAt: new Date("2026-01-01T12:00:00-06:00") })
    .returning();
  uplandDebt = d!.id;

  await seedTxns(F, [
    // Earlier: the loan series, the debt payment, the two-bill payment.
    { key: "larkAug", on: "2026-08-13", desc: "LARKSPUR LENDING", amount: "-1150.40", account: "chase", category: "otherIncome", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT" },
    { key: "larkSep", on: "2026-09-14", desc: "LARKSPUR LENDING", amount: "-1150.40", account: "chase", category: "otherIncome", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT" },
    { key: "upland", on: "2026-09-20", desc: "UPLAND LOAN PMT", amount: "-250.00", account: "chase", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" },
    { key: "ridgeway", on: "2026-09-16", desc: "RIDGEWAY FINANCE", amount: "-300.00", account: "chase", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" },
    // October: the month's own row, last week's payroll.
    { key: "homeGoods", on: "2026-10-02", desc: "HOME GOODS", amount: "-120.00", account: "amex", category: "home", monthly: true, pfcPrimary: "GENERAL_MERCHANDISE" },
    { key: "payroll", on: "2026-10-09", desc: "ORIG CO NAME:MAPLEWORKS INC CO ENTRY DESCR:PAYROLL SEC:PPD ORIG ID:9001", amount: "2391.40", account: "chase", category: "dining", pfcPrimary: "INCOME", pfcDetailed: "INCOME_SALARY" },
    // This week.
    { key: "lrk", on: "2026-10-13", desc: "LRK LOANS", amount: "-1150.40", account: "chase", pending: true, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" },
    { key: "shield", on: "2026-10-12", desc: "SHIELDLINE INS", amount: "-95.00", account: "chase", category: "health", pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_INSURANCE" },
    { key: "pear", on: "2026-10-13", desc: "PEAR GS SAVINGS", amount: "-20.00", account: "chase", category: "subs", pending: true, pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_SAVINGS" },
    { key: "valleyPending", on: "2026-10-12", desc: "VALLEY LOAN SVC", amount: "-50.00", account: "chase", pending: true, pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" },
    { key: "valley", on: "2026-10-13", desc: "VALLEY LOAN SVC", amount: "-50.00", account: "chase" },
    { key: "coffee", on: "2026-10-13", desc: "BEAN COUNTER COFFEE", amount: "-25.00", account: "chase", pending: true, pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_COFFEE" },
    { key: "paypal", on: "2026-10-13", desc: "PAYPAL *GADGETS", amount: "-14.76", account: "chase", pending: true },
    { key: "atm", on: "2026-10-12", desc: "ATM WITHDRAWAL 0042", amount: "-60.00", account: "chase", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_WITHDRAWAL" },
    { key: "zelle", on: "2026-10-12", desc: "ZELLE PAYMENT TO JANE ROE", amount: "-40.00", account: "chase", pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" },
    { key: "amexPay", on: "2026-10-12", desc: "AMEX EPAYMENT ACH PMT", amount: "-250.00", account: "chase", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
    { key: "toSav", on: "2026-10-12", desc: "ONLINE TRANSFER TO SAV ...8801", amount: "-100.00", account: "chase", transfer: true },
    { key: "grocery", on: "2026-10-12", desc: "GROCERY MART", amount: "-150.00", account: "amex", category: "groceries", weekly: true, pfcPrimary: "FOOD_AND_DRINK", pfcDetailed: "FOOD_AND_DRINK_GROCERIES" },
    { key: "groceryBack", on: "2026-10-13", desc: "GROCERY MART", amount: "10.00", account: "amex", category: "groceries", weekly: true },
  ]);

  // ── Household G (the categorizer)
  await seedAccount(G, "gchase", "Chase", "Total Checking", "7701", "depository", "checking");
  await seedAccount(G, "gamex", "American Express", "Gold Card", "7702", "credit", "credit card");
  await seedCategory(G, "gDining", "Dining & Coffee", "expense");
  await seedCategory(G, "gGroceries", "Groceries", "expense");
  await seedCategory(G, "gPaycheck", "Paycheck", "income");
  await seedTxns(G, [
    { key: "gCafe1", on: "2026-10-01", desc: "MAPLEWORKS INC", amount: "-8.50", account: "gamex" },
    { key: "gPayroll1", on: "2026-09-25", desc: "ORIG CO NAME:MAPLEWORKS INC CO ENTRY DESCR:PAYROLL SEC:PPD ORIG ID:7001", amount: "2391.40", account: "gchase" },
    { key: "gCafe2", on: "2026-10-08", desc: "MAPLEWORKS INC", amount: "-9.25", account: "gamex" },
    { key: "gRefund", on: "2026-10-09", desc: "GROCERY MART", amount: "12.00", account: "gamex" },
    { key: "gXfer", on: "2026-10-09", desc: "ONLINE TRANSFER TO SAV ...7703", amount: "-300.00", account: "gchase", transfer: true },
  ]);

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

const WEEK = "/money/period-breakdown?period=week&start=2026-10-11&rowsPerGroup=50";
const MONTH = "/money/period-breakdown?period=month&start=2026-10-01&rowsPerGroup=50";

const rowsOf = (group: { rows: Json[] }) => new Map(group.rows.map((r: Json) => [Object.keys(ids).find((k) => ids[k] === r.id)!, r] as const));

describe("F2 · this week — known purchases vs the plan; unresolved apart; the position unchanged", () => {
  it("⭐ the week by hand: actual 1,595.16 · known 279.76 · unresolved 1,315.40 · left 20.24 · payments 350.00", async () => {
    const b = await get(WEEK);
    if (process.env.F2_PRINT_SAMPLE) writeFileSync(process.env.F2_PRINT_SAMPLE, JSON.stringify({ week: b, month: await get(MONTH) }, null, 2));
    expect(() => GetPeriodBreakdownResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject({
      plan: { status: "set", amount: "300.00" },
      actual: "1595.16",
      known: "279.76",
      remaining: "20.24",
      over: "0.00",
      withinPlan: true,
      provisional: true,
      refundFloorAdjustment: "0.00",
    });
    expect(b.unresolved).toMatchObject({ amount: "1315.40", nettedByRefunds: "0.00", count: 4, truncated: false });
    // ⭐ known + unresolved = actual, to the cent.
    expect(cents(b.known) + cents(b.unresolved.amount)).toBe(cents(b.actual));
    // The drill-down reconciles: Σ unresolved rows = amount + netted.
    expect(b.unresolved.rows.reduce((a: number, r: Json) => a + cents(r.amount), 0)).toBe(cents(b.unresolved.amount) + cents(b.unresolved.nettedByRefunds));
    // Known's drill-down: the filed categories + the unfiled rows that are not unresolved.
    const unresolvedIds = new Set(b.unresolved.rows.map((r: Json) => r.id));
    const knownRows = [...b.categories.flatMap((c: Json) => c.rows), ...b.needsClassification.rows.filter((r: Json) => !unresolvedIds.has(r.id))];
    expect(knownRows.reduce((a: number, r: Json) => a + cents(r.amount), 0) + cents(b.refundFloorAdjustment)).toBe(cents(b.known));
    expect(b.excludedPayments).toMatchObject({ amount: "350.00", count: 2 });
    expect(b.excludedPayments.rows.map((r: Json) => r.id)).toEqual([ids.amexPay, ids.toSav]);
  });

  it("each unresolved row says why — evidence and a suggestion; each known row says why too", async () => {
    const b = await get(WEEK);
    const u = rowsOf(b.unresolved);
    expect([...u.keys()]).toEqual(["lrk", "shield", "valley", "pear"]);
    expect(u.get("lrk")!.evidence).toEqual({
      class: "unresolved",
      reason: "loan_payment",
      items: [
        { field: "pfc_primary", value: "LOAN_PAYMENTS" },
        { field: "pfc_detailed", value: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" },
      ],
      suggestion: { kind: "loan_payment", detail: null, target: null },
    });
    expect(u.get("lrk")).toMatchObject({ pending: true, account: { name: "Total Checking", mask: "4321" } });
    expect(u.get("shield")!.evidence).toMatchObject({
      class: "unresolved",
      reason: "bill_suggestion",
      items: [{ field: "bill_suggestion", value: "Shieldline Life" }, { field: "pfc_primary", value: "GENERAL_SERVICES" }, { field: "pfc_detailed", value: "GENERAL_SERVICES_INSURANCE" }],
      suggestion: { kind: "bill", target: { kind: "bill", id: item.shieldLife, label: "Shieldline Life", occurrenceDate: "2026-10-20", planKey: `${item.shieldLife}|2026-10-20` } },
    });
    expect(u.get("pear")!.evidence).toMatchObject({ reason: "transfer_evidence", suggestion: { kind: "transfer", detail: "savings" } });
    // pending→posted: the posted VALLEY row has no Plaid category; its replaced pending row's carries.
    expect(u.get("valley")!.evidence).toMatchObject({ reason: "loan_payment", items: [{ field: "pfc_primary", value: "LOAN_PAYMENTS" }, { field: "pfc_detailed", value: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" }] });
    expect(u.get("valley")!.pending).toBe(false);
    expect(b.needsClassification.rows.some((r: Json) => r.id === ids.valleyPending)).toBe(false);
    const n = rowsOf(b.needsClassification);
    expect(n.get("coffee")!.evidence).toMatchObject({ class: "known_purchase", reason: "purchase_category" });
    expect(n.get("paypal")!.evidence).toMatchObject({ class: "known_purchase", reason: "no_contrary_evidence", items: [] });
    expect(n.get("atm")!.evidence).toMatchObject({ class: "known_purchase", reason: "atm_withdrawal" });
    expect(n.get("zelle")!.evidence).toMatchObject({ class: "known_purchase", reason: "person_to_person" });
    const groceries = b.categories.find((c: Json) => c.categoryId === cat.groceries);
    expect(groceries.rows.find((r: Json) => r.id === ids.grocery).evidence).toMatchObject({ class: "known_purchase", reason: "household_flag" });
    const pay = rowsOf(b.excludedPayments);
    expect(pay.get("amexPay")!.evidence).toMatchObject({ class: "confirmed_payment", reason: "card_payment" });
    expect(pay.get("toSav")!.evidence).toMatchObject({ class: "confirmed_payment", reason: "transfer" });
  });

  it("⭐ the money position, safe-to-spend and the spine are unchanged: they still count the unresolved rows", async () => {
    const [b, pos, spine] = await Promise.all([get(WEEK), get("/money/position"), get("/spine")]);
    expect(pos.spentWeekDiscretionary).toBe("1595.16");
    expect(b.actual).toBe(pos.spentWeekDiscretionary);
    expect(pos.remainingWeek).toBe("-1295.16");
    expect(spine.position.remainingWeek).toBe(pos.remainingWeek);
    expect(spine.position.safeToSpend).toEqual(pos.safeToSpend);
    expect(b.needsClassification.amount).toBe(pos.needsClassificationWeek);
    // The breakdown's plan comparison reads known — the one figure that moved.
    expect(b.remaining).not.toBe(pos.remainingWeek);
  });

  it("the month: a monthly flag is the household's confirmation — known = actual; the spine's monthAllowance unchanged", async () => {
    const [m, spine] = await Promise.all([get(MONTH), get("/spine")]);
    expect(() => GetPeriodBreakdownResponse.parse(m)).not.toThrow();
    expect(m).toMatchObject({ actual: "120.00", known: "120.00", remaining: "280.00", provisional: false, unresolved: { amount: "0.00", count: 0 } });
    expect(spine.monthAllowance).toEqual({ plan: "400.00", actual: m.actual, status: "within", remaining: m.remaining, over: m.over });
    // The month's payments and transfers in scope (informational).
    expect(m.excludedPayments.rows.map((r: Json) => r.id)).toEqual(expect.arrayContaining([ids.amexPay, ids.toSav]));
  });

  it("account= scoping: the card's week has nothing unresolved; checking's carries all of it", async () => {
    const [card, checking] = await Promise.all([
      get(`${WEEK}&account=${acct.amex!.rowId}`),
      get(`${WEEK}&account=${acct.chase!.rowId}`),
    ]);
    expect(card).toMatchObject({ actual: "140.00", known: "140.00", unresolved: { amount: "0.00" }, provisional: false });
    expect(checking).toMatchObject({ actual: "1455.16", known: "139.76", unresolved: { amount: "1315.40" } });
    expect(cents(card.known) + cents(checking.known)).toBe(27976);
  });
});

describe("Q1 · the week contract — one name, one figure, on every surface", () => {
  it("⭐ position, spine, breakdown and the Banking household quote the same known / unresolved / provisional / left, to the cent", async () => {
    const [b, pos, spine, bank] = await Promise.all([
      get(WEEK),
      get("/money/position"),
      get("/spine"),
      get("/banking/review?from=2026-10-01&to=2026-10-14&rowsPerBucket=1"),
    ]);
    // By hand (file header): known 279.76 · unconfirmed 1,315.40 · provisional · left 300 − 279.76 = 20.24.
    expect(pos).toMatchObject({ knownWeek: "279.76", unresolvedWeek: "1315.40", provisional: true, remainingWeekKnown: "20.24" });
    // The cautious figures are unchanged (they still count the unconfirmed rows).
    expect(pos).toMatchObject({ spentWeekDiscretionary: "1595.16", remainingWeek: "-1295.16", withinPlan: "over" });
    expect(cents(pos.knownWeek) + cents(pos.unresolvedWeek)).toBe(cents(pos.spentWeekDiscretionary));
    // The breakdown's own figures.
    expect([b.known, b.unresolved.amount, b.provisional, b.remaining]).toEqual([pos.knownWeek, pos.unresolvedWeek, pos.provisional, pos.remainingWeekKnown]);
    // The spine: field for field.
    expect(spine.position).toMatchObject({
      knownWeek: pos.knownWeek,
      unresolvedWeek: pos.unresolvedWeek,
      provisional: pos.provisional,
      remainingWeekKnown: pos.remainingWeekKnown,
      remainingWeek: pos.remainingWeek,
    });
    // Banking's household block: the cautious total kept, the contract beside it.
    expect(() => GetBankingReviewResponse.parse(bank)).not.toThrow();
    expect(bank.household).toMatchObject({
      spentWeek: "1595.16",
      remainingWeek: "-1295.16",
      knownWeek: "279.76",
      unresolvedWeek: "1315.40",
      provisional: true,
      remainingWeekKnown: "20.24",
      weekPlan: "300.00",
    });
  });
});

describe("Q1 · Banking fields — in and out apart, each count with its scope, plans in their own direction", () => {
  it("each bucket: moneyIn and moneyOut are positive magnitudes and net = in − out; the inbox says what it counts", async () => {
    const r = await get("/banking/review?from=2026-10-01&to=2026-10-14&rowsPerBucket=50");
    expect(() => GetBankingReviewResponse.parse(r)).not.toThrow();
    let sawIn = false;
    let sawOut = false;
    for (const b of ["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"]) {
      const k = r.notInPlan[b];
      expect(cents(k.moneyIn), b).toBeGreaterThanOrEqual(0);
      expect(cents(k.moneyOut), b).toBeGreaterThanOrEqual(0);
      expect(cents(k.net), b).toBe(cents(k.moneyIn) - cents(k.moneyOut));
      // The rows listed (every one, at 50 a bucket) add up to in and out apart.
      if (!k.truncated) {
        const rows: Json[] = k.rows;
        expect(rows.filter((x) => cents(x.amount) > 0).reduce((a, x) => a + cents(x.amount), 0), b).toBe(cents(k.moneyIn));
        expect(rows.filter((x) => cents(x.amount) < 0).reduce((a, x) => a - cents(x.amount), 0), b).toBe(cents(k.moneyOut));
      }
      if (cents(k.moneyIn) > 0) sawIn = true;
      if (cents(k.moneyOut) > 0) sawOut = true;
    }
    // Not vacuous: money in (the payroll credit) and money out both sit in the buckets.
    expect([sawIn, sawOut]).toEqual([true, true]);
    expect(r.reviewInbox).toMatchObject({
      unresolvedScope: "this account · this period",
      unresolvedFrom: "2026-10-01",
      unresolvedTo: "2026-10-14",
      badgeScope: "this calendar month, forecast account",
    });
    expect(r.reviewInbox.unresolvedInRange).toEqual(expect.any(Number));
  });

  it("⭐ the paycheck reads received a different amount (income words); the bills read paid / not paid yet", async () => {
    const r = await get("/banking/review?from=2026-10-01&to=2026-10-14&rowsPerBucket=1");
    const planned = r.planned as Json[];
    const paycheck = planned.find((p) => p.itemId === item.paycheck && p.scheduledDate === "2026-10-09");
    // 2,391.40 arrived against 2,500.00 planned.
    expect(paycheck).toMatchObject({ eventKind: "income", direction: "in", varianceKind: "less_than_expected", outcome: "received_different" });
    for (const p of planned) {
      if (p.direction === "in") expect(p.outcome, p.label).not.toMatch(/^(paid|paid_different|not_paid_yet)$/);
      else expect(p.outcome, p.label).not.toMatch(/^(received|received_different|not_received_yet)$/);
    }
    // Every planned occurrence carries one.
    expect(planned.every((p) => typeof p.outcome === "string")).toBe(true);
  });
});

describe("F2 · banking review — direction-aware", () => {
  it("a payroll credit filed under Dining reads as money IN with a classification issue; its plan is income, less than expected", async () => {
    // The forecast took the paycheck as arrived (rule 4, automatic): an amount difference, in CASH terms.
    const r = await get("/banking/review?from=2026-10-01&to=2026-10-14&rowsPerBucket=50");
    expect(() => GetBankingReviewResponse.parse(r)).not.toThrow();
    const all: Json[] = ["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"].flatMap((b) => r.notInPlan[b].rows);
    const payroll = all.find((x) => x.id === ids.payroll);
    expect(payroll).toMatchObject({
      direction: "in",
      classificationIssue: "inflow_into_expense",
      reason: "amount",
      evidence: "automatic",
      plan: { eventKind: "income", direction: "in", expected: "2500.00", actual: "2391.40", variance: "-108.60", varianceKind: "less_than_expected" },
    });
    const lrk = all.find((x) => x.id === ids.lrk);
    expect(lrk).toMatchObject({ direction: "out", classificationIssue: null });
    // Money in and money out are never one ambiguous net.
    expect(r.notInPlan.amountDifference).toMatchObject({ varianceIn: "-108.60" });
    // The direction-blind difference says +/− the other way for an expense; for this income it is −108.60 too.
    expect(payroll.plan.difference).toBe("-108.60");
    const paycheck = (r.planned as Json[]).find((p) => p.itemId === item.paycheck && p.scheduledDate === "2026-10-09");
    expect(paycheck).toMatchObject({ eventKind: "income", direction: "in", expected: "2500.00" });
    const heloc = (r.planned as Json[]).find((p) => p.itemId === item.heloc);
    expect(heloc).toMatchObject({ eventKind: "bill", direction: "out", expected: "1110.00" });
  });
});

describe("F2 · GET /review/proposals — evidence-backed, read-only, owner only", () => {
  it("⭐ the proposals by hand, largest first; each names the existing app action that applies it", async () => {
    const p = await get("/review/proposals");
    if (process.env.F2_PRINT_SAMPLE) writeFileSync(`${process.env.F2_PRINT_SAMPLE}.proposals.json`, JSON.stringify(p, null, 2));
    expect(() => GetReviewProposalsResponse.parse(p)).not.toThrow();
    expect(p.window).toEqual({ from: "2026-06-17", to: "2026-10-14", days: 120 });
    expect(p.items.map((i: Json) => [i.kind, i.action.code, i.action.target.label, i.total, i.rowCount])).toEqual([
      ["loan_payment", "file_as_bill_payment", "HELOC", "3451.20", 3],
      ["income_category", "file_under_income_category", "Pat's paycheck (Mapleworks)", "2391.40", 1],
      ["loan_payment", "file_as_debt_payment", "Upland Loan", "250.00", 1],
      ["bill_match", "confirm_bill_match", "Shieldline Life", "95.00", 1],
      ["transfer", "file_as_transfer", "Transfer", "20.00", 1],
    ]);
    expect(p.count).toBe(5);
    const [heloc, income, upland, bill, transfer] = p.items;
    // The HELOC series: the two filed as Other income and this week's pending payment.
    expect(heloc.rows.map((r: Json) => [r.id, r.date, r.amount, r.occurrence?.occurrenceDate])).toEqual([
      [ids.lrk, "2026-10-13", "-1150.40", "2026-10-03"],
      [ids.larkSep, "2026-09-14", "-1150.40", "2026-09-03"],
      [ids.larkAug, "2026-08-13", "-1150.40", "2026-08-03"],
    ]);
    expect(heloc.action.target).toEqual({ kind: "bill", id: item.heloc, label: "HELOC", categoryId: cat.heloc, categoryName: "HELOC (Larkspur)" });
    expect(heloc.applyWith).toEqual(["categories_change", "review_mark_matched"]);
    expect(heloc.evidence).toEqual(
      expect.arrayContaining([
        { field: "pfc_primary", value: "LOAN_PAYMENTS" },
        { field: "name_match", value: "LARKSPUR LENDING ~ HELOC (Larkspur)" },
        { field: "amount_match", value: "1150.40 ~ 1110.00" },
        { field: "same_amount_rows", value: "3" },
      ]),
    );
    expect(income.action.target).toMatchObject({ kind: "category", id: cat.paycheck, categoryName: "Paycheck" });
    expect(income.rows[0]).toMatchObject({ id: ids.payroll, category: { id: cat.dining, name: "Dining & Coffee" } });
    expect(income.applyWith).toEqual(["categories_change"]);
    expect(upland.action.target).toMatchObject({ kind: "debt", id: uplandDebt, label: "Upland Loan", categoryId: null });
    expect(upland.rows[0]).toMatchObject({ id: ids.upland, occurrence: { recurringItemId: `debt:${uplandDebt}`, occurrenceDate: "2026-09-20" } });
    expect(upland.applyWith).toEqual(["review_mark_matched"]);
    expect(bill.rows[0]).toMatchObject({ id: ids.shield, occurrence: { recurringItemId: item.shieldLife, occurrenceDate: "2026-10-20" } });
    expect(bill.applyWith).toEqual(["review_mark_matched"]);
    expect(transfer.action.target).toMatchObject({ kind: "category", id: cat.transfer, label: "Transfer" });
    expect(transfer.rows.map((r: Json) => r.id)).toEqual([ids.pear]);
    // Never a guess: two bills fit RIDGEWAY FINANCE; the ATM, the Zelle and the coffee are purchases.
    const proposed = new Set(p.items.flatMap((i: Json) => i.rows.map((r: Json) => r.id)));
    for (const k of ["ridgeway", "atm", "zelle", "coffee", "paypal", "valley", "grocery"]) expect(proposed.has(ids[k]), k).toBe(false);
  });

  it("writes nothing", async () => {
    const snapshot = async () => {
      const hh = HH[F]!.householdId;
      const [t] = await db.select({ n: count() }).from(transactionsTable).where(eq(transactionsTable.householdId, hh));
      const [r] = await db.select({ n: count() }).from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, hh));
      const [m] = await db.select({ n: count() }).from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, hh));
      const [d] = await db.select({ n: count() }).from(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, hh));
      const rows = await db
        .select({ id: transactionsTable.id, c: transactionsTable.categoryId, x: transactionsTable.isTransfer, d: transactionsTable.debtId })
        .from(transactionsTable)
        .where(eq(transactionsTable.householdId, hh));
      return JSON.stringify({ t, r, m, d, rows: rows.sort((a, b) => a.id.localeCompare(b.id)) });
    };
    const before = await snapshot();
    await get("/review/proposals");
    expect(await snapshot()).toBe(before);
  });

  it("a household member who is not its owner is refused", async () => {
    const r = await call("GET", "/review/proposals", MEMBER);
    expect(r).toEqual({ status: 403, body: { error: "owner_only" } });
  });
});

describe("F2 · the review queue's direction guard and sign-aware merchant memory (household G)", () => {
  const hh = () => HH[G]!.householdId;

  async function queueDecision(txnKey: string, categoryKey: string): Promise<string> {
    const [d] = await db
      .insert(categoryDecisionsTable)
      .values({
        householdId: hh(),
        transactionId: ids[txnKey]!,
        source: "memory",
        categoryId: cat[categoryKey]!,
        previousCategoryId: null,
        confidence: "0.500",
        band: "queue",
        explanation: "test",
        inputHash: `f2-${txnKey}-${randomUUID()}`,
      })
      .returning({ id: categoryDecisionsTable.id });
    return d!.id;
  }
  const rowOf = async (key: string) =>
    (await db.select().from(transactionsTable).where(eq(transactionsTable.id, ids[key]!)))[0]!;
  const decisionOf = async (id: string) =>
    (await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, id)))[0]!;

  it("Accept refuses an expense category for a payroll credit, and an income category for a card purchase — 409, nothing written", async () => {
    const payrollToDining = await queueDecision("gPayroll1", "gDining");
    const r = await call("POST", `/categorization/review/${payrollToDining}/accept`, G);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "Money in, but this would file it under an expense category.", code: "direction_conflict", conflict: "inflow_into_expense" });
    expect(await rowOf("gPayroll1")).toMatchObject({ categoryId: null, categoryLockedByUser: false });
    expect(await decisionOf(payrollToDining)).toMatchObject({ resolvedAt: null, resolution: null });

    const cafeToPaycheck = await queueDecision("gCafe2", "gPaycheck");
    const r2 = await call("POST", `/categorization/review/${cafeToPaycheck}/accept`, G);
    expect(r2).toMatchObject({ status: 409, body: { code: "direction_conflict", conflict: "outflow_into_income" } });
    // Change refuses the same: a correction into the wrong direction.
    const r3 = await call("POST", `/categorization/review/${cafeToPaycheck}/correct`, G, { categoryId: cat.gPaycheck });
    expect(r3).toMatchObject({ status: 409, body: { conflict: "outflow_into_income" } });
    expect(await rowOf("gCafe2")).toMatchObject({ categoryId: null });
    expect((await db.select({ n: count() }).from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, hh())))[0]!.n).toBe(0);
  });

  it("a refund on a card into its purchase category, and a transfer, are never a conflict", async () => {
    const refund = await queueDecision("gRefund", "gGroceries");
    expect((await call("POST", `/categorization/review/${refund}/accept`, G)).status).toBe(200);
    expect(await rowOf("gRefund")).toMatchObject({ categoryId: cat.gGroceries, categoryLockedByUser: true });
    const xfer = await queueDecision("gXfer", "gPaycheck");
    expect((await call("POST", `/categorization/review/${xfer}/accept`, G)).status).toBe(200);
  });

  it("⭐ a payroll credit and same-name card purchases never share a memory", async () => {
    // A cafeteria charge filed by hand under Dining: money OUT learns the plain signature.
    await recordHandFiling(hh(), G, ids.gCafe1!, { previousCategoryId: null, categoryId: cat.gDining! });
    // The paycheck corrected into Paycheck in the queue: money IN learns `in:<signature>`.
    const payroll = await queueDecision("gPayroll1", "gDining");
    const r = await call("POST", `/categorization/review/${payroll}/correct`, G, { categoryId: cat.gPaycheck });
    expect(r.status).toBe(200);
    const memory = await db
      .select({ signature: merchantMemoryTable.signature, categoryId: merchantMemoryTable.categoryId, count: merchantMemoryTable.count, scope: merchantMemoryTable.scope })
      .from(merchantMemoryTable)
      .where(and(eq(merchantMemoryTable.householdId, hh())));
    // The refund accepted above learned its own money-in key too.
    const relevant = memory.filter((m) => /mapleworks|grocery/.test(m.signature));
    expect(relevant.sort((a, b) => a.signature.localeCompare(b.signature))).toEqual([
      { signature: "in:grocery mart", categoryId: cat.gGroceries, count: 1, scope: "merchant" },
      { signature: "in:mapleworks inc", categoryId: cat.gPaycheck, count: 1, scope: "merchant" },
      { signature: "mapleworks inc", categoryId: cat.gDining, count: 1, scope: "merchant" },
    ]);
    // The learned rules say the plain merchant and which way the money moves.
    const rules: Json[] = await get("/learned-rules", G);
    expect(rules.filter((x) => x.signature === "mapleworks inc").map((x) => [x.direction, x.categoryId]).sort()).toEqual([
      ["in", cat.gPaycheck],
      ["out", cat.gDining],
    ]);

    // The engine reads them apart: the next paycheck → Paycheck, the next cafeteria charge → Dining.
    const base = await rowOf("gPayroll1");
    const engineRow = (o: Partial<EngineRow>): EngineRow => ({
      id: randomUUID(),
      description: base.description,
      amount: base.amount,
      source: base.source,
      plaidAccountId: base.plaidAccountId,
      pfcPrimary: null,
      pfcDetailed: null,
      pending: false,
      occurredOn: "2026-10-23",
      // Memory applies to rows that arrived after it was learned (the DB stamps memory with its own clock).
      createdAt: new Date("2099-01-01T12:00:00Z"),
      categoryId: null,
      categoryLockedByUser: false,
      categoryProvisional: false,
      isTransfer: false,
      isTransferUserOverridden: false,
      isExternalCardPayment: false,
      debtId: null,
      reimbursable: false,
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      weeklyBucket: null,
      refundOfTxnId: null,
      ...o,
    });
    const nextPay = engineRow({});
    const nextCafe = engineRow({ description: "MAPLEWORKS INC", amount: "-7.75", source: "plaid:amex", plaidAccountId: acct.gamex!.ext });
    const ctx = await loadEngineContext(hh(), [nextPay, nextCafe]);
    expect(memoryStage(nextPay, ctx)).toMatchObject({ source: "memory", categoryId: cat.gPaycheck });
    expect(memoryStage(nextCafe, ctx)).toMatchObject({ source: "memory", categoryId: cat.gDining });
  });
});
