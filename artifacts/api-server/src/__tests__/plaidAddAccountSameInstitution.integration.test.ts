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
import { and, eq } from "drizzle-orm";

// (#795) Reproduces the Chase-checking + Chase-Prime-Visa incident.
// When a user adds a second card at a bank they already have linked, the
// OLD flow ran a fresh Plaid Link from scratch — which at OAuth banks
// like Chase mints a brand-new item and silently invalidates the prior
// item's session, leaving one broken item and zero history. The fix
// steers the user into Plaid's update-mode "add new account" flow
// against the EXISTING item: the exchanged public token belongs to the
// same external item_id, so the row is updated in place (token + item_id
// + sync cursor preserved) and the new account is appended. This test
// drives the server side of that flow and asserts the end state is ONE
// healthy item carrying BOTH accounts — not two items, not a broken one.

const TEST_USER = `addacct-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
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

// Controls what the mocked Plaid SDK returns. The exchange path keys its
// upsert on `item_id`, so returning the SAME external item_id the seeded
// healthy Chase item already holds is exactly what add-account mode does.
let nextExchangeAccessToken = "access-sandbox-chase-fresh";
let nextExchangeItemId = "item-chase-existing";
let nextAccounts: Array<{
  account_id: string;
  name: string;
  type: string;
  subtype: string;
  mask: string;
}> = [];
let lastAddAccountLinkTokenRequest: { access_token?: string; update?: unknown } | null =
  null;

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      linkTokenCreate: async (req: {
        access_token?: string;
        update?: unknown;
      }) => {
        lastAddAccountLinkTokenRequest = {
          access_token: req.access_token,
          update: req.update,
        };
        return {
          data: {
            link_token: `link-sandbox-${randomUUID()}`,
            expiration: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      },
      itemPublicTokenExchange: async () => ({
        data: {
          access_token: nextExchangeAccessToken,
          item_id: nextExchangeItemId,
        },
      }),
      itemGet: async () => ({
        data: {
          item: {
            item_id: nextExchangeItemId,
            institution_id: "ins_56",
            consent_expiration_time: null,
          },
        },
      }),
      institutionsGetById: async () => ({
        data: { institution: { name: "Chase" } },
      }),
      accountsGet: async () => ({ data: { accounts: nextAccounts } }),
      transactionsSync: async () => ({
        data: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "cursor-1",
          has_more: false,
        },
      }),
      transactionsGet: async () => ({
        data: { transactions: [], total_transactions: 0 },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      liabilitiesGet: async () => ({ data: { liabilities: {}, accounts: [] } }),
      itemRemove: async () => ({ data: { removed: true } }),
    }),
  };
});

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  next();
});
app.use(plaidRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
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
  nextAccounts = [];
  lastAddAccountLinkTokenRequest = null;
  nextExchangeAccessToken = "access-sandbox-chase-fresh";
  nextExchangeItemId = "item-chase-existing";
});

// Seed the "already healthy Chase item with a checking account" the user
// starts from. Returns the internal row id + external item_id.
async function seedHealthyChaseChecking(): Promise<{
  itemRowId: string;
  externalItemId: string;
}> {
  const externalItemId = `item-chase-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: externalItemId,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_56",
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: `acct-checking-${randomUUID()}`,
    name: "Chase Total Checking",
    type: "depository",
    subtype: "checking",
    mask: "1111",
  });
  return { itemRowId: item!.id, externalItemId };
}

describe("(#795) add a second card at an already-linked bank", () => {
  it("update-mode add-account keeps one healthy item with both accounts", async () => {
    const { itemRowId, externalItemId } = await seedHealthyChaseChecking();

    // Step 1: the picker requests an add-account link token for the
    // existing healthy item (proactive steer — no fresh OAuth grant).
    const ltRes = await fetch(`${baseUrl}/plaid/link-token/add-account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(ltRes.status).toBe(200);
    const ltBody = (await ltRes.json()) as { linkToken: string };
    expect(ltBody.linkToken).toMatch(/^link-sandbox-/);
    // It must be a true update-mode token: built from the existing
    // access_token with account_selection_enabled, NOT a fresh grant.
    expect(lastAddAccountLinkTokenRequest?.access_token).toBeTruthy();
    expect(lastAddAccountLinkTokenRequest?.update).toEqual({
      account_selection_enabled: true,
    });

    // Step 2: the user picks the new card in Plaid; the SDK's public
    // token exchanges back to the SAME external item_id, now with both
    // accounts visible to /accounts/get.
    nextExchangeItemId = externalItemId;
    nextAccounts = [
      {
        account_id: `acct-checking-${randomUUID()}`,
        name: "Chase Total Checking",
        type: "depository",
        subtype: "checking",
        mask: "1111",
      },
      {
        account_id: `acct-visa-${randomUUID()}`,
        name: "Chase Prime Visa",
        type: "credit",
        subtype: "credit card",
        mask: "2222",
      },
    ];

    const exRes = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-addaccount" }),
    });
    expect(exRes.status).toBe(200);
    const exBody = (await exRes.json()) as {
      relinked: boolean;
      itemId: string;
    };
    // Same external item_id → the upsert updated the row in place.
    expect(exBody.itemId).toBe(externalItemId);
    expect(exBody.relinked).toBe(true);

    // End state: exactly ONE Chase item for the household...
    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.householdId, TEST_HOUSEHOLD_ID),
          eq(plaidItemsTable.institutionId, "ins_56"),
        ),
      );
    expect(items).toHaveLength(1);
    // ...and it's healthy (no reconnect chip), with its token refreshed.
    expect(items[0]!.lastSyncErrorCode).toBeNull();
    expect(items[0]!.lastSyncError).toBeNull();
    expect(items[0]!.accessToken).toBe(nextExchangeAccessToken);

    // ...carrying BOTH the original checking and the new Prime Visa.
    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.itemId, items[0]!.id));
    const masks = accts.map((a) => a.mask).sort();
    expect(masks).toEqual(["1111", "2222"]);
    const names = accts.map((a) => a.name).sort();
    expect(names).toEqual(["Chase Prime Visa", "Chase Total Checking"]);
  });
});
