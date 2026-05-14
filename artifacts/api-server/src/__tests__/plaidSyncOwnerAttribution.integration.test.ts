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
import { eq, inArray } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

// (#623 follow-up) Regression test for "Plaid sees the expense but the
// app doesn't". Before the fix, syncPlaidItem stamped `transactions.user_id`
// with the *actor* (whoever's session triggered the sync) instead of the
// household owner. When a non-owner member opened the app and a background
// sync fired, every new Plaid row landed under the member's user_id and
// was filtered out of the owner's user_id-scoped ledger view.
const OWNER_ID = `owner-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const MEMBER_ID = `member-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HOUSEHOLD_ID: string;

type AddedTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
};

let nextSyncResponse: {
  added: AddedTxn[];
  modified: AddedTxn[];
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
          next_cursor: "cursor-1",
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
  householdMembersTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";

async function cleanup(): Promise<void> {
  const ids = [OWNER_ID, MEMBER_ID];
  await db
    .delete(transactionsTable)
    .where(inArray(transactionsTable.userId, ids));
  await db
    .delete(plaidAccountsTable)
    .where(inArray(plaidAccountsTable.userId, ids));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, ids));
  await db
    .delete(householdMembersTable)
    .where(inArray(householdMembersTable.userId, ids));
}

beforeAll(async () => {
  const h = await createTestHousehold(OWNER_ID);
  HOUSEHOLD_ID = h.householdId;
  await db
    .insert(householdMembersTable)
    .values({
      userId: MEMBER_ID,
      householdId: HOUSEHOLD_ID,
      role: "member",
    })
    .onConflictDoNothing({ target: householdMembersTable.userId });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

async function seedItem(): Promise<{
  itemRowId: string;
  externalAcctId: string;
}> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: OWNER_ID,
      householdId: HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const externalAcctId = `acct-${randomUUID()}`;
  await db
    .insert(plaidAccountsTable)
    .values({
      userId: OWNER_ID,
      householdId: HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      mask: "5526",
      name: "TOTAL CHECKING",
      type: "depository",
      subtype: "checking",
      firstSyncCompletedAt: new Date(),
    })
    .returning();
  return { itemRowId: item!.id, externalAcctId };
}

describe("syncPlaidItem owner attribution (#623 follow-up)", () => {
  it("attributes new tx to the household owner even when a non-owner member triggers the sync", async () => {
    const { itemRowId, externalAcctId } = await seedItem();
    nextSyncResponse = {
      added: [
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAcctId,
          date: "2026-05-13",
          amount: 450, // Plaid debits are positive
          name: "AMERICAN EXPRESS ACH PMT",
        },
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAcctId,
          date: "2026-05-13",
          amount: -1500, // credit
          name: "Online Transfer from SAV",
        },
      ],
      modified: [],
      removed: [],
    };

    // Member (NOT the owner) triggers the sync — pre-fix this stamped
    // every inserted tx with MEMBER_ID and the owner's ledger view
    // rendered them invisible.
    await syncPlaidItem(MEMBER_ID, itemRowId);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, externalAcctId));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.userId).toBe(OWNER_ID);
      expect(r.householdId).toBe(HOUSEHOLD_ID);
    }
  });

  it("self-heals previously misattributed rows on the next sync", async () => {
    const { itemRowId, externalAcctId } = await seedItem();
    // Simulate the pre-fix bug state: a tx for this item's account is
    // attributed to the member instead of the owner.
    await db.insert(transactionsTable).values({
      userId: MEMBER_ID,
      householdId: HOUSEHOLD_ID,
      occurredOn: "2026-05-12",
      description: "Pre-fix orphan",
      amount: "-13.70",
      source: "plaid:chase",
      plaidTransactionId: `txn-${randomUUID()}`,
      plaidAccountId: externalAcctId,
    });

    // Sync with no new Plaid data — the self-heal step should still run
    // and repoint the orphan onto the owner.
    nextSyncResponse = { added: [], modified: [], removed: [] };
    await syncPlaidItem(MEMBER_ID, itemRowId);

    const [healed] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, externalAcctId));
    expect(healed?.userId).toBe(OWNER_ID);
    expect(healed?.householdId).toBe(HOUSEHOLD_ID);
  });

  it("is a no-op when the owner triggers their own sync", async () => {
    const { itemRowId, externalAcctId } = await seedItem();
    nextSyncResponse = {
      added: [
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAcctId,
          date: "2026-05-13",
          amount: 95,
          name: "TruStage Insurance",
        },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(OWNER_ID, itemRowId);
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, externalAcctId));
    expect(rows.length).toBe(1);
    expect(rows[0]?.userId).toBe(OWNER_ID);
  });
});
