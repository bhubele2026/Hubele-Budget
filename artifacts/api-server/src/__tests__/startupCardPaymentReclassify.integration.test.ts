import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

import {
  db,
  budgetCategoriesTable,
  mappingRulesTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { runStartupCardPaymentReclassify } from "../lib/startupCardPaymentReclassify";
import { createTestHousehold } from "./_helpers/testHousehold";

async function deleteAllForUser(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await deleteAllForUser();
});

afterAll(async () => {
  await deleteAllForUser();
});

async function readRow(id: string) {
  const [row] = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.id, id),
        eq(transactionsTable.userId, TEST_USER),
      ),
    );
  return row;
}

// (#666) Auto-detection of transfers is disabled. The startup
// reclassify sweep walks empty pattern lists and is a no-op: it must
// NOT flip `isTransfer` on any row regardless of description / PFC,
// and it must NOT strip `unplannedAllowance` from rows the user has
// tagged. The user is now in full manual control.
describe("(#666) runStartupCardPaymentReclassify is a no-op", () => {
  it("does not touch any row regardless of description, PFC, or allowance flags", async () => {
    const [a] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-10",
        description: "AUTOPAY PAYMENT - THANK YOU",
        amount: "-450.00",
        isTransfer: false,
        weeklyAllowance: false,
        monthlyAllowance: true,
        unplannedAllowance: false,
        source: "plaid:chase",
      })
      .returning();

    const [b] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-13",
        description: "Online Transfer to SAV ...9128",
        amount: "-500.00",
        isTransfer: false,
        unplannedAllowance: true,
        source: "plaid:chase",
      })
      .returning();

    const summary = await runStartupCardPaymentReclassify();
    expect(summary.reclassified).toBe(0);
    expect(summary.unplannedStripped).toBe(0);

    const afterA = await readRow(a!.id);
    expect(afterA.isTransfer).toBe(false);
    expect(afterA.monthlyAllowance).toBe(true);

    const afterB = await readRow(b!.id);
    expect(afterB.isTransfer).toBe(false);
    expect(afterB.unplannedAllowance).toBe(true);
  });
});
