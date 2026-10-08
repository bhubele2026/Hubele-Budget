// ⭐ V3 — automatic bank updates for banks that are already linked.
//
// A bank linked before PLAID_WEBHOOK_URL was set never told H2 anything. These
// cases pin the one new Plaid call (`/item/webhook/update`, free), that it is
// skipped or made exactly when it should be, that a refusal never breaks a
// sync, that a signed webhook still ends in txn.arrived -> categorize + monitor,
// and that the mocked client NEVER saw `/transactions/refresh` from this code.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Router } from "express";

const TEST_USER = `v3-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

const URL_A = "https://h2budget.example.test/api/plaid/webhook";
const URL_B = "https://other.example.test/api/plaid/webhook";

const webhookUpdateCalls: Array<{ access_token: string; webhook: string }> = [];
const refreshCalls: unknown[] = [];
let webhookUpdateMock: (a: { access_token: string; webhook: string }) => Promise<unknown> = async () => ({ data: {} });
let addedTxns: Array<Record<string, unknown>> = [];

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      itemWebhookUpdate: (a: { access_token: string; webhook: string }) => {
        webhookUpdateCalls.push(a);
        return webhookUpdateMock(a);
      },
      // The billable pull. If any code under test reaches it, the call is
      // recorded AND throws, so both the count and the failure show it.
      transactionsRefresh: (a: unknown) => {
        refreshCalls.push(a);
        throw new Error("transactionsRefresh must never be called from this path");
      },
      transactionsSync: async () => ({
        data: { added: addedTxns, modified: [], removed: [], next_cursor: "c1", has_more: false },
      }),
      itemGet: async () => ({ data: { item: { item_id: "x", consent_expiration_time: null } } }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
    }),
  };
});

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { ensureAllItemWebhooks, ensureItemWebhook, WEBHOOK_RECHECK_MS } from "../lib/plaidWebhookEnsure";
import { syncPlaidItem } from "../lib/plaidSync";
import { _flushPlaidSyncSchedulerForTests, _resetPlaidSyncSchedulerForTests } from "../lib/plaidSyncScheduler";
import { _emittedForTests } from "../jobs/emit";
import { handleTxnArrived } from "../jobs/handlers/txnArrived";
import { computeBankFreshness } from "../lib/bankFreshness";
import { recapFacts } from "../recap/facts";
import { renderRecapTemplate } from "../recap/template";

process.env.PLAID_WEBHOOK_VERIFICATION_DISABLED = "true";
process.env.PLAID_SYNC_DEBOUNCE_MS = "60000";
process.env.PLAID_AUTO_SYNC_ENABLED = "true";

const wrapped = Router();
wrapped.use((req, _res, next) => {
  (req as unknown as { log: object }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
wrapped.use(plaidRouter);
const { request } = createTestApp(wrapped);
const NOW = new Date("2026-10-08T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const extraUsers: string[] = [];
const savedUrl = process.env.PLAID_WEBHOOK_URL;

async function cleanup(): Promise<void> {
  const users = [TEST_USER, ...extraUsers];
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, users));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, users));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, users));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, users));
}

async function seedItem(over: Partial<typeof plaidItemsTable.$inferInsert> = {}) {
  const accessToken = `access-sandbox-${randomUUID()}`;
  const externalItemId = `item-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: externalItemId,
      accessToken,
      institutionName: "Sample Bank",
      institutionSlug: "chase",
      ...over,
    })
    .returning();
  return { row: item!, accessToken, externalItemId };
}
const reread = async (id: string) => (await db.select().from(plaidItemsTable).where(eq(plaidItemsTable.id, id)))[0]!;

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
});
afterAll(async () => {
  await cleanup();
  _resetPlaidSyncSchedulerForTests();
  if (savedUrl === undefined) delete process.env.PLAID_WEBHOOK_URL;
  else process.env.PLAID_WEBHOOK_URL = savedUrl;
});
beforeEach(async () => {
  await cleanup();
  _resetPlaidSyncSchedulerForTests();
  webhookUpdateCalls.length = 0;
  refreshCalls.length = 0;
  _emittedForTests.length = 0;
  addedTxns = [];
  webhookUpdateMock = async () => ({ data: {} });
  process.env.PLAID_WEBHOOK_URL = URL_A;
});

