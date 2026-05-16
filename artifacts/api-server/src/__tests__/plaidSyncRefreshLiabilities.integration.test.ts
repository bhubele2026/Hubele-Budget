import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

// (#651) The Amex page's "Refresh from Plaid" button POSTs /plaid/sync
// expecting BOTH the transactions cursor AND the cached liability
// balance to refresh. Pre-fix the route only walked /transactions/sync,
// so liability_balance + liability_last_fetched_at stayed stale and the
// Ending Balance tile read "Updated 1 week ago" right after a click.
// These tests pin the route's contract: a successful per-item sync
// must trigger fetchLiabilitiesForItem for every item that has at
// least one credit/loan account, and per-item liability failures must
// not 500 the whole response (transactions sync already succeeded).

const TEST_USER = `sync-liab-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

type SyncResultLike = {
  itemId: string;
  plaidItemRowId: string;
  institutionName: string | null;
  added: number;
  modified: number;
  removed: number;
  autoCategorized: number;
  ruleAttributions: unknown[];
  error?: string | null;
};
type SyncFn = (userId: string, itemRowId: string) => Promise<SyncResultLike>;
type SyncAllFn = (userId: string, householdId: string) => Promise<SyncResultLike[]>;

let syncPlaidItemMock: SyncFn = async (_u, itemRowId) => ({
  itemId: itemRowId,
  plaidItemRowId: itemRowId,
  institutionName: null,
  added: 0,
  modified: 0,
  removed: 0,
  autoCategorized: 0,
  ruleAttributions: [],
  error: null,
});
let syncAllForUserMock: SyncAllFn = async () => [];

vi.mock("../lib/plaidSync", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaidSync")>("../lib/plaidSync");
  return {
    ...actual,
    syncPlaidItem: (u: string, i: string) => syncPlaidItemMock(u, i),
    // (#671) Route now calls the serialized wrapper; in tests we just
    // delegate straight to the mock so the per-item promise-chain
    // doesn't drag in the real Plaid client.
    syncPlaidItemSerialized: (u: string, i: string) => syncPlaidItemMock(u, i),
    syncAllForUser: (u: string, h: string) => syncAllForUserMock(u, h),
  };
});

const fetchLiabilitiesCalls: Array<{ userId: string; itemRowId: string }> = [];
let fetchLiabilitiesShouldThrow = false;

vi.mock("../lib/plaidLiabilities", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaidLiabilities")>(
      "../lib/plaidLiabilities",
    );
  return {
    ...actual,
    fetchLiabilitiesForItem: async (userId: string, itemRowId: string) => {
      fetchLiabilitiesCalls.push({ userId, itemRowId });
      if (fetchLiabilitiesShouldThrow) {
        throw new Error("simulated liabilities outage");
      }
      return [];
    },
  };
});

import { db, plaidAccountsTable, plaidItemsTable } from "@workspace/db";
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
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await cleanup();
  fetchLiabilitiesCalls.length = 0;
  fetchLiabilitiesShouldThrow = false;
  syncPlaidItemMock = async (_u, itemRowId) => ({
    itemId: itemRowId,
    plaidItemRowId: itemRowId,
    institutionName: null,
    added: 0,
    modified: 0,
    removed: 0,
    autoCategorized: 0,
    ruleAttributions: [],
    error: null,
  });
});

async function insertItem(opts: {
  accounts: Array<{
    type: string | null;
    subtype?: string | null;
    liabilityKind?: string | null;
  }>;
}): Promise<{ itemRowId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `sync-item-${suffix}`,
      accessToken: "access-sandbox-test",
      institutionName: "Test Bank",
      institutionSlug: "test-bank",
    })
    .returning();
  for (const [i, acct] of opts.accounts.entries()) {
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: `acct-${suffix}-${i}`,
      name: `Account ${i}`,
      type: acct.type,
      subtype: acct.subtype ?? null,
      liabilityKind: acct.liabilityKind ?? null,
    });
  }
  return { itemRowId: item!.id };
}

describe("(#651) POST /plaid/sync refreshes liability balances after transactions sync", () => {
  it("invokes fetchLiabilitiesForItem for credit-card items so the Amex Ending Balance tile reflects the new value", async () => {
    const { itemRowId } = await insertItem({
      accounts: [{ type: "credit", subtype: "credit card" }],
    });

    const res = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: SyncResultLike[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.error).toBeFalsy();

    expect(fetchLiabilitiesCalls).toEqual([
      { userId: TEST_USER, itemRowId },
    ]);
  });

  it("invokes fetchLiabilitiesForItem for loan items too (student/personal loans surface in same Amex-style debt rollups)", async () => {
    const { itemRowId } = await insertItem({
      accounts: [{ type: "loan", subtype: "student" }],
    });

    await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });

    expect(fetchLiabilitiesCalls).toEqual([
      { userId: TEST_USER, itemRowId },
    ]);
  });

  it("skips fetchLiabilitiesForItem for bank-only items (no credit/loan accounts) so we don't pay an INVALID_PRODUCT roundtrip", async () => {
    const { itemRowId } = await insertItem({
      accounts: [{ type: "depository", subtype: "checking" }],
    });

    await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });

    expect(fetchLiabilitiesCalls).toEqual([]);
  });

  it("still includes mixed-type items (credit + depository on same login) — the credit account makes it eligible", async () => {
    const { itemRowId } = await insertItem({
      accounts: [
        { type: "credit", subtype: "credit card" },
        { type: "depository", subtype: "savings" },
      ],
    });

    await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });

    expect(fetchLiabilitiesCalls).toEqual([
      { userId: TEST_USER, itemRowId },
    ]);
  });

  it("does not 500 when fetchLiabilitiesForItem throws — transactions sync already succeeded so the response stays 200", async () => {
    fetchLiabilitiesShouldThrow = true;
    const { itemRowId } = await insertItem({
      accounts: [{ type: "credit", subtype: "credit card" }],
    });

    const res = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: SyncResultLike[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.error).toBeFalsy();
    // The attempt was still made — the warning log is the user-visible
    // signal that the tile may stay stale until next refresh.
    expect(fetchLiabilitiesCalls).toEqual([
      { userId: TEST_USER, itemRowId },
    ]);
  });

  it("skips fetchLiabilitiesForItem when syncPlaidItem itself reported an error (no point re-pulling balances on a broken item)", async () => {
    const { itemRowId } = await insertItem({
      accounts: [{ type: "credit", subtype: "credit card" }],
    });
    syncPlaidItemMock = async (_u, id) => ({
      itemId: id,
      plaidItemRowId: id,
      institutionName: null,
      added: 0,
      modified: 0,
      removed: 0,
      autoCategorized: 0,
      ruleAttributions: [],
      error: "ITEM_LOGIN_REQUIRED",
    });

    await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });

    expect(fetchLiabilitiesCalls).toEqual([]);
  });

  it("liability-kind-only accounts (legacy rows where type is null but liabilityKind was set by a prior /liabilities/get) still trigger refresh", async () => {
    const { itemRowId } = await insertItem({
      accounts: [{ type: null, subtype: null, liabilityKind: "credit" }],
    });

    await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });

    expect(fetchLiabilitiesCalls).toEqual([
      { userId: TEST_USER, itemRowId },
    ]);
  });
});
