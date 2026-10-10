// ⭐ (WP2) THE SYNC TAGS PAYMENTS, NOT EVERY POSITIVE CARD ROW.
//
// A row synced from a credit card linked to a debt used to be tagged to that
// debt whenever its amount was positive — refunds and statement credits
// included — and the pending reader then netted each of them off the debt as
// if it were a payment (Brad's Platinum: $2,615.71 "paid, not posted" beside a
// balance that already held it). The sync now tags only rows
// `classifyLiabilityRow` calls a payment (`debtIdForSyncedRow`). A row tagged
// before keeps its stored tag — no stored data is rewritten — and the pending
// reader excludes it by the same rule.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `tagshape-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

type Txn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
  personal_finance_category?: { primary: string; detailed: string } | null;
};

let nextSyncResponse: { added: Txn[]; modified: Txn[]; removed: { transaction_id: string }[] } = {
  added: [],
  modified: [],
  removed: [],
};

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: {
          added: nextSyncResponse.added,
          modified: nextSyncResponse.modified,
          removed: nextSyncResponse.removed,
          next_cursor: "cursor-x",
          has_more: false,
        },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({ data: { item: { item_id: "item-default", consent_expiration_time: null } } }),
    }),
  };
});

import { db, debtsTable, plaidAccountsTable, plaidItemsTable, settingsTable, transactionsTable } from "@workspace/db";
import { addDaysISO } from "@workspace/avalanche-core";
import { syncPlaidItem } from "../lib/plaidSync";
import { loadPendingPayments } from "../lib/debtPending";
import { householdDayOf } from "../lib/householdClock";

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

async function seed() {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  const cardExt = `acct-plat-${randomUUID()}`;
  const [card] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: cardExt,
      name: "Platinum Card",
      mask: "1005",
      type: "credit",
      subtype: "credit card",
    })
    .returning();
  // Synced half an hour ago: rows dated the next day are after its as-of day.
  const syncedAt = new Date(Date.now() - 30 * 60 * 1000);
  const [debt] = await db
    .insert(debtsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Amex Platinum",
      balance: "3842.98",
      apr: "0",
      minPayment: "85",
      plaidAccountId: card!.id,
      balanceSource: "plaid",
      plaidLastSyncedAt: syncedAt,
      status: "active",
    })
    .returning();
  return { itemRowId: item!.id, cardExt, debt: debt!, next: addDaysISO(householdDayOf(syncedAt), 1) };
}

async function rowsById() {
  const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  return new Map(rows.map((r) => [r.plaidTransactionId, r] as const));
}

describe("(WP2) the sync tags a debt-linked card's PAYMENTS only", () => {
  it("a payment (by words or by Plaid's category) is tagged; a refund, a credit and a purchase are not", async () => {
    const { itemRowId, cardExt, debt, next } = await seed();
    // Plaid's sign: positive is money out of the account (a charge on a card).
    nextSyncResponse.added = [
      { transaction_id: "pt-pay", account_id: cardExt, date: next, amount: -2615.71, name: "ONLINE PAYMENT - THANK YOU" },
      {
        transaction_id: "pt-pfc-pay",
        account_id: cardExt,
        date: next,
        amount: -100,
        name: "ACH CREDIT 0042",
        personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
      },
      { transaction_id: "pt-refund", account_id: cardExt, date: next, amount: -54.19, name: "TARGET T-1123 REFUND" },
      { transaction_id: "pt-credit", account_id: cardExt, date: next, amount: -25, name: "PLATINUM DINING CREDIT" },
      { transaction_id: "pt-charge", account_id: cardExt, date: next, amount: 200, name: "DELTA AIR LINES" },
    ];
    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await rowsById();
    expect(rows.get("pt-pay")?.debtId).toBe(debt.id);
    expect(rows.get("pt-pfc-pay")?.debtId).toBe(debt.id);
    // Before WP2 the refund and the credit were tagged too (positive amounts).
    expect(Number(rows.get("pt-refund")?.amount)).toBeCloseTo(54.19, 2);
    expect(rows.get("pt-refund")?.debtId).toBeNull();
    expect(rows.get("pt-credit")?.debtId).toBeNull();
    expect(rows.get("pt-charge")?.debtId).toBeNull();

    // And the pending reader nets the two payments only.
    const pending = await loadPendingPayments(TEST_HOUSEHOLD_ID, [debt]);
    expect(pending.get(debt.id)).toEqual({ total: 2715.71, count: 2 });
  });

  it("⭐ (WP2 review) a payment the household typed, merged with the feed's own row, is still pending — once", async () => {
    const { itemRowId, cardExt, debt, next } = await seed();
    // The account's first sync, with a cutoff: the first-sync merge adopts a
    // typed row of the same day and amount instead of inserting a twin.
    await db
      .update(plaidAccountsTable)
      .set({ importCutoffDate: addDaysISO(next, 3), firstSyncCompletedAt: null })
      .where(eq(plaidAccountsTable.accountId, cardExt));
    // The household's shorthand: no payment words, no Plaid category.
    await db.insert(transactionsTable).values({
      userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: next, description: "Blue card",
      amount: "500.00", source: "manual", debtId: debt.id,
    });
    expect((await loadPendingPayments(TEST_HOUSEHOLD_ID, [debt])).get(debt.id)).toEqual({ total: 500, count: 1 });

    nextSyncResponse.added = [
      {
        transaction_id: "pt-merged", account_id: cardExt, date: next, amount: -500, name: "ONLINE PAYMENT - THANK YOU",
        personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
      },
    ];
    await syncPlaidItem(TEST_USER, itemRowId);

    // Merged, not doubled: the typed row adopted the feed's id, words and category, and kept its tag.
    const all = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      plaidTransactionId: "pt-merged",
      description: "ONLINE PAYMENT - THANK YOU",
      pfcPrimary: "LOAN_PAYMENTS",
      debtId: debt.id,
    });
    // Before the fix it kept "Blue card" with no category, read as a credit, and left pending.
    expect((await loadPendingPayments(TEST_HOUSEHOLD_ID, [debt])).get(debt.id)).toEqual({ total: 500, count: 1 });
  });

  it("a refund the OLD sync tagged keeps its stored tag (no rewrite) and is still not counted as a payment", async () => {
    const { itemRowId, cardExt, debt, next } = await seed();
    // Tagged before WP2, as every positive card row was.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: next,
      description: "AMAZON MKTPL REFUND",
      amount: "25.00",
      source: "plaid:amex",
      plaidTransactionId: "pt-old-refund",
      plaidAccountId: cardExt,
      debtId: debt.id,
    });
    // Plaid re-sends it (a metadata change): the upsert leaves the stored tag alone.
    nextSyncResponse.modified = [
      { transaction_id: "pt-old-refund", account_id: cardExt, date: next, amount: -25, name: "AMAZON MKTPL REFUND" },
    ];
    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await rowsById();
    expect(rows.get("pt-old-refund")?.debtId).toBe(debt.id);
    // Excluded at read time by the same shape rule.
    const pending = await loadPendingPayments(TEST_HOUSEHOLD_ID, [debt]);
    expect(pending.get(debt.id)).toBeUndefined();
  });
});
