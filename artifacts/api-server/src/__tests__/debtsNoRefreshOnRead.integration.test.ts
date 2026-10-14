// (P3) "I don't need debt refresh, I can handle that on my own." — the owner.
//
// GET /debts used to call Plaid's liabilities endpoint and write fresh
// balances onto every linked debt more than an hour stale, on every page that
// listed debts. It never calls Plaid now and never touches a debt row; the
// household's Sync (POST /plaid/sync) is what refreshes liabilities, on
// demand. Plaid is mocked at its client, as in plaidSyncAppliesLiabilities.
// Synthetic data only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `p3-debts-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

// The transactions half of a Sync is not under test: every item "syncs" cleanly.
vi.mock("../lib/plaidSync", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaidSync")>("../lib/plaidSync");
  const ok = async (_u: string, itemRowId: string) => ({
    itemId: itemRowId, plaidItemRowId: itemRowId, institutionName: null, added: 0, modified: 0, removed: 0,
    autoCategorized: 0, ruleAttributions: [], error: null,
  });
  return { ...actual, syncPlaidItem: ok, syncPlaidItemSerialized: ok, syncAllForUser: async () => [] };
});

// Every Plaid call is counted; the liabilities answer is set per test.
const plaidCalls: string[] = [];
type Acct = { account_id: string; type: string; subtype: string; balances: { current: number | null } };
let accounts: Acct[] = [];
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  const counted = (name: string, data: () => unknown) => async () => {
    plaidCalls.push(name);
    return { data: data() };
  };
  return {
    ...actual,
    plaid: () => ({
      accountsGet: counted("accountsGet", () => ({ accounts })),
      accountsBalanceGet: counted("accountsBalanceGet", () => ({ accounts })),
      liabilitiesGet: counted("liabilitiesGet", () => ({ accounts, liabilities: { credit: [], student: [], mortgage: [] } })),
    }),
  };
});

import { db, debtBalanceHistoryTable, debtsTable, plaidAccountsTable, plaidItemsTable } from "@workspace/db";
import debtsRouter from "../routes/debts";
import plaidRouter from "../routes/plaid";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(debtsRouter);
app.use(plaidRouter);
let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db.delete(debtBalanceHistoryTable).where(eq(debtBalanceHistoryTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  await cleanup();
  plaidCalls.length = 0;
  accounts = [];
});

/** One card item, its card account caching a balance Plaid would now replace, and two STALE linked debts. */
async function seedStale() {
  const suffix = randomUUID().slice(0, 8);
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: `item-${suffix}`,
      accessToken: `access-sandbox-${randomUUID()}`, institutionName: "Test Card Co", institutionSlug: "testcard",
    })
    .returning();
  const card = async (mask: string) => {
    const ext = `acct-card-${mask}-${suffix}`;
    const [a] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: item!.id, accountId: ext, name: `Card ${mask}`, mask,
        type: "credit", subtype: "credit card", liabilityBalance: "900.00",
      })
      .returning();
    return { rowId: a!.id, ext };
  };
  const [a1, a2] = [await card("4242"), await card("5151")];
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const [owned] = await db
    .insert(debtsTable)
    .values({
      userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Card (Plaid balance)", balance: "1500.00", apr: "0.2",
      minPayment: "40", plaidAccountId: a1.rowId, balanceSource: "plaid", aprSource: "plaid", minPaymentSource: "plaid",
      plaidLastSyncedAt: threeHoursAgo, status: "active", originalBalance: "2000.00",
    })
    .returning();
  // Never synced at all: the old rule's other "stale" case.
  const [never] = await db
    .insert(debtsTable)
    .values({
      userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Card (never synced)", balance: "300.00", apr: "0.1",
      minPayment: "25", plaidAccountId: a2.rowId, balanceSource: "plaid", status: "active", originalBalance: "300.00",
    })
    .returning();
  // What Plaid would answer if anyone asked.
  accounts = [
    { account_id: a1.ext, type: "credit", subtype: "credit card", balances: { current: 1234.56 } },
    { account_id: a2.ext, type: "credit", subtype: "credit card", balances: { current: 345.67 } },
  ];
  return { itemRowId: item!.id, owned: owned!, never: never! };
}

const debtRow = async (id: string) => (await db.select().from(debtsTable).where(eq(debtsTable.id, id)))[0]!;

describe("(P3) GET /debts never refreshes from Plaid", () => {
  it("⭐ stale linked debts: no Plaid call, no debt row written, the stored balances served", async () => {
    const { owned, never } = await seedStale();
    const before = [await debtRow(owned.id), await debtRow(never.id)];

    const r = await fetch(`${baseUrl}/debts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Array<{ id: string; balance: string; plaidLastSyncedAt: string | null }>;

    expect(plaidCalls).toEqual([]);
    const after = [await debtRow(owned.id), await debtRow(never.id)];
    // The whole row: balance, APR, minimum, sync stamp, updatedAt — nothing moved.
    expect(after).toEqual(before);
    const served = new Map(body.map((d) => [d.id, d]));
    expect(served.get(owned.id)!.balance).toBe("1500.00");
    expect(served.get(owned.id)!.plaidLastSyncedAt).toBe(before[0]!.plaidLastSyncedAt!.toISOString());
    expect(served.get(never.id)!.balance).toBe("300.00");
    expect(served.get(never.id)!.plaidLastSyncedAt).toBeNull();
  });

  it("a second read is the same: still nothing asked, nothing written", async () => {
    const { owned } = await seedStale();
    const before = await debtRow(owned.id);
    await fetch(`${baseUrl}/debts`);
    await fetch(`${baseUrl}/debts`);
    expect(plaidCalls).toEqual([]);
    expect(await debtRow(owned.id)).toEqual(before);
  });
});

describe("(P3) the household's Sync is what refreshes them, on demand", () => {
  it("POST /plaid/sync asks Plaid for liabilities and puts the fresh balance on the debts Plaid owns", async () => {
    const { itemRowId, owned, never } = await seedStale();
    const staleStamp = (await debtRow(owned.id)).plaidLastSyncedAt!;

    const r = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(r.status).toBe(200);
    expect(plaidCalls).toContain("liabilitiesGet");

    const o = await debtRow(owned.id);
    expect(o.balance).toBe("1234.56");
    expect(o.plaidLastSyncedAt!.getTime()).toBeGreaterThan(staleStamp.getTime());
    const n = await debtRow(never.id);
    expect(n.balance).toBe("345.67");
    expect(n.plaidLastSyncedAt).not.toBeNull();

    // And GET /debts serves what the Sync wrote, still without asking Plaid itself.
    plaidCalls.length = 0;
    const body = (await (await fetch(`${baseUrl}/debts`)).json()) as Array<{ id: string; balance: string }>;
    expect(plaidCalls).toEqual([]);
    expect(body.find((d) => d.id === owned.id)!.balance).toBe("1234.56");
  });
});
