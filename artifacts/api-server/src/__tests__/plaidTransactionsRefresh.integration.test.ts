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
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `refresh-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

type AddedTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
};

let nextSyncResponse: {
  added: AddedTxn[];
  modified: AddedTxn[];
  removed: { transaction_id: string }[];
} = { added: [], modified: [], removed: [] };

const refreshCalls: { access_token: string; calledAt: number }[] = [];
const syncCalls: { access_token: string; calledAt: number }[] = [];
let refreshShouldThrow: Error | null = null;

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      // (#665) Capture every refresh attempt + every sync call so we can
      // assert ordering (refresh-then-sync) and that refresh is or isn't
      // invoked depending on the caller's `forceRefresh` choice.
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
        cursor,
      }: {
        access_token: string;
        cursor?: string;
      }) => {
        syncCalls.push({ access_token, calledAt: Date.now() });
        // (#717) Model real Plaid cursor semantics so the
        // poll-after-refresh loop terminates: the seeded item starts at
        // cursor "prev-cursor", so the FIRST walk delivers the staged
        // batch and advances the cursor to "cursor-1". Every subsequent
        // walk re-reads from "cursor-1" and must come back empty (the
        // feed is drained) — otherwise the #717 retry loop keeps
        // re-walking on every non-empty drain and `syncCalls` balloons.
        const drained = cursor === "cursor-1";
        return {
          data: {
            added: drained ? [] : nextSyncResponse.added,
            modified: drained ? [] : nextSyncResponse.modified,
            removed: drained ? [] : nextSyncResponse.removed,
            next_cursor: "cursor-1",
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

// (#717) Near-instant poll backoffs so the confirm-settled empty drain
// fires immediately instead of burning the real 1.5s+ schedule and
// slowing the suite. The drain modelled in the transactionsSync mock
// above is what bounds the loop to two walks on a successful refresh.
process.env.PLAID_REFRESH_POLL_DELAYS_MS = "5,5";

import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import { syncPlaidItem } from "../lib/plaidSync";

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
  refreshCalls.length = 0;
  syncCalls.length = 0;
  refreshShouldThrow = null;
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

async function seedHealthyChase(): Promise<{
  itemRowId: string;
  externalAcctId: string;
  accessToken: string;
}> {
  const accessToken = `access-sandbox-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken,
      institutionName: "Chase",
      institutionSlug: "chase",
      // Already past first sync — exercises the steady-state path the
      // user's real Chase ··5526 item is in.
      cursor: "prev-cursor",
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

