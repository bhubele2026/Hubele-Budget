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

const TEST_USER = `relink-autodedupe-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
            institution_id: "ins_amex",
            consent_expiration_time: null,
          },
        },
      }),
      institutionsGetById: async () => ({
        data: { institution: { name: "American Express" } },
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
});

describe("(#461) /plaid/exchange auto-runs dedupePlaidAccountsForUser before returning", () => {
  it("collapses a pre-existing duplicate plaid_accounts row in the same request as the re-link", async () => {
    // Pre-seed: two stale `plaid_accounts` rows for the same physical
    // card (mask 1001), under two different prior items, simulating
    // the legacy state from before the (#410) cross-item upsert guard
    // landed. The exchange-side guard adopts one of the two rows; the
    // other lingers as a duplicate that the in-request dedupe sweep
    // (#461) must collapse before /plaid/exchange returns 200.
    const oldItemA = `amex-old-A-${randomUUID().slice(0, 8)}`;
    const [staleA] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: oldItemA,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    const oldItemB = `amex-old-B-${randomUUID().slice(0, 8)}`;
    const [staleB] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: oldItemB,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: staleA.id,
      accountId: `stale-A-1001-${randomUUID().slice(0, 8)}`,
      name: "Amex ··1001",
      mask: "1001",
      type: "credit",
      subtype: "credit card",
    });
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: staleB.id,
      accountId: `stale-B-1001-${randomUUID().slice(0, 8)}`,
      name: "Amex ··1001",
      mask: "1001",
      type: "credit",
      subtype: "credit card",
    });

    // Sanity: two duplicate ··1001 rows exist before the re-link.
    const before = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(before.filter((a) => a.mask === "1001")).toHaveLength(2);

    nextExchangeItemId = `amex-item-fresh-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    nextAccounts = [
      {
        account_id: `amex-1001-fresh-${randomUUID().slice(0, 8)}`,
        name: "Amex ··1001",
        type: "credit",
        subtype: "credit card",
        mask: "1001",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-relink" }),
    });
    expect(r.status).toBe(200);

    // Critical assertion for #461: by the time /plaid/exchange returns,
    // the in-request dedupe pass has already collapsed the stale
    // duplicate. No additional page hit / cron / explicit heal is
    // required to reach the single-row steady state.
    const after = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    const oneOhOne = after.filter((a) => a.mask === "1001");
    expect(oneOhOne).toHaveLength(1);
    // Total `plaid_accounts` rows for this user collapsed back to one
    // (the single physical card returned by accountsGet). Without the
    // in-request dedupe sweep we'd be sitting at two rows here and
    // the picker would still show the duplicate until the next page
    // hit / cron triggered a heal.
    expect(after).toHaveLength(1);
  });
});
