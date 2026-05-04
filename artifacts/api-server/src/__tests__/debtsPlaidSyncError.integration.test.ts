import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

import {
  db,
  debtsTable,
  debtBalanceHistoryTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import debtsRouter from "../routes/debts";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(debtsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(debtBalanceHistoryTable)
    .where(eq(debtBalanceHistoryTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
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

beforeEach(cleanup);

async function seedItem(opts: { lastSyncError: string | null }): Promise<{ accountRowId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "TestBank",
      institutionSlug: "testbank",
      lastSyncedAt: new Date("2026-05-01T10:00:00Z"),
      lastSyncError: opts.lastSyncError,
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      itemId: item!.id,
      accountId: `acct-${randomUUID()}`,
      name: "Visa Card",
      mask: "1234",
      type: "credit",
      subtype: "credit card",
    })
    .returning();
  return { accountRowId: acct!.id };
}

type DebtResponse = {
  id: string;
  plaidAccountId: string | null;
  plaidLastSyncedAt: string | null;
  plaidLastSyncError: string | null;
};

describe("(#43) GET /debts surfaces parent Plaid item lastSyncError", () => {
  it("returns plaidLastSyncError null when sync is healthy", async () => {
    const { accountRowId } = await seedItem({ lastSyncError: null });
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      name: "Healthy Card",
      balance: "1000",
      apr: "0.2",
      minPayment: "25",
      plaidAccountId: accountRowId,
      plaidLastSyncedAt: new Date("2026-05-01T10:00:00Z"),
    });

    const res = await fetch(`${baseUrl}/debts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DebtResponse[];
    expect(body).toHaveLength(1);
    expect(body[0].plaidLastSyncError).toBeNull();
    expect(body[0].plaidLastSyncedAt).toBe("2026-05-01T10:00:00.000Z");
  });

  it("surfaces ITEM_LOGIN_REQUIRED to plaidLastSyncError when item sync failed", async () => {
    const { accountRowId } = await seedItem({
      lastSyncError: "ITEM_LOGIN_REQUIRED: the user needs to re-authenticate",
    });
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      name: "Failing Card",
      balance: "1500",
      apr: "0.25",
      minPayment: "30",
      plaidAccountId: accountRowId,
      plaidLastSyncedAt: new Date("2026-04-15T10:00:00Z"),
    });

    const res = await fetch(`${baseUrl}/debts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DebtResponse[];
    expect(body).toHaveLength(1);
    expect(body[0].plaidLastSyncError).toBe(
      "ITEM_LOGIN_REQUIRED: the user needs to re-authenticate",
    );
    // The "last healthy" timestamp must still be present so the UI can show
    // when sync was last working.
    expect(body[0].plaidLastSyncedAt).toBe("2026-04-15T10:00:00.000Z");
  });

  it("returns plaidLastSyncError null for manual (non-Plaid) debts", async () => {
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      name: "Manual Card",
      balance: "500",
      apr: "0.18",
      minPayment: "15",
    });

    const res = await fetch(`${baseUrl}/debts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DebtResponse[];
    expect(body).toHaveLength(1);
    expect(body[0].plaidAccountId).toBeNull();
    expect(body[0].plaidLastSyncError).toBeNull();
  });
});
