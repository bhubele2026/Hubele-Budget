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
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `sync-err-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
type ItemGetFn = (args: { access_token: string }) => Promise<unknown>;

let transactionsSyncMock: TxnsSyncFn = async () => ({
  data: { added: [], modified: [], removed: [], next_cursor: "", has_more: false },
});
let accountsBalanceGetMock: AccountsBalanceGetFn = async () => ({
  data: { accounts: [] },
});
let linkTokenCreateMock: LinkTokenCreateFn = async () => ({
  data: { link_token: "link-sandbox-default", expiration: "2030-01-01T00:00:00Z" },
});
// (#238) Mocked /item/get — defaults to no consent_expiration_time so the
// existing ITEM_LOGIN_REQUIRED / PRODUCT_NOT_READY tests behave exactly as
// they did before the dated-cutoff sync refresh path was added.
let itemGetMock: ItemGetFn = async () => ({
  data: { item: { item_id: "item-default", consent_expiration_time: null } },
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
      itemGet: (args: Parameters<ItemGetFn>[0]) => itemGetMock(args),
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
  derivePlaidErrorKind,
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
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
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
  itemGetMock = async () => ({
    data: { item: { item_id: "item-default", consent_expiration_time: null } },
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
      householdId: TEST_HOUSEHOLD_ID,
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

  it("(#357) returns a generic reachability message — never the raw axios/network string — when there is no Plaid response body", () => {
    const out = extractPlaidError(new Error("network reset"));
    expect(out.code).toBeNull();
    // MUST NOT echo "network reset" back to the user — the chip / toast
    // would otherwise leak infra detail. The raw error stays in
    // structured logs via plaidLogContext().
    expect(out.message).not.toMatch(/network reset/i);
    expect(out.message).toMatch(/couldn't reach plaid/i);
  });

  it("(#357) returns the same generic reachability message for non-Error throws with no response body", () => {
    const out = extractPlaidError("plain string failure");
    expect(out.code).toBeNull();
    expect(out.message).not.toMatch(/plain string failure/i);
    expect(out.message).toMatch(/couldn't reach plaid/i);
  });

  it("synthesizes a friendly fallback when Plaid returned an HTTP error with no error_message body (the bug behind the '400' chip)", () => {
    // Plaid axios error with status 400 but data was empty / had no
    // error_message. The bare e.message is the unhelpful axios string;
    // extractPlaidError MUST replace it with a friendly synthesized
    // message so this never lands in plaid_items.last_sync_error.
    const err = {
      message: "Request failed with status code 400",
      response: { status: 400, data: {} },
    };
    const out = extractPlaidError(err);
    expect(out.code).toBeNull();
    expect(out.message).not.toBe("Request failed with status code 400");
    expect(out.message).toMatch(/Plaid returned 400/);
  });

  it("(#357) prefers display_message even when error_code is absent on a Plaid 400", () => {
    // Plaid sometimes returns an HTTP 400 whose body has only a
    // display_message (no error_code) — we still need to surface that
    // friendly string instead of the raw axios "status code 400".
    const err = {
      message: "Request failed with status code 400",
      response: {
        status: 400,
        data: {
          display_message:
            "Your bank is temporarily unavailable. Please try again shortly.",
          request_id: "req-display-only",
        },
      },
    };
    const out = extractPlaidError(err);
    expect(out.code).toBeNull();
    expect(out.displayMessage).toMatch(/temporarily unavailable/);
    expect(out.requestId).toBe("req-display-only");
    expect(out.httpStatus).toBe(400);
    expect(out.message).not.toMatch(/Request failed with status code 400/);
  });

  it("(#357) on a non-Plaid axios error (response present but no Plaid-shaped fields) still synthesizes a friendly message — never the bare axios string", () => {
    // An upstream Plaid call could fail through a misconfigured proxy
    // or some non-Plaid intermediary that returns its own error body.
    // The extractor must not echo the bare axios message back to the
    // user-visible chip.
    const err = {
      message: "Request failed with status code 502",
      response: {
        status: 502,
        data: { detail: "upstream proxy went away", proxy: "edge-7" },
      },
    };
    const out = extractPlaidError(err);
    expect(out.code).toBeNull();
    expect(out.httpStatus).toBe(502);
    expect(out.message).not.toMatch(/Request failed with status code/);
    expect(out.message).toMatch(/Plaid returned 502/);
    // Non-Plaid response body must not pollute display_message either —
    // we only ever surface Plaid's own display_message.
    expect(out.displayMessage).toBeNull();
  });

  it("(#357) extracts plaid display_message and request_id and tags kind=reauth for ITEM_LOGIN_REQUIRED", () => {
    const err = {
      message: "Request failed with status code 400",
      response: {
        status: 400,
        data: {
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message: "the login details of this item have changed",
          error_type: "ITEM_ERROR",
          display_message:
            "Please reconnect your account to continue syncing.",
          request_id: "req-abc-123",
        },
      },
    };
    const out = extractPlaidError(err);
    expect(out.code).toBe("ITEM_LOGIN_REQUIRED");
    expect(out.displayMessage).toMatch(/reconnect your account/);
    expect(out.requestId).toBe("req-abc-123");
    expect(out.httpStatus).toBe(400);
    expect(out.kind).toBe("reauth");
  });

  it("(#357) derivePlaidErrorKind buckets codes/status into the categorical CTA hint", () => {
    expect(derivePlaidErrorKind("ITEM_LOGIN_REQUIRED", 400)).toBe("reauth");
    expect(derivePlaidErrorKind("PENDING_EXPIRATION", 400)).toBe("reauth");
    expect(derivePlaidErrorKind("RATE_LIMIT_EXCEEDED", 429)).toBe("rate_limit");
    expect(derivePlaidErrorKind("INSTITUTION_DOWN", 400)).toBe(
      "institution_down",
    );
    expect(derivePlaidErrorKind("PRODUCT_NOT_READY", 400)).toBe("transient");
    expect(derivePlaidErrorKind(null, 500)).toBe("transient");
    expect(derivePlaidErrorKind("SOMETHING_NEW", 400)).toBe("unknown");
    expect(derivePlaidErrorKind(null, null)).toBe("unknown");
  });

  it("synthesizes a friendly fallback when Plaid returned an error_code but no error_message", () => {
    // Some Plaid endpoints occasionally omit error_message even when
    // error_code is present. The friendly fallback must include the
    // code so support can still triage from the chip text.
    const err = {
      message: "Request failed with status code 400",
      response: {
        status: 400,
        data: { error_code: "INVALID_REQUEST", error_type: "INVALID_REQUEST" },
      },
    };
    const out = extractPlaidError(err);
    expect(out.code).toBe("INVALID_REQUEST");
    expect(out.message).toMatch(/Plaid returned 400/);
    expect(out.message).toContain("INVALID_REQUEST");
    expect(out.message).not.toBe("Request failed with status code 400");
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

  it("(#238) refreshes consentExpirationAt on PENDING_EXPIRATION so the dated banner copy stays current", async () => {
    // Seed an item with a stale (or missing) consent cutoff so we can
    // assert the catch branch actually called itemGet and persisted the
    // value Plaid returns alongside the PENDING_EXPIRATION code.
    const { itemRowId } = await seedItem();
    const cutoff = "2026-05-21T15:30:00.000Z";
    itemGetMock = async () => ({
      data: {
        item: {
          item_id: "item-from-mock",
          consent_expiration_time: cutoff,
        },
      },
    });
    transactionsSyncMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            error_code: "PENDING_EXPIRATION",
            error_message:
              "the access_token is approaching its expiration time and should be updated",
            error_type: "ITEM_ERROR",
          },
        },
      };
    };

    const result = await syncPlaidItem(TEST_USER, itemRowId);
    expect(result.error).toMatch(/expiration/i);

    const [row] = await db
      .select({
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
        consentExpirationAt: plaidItemsTable.consentExpirationAt,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("PENDING_EXPIRATION");
    // The whole point of #238: when sync hits PENDING_EXPIRATION we MUST
    // refresh the consent cutoff so the banner copy ("Chase will
    // disconnect on May 21") reflects what Plaid currently reports.
    expect(row?.consentExpirationAt).toBeInstanceOf(Date);
    expect(row?.consentExpirationAt?.toISOString()).toBe(cutoff);
  });

  it("(#238) leaves consentExpirationAt untouched on PENDING_EXPIRATION when /item/get itself fails (best-effort)", async () => {
    // If the /item/get refresh throws (e.g. transient Plaid outage), we
    // must still persist the lastSyncErrorCode so the page-top reconnect
    // banner appears — just without bumping the consent date. The
    // previously stored value (or null) must remain.
    const { itemRowId } = await seedItem();
    itemGetMock = async () => {
      throw new Error("simulated /item/get failure");
    };
    transactionsSyncMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            error_code: "PENDING_EXPIRATION",
            error_message: "the access_token is approaching its expiration time",
            error_type: "ITEM_ERROR",
          },
        },
      };
    };

    const result = await syncPlaidItem(TEST_USER, itemRowId);
    // The original sync error must still surface — itemGet is best-effort.
    expect(result.error).toMatch(/expiration/i);

    const [row] = await db
      .select({
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
        consentExpirationAt: plaidItemsTable.consentExpirationAt,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("PENDING_EXPIRATION");
    // Best-effort means: leave the previously stored value alone.
    // The seedItem helper doesn't set one, so it stays null.
    expect(row?.consentExpirationAt).toBeNull();
  });

  it("(#238) GET /plaid/items exposes consentExpirationAt so the banner can render the dated copy", async () => {
    const { itemRowId } = await seedItem();
    const cutoff = new Date("2026-05-21T15:30:00.000Z");
    await db
      .update(plaidItemsTable)
      .set({ consentExpirationAt: cutoff })
      .where(eq(plaidItemsTable.id, itemRowId));

    const res = await fetch(`${baseUrl}/plaid/items`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      consentExpirationAt: string | null;
    }>;
    const found = body.find((b) => b.id === itemRowId);
    expect(found).toBeTruthy();
    expect(found?.consentExpirationAt).toBe(cutoff.toISOString());
  });

  it("never writes the literal 'Request failed with status code 400' to lastSyncError when Plaid returns an axios 400 with an empty body (chip-leak regression)", async () => {
    // The bug: a follow-up Plaid call returned 400 with no
    // error_code/error_message, the bare axios message landed in
    // lastSyncError, and the Transactions page chip showed the
    // unhelpful "Request failed with status code 400" string. The fix
    // is in extractPlaidError — make sure it actually flows through to
    // the persisted column (and the route response).
    const { itemRowId } = await seedItem();
    transactionsSyncMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: { status: 400, data: {} },
      };
    };

    const res = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ error: string | null }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].error).not.toBe("Request failed with status code 400");
    expect(body.items[0].error).toMatch(/Plaid returned 400/);

    const [row] = await db
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    // Persisted chip text MUST be the friendly synthesized fallback,
    // never the bare axios string.
    expect(row?.lastSyncError).not.toBe("Request failed with status code 400");
    expect(row?.lastSyncError).toMatch(/Plaid returned 400/);
    // No structured code was returned, so the column stays null —
    // exactly so the Reconnect button (gated on PLAID_REAUTH_ERROR_CODES)
    // does not light up for a non-actionable transient 400.
    expect(row?.lastSyncErrorCode).toBeNull();
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

  it("(#654) translates Plaid INVALID_ACCESS_TOKEN from /link/token/create into a 409 relink response so the Reconnect button's fresh-link fallback recovers", async () => {
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
    // Pre-#654 this returned 500 with the raw Plaid error, leaving the
    // user stuck on a generic toast. Now we translate to the same
    // {409, action:"relink"} shape the malformed-token branch uses,
    // which the Reconnect button knows how to handle by falling back
    // to a fresh-link flow.
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      code?: string;
      action?: string;
    };
    expect(body.code).toBe("INVALID_ACCESS_TOKEN");
    expect(body.action).toBe("relink");
    // The persisted columns must also be updated so the Settings chip
    // and Reconnect gating reflect the new state on the next render.
    const [row] = await db
      .select({
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
        lastSyncError: plaidItemsTable.lastSyncError,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("INVALID_ACCESS_TOKEN");
    expect(row?.lastSyncError).toMatch(/different Plaid environment/i);
  });

  it("(#654) pre-flight env-mismatch guard short-circuits before calling Plaid and returns {409, action:relink}", async () => {
    const { itemRowId } = await seedItem();
    // Force the env mismatch the user actually has in production
    // (sandbox-prefixed token from seedItem default + production
    // server). Restore inside the same test to keep the rest of the
    // suite on the singleFork shared sandbox env.
    const PRIOR = process.env.PLAID_ENV;
    process.env.PLAID_ENV = "production";
    let linkTokenCreateWasCalled = false;
    const previousLinkTokenCreateMock = linkTokenCreateMock;
    linkTokenCreateMock = async () => {
      linkTokenCreateWasCalled = true;
      throw new Error(
        "guard regressed: linkTokenCreate was called for an env-mismatched item",
      );
    };

    try {
      const res = await fetch(`${baseUrl}/plaid/link-token/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: itemRowId }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: string;
        code?: string;
        action?: string;
      };
      expect(body.code).toBe("INVALID_ACCESS_TOKEN");
      expect(body.action).toBe("relink");
      expect(body.error).toMatch(/different Plaid environment/i);
      expect(linkTokenCreateWasCalled).toBe(false);

      const [row] = await db
        .select({
          lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
          lastSyncError: plaidItemsTable.lastSyncError,
        })
        .from(plaidItemsTable)
        .where(eq(plaidItemsTable.id, itemRowId));
      expect(row?.lastSyncErrorCode).toBe("INVALID_ACCESS_TOKEN");
      expect(row?.lastSyncError).toMatch(/different Plaid environment/i);
    } finally {
      if (PRIOR === undefined) delete process.env.PLAID_ENV;
      else process.env.PLAID_ENV = PRIOR;
      linkTokenCreateMock = previousLinkTokenCreateMock;
    }
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

  it("GET /plaid/items exposes stillPreparingSince so the UI can show elapsed time", async () => {
    // The Settings page renders "Preparing for 12m / 3h" using this
    // timestamp so the user can tell a freshly linked bank from one that
    // has been stuck for hours. Healthy items must not leak a timestamp.
    const { itemRowId: healthyId } = await seedItem();
    const { itemRowId: preparingId } = await seedItem();
    const since = new Date(Date.now() - 90 * 60 * 1000); // 90 minutes ago
    await db
      .update(plaidItemsTable)
      .set({ stillPreparingSince: since })
      .where(eq(plaidItemsTable.id, preparingId));

    const res = await fetch(`${baseUrl}/plaid/items`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      stillPreparing: boolean;
      stillPreparingSince: string | null;
    }>;
    const byId = new Map(body.map((b) => [b.id, b]));
    expect(byId.get(healthyId)?.stillPreparingSince ?? null).toBeNull();
    const exposed = byId.get(preparingId)?.stillPreparingSince;
    expect(typeof exposed).toBe("string");
    expect(new Date(exposed!).toISOString()).toBe(since.toISOString());
  });
});
