// (#671) Frequent forced-refresh loop semantics — Layer 2 of the
// "pending charges always land" delivery guarantee.
//
// The 10-minute background loop calls
// `syncAllForAllUsers({ forceRefresh: true })`. Verifies:
//   1. Every active healthy item is touched (no item left behind).
//   2. forceRefresh:true is propagated all the way to /transactions/refresh.
//   3. Reauth-blocked items are skipped server-side so we don't burn
//      Plaid quota on tokens that will bounce.
//   4. Two concurrent loop kicks don't double-sync the same item — the
//      per-item serialization chain (syncPlaidItemSerialized) keeps the
//      same itemRowId from running its cursor walk in parallel with
//      itself.

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
import { eq } from "drizzle-orm";

const TEST_USER = `frequent-refresh-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

// Track every Plaid call so we can assert ordering, count, and which
// item received which call.
let refreshCallsByToken: string[] = [];
let syncCallsByToken: string[] = [];
let syncInflightByToken: Map<string, number> = new Map();
let maxConcurrentSyncByToken: Map<string, number> = new Map();

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsRefresh: async ({ access_token }: { access_token: string }) => {
        refreshCallsByToken.push(access_token);
        return { data: {} };
      },
      transactionsSync: async ({ access_token }: { access_token: string }) => {
        syncCallsByToken.push(access_token);
        const cur = (syncInflightByToken.get(access_token) ?? 0) + 1;
        syncInflightByToken.set(access_token, cur);
        const peak = Math.max(
          maxConcurrentSyncByToken.get(access_token) ?? 0,
          cur,
        );
        maxConcurrentSyncByToken.set(access_token, peak);
        // Yield to the event loop so concurrent kicks have a real
        // chance to interleave — without this `await` the mock is
        // synchronous and Node's microtask ordering hides any race.
        await new Promise((r) => setTimeout(r, 5));
        syncInflightByToken.set(
          access_token,
          (syncInflightByToken.get(access_token) ?? 1) - 1,
        );
        return {
          data: {
            added: [],
            modified: [],
            removed: [],
            next_cursor: "",
            has_more: false,
          },
        };
      },
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "x", consent_expiration_time: null } },
      }),
    }),
  };
});

// Tight retry budget so the poll-after-refresh loop inside syncPlaidItem
// completes quickly under tests.
process.env.PLAID_REFRESH_POLL_DELAYS_MS = "5,5";

import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  syncAllForAllUsers,
  _resetPlaidSyncChainForTests,
} from "../lib/plaidSync";
import { createTestHousehold } from "./_helpers/testHousehold";

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
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  refreshCallsByToken = [];
  syncCallsByToken = [];
  syncInflightByToken = new Map();
  maxConcurrentSyncByToken = new Map();
  _resetPlaidSyncChainForTests();
});

async function seedItem(opts: {
  institutionName: string;
  lastSyncErrorCode?: string | null;
}): Promise<{ itemRowId: string; accessToken: string }> {
  const accessToken = `access-sandbox-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken,
      institutionName: opts.institutionName,
      institutionSlug: opts.institutionName.toLowerCase(),
      lastSyncErrorCode: opts.lastSyncErrorCode ?? null,
    })
    .returning();
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: `acct-${randomUUID()}`,
    name: `${opts.institutionName} Checking`,
    mask: "1234",
    type: "depository",
    subtype: "checking",
  });
  return { itemRowId: item!.id, accessToken };
}

describe("(#671) frequent forced-refresh loop", () => {
  it("calls /transactions/refresh on every healthy item with forceRefresh:true", async () => {
    const a = await seedItem({ institutionName: "Chase" });
    const b = await seedItem({ institutionName: "Amex" });

    await syncAllForAllUsers({ forceRefresh: true });

    // Both healthy items got their /transactions/refresh kicked.
    expect(refreshCallsByToken).toContain(a.accessToken);
    expect(refreshCallsByToken).toContain(b.accessToken);
  });

  it("skips items in a reauth state (does not burn quota on tokens Plaid will bounce)", async () => {
    const healthy = await seedItem({ institutionName: "Chase" });
    const broken = await seedItem({
      institutionName: "Wells",
      lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
    });

    await syncAllForAllUsers({ forceRefresh: true });

    expect(refreshCallsByToken).toContain(healthy.accessToken);
    // The reauth-blocked item's token was never sent to Plaid.
    expect(refreshCallsByToken).not.toContain(broken.accessToken);
    expect(syncCallsByToken).not.toContain(broken.accessToken);
  });

  it("does NOT run the same item concurrently when two loop kicks overlap", async () => {
    // Single item, two simultaneous loop kicks. The per-item promise
    // chain (syncPlaidItemSerialized) must serialize them so the
    // cursor walk never executes against itself in parallel — that's
    // what would corrupt the cursor and silently drop a batch.
    const a = await seedItem({ institutionName: "Chase" });

    await Promise.all([
      syncAllForAllUsers({ forceRefresh: true }),
      syncAllForAllUsers({ forceRefresh: true }),
    ]);

    // Two kicks → two refresh attempts (one per loop), but never two
    // /transactions/sync calls in flight against the same access_token
    // at the same time.
    expect(refreshCallsByToken.filter((t) => t === a.accessToken).length).toBe(
      2,
    );
    expect(maxConcurrentSyncByToken.get(a.accessToken) ?? 0).toBeLessThanOrEqual(
      1,
    );
  });
});