describe("ensureItemWebhook", () => {
  it("no URL on the server: no Plaid call, state no_url", async () => {
    delete process.env.PLAID_WEBHOOK_URL;
    const { row } = await seedItem();
    expect(await ensureItemWebhook(row, { now: NOW })).toEqual({ state: "no_url" });
    expect(webhookUpdateCalls).toEqual([]);
    expect((await reread(row.id)).webhookCheckedAt).toBeNull();
  });

  it("same URL checked within 7 days: no Plaid call", async () => {
    const { row } = await seedItem({ webhookUrl: URL_A, webhookCheckedAt: new Date(NOW.getTime() - 6 * DAY) });
    expect(await ensureItemWebhook(row, { now: NOW })).toEqual({ state: "ok" });
    expect(webhookUpdateCalls).toEqual([]);
  });

  it("same URL but checked more than 7 days ago: one call again", async () => {
    const { row, accessToken } = await seedItem({
      webhookUrl: URL_A,
      webhookCheckedAt: new Date(NOW.getTime() - WEBHOOK_RECHECK_MS - 1000),
    });
    expect((await ensureItemWebhook(row, { now: NOW })).state).toBe("registered");
    expect(webhookUpdateCalls).toEqual([{ access_token: accessToken, webhook: URL_A }]);
  });

  it("a different URL: exactly one itemWebhookUpdate, columns stored", async () => {
    const { row, accessToken } = await seedItem({ webhookUrl: URL_B, webhookCheckedAt: NOW, webhookError: "old" });
    expect(await ensureItemWebhook(row, { now: NOW })).toEqual({ state: "registered" });
    expect(webhookUpdateCalls).toEqual([{ access_token: accessToken, webhook: URL_A }]);
    const after = await reread(row.id);
    expect(after.webhookUrl).toBe(URL_A);
    expect(after.webhookCheckedAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.webhookError).toBeNull();
    expect(refreshCalls).toEqual([]);
  });

  it("a refusal is stored (cut to 300 chars, no token) and the caller carries on", async () => {
    const { row, accessToken } = await seedItem();
    webhookUpdateMock = async () => {
      throw new Error(`bad address for ${accessToken} ${"x".repeat(500)}`);
    };
    const r = await ensureItemWebhook(row, { now: NOW });
    expect(r).toEqual({ state: "error" });
    const after = await reread(row.id);
    expect(after.webhookUrl).toBeNull();
    expect(after.webhookCheckedAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.webhookError!.length).toBeLessThanOrEqual(300);
    expect(after.webhookError).not.toContain(accessToken);
    expect(webhookUpdateCalls).toHaveLength(1);
  });

  it("boot sweep: one call per real item, none for synthetic seed rows", async () => {
    await seedItem();
    await seedItem();
    await seedItem({ itemId: `seed-${randomUUID()}` });
    const tally = await ensureAllItemWebhooks({ now: NOW });
    expect(webhookUpdateCalls).toHaveLength(2);
    expect(tally.registered).toBeGreaterThanOrEqual(2);
    expect(refreshCalls).toEqual([]);
  });
});

describe("sync end + webhook path", () => {
  it("a successful sync registers the address once; a failure cannot block it or the txn.arrived emit", async () => {
    const { row, accessToken } = await seedItem();
    const first = await syncPlaidItem(TEST_USER, row.id, { syncOrigin: "webhook" });
    expect(first.error ?? null).toBeNull();
    expect(webhookUpdateCalls).toEqual([{ access_token: accessToken, webhook: URL_A }]);
    expect((await reread(row.id)).webhookUrl).toBe(URL_A);
    // A second sync inside the window makes no second call.
    await syncPlaidItem(TEST_USER, row.id, { syncOrigin: "webhook" });
    expect(webhookUpdateCalls).toHaveLength(1);
    expect(refreshCalls).toEqual([]);

    // A refusing bank: the sync still succeeds and still hands off the arrivals.
    const bad = await seedItem();
    const acct = `acct-${randomUUID()}`;
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: bad.row.id, accountId: acct,
      mask: "1111", name: "Checking", type: "depository", subtype: "checking", firstSyncCompletedAt: new Date(),
    });
    addedTxns = [{ transaction_id: `t-${randomUUID()}`, account_id: acct, date: "2026-10-07", amount: 12, name: "SYNTHETIC SHOP" }];
    webhookUpdateMock = async () => { throw new Error("refused"); };
    _emittedForTests.length = 0;
    const r = await syncPlaidItem(TEST_USER, bad.row.id, { syncOrigin: "webhook" });
    expect(r.error ?? null).toBeNull();
    expect(_emittedForTests.filter((e) => e.queue === "txn.arrived")).toHaveLength(1);
    expect((await reread(bad.row.id)).webhookError).toBe("refused");
  });

  it("a signed webhook -> debounced free sync -> txn.arrived -> categorize + monitor; never a refresh", async () => {
    const { row, externalItemId } = await seedItem({ webhookUrl: URL_A, webhookCheckedAt: new Date() });
    const acct = `acct-${randomUUID()}`;
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: row.id, accountId: acct,
      mask: "2222", name: "Checking", type: "depository", subtype: "checking", firstSyncCompletedAt: new Date(),
    });
    addedTxns = [{ transaction_id: `t-${randomUUID()}`, account_id: acct, date: "2026-10-07", amount: 31, name: "MYSTERY SHOP 9" }];
    const res = await request("POST", "/plaid/webhook", {
      webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: externalItemId,
    });
    expect(res.status).toBe(200);
    await _flushPlaidSyncSchedulerForTests();
    const arrived = _emittedForTests.filter((e) => e.queue === "txn.arrived");
    expect(arrived).toHaveLength(1);
    expect(arrived[0]!.data).toMatchObject({ householdId: TEST_HOUSEHOLD_ID, ownerUserId: TEST_USER, arrived: 1 });
    _emittedForTests.length = 0;
    await handleTxnArrived([{ id: "j1", data: arrived[0]!.data } as never]);
    const queues = _emittedForTests.map((e) => e.queue);
    expect(queues).toContain("monitor.household");
    expect(refreshCalls).toEqual([]);
    expect(webhookUpdateCalls).toEqual([]); // fresh registration: no extra call
  });
});

