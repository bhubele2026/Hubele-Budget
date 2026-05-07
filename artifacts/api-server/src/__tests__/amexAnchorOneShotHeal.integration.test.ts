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

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
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
      itemId: `amex-item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_amex",
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  return item;
}

describe("(#416) /amex/anchor one-shot heal hook", () => {
  it("collapses a duplicate Amex plaid_accounts row on the first hit, stamps the cleanup flag, and skips the dedupe pass on subsequent hits", async () => {
    const item = await seedAmexItem();
    // Two `plaid_accounts` rows for the same physical card mask 1001 —
    // exactly the shape the dedupe routine collapses.
    const [survivor] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item.id,
        accountId: `amex-survivor-${randomUUID()}`,
        name: "Amex Gold",
        mask: "1001",
        type: "credit",
        subtype: "credit card",
      })
      .returning();
    const [loser] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item.id,
        accountId: `amex-loser-${randomUUID()}`,
        name: "Amex Gold",
        mask: "1001",
        type: "credit",
        subtype: "credit card",
      })
      .returning();

    // First hit: heal runs, the duplicate plaid_account is collapsed,
    // cleanup flag is stamped.
    const r1 = await fetch(`${baseUrl}/amex/anchor`);
    expect(r1.status).toBe(200);

    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(accts).toHaveLength(1);
    // Survivor is the row referenced by no debt (most recent created),
    // exact identity isn't critical — what matters is exactly one row
    // and its id is one of the originals.
    expect([survivor.id, loser.id]).toContain(accts[0].id);

    const [settingsAfter] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (settingsAfter?.preferences ?? {}) as Record<string, unknown>;
    expect(typeof prefs.amexCleanupDoneAt).toBe("string");
    const stampedAt = prefs.amexCleanupDoneAt as string;

    // Second hit: cleanup flag is set, heal must NOT run again. Insert
    // a fresh duplicate plaid_account and confirm it is left alone
    // (no dedupe pass), proving one-shot gating works.
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      itemId: item.id,
      accountId: `amex-post-heal-${randomUUID()}`,
      name: "Amex Gold",
      mask: "1001",
      type: "credit",
      subtype: "credit card",
    });
    const r2 = await fetch(`${baseUrl}/amex/anchor`);
    expect(r2.status).toBe(200);
    const acctsFinal = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(acctsFinal).toHaveLength(2);

    // Cleanup flag was not re-stamped on the gated second hit.
    const [settingsFinal] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefsFinal = (settingsFinal?.preferences ?? {}) as Record<
      string,
      unknown
    >;
    expect(prefsFinal.amexCleanupDoneAt).toBe(stampedAt);
  });

  it("preserves other preference keys (e.g. amexAnchor) when stamping the cleanup flag", async () => {
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      preferences: {
        amexAnchor: { balance: 1234.56, asOf: "2026-04-01T00:00:00.000Z" },
      },
    });

    const r = await fetch(`${baseUrl}/amex/anchor`);
    expect(r.status).toBe(200);

    const [row] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
    expect(typeof prefs.amexCleanupDoneAt).toBe("string");
    expect(prefs.amexAnchor).toEqual({
      balance: 1234.56,
      asOf: "2026-04-01T00:00:00.000Z",
    });
  });
});
