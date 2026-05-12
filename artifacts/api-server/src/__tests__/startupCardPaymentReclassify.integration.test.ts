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

describe("runStartupCardPaymentReclassify (#632)", () => {
  it("flips matching rows, leaves user-overridden + non-matching rows alone, and is idempotent", async () => {
    // (a) Card-payment-pattern row with monthlyAllowance=true and
    //     isTransfer=false. Should be flipped to isTransfer=true with all
    //     three allowance flags cleared.
    const [needsFix] = await db
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

    // (b) Card-payment-pattern row the user has explicitly overridden —
    //     should be left untouched even though the description matches.
    const [overridden] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-11",
        description: "ONLINE PAYMENT - THANK YOU",
        amount: "-225.00",
        isTransfer: false,
        isTransferUserOverridden: true,
        weeklyAllowance: true,
        monthlyAllowance: false,
        unplannedAllowance: false,
        source: "plaid:amex",
      })
      .returning();

    // (c) Normal merchant row that doesn't match any heuristic pattern.
    const [merchant] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-12",
        description: "STARBUCKS STORE 4477",
        amount: "-5.50",
        isTransfer: false,
        weeklyAllowance: true,
        monthlyAllowance: false,
        unplannedAllowance: false,
        source: "manual",
      })
      .returning();

    const first = await runStartupCardPaymentReclassify();
    expect(first.reclassified).toBeGreaterThanOrEqual(1);

    const afterA = await readRow(needsFix!.id);
    expect(afterA.isTransfer).toBe(true);
    expect(afterA.weeklyAllowance).toBe(false);
    expect(afterA.monthlyAllowance).toBe(false);
    expect(afterA.unplannedAllowance).toBe(false);

    const afterB = await readRow(overridden!.id);
    expect(afterB.isTransfer).toBe(false);
    expect(afterB.isTransferUserOverridden).toBe(true);
    expect(afterB.weeklyAllowance).toBe(true);

    const afterC = await readRow(merchant!.id);
    expect(afterC.isTransfer).toBe(false);
    expect(afterC.weeklyAllowance).toBe(true);

    // Idempotency: a second pass should match nothing.
    const second = await runStartupCardPaymentReclassify();
    expect(second.reclassified).toBe(0);
  });

  // (#642) The original sweep skips user-overridden rows by design (so the
  // user's manual classification sticks). But a transfer-looking row that
  // is *also* tagged Unplanned is a contradiction: it shouldn't drive the
  // dashboard's Unplanned bucket. The sibling sweep clears just the
  // `unplannedAllowance` flag, leaving `isTransfer` and the override flag
  // alone.
  it("(#642) strips unplannedAllowance from user-overridden transfer-looking rows without flipping isTransfer", async () => {
    const [overriddenUnplanned] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-13",
        description: "Online Transfer to SAV ...9128",
        amount: "-500.00",
        isTransfer: false,
        isTransferUserOverridden: true,
        weeklyAllowance: false,
        monthlyAllowance: false,
        unplannedAllowance: true,
        source: "plaid:chase",
      })
      .returning();

    const out = await runStartupCardPaymentReclassify();
    expect(out.unplannedStripped).toBeGreaterThanOrEqual(1);

    const after = await readRow(overriddenUnplanned!.id);
    expect(after.unplannedAllowance).toBe(false);
    expect(after.isTransfer).toBe(false);
    expect(after.isTransferUserOverridden).toBe(true);

    const second = await runStartupCardPaymentReclassify();
    expect(second.unplannedStripped).toBe(0);
  });
});
