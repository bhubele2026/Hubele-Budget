// PR-0 · Plaid sync never writes transactions.category_locked_by_user.
//
// The sync's upserts list the Plaid-owned fields they refresh, and neither
// `category_id` nor the lock is among them, so a hand-filed row keeps its
// category AND its lock through a `modified` re-send of the same
// plaid_transaction_id and through the pending→posted re-key. A row the sync
// inserts and files by rule is never born locked.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `synclock-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

type Txn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
  pending_transaction_id?: string | null;
};

let nextSyncResponse: {
  added: Txn[];
  modified: Txn[];
  removed: { transaction_id: string }[];
} = { added: [], modified: [], removed: [] };

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
      itemGet: async () => ({
        data: { item: { item_id: "item-default", consent_expiration_time: null } },
      }),
    }),
  };
});

import {
  budgetCategoriesTable,
  db,
  mappingRulesTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";

let HAND_CAT: string;
let RULE_CAT: string;

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.householdId, TEST_HOUSEHOLD_ID));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  const cats = await db
    .insert(budgetCategoriesTable)
    .values(
      ["Hand filed", "Rule filed"].map((name) => ({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `${name} ${randomUUID().slice(0, 6)}`,
        kind: "expense",
      })),
    )
    .returning({ id: budgetCategoriesTable.id });
  HAND_CAT = cats[0]!.id;
  RULE_CAT = cats[1]!.id;
});

afterAll(async () => {
  await cleanup();
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
});

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

async function seedCheckingAccount(): Promise<{ itemRowId: string; acct: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Test Bank",
      institutionSlug: "chase",
    })
    .returning();
  const acct = `acct-${randomUUID()}`;
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: acct,
    name: "Test Checking",
    type: "depository",
    subtype: "checking",
    firstSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return { itemRowId: item!.id, acct };
}

async function byPlaidId(ptid: string) {
  const [row] = await db
    .select({
      categoryId: transactionsTable.categoryId,
      locked: transactionsTable.categoryLockedByUser,
      amount: transactionsTable.amount,
      description: transactionsTable.description,
    })
    .from(transactionsTable)
    .where(eq(transactionsTable.plaidTransactionId, ptid));
  return row;
}

describe("Plaid sync and category_locked_by_user", () => {
  it("a modified re-send of the same plaid_transaction_id keeps the category and the lock", async () => {
    const { itemRowId, acct } = await seedCheckingAccount();
    const ptid = `LOCK-${randomUUID()}`;
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-10",
      description: "SHOP ORIGINAL",
      amount: "-20.00",
      source: "plaid:chase",
      plaidTransactionId: ptid,
      plaidAccountId: acct,
      categoryId: HAND_CAT,
      isTransferUserOverridden: true,
      categoryLockedByUser: true,
    });

    nextSyncResponse = {
      added: [],
      modified: [
        { transaction_id: ptid, account_id: acct, date: "2026-05-10", amount: 21.5, name: "SHOP RENAMED" },
      ],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const row = await byPlaidId(ptid);
    // The upsert really ran (Plaid-owned fields refreshed)...
    expect(row!.amount).toBe("-21.50");
    expect(row!.description).toBe("SHOP RENAMED");
    // ...and left the person's filing alone.
    expect(row!.categoryId).toBe(HAND_CAT);
    expect(row!.locked).toBe(true);
  });

  it("the pending→posted re-key carries the lock to the posted row", async () => {
    const { itemRowId, acct } = await seedCheckingAccount();
    const pend = `LOCKP-${randomUUID()}`;
    const post = `LOCKQ-${randomUUID()}`;
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-10",
      description: "DINER AUTH HOLD",
      amount: "-40.00",
      source: "plaid:chase",
      plaidTransactionId: pend,
      plaidAccountId: acct,
      pending: true,
      categoryId: HAND_CAT,
      isTransferUserOverridden: true,
      categoryLockedByUser: true,
    });

    nextSyncResponse = {
      added: [
        {
          transaction_id: post,
          account_id: acct,
          date: "2026-05-13",
          amount: 46.0,
          name: "DINER",
          pending: false,
          pending_transaction_id: pend,
        },
      ],
      modified: [],
      removed: [{ transaction_id: pend }],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    expect(await byPlaidId(pend)).toBeUndefined();
    const row = await byPlaidId(post);
    expect(row!.categoryId).toBe(HAND_CAT);
    expect(row!.locked).toBe(true);
  });

  it("a row the sync inserts and files by rule is not locked", async () => {
    const { itemRowId, acct } = await seedCheckingAccount();
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      pattern: "SYNCLOCK RULED",
      matchType: "contains",
      categoryId: RULE_CAT,
      priority: 100,
    });
    const ptid = `LOCKR-${randomUUID()}`;
    nextSyncResponse = {
      added: [
        { transaction_id: ptid, account_id: acct, date: "2026-05-11", amount: 9.0, name: "SYNCLOCK RULED 7" },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const row = await byPlaidId(ptid);
    expect(row!.categoryId).toBe(RULE_CAT);
    expect(row!.locked).toBe(false);
  });
});
