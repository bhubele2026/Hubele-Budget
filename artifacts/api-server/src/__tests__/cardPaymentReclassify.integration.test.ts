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

describe("(#632) startup card-payment reclassify sweep", () => {
  it("flips card-payment rows to isTransfer + clears allowance flags, leaves user-overridden and unrelated rows alone, and is idempotent", async () => {
    // (a) Card-payment row mis-tagged as Monthly spend.
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

    // (b) Card-payment-pattern row the user has explicitly overridden
    //     (they want it to count as spend, weird but allowed).
    const [overridden] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-16",
        description: "AUTOPAY PAYMENT TO CHASE CARD 4444",
        amount: "-200.00",
        isTransfer: false,
        isTransferUserOverridden: true,
        weeklyAllowance: true,
        source: "manual",
      })
      .returning();

    // (c) Unrelated merchant row — must not be touched.
    const [merchant] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-17",
        description: "STARBUCKS STORE 4477",
        amount: "-5.50",
        isTransfer: false,
        weeklyAllowance: true,
        source: "manual",
      })
      .returning();

    const summary = await runStartupCardPaymentReclassify();
    expect(summary.reclassified).toBeGreaterThanOrEqual(1);

    const a = await readRow(cardPayment!.id);
    expect(a.isTransfer).toBe(true);
    expect(a.weeklyAllowance).toBe(false);
    expect(a.monthlyAllowance).toBe(false);
    expect(a.unplannedAllowance).toBe(false);

    const b = await readRow(overridden!.id);
    expect(b.isTransfer).toBe(false);
    expect(b.isTransferUserOverridden).toBe(true);
    expect(b.weeklyAllowance).toBe(true);

    const c = await readRow(merchant!.id);
    expect(c.isTransfer).toBe(false);
    expect(c.weeklyAllowance).toBe(true);

    // Idempotency: a second run finds nothing left to fix.
    const second = await runStartupCardPaymentReclassify();
    expect(second.reclassified).toBe(0);
  });

  it("Plaid sync upsert clears Weekly/Monthly/Unplanned allowance flags when the row is auto-classified as transfer", async () => {
    const plaidTxnId = `t-${randomUUID()}`;
    // Pre-existing row carrying stale allowance flags.
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
    expect(after.isTransfer).toBe(true);
    expect(after.weeklyAllowance).toBe(false);
    expect(after.monthlyAllowance).toBe(false);
    expect(after.unplannedAllowance).toBe(false);
  });
});