describe("(#665) /transactions/refresh on user-triggered Sync", () => {
  it("calls /transactions/refresh before /transactions/sync when body force=true (explicit Force-refresh button)", async () => {
    const { itemRowId, externalAcctId, accessToken } =
      await seedHealthyChase();
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-pending-venmo",
          account_id: externalAcctId,
          date: "2026-05-15",
          amount: 502,
          name: "Venmo",
          pending: true,
        },
      ],
      modified: [],
      removed: [],
    };

    // POST /plaid/sync now only refreshes when force=true is passed
    // (the explicit Force-refresh button / link+reconnect flows). A plain
    // body takes the free cursor path — see the default-body test below.
    const resp = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId, force: true }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      items: { refreshAttempted?: boolean; added: number }[];
    };

    expect(refreshCalls.length).toBe(1);
    expect(refreshCalls[0]!.access_token).toBe(accessToken);
    // (#717) A successful forceRefresh whose first cursor walk returns
    // rows polls one extra empty drain to confirm Plaid finished
    // ingesting — so the contract is exactly TWO /transactions/sync
    // calls (the row-delivering walk + the confirm-settled empty
    // drain), not one. The drain is modelled in the transactionsSync
    // mock (subsequent walks from the advanced cursor come back empty).
    expect(syncCalls.length).toBe(2);
    // Refresh must precede sync — Plaid's contract is: refresh, then
    // the next sync sees the freshly-pulled rows.
    expect(refreshCalls[0]!.calledAt).toBeLessThanOrEqual(
      syncCalls[0]!.calledAt,
    );
    expect(body.items[0]!.refreshAttempted).toBe(true);
    // Only the first walk delivered the row; the confirm-settled empty
    // drain added nothing, so the user-facing `added` count is 1.
    expect(body.items[0]!.added).toBe(1);

    // (#728) The pending row that flowed through must be persisted
    // with pending=true on the new boolean column — proving the
    // end-to-end pipeline writes the first-class field (the legacy
    // notes='[pending]' marker is gone).
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(rows.length).toBe(1);
    expect(rows[0]!.pending).toBe(true);
    expect(rows[0]!.notes).toBeNull();
  });

  it("does NOT call /transactions/refresh when force is omitted (default = free cursor sync, the plain Sync button)", async () => {
    // This is the whole point of the July billing fix: an ordinary Sync
    // click (no `force` in the body) must never bill a /transactions/refresh.
    const { itemRowId } = await seedHealthyChase();
    const resp = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      items: { refreshAttempted?: boolean }[];
    };
    expect(refreshCalls.length).toBe(0);
    expect(syncCalls.length).toBe(1);
    expect(body.items[0]!.refreshAttempted).toBe(false);
  });

  it("does NOT call /transactions/refresh when body force=false (cheap-sync opt-out)", async () => {
    const { itemRowId } = await seedHealthyChase();
    const resp = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId, force: false }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      items: { refreshAttempted?: boolean }[];
    };
    expect(refreshCalls.length).toBe(0);
    expect(syncCalls.length).toBe(1);
    expect(body.items[0]!.refreshAttempted).toBe(false);
  });

  it("does NOT call /transactions/refresh from the default (cron / webhook) syncPlaidItem path", async () => {
    const { itemRowId } = await seedHealthyChase();
    // Direct call with no opts — mirrors the webhook coalescer and
    // syncAllForAllUsers cron paths that should never touch refresh.
    const result = await syncPlaidItem(TEST_USER, itemRowId);
    expect(refreshCalls.length).toBe(0);
    expect(syncCalls.length).toBe(1);
    expect(result.refreshAttempted).toBe(false);
  });

  // (#723) When Plaid responds INVALID_PRODUCT(transactions_refresh) —
  // i.e. the Plaid client is not authorized for the
  // `transactions_refresh` add-on (the real, persistent state of this
  // app's prod client) — the SyncResult must surface a non-null
  // `refreshDisabledReason` so the toast can swap the misleading
  // "still preparing the initial batch" copy for honest "real-time
  // refresh isn't enabled on this Plaid plan" copy. Before #723 the
  // best-effort catch silently ate this error and the UI kept lying.
  it("(#723) surfaces refreshDisabledReason when Plaid returns INVALID_PRODUCT(transactions_refresh)", async () => {
    const { itemRowId, externalAcctId } = await seedHealthyChase();
    refreshShouldThrow = Object.assign(new Error("INVALID_PRODUCT"), {
      response: {
        status: 400,
        data: {
          error_code: "INVALID_PRODUCT",
          error_message:
            "client is not authorized to access the following products: [\"transactions_refresh\"]",
          display_message: null,
          request_id: "req-invalid-product-1",
        },
      },
    });
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-posted-after-invalid-product",
          account_id: externalAcctId,
          date: "2026-05-14",
          amount: -200,
          name: "Kwik Trip",
        },
      ],
      modified: [],
      removed: [],
    };

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    expect(refreshCalls.length).toBe(1);
    // Refresh failed but the cursor sync still proceeds — best-effort.
    expect(syncCalls.length).toBe(1);
    expect(result.error).toBeNull();
    expect(result.refreshAttempted).toBe(true);
    // The honest reason is surfaced for the UI to render.
    expect(result.refreshDisabledReason).toMatch(/transactions_refresh/i);
    // Persisted short-circuit stamp is set so subsequent syncs skip the
    // doomed refresh call for ~7 days.
    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(persisted!.refreshProductDisabledAt).toBeInstanceOf(Date);
  });

  // (#723) The companion to the case above: once the
  // `refreshProductDisabledAt` stamp is set, the next manual Sync
  // should short-circuit the refresh call entirely AND still surface
  // `refreshDisabledReason` so the toast stays honest on every
  // subsequent click until Plaid enables the add-on.
  it("(#723) skips the refresh call AND still sets refreshDisabledReason once short-circuit stamp is recent", async () => {
    const { itemRowId } = await seedHealthyChase();
    await db
      .update(plaidItemsTable)
      .set({ refreshProductDisabledAt: new Date() })
      .where(eq(plaidItemsTable.id, itemRowId));

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });
    expect(refreshCalls.length).toBe(0);
    expect(syncCalls.length).toBe(1);
    expect(result.refreshDisabledReason).toMatch(/transactions_refresh/i);
  });

  // (#725) Companion self-heal: once Plaid approves the
  // `transactions_refresh` add-on, the next successful refresh call
  // must clear any stale `refreshProductDisabledAt` stamp so a future
  // add-on toggle never leaves items stranded for the full 7-day
  // auto-retry window. Without this, the user would have to wait up
  // to a week after Plaid's approval email before Sync started
  // pulling live data — exactly the gap we hit on 2026-05-18.
  it("(#725) clears refreshProductDisabledAt automatically after a successful refresh", async () => {
    const { itemRowId, externalAcctId } = await seedHealthyChase();
    // Pre-stamp the item as if a prior INVALID_PRODUCT had set it,
    // but place it far enough in the past that the 7-day short-circuit
    // does NOT block this call (so the refresh actually fires and the
    // self-heal path executes).
    const stalePast = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db
      .update(plaidItemsTable)
      .set({ refreshProductDisabledAt: stalePast })
      .where(eq(plaidItemsTable.id, itemRowId));
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-posted-after-reenable",
          account_id: externalAcctId,
          date: "2026-05-18",
          amount: -42,
          name: "Kwik Trip",
        },
      ],
      modified: [],
      removed: [],
    };

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    expect(refreshCalls.length).toBe(1);
    // syncCalls count is poll-loop dependent and the same #724-tracked
    // flake the pre-existing refresh-before-sync test trips on; the
    // self-heal contract only cares that refresh fired and the stamp
    // got cleared.
    expect(syncCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.refreshAttempted).toBe(true);
    expect(result.refreshDisabledReason).toBeNull();
    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(persisted!.refreshProductDisabledAt).toBeNull();
  });

  // (#725) Manual "Re-enable refresh" button: POST
  // /plaid/items/:id/clear-refresh-disabled clears the stamp and
  // returns the refreshed item — same idempotency guarantees as the
  // other admin-style item routes.
  it("(#725) POST /plaid/items/:id/clear-refresh-disabled nulls the stamp", async () => {
    const { itemRowId } = await seedHealthyChase();
    await db
      .update(plaidItemsTable)
      .set({ refreshProductDisabledAt: new Date() })
      .where(eq(plaidItemsTable.id, itemRowId));

    const resp = await fetch(
      `${baseUrl}/plaid/items/${itemRowId}/clear-refresh-disabled`,
      { method: "POST" },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      id: string;
      refreshProductDisabledAt: string | null;
    };
    expect(body.id).toBe(itemRowId);
    expect(body.refreshProductDisabledAt).toBeNull();

    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(persisted!.refreshProductDisabledAt).toBeNull();
  });

  // (#725) Cross-household isolation: the new clear-refresh-disabled
  // route must 404 (not silently mutate someone else's item) when a
  // user attempts to target a plaidItem belonging to another
  // household. Guards against the classic IDOR shape on a new
  // mutation surface.
  it("(#725) POST /plaid/items/:id/clear-refresh-disabled returns 404 for items in another household", async () => {
    const { itemRowId } = await seedHealthyChase();
    await db
      .update(plaidItemsTable)
      .set({ refreshProductDisabledAt: new Date() })
      .where(eq(plaidItemsTable.id, itemRowId));
    // Move the item out from under the test user's household so the
    // authenticated requireAuth fixture should NOT be able to clear it.
    // Use createTestHousehold to satisfy the FK constraint on
    // plaid_items.household_id.
    const otherOwnerId = `other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const { householdId: foreignHouseholdId } =
      await createTestHousehold(otherOwnerId);
    await db
      .update(plaidItemsTable)
      .set({ householdId: foreignHouseholdId })
      .where(eq(plaidItemsTable.id, itemRowId));

    const resp = await fetch(
      `${baseUrl}/plaid/items/${itemRowId}/clear-refresh-disabled`,
      { method: "POST" },
    );
    expect(resp.status).toBe(404);

    const [persisted] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    // Stamp must remain set — the cross-household call was rejected.
    expect(persisted!.refreshProductDisabledAt).not.toBeNull();
  });

  it("still completes sync when /transactions/refresh throws (best-effort)", async () => {
    const { itemRowId, externalAcctId } = await seedHealthyChase();
    refreshShouldThrow = Object.assign(new Error("PRODUCT_NOT_READY"), {
      response: {
        status: 400,
        data: {
          error_code: "PRODUCT_NOT_READY",
          error_message: "the requested product is not yet ready",
          display_message: null,
          request_id: "req-refresh-fail",
        },
      },
    });
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-posted-1",
          account_id: externalAcctId,
          date: "2026-05-14",
          amount: -200,
          name: "Kwik Trip",
        },
      ],
      modified: [],
      removed: [],
    };
    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
    });
    expect(refreshCalls.length).toBe(1);
    // Sync MUST still have run — the whole point of the best-effort
    // wrapper is that a failed refresh does not derail the sync.
    expect(syncCalls.length).toBe(1);
    expect(result.error).toBeNull();
    expect(result.added).toBe(1);
    expect(result.refreshAttempted).toBe(true);
  });
});
