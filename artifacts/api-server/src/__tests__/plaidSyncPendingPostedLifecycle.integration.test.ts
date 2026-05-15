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
import { eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `pendpost-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

type Txn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
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
  db,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

async function seedChaseRelinkScenario(): Promise<{
  itemRowId: string;
  acctRowId: string;
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
  // Fresh-relink shape: brand-new plaid_accounts row with a today-ish
  // import cutoff and firstSyncCompletedAt still null. This is exactly
  // the state in which #662 was silently dropping pending Plaid rows.
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      importCutoffDate: "2026-05-15",
    })
    .returning();
  return { itemRowId: item!.id, acctRowId: acct!.id, externalAcctId };
}

describe("(#662) Plaid pending → posted lifecycle survives the first-sync cutoff", () => {
  it("inserts the pending row on first sync and updates the same row in place when it later posts", async () => {
    const { itemRowId, externalAcctId } = await seedChaseRelinkScenario();

    // First sync: Plaid returns a pending row whose authorization
    // `date` is a couple days before the import cutoff. Pre-#662 this
    // was silently filtered out; now it must land.
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-pending-life",
          account_id: externalAcctId,
          date: "2026-05-13",
          amount: 502.0,
          name: "Venmo (pending)",
          pending: true,
        },
      ],
      modified: [],
      removed: [],
    };
    const first = await syncPlaidItem(TEST_USER, itemRowId);
    expect(first.added).toBe(1);
    expect(first.skippedPreCutoff ?? 0).toBe(0);

    const afterFirst = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].plaidTransactionId).toBe("plaid-pending-life");
    expect(afterFirst[0].notes).toBe("[pending]");
    const originalRowId = afterFirst[0].id;

    // Second sync: Plaid sends the SAME transaction_id as a `modified`
    // row, now with pending=false and a concrete posted date. The
    // existing onConflictDoUpdate path must update the same row in
    // place — no duplicate insert.
    nextSyncResponse = {
      added: [],
      modified: [
        {
          transaction_id: "plaid-pending-life",
          account_id: externalAcctId,
          date: "2026-05-14",
          amount: 502.0,
          name: "Venmo",
          pending: false,
        },
      ],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const afterSecond = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(originalRowId);
    expect(afterSecond[0].plaidTransactionId).toBe("plaid-pending-life");
    expect(afterSecond[0].occurredOn).toBe("2026-05-14");
    // [pending] tag cleared once the row posts.
    expect(afterSecond[0].notes).toBeNull();
  });
});
