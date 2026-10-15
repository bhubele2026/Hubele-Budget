// ⭐ (Q2) A PROPOSED FIX: PREVIEW, APPLY, UNDO — synthetic. Every name, amount
// and account number is made up; the household is F2's (f2Classification), plus
// one cafeteria charge that shares the payroll's merchant name.
//
// Today is Wed 2026-10-14 12:00 America/Chicago; the household week is Sun
// 10/11 – Sat 10/17. Chase checking ••4321 (the forecast's), Amex ••1009.
// Weekly plan $300, monthly $400.
//
// The five proposals (GET /review/proposals, largest first):
//   loan_payment     LARKSPUR LENDING 8/13, 9/14 (filed "Other income") + LRK LOANS 10/13 (pending,
//                    unfiled) → the HELOC bill (category "HELOC (Larkspur)"), occurrences 8/03 9/03 10/03
//   income_category  MAPLEWORKS payroll +2,391.40 (10/09, filed Dining) → Paycheck
//   loan_payment     UPLAND LOAN PMT 9/20 −250.00 → the Upland Loan debt's 9/20 minimum (no category)
//   bill_match       SHIELDLINE INS 10/12 −95.00 (Health) → Shieldline Life 10/20
//   transfer         PEAR GS SAVINGS 10/13 −20.00 (pending, Subscriptions) → Transfer
//
// By hand, this week before any fix (F2's figures): actual 1,595.16 · known 279.76 ·
// unresolved 1,315.40 (LRK 1,150.40 + SHIELDLINE 95 + VALLEY 50 + PEAR 20).
//   transfer   → PEAR leaves spending:            actual 1,575.16 · unresolved 1,295.40
//   bill_match → SHIELDLINE is a bill paid:        actual 1,500.16 · unresolved 1,220.40
//   HELOC      → LRK is the HELOC's payment:      actual   444.76 · unresolved   165.00
// The October Budget: Paycheck's line +2,391.40 (income), Dining's spend unchanged
// (a credit was never Dining spend); HELOC's line +1,150.40 (LRK).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const F = `q2-f-${tag}`;
const MEMBER = `q2-m-${tag}`;
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
    const hh = HH[F]!;
    req.userId = who === MEMBER ? MEMBER : hh.ownerUserId;
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
  correctionApplicationsTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  merchantMemoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  ApplyReviewProposalResponse,
  GetReviewProposalsResponse,
  ListAppliedReviewProposalsResponse,
  UndoAppliedReviewProposalResponse,
} from "@workspace/api-zod";
import moneyRouter from "../routes/money";
import bankingRouter from "../routes/banking";
import budgetRouter from "../routes/budget";
import reviewProposalsRouter from "../routes/reviewProposals";
import transactionsRouter from "../routes/transactions";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { loadEngineContext } from "../lib/categorizer/context";
import { memoryStage } from "../lib/categorizer/stages/memory";
import type { EngineRow } from "../lib/categorizer/types";
// (Q1) The ledger as the fix would leave it, beside the ledger once it is applied.
import { computeCashSignalDetailed, computeCashSignalWithOverlay, type DetailedCashSignal } from "../lib/cashSignal";
import { overlayForProposal } from "../lib/reviewCorrections";
import { resolveDecision } from "../lib/categorizer/review";

const NOW = new Date("2026-10-14T12:00:00-05:00");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(bankingRouter);
app.use(budgetRouter);
app.use(reviewProposalsRouter);
app.use(transactionsRouter);

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

const ids: Record<string, string> = {};
const acct: Record<string, { rowId: string; ext: string }> = {};
const cat: Record<string, string> = {};
const item: Record<string, string> = {};
let uplandDebt = "";
const hh = () => HH[F]!.householdId;

async function cleanup(): Promise<void> {
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length === 0) return;
  await db.delete(correctionApplicationsTable).where(inArray(correctionApplicationsTable.householdId, hhIds));
  await db.delete(categoryDecisionsTable).where(inArray(categoryDecisionsTable.householdId, hhIds));
  await db.delete(merchantMemoryTable).where(inArray(merchantMemoryTable.householdId, hhIds));
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.householdId, hhIds));
  await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, hhIds));
  await db.delete(transactionsTable).where(inArray(transactionsTable.householdId, hhIds));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.householdId, hhIds));
  await db.delete(debtsTable).where(inArray(debtsTable.householdId, hhIds));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.householdId, hhIds));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, [F]));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.householdId, hhIds));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.householdId, hhIds));
}

async function seedAccount(key: string, inst: string, name: string, mask: string, type: string, subtype: string): Promise<void> {
  const owned = { userId: F, householdId: hh() };
  const [it] = await db
    .insert(plaidItemsTable)
    .values({
      ...owned,
      itemId: `q2-item-${key}-${randomUUID()}`,
      accessToken: "t",
      institutionName: inst,
      institutionSlug: type === "credit" ? "amex" : "chase",
      lastSyncedAt: new Date("2026-10-14T09:00:00-05:00"),
    })
    .returning();
  const ext = `q2-${key}-${randomUUID().slice(0, 8)}`;
  const [r] = await db.insert(plaidAccountsTable).values({ ...owned, itemId: it!.id, accountId: ext, name, mask, type, subtype }).returning();
  acct[key] = { rowId: r!.id, ext };
}

