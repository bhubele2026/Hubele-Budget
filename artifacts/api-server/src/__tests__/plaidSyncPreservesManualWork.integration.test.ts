// Regression tests for the "every Chase sync erases my work" bug.
//
// Root cause: the sync never used Plaid's `pending_transaction_id`. When a
// pending charge posted under a NEW transaction_id (amount drifts on posting —
// tip, auth-hold → final — or the date shifts > 2 days), the fragile fuzzy
// re-mint heuristic (exact amount + date ±2 days) missed, so the posted row was
// INSERTed fresh (auto-categorized, no buckets) and the user's original
// pending row — carrying their manual category AND Weekly/Monthly/Unplanned
// allowance flags AND weeklyBucket — was DELETED by the unguarded `removed`
// handler. Net: category + all allowance/bucket work wiped in one shot.
//
// Fix: adopt `pending_transaction_id` (re-key the existing row in place,
// writing only Plaid-owned fields so every manual field is preserved) + guard
// the delete paths so a user-touched row is never hard-deleted.
//
// Note: the sync's transfer-detected allowance-clearing branch is NOT exercised
// here because auto-transfer detection is disabled app-wide (#666 —
// transferHeuristic.ts constants are empty), so `categorize()` always returns
// isTransfer:false on sync. The live erasure path is the delete+reinsert above.
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `preserve-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
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
        data: {
          item: { item_id: "item-default", consent_expiration_time: null },
        },
      }),
    }),
  };
});

import {
  budgetCategoriesTable,
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";

let CAT_ID: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  const [cat] = await db
    .insert(budgetCategoriesTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: `Dining ${randomUUID().slice(0, 6)}`,
      kind: "expense",
    })
    .returning({ id: budgetCategoriesTable.id });
  CAT_ID = cat!.id;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
});

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

/** Seed a past-first-sync Chase checking account so rows flow straight to the
 * upsert / adoption paths (no import-cutoff gating). */
async function seedChaseAccount(): Promise<{
  itemRowId: string;
  externalAcctId: string;
}> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const externalAcctId = `acct-${randomUUID()}`;
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: externalAcctId,
    name: "Chase Checking",
    type: "depository",
    subtype: "checking",
    firstSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return { itemRowId: item!.id, externalAcctId };
}

describe("Chase sync preserves manual work across pending→posted", () => {
  it("adopts pending_transaction_id and preserves category + allowance flags + bucket despite an amount & date change", async () => {
    const { itemRowId, externalAcctId } = await seedChaseAccount();

    // A pending charge the user already categorized AND bucketed into their
    // Weekly allowance.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-10",
      description: "RESTAURANT AUTH HOLD",
      amount: "-50.00",
      source: "plaid:chase",
      plaidTransactionId: "PEND1",
      plaidAccountId: externalAcctId,
      pending: true,
      categoryId: CAT_ID,
      weeklyAllowance: true,
      weeklyBucket: "dining",
    });

    // Plaid posts it under a NEW id, references the pending via
    // pending_transaction_id, with a tip-adjusted amount and a >2-day shift
    // (defeats the fuzzy re-mint), and lists the old id in `removed`.
    nextSyncResponse = {
      added: [
        {
          transaction_id: "POST1",
          account_id: externalAcctId,
          date: "2026-05-14",
          amount: 58.0,
          name: "RESTAURANT",
          pending: false,
          pending_transaction_id: "PEND1",
        },
      ],
      modified: [],
      removed: [{ transaction_id: "PEND1" }],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.plaidTransactionId).toBe("POST1"); // adopted the new id
    expect(row.pending).toBe(false); // posted
    expect(row.occurredOn).toBe("2026-05-14"); // refreshed from Plaid
    // Every piece of manual work is PRESERVED:
    expect(row.categoryId).toBe(CAT_ID);
    expect(row.weeklyAllowance).toBe(true);
    expect(row.weeklyBucket).toBe("dining");
    // Old pending id no longer exists (re-keyed, so `removed` no-op'd).
    const oldRow = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidTransactionId, "PEND1"));
    expect(oldRow).toHaveLength(0);
  });

  it("honors a manual date edit through the adoption (occurredOnUserOverridden sticks)", async () => {
    const { itemRowId, externalAcctId } = await seedChaseAccount();
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-09", // user pulled it into the prior allowance week
      description: "COFFEE AUTH",
      amount: "-5.00",
      source: "plaid:chase",
      plaidTransactionId: "PENDC",
      plaidAccountId: externalAcctId,
      pending: true,
      categoryId: CAT_ID,
      occurredOnUserOverridden: true,
    });

    nextSyncResponse = {
      added: [
        {
          transaction_id: "POSTC",
          account_id: externalAcctId,
          date: "2026-05-12",
          amount: 6.0,
          name: "COFFEE",
          pending: false,
          pending_transaction_id: "PENDC",
        },
      ],
      modified: [],
      removed: [{ transaction_id: "PENDC" }],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const [row] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidTransactionId, "POSTC"));
    expect(row.occurredOn).toBe("2026-05-09"); // user's date preserved
    expect(row.categoryId).toBe(CAT_ID);
  });
});

describe("`removed` never hard-deletes a user-touched row", () => {
  it("keeps categorized / bucketed rows that Plaid removes, but still deletes an untouched one", async () => {
    const { itemRowId, externalAcctId } = await seedChaseAccount();

    // Categorized row...
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-10",
      description: "CATEGORIZED",
      amount: "-30.00",
      source: "plaid:chase",
      plaidTransactionId: "CATED",
      plaidAccountId: externalAcctId,
      categoryId: CAT_ID,
    });
    // ...bucketed-only row (no category, but weekly allowance set)...
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-10",
      description: "BUCKETED",
      amount: "-20.00",
      source: "plaid:chase",
      plaidTransactionId: "BUCKD",
      plaidAccountId: externalAcctId,
      weeklyAllowance: true,
    });
    // ...and an untouched, uncategorized one.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-10",
      description: "UNTOUCHED",
      amount: "-10.00",
      source: "plaid:chase",
      plaidTransactionId: "UNTCH",
      plaidAccountId: externalAcctId,
    });

    nextSyncResponse = {
      added: [],
      modified: [],
      removed: [
        { transaction_id: "CATED" },
        { transaction_id: "BUCKD" },
        { transaction_id: "UNTCH" },
      ],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const survivors = await db
      .select({ ptid: transactionsTable.plaidTransactionId })
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    const ids = survivors.map((r) => r.ptid).sort();
    expect(ids).toEqual(["BUCKD", "CATED"]); // touched rows kept
    // untouched one deleted
    const gone = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.plaidTransactionId, "UNTCH"),
        ),
      );
    expect(gone).toHaveLength(0);
  });
});
