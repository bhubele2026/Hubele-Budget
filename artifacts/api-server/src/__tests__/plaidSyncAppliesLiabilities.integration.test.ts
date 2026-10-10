// ⭐ (WP2 review) THE AS-OF MUST NOT OUTRUN THE BALANCE.
//
// The pending rule cuts at the debt balance's as-of: the later of the card's
// liability fetch and the debt's last Plaid refresh. POST /plaid/sync fetched
// liabilities after every Sync and stamped `liability_last_fetched_at` — even
// for an account whose current balance Plaid did not send — but never put the
// cached balance on the linked debt (GET /debts re-applies only after an hour).
// So right after a Sync a same-day payment left "pending" while `debts.balance`
// still excluded it: Owed read high for up to an hour. Now:
//   - the post-Sync fetch applies the cached balance to the linked debts Plaid
//     owns (the same `applyLiabilityToDebt` GET /debts uses);
//   - only the step that caches a balance stamps the fetch time.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `sync-apply-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

// The transactions half of the Sync is not under test: every item "syncs" cleanly.
vi.mock("../lib/plaidSync", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaidSync")>("../lib/plaidSync");
  const ok = async (_u: string, itemRowId: string) => ({
    itemId: itemRowId, plaidItemRowId: itemRowId, institutionName: null, added: 0, modified: 0, removed: 0,
    autoCategorized: 0, ruleAttributions: [], error: null,
  });
  return { ...actual, syncPlaidItem: ok, syncPlaidItemSerialized: ok, syncAllForUser: async () => [] };
});

// Plaid's two liability reads, answered per test.
type Acct = { account_id: string; type: string; subtype: string; balances: { current: number | null } };
let accounts: Acct[] = [];
let credit: Array<{ account_id: string; aprs: Array<{ apr_type: string; apr_percentage: number }>; minimum_payment_amount: number | null }> = [];
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      accountsGet: async () => ({ data: { accounts } }),
      liabilitiesGet: async () => ({ data: { accounts, liabilities: { credit, student: [], mortgage: [] } } }),
    }),
  };
});

import { db, debtBalanceHistoryTable, debtsTable, plaidAccountsTable, plaidItemsTable } from "@workspace/db";
import plaidRouter from "../routes/plaid";
import { fetchLiabilitiesForItem } from "../lib/plaidLiabilities";
import { createTestHousehold } from "./_helpers/testHousehold";

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
  accounts = [];
  credit = [];
});

/** One card item with two card accounts. */
async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: `item-${suffix}`,
      // The token guards want a well-formed sandbox token (the suite forces PLAID_ENV=sandbox).
      accessToken: `access-sandbox-${randomUUID()}`, institutionName: "American Express", institutionSlug: "amex",
    })
    .returning();
  const mk = async (mask: string) => {
    const ext = `acct-${mask}-${suffix}`;
    const [a] = await db
      .insert(plaidAccountsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: item!.id, accountId: ext, name: `Card ${mask}`, mask, type: "credit", subtype: "credit card" })
      .returning();
    return { rowId: a!.id, ext };
  };
  return { itemRowId: item!.id, plat: await mk("1005"), blue: await mk("1001") };
}

describe("(WP2 review) POST /plaid/sync applies the balances it caches", () => {
  it("a linked debt whose balance Plaid owns takes the fresh balance and sync time; a manual-balance debt is untouched", async () => {
    const { itemRowId, plat, blue } = await seed();
    const oldSync = new Date(Date.now() - 30 * 60 * 1000);
    const [platDebt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Platinum", balance: "3842.98", apr: "0", minPayment: "85",
        plaidAccountId: plat.rowId, balanceSource: "plaid", plaidLastSyncedAt: oldSync, status: "active",
      })
      .returning();
    const [blueDebt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Blue", balance: "700.00", apr: "0.2", minPayment: "40",
        plaidAccountId: blue.rowId, balanceSource: "manual", status: "active",
      })
      .returning();
    accounts = [
      { account_id: plat.ext, type: "credit", subtype: "credit card", balances: { current: 1227.27 } },
      { account_id: blue.ext, type: "credit", subtype: "credit card", balances: { current: 650.0 } },
    ];

    const r = await fetch(`${baseUrl}/plaid/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: itemRowId }),
    });
    expect(r.status).toBe(200);

    const [p] = await db.select().from(debtsTable).where(eq(debtsTable.id, platDebt!.id));
    expect(p!.balance).toBe("1227.27");
    expect(p!.plaidLastSyncedAt!.getTime()).toBeGreaterThan(oldSync.getTime());
    const [b] = await db.select().from(debtsTable).where(eq(debtsTable.id, blueDebt!.id));
    expect(b!.balance).toBe("700.00");
    expect(b!.plaidLastSyncedAt).toBeNull();
  });
});

describe("(WP2 review) the liability fetch time is stamped only with a cached balance", () => {
  it("an account Plaid sent no current balance for keeps its previous stamp; APR and minimum still refresh", async () => {
    const { itemRowId, plat, blue } = await seed();
    const earlier = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db.update(plaidAccountsTable).set({ liabilityLastFetchedAt: earlier }).where(eq(plaidAccountsTable.id, blue.rowId));
    accounts = [
      { account_id: plat.ext, type: "credit", subtype: "credit card", balances: { current: 1227.27 } },
      { account_id: blue.ext, type: "credit", subtype: "credit card", balances: { current: null } },
    ];
    credit = [
      { account_id: plat.ext, aprs: [{ apr_type: "purchase_apr", apr_percentage: 0 }], minimum_payment_amount: 85 },
      { account_id: blue.ext, aprs: [{ apr_type: "purchase_apr", apr_percentage: 27.99 }], minimum_payment_amount: 40 },
    ];
    await fetchLiabilitiesForItem(TEST_USER, itemRowId);

    const [p] = await db.select().from(plaidAccountsTable).where(eq(plaidAccountsTable.id, plat.rowId));
    expect(p!.liabilityBalance).toBe("1227.27");
    expect(p!.liabilityLastFetchedAt).not.toBeNull();
    const [b] = await db.select().from(plaidAccountsTable).where(eq(plaidAccountsTable.id, blue.rowId));
    expect(b!.liabilityBalance).toBeNull();
    // Before: stamped "now" with no balance behind it.
    expect(b!.liabilityLastFetchedAt!.getTime()).toBe(earlier.getTime());
    expect(b!.liabilityMinPayment).toBe("40.00");
  });
});
