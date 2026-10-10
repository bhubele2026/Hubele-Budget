// ⭐ (WP6) The month's spending reconciliation, on a seeded randomized ledger:
// GET /budget/months/:m's `spendingReconciliation` must quote the Budget's own
// summary.expenses.actual, household spending to date exactly as
// buildSpendingFacts computes it (the spine's spentMonth), and close its
// identity with unexplained = 0.00 — on any ledger, not a hand-picked one.
// Every category kind, card-payment / bank-noise descriptions, debt tags,
// reimbursables, transfers, Amex and bank sign conventions, refunds, splits,
// pending pairs and rows dated after today. Synthetic data only.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";

const TEST_USER = `wp6-recon-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HH = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = HH;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  debtsTable,
  transactionSplitsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, monthBounds } from "@workspace/avalanche-core";
import budgetRouter from "../routes/budget";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { householdTodayISO } from "../lib/householdClock";
import { PFC_CARD_PAYMENT } from "../lib/spendingFilter";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(budgetRouter);
let server: Server;
let baseUrl = "";

const TODAY = householdTodayISO();
const MONTH = monthBounds(TODAY); // the household's current month

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
}

beforeAll(async () => {
  HH = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  const base = { userId: TEST_USER, householdId: HH };
  const rnd = mulberry32(20261013);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const bool = (p: number) => rnd() < p;

  const [debt] = await db.insert(debtsTable).values({ ...base, name: "Test Loan", balance: "5000.00" }).returning({ id: debtsTable.id });
  const cats = await db
    .insert(budgetCategoriesTable)
    .values([
      { ...base, name: "Groceries", kind: "expense" },
      { ...base, name: "Dining", kind: "expense" },
      { ...base, name: "Misc / Buffer", kind: "expense" },
      // The system row: no Budget line.
      { ...base, name: "Uncategorized", kind: "expense", excludeFromBudget: true },
      { ...base, name: "Test Loan", kind: "expense", debtId: debt!.id, sourceKind: "auto_debts" },
      { ...base, name: "Ignore", kind: "expense" },
      { ...base, name: "Transfer", kind: "expense" },
      { ...base, name: "Reimbursement", kind: "expense" },
      { ...base, name: "Paycheck", kind: "income" },
    ])
    .returning({ id: budgetCategoriesTable.id });
  const categoryIds = [...cats.map((c) => c.id), randomUUID() /* a deleted category */];

  const DESCRIPTIONS = [
    "CORNER BISTRO", "GREEN GROCER", "HARDWARE DEPOT", "CITY PHARMACY", "GREEN GROCER REFUND",
    "AMEX EPAYMENT ACH PMT", "CRCARDPMT REF 42", "ONLINE TRANSFER TO SAV 9", "CITY WATER WEB ID: 4417", "ACME PAYROLL",
  ];
  const ACCOUNTS = [
    { source: "plaid:chase", plaidAccountId: `chk-${randomUUID()}` as string | null, outflowSign: -1 },
    { source: "plaid:amex", plaidAccountId: `card-${randomUUID()}` as string | null, outflowSign: -1 },
    { source: "amex", plaidAccountId: null, outflowSign: 1 },
    { source: "manual", plaidAccountId: null, outflowSign: -1 },
  ];
  const days: string[] = [];
  for (let d = MONTH.start; d <= MONTH.end; d = addDaysISO(d, 1)) days.push(d);

  const filing = () => ({
    categoryId: bool(0.2) ? null : pick(categoryIds),
    weeklyAllowance: bool(0.3),
    monthlyAllowance: bool(0.2),
    unplannedAllowance: bool(0.1),
    weeklyBucket: null,
    reimbursable: bool(0.12),
    debtId: bool(0.08) ? debt!.id : null,
    isTransfer: bool(0.08),
    isTransferUserOverridden: bool(0.3),
    isExternalCardPayment: bool(0.05),
    pfcDetailed: bool(0.06) ? PFC_CARD_PAYMENT : null,
  });

  const rows: (typeof transactionsTable.$inferInsert)[] = [];
  for (let i = 0; i < 260; i += 1) {
    const account = pick(ACCOUNTS);
    const day = pick(days);
    const magnitude = Math.round(100 + rnd() * 29900) / 100;
    const signed = bool(0.78) ? account.outflowSign * magnitude : -account.outflowSign * magnitude;
    rows.push({
      ...base,
      id: randomUUID(),
      occurredOn: day,
      createdAt: new Date(createdAtStartOfHouseholdDay(day).getTime() + 3_600_000 + i * 1000),
      description: pick(DESCRIPTIONS),
      amount: signed.toFixed(2),
      source: account.source,
      plaidAccountId: account.plaidAccountId,
      pending: account.plaidAccountId !== null && bool(0.05),
      ...filing(),
    });
  }
  // Pending rows and the posted rows that replaced them (same account and
  // description, later, final amount above the hold); the posted row arrives
  // bare and inherits the pending row's filing.
  for (let k = 0; k < 25; k += 1) {
    const account = pick(ACCOUNTS.slice(0, 2));
    const pendingDay = pick(days);
    const postedDay = addDaysISO(pendingDay, Math.floor(rnd() * 4));
    if (postedDay > MONTH.end) continue;
    const description = `FARM STAND ${String.fromCharCode(65 + k)}`;
    const hold = Math.round(500 + rnd() * 9500) / 100;
    rows.push({
      ...base, id: randomUUID(), occurredOn: pendingDay, createdAt: new Date(createdAtStartOfHouseholdDay(pendingDay).getTime() + 1000 + k),
      description, amount: (-hold).toFixed(2), source: account.source, plaidAccountId: account.plaidAccountId, pending: true, ...filing(),
    });
    rows.push({
      ...base, id: randomUUID(), occurredOn: postedDay, createdAt: new Date(createdAtStartOfHouseholdDay(postedDay).getTime() + 7_200_000 + k),
      description, amount: (-Math.round(hold * (1 + rnd() * 0.2) * 100) / 100).toFixed(2), source: account.source,
      plaidAccountId: account.plaidAccountId, pending: false,
      categoryId: null, weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false, weeklyBucket: null,
      reimbursable: false, debtId: null, isTransfer: false, isTransferUserOverridden: false, isExternalCardPayment: false, pfcDetailed: null,
    });
  }
  // And one deterministic row per term, dated the 1st (always on or before
  // today), so no term is left to the seed: the identity is checked with all.
  const [groceries, , misc, uncat, loan, ignore] = cats.map((c) => c.id);
  const chk = ACCOUNTS[0]!;
  const plain = {
    ...base, occurredOn: MONTH.start, source: chk.source, plaidAccountId: chk.plaidAccountId, pending: false,
    weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false, weeklyBucket: null, reimbursable: false,
    debtId: null as string | null, isTransfer: false, isTransferUserOverridden: false, isExternalCardPayment: false, pfcDetailed: null as string | null,
  };
  const one = (o: Partial<typeof transactionsTable.$inferInsert>) => ({ ...plain, id: randomUUID(), createdAt: createdAtStartOfHouseholdDay(MONTH.start), ...o });
  const fixed = [
    one({ description: "CORNER BISTRO", amount: "-41.10", categoryId: groceries }),
    one({ description: "AMEX EPAYMENT ACH PMT", amount: "-1200.00", categoryId: misc }),
    one({ description: "TEST LOAN PAYMENT", amount: "-245.00", categoryId: loan, debtId: debt!.id }),
    one({ description: "CASH TO SELF", amount: "-30.00", categoryId: ignore }),
    one({ description: "OFFICE SUPPLY CO", amount: "-60.00", categoryId: groceries, reimbursable: true }),
    one({ description: "ONLINE TRANSFER TO SAV 9", amount: "-500.00", categoryId: misc }),
    one({ description: "FOOD TRUCK", amount: "-25.00", categoryId: null }),
    one({ description: "STREET VENDOR", amount: "-15.00", categoryId: uncat }),
    one({ description: "CORNER BISTRO REFUND", amount: "20.00", categoryId: groceries }),
  ];
  if (MONTH.start < MONTH.end && TODAY < MONTH.end) {
    fixed.push(one({ description: "GREEN GROCER", amount: "-40.00", categoryId: groceries, occurredOn: MONTH.end, createdAt: createdAtStartOfHouseholdDay(MONTH.end) }));
  }
  rows.push(...fixed);
  await db.insert(transactionsTable).values(rows);

  // Splits: two parts that add up to the row, one of them often outside the lines.
  const splitCandidates = rows.filter((r) => !r.pending && Number(r.amount) !== 0 && !fixed.includes(r)).slice(0, 30);
  const splits: (typeof transactionSplitsTable.$inferInsert)[] = [];
  for (const r of splitCandidates) {
    const cents = Math.round(Number(r.amount) * 100);
    const first = Math.round(cents * (0.3 + rnd() * 0.4));
    splits.push({ householdId: HH, transactionId: r.id!, categoryId: pick(categoryIds), amount: (first / 100).toFixed(2) });
    splits.push({ householdId: HH, transactionId: r.id!, categoryId: pick(categoryIds), amount: ((cents - first) / 100).toFixed(2) });
  }
  await db.insert(transactionSplitsTable).values(splits);

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  const ids = (await db.select({ id: transactionsTable.id }).from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER))).map((r) => r.id);
  if (ids.length) await db.delete(transactionSplitsTable).where(inArray(transactionSplitsTable.transactionId, ids));
  await cleanup();
});

type Recon = {
  budgetActual: string;
  householdSpendToDate: string;
  through: string | null;
  difference: string;
  terms: Record<string, string>;
  unexplained: string;
};

const cents = (s: string) => Math.round(Number(s) * 100);

describe("(WP6) spendingReconciliation on a randomized ledger", () => {
  it("quotes the Budget's own expense actual and buildSpendingFacts' household spend, and closes with unexplained 0.00", async () => {
    const r = await fetch(`${baseUrl}/budget/months/${MONTH.start}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { summary: { expenses: { actual: string } }; spendingReconciliation: Recon | null };
    const recon = body.spendingReconciliation!;
    expect(recon).not.toBeNull();

    // A is the page's own figure; B is the spine's spentMonth basis, to the cent.
    expect(recon.budgetActual).toBe(body.summary.expenses.actual);
    const facts = await buildSpendingFacts(HH, MONTH.start, TODAY);
    expect(recon.householdSpendToDate).toBe(facts.householdSpend.total.toFixed(2));
    expect(recon.through).toBe(TODAY);

    // The identity, to the cent, and nothing left unexplained.
    const t = recon.terms;
    const explained =
      cents(t.futureDated!) + cents(t.cardPayments!) + cents(t.debtPayments!) + cents(t.excludedNames!) + cents(t.reimbursable!) +
      cents(t.bankNoise!) + cents(t.splitsOutsideLines!) - cents(t.uncategorized!) - cents(t.parkedUncategorized!) + cents(t.refundsNetted!);
    expect(cents(recon.difference)).toBe(cents(recon.budgetActual) - cents(recon.householdSpendToDate));
    expect(explained).toBe(cents(recon.difference));
    expect(recon.unexplained).toBe("0.00");

    // Not vacuous: the ledger exercised the terms (rows after today only when today is not the month's last day).
    for (const k of ["cardPayments", "debtPayments", "excludedNames", "reimbursable", "bankNoise", "uncategorized", "parkedUncategorized", "refundsNetted"]) {
      expect(cents(t[k]!), k).toBeGreaterThan(0);
    }
    expect(cents(t.splitsOutsideLines!)).not.toBe(0);
    if (TODAY < MONTH.end) expect(cents(t.futureDated!)).toBeGreaterThan(0);
  });
});
