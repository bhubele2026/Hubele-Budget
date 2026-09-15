// ⭐ PR-I: a row the bank removed (marked `bank_removed`) counts in no spending,
// Amex owed or Budget figure — every server place that computes one, each tested.
//
//   Amex owed:  GET /amex/weekly-payoff (computeWeeklyPayoff), refreshAmexAnchor,
//               GET /amex/anchor (computed from rows). The web's two places are
//               tested in h2budget (amexEndingBalance.test.ts, the Amex page).
//   Spending:   GET /reports/spending-facts (buildSpendingFacts).
//   Budget:     GET /budget/months/:monthStart, GET /reports/budget-facts.
//   Rows:       GET /transactions leaves it out unless asked, and flags it.
//
// And a removed POSTED row never replaces a live pending row, so the pending row
// the bank still reports keeps counting.
//
// Synthetic merchants and amounts.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `pri-owed-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
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
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  forecastResolutionsTable,
  plaidAccountsTable,
  plaidItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { refreshAmexAnchor } from "../lib/amexAnchor";
import apiRouter from "../routes/index";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const routes = Router();
routes.use((req, _res, next) => {
  (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
routes.use(apiRouter);
const { request } = createTestApp(routes);

const WEEK_START = "2026-08-02"; // Sunday
const WEEK_END = "2026-08-08";
const CHARGE_DAY = "2026-08-04";
const MONTH = "2026-08-01";
// A second week, for the pending/posted pair, so it touches none of the figures above.
const PAIR_WEEK_START = "2026-08-16";
const PAIR_WEEK_END = "2026-08-22";
const CARD = `acct-amex-pri-${randomUUID()}`;

let GROCERIES: string;
let keptId: string;
let removedId: string;
let pairPendingId: string;
let pairPostedId: string;

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  for (const t of [budgetLinesTable, budgetMonthsTable, budgetCategoriesTable, debtsTable, avalancheSettingsTable, settingsTable]) {
    await db.delete(t).where(eq(t.userId, TEST_USER));
  }
}

async function charge(occurredOn: string, description: string, amount: string, extra: Partial<typeof transactionsTable.$inferInsert> = {}): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description,
      amount,
      source: "plaid:amex",
      plaidAccountId: CARD,
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
      ...extra,
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

async function markRemoved(txnId: string): Promise<void> {
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    recurringItemId: null,
    occurrenceDate: null,
    status: "bank_removed",
    matchedTxnId: txnId,
  });
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
    mask: "2002",
    type: "credit",
    subtype: "credit card",
  });
  const [groceries] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `Groceries PR-I ${randomUUID().slice(0, 6)}`, kind: "expense" })
    .returning();
  GROCERIES = groceries!.id;
  await db.insert(budgetLinesTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    monthStart: MONTH,
    categoryId: GROCERIES,
    plannedAmount: "200.00",
  });

  keptId = await charge(CHARGE_DAY, "VALLEY FOODS", "-50.00", { categoryId: GROCERIES });
  // Worked on (filed), then removed by the bank.
  removedId = await charge(CHARGE_DAY, "ORCHARD PRODUCE", "-40.00", { categoryId: GROCERIES, reviewed: true });
  await markRemoved(removedId);

  // A pending charge the bank still reports, and a posted look-alike the bank removed.
  // Filed (the Amex payoff counts filed charges only) under a category with no
  // budget line, so the Budget figures above never see the pair.
  const [outdoor] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `Outdoor PR-I ${randomUUID().slice(0, 6)}`, kind: "expense" })
    .returning();
  pairPendingId = await charge("2026-08-18", "SUMMIT OUTFITTERS", "-30.00", { pending: true, categoryId: outdoor!.id });
  pairPostedId = await charge("2026-08-19", "SUMMIT OUTFITTERS", "-30.00", { categoryId: outdoor!.id });
  await markRemoved(pairPostedId);
});

afterAll(cleanup);

type Payoff = { cards: { accountId: string; weekCharges: number; chargeCount: number }[]; combinedWeekCharges: number };
type Facts = { householdSpend: { total: number; transactionCount: number }; excluded: { replacedPending: number } };

