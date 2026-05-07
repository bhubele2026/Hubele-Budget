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

const TEST_USER = `relink-xitem-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

let nextExchangeAccessToken = "access-sandbox-fresh";
let nextExchangeItemId = "item-fresh";
let nextAccounts: Array<{
  account_id: string;
  name: string;
  type: string;
  subtype: string;
  mask: string;
}> = [];

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
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
      liabilitiesGet: async () => ({
        data: { liabilities: {}, accounts: [] },
      }),
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
});

describe("(#410) /plaid/exchange cross-item dedupe", () => {
  it("re-link under a brand-new Plaid item_id reuses the existing Chase row instead of inserting a sibling", async () => {
    // Pre-seed: a stale Chase item + account already on file from a
    // previous link, with the same institution + mask the user is
    // about to relink. The plaid_account.account_id text is the
    // *old* one Plaid minted last time — Plaid Link in real life
    // commonly mints a new id when the user re-grants consent.
    const oldItemExternal = `old-item-${randomUUID().slice(0, 8)}`;
    const [oldItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: oldItemExternal,
        // (#401) Use a Plaid-shaped sandbox access token so the
        // malformed-token sibling sweep doesn't pre-emptively delete
        // this row before #410's cross-item dedupe gets a chance to
        // run. We're testing the healthy re-link case here, where the
        // user's previous link was working but Plaid still minted a
        // brand-new item_id and account_id on this round-trip.
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const oldAccountIdText = `old-acct-${randomUUID().slice(0, 8)}`;
    const [existingAcct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: oldItem.id,
        accountId: oldAccountIdText,
        name: "Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Now simulate a re-link: the new exchange returns a *brand-new*
    // item_id and accountsGet returns the same physical account but
    // with a *brand-new* account_id text. Without the cross-item
    // guard, this would create a sibling plaid_accounts row and the
    // user would see Chase ··5526 twice in the picker.
    nextExchangeItemId = `new-item-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    const newAccountIdText = `new-acct-${randomUUID().slice(0, 8)}`;
    nextAccounts = [
      {
        account_id: newAccountIdText,
        name: "Chase Total Checking",
        type: "depository",
        subtype: "checking",
        mask: "5526",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-relink" }),
    });
    expect(r.status).toBe(200);

    // No duplicate Chase ··5526 row was created.
    const allChase = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    const fiveTwoSix = allChase.filter((a) => a.mask === "5526");
    expect(fiveTwoSix.length).toBe(1);
    // The existing row was reused (same uuid as the pre-seeded row).
    expect(fiveTwoSix[0].id).toBe(existingAcct.id);
    // Its accountId text was rotated to the new Plaid id, and its
    // itemId now points at the freshly-exchanged item.
    expect(fiveTwoSix[0].accountId).toBe(newAccountIdText);
    expect(fiveTwoSix[0].itemId).not.toBe(oldItem.id);
  });
});
