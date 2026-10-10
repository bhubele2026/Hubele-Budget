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

const TEST_USER = `amex-oneshot-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import amexRouter from "../routes/amex";
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
app.use(amexRouter);

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
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
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

beforeEach(cleanup);

async function seedAmexItem() {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `amex-item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_amex",
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  return item;
}

// (WP9) The owner's decision (2026-10-10): duplicate accounts are merged ONLY
// when a bank sync runs, never on a page read. /amex/anchor used to collapse
// twin Amex rows on its first hit (#416, gated by `amexCleanupDoneAt`); it is
// now read-only for account rows and writes no preference. The sync-path merge
// is pinned in plaidAccountTwinsOnSync.integration.test.ts.
describe("(WP9) /amex/anchor is read-only for account rows", () => {
  it("leaves a duplicate Amex plaid_accounts row in place, hit after hit, and stamps nothing", async () => {
    const item = await seedAmexItem();
    // Two `plaid_accounts` rows for the same physical card mask 1001 —
    // exactly the shape the sync-time merge collapses.
    const twins = await db
      .insert(plaidAccountsTable)
      .values(
        ["survivor", "loser"].map((k) => ({
          userId: TEST_USER,
          householdId: TEST_HOUSEHOLD_ID,
          itemId: item.id,
          accountId: `amex-${k}-${randomUUID()}`,
          name: "Amex Gold",
          mask: "1001",
          type: "credit",
          subtype: "credit card",
        })),
      )
      .returning();

    for (let i = 0; i < 2; i += 1) {
      const r = await fetch(`${baseUrl}/amex/anchor`);
      expect(r.status).toBe(200);
      const accts = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, TEST_USER));
      expect(accts.map((a) => a.id).sort()).toEqual(twins.map((t) => t.id).sort());
    }

    const [settingsAfter] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (settingsAfter?.preferences ?? {}) as Record<string, unknown>;
    expect(prefs.amexCleanupDoneAt).toBeUndefined();
  });

  it("writes no preference (other keys such as amexAnchor are left exactly as they were)", async () => {
    const before = { amexAnchor: { balance: 1234.56, asOf: "2026-04-01T00:00:00.000Z" } };
    await db.insert(settingsTable).values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, preferences: before });

    const r = await fetch(`${baseUrl}/amex/anchor`);
    expect(r.status).toBe(200);

    const [row] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(row?.preferences).toEqual(before);
  });
});
