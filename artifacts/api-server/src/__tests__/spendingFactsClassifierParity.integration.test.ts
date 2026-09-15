// (PR-H, owner decisions 7 and 12) Parity between today's `householdSpend`
// (`buildSpendingFacts`) and the classifier's view of the same rows
// (`classifierHouseholdSpend`, `classifyMovement`) — and the two documented
// places they diverge (moved in PR8r/PR10): see
// docs/reviews/2026-09-14-household-money-core.md.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  debtsTable,
  forecastResolutionsTable,
  transactionsTable,
} from "@workspace/db";
import {
  buildSpendingFacts,
  classifierHouseholdSpend,
} from "../lib/spendingFacts";
import { effectiveFiling, uncategorizedCategoryIds, type FilingContext } from "../lib/pendingFiling";
import { findSupersededPendingForRange } from "../lib/supersededPending";
import { loadConfirmedBillMatches } from "../lib/moneyContext";
import type { MovementContext, MovementRow } from "../lib/spendingFilter";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `pr-h-spend-parity-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
let GROCERIES_CAT: string;
let TEST_DEBT_ID: string;

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  const [cat] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Groceries", kind: "expense" })
    .returning({ id: budgetCategoriesTable.id });
  GROCERIES_CAT = cat!.id;
  const [debt] = await db
    .insert(debtsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Test Card" })
    .returning({ id: debtsTable.id });
  TEST_DEBT_ID = debt!.id;
});

afterAll(async () => {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
});

/** Build the classifier-ready rows for `[start, end]` the same way
 *  `buildSpendingFacts` prepares them before calling `classifyOutflow`. */
async function loadEffectiveMovementRows(
  start: string,
  end: string,
): Promise<{ rows: MovementRow[]; ctx: MovementContext }> {
  const cats = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      debtId: budgetCategoriesTable.debtId,
      kind: budgetCategoriesTable.kind,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, TEST_HOUSEHOLD_ID));
  const categoriesById = new Map(cats.map((c) => [c.id, { name: c.name, debtId: c.debtId, kind: c.kind }]));
  const debtCategoryIds = new Set(cats.filter((c) => c.debtId).map((c) => c.id));
  const filingCtx: FilingContext = { uncategorizedIds: uncategorizedCategoryIds(cats) };

  const supersede = await findSupersededPendingForRange(TEST_HOUSEHOLD_ID, start, end);
  const matchedTxnIds = await loadConfirmedBillMatches(TEST_HOUSEHOLD_ID, { start, end });

  const txns = await db
    .select({
      id: transactionsTable.id,
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
      source: transactionsTable.source,
      reimbursable: transactionsTable.reimbursable,
      debtId: transactionsTable.debtId,
      isExternalCardPayment: transactionsTable.isExternalCardPayment,
      pfcDetailed: transactionsTable.pfcDetailed,
      weeklyAllowance: transactionsTable.weeklyAllowance,
      monthlyAllowance: transactionsTable.monthlyAllowance,
      unplannedAllowance: transactionsTable.unplannedAllowance,
      weeklyBucket: transactionsTable.weeklyBucket,
      isTransferUserOverridden: transactionsTable.isTransferUserOverridden,
      plaidAccountId: transactionsTable.plaidAccountId,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID),
        gte(transactionsTable.occurredOn, start),
        lte(transactionsTable.occurredOn, end),
      ),
    );

  const rows: MovementRow[] = [];
  for (const row of txns) {
    if (supersede.replacedIds.has(row.id)) continue;
    rows.push(effectiveFiling(row, supersede.replacedBy.get(row.id), filingCtx));
  }

  return {
    rows,
    ctx: { categoriesById, debtCategoryIds, checkingAccountExternalId: null, matchedTxnIds },
  };
}

describe("classifierHouseholdSpend — parity with buildSpendingFacts.householdSpend", () => {
  it("agrees to the cent over a mixed fixture with no bill match and no reimbursable+flag row", async () => {
    const start = "2026-06-01";
    const end = "2026-06-30";
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-06-05",
        description: "WHOLE FOODS",
        amount: "-64.20",
        categoryId: GROCERIES_CAT,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-06-06",
        description: "ONLINE TRANSFER TO SAVINGS",
        amount: "-500.00",
        isTransfer: true,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-06-07",
        description: "DEBT PAYMENT",
        amount: "-200.00",
        debtId: TEST_DEBT_ID,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-06-08",
        description: "CRCARDPMT REF 42",
        amount: "-300.00",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-06-09",
        description: "DOCTOR VISIT",
        amount: "-50.00",
        reimbursable: true,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-06-10",
        description: "TARGET",
        amount: "-18.40",
        unplannedAllowance: true,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-06-11",
        description: "UNKNOWN MERCHANT",
        amount: "-9.99",
      },
    ]);

    const today = await buildSpendingFacts(TEST_HOUSEHOLD_ID, start, end);
    const { rows, ctx } = await loadEffectiveMovementRows(start, end);
    const classifier = classifierHouseholdSpend(rows, ctx, { billMatchedCounts: true });

    expect(classifier.total).toBe(today.householdSpend.total);
    expect(classifier.transactionCount).toBe(today.householdSpend.transactionCount);
    // Sanity: the fixture actually exercises more than the trivial zero case.
    expect(today.householdSpend.total).toBeGreaterThan(0);
  });
});

describe("classifierHouseholdSpend — documented difference #1: a confirmed bill match", () => {
  it("today counts it; the forward rule (PR8r/PR10) would not", async () => {
    const start = "2026-07-01";
    const end = "2026-07-31";
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-07-10",
        description: "STATE FARM AUTO",
        amount: "-142.17",
        categoryId: GROCERIES_CAT,
      })
      .returning({ id: transactionsTable.id });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: "rec-parity-1",
      occurrenceDate: "2026-07-10",
      status: "matched",
      matchedTxnId: txn!.id,
    });

    const today = await buildSpendingFacts(TEST_HOUSEHOLD_ID, start, end);
    const { rows, ctx } = await loadEffectiveMovementRows(start, end);

    const classifierToday = classifierHouseholdSpend(rows, ctx, { billMatchedCounts: true });
    expect(classifierToday.total).toBe(today.householdSpend.total);

    const classifierForward = classifierHouseholdSpend(rows, ctx, { billMatchedCounts: false });
    expect(Math.round((today.householdSpend.total - classifierForward.total) * 100)).toBe(14217);
  });
});

describe("classifierHouseholdSpend — documented difference #2: reimbursable + an allowance flag", () => {
  it("today excludes it entirely; the classifier's flag-before-reimbursable precedence counts it", async () => {
    const start = "2026-08-01";
    const end = "2026-08-31";
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-08-05",
      description: "URGENT CARE COPAY",
      amount: "-35.00",
      reimbursable: true,
      weeklyAllowance: true,
    });

    const today = await buildSpendingFacts(TEST_HOUSEHOLD_ID, start, end);
    expect(today.householdSpend.total).toBe(0);

    const { rows, ctx } = await loadEffectiveMovementRows(start, end);
    const classifier = classifierHouseholdSpend(rows, ctx);
    expect(classifier.total).toBe(35);
  });
});
