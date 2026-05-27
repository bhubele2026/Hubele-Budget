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

// (#754) End-to-end self-healing regression test for /plaid/sync.
//
// Scenario reproduces the exact production state that triggered task
// #754: the household has Platinum ··1009 in plaid_accounts but Delta
// Gold ··1009 was previously deleted by the old dedupe mask-collision
// bug. Delta Gold's historical transactions still reference its Plaid
// account_id, so by definition they look like "orphan" transactions
// (their plaid_account_id has no matching plaid_accounts row).
//
// Before the fix, clicking "Refresh from Plaid" was actually DANGEROUS:
//   1. /plaid/sync called pruneOrphanPlaidTransactionsForHousehold first
//   2. That prune deletes every transaction whose plaid_account_id has
//      no matching plaid_accounts row — i.e. all of Delta Gold's
//      history.
//   3. transactionsSync then proceeds normally but never re-fetches
//      historical data, so Delta Gold's transactions are gone forever.
//
// The fix: /plaid/sync now calls refreshPlaidAccountsForItem BEFORE
// the prune, which uses the same tiered (mask + name) upsert helper
// as /plaid/exchange. With Platinum already at ··1009, the helper sees
// Delta Gold's incoming "Delta SkyMiles® Gold Card" name doesn't match
// Platinum's "Platinum Card®", so it INSERTS a fresh Delta Gold row
// instead of overwriting Platinum. Once the row exists, Delta Gold's
// transactions are no longer orphans and the prune leaves them alone.

