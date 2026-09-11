import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, transactionsTable, budgetCategoriesTable } from "@workspace/db";
import { createTestHousehold } from "./_helpers/testHousehold";
import { buildSpendingFacts } from "../lib/spendingFacts";
const userId = `test-unplanned-${randomUUID()}`;
let householdId: string;
beforeAll(async () => {
  householdId = (await createTestHousehold(userId)).householdId;
});
afterAll(async () => {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, userId));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, userId));
});
describe("unplanned spending facts", () => {
  it("separates explicit unplanned purchases from uncategorized, transfers, and income", async () => {
    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId,
        householdId,
        name: "Shopping",
        kind: "expense",
        sourceKind: "manual",
      })
      .returning();
    await db.insert(transactionsTable).values(
      [
        {
          description: "Bookstore",
          amount: "-30",
          categoryId: cat.id,
          unplannedAllowance: true,
        },
        { description: "Bakery", amount: "-10", unplannedAllowance: true },
        { description: "Unknown merchant", amount: "-20" },
        { description: "Clothing", amount: "-50", categoryId: cat.id },
        {
          description: "Transfer",
          amount: "-100",
          categoryId: cat.id,
          isTransfer: true,
          unplannedAllowance: true,
        },
        { description: "Paycheck", amount: "500", unplannedAllowance: true },
      ].map((row) => ({
        userId,
        householdId,
        occurredOn: "2026-09-08",
        source: "manual",
        ...row,
      })),
    );
    const facts = await buildSpendingFacts(
      householdId,
      "2026-09-06",
      "2026-09-12",
    );
    expect(facts.realSpend.total).toBe(80);
    expect(facts.uncategorized.total).toBe(30);
    expect(facts.unplanned?.total).toBe(40);
    expect(facts.unplanned?.transactionCount).toBe(2);
    expect(facts.unplanned?.transactions.map((t) => t.description)).toEqual([
      "Bookstore",
      "Bakery",
    ]);
    await db
      .update(transactionsTable)
      .set({ reviewed: true })
      .where(eq(transactionsTable.userId, userId));
    expect(
      await buildSpendingFacts(householdId, "2026-09-06", "2026-09-12"),
    ).toEqual(facts);
    expect(
      (await buildSpendingFacts(householdId, "2026-08-30", "2026-09-05"))
        .unplanned?.total,
    ).toBe(0);
  });
});
