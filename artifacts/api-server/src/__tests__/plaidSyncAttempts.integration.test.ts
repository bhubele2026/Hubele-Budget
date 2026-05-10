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
import { eq, sql } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `sync-attempts-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

type TxnsSyncFn = (args: {
  access_token: string;
  cursor?: string;
  count?: number;
}) => Promise<unknown>;

let transactionsSyncMock: TxnsSyncFn = async () => ({
  data: { added: [], modified: [], removed: [], next_cursor: "", has_more: false },
});

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: (args: Parameters<TxnsSyncFn>[0]) =>
        transactionsSyncMock(args),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "item-default", consent_expiration_time: null } },
      }),
    }),
  };
});

import {
  db,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  transactionsTable,
  plaidAccountsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import { syncPlaidItem } from "../lib/plaidSync";
import {
  prunePlaidSyncAttempts,
  PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM,
} from "../lib/plaidSyncAttempts";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
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
    .delete(plaidSyncAttemptsTable)
    .where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
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
  transactionsSyncMock = async () => ({
    data: { added: [], modified: [], removed: [], next_cursor: "", has_more: false },
  });
});

async function seedItem(): Promise<{ itemRowId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  return { itemRowId: item!.id };
}

describe("(#279) plaid sync attempt audit log", () => {
  it("records a successful 'transactions' attempt on each healthy syncPlaidItem call", async () => {
    const { itemRowId } = await seedItem();
    await syncPlaidItem(TEST_USER, itemRowId);
    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await db
      .select()
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.kind).toBe("transactions");
      expect(r.success).toBe(true);
      expect(r.errorCode).toBeNull();
      expect(r.errorMessage).toBeNull();
    }
  });

  it("records a failed attempt with Plaid's structured error_code/message when /transactions/sync fails", async () => {
    const { itemRowId } = await seedItem();
    transactionsSyncMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            error_code: "ITEM_LOGIN_REQUIRED",
            error_message: "the login details of this item have changed",
            error_type: "ITEM_ERROR",
          },
        },
      };
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const [row] = await db
      .select()
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    expect(row?.success).toBe(false);
    expect(row?.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(row?.errorMessage).toMatch(/login details of this item have changed/);
  });

  it("GET /plaid/items/:id/sync-attempts returns history newest-first, capped at the server limit", async () => {
    const { itemRowId } = await seedItem();
    // Seed 25 attempts at known monotonic timestamps so the order assertion
    // is stable regardless of how fast the inserts complete.
    const base = Date.now() - 25_000;
    const rows = Array.from({ length: 25 }, (_, i) => ({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      plaidItemId: itemRowId,
      kind: "transactions",
      success: i % 3 !== 0,
      errorCode: i % 3 === 0 ? "ITEM_LOGIN_REQUIRED" : null,
      errorMessage: i % 3 === 0 ? "fake failure" : null,
      attemptedAt: new Date(base + i * 1000),
    }));
    await db.insert(plaidSyncAttemptsTable).values(rows);

    const res = await fetch(`${baseUrl}/plaid/items/${itemRowId}/sync-attempts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attempts: Array<{ attemptedAt: string; kind: string; success: boolean }>;
    };
    expect(body.attempts).toHaveLength(20);
    // Newest first.
    for (let i = 1; i < body.attempts.length; i++) {
      expect(
        new Date(body.attempts[i - 1].attemptedAt).getTime(),
      ).toBeGreaterThanOrEqual(
        new Date(body.attempts[i].attemptedAt).getTime(),
      );
    }
  });

  it("GET /plaid/items/:id/sync-attempts returns 404 for an item that doesn't belong to the caller", async () => {
    const res = await fetch(
      `${baseUrl}/plaid/items/${randomUUID()}/sync-attempts`,
    );
    expect(res.status).toBe(404);
  });

  it("prunePlaidSyncAttempts trims each item to PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM newest rows", async () => {
    const { itemRowId } = await seedItem();
    const total = PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM + 15;
    const base = Date.now() - total * 1000;
    await db.insert(plaidSyncAttemptsTable).values(
      Array.from({ length: total }, (_, i) => ({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        plaidItemId: itemRowId,
        kind: "transactions",
        success: true,
        attemptedAt: new Date(base + i * 1000),
      })),
    );

    const deleted = await prunePlaidSyncAttempts();
    expect(deleted).toBeGreaterThanOrEqual(15);

    const remaining = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    expect(remaining[0].count).toBe(PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM);
  });
});
