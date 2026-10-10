// (WP9) Twin accounts are merged ONLY when a bank sync runs — never on a page
// read (owner's decision, 2026-10-10).
//
// The harness's `dupmask` shape: Chase Total Checking ••5526 (the bank-snapshot
// account), its true twin ••5526 on a re-linked Chase item (same name: one
// physical account), and Capital One 360 Checking ••5526 (another bank: never
// merged). Before this package, opening the Amex page (or the first /forecast
// or Chase-list read) merged the twin and 18 figures moved
// ($4,812.37 → $4,752.37): a figure depended on which page was opened first.
//
// Pinned here:
//   1. every GET the pages make is read-only: plaid_accounts, every row's
//      account, the snapshot pointer and every balance read the same after;
//   2. a sync merges the twin (its row moves to the account that stays; Capital
//      One untouched), counts it in the result (`accountsMerged`) and writes one
//      `account_merge` sync-log row; the bank balance then includes the twin's
//      row — on the sync, never on a read;
//   3. a second sync merges nothing and logs nothing.
//
// (WP9b) Also pinned:
//   4. GET /forecast changes no transaction rows: it no longer runs the
//      per-account or cross-account transaction dedupe once per process (a
//      read that wrote). Both passes run during a sync; the cross-account half
//      is seen here collapsing the twin left on a removed account;
//   5. a balance snapshot moves only with a merge: the twin's reading moves
//      onto the account that stays and the account_merge line names it; a
//      removed account's reading is dropped, never moved onto a live account
//      by name or by last four (Capital One 360 ••5526 never gets Chase's).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, asc, eq } from "drizzle-orm";

const TEST_USER = `twins-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID = "";

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

// Plaid is mocked: the sync sees an empty delta, and nothing reaches Plaid.
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: { added: [], modified: [], removed: [], next_cursor: "cursor-twins", has_more: false },
      }),
      transactionsGet: async () => ({ data: { transactions: [], total_transactions: 0 } }),
      transactionsRefresh: async () => ({ data: {} }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({ data: { item: { item_id: "item-twins", consent_expiration_time: null } } }),
      itemWebhookUpdate: async () => ({ data: {} }),
    }),
  };
});

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  transactionsTable,
} from "@workspace/db";
import spineRouter from "../routes/spine";
import forecastRouter from "../routes/forecast";
import bankBalanceExplainRouter from "../routes/bankBalanceExplain";
import plaidRouter from "../routes/plaid";
import amexRouter from "../routes/amex";
import transactionsRouter from "../routes/transactions";
import transactionsLedgerRouter from "../routes/transactionsLedger";
import dashboardRouter from "../routes/dashboard";
import { syncPlaidItem, _resetPlaidSyncChainForTests } from "../lib/plaidSync";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
for (const r of [
  spineRouter,
  forecastRouter,
  bankBalanceExplainRouter,
  plaidRouter,
  amexRouter,
  transactionsRouter,
  transactionsLedgerRouter,
  dashboardRouter,
]) {
  app.use(r);
}

let server: Server;
let baseUrl = "";

const ids = { chase: "", relink: "", capone: "", chk: "", twin: "", cap360: "" };
const ext = {
  chk: `acct-chk-${randomUUID()}`,
  twin: `acct-twin-${randomUUID()}`,
  cap360: `acct-cap-${randomUUID()}`,
  // (WP9b) An account whose plaid_accounts row is gone (a reconnect removed it).
  gone: `acct-gone-${randomUUID()}`,
};

// (WP9b) Balance snapshots (forecast_settings.account_snapshots), keyed by
// plaid_accounts.id. DEAD ids name accounts whose rows no longer exist.
const DEAD = { a: randomUUID(), b: randomUUID() };
const reading = (balance: string, hoursAgo: number, name: string) => ({
  balance,
  at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  source: "plaid" as const,
  name,
  mask: "5526",
});
const READINGS = {
  chk: reading("4790.00", 120, "Chase Total Checking"),
  twin: reading("4812.37", 48, "Chase Total Checking"),
  // A removed account's reading with the main account's name and last four, newest of all.
  deadA: reading("999.99", 1, "Chase Total Checking"),
  // Added before the second sync: a removed account's reading that matches live accounts by last four only.
  deadB: reading("777.77", 0.5, "Everyday Checking"),
};

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidSyncAttemptsTable).where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

async function item(name: string, slug: string): Promise<string> {
  const [row] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${slug}-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: name,
      institutionSlug: slug,
      cursor: "cursor-0",
    })
    .returning({ id: plaidItemsTable.id });
  return row!.id;
}

async function account(itemId: string, accountId: string, name: string, createdAt: Date): Promise<string> {
  const [row] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId,
      accountId,
      name,
      mask: "5526",
      type: "depository",
      subtype: "checking",
      firstSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
      createdAt,
    })
    .returning({ id: plaidAccountsTable.id });
  return row!.id;
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  ids.chase = await item("Chase", "chase");
  ids.relink = await item("Chase", "chase");
  ids.capone = await item("Capital One", "capital-one");
  ids.chk = await account(ids.chase, ext.chk, "Chase Total Checking", new Date(Date.now() - 86_400_000 * 30));
  ids.twin = await account(ids.relink, ext.twin, "Chase Total Checking", new Date(Date.now() - 86_400_000 * 2));
  ids.cap360 = await account(ids.capone, ext.cap360, "360 Checking", new Date(Date.now() - 86_400_000 * 10));
  // The bank snapshot sits on the main Chase account, two days ago.
  const snapAt = new Date(Date.now() - 2 * 86_400_000);
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "4812.37",
    bankSnapshotAt: snapAt,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: ids.chk,
    bankSnapshotName: "Chase Total Checking",
    bankSnapshotMask: "5526",
    autoDedupeRanAt: null,
    accountSnapshots: { [ids.chk]: READINGS.chk, [ids.twin]: READINGS.twin, [DEAD.a]: READINGS.deadA },
  });
  const today = new Date().toISOString().slice(0, 10);
  const row = (accountId: string, description: string, amount: string) => ({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    occurredOn: today,
    description,
    amount,
    source: accountId === ext.cap360 || accountId === ext.gone ? "plaid:capital-one" : "plaid:chase",
    plaidAccountId: accountId,
    plaidTransactionId: `ptx-${randomUUID()}`,
    createdAt: new Date(),
  });
  await db.insert(transactionsTable).values([
    // The twin's ATM withdrawal, after the snapshot: real money out of the one account.
    row(ext.twin, "CHASE ATM WITHDRAWAL 1140", "-60.00"),
    row(ext.cap360, "MEIJER #212", "-64.12"),
    row(ext.cap360, "ZELLE FROM M LEE", "120.00"),
    // (WP9b) The per-account pass's shape (one posting twice on one account)
    // and the cross-account pass's (a twin left on the removed account): the
    // first-read heal deleted one of each.
    row(ext.cap360, "NETFLIX.COM", "-15.49"),
    row(ext.cap360, "NETFLIX.COM", "-15.49"),
    row(ext.cap360, "SPOTIFY USA", "-11.99"),
    row(ext.gone, "SPOTIFY USA", "-11.99"),
  ]);
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

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`);
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, json };
}

