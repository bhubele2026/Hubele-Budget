// (#479 follow-up) Re-sync must not drag a user-flagged transfer back into
// the forecast register by force-resetting `forecastFlag=true`.
//
// Bug: `syncPlaidItem`'s onConflictDoUpdate re-set `forecastFlag: true` for
// any checking-account row whose freshly-computed `cat.isTransfer` was false.
// With the auto-transfer heuristic disabled (#666), `cat.isTransfer` is
// ALWAYS false, so a row the user manually flagged as a transfer
// (`is_transfer_user_overridden=true`, `is_transfer=true`) had its
// `forecastFlag` force-set back to `true` on every sync. The forecast
// register (`filterForecastTxns`) admits rows purely on
// `forecastFlag && isBankTxn` and does NOT re-check `isTransfer`, so the
// user's transfer leaked back into the running balance and faked reconcile
// slack. The fix guards the re-set with the same CASE the isTransfer /
// allowance re-sets use, so a user transfer keeps its (false) forecastFlag.
//
// This test mirrors the bank-snapshot harness so the synced account is the
// configured checking account (which is what makes `isChecking` true and
// the forecastFlag re-set fire in the first place).

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

const TEST_USER = `xfer-ff-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

const transactionsSyncMock = vi.fn();
vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: transactionsSyncMock,
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
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";
import { createTestHousehold } from "./_helpers/testHousehold";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  transactionsSyncMock.mockReset();
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

/** Seed an item + checking account configured as the bank snapshot, so the
 *  synced rows on that account count as `isChecking`. */
async function seedCheckingItem(): Promise<{
  itemRowId: string;
  externalAccountId: string;
}> {
  const externalAccountId = `acct-${randomUUID()}`;
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
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAccountId,
      name: "Chase Checking",
      mask: "1234",
      type: "depository",
      subtype: "checking",
      // Already past first sync so `added`/`modified` rows aren't gated by
      // the import cutoff — we want the modified row to flow straight to
      // the onConflictDoUpdate path.
      firstSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotAccountId: acct!.id,
    bankSnapshotName: "Chase Checking",
    bankSnapshotMask: "1234",
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: new Date("2026-01-01T00:00:00Z"),
    bankSnapshotSource: "manual",
  });
  return { itemRowId: item!.id, externalAccountId };
}

describe("(#479 follow-up) re-sync respects a user transfer's forecastFlag", () => {
  it("does NOT re-set forecastFlag=true on a checking row the user flagged as a transfer", async () => {
    const { itemRowId, externalAccountId } = await seedCheckingItem();

    // A checking-account Plaid row the user has manually classified as a
    // transfer: isTransfer=true, override=true, and (because it's a
    // transfer) pulled OUT of the forecast register (forecastFlag=false).
    const plaidTxnId = `t-${randomUUID()}`;
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-10",
        description: "TRANSFER TO BROKERAGE",
        amount: "-750.00",
        isTransfer: true,
        isTransferUserOverridden: true,
        forecastFlag: false,
        source: "plaid:chase",
        plaidTransactionId: plaidTxnId,
        plaidAccountId: externalAccountId,
      })
      .returning();
    expect(row!.isTransfer).toBe(true);
    expect(row!.forecastFlag).toBe(false);

    // Plaid re-delivers the same posting as a `modified` row. With the
    // auto-transfer heuristic disabled, cat.isTransfer is false — the path
    // that used to force forecastFlag=true.
    transactionsSyncMock.mockResolvedValueOnce({
      data: {
        added: [],
        modified: [
          {
            transaction_id: plaidTxnId,
            account_id: externalAccountId,
            amount: 750.0,
            date: "2026-05-10",
            name: "TRANSFER TO BROKERAGE",
            merchant_name: null,
            pending: false,
            personal_finance_category: {
              primary: "TRANSFER_OUT",
              detailed: "TRANSFER_OUT_INVESTMENT",
            },
          },
        ],
        removed: [],
        next_cursor: "cur-1",
        has_more: false,
      },
    });

    const syncResult = await syncPlaidItem(TEST_USER, itemRowId);
    expect(syncResult.error).toBeNull();

    const after = await readRow(row!.id);
    // The user's transfer classification is preserved AND it stays out of
    // the forecast register — it must not be dragged back to fake slack.
    expect(after.isTransfer).toBe(true);
    expect(after.isTransferUserOverridden).toBe(true);
    expect(after.forecastFlag).toBe(false);
  });

  it("still re-sets forecastFlag=true on a normal (non-transfer) checking row", async () => {
    // Guard against over-correcting: a plain checking charge that is NOT a
    // user transfer must still get forecastFlag=true on sync so it reaches
    // the forecast register.
    const { itemRowId, externalAccountId } = await seedCheckingItem();

    const plaidTxnId = `t-${randomUUID()}`;
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-11",
        description: "WHOLE FOODS MARKET",
        amount: "-42.10",
        isTransfer: false,
        isTransferUserOverridden: false,
        // Simulate a row that somehow lost its forecastFlag; the sync
        // should restore it for a normal checking charge.
        forecastFlag: false,
        source: "plaid:chase",
        plaidTransactionId: plaidTxnId,
        plaidAccountId: externalAccountId,
      })
      .returning();

    transactionsSyncMock.mockResolvedValueOnce({
      data: {
        added: [],
        modified: [
          {
            transaction_id: plaidTxnId,
            account_id: externalAccountId,
            amount: 42.1,
            date: "2026-05-11",
            name: "WHOLE FOODS MARKET",
            merchant_name: "Whole Foods",
            pending: false,
            personal_finance_category: {
              primary: "FOOD_AND_DRINK",
              detailed: "FOOD_AND_DRINK_GROCERIES",
            },
          },
        ],
        removed: [],
        next_cursor: "cur-2",
        has_more: false,
      },
    });

    const syncResult = await syncPlaidItem(TEST_USER, itemRowId);
    expect(syncResult.error).toBeNull();

    const after = await readRow(row!.id);
    expect(after.isTransfer).toBe(false);
    expect(after.forecastFlag).toBe(true);
  });
});
