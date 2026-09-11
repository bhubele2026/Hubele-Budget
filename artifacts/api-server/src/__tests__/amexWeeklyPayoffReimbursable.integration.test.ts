// (PR7 review L2) The Amex weekly payoff uses the one spending rule with one
// exception: a reimbursable charge is still owed to Amex, so it stays in "what
// to pay this card" while the Spending report leaves it out. Through the real
// route, beside the report for the same week.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `pr7-amex-payoff-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
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

import {
  db,
  budgetCategoriesTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import amexRouter from "../routes/amex";
import reportsRouter from "../routes/reports";
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

const WEEK_START = "2026-09-27"; // Sunday
const WEEK_END = "2026-10-03";
const CHARGE_DAY = "2026-09-29";
const CARD = `acct-amex-plat-${randomUUID()}`;

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
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-amex-${randomUUID()}`,
      accessToken: "test-token",
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: CARD,
    name: "Platinum Card",
    mask: "1001",
    type: "credit",
    subtype: "credit card",
  });
  const [groceries] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Groceries", kind: "expense" })
    .returning();

  const charge = (description: string, amount: string, extra: Partial<typeof transactionsTable.$inferInsert> = {}) => ({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    occurredOn: CHARGE_DAY,
    description,
    amount,
    categoryId: groceries!.id,
    plaidAccountId: CARD,
    source: "plaid:amex",
    ...extra,
  });
  await db.insert(transactionsTable).values([
    charge("WHOLE FOODS MARKET", "-50.00"),
    charge("CLIENT LUNCH", "-40.00", { reimbursable: true }),
    // An outflow the rule calls a card payment: out of the payoff and spending alike.
    charge("AMEX EPAYMENT ACH PMT", "-30.00"),
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

describe("GET /amex/weekly-payoff — reimbursable charges are still owed", () => {
  it("counts the reimbursable charge in what to pay; the Spending report leaves it out", async () => {
    const payoff = await get<{
      cards: { accountId: string; weekCharges: number; chargeCount: number }[];
      combinedWeekCharges: number;
    }>(`/amex/weekly-payoff?weekStart=${WEEK_START}`);
    expect(payoff.cards).toHaveLength(1);
    expect(payoff.cards[0]).toMatchObject({ accountId: CARD, weekCharges: 90, chargeCount: 2 });
    expect(payoff.combinedWeekCharges).toBe(90);

    const facts = await get<{
      householdSpend: { total: number };
      excluded: { reimbursable: number; cardPayments: number };
    }>(`/reports/spending-facts?from=${WEEK_START}&to=${WEEK_END}`);
    expect(facts.householdSpend.total).toBe(50);
    expect(facts.excluded.reimbursable).toBe(40);
    expect(facts.excluded.cardPayments).toBe(30);
  });
});