/** Everything a merge would change, read from the database. */
async function accountState() {
  const accounts = await db
    .select({ id: plaidAccountsTable.id, accountId: plaidAccountsTable.accountId, itemId: plaidAccountsTable.itemId })
    .from(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER))
    .orderBy(asc(plaidAccountsTable.id));
  const rows = await db
    .select({ id: transactionsTable.id, plaidAccountId: transactionsTable.plaidAccountId, amount: transactionsTable.amount })
    .from(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER))
    .orderBy(asc(transactionsTable.id));
  const [settings] = await db
    .select({
      pointer: forecastSettingsTable.bankSnapshotAccountId,
      snapshots: forecastSettingsTable.accountSnapshots,
      balance: forecastSettingsTable.bankSnapshotBalance,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  return { accounts, rows, settings };
}

async function bankToday(): Promise<string | null> {
  const spine = (await get("/spine")).json as { bank: { balance: string | null } };
  return spine.bank.balance;
}

/** Every transaction row of the user, every column. */
async function allRows() {
  return db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER))
    .orderBy(asc(transactionsTable.id));
}

type ItemsJson = Array<{ accounts: Array<{ id: string; snapshot?: { balance: string } | null }> }>;

const MERGE_ROWS = async () =>
  db
    .select()
    .from(plaidSyncAttemptsTable)
    .where(and(eq(plaidSyncAttemptsTable.userId, TEST_USER), eq(plaidSyncAttemptsTable.kind, "account_merge")));

