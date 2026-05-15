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
      }: {
        access_token: string;
      }) => {
        syncCalls.push({ access_token, calledAt: Date.now() });
        return {
          data: {
            added: nextSyncResponse.added,
            modified: nextSyncResponse.modified,
            removed: nextSyncResponse.removed,
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
  it("calls /transactions/refresh before /transactions/sync when forceRefresh=true (manual Sync button)", async () => {
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

    // Default body — POST /plaid/sync defaults to force=true.
    const resp = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      items: { refreshAttempted?: boolean; added: number }[];
    };

    expect(refreshCalls.length).toBe(1);
    expect(refreshCalls[0]!.access_token).toBe(accessToken);
    expect(syncCalls.length).toBe(1);
    // Refresh must precede sync — Plaid's contract is: refresh, then
    // the next sync sees the freshly-pulled rows.
    expect(refreshCalls[0]!.calledAt).toBeLessThanOrEqual(
      syncCalls[0]!.calledAt,
    );
    expect(body.items[0]!.refreshAttempted).toBe(true);
    expect(body.items[0]!.added).toBe(1);

    // The pending row that flowed through must be persisted with the
    // [pending] note marker — proving the end-to-end pipeline works.
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(rows.length).toBe(1);
    expect(rows[0]!.notes).toBe("[pending]");
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