async function seedCategory(key: string, name: string, kind: "expense" | "income", excludeFromBudget = false): Promise<void> {
  const [c] = await db.insert(budgetCategoriesTable).values({ userId: F, householdId: hh(), name, kind, groupName: "Q2", excludeFromBudget }).returning();
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

async function seedTxns(rows: TxnSpec[]): Promise<void> {
  for (const r of rows) {
    const a = acct[r.account]!;
    const [t] = await db
      .insert(transactionsTable)
      .values({
        userId: F,
        householdId: hh(),
        occurredOn: r.on,
        createdAt: createdAtStartOfHouseholdDay(r.on),
        description: r.desc,
        amount: r.amount,
        plaidAccountId: a.ext,
        plaidTransactionId: `q2-${r.key}-${randomUUID().slice(0, 8)}`,
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

async function seedBill(key: string, name: string, kind: "bill" | "income", amount: string, freq: string, dayOfMonth: number | null, anchor: string, category?: string): Promise<void> {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({ userId: F, householdId: hh(), name, kind, amount, frequency: freq, dayOfMonth, anchorDate: anchor, active: "true", categoryId: category ? cat[category]! : null })
    .returning();
  item[key] = r!.id;
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH[F] = await createTestHousehold(F);
  await cleanup();
  const f = { userId: F, householdId: hh() };
  await seedAccount("chase", "Chase", "Total Checking", "4321", "depository", "checking");
  await seedAccount("amex", "American Express", "Blue Card", "1009", "credit", "credit card");
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
  await seedCategory("groceries", "Groceries", "expense");
  await seedCategory("dining", "Dining & Coffee", "expense");
  await seedCategory("subs", "Subscriptions", "expense");
  await seedCategory("health", "Health", "expense");
  await seedCategory("insurance", "Insurance", "expense");
  await seedCategory("heloc", "HELOC (Larkspur)", "expense");
  await seedCategory("home", "Home", "expense");
  // The system-managed Transfer category, as the app seeds it: out of the Budget, teaches no memory.
  await seedCategory("transfer", "Transfer", "expense", true);
  await seedCategory("otherIncome", "Other income", "income");
  await seedCategory("paycheck", "Paycheck", "income");
  await db.insert(allowancePlansTable).values([
    { householdId: hh(), memberUserId: null, period: "weekly", amount: "300.00", effectiveFrom: "2026-05-01", source: "owner" },
    { householdId: hh(), memberUserId: null, period: "monthly", amount: "400.00", effectiveFrom: "2026-05-01", source: "owner" },
  ]);
  await seedBill("heloc", "HELOC", "bill", "1110", "monthly", 3, "2026-05-03", "heloc");
  await seedBill("shieldLife", "Shieldline Life", "bill", "95", "monthly", 20, "2026-10-20", "insurance");
  await seedBill("shieldAuto", "Shieldline Auto", "bill", "210", "monthly", 25, "2026-10-25", "insurance");
  await seedBill("ridgeBoat", "Ridgeway Boat", "bill", "300", "monthly", 1, "2026-10-01");
  await seedBill("ridgeCamper", "Ridgeway Camper", "bill", "300", "monthly", 1, "2026-10-01");
  await seedBill("paycheck", "Pat's paycheck (Mapleworks)", "income", "2500", "biweekly", null, "2026-10-09", "paycheck");
  const [d] = await db
    .insert(debtsTable)
    .values({ ...f, name: "Upland Loan", balance: "5000.00", originalBalance: "5000.00", apr: "0.0900", minPayment: "200", payment: "0", dueDay: 20, type: "personal_loan", createdAt: new Date("2026-01-01T12:00:00-06:00") })
    .returning();
  uplandDebt = d!.id;

  await seedTxns([
    { key: "larkAug", on: "2026-08-13", desc: "LARKSPUR LENDING", amount: "-1150.40", account: "chase", category: "otherIncome", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT" },
    { key: "larkSep", on: "2026-09-14", desc: "LARKSPUR LENDING", amount: "-1150.40", account: "chase", category: "otherIncome", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT" },
    { key: "upland", on: "2026-09-20", desc: "UPLAND LOAN PMT", amount: "-250.00", account: "chase", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" },
    { key: "ridgeway", on: "2026-09-16", desc: "RIDGEWAY FINANCE", amount: "-300.00", account: "chase", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT" },
    { key: "homeGoods", on: "2026-10-02", desc: "HOME GOODS", amount: "-120.00", account: "amex", category: "home", monthly: true, pfcPrimary: "GENERAL_MERCHANDISE" },
    { key: "payroll", on: "2026-10-09", desc: "ORIG CO NAME:MAPLEWORKS INC CO ENTRY DESCR:PAYROLL SEC:PPD ORIG ID:9001", amount: "2391.40", account: "chase", category: "dining", pfcPrimary: "INCOME", pfcDetailed: "INCOME_SALARY" },
    // The office cafeteria: the payroll's merchant name, money OUT, filed Dining by hand last week.
    { key: "cafe", on: "2026-10-05", desc: "MAPLEWORKS INC", amount: "-8.50", account: "amex", category: "dining", weekly: true, pfcPrimary: "FOOD_AND_DRINK" },
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

// ── Helpers ────────────────────────────────────────────────────────────────

const proposals = async (): Promise<Json[]> => (await get("/review/proposals")).items;
const proposalOf = async (kind: string, label?: string): Promise<Json> => {
  const p = (await proposals()).find((x) => x.kind === kind && (!label || x.action.target.label === label));
  if (!p) throw new Error(`no ${kind} ${label ?? ""} proposal`);
  return p;
};
const applyPath = (p: Json, dryRun = false) => `/review/proposals/${encodeURIComponent(p.key)}/apply${dryRun ? "?dryRun=1" : ""}`;
const bodyOf = (p: Json) => ({ rowIds: p.rows.map((r: Json) => r.id), proposalHash: p.proposalHash });
const preview = async (p: Json): Promise<Json> => {
  const r = await call("POST", applyPath(p, true), F, bodyOf(p));
  if (r.status !== 200) throw new Error(`dry run -> ${r.status} ${JSON.stringify(r.body)}`);
  expect(() => ApplyReviewProposalResponse.parse(r.body)).not.toThrow();
  return r.body;
};
const apply = async (p: Json): Promise<Json> => {
  const r = await call("POST", applyPath(p), F, bodyOf(p));
  if (r.status !== 200) throw new Error(`apply -> ${r.status} ${JSON.stringify(r.body)}`);
  expect(() => ApplyReviewProposalResponse.parse(r.body)).not.toThrow();
  return r.body;
};
const undo = async (applicationId: string): Promise<Json> => {
  const r = await call("POST", `/review/proposals/applied/${applicationId}/undo`);
  if (r.status !== 200) throw new Error(`undo -> ${r.status} ${JSON.stringify(r.body)}`);
  expect(() => UndoAppliedReviewProposalResponse.parse(r.body)).not.toThrow();
  return r.body;
};

const periodOf = (b: Json) => ({ start: b.start, end: b.end, plan: b.plan.amount, actual: b.actual, known: b.known, unresolved: b.unresolved.amount, remaining: b.remaining, over: b.over });

/** The figures as the screens' own endpoints serve them NOW, in the dry run's scope. */
async function figuresNow(dry: Json): Promise<Json> {
  const [week, month] = await Promise.all([
    get(`/money/period-breakdown?period=week&start=${dry.figures.week.before.start}&rowsPerGroup=1`),
    get(`/money/period-breakdown?period=month&start=${dry.figures.month.before.start}&rowsPerGroup=1`),
  ]);
  const budgetMonths = await Promise.all(
    dry.figures.budgetMonths.map(async (m: Json) => {
      const v = await get(`/budget/months/${m.monthStart}`);
      const want = new Set([...m.before.lines, ...m.after.lines].map((l: Json) => l.categoryId));
      return {
        monthStart: m.monthStart,
        income: v.summary.income.actual,
        expenses: v.summary.expenses.actual,
        net: v.summary.net.actual,
        lines: v.lines.filter((l: Json) => want.has(l.categoryId)).map((l: Json) => ({ categoryId: l.categoryId, name: l.categoryName, kind: l.kind, actual: l.actualAmount })),
      };
    }),
  );
  const banking = await Promise.all(
    dry.figures.banking.map(async (b: Json) => {
      const r = await get(`/banking/review?account=${b.account.id}&from=${b.from}&to=${b.to}&rowsPerBucket=1`);
      const bucket = (x: Json) => ({ count: x.count, moneyIn: x.moneyIn, moneyOut: x.moneyOut, net: x.net });
      return {
        buckets: Object.fromEntries(["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"].map((k) => [k, bucket(r.notInPlan[k])])),
        asPlanned: { count: r.asPlanned.count, net: r.asPlanned.net },
        unresolvedInRange: r.reviewInbox.unresolvedInRange,
        reconciliation: r.reconciliation,
      };
    }),
  );
  return { week: periodOf(week), month: periodOf(month), budgetMonths, banking };
}

/** (Q1) What the forecast ledger decided, comparable across two builds: the curve, the pairs, each plan's fate. */
const ledgerView = (c: DetailedCashSignal) => ({
  bankToday: c.signal.bankToday,
  low: [c.signal.lowestProjected, c.signal.lowestDate],
  daily: (c.signal.daily ?? []).map((d) => [d.date, d.balance]),
  matches: c.ledger.matches.map((m) => JSON.stringify([m.txnId, m.planKey, m.tier, m.offCurve])).sort(),
  occurrences: c.ledger.planOccurrences
    .map((o) => JSON.stringify([o.planKey, o.fate, o.txnId, o.amount, o.txnAmount, o.remainder, o.onCurve]))
    .sort(),
});

const side = (dry: Json, which: "before" | "after") => ({
  week: dry.figures.week[which],
  month: dry.figures.month[which],
  budgetMonths: dry.figures.budgetMonths.map((m: Json) => ({ monthStart: m.monthStart, ...m[which] })),
});

/** Everything a fix may touch, for "writes nothing" and "undo restores exactly". */
async function snapshot(): Promise<string> {
  const rows = await db
    .select({
      id: transactionsTable.id,
      categoryId: transactionsTable.categoryId,
      locked: transactionsTable.categoryLockedByUser,
      provisional: transactionsTable.categoryProvisional,
      isTransfer: transactionsTable.isTransfer,
      override: transactionsTable.isTransferUserOverridden,
      weekly: transactionsTable.weeklyAllowance,
      monthly: transactionsTable.monthlyAllowance,
      unplanned: transactionsTable.unplannedAllowance,
      debtId: transactionsTable.debtId,
    })
    .from(transactionsTable)
    .where(eq(transactionsTable.householdId, hh()));
  const resolutions = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, hh()));
  const memory = await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, hh()));
  const by = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ rows: by(rows), resolutions: by(resolutions), memory: by(memory) });
}
const decisionsSnapshot = async () =>
  JSON.stringify(
    (
      await db
        .select({ id: categoryDecisionsTable.id, resolvedAt: categoryDecisionsTable.resolvedAt, resolution: categoryDecisionsTable.resolution, resolvedVia: categoryDecisionsTable.resolvedVia, undoneAt: categoryDecisionsTable.undoneAt })
        .from(categoryDecisionsTable)
        .where(eq(categoryDecisionsTable.householdId, hh()))
    ).sort((a, b) => a.id.localeCompare(b.id)),
  );

const cents = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 100);

// ── Row links ──────────────────────────────────────────────────────────────

describe("Q2 · proposal rows link straight to their record", () => {
  it("each row carries its account's external Plaid id and its source; each proposal a hash", async () => {
    const p = await get("/review/proposals");
    expect(() => GetReviewProposalsResponse.parse(p)).not.toThrow();
    expect(p.items.map((i: Json) => [i.kind, i.action.target.label])).toEqual([
      ["loan_payment", "HELOC"],
      ["income_category", "Pat's paycheck (Mapleworks)"],
      ["loan_payment", "Upland Loan"],
      ["bill_match", "Shieldline Life"],
      ["transfer", "Transfer"],
    ]);
    const heloc = p.items[0];
    expect(heloc.rows[0]).toMatchObject({
      id: ids.lrk,
      source: "plaid:chase",
      account: { id: acct.chase!.rowId, externalId: acct.chase!.ext, name: "Total Checking", mask: "4321", institution: "Chase" },
    });
    for (const i of p.items) expect(i.proposalHash).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(p.items.map((i: Json) => i.proposalHash)).size).toBe(5);
    // Stable: the same proposal, read again, has the same hash.
    expect((await get("/review/proposals")).items.map((i: Json) => i.proposalHash)).toEqual(p.items.map((i: Json) => i.proposalHash));
  });
});

// ── Refusals ───────────────────────────────────────────────────────────────

describe("Q2 · refusals write nothing", () => {
  it("a member who is not the owner: 403 on apply, dry run, undo and history", async () => {
    const p = await proposalOf("transfer");
    expect(await call("POST", applyPath(p), MEMBER, bodyOf(p))).toEqual({ status: 403, body: { error: "owner_only" } });
    expect(await call("POST", applyPath(p, true), MEMBER, bodyOf(p))).toEqual({ status: 403, body: { error: "owner_only" } });
    expect((await call("POST", `/review/proposals/applied/${randomUUID()}/undo`, MEMBER)).status).toBe(403);
    expect((await call("GET", "/review/proposals/applied", MEMBER)).status).toBe(403);
  });

  it("a changed proposal (another hash, other rows) and a gone one: 409, nothing written", async () => {
    const before = await snapshot();
    const p = await proposalOf("transfer");
    const wrongHash = await call("POST", applyPath(p), F, { ...bodyOf(p), proposalHash: "0".repeat(32) });
    expect(wrongHash).toMatchObject({ status: 409, body: { code: "proposal_changed", proposalHash: p.proposalHash } });
    const otherRows = await call("POST", applyPath(p), F, { rowIds: [ids.coffee], proposalHash: p.proposalHash });
    expect(otherRows).toMatchObject({ status: 409, body: { code: "proposal_changed" } });
    const gone = await call("POST", `/review/proposals/${encodeURIComponent("transfer:nothing|here")}/apply`, F, bodyOf(p));
    expect(gone).toMatchObject({ status: 409, body: { code: "proposal_gone" } });
    expect((await call("POST", applyPath(p), F, { rowIds: [], proposalHash: p.proposalHash })).status).toBe(400);
    expect(await snapshot()).toBe(before);
    expect(await db.select().from(correctionApplicationsTable).where(eq(correctionApplicationsTable.householdId, hh()))).toEqual([]);
  });

  it("an undo of nothing: 404", async () => {
    expect(await call("POST", `/review/proposals/applied/${randomUUID()}/undo`)).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect((await call("POST", "/review/proposals/applied/not-a-uuid/undo")).status).toBe(404);
  });
});

// ── Each kind: dry run, apply = dry run, undo exact ────────────────────────

/** Dry run → nothing written → apply → the endpoints equal the dry run's "after" → undo → everything as it was. */
async function roundTrip(kind: string, label: string | undefined, check: (dry: Json, applied: Json) => Promise<void>) {
  const p = await proposalOf(kind, label);
  const before = await snapshot();
  const decisionsBefore = await decisionsSnapshot();
  const figuresBefore = await figuresNow(await preview(p));

  const dry = await preview(p);
  // (Q1) The ledger the dry run reads for "after": built with the fix's overlay, before it is written.
  const ledgerPreview = ledgerView(
    await computeCashSignalWithOverlay(hh(), F, { horizonDays: 90 }, await overlayForProposal(hh(), F, p.key, bodyOf(p))),
  );
  const ledgerBefore = ledgerView(await computeCashSignalDetailed(hh(), F, { horizonDays: 90 }));
  expect(await snapshot()).toBe(before);
  expect(await decisionsSnapshot()).toBe(decisionsBefore);
  // The dry run's "before" is what the screens show now.
  expect(side(dry, "before")).toEqual({ week: figuresBefore.week, month: figuresBefore.month, budgetMonths: figuresBefore.budgetMonths });
  for (const [i, b] of dry.figures.banking.entries()) {
    const { reconciliation: _r, ...now } = figuresBefore.banking[i];
    expect(b.before).toEqual(now);
    // (Q1) The Banking buckets are previewed now (they were null: banking_after_not_previewed).
    expect(b.after).not.toBeNull();
  }
  // (Q1) Neither old limitation is said any more.
  expect(dry.limitations).not.toContain("banking_after_not_previewed");
  expect(dry.limitations).not.toContain("forecast_pairs_as_before");

  const applied = await apply(p);
  expect(applied).toMatchObject({ dryRun: false, proposal: { key: p.key, kind, proposalHash: p.proposalHash } });
  // ⭐ The applied result equals the dry run.
  const after = await figuresNow(dry);
  expect({ week: after.week, month: after.month, budgetMonths: after.budgetMonths }).toEqual(side(dry, "after"));
  // ⭐ (Q1) …the Banking buckets too, and the forecast ledger: the pairing previewed IS the pairing applied.
  for (const [i, b] of dry.figures.banking.entries()) {
    const { reconciliation: _r, ...now } = after.banking[i];
    expect(b.after).toEqual(now);
  }
  const ledgerApplied = ledgerView(await computeCashSignalDetailed(hh(), F, { horizonDays: 90 }));
  expect(ledgerPreview).toEqual(ledgerApplied);
  if (kind === "bill_match" || kind === "loan_payment") expect(ledgerApplied.occurrences).not.toEqual(ledgerBefore.occurrences);
  // No figure counts a row twice: known + unresolved = actual; Banking places every row once.
  for (const per of [after.week, after.month]) expect(cents(per.known) + cents(per.unresolved)).toBe(cents(per.actual));
  for (const b of after.banking) expect(b.reconciliation.unexplained).toBe("0.00");
  await check(dry, applied);

  // Double apply: the proposal is gone (its rows are filed / answered).
  expect(await call("POST", applyPath(p), F, bodyOf(p))).toMatchObject({ status: 409, body: { code: "proposal_gone" } });

  // ⭐ Undo restores every field and every answer exactly.
  const u = await undo(applied.applicationId);
  expect(u.applicationId).toBe(applied.applicationId);
  expect(await snapshot()).toBe(before);
  const back = await figuresNow(dry);
  expect({ week: back.week, month: back.month, budgetMonths: back.budgetMonths }).toEqual(side(dry, "before"));
  // The fix's own decisions are marked undone; the proposal is back, with the same hash.
  const mine = await db.select().from(categoryDecisionsTable).where(and(eq(categoryDecisionsTable.householdId, hh()), eq(categoryDecisionsTable.source, "user")));
  for (const r of applied.rows.filter((x: Json) => x.decisionId)) {
    expect(mine.find((d) => d.id === r.decisionId)!.undoneAt).not.toBeNull();
  }
  expect((await proposalOf(kind, label)).proposalHash).toBe(p.proposalHash);
  // A second undo is refused.
  expect(await call("POST", `/review/proposals/applied/${applied.applicationId}/undo`)).toMatchObject({ status: 409, body: { code: "already_undone" } });
  return { dry, applied, undone: u };
}

describe("Q2 · transfer — PEAR GS SAVINGS → Transfer", () => {
  it("⭐ preview, apply = preview, undo restores the category AND the flags", async () => {
    await roundTrip("transfer", undefined, async (dry, applied) => {
      expect(dry.rows).toHaveLength(1);
      expect(dry.rows[0]).toMatchObject({
        id: ids.pear,
        before: { categoryId: cat.subs, isTransfer: false, isTransferUserOverridden: false, categoryLockedByUser: false },
        after: { categoryId: cat.transfer, isTransfer: true, isTransferUserOverridden: true, categoryLockedByUser: true, weeklyAllowance: false },
        resolution: null,
      });
      expect(dry.learnsMemory).toBe(false);
      // (Q1) Was ["banking_after_not_previewed"]: the Banking buckets are previewed now.
      expect(dry.limitations).toEqual([]);
      // By hand: PEAR's 20.00 leaves the week's spending.
      expect(dry.figures.week.before).toMatchObject({ actual: "1595.16", known: "279.76", unresolved: "1315.40" });
      expect(dry.figures.week.after).toMatchObject({ actual: "1575.16", known: "279.76", unresolved: "1295.40" });
      expect(applied.learnedMemory).toBe(false);
      const [row] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, ids.pear!));
      expect(row).toMatchObject({ categoryId: cat.transfer, isTransfer: true });
    });
  });
});

describe("Q2 · bill_match — SHIELDLINE INS → Shieldline Life 10/20", () => {
  it("⭐ marks it matched (one answer); apply = preview; undo removes the answer", async () => {
    await roundTrip("bill_match", undefined, async (dry, applied) => {
      expect(dry.rows[0]).toMatchObject({
        id: ids.shield,
        resolution: { recurringItemId: item.shieldLife, occurrenceDate: "2026-10-20", status: "matched" },
      });
      expect(dry.rows[0].after).toEqual(dry.rows[0].before);
      expect(dry.replaces).toEqual([]);
      // (Q1) Was ["forecast_pairs_as_before", "banking_after_not_previewed"]: the ledger and Banking are rebuilt now.
      expect(dry.limitations).toEqual([]);
      expect(dry.figures.week.after).toMatchObject({ actual: "1500.16", known: "279.76", unresolved: "1220.40" });
      // (Q1) Banking previewed: the 95.00 row was a suggested match (uncertain); confirmed against the
      // 10/20 bill it is paid 8 days early (a timing difference) — before ≠ after, and the applied review
      // is that "after" (asserted in roundTrip).
      const bank = dry.figures.banking[0];
      expect(bank.after).not.toEqual(bank.before);
      expect(cents(bank.before.buckets.uncertain.moneyOut) - cents(bank.after.buckets.uncertain.moneyOut)).toBe(9500);
      expect(cents(bank.after.buckets.timingDifference.moneyOut) - cents(bank.before.buckets.timingDifference.moneyOut)).toBe(9500);
      const res = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, hh()));
      expect(res.map((r) => [r.recurringItemId, r.occurrenceDate, r.status, r.matchedTxnId])).toEqual([[item.shieldLife, "2026-10-20", "matched", ids.shield]]);
      expect(applied.replaced).toEqual([]);
    });
  });

  it("an answer the fix replaces comes back on undo (same id); one written since refuses the undo", async () => {
    // The household had moved this occurrence; matching replaces the move (the route's own rule).
    const [moved] = await db
      .insert(forecastResolutionsTable)
      .values({ userId: F, householdId: hh(), recurringItemId: item.shieldLife, occurrenceDate: "2026-10-20", status: "rescheduled", rescheduledTo: "2026-10-22" })
      .returning();
    const p = await proposalOf("bill_match");
    const before = await snapshot();
    const dry = await preview(p);
    expect(dry.replaces).toEqual([{ id: moved!.id, status: "rescheduled", recurringItemId: item.shieldLife, occurrenceDate: "2026-10-20", matchedTxnId: null }]);
    const applied = await apply(p);
    expect(applied.replaced.map((r: Json) => r.id)).toEqual([moved!.id]);
    expect(await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.id, moved!.id))).toEqual([]);
    // Someone answers the occurrence again since (a skip): the undo would make two answers — refused.
    const created = (await db.select().from(forecastResolutionsTable).where(and(eq(forecastResolutionsTable.householdId, hh()), eq(forecastResolutionsTable.matchedTxnId, ids.shield!))))[0]!;
    const [skip] = await db
      .insert(forecastResolutionsTable)
      .values({ userId: F, householdId: hh(), recurringItemId: item.shieldLife, occurrenceDate: "2026-10-20", status: "not_match", matchedTxnId: ids.coffee })
      .returning();
    await db.update(forecastResolutionsTable).set({ status: "partial" }).where(eq(forecastResolutionsTable.id, created.id));
    const refused = await call("POST", `/review/proposals/applied/${applied.applicationId}/undo`);
    expect(refused).toMatchObject({ status: 409, body: { code: "changed_since", rows: [], answers: [created.id] } });
    // Put the answer back as the fix wrote it: the undo goes through, and the move returns with its id.
    await db.update(forecastResolutionsTable).set({ status: "matched" }).where(eq(forecastResolutionsTable.id, created.id));
    await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.id, skip!.id));
    await undo(applied.applicationId);
    expect(await snapshot()).toBe(before);
    await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.id, moved!.id));
  });
});

