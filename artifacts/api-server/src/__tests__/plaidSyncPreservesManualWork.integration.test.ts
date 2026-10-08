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
import { and, eq, inArray } from "drizzle-orm";
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
  categoryDecisionsTable,
  mappingRulesTable,
  merchantMemoryTable,
  transactionSplitsTable,
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
  if (TEST_HOUSEHOLD_ID) {
    await db.delete(mappingRulesTable).where(eq(mappingRulesTable.householdId, TEST_HOUSEHOLD_ID));
    await db.delete(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, TEST_HOUSEHOLD_ID));
  }
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

  it("(PR-A) a kept row is stamped plaid_removed_at and queued; a locked or split row is kept too", async () => {
    const { itemRowId, externalAcctId } = await seedChaseAccount();
    const base = { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: "2026-05-11", source: "plaid:chase", plaidAccountId: externalAcctId };
    const [kept] = await db.insert(transactionsTable).values({ ...base, description: "KEPT", amount: "-30.00", plaidTransactionId: "KEPT1", categoryId: CAT_ID }).returning();
    // A split parent with no category of its own used to be deleted.
    const [split] = await db.insert(transactionsTable).values({ ...base, description: "SPLITP", amount: "-40.00", plaidTransactionId: "SPLT1" }).returning();
    await db.insert(transactionSplitsTable).values([
      { householdId: TEST_HOUSEHOLD_ID, transactionId: split!.id, categoryId: CAT_ID, amount: "-25.00" },
      { householdId: TEST_HOUSEHOLD_ID, transactionId: split!.id, categoryId: CAT_ID, amount: "-15.00" },
    ]);
    await db.insert(transactionsTable).values({ ...base, description: "GONE", amount: "-5.00", plaidTransactionId: "GONE1" });
    nextSyncResponse = { added: [], modified: [], removed: [{ transaction_id: "KEPT1" }, { transaction_id: "SPLT1" }, { transaction_id: "GONE1" }] };
    await syncPlaidItem(TEST_USER, itemRowId);
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
    const byPtid = new Map(rows.map((r) => [r.plaidTransactionId, r]));
    expect(byPtid.has("GONE1")).toBe(false);
    expect(byPtid.get("KEPT1")!.plaidRemovedAt).not.toBeNull();
    expect(byPtid.get("SPLT1")!.plaidRemovedAt).not.toBeNull();
    const notices = await db.select().from(categoryDecisionsTable).where(inArray(categoryDecisionsTable.transactionId, [kept!.id, split!.id]));
    expect(notices.map((d) => [d.band, d.explanation])).toEqual([
      ["queue", "The bank removed this charge."],
      ["queue", "The bank removed this charge."],
    ]);
    // A second sync naming the same ids queues nothing new.
    await syncPlaidItem(TEST_USER, itemRowId);
    expect(await db.select().from(categoryDecisionsTable).where(inArray(categoryDecisionsTable.transactionId, [kept!.id, split!.id]))).toHaveLength(2);
  });

  it("(PR-A) the sync runs the engine over the rows it upserted: a rule fills a new row, memory a new merchant", async () => {
    const { itemRowId, externalAcctId } = await seedChaseAccount();
    await db.insert(mappingRulesTable).values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, pattern: "QUARRY HARDWARE", matchType: "contains", categoryId: CAT_ID, priority: 0 });
    await db.insert(merchantMemoryTable).values({ householdId: TEST_HOUSEHOLD_ID, signature: "brightside cafe", scope: "merchant", categoryId: CAT_ID, count: 3, createdAt: new Date(Date.now() - 60_000) });
    nextSyncResponse = {
      added: [
        { transaction_id: "ENG1", account_id: externalAcctId, date: "2026-05-12", amount: 22, name: "QUARRY HARDWARE 0099" },
        { transaction_id: "ENG2", account_id: externalAcctId, date: "2026-05-12", amount: 6, name: "BRIGHTSIDE CAFE" },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    const rows = await db.select().from(transactionsTable).where(inArray(transactionsTable.plaidTransactionId, ["ENG1", "ENG2"]));
    const byPtid = new Map(rows.map((r) => [r.plaidTransactionId, r]));
    expect(byPtid.get("ENG1")).toMatchObject({ categoryId: CAT_ID, categoryProvisional: false, categoryLockedByUser: false });
    expect(byPtid.get("ENG2")).toMatchObject({ categoryId: CAT_ID, categoryProvisional: false });
    const sources = await db.select({ s: categoryDecisionsTable.source }).from(categoryDecisionsTable).where(inArray(categoryDecisionsTable.transactionId, rows.map((r) => r.id)));
    expect(sources.map((x) => x.s).sort()).toEqual(["memory", "rule"]);
  });
});
