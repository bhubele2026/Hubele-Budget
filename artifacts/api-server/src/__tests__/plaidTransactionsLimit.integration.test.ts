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

/**
 * (#728) Circuit-breaker tests for /transactions/refresh
 * TRANSACTIONS_LIMIT (HTTP 429):
 *
 *   1. A TRANSACTIONS_LIMIT error stamps `refresh_rate_limited_until`
 *      to now()+1h and surfaces `refreshDisabledReason="rate_limited"`
 *      on the sync result so the UI can render honest copy.
 *   2. A subsequent user-initiated sync while the stamp is still in
 *      the future short-circuits — it never calls
 *      /transactions/refresh again and still returns
 *      `refreshDisabledReason="rate_limited"`.
 *   3. A successful /transactions/refresh clears the stamp (self-heal),
 *      matching the same self-heal pattern already in place for the
 *      INVALID_PRODUCT (#725) circuit breaker.
 *
 * The point is to prevent the Chase bug from May 2026, where every
 * click of Sync burned the same 429 against the same per-item quota
 * and pushed the next legitimate refresh further out.
 */

const TEST_USER = `txnlimit-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

type RefreshFn = (args: { access_token: string }) => Promise<unknown>;
type SyncFn = (args: { access_token: string; cursor?: string }) => Promise<unknown>;

let refreshMock: RefreshFn = async () => ({ data: {} });
const refreshCalls: Array<{ access_token: string }> = [];

let syncMock: SyncFn = async () => ({
  data: {
    added: [],
    modified: [],
    removed: [],
    has_more: false,
    next_cursor: "cursor-end",
  },
});

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsRefresh: (args: Parameters<RefreshFn>[0]) => {
        refreshCalls.push(args);
        return refreshMock(args);
      },
      transactionsSync: (args: Parameters<SyncFn>[0]) => syncMock(args),
      accountsGet: async () => ({ data: { accounts: [] } }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "x", consent_expiration_time: null } },
      }),
    }),
  };
});

import { db, plaidItemsTable } from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";
import { createTestHousehold } from "./_helpers/testHousehold";

async function cleanup(): Promise<void> {
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
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
  refreshMock = async () => ({ data: {} });
  syncMock = async () => ({
    data: {
      added: [],
      modified: [],
      removed: [],
      has_more: false,
      next_cursor: "cursor-end",
    },
  });
});

async function seedItem(): Promise<{ itemRowId: string; itemId: string }> {
  const externalItemId = `item-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: externalItemId,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  return { itemRowId: item!.id, itemId: externalItemId };
}

function makeTransactionsLimitError(): unknown {
  return {
    message: "Request failed with status code 429",
    response: {
      status: 429,
      data: {
        error_code: "TRANSACTIONS_LIMIT",
        error_message:
          "the per-item /transactions/refresh quota is exhausted",
        error_type: "RATE_LIMIT_EXCEEDED_ERROR",
      },
    },
  };
}

describe("(#728) /transactions/refresh circuit-breaker", () => {
  it("stamps refresh_rate_limited_until and surfaces rate_limited on TRANSACTIONS_LIMIT", async () => {
    const { itemRowId } = await seedItem();
    refreshMock = async () => {
      throw makeTransactionsLimitError();
    };

    const before = Date.now();
    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });
    const after = Date.now();

    expect(result.refreshDisabledReason).toBe("rate_limited");
    expect(refreshCalls).toHaveLength(1);

    const [row] = await db
      .select({
        refreshRateLimitedUntil: plaidItemsTable.refreshRateLimitedUntil,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.refreshRateLimitedUntil).not.toBeNull();
    const stampMs = row!.refreshRateLimitedUntil!.getTime();
    // Stamp must land within (now+59m, now+61m) so the user-initiated
    // retry window is honored — too short and we burn quota on the
    // next click, too long and Plaid's window has rolled over before
    // we let the user retry.
    expect(stampMs).toBeGreaterThan(before + 59 * 60 * 1000);
    expect(stampMs).toBeLessThan(after + 61 * 60 * 1000);
  });

  it("short-circuits subsequent sync while the rate-limit stamp is in the future (no second refresh call)", async () => {
    const { itemRowId } = await seedItem();
    // Pre-stamp a fresh +30m window so this sync should short-circuit
    // even though the mock is a no-op success — if the breaker leaks,
    // refreshCalls would grow and the test fails.
    await db
      .update(plaidItemsTable)
      .set({
        refreshRateLimitedUntil: new Date(Date.now() + 30 * 60 * 1000),
      })
      .where(eq(plaidItemsTable.id, itemRowId));

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    expect(result.refreshDisabledReason).toBe("rate_limited");
    expect(refreshCalls).toHaveLength(0);
  });

  it("self-heals: a successful refresh clears refresh_rate_limited_until (and refresh_product_disabled_at)", async () => {
    const { itemRowId } = await seedItem();
    // Seed both stamps as if a prior INVALID_PRODUCT (#725) AND
    // TRANSACTIONS_LIMIT (#728) both fired in the past, then expired.
    // A successful refresh must clear BOTH in one UPDATE so partial
    // clears can't leave the breaker engaged after a clean refresh.
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(plaidItemsTable)
      .set({
        refreshRateLimitedUntil: expired,
        refreshProductDisabledAt: expired,
      })
      .where(eq(plaidItemsTable.id, itemRowId));

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    expect(result.refreshDisabledReason).toBeNull();
    expect(refreshCalls).toHaveLength(1);

    const [row] = await db
      .select({
        refreshRateLimitedUntil: plaidItemsTable.refreshRateLimitedUntil,
        refreshProductDisabledAt: plaidItemsTable.refreshProductDisabledAt,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.refreshRateLimitedUntil).toBeNull();
    expect(row?.refreshProductDisabledAt).toBeNull();
  });
});