describe("GET /plaid/items — autoUpdates", () => {
  it("reports the four reasons", async () => {
    const ok = await seedItem({ institutionName: "OkBank", webhookUrl: URL_A, webhookCheckedAt: NOW });
    const notReg = await seedItem({ institutionName: "NewBank" });
    const stale = await seedItem({ institutionName: "OldUrlBank", webhookUrl: URL_B, webhookCheckedAt: NOW });
    const err = await seedItem({ institutionName: "RefusedBank", webhookError: "address not allowed", webhookCheckedAt: NOW });
    const get = async () =>
      (await request("GET", "/plaid/items")).json as Array<{ id: string; autoUpdates: { on: boolean; reason: string; checkedAt: string | null; error: string | null } }>;
    let items = await get();
    const by = (id: string) => items.find((i) => i.id === id)!.autoUpdates;
    expect(by(ok.row.id)).toEqual({ on: true, reason: "ok", checkedAt: NOW.toISOString(), error: null });
    expect(by(notReg.row.id)).toMatchObject({ on: false, reason: "not_registered", checkedAt: null });
    expect(by(stale.row.id)).toMatchObject({ on: false, reason: "not_registered" });
    expect(by(err.row.id)).toMatchObject({ on: false, reason: "error", error: "address not allowed" });
    delete process.env.PLAID_WEBHOOK_URL;
    items = await get();
    for (const r of [ok, notReg, stale, err]) expect(by(r.row.id)).toMatchObject({ on: false, reason: "no_url" });
  });
});

describe("a bank quiet for 3 days is stale, never 'nothing spent'", () => {
  it("the recap says the bank data is old and does not claim nothing was spent", async () => {
    const user = `v3-recap-${process.pid}-${randomUUID().slice(0, 8)}`;
    extraUsers.push(user);
    const { householdId } = await createTestHousehold(user);
    const real = new Date();
    const threeDays = new Date(real.getTime() - 3 * DAY);
    const [item] = await db.insert(plaidItemsTable).values({
      userId: user, householdId, itemId: `item-${randomUUID()}`, accessToken: "t", institutionSlug: "chase", lastSyncedAt: threeDays,
    }).returning();
    const [acct] = await db.insert(plaidAccountsTable).values({
      userId: user, householdId, itemId: item!.id, accountId: `a-${randomUUID()}`, mask: "3333", name: "Checking", type: "depository", subtype: "checking",
    }).returning();
    await db.insert(forecastSettingsTable).values({
      userId: user, householdId, bankSnapshotBalance: "1000.00", bankSnapshotAt: threeDays,
      bankSnapshotSource: "plaid", bankSnapshotAccountId: acct!.id, bankSnapshotMask: "3333",
    });
    const fr = await computeBankFreshness(householdId, user, real);
    expect(fr).toMatchObject({ stale: true, staleReason: "old" });
    const facts = await recapFacts(householdId, user, user, real.toISOString().slice(0, 10));
    expect(facts.freshness.stale).toBe(true);
    const text = renderRecapTemplate(facts);
    expect(text).toMatch(/Bank data last updated \d+ days? ago/);
    expect(text).not.toMatch(/nothing spent/i);
  });
});
