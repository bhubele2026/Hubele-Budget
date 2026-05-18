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

import { createTestHousehold } from "./_helpers/testHousehold";

// (#727) Reproduce the production trap: a Chase item with a stale
// `refresh_product_disabled_at` stamp from a prior INVALID_PRODUCT
// incident that has since been resolved (Plaid Dashboard now shows
// `transactions_refresh` Enabled). The pre-#727 code skipped the
// live refresh call for 7 days, which meant the #725 self-heal —
// which only fires on a *successful* refresh — could never run.
// Every user-clicked Sync went straight to /transactions/sync and
// the honest-copy "real-time refresh isn't enabled" toast kept
// firing indefinitely. These tests pin the split-cooldown contract:
// background callers still skip for 7 days; user-clicked Syncs retry
// after 1 hour so the self-heal has a path to actually clear the
// stamp.

const TEST_USER = `refresh-retry-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

const refreshCalls: { access_token: string; calledAt: number }[] = [];
const syncCalls: { access_token: string; calledAt: number }[] = [];
let refreshShouldThrow: Error | null = null;

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsRefresh: async ({
        access_token,
      }: {
        access_token: string;
      }) => {
        refreshCalls.push({ access_token, calledAt: Date.now() });
        if (refreshShouldThrow) throw refreshShouldThrow;
        return { data: { request_id: "req-refresh-1" } };
      },
      transactionsSync: async ({
        access_token,
      }: {
        access_token: string;
      }) => {
        syncCalls.push({ access_token, calledAt: Date.now() });
        return {
          data: {
            added: [],
            modified: [],
            removed: [],
            next_cursor: "cursor-next",
            has_more: false,
          },
        };
      },
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: {
          item: { item_id: "item-default", consent_expiration_time: null },
        },
      }),
    }),
  };
});

import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(plaidSyncAttemptsTable)
    .where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  refreshCalls.length = 0;
  syncCalls.length = 0;
  refreshShouldThrow = null;
});

async function seedStampedChase(stampAgeMs: number): Promise<{
  itemRowId: string;
  externalAcctId: string;
  accessToken: string;
}> {
  const accessToken = `access-sandbox-${randomUUID()}`;
  const stamp = new Date(Date.now() - stampAgeMs);
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken,
      institutionName: "Chase",
      institutionSlug: "chase",
      cursor: "prev-cursor",
      refreshProductDisabledAt: stamp,
    })
    .returning();
  const externalAcctId = `acct-${randomUUID()}`;
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: externalAcctId,
    name: "TOTAL CHECKING",
    type: "depository",
    subtype: "checking",
    firstSyncCompletedAt: new Date("2026-05-07T00:00:00Z"),
  });
  return { itemRowId: item!.id, externalAcctId, accessToken };
}

describe("(#727) /transactions/refresh cooldown is split by intent", () => {
  // Background callers (webhook coalescer, nightly cron) must continue
  // to honor the 7-day window — they aren't a human asking for fresh
  // data and we don't want them to spam INVALID_PRODUCT against a
  // truly disabled add-on.
  it("cron path (forceRefresh=false) still skips refresh for 7 days after the stamp", async () => {
    const { itemRowId } = await seedStampedChase(2 * 60 * 60 * 1000); // 2h ago

    // No opts → forceRefresh defaults to false, mirroring the webhook
    // coalescer and syncAllForAllUsers cron paths.
    const result = await syncPlaidItem(TEST_USER, itemRowId);

    expect(refreshCalls.length).toBe(0);
    expect(syncCalls.length).toBe(1);
    // refreshAttempted echoes the caller's forceRefresh flag, which
    // was false here — refresh genuinely was not attempted.
    expect(result.refreshAttempted).toBe(false);

    // The stamp must remain set — the cron path is not allowed to
    // clear or re-bump it.
    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(persisted!.refreshProductDisabledAt).not.toBeNull();
  });

  // The core #727 contract: a user-clicked Sync at >1h after the
  // stamp fires the live refresh call. On success, the #725 self-heal
  // clears the stamp automatically — no manual Settings trip required.
  it("user-clicked Sync (forceRefresh=true) retries refresh after 1h and #725 self-heal clears the stamp on success", async () => {
    const { itemRowId, accessToken } = await seedStampedChase(
      2 * 60 * 60 * 1000, // 2h ago — past the 1h user cooldown
    );

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    // Live refresh fired exactly once with the item's access token.
    expect(refreshCalls.length).toBe(1);
    expect(refreshCalls[0]!.access_token).toBe(accessToken);
    expect(syncCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.refreshAttempted).toBe(true);
    // Healthy path → no honest-copy "refresh disabled" reason.
    expect(result.refreshDisabledReason).toBeNull();

    // #725 self-heal must have nulled the stamp now that the live
    // refresh proved the add-on is enabled.
    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(persisted!.refreshProductDisabledAt).toBeNull();
  });

  // If the add-on truly is still disabled, the 1h-retry path must
  // re-stamp and re-surface the honest reason — exactly the same
  // behavior the original #723 path had — so subsequent clicks
  // short-circuit again until another hour passes.
  it("user-clicked Sync re-stamps and re-surfaces refreshDisabledReason when refresh still returns INVALID_PRODUCT(transactions_refresh)", async () => {
    const { itemRowId } = await seedStampedChase(2 * 60 * 60 * 1000); // 2h ago
    refreshShouldThrow = Object.assign(new Error("INVALID_PRODUCT"), {
      response: {
        status: 400,
        data: {
          error_code: "INVALID_PRODUCT",
          error_message:
            'client is not authorized to access the following products: ["transactions_refresh"]',
          display_message: null,
          request_id: "req-invalid-product-still-off",
        },
      },
    });
    const beforeTs = Date.now();

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    expect(refreshCalls.length).toBe(1);
    expect(syncCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.refreshAttempted).toBe(true);
    // Honest copy is surfaced again so the UI keeps telling the truth.
    expect(result.refreshDisabledReason).toMatch(/transactions_refresh/i);

    // Stamp was re-bumped to "now" so the next click within the hour
    // short-circuits without re-spamming Plaid.
    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(persisted!.refreshProductDisabledAt).toBeInstanceOf(Date);
    expect(persisted!.refreshProductDisabledAt!.getTime()).toBeGreaterThanOrEqual(
      beforeTs,
    );
  });

  // Spam-click guard: a user-clicked Sync within the new 1h window
  // must still skip the live refresh call so we don't hammer Plaid
  // when the user clicks Sync three times in a row. Honest copy
  // continues to fire so the UI doesn't silently flip to "healthy".
  it("user-clicked Sync within 1h of the stamp still skips refresh and keeps surfacing refreshDisabledReason", async () => {
    const { itemRowId } = await seedStampedChase(5 * 60 * 1000); // 5min ago

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    expect(refreshCalls.length).toBe(0);
    expect(syncCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.refreshDisabledReason).toMatch(/transactions_refresh/i);

    // Stamp untouched — neither cleared nor bumped — within cooldown.
    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(persisted!.refreshProductDisabledAt).not.toBeNull();
  });
});
