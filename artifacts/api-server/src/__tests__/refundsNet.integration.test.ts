// (B6) Refunds net — through the real readers, on one small ledger.
//
//   GET /amex/weekly-payoff  the card's charges less its refunds, per window, never below zero;
//                            a refund dated after a week closed nets the NEXT week
//   computeWeeklyPayoff      the hooks' view (every coverage) nets the same refunds
//   GET /reports/spending-facts
//                            householdSpend nets per account; a filed refund nets its
//                            category; `refunds` says what was netted
//   classifierHouseholdSpend (mode "today") still IS householdSpend, refunds included
//
// See docs/reviews/2026-10-08-b6-refunds.md.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `b6-refunds-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HH: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = HH;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => {
      throw new Error("no Plaid calls in this test");
    },
  };
});

import { db, budgetCategoriesTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import amexRouter from "../routes/amex";
import reportsRouter from "../routes/reports";
import { computeWeeklyPayoff } from "../lib/amexAnchor";
import { classifierSpendForRange } from "./_helpers/classifierSpend";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(amexRouter);
app.use(reportsRouter);

let server: Server;
let baseUrl: string;

// Week 1: Sun 9/27 – Sat 10/3. Week 2: Sun 10/4 – Sat 10/10.
const W1 = { start: "2026-09-27", end: "2026-10-03" };
const W2 = { start: "2026-10-04", end: "2026-10-10" };
const CARD = `acct-amex-b6-${randomUUID()}`;
const cat: Record<string, string> = {};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  HH = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  const owned = { userId: TEST_USER, householdId: HH };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...owned, itemId: `item-amex-${randomUUID()}`, accessToken: "test-token", institutionName: "American Express", institutionSlug: "amex" })
    .returning();
  await db.insert(plaidAccountsTable).values({ ...owned, itemId: item!.id, accountId: CARD, name: "Platinum Card", mask: "1005", type: "credit", subtype: "credit card" });
  for (const name of ["Groceries", "Dining"]) {
    const [c] = await db.insert(budgetCategoriesTable).values({ ...owned, name, kind: "expense" }).returning();
    cat[name] = c!.id;
  }
  const amex = (occurredOn: string, description: string, amount: string, extra: Partial<typeof transactionsTable.$inferInsert> = {}) => ({
    ...owned,
    occurredOn,
    description,
    amount,
    plaidAccountId: CARD,
    source: "plaid:amex",
    ...extra,
  });
  const manual = (occurredOn: string, description: string, amount: string) => ({ ...owned, occurredOn, description, amount, source: "manual" });
  await db.insert(transactionsTable).values([
    // ── Week 1, the card.
    amex("2026-09-29", "WHOLE FOODS MARKET", "-50.00", { categoryId: cat.Groceries }),
    amex("2026-09-30", "CORNER BISTRO", "-30.00"),
    amex("2026-10-01", "WHOLE FOODS MARKET REFUND", "15.00", { categoryId: cat.Groceries }),
    amex("2026-10-02", "CLIENT LUNCH REFUND", "5.00", { reimbursable: true }),
    amex("2026-09-29", "ONLINE PAYMENT - THANK YOU", "500.00", { pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }),
    // ── Week 1, checking (manual rows): a refund bigger than the account's spend; a paycheck.
    manual("2026-09-28", "HARDWARE DEPOT", "-25.00"),
    manual("2026-09-30", "AMAZON.COM REFUND", "100.00"),
    manual("2026-09-30", "ACME PAYROLL", "2000.00"),
    // ── Week 2, the card: a refund of week 1's bistro charge, after week 1 closed.
    amex("2026-10-05", "CORNER BISTRO", "40.00"),
    amex("2026-10-06", "PIZZA PLACE", "-10.00", { categoryId: cat.Dining }),
  ]);

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

type Payoff = { cards: { accountId: string; weekCharges: number; chargeCount: number }[]; combinedWeekCharges: number };