describe("Q2 · loan_payment (bill) — the HELOC series → its category + each month's occurrence", () => {
  it("⭐ three rows filed under HELOC (Larkspur) and three answers; memory learned once; apply = preview; undo exact", async () => {
    const { dry, applied } = await roundTrip("loan_payment", "HELOC", async (dry, applied) => {
      expect(dry.rows.map((r: Json) => [r.id, r.after.categoryId, r.resolution?.occurrenceDate])).toEqual([
        [ids.lrk, cat.heloc, "2026-10-03"],
        [ids.larkSep, cat.heloc, "2026-09-03"],
        [ids.larkAug, cat.heloc, "2026-08-03"],
      ]);
      expect(dry.learnsMemory).toBe(true);
      expect(dry.figures.week.after).toMatchObject({ actual: "444.76", known: "279.76", unresolved: "165.00" });
      // The Budget: HELOC's line takes each month's payment; Other income never counted a debit.
      const oct = dry.figures.budgetMonths.find((m: Json) => m.monthStart === "2026-10-01");
      const helocLine = (side: Json) => side.lines.find((l: Json) => l.categoryId === cat.heloc).actual;
      expect([helocLine(oct.before), helocLine(oct.after)]).toEqual(["0.00", "1150.40"]);
      expect(cents(oct.after.expenses) - cents(oct.before.expenses)).toBe(115040);
      const sep = dry.figures.budgetMonths.find((m: Json) => m.monthStart === "2026-09-01");
      expect([helocLine(sep.before), helocLine(sep.after)]).toEqual(["0.00", "1150.40"]);
      expect(dry.figures.budgetMonths.map((m: Json) => m.monthStart)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
      expect(dry.figures.banking).toHaveLength(1);
      expect(dry.figures.banking[0]).toMatchObject({ account: { id: acct.chase!.rowId, mask: "4321" }, from: "2026-08-13", to: "2026-10-13" });
      // Memory: ONCE, from the first listed row, money out.
      expect(applied.learnedMemory).toBe(true);
      const memory = await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, hh()));
      expect(memory.map((m) => [m.signature, m.categoryId])).toEqual([["lrk loans", cat.heloc]]);
      const decisions = await db.select().from(categoryDecisionsTable).where(and(eq(categoryDecisionsTable.householdId, hh()), isUser));
      expect(decisions.filter((d) => d.createdMemoryId === memory[0]!.id).map((d) => d.transactionId)).toEqual([ids.lrk]);
    });
    expect(dry.rows).toHaveLength(3);
    expect(applied.rows.every((r: Json) => r.decisionId)).toBe(true);
    // Undo restored the memory exactly: none was there before.
    expect(await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, hh()))).toEqual([]);
  });

  it("two taps at once apply once", async () => {
    const p = await proposalOf("loan_payment", "HELOC");
    const [a, b] = await Promise.all([call("POST", applyPath(p), F, bodyOf(p)), call("POST", applyPath(p), F, bodyOf(p))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(["already_applied", "proposal_gone", "proposal_changed"]).toContain(loser.body.code);
    const apps = await db.select().from(correctionApplicationsTable).where(and(eq(correctionApplicationsTable.householdId, hh()), eq(correctionApplicationsTable.proposalKey, p.key)));
    expect(apps.filter((x) => x.undoneAt == null)).toHaveLength(1);
    const res = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, hh()));
    expect(res).toHaveLength(3);
    await undo((a.status === 200 ? a : b).body.applicationId);
  });
});

