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

const TEST_USER = `reset-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `reset-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

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

const syncCalls: Array<{ userId: string; itemRowId: string }> = [];
vi.mock("../lib/plaidSync", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaidSync")>(
    "../lib/plaidSync",
  );
  return {
    ...actual,
    syncPlaidItem: async (userId: string, itemRowId: string) => {
      syncCalls.push({ userId, itemRowId });
      return { itemRowId, added: 0, modified: 0, removed: 0 };
    },
  };
});

import { db, plaidItemsTable } from "@workspace/db";
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
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, OTHER_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  OTHER_HOUSEHOLD_ID = (await createTestHousehold(OTHER_USER)).householdId;
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
  syncCalls.length = 0;
});

async function seedItem(opts: {
  userId?: string;
  itemId?: string;
  accessToken?: string;
  cursor?: string | null;
  lastSyncError?: string | null;
  lastSyncErrorCode?: string | null;
}): Promise<{ itemRowId: string }> {
  const userId = opts.userId ?? TEST_USER;
  const householdId =
    userId === TEST_USER ? TEST_HOUSEHOLD_ID : OTHER_HOUSEHOLD_ID;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId,
      householdId,
      itemId: opts.itemId ?? `item-${randomUUID()}`,
      accessToken: opts.accessToken ?? `access-production-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
      cursor: opts.cursor ?? "OLD_CURSOR_VALUE_xyz",
      lastSyncError: opts.lastSyncError ?? null,
      lastSyncErrorCode: opts.lastSyncErrorCode ?? null,
    })
    .returning();
  return { itemRowId: item!.id };
}

describe("(#651) POST /plaid/items/:itemId/reset-cursor", () => {
  it("clears cursor + stale error fields and triggers a fresh sync", async () => {
    const { itemRowId } = await seedItem({
      lastSyncError: "stale error",
      lastSyncErrorCode: "STALE",
    });

    const resp = await fetch(
      `${baseUrl}/plaid/items/${itemRowId}/reset-cursor`,
      { method: "POST" },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; item: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.item.id).toBe(itemRowId);

    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.cursor).toBeNull();
    expect(row?.lastSyncError).toBeNull();
    expect(row?.lastSyncErrorCode).toBeNull();

    expect(syncCalls).toEqual([{ userId: TEST_USER, itemRowId }]);
  });

  it("returns 404 when the item belongs to another household", async () => {
    const { itemRowId } = await seedItem({ userId: OTHER_USER });

    const resp = await fetch(
      `${baseUrl}/plaid/items/${itemRowId}/reset-cursor`,
      { method: "POST" },
    );
    expect(resp.status).toBe(404);

    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.cursor).toBe("OLD_CURSOR_VALUE_xyz");
    expect(syncCalls).toEqual([]);
  });

  it("rejects synthetic seed items", async () => {
    const { itemRowId } = await seedItem({
      itemId: `seed-april-2026-chase-${randomUUID()}`,
      accessToken: "access-sandbox-seed-april-chase",
    });

    const resp = await fetch(
      `${baseUrl}/plaid/items/${itemRowId}/reset-cursor`,
      { method: "POST" },
    );
    expect(resp.status).toBe(400);

    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.cursor).toBe("OLD_CURSOR_VALUE_xyz");
    expect(syncCalls).toEqual([]);
  });

  it("rejects items with malformed access tokens (409 → relink)", async () => {
    const { itemRowId } = await seedItem({ accessToken: "not-a-real-token" });

    const resp = await fetch(
      `${baseUrl}/plaid/items/${itemRowId}/reset-cursor`,
      { method: "POST" },
    );
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { code?: string; action?: string };
    expect(body.code).toBe("ITEM_LOGIN_REQUIRED");
    expect(body.action).toBe("relink");

    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.cursor).toBe("OLD_CURSOR_VALUE_xyz");
    expect(syncCalls).toEqual([]);
  });

  it("returns 404 for an unknown item id", async () => {
    const resp = await fetch(
      `${baseUrl}/plaid/items/${randomUUID()}/reset-cursor`,
      { method: "POST" },
    );
    expect(resp.status).toBe(404);
    expect(syncCalls).toEqual([]);
  });
});
