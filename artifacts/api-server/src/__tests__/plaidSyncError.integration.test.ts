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
type LinkTokenCreateFn = (args: {
  user: { client_user_id: string };
  client_name: string;
  access_token?: string;
  country_codes: unknown;
  language: string;
}) => Promise<unknown>;

let transactionsSyncMock: TxnsSyncFn = async () => ({
  data: { added: [], modified: [], removed: [], next_cursor: "", has_more: false },
});
let accountsBalanceGetMock: AccountsBalanceGetFn = async () => ({
  data: { accounts: [] },
});
let linkTokenCreateMock: LinkTokenCreateFn = async () => ({
  data: { link_token: "link-sandbox-default", expiration: "2030-01-01T00:00:00Z" },
});
let lastLinkTokenCreateArgs: Parameters<LinkTokenCreateFn>[0] | null = null;

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
      linkTokenCreate: (args: Parameters<LinkTokenCreateFn>[0]) => {
        lastLinkTokenCreateArgs = args;
        return linkTokenCreateMock(args);
      },
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
  linkTokenCreateMock = async () => ({
    data: { link_token: "link-sandbox-default", expiration: "2030-01-01T00:00:00Z" },
  });
  lastLinkTokenCreateArgs = null;
});

async function seedItem(opts?: {
  lastSyncError?: string | null;
  lastSyncErrorCode?: string | null;
  accessToken?: string;
}): Promise<{ itemRowId: string; itemId: string; accessToken: string }> {
  const externalItemId = `item-${randomUUID()}`;
  const accessToken = opts?.accessToken ?? `access-sandbox-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      itemId: externalItemId,
      accessToken,
      institutionName: "Chase",
      institutionSlug: "chase",
      lastSyncError: opts?.lastSyncError ?? null,
      lastSyncErrorCode: opts?.lastSyncErrorCode ?? null,
    })
    .returning();
  return { itemRowId: item!.id, itemId: externalItemId, accessToken };
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
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncError).toMatch(
      /login details of this item have changed/,
    );
    expect(row?.lastSyncError).not.toBe("Request failed with status code 400");
    // (#43 follow-up) Persist Plaid's structured error_code so the UI can
    // decide when to render the "Reconnect" button without string-matching
    // the human-readable message.
    expect(row?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");
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
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
        stillPreparingSince: plaidItemsTable.stillPreparingSince,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    // The previous lastSyncError must NOT be overwritten by a transient
    // PRODUCT_NOT_READY response — that's the whole point of the branch.
    expect(row?.lastSyncError).toBe(previousError);
    // Likewise, the (still-null) error code must remain untouched so the
    // Reconnect-button decision stays driven by the previous real failure.
    expect(row?.lastSyncErrorCode).toBeNull();
    // But we DO want to remember the still-preparing state so the Settings
    // page can render a per-item badge until the next successful sync.
    expect(row?.stillPreparingSince).toBeInstanceOf(Date);
  });

  it("clears lastSyncError + lastSyncErrorCode back to null on a healthy sync (regression check)", async () => {
    const { itemRowId } = await seedItem({
      lastSyncError: "stale error from a previous run",
      lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
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
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncError).toBeNull();
    // The Reconnect button hides the moment the next sync goes through, so
    // the code column MUST also be wiped — not just the message.
    expect(row?.lastSyncErrorCode).toBeNull();
  });
});

describe("/plaid/link-token/update (re-auth in update mode)", () => {
  it("400s when itemId is missing", async () => {
    const res = await fetch(`${baseUrl}/plaid/link-token/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s when the item doesn't belong to the caller (or doesn't exist)", async () => {
    const res = await fetch(`${baseUrl}/plaid/link-token/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Random UUID — there's no row for this user.
      body: JSON.stringify({ itemId: randomUUID() }),
    });
    expect(res.status).toBe(404);
  });

  it("creates a Plaid Link token in update mode using the item's stored access_token", async () => {
    const { itemRowId, accessToken } = await seedItem({
      lastSyncError: "the login details of this item have changed",
      lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
    });
    linkTokenCreateMock = async () => ({
      data: {
        link_token: "link-sandbox-update-mode-abc",
        expiration: "2030-01-01T00:00:00Z",
      },
    });

    const res = await fetch(`${baseUrl}/plaid/link-token/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkToken: string; expiration: string };
    expect(body.linkToken).toBe("link-sandbox-update-mode-abc");

    // The point of "update mode" is that we pass `access_token` to Plaid's
    // /link/token/create — that's what tells Plaid Link to skip institution
    // selection and re-auth this specific item. Without it, the user would
    // get the normal "pick your bank" flow and end up with a duplicate item.
    expect(lastLinkTokenCreateArgs).toBeTruthy();
    expect(lastLinkTokenCreateArgs?.access_token).toBe(accessToken);
    expect(lastLinkTokenCreateArgs?.user.client_user_id).toBe(TEST_USER);
    // `products` MUST be omitted in update mode — passing it makes Plaid
    // reject the request with INVALID_FIELD.
    expect(
      (lastLinkTokenCreateArgs as unknown as { products?: unknown }).products,
    ).toBeUndefined();
  });

  it("surfaces Plaid's structured error_code/error_message when /link/token/create fails", async () => {
    const { itemRowId } = await seedItem();
    linkTokenCreateMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            error_code: "INVALID_ACCESS_TOKEN",
            error_message: "the access_token is no longer valid",
            error_type: "INVALID_INPUT",
          },
        },
      };
    };

    const res = await fetch(`${baseUrl}/plaid/link-token/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toMatch(/the access_token is no longer valid/);
    expect(body.code).toBe("INVALID_ACCESS_TOKEN");
  });

  it("clears stillPreparingSince on a healthy sync so the Settings badge goes away", async () => {
    // Seed the item already flagged as still-preparing (i.e. a previous
    // sync hit PRODUCT_NOT_READY). The next successful sync MUST drop the
    // flag so the per-item badge disappears.
    const { itemRowId } = await seedItem();
    await db
      .update(plaidItemsTable)
      .set({ stillPreparingSince: new Date() })
      .where(eq(plaidItemsTable.id, itemRowId));

    transactionsSyncMock = async () => ({
      data: {
        added: [],
        modified: [],
        removed: [],
        next_cursor: "ok-cursor",
        has_more: false,
      },
    });

    const result = await syncPlaidItem(TEST_USER, itemRowId);
    expect(result.error).toBeNull();
    expect(result.stillPreparing).toBeFalsy();

    const [row] = await db
      .select({ stillPreparingSince: plaidItemsTable.stillPreparingSince })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.stillPreparingSince).toBeNull();
  });

  it("GET /plaid/items exposes a per-item stillPreparing flag", async () => {
    // Two items: one healthy, one currently flagged still-preparing. The
    // Settings page reads this list to render the per-item status row.
    const { itemRowId: healthyId } = await seedItem();
    const { itemRowId: preparingId } = await seedItem();
    await db
      .update(plaidItemsTable)
      .set({ stillPreparingSince: new Date() })
      .where(eq(plaidItemsTable.id, preparingId));

    const res = await fetch(`${baseUrl}/plaid/items`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      stillPreparing: boolean;
    }>;
    const byId = new Map(body.map((b) => [b.id, b]));
    expect(byId.get(healthyId)?.stillPreparing).toBe(false);
    expect(byId.get(preparingId)?.stillPreparing).toBe(true);
  });
});