describe("Q2 · loan_payment (debt) — UPLAND LOAN PMT → the Upland Loan's 9/20 minimum", () => {
  it("⭐ marks it matched (no category); apply = preview; undo exact", async () => {
    await roundTrip("loan_payment", "Upland Loan", async (dry) => {
      expect(dry.rows[0]).toMatchObject({ id: ids.upland, resolution: { recurringItemId: `debt:${uplandDebt}`, occurrenceDate: "2026-09-20" } });
      expect(dry.rows[0].after).toEqual(dry.rows[0].before);
      expect(dry.learnsMemory).toBe(false);
      // Not this week or month: those figures do not move.
      expect(dry.figures.week.after).toEqual(dry.figures.week.before);
      expect(dry.figures.month.after).toEqual(dry.figures.month.before);
    });
  });
});

const isUser = eq(categoryDecisionsTable.source, "user");

describe("Q2 · income_category — the MAPLEWORKS payroll → Paycheck", () => {
  it("⭐ apply = preview; the Budget counts the credit once, as income; the queue item it answers reopens on undo", async () => {
    // An open queue item on the payroll row (the engine asked about it).
    const [queued] = await db
      .insert(categoryDecisionsTable)
      .values({ householdId: hh(), transactionId: ids.payroll!, source: "memory", categoryId: cat.dining, previousCategoryId: null, confidence: "0.500", band: "queue", explanation: "test", inputHash: `q2-${randomUUID()}` })
      .returning();
    await roundTrip("income_category", undefined, async (dry, applied) => {
      expect(dry.rows[0]).toMatchObject({ id: ids.payroll, before: { categoryId: cat.dining }, after: { categoryId: cat.paycheck, isTransfer: false } });
      expect(dry.learnsMemory).toBe(true);
      const oct = dry.figures.budgetMonths[0];
      expect(oct.monthStart).toBe("2026-10-01");
      const line = (s: Json, c: string) => s.lines.find((l: Json) => l.categoryId === c)?.actual;
      // A credit was never Dining's spend; it is Paycheck's income now — counted once.
      expect([line(oct.before, cat.paycheck), line(oct.after, cat.paycheck)]).toEqual(["0.00", "2391.40"]);
      expect(line(oct.after, cat.dining)).toBe(line(oct.before, cat.dining));
      expect(cents(oct.after.income) - cents(oct.before.income)).toBe(239140);
      expect(oct.after.expenses).toBe(oct.before.expenses);
      // The week never counted the paycheck.
      expect(dry.figures.week.after).toEqual(dry.figures.week.before);
      const [q] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, queued!.id));
      expect(q).toMatchObject({ resolution: "corrected", resolvedVia: "user" });
      expect(applied.learnedMemory).toBe(true);
    });
    const [q] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, queued!.id));
    expect(q).toMatchObject({ resolvedAt: null, resolution: null, resolvedVia: null, undoneAt: null });
    await db.delete(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, queued!.id));
  });

  it("⭐ the payroll and the cafeteria never share a rule: the fix teaches money IN only", async () => {
    const applied = await apply(await proposalOf("income_category"));
    const memory = await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, hh()));
    expect(memory.map((m) => [m.signature, m.categoryId])).toEqual([["in:mapleworks inc", cat.paycheck]]);
    const [base] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, ids.payroll!));
    const engineRow = (o: Partial<EngineRow>): EngineRow => ({
      id: randomUUID(),
      description: base!.description,
      amount: base!.amount,
      source: base!.source,
      plaidAccountId: base!.plaidAccountId,
      pfcPrimary: null,
      pfcDetailed: null,
      pending: false,
      occurredOn: "2026-10-23",
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
    const nextCafe = engineRow({ description: "MAPLEWORKS INC", amount: "-7.75", source: "plaid:amex", plaidAccountId: acct.amex!.ext });
    const ctx = await loadEngineContext(hh(), [nextPay, nextCafe]);
    expect(memoryStage(nextPay, ctx)).toMatchObject({ source: "memory", categoryId: cat.paycheck });
    const cafe = memoryStage(nextCafe, ctx);
    expect(cafe?.categoryId ?? null).not.toBe(cat.paycheck);
    // And the guard refuses filing a cafeteria charge under Paycheck by hand.
    expect((await call("PATCH", `/transactions/${ids.cafe}`, F, { categoryId: cat.paycheck })).body.code).toBe("direction_conflict");
    await undo(applied.applicationId);
    expect(await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, hh()))).toEqual([]);
  });
});

