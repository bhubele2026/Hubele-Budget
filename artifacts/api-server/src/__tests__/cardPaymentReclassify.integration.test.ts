import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const PLAID_ACCESS_TOKEN = "access-sandbox-test-token";
let TEST_HOUSEHOLD_ID: string;

const transactionsSyncMock = vi.fn();
vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({ transactionsSync: transactionsSyncMock }),
  };
});

import {
  db,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";
import { runStartupCardPaymentReclassify } from "../lib/startupCardPaymentReclassify";
import { createTestHousehold } from "./_helpers/testHousehold";

async function deleteAllForUser(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
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

// (#666) Auto-detection of transfers and card payments is disabled.
// The startup reclassify sweep is a no-op, and Plaid sync no longer
// flips `isTransfer` on bland-description / LOAN_PAYMENTS rows. The
// user is in full manual control: only explicitly assigning a row to
// the system "Transfer" category sets `isTransfer=true`.
describe("(#666) Card-payment auto-classification is disabled", () => {
  it("startup sweep does NOT flip card-payment-pattern rows to isTransfer", async () => {
    const [cardPayment] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-15",
        description: "ONLINE PAYMENT - THANK YOU",
        amount: "-1234.56",
        isTransfer: false,
        monthlyAllowance: true,
        source: "manual",
      })
      .returning();

    const summary = await runStartupCardPaymentReclassify();
    expect(summary.reclassified).toBe(0);

    const after = await readRow(cardPayment!.id);
    expect(after.isTransfer).toBe(false);
    expect(after.monthlyAllowance).toBe(true);
  });

  it("startup sweep does NOT flip rows whose Plaid PFC primary is LOAN_PAYMENTS", async () => {
    const [pfcCardPayment] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-25",
        description: "ACH WEB PAYMENT 12345",
        amount: "-300.00",
        isTransfer: false,
        monthlyAllowance: true,
        source: "plaid:card",
        plaidTransactionId: `t-${randomUUID()}`,
        plaidAccountId: "acct-cc-2",
        pfcPrimary: "LOAN_PAYMENTS",
        pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      })
      .returning();

    const summary = await runStartupCardPaymentReclassify();
    expect(summary.reclassified).toBe(0);

    const after = await readRow(pfcCardPayment!.id);
    expect(after.isTransfer).toBe(false);
    expect(after.monthlyAllowance).toBe(true);
  });

  it("Plaid sync upsert does NOT flip pre-existing rows to transfer when modified row carries LOAN_PAYMENTS PFC", async () => {
    const plaidTxnId = `t-${randomUUID()}`;
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-20",
        description: "ONLINE PAYMENT - THANK YOU",
        amount: "-500.00",
        isTransfer: false,
        weeklyAllowance: true,
        monthlyAllowance: true,
        unplannedAllowance: true,
        source: "plaid:card",
        plaidTransactionId: plaidTxnId,
        plaidAccountId: "acct-cc-1",
      })
      .returning();

    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `it-${randomUUID()}`,
        accessToken: PLAID_ACCESS_TOKEN,
        institutionName: "Test Card",
        institutionSlug: "card",
      })
      .returning();

    transactionsSyncMock.mockResolvedValueOnce({
      data: {
        added: [],
        modified: [
          {
            transaction_id: plaidTxnId,
            account_id: "acct-cc-1",
            amount: 500.0,
            date: "2026-04-20",
            name: "ONLINE PAYMENT - THANK YOU",
            merchant_name: null,
            pending: false,
            personal_finance_category: {
              primary: "LOAN_PAYMENTS",
              detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
            },
          },
        ],
        removed: [],
        next_cursor: "cur-cc-1",
        has_more: false,
      },
    });

    const syncResult = await syncPlaidItem(TEST_USER, item!.id);
    expect(syncResult.error).toBeNull();

    const after = await readRow(row!.id);
    expect(after.isTransfer).toBe(false);
    expect(after.weeklyAllowance).toBe(true);
    expect(after.monthlyAllowance).toBe(true);
    expect(after.unplannedAllowance).toBe(true);
  });
});
