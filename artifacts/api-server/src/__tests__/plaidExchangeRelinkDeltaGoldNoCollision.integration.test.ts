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

// (#754) Regression test for the dedupe-mask-collision bug.
//
// Two physical Amex cards under one Plaid login can share a mask
// (Platinum Card® ··1009 and Delta SkyMiles® Gold Card ··1009). Before
// this fix, the /plaid/exchange account-upsert dupe guard in
// routes/plaid.ts matched candidates by (householdId, mask) only — so
// the second card's ingest reused the first card's row and silently
// overwrote its accountId/name. The user lost a card row entirely and
// every transaction belonging to the lost card became unfilterable
// because there was no plaid_accounts row whose accountId matched the
// stored transactions.plaid_account_id.
//
// This test exercises the exact scenario: Platinum ··1009 is already in
// the DB; a fresh /plaid/exchange returns BOTH Platinum ··1009 and
// Delta Gold ··1009 under the same item. After the call, both rows
// must survive with their correct distinct accountIds.

const TEST_USER = `relink-amex-delta-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

let nextExchangeAccessToken = "access-sandbox-fresh";
let nextExchangeItemId = "item-fresh";
let nextAccounts: Array<{
  account_id: string;
  name: string;
  official_name?: string;
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

describe("(#754) /plaid/exchange ingest preserves two same-mask different-name Amex cards", () => {
  it("ingesting Delta SkyMiles Gold ··1009 when Platinum ··1009 already exists keeps both rows with distinct accountIds", async () => {
    // Pre-seed: Platinum ··1009 already exists under a prior Amex item,
    // exactly mirroring the production state that surfaced #754.
    const existingPlatinumAccountId = `amex-platinum-${randomUUID().slice(0, 8)}`;
    const [priorItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `amex-prior-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: priorItem.id,
      accountId: existingPlatinumAccountId,
      name: "Platinum Card®",
      officialName: "Platinum Card®",
      mask: "1009",
      type: "credit",
      subtype: "credit card",
    });

    // Fresh /plaid/exchange call returns BOTH cards under one item.
    nextExchangeItemId = `amex-fresh-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    const newPlatinumAccountId = `amex-platinum-fresh-${randomUUID().slice(0, 8)}`;
    const newDeltaGoldAccountId = `amex-delta-gold-fresh-${randomUUID().slice(0, 8)}`;
    nextAccounts = [
      {
        account_id: newPlatinumAccountId,
        name: "Platinum Card®",
        official_name: "Platinum Card®",
        type: "credit",
        subtype: "credit card",
        mask: "1009",
      },
      {
        account_id: newDeltaGoldAccountId,
        name: "Delta SkyMiles® Gold Card",
        official_name: "Delta SkyMiles® Gold Card",
        type: "credit",
        subtype: "credit card",
        mask: "1009",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-amex" }),
    });
    expect(r.status).toBe(200);

    // BOTH rows must survive. Pre-#754 code would have matched both
    // incoming cards onto the single existing Platinum row by mask
    // alone — the second match (Delta Gold) would have overwritten
    // its accountId/name, leaving only one row total.
    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(accts).toHaveLength(2);

    const platinum = accts.find((a) => a.name === "Platinum Card®");
    const deltaGold = accts.find(
      (a) => a.name === "Delta SkyMiles® Gold Card",
    );
    expect(platinum, "Platinum row must survive").toBeDefined();
    expect(deltaGold, "Delta Gold row must be inserted").toBeDefined();

    // Existing Platinum row was reused (same row id) and rotated onto
    // the fresh item + fresh accountId. Delta Gold was inserted as a
    // new row with its own accountId.
    expect(platinum!.accountId).toBe(newPlatinumAccountId);
    expect(deltaGold!.accountId).toBe(newDeltaGoldAccountId);
    expect(platinum!.mask).toBe("1009");
    expect(deltaGold!.mask).toBe("1009");
    expect(platinum!.accountId).not.toBe(deltaGold!.accountId);

    // Both rows are now homed under the fresh item.
    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER));
    const freshItem = items.find((i) => i.itemId === nextExchangeItemId);
    expect(freshItem, "fresh item row must exist").toBeDefined();
    expect(platinum!.itemId).toBe(freshItem!.id);
    expect(deltaGold!.itemId).toBe(freshItem!.id);
  });

  it("with both a legacy (empty-name) candidate and an exact-name candidate at the same mask, the exact-name candidate wins deterministically", async () => {
    // Determinism check: when the candidate set mixes an empty-name
    // legacy row and an exact-name row at the same mask, the upsert
    // must adopt the exact-name row — never the legacy one, regardless
    // of DB return order. Without strictly tiered selection, .find()
    // over a permissive union could pick whichever row Postgres
    // happened to return first.
    const [priorItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `amex-mixed-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    // Legacy empty-name row, inserted FIRST so it tends to come back
    // first in default ordering.
    const legacyAccountId = `legacy-1234-${randomUUID().slice(0, 8)}`;
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: priorItem.id,
      accountId: legacyAccountId,
      name: null,
      officialName: null,
      mask: "1234",
      type: "credit",
      subtype: "credit card",
    });
    const exactAccountId = `exact-1234-${randomUUID().slice(0, 8)}`;
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: priorItem.id,
      accountId: exactAccountId,
      name: "Sapphire Card®",
      officialName: "Sapphire Card®",
      mask: "1234",
      type: "credit",
      subtype: "credit card",
    });

    nextExchangeItemId = `amex-mixed-fresh-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    const freshAccountId = `fresh-1234-${randomUUID().slice(0, 8)}`;
    nextAccounts = [
      {
        account_id: freshAccountId,
        name: "Sapphire Card®",
        official_name: "Sapphire Card®",
        type: "credit",
        subtype: "credit card",
        mask: "1234",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-mixed" }),
    });
    expect(r.status).toBe(200);

    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    // Exact-name row was reused (rotated onto freshAccountId); legacy
    // row was left untouched. Net: still two rows, exact-name now
    // carries the fresh accountId.
    expect(accts).toHaveLength(2);
    const legacy = accts.find((a) => a.name === null);
    const exact = accts.find((a) => a.name === "Sapphire Card®");
    expect(legacy, "legacy row should still exist").toBeDefined();
    expect(exact, "exact-name row should still exist").toBeDefined();
    expect(legacy!.accountId).toBe(legacyAccountId);
    expect(exact!.accountId).toBe(freshAccountId);
  });

  it("same-item re-exchange with same-mask two-card payload keeps both rows distinct", async () => {
    // Same-item variant: a fresh exchange under the SAME item_id that
    // already owns Platinum ··1009 returns BOTH Platinum and Delta
    // Gold. The sameItem branch must still pick the right candidate
    // for each incoming card (and insert the missing one) — not fold
    // them onto each other.
    const sharedItemId = `amex-shared-${randomUUID().slice(0, 8)}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: sharedItemId,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    const oldPlatinumAccountId = `same-item-plat-${randomUUID().slice(0, 8)}`;
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item.id,
      accountId: oldPlatinumAccountId,
      name: "Platinum Card®",
      officialName: "Platinum Card®",
      mask: "1009",
      type: "credit",
      subtype: "credit card",
    });

    // Same item_id, same access token (re-exchange path with cached item).
    nextExchangeItemId = sharedItemId;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    const newPlatinumAccountId = `same-item-plat-fresh-${randomUUID().slice(0, 8)}`;
    const newDeltaGoldAccountId = `same-item-delta-fresh-${randomUUID().slice(0, 8)}`;
    nextAccounts = [
      {
        account_id: newPlatinumAccountId,
        name: "Platinum Card®",
        official_name: "Platinum Card®",
        type: "credit",
        subtype: "credit card",
        mask: "1009",
      },
      {
        account_id: newDeltaGoldAccountId,
        name: "Delta SkyMiles® Gold Card",
        official_name: "Delta SkyMiles® Gold Card",
        type: "credit",
        subtype: "credit card",
        mask: "1009",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-same-item" }),
    });
    expect(r.status).toBe(200);

    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(accts).toHaveLength(2);
    const platinum = accts.find((a) => a.name === "Platinum Card®");
    const delta = accts.find((a) => a.name === "Delta SkyMiles® Gold Card");
    expect(platinum).toBeDefined();
    expect(delta).toBeDefined();
    expect(platinum!.accountId).toBe(newPlatinumAccountId);
    expect(delta!.accountId).toBe(newDeltaGoldAccountId);
  });

  it("ingesting a same-mask card with an empty (legacy) candidate name still reuses the legacy row (mask-only fallback)", async () => {
    // A pre-existing row whose name is empty (e.g. created before the
    // app started capturing account names). On re-link with a card
    // that shares its mask, the dupe guard must still adopt the
    // legacy row — otherwise every legacy user would get a duplicate
    // sibling row on their next re-link.
    const legacyAccountId = `amex-legacy-${randomUUID().slice(0, 8)}`;
    const [priorItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `amex-legacy-item-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: priorItem.id,
      accountId: legacyAccountId,
      name: null,
      officialName: null,
      mask: "4242",
      type: "credit",
      subtype: "credit card",
    });

    nextExchangeItemId = `amex-fresh-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    const newAccountId = `amex-4242-fresh-${randomUUID().slice(0, 8)}`;
    nextAccounts = [
      {
        account_id: newAccountId,
        name: "Some Card®",
        official_name: "Some Card®",
        type: "credit",
        subtype: "credit card",
        mask: "4242",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-amex-legacy" }),
    });
    expect(r.status).toBe(200);

    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(accts).toHaveLength(1);
    expect(accts[0].accountId).toBe(newAccountId);
    expect(accts[0].name).toBe("Some Card®");
    expect(accts[0].mask).toBe("4242");
  });
});