describe("the card's charges net its refunds, per window, never below zero", () => {
  it("week 1 — the Amex page: filed charges 50.00 less the 15.00 and the reimbursable 5.00 refunds = 30.00", async () => {
    const p = await get<Payoff>(`/amex/weekly-payoff?weekStart=${W1.start}`);
    expect(p.cards).toHaveLength(1);
    expect(p.cards[0]).toMatchObject({ accountId: CARD, weekCharges: 30, chargeCount: 1 });
    expect(p.combinedWeekCharges).toBe(30);
  });

  it("week 1 — the hooks (every coverage): 80.00 less 20.00 = 60.00; the 10/05 refund stays out of the closed week", async () => {
    const p = await computeWeeklyPayoff(HH, W1.start, TEST_USER, { allCoverages: true });
    expect(p.combinedWeekCharges).toBe(60);
    expect(p.cards[0]!.chargeCount).toBe(2);
  });

  it("week 2 — the refund dated after week 1 closed nets week 2: 10.00 less 40.00, floored at 0.00", async () => {
    expect((await get<Payoff>(`/amex/weekly-payoff?weekStart=${W2.start}`)).combinedWeekCharges).toBe(0);
    const all = await computeWeeklyPayoff(HH, W2.start, TEST_USER, { allCoverages: true });
    expect(all.combinedWeekCharges).toBe(0);
    expect(all.cards[0]!.chargeCount).toBe(1);
  });
});

type Facts = {
  householdSpend: { total: number; transactionCount: number };
  realSpend: { total: number; transactionCount: number };
  uncategorized: { total: number; transactionCount: number };
  refunds: { total: number; transactionCount: number; fromCategories: number };
  byCategory: { name: string; total: number; txnCount: number }[];
  realIncome: { total: number };
};

describe("household spending nets refunds per account; a filed refund nets its category", () => {
  it("week 1: the card 80.00 − 15.00 = 65.00; checking 25.00 − 100.00 → 0.00; the reimbursable refund and the payment do not net", async () => {
    const f = await get<Facts>(`/reports/spending-facts?from=${W1.start}&to=${W1.end}`);
    expect(f.householdSpend).toEqual({ total: 65, transactionCount: 3 });
    expect(f.refunds).toEqual({ total: 40, transactionCount: 2, fromCategories: 15 });
    expect(f.realSpend).toEqual({ total: 35, transactionCount: 1 });
    expect(f.byCategory.map((c) => [c.name, c.total, c.txnCount])).toEqual([["Groceries", 35, 1]]);
    expect(f.uncategorized.total).toBe(55);
    // householdSpend = realSpend + uncategorized − (refunds.total − refunds.fromCategories)
    expect(f.householdSpend.total).toBeCloseTo(f.realSpend.total + f.uncategorized.total - (f.refunds.total - f.refunds.fromCategories), 2);
    expect(f.realIncome.total).toBe(0); // the uncategorized paycheck is neither income nor a refund
  });

  it("week 2: the card 10.00 − 40.00 → 0.00 (the refund never reaches another account or week)", async () => {
    const f = await get<Facts>(`/reports/spending-facts?from=${W2.start}&to=${W2.end}`);
    expect(f.householdSpend).toEqual({ total: 0, transactionCount: 1 });
    expect(f.refunds).toEqual({ total: 10, transactionCount: 1, fromCategories: 0 });
    expect(f.realSpend.total).toBe(10); // the refund was not filed to Dining
  });

  it("both weeks together: one window, so the card nets 90.00 − 55.00 = 35.00; checking still 0.00", async () => {
    const f = await get<Facts>(`/reports/spending-facts?from=${W1.start}&to=${W2.end}`);
    expect(f.householdSpend.total).toBe(35);
  });

  it("mode 'today' of the household-money classifier IS householdSpend on each window, refunds included", async () => {
    for (const [start, end] of [[W1.start, W1.end], [W2.start, W2.end], [W1.start, W2.end]] as const) {
      const f = await get<Facts>(`/reports/spending-facts?from=${start}&to=${end}`);
      const { spend } = await classifierSpendForRange(HH, start, end, { mode: "today" });
      expect(spend, `${start}..${end}`).toEqual(f.householdSpend);
    }
  });
});