describe("Q2 · undo refuses when a row changed since — and says which", () => {
  it("a row filed by the fix, re-filed by hand since: 409 changed_since naming it; nothing undone", async () => {
    const applied = await apply(await proposalOf("transfer"));
    expect((await call("PATCH", `/transactions/${ids.pear}`, F, { categoryId: cat.groceries })).status).toBe(200);
    const before = await snapshot();
    const r = await call("POST", `/review/proposals/applied/${applied.applicationId}/undo`);
    expect(r).toEqual({ status: 409, body: { error: "Some of these changed since the fix. Nothing was undone.", code: "changed_since", rows: [ids.pear], answers: [] } });
    expect(await snapshot()).toBe(before);
    const [app] = await db.select().from(correctionApplicationsTable).where(eq(correctionApplicationsTable.id, applied.applicationId));
    expect(app!.undoneAt).toBeNull();
    // History lists it, undoable (the undo will say why it cannot, until the row is back).
    const h = await get("/review/proposals/applied");
    expect(() => ListAppliedReviewProposalsResponse.parse(h)).not.toThrow();
    expect(h.items[0]).toMatchObject({ id: applied.applicationId, kind: "transfer", label: "Transfer", rowCount: 1, filedCount: 1, matchedCount: 0, undoneAt: null, undoable: true });
    // Put the row back as the fix left it: the undo goes through.
    await db
      .update(transactionsTable)
      .set({ categoryId: cat.transfer, isTransfer: true, isTransferUserOverridden: true, categoryLockedByUser: true, categoryProvisional: false })
      .where(eq(transactionsTable.id, ids.pear!));
    await undo(applied.applicationId);
    const [row] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, ids.pear!));
    expect(row).toMatchObject({ categoryId: cat.subs, isTransfer: false, isTransferUserOverridden: false, categoryLockedByUser: false });
  });
});

