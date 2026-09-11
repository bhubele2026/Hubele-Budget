// ⭐ THE `balance` ATTEMPT ROW SAYS WHAT THE BALANCE CALL DID. `bankFreshness`
// reads these rows to decide whether the bank balance is stale. The row used to
// have its own condition, separate from the call's:
//   - a webhook sync, which never calls /accounts/balance/get, logged
//     "balance: success" over a real failure;
//   - a manual Sync whose stored pointer was gone, but whose account still
//     resolved by mask, called Plaid and logged nothing.
// Now the row is written exactly when the call ran, and it is a success only
// when a balance was actually re-read.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `sync-balance-attempt-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

let accountsBalanceGetMock: () => Promise<unknown> = async () => ({
  data: { accounts: [] },
});
let balanceCalls = 0;

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  const empty = async () => ({ data: {} });
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: { added: [], modified: [], removed: [], next_cursor: "", has_more: false },
      }),
      accountsBalanceGet: () => {
        balanceCalls += 1;
        return accountsBalanceGetMock();
      },
      itemGet: async () => ({
        data: { item: { item_id: "item-default", consent_expiration_time: null } },
      }),
      // Anything else a Sync might touch answers empty, so an unexpected call
      // cannot fail these tests for the wrong reason.
      accountsGet: async () => ({ data: { accounts: [] } }),
      transactionsGet: async () => ({
        data: { transactions: [], total_transactions: 0, accounts: [] },
      }),
      transactionsRefresh: empty,
      liabilitiesGet: async () => ({ data: { accounts: [], liabilities: {} } }),
    }),
  };
});

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidSyncAttemptsTable)
    .where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
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
  balanceCalls = 0;
  accountsBalanceGetMock = async () => ({ data: { accounts: [] } });
});

async function seedItemWithChecking(mask: string): Promise<{
  itemRowId: string;
  accountRowId: string;
  externalId: string;
}> {
  const externalId = `acct-${randomUUID()}`;
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
      accountId: externalId,
      name: "TOTAL CHECKING",
      mask,
      type: "depository",
      subtype: "checking",
    })
    .returning();
  return { itemRowId: item!.id, accountRowId: acct!.id, externalId };
}

async function seedSnapshot(opts: { pointer: string | null; mask: string | null }) {
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: new Date("2026-09-01T17:00:00Z"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: opts.pointer,
    bankSnapshotMask: opts.mask,
  });
}

async function rowsOfKind(itemRowId: string, kind: string) {
  return db
    .select({
      success: plaidSyncAttemptsTable.success,
      errorCode: plaidSyncAttemptsTable.errorCode,
    })
    .from(plaidSyncAttemptsTable)
    .where(
      and(
        eq(plaidSyncAttemptsTable.plaidItemId, itemRowId),
        eq(plaidSyncAttemptsTable.kind, kind),
      ),
    );
}

function plaidError(status: number, code: string, message: string) {
  return {
    message: `Request failed with status code ${status}`,
    response: {
      status,
      data: { error_code: code, error_message: message, error_type: "API_ERROR" },
    },
  };
}

describe("the `balance` attempt row follows the balance call", () => {
  it("a webhook sync makes no balance call and writes no balance row, even with a stored pointer", async () => {
    const { itemRowId, accountRowId } = await seedItemWithChecking("5526");
    await seedSnapshot({ pointer: accountRowId, mask: "5526" });

    await syncPlaidItem(TEST_USER, itemRowId); // syncOrigin defaults to "webhook"

    expect(balanceCalls).toBe(0);
    expect(await rowsOfKind(itemRowId, "transactions")).toEqual([
      { success: true, errorCode: null },
    ]);
    expect(await rowsOfKind(itemRowId, "balance")).toEqual([]);
  });

  it("a manual Sync with the pointer gone but the account found by its mask re-reads the balance and records it", async () => {
    const { itemRowId, externalId } = await seedItemWithChecking("5526");
    await seedSnapshot({ pointer: null, mask: "5526" });
    // The same figure as the snapshot, with no ledger rows, so nothing drifts.
    accountsBalanceGetMock = async () => ({
      data: {
        accounts: [
          { account_id: externalId, balances: { available: 1000, current: 1000 } },
        ],
      },
    });

    await syncPlaidItem(TEST_USER, itemRowId, { syncOrigin: "manual" });

    expect(balanceCalls).toBe(1);
    expect(await rowsOfKind(itemRowId, "balance")).toEqual([
      { success: true, errorCode: null },
    ]);
  });

  it("a manual Sync whose balance call returns no balance records no_balance, not a success", async () => {
    const { itemRowId, accountRowId } = await seedItemWithChecking("5526");
    await seedSnapshot({ pointer: accountRowId, mask: "5526" });

    await syncPlaidItem(TEST_USER, itemRowId, { syncOrigin: "manual" });

    expect(balanceCalls).toBe(1);
    expect(await rowsOfKind(itemRowId, "balance")).toEqual([
      { success: false, errorCode: "no_balance" },
    ]);
  });

  it("PRODUCT_NOT_READY on the balance call records that code, not a success, and no error chip", async () => {
    const { itemRowId, accountRowId } = await seedItemWithChecking("5526");
    await seedSnapshot({ pointer: accountRowId, mask: "5526" });
    accountsBalanceGetMock = async () => {
      throw plaidError(400, "PRODUCT_NOT_READY", "the requested product is not yet ready");
    };

    await syncPlaidItem(TEST_USER, itemRowId, { syncOrigin: "manual" });

    expect(await rowsOfKind(itemRowId, "balance")).toEqual([
      { success: false, errorCode: "PRODUCT_NOT_READY" },
    ]);
    const [item] = await db
      .select({ lastSyncError: plaidItemsTable.lastSyncError })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(item!.lastSyncError).toBeNull();
  });

  it("a manual Sync whose balance re-read fails records the failure with Plaid's code", async () => {
    const { itemRowId, accountRowId } = await seedItemWithChecking("5526");
    await seedSnapshot({ pointer: accountRowId, mask: "5526" });
    accountsBalanceGetMock = async () => {
      throw plaidError(500, "INTERNAL_SERVER_ERROR", "an unexpected error occurred");
    };

    await syncPlaidItem(TEST_USER, itemRowId, { syncOrigin: "manual" });

    expect(balanceCalls).toBe(1);
    expect(await rowsOfKind(itemRowId, "balance")).toEqual([
      { success: false, errorCode: "INTERNAL_SERVER_ERROR" },
    ]);
  });

  it("a manual Sync of an item that does not own the snapshot account makes no balance call and writes no row", async () => {
    const snapshotItem = await seedItemWithChecking("5526");
    const otherItem = await seedItemWithChecking("7777");
    await seedSnapshot({ pointer: snapshotItem.accountRowId, mask: "5526" });

    await syncPlaidItem(TEST_USER, otherItem.itemRowId, { syncOrigin: "manual" });

    expect(balanceCalls).toBe(0);
    expect(await rowsOfKind(otherItem.itemRowId, "balance")).toEqual([]);
  });
});
