import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { createTestHousehold } from "./_helpers/testHousehold";
import {
  runStartupOrphanTransactionRepair,
  scanOrphanTransactionsByHousehold,
} from "../lib/startupOrphanTransactionRepair";

const TEST_USER = `orphan-txn-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
});
beforeEach(async () => {
  await cleanup();
});
afterAll(async () => {
  await cleanup();
});

async function insertItem(): Promise<string> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID().slice(0, 8)}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  return item!.id;
}

async function insertAccount(itemRowId: string, externalId: string): Promise<string> {
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: itemRowId,
      accountId: externalId,
      name: "Platinum Card®",
      mask: "1009",
      type: "credit",
      subtype: "credit card",
    })
    .returning();
  return acct!.id;
}

async function insertTxn(externalAcctId: string, debtId: string | null): Promise<string> {
  const [txn] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-01",
      description: "AMEX CHARGE",
      amount: "12.34",
      source: "plaid",
      plaidTransactionId: `ptx-${randomUUID().slice(0, 8)}`,
      plaidAccountId: externalAcctId,
      debtId: debtId ?? undefined,
    })
    .returning();
  return txn!.id;
}

describe("(#796) runStartupOrphanTransactionRepair", () => {
  it("scans and reports orphaned transactions per household", async () => {
    // Orphan: transaction points at an external account_id with no row.
    await insertTxn(`gone-${randomUUID().slice(0, 8)}`, null);
    await insertTxn(`gone-${randomUUID().slice(0, 8)}`, null);

    const scan = await scanOrphanTransactionsByHousehold();
    const mine = scan.households.find((h) => h.householdId === TEST_HOUSEHOLD_ID);
    expect(mine?.orphanCount).toBe(2);

    const summary = await runStartupOrphanTransactionRepair();
    const reported = summary.households.find(
      (h) => h.householdId === TEST_HOUSEHOLD_ID,
    );
    expect(reported?.orphanCount).toBe(2);
  });

  it("re-points a debt-linked orphan onto the debt's current account", async () => {
    // The wiped item left a transaction pointing at the OLD external id.
    const oldExternalId = `old-${randomUUID().slice(0, 8)}`;
    // The user's CURRENT item now owns the same real card under a NEW id.
    const newExternalId = `new-${randomUUID().slice(0, 8)}`;
    const itemRowId = await insertItem();
    const acctRowId = await insertAccount(itemRowId, newExternalId);
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Amex Platinum",
        balance: "100.00",
        plaidAccountId: acctRowId,
      })
      .returning();
    const txnId = await insertTxn(oldExternalId, debt!.id);

    const summary = await runStartupOrphanTransactionRepair();
    expect(summary.repointed).toBeGreaterThanOrEqual(1);

    const [after] = await db
      .select({ plaidAccountId: transactionsTable.plaidAccountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txnId));
    expect(after?.plaidAccountId).toBe(newExternalId);

    // Idempotent: a second run finds nothing left to repoint.
    const second = await runStartupOrphanTransactionRepair();
    expect(second.repointed).toBe(0);
    const residual = second.residualHouseholds.find(
      (h) => h.householdId === TEST_HOUSEHOLD_ID,
    );
    expect(residual).toBeUndefined();
  });

  it("leaves a healthy transaction (live account row) untouched", async () => {
    const externalId = `live-${randomUUID().slice(0, 8)}`;
    const itemRowId = await insertItem();
    await insertAccount(itemRowId, externalId);
    const txnId = await insertTxn(externalId, null);

    const summary = await runStartupOrphanTransactionRepair();
    expect(summary.repointed).toBe(0);
    const reported = summary.households.find(
      (h) => h.householdId === TEST_HOUSEHOLD_ID,
    );
    expect(reported).toBeUndefined();

    const [after] = await db
      .select({ plaidAccountId: transactionsTable.plaidAccountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txnId));
    expect(after?.plaidAccountId).toBe(externalId);
  });
});
