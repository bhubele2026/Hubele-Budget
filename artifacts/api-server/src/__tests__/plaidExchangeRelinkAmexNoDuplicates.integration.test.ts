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

const TEST_USER = `relink-amex-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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

describe("(#416) /plaid/exchange Amex three-card re-link no-duplicates", () => {
  it("re-linking the same Amex login three times in a row never inserts a second plaid_accounts row per physical card", async () => {
    // Three physical Amex cards under one Plaid login. Each round-trip
    // simulates Plaid minting a brand-new item_id and brand-new
    // account_id texts (the worst case for the (institution, mask)
    // upsert guard from #410). After three back-to-back exchanges,
    // there must be exactly three plaid_accounts rows — one per card.
    const cardMasks = ["1001", "2002", "3003"] as const;

    for (let pass = 1; pass <= 3; pass++) {
      nextExchangeItemId = `amex-item-pass${pass}-${randomUUID().slice(0, 8)}`;
      nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
      nextAccounts = cardMasks.map((mask) => ({
        account_id: `amex-${mask}-pass${pass}-${randomUUID().slice(0, 8)}`,
        name: `Amex ··${mask}`,
        type: "credit",
        subtype: "credit card",
        mask,
      }));

      const r = await fetch(`${baseUrl}/plaid/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicToken: `public-sandbox-pass${pass}` }),
      });
      expect(r.status).toBe(200);

      // After every pass, exactly three Amex `plaid_accounts` rows
      // exist — one per physical card mask. The cross-item dupe guard
      // in /plaid/exchange (lines 686-739) reuses the existing row
      // and rotates its accountId / itemId in place instead of
      // inserting a sibling.
      const accts = await db
        .select()
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, TEST_USER));
      expect(accts).toHaveLength(3);
      const masksSeen = new Set(accts.map((a) => a.mask));
      expect(masksSeen).toEqual(new Set(cardMasks));
      // Every row reflects the current pass's accountId text.
      const currentAccountIds = new Set(nextAccounts.map((a) => a.account_id));
      for (const acct of accts) {
        expect(currentAccountIds.has(acct.accountId)).toBe(true);
      }
    }
  });

  it("re-link with a pre-existing duplicate row per card collapses to one row per card (cross-item guard + dedupe heal)", async () => {
    // Pre-seed: two stale `plaid_accounts` rows for one of the three
    // cards (mask 1001), under two different prior items, simulating
    // the exact bug #416 needs to prevent. The exchange guard should
    // adopt one of the existing rows for ··1001 instead of minting a
    // third sibling, and the per-Amex-page heal hook (#416) catches
    // any leftover duplicate via dedupePlaidAccountsForUser.
    const oldItemA = `amex-old-A-${randomUUID().slice(0, 8)}`;
    const [staleA] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
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
        itemId: oldItemB,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      itemId: staleA.id,
      accountId: `stale-A-1001-${randomUUID().slice(0, 8)}`,
      name: "Amex ··1001",
      mask: "1001",
      type: "credit",
      subtype: "credit card",
    });
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      itemId: staleB.id,
      accountId: `stale-B-1001-${randomUUID().slice(0, 8)}`,
      name: "Amex ··1001",
      mask: "1001",
      type: "credit",
      subtype: "credit card",
    });

    // Now exchange returns all three cards.
    nextExchangeItemId = `amex-item-fresh-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    nextAccounts = ["1001", "2002", "3003"].map((mask) => ({
      account_id: `amex-${mask}-fresh-${randomUUID().slice(0, 8)}`,
      name: `Amex ··${mask}`,
      type: "credit",
      subtype: "credit card",
      mask,
    }));

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-amex" }),
    });
    expect(r.status).toBe(200);

    // Exchange guard reused one of the existing ··1001 rows. There may
    // still be one leftover duplicate row from the second pre-seed; the
    // /amex/anchor heal hook collapses it on the next page hit.
    const acctsAfterExchange = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    const oneOhOneAfterExchange = acctsAfterExchange.filter(
      (a) => a.mask === "1001",
    );
    expect(oneOhOneAfterExchange.length).toBeLessThanOrEqual(2);

    // Trigger the heal hook (the same routine that /amex/anchor runs).
    const { dedupePlaidAccountsForUser } = await import(
      "../lib/dedupePlaidAccounts"
    );
    await dedupePlaidAccountsForUser(TEST_USER);

    const acctsFinal = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(acctsFinal).toHaveLength(3);
    expect(new Set(acctsFinal.map((a) => a.mask))).toEqual(
      new Set(["1001", "2002", "3003"]),
    );
  });
});