describe("Amex owed skips a removed row", () => {
  it("GET /amex/weekly-payoff (computeWeeklyPayoff)", async () => {
    const r = await request("GET", `/amex/weekly-payoff?weekStart=${WEEK_START}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const payoff = r.json as Payoff;
    expect(payoff.cards.find((c) => c.accountId === CARD)).toMatchObject({ weekCharges: 50, chargeCount: 1 });
  });

  it("GET /amex/anchor, computed from rows", async () => {
    await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
    const r = await request("GET", "/amex/anchor");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Every Amex row: the kept charge and the live pending one. Never the removed charges.
    expect(r.json).toMatchObject({ source: "computed", amexEndingBalance: -80 });
  });

  it("refreshAmexAnchor", async () => {
    // ⚠️ Its own household of workbook-imported rows (`source: "amex"`, no Plaid
    // account): on main, refreshAmexAnchor's debt lookup fails (22P02) whenever an
    // Amex row carries a plaid_account_id — a separate, pre-existing fault this PR
    // reports and does not change. Here the sum is what is under test.
    const LEGACY_USER = `pri-owed-legacy-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const legacyHousehold = (await createTestHousehold(LEGACY_USER)).householdId;
    try {
      const imported = (description: string, amount: string) => ({
        userId: LEGACY_USER,
        householdId: legacyHousehold,
        occurredOn: CHARGE_DAY,
        description,
        amount,
        source: "amex",
      });
      await db.insert(transactionsTable).values(imported("VALLEY FOODS", "50.00"));
      const [gone] = await db
        .insert(transactionsTable)
        .values(imported("ORCHARD PRODUCE", "40.00"))
        .returning({ id: transactionsTable.id });
      await db.insert(forecastResolutionsTable).values({
        userId: LEGACY_USER,
        householdId: legacyHousehold,
        status: "bank_removed",
        matchedTxnId: gone!.id,
      });
      const result = await refreshAmexAnchor(LEGACY_USER);
      expect(result).toMatchObject({ balance: 50, txnCount: 1 });
    } finally {
      await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, LEGACY_USER));
      await db.delete(transactionsTable).where(eq(transactionsTable.userId, LEGACY_USER));
      await db.delete(settingsTable).where(eq(settingsTable.userId, LEGACY_USER));
    }
  });
});

describe("Spending and Budget skip a removed row", () => {
  it("GET /reports/spending-facts (buildSpendingFacts)", async () => {
    const r = await request("GET", `/reports/spending-facts?from=${WEEK_START}&to=${WEEK_END}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json as Facts).householdSpend).toEqual({ total: 50, transactionCount: 1 });
  });

  it("GET /budget/months/:monthStart", async () => {
    const r = await request("GET", `/budget/months/${MONTH}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const line = (r.json as { lines: { categoryId: string; actualAmount: string }[] }).lines.find(
      (l) => l.categoryId === GROCERIES,
    );
    expect(line?.actualAmount).toBe("50.00");
  });

  it("GET /reports/budget-facts", async () => {
    const r = await request("GET", `/reports/budget-facts?monthStart=${MONTH}&monthsBack=1`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const flex = (r.json as { flex: { lines: { categoryId: string; actual: number }[] } }).flex;
    expect(flex.lines.find((l) => l.categoryId === GROCERIES)?.actual).toBe(50);
  });
});

describe("GET /transactions", () => {
  it("leaves a removed row out of a plain list, and lists it flagged when asked", async () => {
    const plain = await request("GET", `/transactions?from=${WEEK_START}&to=${WEEK_END}`);
    expect(plain.status).toBe(200);
    expect((plain.json as { id: string }[]).map((t) => t.id)).toEqual([keptId]);

    const asked = await request("GET", `/transactions?from=${WEEK_START}&to=${WEEK_END}&includeBankRemoved=true`);
    expect(asked.status).toBe(200);
    const rows = asked.json as { id: string; bankRemoved?: boolean }[];
    expect(rows.find((t) => t.id === keptId)).toMatchObject({ bankRemoved: false });
    expect(rows.find((t) => t.id === removedId)).toMatchObject({ bankRemoved: true });
  });
});

describe("a removed posted row never replaces a live pending row", () => {
  it("the pending charge the bank still reports counts once, in spending and Amex owed", async () => {
    const facts = await request("GET", `/reports/spending-facts?from=${PAIR_WEEK_START}&to=${PAIR_WEEK_END}`);
    expect(facts.status).toBe(200);
    expect((facts.json as Facts).householdSpend).toEqual({ total: 30, transactionCount: 1 });
    expect((facts.json as Facts).excluded.replacedPending).toBe(0);

    const r = await request("GET", `/amex/weekly-payoff?weekStart=${PAIR_WEEK_START}`);
    expect((r.json as Payoff).cards.find((c) => c.accountId === CARD)).toMatchObject({ weekCharges: 30, chargeCount: 1 });
    expect(pairPendingId).not.toBe(pairPostedId);
  });
});