describe("(WP9) twin accounts: merged on a sync, never on a page read", () => {
  // First GET /forecast of the process for this user: the old once-per-process
  // heal would have deleted a NETFLIX and a SPOTIFY row here.
  it("(WP9b) GET /forecast changes no transaction rows", async () => {
    const before = await allRows();
    expect(before.filter((r) => r.description === "NETFLIX.COM")).toHaveLength(2);
    expect(before.filter((r) => r.description === "SPOTIFY USA")).toHaveLength(2);
    for (let i = 0; i < 2; i += 1) {
      expect((await get("/forecast")).status).toBe(200);
    }
    expect(await allRows()).toEqual(before);
  });

  it("every GET the pages make is read-only: no account row, row's account, pointer or balance moves", async () => {
    const before = await accountState();
    const balanceBefore = await bankToday();
    expect(before.accounts).toHaveLength(3);

    // The reads the pages make (twice over: a gate that fires on a second read counts too).
    const paths = [
      "/forecast",
      "/forecast/cash-signal?horizonDays=90",
      "/forecast/bank-balance-explain",
      "/spine",
      "/plaid/items",
      "/plaid/liability-accounts",
      "/amex/anchor",
      "/amex/weekly-payoff",
      "/transactions?limit=50",
      "/transactions/ledger?limit=50",
      `/transactions/balances?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`,
      "/dashboard",
    ];
    for (let pass = 0; pass < 2; pass += 1) {
      for (const p of paths) {
        const r = await get(p);
        expect(r.status, p).toBeLessThan(500);
      }
    }

    expect(await accountState()).toEqual(before);
    expect(await bankToday()).toBe(balanceBefore);
    expect(await MERGE_ROWS()).toEqual([]);
  });

  it("a sync merges the twin, leaves the other bank alone, counts and logs it; the balance moves on the sync", async () => {
    _resetPlaidSyncChainForTests();
    const balanceBefore = Number(await bankToday());
    const result = await syncPlaidItem(TEST_USER, ids.relink);

    expect(result.accountsMerged).toBe(1);
    const after = await accountState();
    // One Chase Total Checking ••5526 stays (the snapshot's); Capital One's ••5526 is untouched.
    expect(after.accounts.map((a) => a.id).sort()).toEqual([ids.chk, ids.cap360].sort());
    expect(after.settings!.pointer).toBe(ids.chk);
    // The twin's ATM row now sits on the account that stays; Capital One's rows did not move.
    const accountsOf = new Map(after.rows.map((r) => [r.amount, r.plaidAccountId]));
    expect(accountsOf.get("-60.00")).toBe(ext.chk);
    expect(accountsOf.get("-64.12")).toBe(ext.cap360);
    expect(accountsOf.get("120.00")).toBe(ext.cap360);

    const logged = await MERGE_ROWS();
    expect(logged).toHaveLength(1);
    // (WP9b) The line names the balance snapshot that moved with the merge.
    expect(logged[0]).toMatchObject({
      plaidItemId: ids.relink,
      success: true,
      errorMessage: "Merged 1 duplicate account; 1 transaction and 1 balance snapshot moved to the account that stays.",
    });
    // (WP9b) The twin's (newer) reading now sits on the account that stays —
    // moved by the merge. The removed account's reading (same name, same last
    // four) was dropped, not moved: nothing shows 999.99.
    expect(after.settings!.snapshots).toEqual({ [ids.chk]: READINGS.twin });

    // (WP9b) The sync's cross-account pass collapsed the SPOTIFY twin left on
    // the removed account (the reads left it alone); the row stays on 360.
    const spotify = after.rows.filter((r) => r.amount === "-11.99");
    expect(spotify.map((r) => r.plaidAccountId)).toEqual([ext.cap360]);

    // The merge is what moves the figure — on the sync: the twin's −$60 now counts.
    expect(Number(await bankToday())).toBeCloseTo(balanceBefore - 60, 2);
  });

  it("a second sync merges nothing, logs nothing, and moves no snapshot by its last four", async () => {
    // (WP9b) A removed account's reading that matches both live ••5526 accounts
    // (Chase, Capital One 360) by last four only, and is newer than either.
    await db
      .update(forecastSettingsTable)
      .set({ accountSnapshots: { [ids.chk]: READINGS.twin, [DEAD.b]: READINGS.deadB } })
      .where(eq(forecastSettingsTable.userId, TEST_USER));

    const result = await syncPlaidItem(TEST_USER, ids.chase);
    expect(result.accountsMerged).toBe(0);
    expect(await MERGE_ROWS()).toHaveLength(1);

    // Dropped (its account is gone), never moved: Chase keeps its own reading
    // and Capital One 360 still has none.
    expect((await accountState()).settings!.snapshots).toEqual({ [ids.chk]: READINGS.twin });
    const accounts = ((await get("/plaid/items")).json as ItemsJson).flatMap((i) => i.accounts);
    expect(accounts.find((a) => a.id === ids.cap360)?.snapshot ?? null).toBeNull();
  });
});
