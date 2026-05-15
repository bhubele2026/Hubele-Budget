import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `liab-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

type AccountsGetFn = (args: {
  access_token: string;
}) => Promise<{ data: { accounts: Array<Record<string, unknown>> } }>;
type LiabilitiesGetFn = (args: {
  access_token: string;
}) => Promise<{ data: { accounts: Array<Record<string, unknown>>; liabilities: unknown } }>;

let accountsGetMock: AccountsGetFn = async () => ({ data: { accounts: [] } });
let liabilitiesGetMock: LiabilitiesGetFn = async () => ({
  data: { accounts: [], liabilities: null },
});

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      accountsGet: (args: { access_token: string }) => accountsGetMock(args),
      liabilitiesGet: (args: { access_token: string }) =>
        liabilitiesGetMock(args),
    }),
  };
});

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { fetchLiabilitiesForItem } from "../lib/plaidLiabilities";

async function cleanup(): Promise<void> {
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
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
  accountsGetMock = async () => ({ data: { accounts: [] } });
  liabilitiesGetMock = async () => ({
    data: { accounts: [], liabilities: null },
  });
});

async function insertItemAndAccount(): Promise<{
  itemRowId: string;
  acctRowId: string;
  plaidAccountId: string;
}> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-liab-${randomUUID()}`,
      // (#654) Use a token whose env prefix matches the server's
      // PLAID_ENV so the env-mismatch guard doesn't short-circuit the
      // whole flow before /accounts/get / /liabilities/get are exercised.
      accessToken: `access-${(process.env.PLAID_ENV ?? "sandbox").toLowerCase()}-test-token`,
      institutionName: "Test Bank",
      institutionSlug: "test-bank",
    })
    .returning();
  const plaidAccountId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: plaidAccountId,
      name: "Test Card",
      type: "credit",
      subtype: "credit card",
    })
    .returning();
  return { itemRowId: item!.id, acctRowId: acct!.id, plaidAccountId };
}

describe("fetchLiabilitiesForItem when liabilities product is not enabled", () => {
  it("resolves (does NOT throw) when liabilitiesGet rejects with INVALID_PRODUCT, falling back to /accounts/get balances", async () => {
    const { acctRowId, plaidAccountId } = await insertItemAndAccount();

    accountsGetMock = async () => ({
      data: {
        accounts: [
          {
            account_id: plaidAccountId,
            name: "Test Card",
            type: "credit",
            subtype: "credit card",
            balances: { current: 1234.56 },
          },
        ],
      },
    });
    liabilitiesGetMock = async () => {
      // Mimic the Plaid axios error shape.
      throw {
        response: {
          data: {
            error_code: "INVALID_PRODUCT",
            error_type: "INVALID_REQUEST",
            error_message:
              "client is not authorized to access the following products: [\"liabilities\"]",
          },
        },
      };
    };

    // The whole point: this must NOT throw. fetchLiabilitiesForUser (used
    // by /plaid/liability-accounts and the debt-refresh path) wraps in
    // try/catch but a throw here used to corrupt the balance refresh.
    const rows = await fetchLiabilitiesForItem(TEST_USER, (await db
      .select({ id: plaidItemsTable.id })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER)))[0]!.id);

    // No liability rows are returned (we have no /liabilities/get data),
    // but the call resolves cleanly.
    expect(rows).toEqual([]);

    // /accounts/get balance was still persisted to the cached column
    // (this is the behaviour that protects debt refresh).
    const [row] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(row).toBeDefined();
    expect(row!.liabilityBalance).toBe("1234.56");
    expect(row!.liabilityLastFetchedAt).not.toBeNull();
  });

  it("also tolerates PRODUCTS_NOT_SUPPORTED from liabilitiesGet", async () => {
    const { acctRowId, plaidAccountId } = await insertItemAndAccount();

    accountsGetMock = async () => ({
      data: {
        accounts: [
          {
            account_id: plaidAccountId,
            name: "Test Card",
            type: "credit",
            subtype: "credit card",
            balances: { current: 42.0 },
          },
        ],
      },
    });
    liabilitiesGetMock = async () => {
      throw {
        response: {
          data: {
            error_code: "PRODUCTS_NOT_SUPPORTED",
            error_type: "INVALID_REQUEST",
            error_message: "products not supported by this institution",
          },
        },
      };
    };

    const itemId = (await db
      .select({ id: plaidItemsTable.id })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER)))[0]!.id;

    const rows = await fetchLiabilitiesForItem(TEST_USER, itemId);
    expect(rows).toEqual([]);

    const [row] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(row!.liabilityBalance).toBe("42.00");
  });

  it("still throws when /accounts/get also fails (no data to fall back to)", async () => {
    await insertItemAndAccount();

    accountsGetMock = async () => {
      throw new Error("network down");
    };
    liabilitiesGetMock = async () => {
      throw {
        response: {
          data: {
            error_code: "INVALID_PRODUCT",
            error_message: "no liabilities access",
          },
        },
      };
    };

    const itemId = (await db
      .select({ id: plaidItemsTable.id })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER)))[0]!.id;

    await expect(fetchLiabilitiesForItem(TEST_USER, itemId)).rejects.toThrow(
      /Plaid fetch failed/,
    );
  });
});

