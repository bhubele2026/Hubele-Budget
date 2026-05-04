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

const TEST_USER = `liab-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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
      itemId: `item-liab-${randomUUID()}`,
      accessToken: "access-sandbox-test-token",
      institutionName: "Test Bank",
      institutionSlug: "test-bank",
    })
    .returning();
  const plaidAccountId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
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