// ── (Final polish) A card row, and an undo that leaves the owner's later answer ──

describe("Final #7 · a fix on a CARD row — an Amex pay-later instalment → its bill", () => {
  it("⭐ previews (200: the card has no Banking review, so no Banking figures), applies = the preview, undoes exactly", async () => {
    // Was: the dry run asked the Banking review for the Amex, which refused it
    // (account_not_ledger) — 400, and the Fix dialog could never enable Apply.
    await seedBill("affirm", "Affirm", "bill", "25", "monthly", 10, "2026-10-10");
    await seedTxns([
      { key: "affirmCard", on: "2026-10-10", desc: "AFFIRM INC", amount: "-25.00", account: "amex", pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_OTHER_PAYMENT" },
    ]);
    try {
      await roundTrip("loan_payment", "Affirm", async (dry, applied) => {
        expect(dry.rows).toHaveLength(1);
        expect(dry.rows[0]).toMatchObject({
          id: ids.affirmCard,
          source: "plaid:amex",
          account: { id: acct.amex!.rowId, mask: "1009", institution: "American Express" },
          resolution: { recurringItemId: item.affirm, occurrenceDate: "2026-10-10", status: "matched" },
        });
        // Its own before → after: matched, nothing re-filed.
        expect(dry.rows[0].after).toEqual(dry.rows[0].before);
        expect(dry.figures.banking).toEqual([]);
        expect(dry.limitations).toEqual([]);
        expect(applied.rows[0]).toMatchObject({ id: ids.affirmCard, decisionId: null });
        const res = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, hh()));
        expect(res.map((r) => [r.recurringItemId, r.occurrenceDate, r.status, r.matchedTxnId])).toEqual([[item.affirm, "2026-10-10", "matched", ids.affirmCard]]);
      });
    } finally {
      await db.delete(transactionsTable).where(eq(transactionsTable.id, ids.affirmCard!));
      await db.delete(recurringItemsTable).where(eq(recurringItemsTable.id, item.affirm!));
    }
  });

  it("a fix with rows on checking still previews its Banking figures (only the card's are left out)", async () => {
    const dry = await preview(await proposalOf("loan_payment", "HELOC"));
    expect(dry.figures.banking.map((b: Json) => b.account.id)).toEqual([acct.chase!.rowId]);
  });
});