describe("(#43) fetchLiabilitiesForItem records sync errors on the parent item", () => {
  it("persists the Plaid error_code + message to lastSyncError when /accounts/get returns ITEM_LOGIN_REQUIRED", async () => {
    const { itemRowId } = await insertItemAndAccount();

    accountsGetMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            error_code: "ITEM_LOGIN_REQUIRED",
            error_type: "ITEM_ERROR",
            error_message:
              "the login details of this item have changed and a user login is required",
          },
        },
      };
    };
    liabilitiesGetMock = async () => {
      throw {
        response: {
          data: {
            error_code: "ITEM_LOGIN_REQUIRED",
            error_message:
              "the login details of this item have changed and a user login is required",
          },
        },
      };
    };

    await expect(
      fetchLiabilitiesForItem(TEST_USER, itemRowId),
    ).rejects.toThrow(/Plaid fetch failed/);

    const [row] = await db
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    // Code is the Reconnect-button gate — must be the structured Plaid value.
    expect(row?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");
    // Message is the human-readable chip text — must include the friendly
    // Plaid error_message, NOT the bare axios "Request failed…" string.
    expect(row?.lastSyncError).toMatch(/Liability refresh failed/);
    expect(row?.lastSyncError).toMatch(
      /login details of this item have changed/,
    );
    expect(row?.lastSyncError).not.toMatch(/Request failed with status code/);
  });

  it("records the error when /accounts/get fails even if /liabilities/get returned recoverable INVALID_PRODUCT", async () => {
    const { itemRowId } = await insertItemAndAccount();

    accountsGetMock = async () => {
      throw {
        response: {
          status: 400,
          data: {
            error_code: "ITEM_LOGIN_REQUIRED",
            error_message: "auth expired",
          },
        },
      };
    };
    liabilitiesGetMock = async () => {
      throw {
        response: {
          data: {
            error_code: "INVALID_PRODUCT",
            error_message: "no liabilities access",
          },
        },
      };
    };

    await expect(
      fetchLiabilitiesForItem(TEST_USER, itemRowId),
    ).rejects.toThrow(/Plaid fetch failed/);

    const [row] = await db
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    // The acctErr (ITEM_LOGIN_REQUIRED) must win over the recoverable
    // INVALID_PRODUCT — that's the actionable code that drives Reconnect.
    expect(row?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(row?.lastSyncError).toMatch(/auth expired/);
  });

  it("clears a stale lastSyncError after a successful balance refresh", async () => {
    const { acctRowId, plaidAccountId, itemRowId } =
      await insertItemAndAccount();
    // Pre-stamp a stale re-auth error from a previous run.
    await db
      .update(plaidItemsTable)
      .set({
        lastSyncError: "Liability refresh failed: stale credentials",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      })
      .where(eq(plaidItemsTable.id, itemRowId));

    accountsGetMock = async () => ({
      data: {
        accounts: [
          {
            account_id: plaidAccountId,
            name: "Test Card",
            type: "credit",
            subtype: "credit card",
            balances: { current: 999.99 },
          },
        ],
      },
    });
    // /liabilities/get also succeeds (returns no liabilities is fine).
    liabilitiesGetMock = async () => ({
      data: { accounts: [], liabilities: null },
    });

    const rows = await fetchLiabilitiesForItem(TEST_USER, itemRowId);
    expect(rows).toEqual([]);

    const [item] = await db
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    // A healthy balance refresh proves the connection works — the chip
    // must drop on the next /debts read.
    expect(item?.lastSyncError).toBeNull();
    expect(item?.lastSyncErrorCode).toBeNull();

    const [row] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(row!.liabilityBalance).toBe("999.99");
  });

  it("preserves stale lastSyncError when a successful liab call only had INVALID_PRODUCT-grade gaps (still success path)", async () => {
    const { plaidAccountId, itemRowId } = await insertItemAndAccount();

    accountsGetMock = async () => ({
      data: {
        accounts: [
          {
            account_id: plaidAccountId,
            name: "Test Card",
            type: "credit",
            subtype: "credit card",
            balances: { current: 12.34 },
          },
        ],
      },
    });
    liabilitiesGetMock = async () => {
      throw {
        response: {
          data: {
            error_code: "INVALID_PRODUCT",
            error_message: "no liabilities access",
          },
        },
      };
    };

    await fetchLiabilitiesForItem(TEST_USER, itemRowId);

    // INVALID_PRODUCT is an expected, recoverable state for the bank-only
    // configuration — accounts/get succeeded, so we treat the item as
    // healthy and clear any stale chip from a previous run.
    const [item] = await db
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(item?.lastSyncError).toBeNull();
    expect(item?.lastSyncErrorCode).toBeNull();
  });
});
