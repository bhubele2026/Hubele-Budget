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
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `sync-err-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

type TxnsSyncFn = (args: {
  access_token: string;
  cursor?: string;
  count?: number;
}) => Promise<unknown>;
type AccountsBalanceGetFn = (args: {
  access_token: string;
  options?: { account_ids?: string[] };
}) => Promise<unknown>;

let transactionsSyncMock: TxnsSyncFn = async () => ({
  data: { added: [], modified: [], removed: [], next_cursor: "", has_more: false },
});
let accountsBalanceGetMock: AccountsBalanceGetFn = async () => ({
  data: { accounts: [] },
});

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: (args: Parameters<TxnsSyncFn>[0]) =>
        transactionsSyncMock(args),
      accountsBalanceGet: (args: Parameters<AccountsBalanceGetFn>[0]) =>
        accountsBalanceGetMock(args),
    }),
  };
});

import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import {
  extractPlaidError,
  syncPlaidItem,
} from "../lib/plaidSync";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(plaidRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(async () => {
  await cleanup();
  transactionsSyncMock = async () => ({
    data: {
      added: [],
      modified: [],
      removed: [],
      next_cursor: "",
      has_more: false,
    },
  });
  accountsBalanceGetMock = async () => ({ data: { accounts: [] } });
});

async function seedItem(opts?: {
  lastSyncError?: string | null;
}): Promise<{ itemRowId: string; itemId: string }> {
  const externalItemId = `item-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      itemId: externalItemId,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
      lastSyncError: opts?.lastSyncError ?? null,
    })
    .returning();
  return { itemRowId: item!.id, itemId: externalItemId };
}

describe("extractPlaidError helper", () => {
  it("pulls error_code + error_message out of an axios-shaped Plaid error", () => {
    const err = {
      message: "Request failed with status code 400",
      response: {
        status: 400,
        data: {
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message:
            "the login details of this item have changed (credentials, MFA, or required user action) and a user login is required to update this information.",
          error_type: "ITEM_ERROR",
        },
      },
    };
    const out = extractPlaidError(err);
    expect(out.code).toBe("ITEM_LOGIN_REQUIRED");
    expect(out.message).toMatch(/login details of this item have changed/);
    // It must NOT fall back to the bare axios message.
    expect(out.message).not.toBe("Request failed with status code 400");
  });

  it("falls back to e.message when no Plaid response body is present", () => {
    const out = extractPlaidError(new Error("network reset"));
    expect(out.code).toBeNull();
    expect(out.message).toBe("network reset");
  });

  it("returns String(e) for non-Error throws with no response body", () => {
    const out = extractPlaidError("plain string failure");
    expect(out.code).toBeNull();
    expect(out.message).toBe("plain string failure");
  });
});

describe("/plaid/sync error unwrapping", () => {
  it("stores the friendly Plaid error_message (not 'Request failed with status code 400') on lastSyncError when /transactions/sync returns an axios 400 with a Plaid body", async () => {
    const { itemRowId } = await seedItem();
    transactionsSyncMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            error_code: "ITEM_LOGIN_REQUIRED",
            error_message:
              "the login details of this item have changed and a user login is required",
            error_type: "ITEM_ERROR",
          },
        },
      };
    };

    const res = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ error: string | null; stillPreparing?: boolean }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].error).toMatch(/login details of this item have changed/);
    expect(body.items[0].error).not.toBe("Request failed with status code 400");
    expect(body.items[0].stillPreparing).toBeFalsy();

    const [row] = await db
      .select({ lastSyncError: plaidItemsTable.lastSyncError })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncError).toMatch(
      /login details of this item have changed/,
    );
    expect(row?.lastSyncError).not.toBe("Request failed with status code 400");
  });

  it("treats PRODUCT_NOT_READY as transient: per-item stillPreparing=true, error=null, and lastSyncError is NOT overwritten", async () => {
    // Seed the item with a previous (different, non-stale) error so we can
    // assert the PRODUCT_NOT_READY branch leaves the existing column alone
    // rather than clobbering it.
    const previousError = "Plaid sandbox seed error from a prior run";
    const { itemRowId } = await seedItem({ lastSyncError: previousError });

    transactionsSyncMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            error_code: "PRODUCT_NOT_READY",
            error_message:
              "the requested product is not yet ready. please provide a webhook or try the request again later.",
            error_type: "ITEM_ERROR",
          },
        },
      };
    };

    const result = await syncPlaidItem(TEST_USER, itemRowId);
    expect(result.error).toBeNull();
    expect(result.stillPreparing).toBe(true);
    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);

    const [row] = await db
      .select({ lastSyncError: plaidItemsTable.lastSyncError })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    // The previous lastSyncError must NOT be overwritten by a transient
    // PRODUCT_NOT_READY response — that's the whole point of the branch.
    expect(row?.lastSyncError).toBe(previousError);
  });

  it("clears lastSyncError back to null on a healthy sync (regression check)", async () => {
    const { itemRowId } = await seedItem({
      lastSyncError: "stale error from a previous run",
    });

    transactionsSyncMock = async () => ({
      data: {
        added: [],
        modified: [],
        removed: [],
        next_cursor: "next-cursor-value",
        has_more: false,
      },
    });

    const result = await syncPlaidItem(TEST_USER, itemRowId);
    expect(result.error).toBeNull();
    expect(result.stillPreparing).toBeFalsy();

    const [row] = await db
      .select({ lastSyncError: plaidItemsTable.lastSyncError })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncError).toBeNull();
  });
});