describe("Final #8 · undoing a mark-matched fix leaves a queue item it never answered", () => {
  it("⭐ bill_match (files nothing): the owner skips the row's question after the fix; the undo keeps his skip", async () => {
    const [queued] = await db
      .insert(categoryDecisionsTable)
      .values({ householdId: hh(), transactionId: ids.shield!, source: "memory", categoryId: cat.health, previousCategoryId: null, confidence: "0.500", band: "queue", explanation: "test", inputHash: `q2-${randomUUID()}` })
      .returning();
    try {
      const applied = await apply(await proposalOf("bill_match"));
      // The fix files nothing: the question stays open, and the fix does not claim it.
      const [open] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, queued!.id));
      expect(open).toMatchObject({ resolvedAt: null, resolution: null });
      const [record] = await db.select().from(correctionApplicationsTable).where(eq(correctionApplicationsTable.id, applied.applicationId));
      expect(record!.reopenedDecisionIds).toEqual([]);
      // The owner answers it himself, later: Skip.
      expect((await resolveDecision(hh(), F, queued!.id, "skip")).status).toBe(200);
      await undo(applied.applicationId);
      const [after] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, queued!.id));
      // Was: resolvedAt, resolution and resolvedBy wiped — the question came back.
      expect(after).toMatchObject({ resolution: "skipped", resolvedBy: F, undoneAt: null });
      expect(after!.resolvedAt).not.toBeNull();
    } finally {
      await db.delete(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, queued!.id));
    }
  });
});

