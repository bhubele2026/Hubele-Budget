// (#879) Biggest Splurge: discretionary only.
//
// The "Biggest Splurge" card (and its Hall-of-Fame "biggest expense" alias)
// must reflect discretionary spend — shopping/dining/home-improvement/etc —
// never a fixed obligation like the mortgage, a loan, rent, insurance,
// utilities, taxes, or any debt/card payment. These tests drive the
// server-side computation in buildBehaviorFacts plus the pure obligation
// helper.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db, budgetCategoriesTable, transactionsTable } from "@workspace/db";
import { createTestHousehold } from "./_helpers/testHousehold";
import {
  buildBehaviorFacts,
  isNonDiscretionaryCategory,
} from "../lib/behaviorFacts";

const TEST_USER = `splurge-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

const RANGE_START = "2026-05-01";
const RANGE_END = "2026-05-31";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
}

async function makeCategory(opts: {
  name: string;
  groupName?: string;
  kind?: string;
  sourceKind?: string;
  excludeFromBudget?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(budgetCategoriesTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: opts.name,
      groupName: opts.groupName ?? "Other",
      kind: opts.kind ?? "expense",
      sourceKind: opts.sourceKind ?? "manual",
      excludeFromBudget: opts.excludeFromBudget ?? false,
    })
    .returning({ id: budgetCategoriesTable.id });
  return row!.id;
}

async function makeTxn(opts: {
  description: string;
  amount: string;
  occurredOn?: string;
  categoryId?: string | null;
  isTransfer?: boolean;
  isExternalCardPayment?: boolean;
  source?: string;
}): Promise<void> {
  await db.insert(transactionsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    occurredOn: opts.occurredOn ?? "2026-05-15",
    description: opts.description,
    amount: opts.amount,
    categoryId: opts.categoryId ?? null,
    isTransfer: opts.isTransfer ?? false,
    isExternalCardPayment: opts.isExternalCardPayment ?? false,
    source: opts.source ?? "bank",
  });
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  await cleanup();
});

describe("isNonDiscretionaryCategory", () => {
  const base = {
    name: "Shopping",
    groupName: "Lifestyle",
    kind: "expense",
    sourceKind: "manual",
    excludeFromBudget: false,
  };

  it("treats a plain discretionary category as discretionary", () => {
    expect(isNonDiscretionaryCategory(base)).toBe(false);
  });

  it("excludes auto_bills and auto_debts source kinds", () => {
    expect(isNonDiscretionaryCategory({ ...base, sourceKind: "auto_bills" })).toBe(true);
    expect(isNonDiscretionaryCategory({ ...base, sourceKind: "auto_debts" })).toBe(true);
  });

  it("excludes income, excludeFromBudget, and obligation names/groups", () => {
    expect(isNonDiscretionaryCategory({ ...base, kind: "income" })).toBe(true);
    expect(isNonDiscretionaryCategory({ ...base, excludeFromBudget: true })).toBe(true);
    expect(isNonDiscretionaryCategory({ ...base, name: "Mortgage" })).toBe(true);
    expect(isNonDiscretionaryCategory({ ...base, name: "Car Loan" })).toBe(true);
    expect(isNonDiscretionaryCategory({ ...base, name: "Renters Insurance" })).toBe(true);
    expect(isNonDiscretionaryCategory({ ...base, groupName: "Utilities" })).toBe(true);
    expect(isNonDiscretionaryCategory({ ...base, name: "Property Taxes" })).toBe(true);
  });
});

describe("buildBehaviorFacts — biggest splurge is discretionary only", () => {
  it("picks the discretionary purchase over a larger mortgage payment", async () => {
    const mortgageCat = await makeCategory({
      name: "Mortgage",
      groupName: "Housing",
      sourceKind: "auto_bills",
    });
    const shoppingCat = await makeCategory({
      name: "Home Improvement",
      groupName: "Lifestyle",
    });

    await makeTxn({
      description: "Lakeview Loan Servicing Mortgage",
      amount: "-2085.79",
      categoryId: mortgageCat,
    });
    await makeTxn({
      description: "The Home Depot #1234",
      amount: "-312.45",
      categoryId: shoppingCat,
    });

    const facts = await buildBehaviorFacts(
      TEST_HOUSEHOLD_ID,
      RANGE_START,
      RANGE_END,
    );

    expect(facts.funFacts.biggestSplurge).not.toBeNull();
    expect(facts.funFacts.biggestSplurge!.amount).toBe(312.45);
    expect(facts.funFacts.biggestSplurge!.merchant).toMatch(/home depot/i);
    // Hall-of-Fame biggest expense is an alias of the same value.
    expect(facts.hallOfFame.biggestExpense).not.toBeNull();
    expect(facts.hallOfFame.biggestExpense!.amount).toBe(312.45);
  });

  it("never lets a transfer or a card payment win the splurge", async () => {
    const shoppingCat = await makeCategory({ name: "Clothing" });

    // A large transfer-flagged row and a card-payment description row, plus a
    // smaller genuine purchase.
    await makeTxn({
      description: "Online Transfer to SAV 1234",
      amount: "-5000.00",
      isTransfer: true,
    });
    await makeTxn({
      description: "CHASE CREDIT CRD AUTOPAY",
      amount: "-1500.00",
    });
    await makeTxn({
      description: "Nordstrom",
      amount: "-89.99",
      categoryId: shoppingCat,
    });

    const facts = await buildBehaviorFacts(
      TEST_HOUSEHOLD_ID,
      RANGE_START,
      RANGE_END,
    );

    expect(facts.funFacts.biggestSplurge).not.toBeNull();
    expect(facts.funFacts.biggestSplurge!.amount).toBe(89.99);
    expect(facts.funFacts.biggestSplurge!.merchant).toMatch(/nordstrom/i);
  });

  it("never lets an external-card-payment-flagged row win, even with a benign description", async () => {
    const shoppingCat = await makeCategory({ name: "Electronics" });
    const groceriesCat = await makeCategory({ name: "Groceries" });

    // A large card payment that was flagged isExternalCardPayment but carries a
    // bland, discretionary-looking description + ordinary category — only the
    // flag identifies it. It must never win the splurge.
    await makeTxn({
      description: "ACH WEB PAYMENT 9981",
      amount: "-2400.00",
      categoryId: groceriesCat,
      isExternalCardPayment: true,
    });
    await makeTxn({
      description: "Best Buy",
      amount: "-149.99",
      categoryId: shoppingCat,
    });

    const facts = await buildBehaviorFacts(
      TEST_HOUSEHOLD_ID,
      RANGE_START,
      RANGE_END,
    );

    expect(facts.funFacts.biggestSplurge).not.toBeNull();
    expect(facts.funFacts.biggestSplurge!.amount).toBe(149.99);
    expect(facts.funFacts.biggestSplurge!.merchant).toMatch(/best buy/i);
  });

  it("returns null when every row is a fixed obligation", async () => {
    const mortgageCat = await makeCategory({
      name: "Mortgage",
      groupName: "Housing",
      sourceKind: "auto_bills",
    });
    const debtCat = await makeCategory({
      name: "Auto Loan",
      groupName: "Debt",
      sourceKind: "auto_debts",
    });

    await makeTxn({
      description: "Lakeview Loan Servicing Mortgage",
      amount: "-2085.79",
      categoryId: mortgageCat,
    });
    await makeTxn({
      description: "Honda Financial Loan",
      amount: "-410.00",
      categoryId: debtCat,
    });

    const facts = await buildBehaviorFacts(
      TEST_HOUSEHOLD_ID,
      RANGE_START,
      RANGE_END,
    );

    expect(facts.funFacts.biggestSplurge).toBeNull();
    expect(facts.hallOfFame.biggestExpense).toBeNull();
  });
});