const TEST_USER = `sync-selfheal-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
      transactionsRefresh: async () => ({ data: {} }),
      transactionsGet: async () => ({
        data: { transactions: [], total_transactions: 0 },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      liabilitiesGet: async () => ({
        data: { liabilities: {}, accounts: [] },
      }),
      itemGet: async () => ({
        data: {
          item: {
            item_id: "amex-shared",
            institution_id: "ins_amex",
            consent_expiration_time: null,
            webhook: null,
          },
        },
      }),
    }),
  };
});

// Stub the sync scheduler so the /plaid/sync handler's downstream calls
// don't try to talk to a real Plaid instance for unrelated bookkeeping.
vi.mock("../lib/plaidSyncScheduler", () => ({
  scheduleSyncForItem: async () => {},
}));

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

describe("(#754) /plaid/sync self-heals a previously-deleted plaid_accounts row from Plaid's truth", () => {
  it("re-creates Delta Gold ··1009 row AND preserves its historical orphan transactions when Refresh from Plaid is clicked", async () => {
    // --- Pre-seed production state ---
    // 1. The Amex item that owns both physical cards in Plaid.
    const PLATINUM_ACCOUNT_ID = `amex-plat-${randomUUID().slice(0, 8)}`;
    const DELTA_GOLD_ACCOUNT_ID = `amex-delta-gold-${randomUUID().slice(0, 8)}`;
    const [amexItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `amex-prod-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();

    // 2. Platinum row exists. Delta Gold row was deleted by the old
    //    dedupe bug — INTENTIONALLY NOT INSERTED.
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: amexItem.id,
      accountId: PLATINUM_ACCOUNT_ID,
      name: "Platinum Card®",
      officialName: "Platinum Card®",
      mask: "1009",
      type: "credit",
      subtype: "credit card",
    });

    // 3. Delta Gold's historical transactions still reference its
    //    Plaid account_id (the orphan state). Three transactions
    //    spanning a few months so we can verify all survive.
    const txRows = [
      {
        occurredOn: "2026-04-15",
        description: "Delta Air Lines",
        amount: "-450.00",
        txId: `tx-${randomUUID().slice(0, 8)}`,
      },
      {
        occurredOn: "2026-04-30",
        description: "Delta Sky Club",
        amount: "-59.00",
        txId: `tx-${randomUUID().slice(0, 8)}`,
      },
      {
        occurredOn: "2026-05-10",
        description: "United Airlines",
        amount: "-123.45",
        txId: `tx-${randomUUID().slice(0, 8)}`,
      },
    ];
    for (const t of txRows) {
      await db.insert(transactionsTable).values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: t.occurredOn,
        description: t.description,
        amount: t.amount,
        plaidAccountId: DELTA_GOLD_ACCOUNT_ID,
        plaidTransactionId: t.txId,
        source: "plaid",
      });
    }

    // Sanity check: orphans exist before sync.
    const orphansBefore = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.plaidAccountId, DELTA_GOLD_ACCOUNT_ID),
        ),
      );
    expect(orphansBefore).toHaveLength(3);

    // --- Configure Plaid's response: BOTH cards exist in Plaid's truth ---
    nextAccounts = [
      {
        account_id: PLATINUM_ACCOUNT_ID,
        name: "Platinum Card®",
        official_name: "Platinum Card®",
        type: "credit",
        subtype: "credit card",
        mask: "1009",
      },
      {
        account_id: DELTA_GOLD_ACCOUNT_ID,
        name: "Delta SkyMiles® Gold Card",
        official_name: "Delta SkyMiles® Gold Card",
        type: "credit",
        subtype: "credit card",
        mask: "1009",
      },
    ];

    // --- Click "Refresh from Plaid" ---
    const r = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: amexItem.id, force: false }),
    });
    expect(r.status).toBe(200);

    // --- Verify the self-heal ---
    // Delta Gold row was re-created (not as a Platinum overwrite).
    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(accts).toHaveLength(2);

    const platinum = accts.find((a) => a.name === "Platinum Card®");
    const deltaGold = accts.find((a) => a.name === "Delta SkyMiles® Gold Card");
    expect(platinum, "Platinum row must still exist with original data").toBeDefined();
    expect(platinum!.accountId).toBe(PLATINUM_ACCOUNT_ID);
    expect(platinum!.mask).toBe("1009");
    expect(deltaGold, "Delta Gold row must be re-materialized").toBeDefined();
    expect(deltaGold!.accountId).toBe(DELTA_GOLD_ACCOUNT_ID);
    expect(deltaGold!.mask).toBe("1009");
    expect(deltaGold!.itemId).toBe(amexItem.id);

    // Historical transactions survived the orphan prune.
    const txAfter = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.plaidAccountId, DELTA_GOLD_ACCOUNT_ID),
        ),
      );
    expect(txAfter, "all 3 historical Delta Gold transactions must survive").toHaveLength(3);
    const descriptions = txAfter.map((t) => t.description).sort();
    expect(descriptions).toEqual([
      "Delta Air Lines",
      "Delta Sky Club",
      "United Airlines",
    ]);
  });

  it("on a clean household (no missing rows), /plaid/sync is a no-op for accounts and prune", async () => {
    // Make sure the new pre-prune refresh doesn't disrupt the happy
    // path. Pre-seed two distinct cards, sync should leave both
    // exactly as-is.
    const ACCT_A = `clean-a-${randomUUID().slice(0, 8)}`;
    const ACCT_B = `clean-b-${randomUUID().slice(0, 8)}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `clean-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_amex",
        institutionName: "American Express",
        institutionSlug: "amex",
      })
      .returning();
    await db.insert(plaidAccountsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item.id,
        accountId: ACCT_A,
        name: "Card A",
        officialName: "Card A",
        mask: "0001",
        type: "credit",
        subtype: "credit card",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item.id,
        accountId: ACCT_B,
        name: "Card B",
        officialName: "Card B",
        mask: "0002",
        type: "credit",
        subtype: "credit card",
      },
    ]);

    nextAccounts = [
      {
        account_id: ACCT_A,
        name: "Card A",
        official_name: "Card A",
        type: "credit",
        subtype: "credit card",
        mask: "0001",
      },
      {
        account_id: ACCT_B,
        name: "Card B",
        official_name: "Card B",
        type: "credit",
        subtype: "credit card",
        mask: "0002",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: item.id, force: false }),
    });
    expect(r.status).toBe(200);

    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(accts).toHaveLength(2);
    const ids = accts.map((a) => a.accountId).sort();
    expect(ids).toEqual([ACCT_A, ACCT_B].sort());
  });
});