describe("Q2 · every fix applied: nothing counted twice", () => {
  it("⭐ the week, the month, Banking and the Budget recomputed after all five", async () => {
    // The re-file above left decisions on PEAR; the proposal is computed afresh.
    for (const [kind, label] of [
      ["transfer", undefined],
      ["bill_match", undefined],
      ["loan_payment", "Upland Loan"],
      ["income_category", undefined],
      ["loan_payment", "HELOC"],
    ] as const) {
      await apply(await proposalOf(kind, label));
    }
    expect(await proposals()).toEqual([]);
    const week = await get("/money/period-breakdown?period=week&start=2026-10-11&rowsPerGroup=50");
    // By hand: 1,595.16 − PEAR 20 − SHIELDLINE 95 − LRK 1,150.40 = 329.76; VALLEY's 50 is still unresolved.
    expect(week).toMatchObject({ actual: "329.76", known: "279.76", unresolved: { amount: "50.00", count: 1 } });
    expect(cents(week.known) + cents(week.unresolved.amount)).toBe(cents(week.actual));
    expect(week.unresolved.rows.map((r: Json) => r.id)).toEqual([ids.valley]);
    const banking = await get("/banking/review?from=2026-08-01&to=2026-10-14&rowsPerBucket=50");
    expect(banking.reconciliation).toMatchObject({ rowsUnexplained: 0, unexplained: "0.00" });
    const oct = await get("/budget/months/2026-10-01");
    const line = (c: string) => oct.lines.find((l: Json) => l.categoryId === c).actualAmount;
    expect(line(cat.paycheck)).toBe("2391.40");
    expect(line(cat.heloc)).toBe("1150.40");
    // Transfer is not a Budget line (exclude_from_budget): PEAR's 20.00 left Subscriptions and is nowhere.
    expect(oct.lines.some((l: Json) => l.categoryId === cat.transfer)).toBe(false);
    const apps = await get("/review/proposals/applied");
    expect(apps.items.filter((a: Json) => a.undoneAt == null).map((a: Json) => a.kind)).toEqual([
      "loan_payment",
      "income_category",
      "loan_payment",
      "bill_match",
      "transfer",
    ]);
  });
});
