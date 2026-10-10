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
  categoryDecisionsTable,
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

async function seedCheckingAccount(type = "depository"): Promise<{ itemRowId: string; acct: string }> {
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
    name: type === "credit" ? "Test Card" : "Test Checking",
    type,
    subtype: type === "credit" ? "credit card" : "checking",
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

// (WP5d) The insert-time rule fill never files money against its direction:
// a payroll deposit a rule would put under an expense category is inserted
// UNcategorized, and the engine at the end of the sync queues it, naming the
// rule. A card's credit and the right direction are filed as before.
describe("(WP5d) the sync's insert-time fill and the direction guard", () => {
  async function rule(pattern: string): Promise<string> {
    const [r] = await db
      .insert(mappingRulesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, pattern, matchType: "contains", categoryId: RULE_CAT, priority: 100 })
      .returning({ id: mappingRulesTable.id });
    return r!.id;
  }
  const decisionsOf = async (ptid: string) => {
    const [row] = await db.select({ id: transactionsTable.id }).from(transactionsTable).where(eq(transactionsTable.plaidTransactionId, ptid));
    return db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, row!.id));
  };

  it("a deposit a rule would file under an expense category inserts uncategorized and is queued, naming the rule", async () => {
    const { itemRowId, acct } = await seedCheckingAccount();
    const ruleId = await rule("SYNCDIR BIGCO");
    const pay = `DIRP-${randomUUID()}`;
    const cafe = `DIRC-${randomUUID()}`;
    nextSyncResponse = {
      added: [
        // Plaid's sign: negative = money in.
        { transaction_id: pay, account_id: acct, date: "2026-05-12", amount: -2500, name: "SYNCDIR BIGCO PAYROLL" },
        { transaction_id: cafe, account_id: acct, date: "2026-05-12", amount: 8.5, name: "SYNCDIR BIGCO CAFE" },
      ],
      modified: [],
      removed: [],
    };
    const result = await syncPlaidItem(TEST_USER, itemRowId);

    expect(await byPlaidId(pay)).toMatchObject({ categoryId: null, locked: false, amount: "2500.00" });
    const [d] = await decisionsOf(pay);
    expect(d).toMatchObject({
      source: "rule",
      band: "queue",
      categoryId: RULE_CAT,
      ruleId,
      explanation: "Money in, but this would file it under an expense category.",
    });
    // The cafeteria charge is money out under an expense: filed by the rule as before.
    expect(await byPlaidId(cafe)).toMatchObject({ categoryId: RULE_CAT, locked: false });
    // Only the filed row is counted as auto-categorized by the rule.
    expect(result.autoCategorized).toBe(1);
    expect(result.ruleAttributions).toEqual([expect.objectContaining({ ruleId, count: 1 })]);
  });

  it("must not change: a credit on a card of any bank is filed by the rule as before", async () => {
    const { itemRowId, acct } = await seedCheckingAccount("credit");
    await rule("SYNCDIR STORE");
    const credit = `DIRK-${randomUUID()}`;
    nextSyncResponse = {
      added: [{ transaction_id: credit, account_id: acct, date: "2026-05-12", amount: -20, name: "SYNCDIR STORE 9" }],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    expect(await byPlaidId(credit)).toMatchObject({ categoryId: RULE_CAT, locked: false, amount: "20.00" });
  });
});
