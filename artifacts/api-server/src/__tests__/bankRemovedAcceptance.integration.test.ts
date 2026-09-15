// ⭐ PR-I (owner decisions 5 and 14): what happens when the bank re-issues or
// removes a transaction someone already worked on. The acceptance tests, through
// the real Plaid sync (Plaid itself mocked) and the real readers.
//
//   Decision 14 — reviewed does not freeze bank status.
//     - A replacement that arrives under a NEW id carries the review work
//       (reviewed, category, flags) onto the posted row, only while that row
//       still has the values sync gave it.
//     - The bank still decides whether money moved: a removed row someone
//       worked on stays visible, marked by a `forecast_resolutions` row with
//       status `bank_removed`, and counts in no cash, spending or Budget figure.
//     - Plaid listing the id again deletes the marker.
//   Decision 5 — no automatic $0 for a stale pending row: labelled, counted once.
//
// The repo is public: merchants and amounts are synthetic.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";

const TEST_USER = `pri-accept-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

type PlaidRow = {
  transaction_id: string;
  account_id: string;
  date: string;
  /** Plaid's sign: positive is money out. */
  amount: number;
  name: string;
  pending?: boolean;
  pending_transaction_id?: string | null;
};

let nextSyncResponse: {
  added: PlaidRow[];
  modified: PlaidRow[];
  removed: { transaction_id: string }[];
} = { added: [], modified: [], removed: [] };
let nextGetResponse: { transactions: PlaidRow[]; total_transactions: number } = {
  transactions: [],
  total_transactions: 0,
};

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: {
          added: nextSyncResponse.added,
          modified: nextSyncResponse.modified,
          removed: nextSyncResponse.removed,
          next_cursor: "cursor-pri",
          has_more: false,
        },
      }),
      transactionsGet: async () => ({ data: nextGetResponse }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "item-pri", consent_expiration_time: null } },
      }),
    }),
  };
});

import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  mappingRulesTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO } from "@workspace/avalanche-core";
import { computeCashSignal } from "../lib/cashSignal";
import { householdTodayISO } from "../lib/householdClock";
import { runGapBackfillForItem, syncPlaidItem } from "../lib/plaidSync";
import apiRouter from "../routes/index";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const routes = Router();
routes.use((req, _res, next) => {
  (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
routes.use(apiRouter);
const { request } = createTestApp(routes);

let DINING: string;
let GROCERIES: string;
let HOME: string;
let AUTO: string;

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidSyncAttemptsTable).where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  const category = async (name: string) => {
    const [c] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name, kind: "expense" })
      .returning({ id: budgetCategoriesTable.id });
    return c!.id;
  };
  DINING = await category(`Dining PR-I ${randomUUID().slice(0, 6)}`);
  GROCERIES = await category(`Groceries PR-I ${randomUUID().slice(0, 6)}`);
  HOME = await category(`Home PR-I ${randomUUID().slice(0, 6)}`);
  AUTO = await category(`Auto PR-I ${randomUUID().slice(0, 6)}`);
});

afterAll(async () => {
  await cleanup();
  for (const t of [budgetLinesTable, budgetMonthsTable, budgetCategoriesTable, avalancheSettingsTable, settingsTable]) {
    await db.delete(t).where(eq(t.userId, TEST_USER));
  }
});

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
  nextGetResponse = { transactions: [], total_transactions: 0 };
});

/** A Chase checking account past its first sync, so rows reach the upsert and adoption paths. */
async function seedChase(): Promise<{ itemRowId: string; acctRowId: string; externalAcctId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
      cursor: "prior-cursor",
    })
    .returning();
  const externalAcctId = `acct-pri-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Checking",
      mask: "0101",
      type: "depository",
      subtype: "checking",
      firstSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  return { itemRowId: item!.id, acctRowId: acct!.id, externalAcctId };
}

/** The bank balance the ledger rolls forward from. The syncs here never re-read it (webhook origin). */
async function setSnapshot(acctRowId: string, at: Date, balance = "1000.00"): Promise<void> {
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: balance,
    bankSnapshotAt: at,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acctRowId,
  });
}

const plaidRow = (
  id: string,
  account: string,
  date: string,
  dollarsOut: number,
  name: string,
  pending = false,
): PlaidRow => ({
  transaction_id: id,
  account_id: account,
  date,
  amount: dollarsOut,
  name,
  pending,
  pending_transaction_id: null,
});

async function rowByPlaidId(plaidTransactionId: string) {
  const [row] = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID),
        eq(transactionsTable.plaidTransactionId, plaidTransactionId),
      ),
    );
  return row;
}

async function markersOn(txnId: string): Promise<number> {
  const rows = await db
    .select({ id: forecastResolutionsTable.id, recurringItemId: forecastResolutionsTable.recurringItemId })
    .from(forecastResolutionsTable)
    .where(
      and(eq(forecastResolutionsTable.matchedTxnId, txnId), eq(forecastResolutionsTable.status, "bank_removed")),
    );
  for (const r of rows) expect(r.recurringItemId).toBeNull();
  return rows.length;
}

const cents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100);

type LedgerRow = {
  id: string;
  countsInBalance: boolean;
  balanceReason: string;
  balanceAmount: string | null;
  stalePending: boolean;
  pending: boolean;
};

async function ledgerRow(from: string, to: string, id: string): Promise<LedgerRow | undefined> {
  const r = await request("GET", `/transactions/ledger?from=${from}&to=${to}&limit=100`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json as { rows: LedgerRow[] }).rows.find((x) => x.id === id);
}

/** Cash today (the spine's bank balance), household spending from `from`, and a Budget line's actual. */
async function measure(from: string, categoryId: string): Promise<{ cash: number; spend: number; budget: number }> {
  const today = householdTodayISO();
  const signal = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 90 });
  const facts = await request("GET", `/reports/spending-facts?from=${from}&to=${today}`);
  expect(facts.status, JSON.stringify(facts.json)).toBe(200);
  const month = await request("GET", `/budget/months/${from.slice(0, 7)}-01`);
  expect(month.status, JSON.stringify(month.json)).toBe(200);
  const line = (month.json as { lines: { categoryId: string; actualAmount: string }[] }).lines.find(
    (l) => l.categoryId === categoryId,
  );
  return {
    cash: cents(signal.bankToday),
    spend: cents((facts.json as { householdSpend: { total: number } }).householdSpend.total),
    budget: cents(line?.actualAmount),
  };
}

/**
 * Sync 1 lands a pending charge; the household reviews and files it by hand;
 * sync 2 posts it with a tip under a NEW id and no `pending_transaction_id`
 * (no re-key), at a different amount (no re-mint), and removes the pending id.
 */
async function repostWorkedPending(): Promise<{ itemRowId: string; externalAcctId: string; pendingId: string; postedId: string }> {
  const { itemRowId, externalAcctId } = await seedChase();
  const today = householdTodayISO();
  // A rule files the merchant automatically; the household re-files it by hand.
  await db.insert(mappingRulesTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    pattern: "CORNER BISTRO",
    matchType: "contains",
    categoryId: GROCERIES,
  });
  nextSyncResponse = {
    added: [plaidRow("PEND-BISTRO", externalAcctId, addDaysISO(today, -3), 40, "CORNER BISTRO", true)],
    modified: [],
    removed: [],
  };
  await syncPlaidItem(TEST_USER, itemRowId);
  const pending = await rowByPlaidId("PEND-BISTRO");
  expect(pending).toMatchObject({ pending: true, categoryId: GROCERIES, reviewed: false });
  // What the Chase page writes: reviewed, a hand-picked category (PATCH sets
  // isTransferUserOverridden with it), a Weekly allowance slice, reimbursable.
  await db
    .update(transactionsTable)
    .set({
      reviewed: true,
      categoryId: DINING,
      isTransferUserOverridden: true,
      weeklyAllowance: true,
      weeklyBucket: "dining",
      reimbursable: true,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    .where(eq(transactionsTable.id, pending!.id));

  nextSyncResponse = {
    added: [plaidRow("POST-BISTRO", externalAcctId, addDaysISO(today, -1), 46, "CORNER BISTRO", false)],
    modified: [],
    removed: [{ transaction_id: "PEND-BISTRO" }],
  };
  await syncPlaidItem(TEST_USER, itemRowId);
  const posted = await rowByPlaidId("POST-BISTRO");
  expect(posted).toBeTruthy();
  return { itemRowId, externalAcctId, pendingId: pending!.id, postedId: posted!.id };
}

describe("(decision 14) a replacement under a new id carries the review work", () => {
  it("⭐ a reviewed pending row re-posted under a new id comes back reviewed, with its category and flags", async () => {
    const { pendingId, postedId } = await repostWorkedPending();
    const posted = (await db.select().from(transactionsTable).where(eq(transactionsTable.id, postedId)))[0]!;
    expect(posted).toMatchObject({
      pending: false,
      amount: "-46.00",
      reviewed: true,
      // The hand filing beats the rule's category on the posted row (`effectiveFiling`).
      categoryId: DINING,
      weeklyAllowance: true,
      weeklyBucket: "dining",
      reimbursable: true,
      // Carried with the hand-filed category, as dedupe's merge carries it.
      isTransferUserOverridden: true,
    });
    expect(await markersOn(postedId)).toBe(0);

    // The pending row the household worked on stays, marked removed by the bank.
    const pending = (await db.select().from(transactionsTable).where(eq(transactionsTable.id, pendingId)))[0]!;
    expect(pending).toMatchObject({ reviewed: true, categoryId: DINING });
    expect(await markersOn(pendingId)).toBe(1);
  });

  it("a choice made on the posted row itself is never overwritten by a later sync", async () => {
    const { itemRowId, externalAcctId, postedId } = await repostWorkedPending();
    const today = householdTodayISO();
    // The household un-reviews the posted row and files it elsewhere.
    await db
      .update(transactionsTable)
      .set({ reviewed: false, categoryId: HOME, weeklyAllowance: false, weeklyBucket: null, reimbursable: false })
      .where(eq(transactionsTable.id, postedId));
    // Plaid refreshes the posted row, and lists the pending id as removed again.
    nextSyncResponse = {
      added: [],
      modified: [plaidRow("POST-BISTRO", externalAcctId, addDaysISO(today, -1), 46, "CORNER BISTRO", false)],
      removed: [{ transaction_id: "PEND-BISTRO" }],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    const posted = (await db.select().from(transactionsTable).where(eq(transactionsTable.id, postedId)))[0]!;
    expect(posted).toMatchObject({
      reviewed: false,
      categoryId: HOME,
      weeklyAllowance: false,
      weeklyBucket: null,
      reimbursable: false,
    });
  });

  it("the gap backfill carries it too, when /transactions/get brings the posted row", async () => {
    const { itemRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    const day = addDaysISO(today, -4);
    const [pending] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: day,
        description: "HILLTOP HARDWARE",
        amount: "-30.00",
        source: "plaid:chase",
        plaidTransactionId: "PEND-HILLTOP",
        plaidAccountId: externalAcctId,
        pending: true,
        reviewed: true,
        categoryId: HOME,
        isTransferUserOverridden: true,
        monthlyAllowance: true,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning();
    nextGetResponse = {
      transactions: [plaidRow("POST-HILLTOP", externalAcctId, addDaysISO(day, 2), 33, "HILLTOP HARDWARE", false)],
      total_transactions: 1,
    };
    await runGapBackfillForItem(TEST_USER, itemRowId, { today: new Date() });
    const posted = await rowByPlaidId("POST-HILLTOP");
    expect(posted).toMatchObject({ reviewed: true, categoryId: HOME, monthlyAllowance: true });
    // The backfill's vanished-pending sweep keeps the worked-on pending row.
    expect((await db.select().from(transactionsTable).where(eq(transactionsTable.id, pending!.id))).length).toBe(1);
  });
});

describe("(decision 14) the bank decides whether money moved", () => {
  it("⭐ a removed −$40 row someone worked on: cash goes up 40, spending goes down 40, the Budget line down 40, and the row stays visible with its marker", async () => {
    const { itemRowId, acctRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    await setSnapshot(acctRowId, new Date(Date.now() - 5 * 86_400_000));
    const day = addDaysISO(today, -2);
    const [worked] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: day,
        description: "MAPLE GARDEN CENTER",
        amount: "-40.00",
        source: "plaid:chase",
        plaidTransactionId: "GONE-40",
        plaidAccountId: externalAcctId,
        categoryId: HOME,
        reviewed: true,
      })
      .returning();

    const before = await measure(day, HOME);
    const beforeLedger = await ledgerRow(day, today, worked!.id);
    expect(beforeLedger).toMatchObject({ countsInBalance: true, balanceReason: "counted", balanceAmount: "-40.00" });

    nextSyncResponse = { added: [], modified: [], removed: [{ transaction_id: "GONE-40" }] };
    await syncPlaidItem(TEST_USER, itemRowId);

    // The syncs here never re-read the balance: the anchor did not move.
    const [settings] = await db.select().from(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(settings!.bankSnapshotBalance).toBe("1000.00");

    const after = await measure(day, HOME);
    expect(after.cash - before.cash).toBe(4000);
    expect(before.spend - after.spend).toBe(4000);
    expect(before.budget - after.budget).toBe(4000);

    // Visible, with its marker.
    const kept = await rowByPlaidId("GONE-40");
    expect(kept).toMatchObject({ id: worked!.id, reviewed: true, categoryId: HOME });
    expect(await markersOn(worked!.id)).toBe(1);
    expect(await ledgerRow(day, today, worked!.id)).toMatchObject({
      countsInBalance: false,
      balanceReason: "removed_by_bank",
      balanceAmount: "0.00",
    });
    // The Chase page's row list still shows it, flagged, when it asks for removed rows.
    const listed = await request("GET", `/transactions?from=${day}&to=${today}&includeBankRemoved=true`);
    expect(listed.status).toBe(200);
    expect((listed.json as { id: string; bankRemoved?: boolean }[]).find((t) => t.id === worked!.id)).toMatchObject({
      bankRemoved: true,
    });
  });

  it("⭐ Plaid re-adds the id: the marker is gone and the row counts again", async () => {
    const { itemRowId, acctRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    await setSnapshot(acctRowId, new Date(Date.now() - 5 * 86_400_000));
    const day = addDaysISO(today, -2);
    const [worked] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: day,
        description: "RIVERSIDE PHARMACY",
        amount: "-40.00",
        source: "plaid:chase",
        plaidTransactionId: "BACK-40",
        plaidAccountId: externalAcctId,
        categoryId: HOME,
        weeklyAllowance: true,
      })
      .returning();
    const counted = await measure(day, HOME);

    nextSyncResponse = { added: [], modified: [], removed: [{ transaction_id: "BACK-40" }] };
    await syncPlaidItem(TEST_USER, itemRowId);
    expect(await markersOn(worked!.id)).toBe(1);
    const removed = await measure(day, HOME);
    expect(removed.cash - counted.cash).toBe(4000);
    expect(counted.spend - removed.spend).toBe(4000);

    nextSyncResponse = {
      added: [],
      modified: [plaidRow("BACK-40", externalAcctId, day, 40, "RIVERSIDE PHARMACY")],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    expect(await markersOn(worked!.id)).toBe(0);
    expect(await measure(day, HOME)).toEqual(counted);
    expect(await ledgerRow(day, today, worked!.id)).toMatchObject({ countsInBalance: true, balanceReason: "counted" });
  });

  it("a marker is deleted when the gap backfill lists the id again", async () => {
    const { itemRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    const day = addDaysISO(today, -3);
    const [worked] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: day,
        description: "LAKESIDE BAKERY",
        amount: "-12.00",
        source: "plaid:chase",
        plaidTransactionId: "RELIST-12",
        plaidAccountId: externalAcctId,
        reviewed: true,
      })
      .returning();
    // An earlier sync marked it removed.
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: null,
      occurrenceDate: null,
      status: "bank_removed",
      matchedTxnId: worked!.id,
    });
    nextGetResponse = {
      transactions: [plaidRow("RELIST-12", externalAcctId, day, 12, "LAKESIDE BAKERY")],
      total_transactions: 1,
    };
    await runGapBackfillForItem(TEST_USER, itemRowId, { today: new Date(), overlapDays: 5 });
    expect(await markersOn(worked!.id)).toBe(0);
  });

  it("the backfill's vanished-pending sweep keeps a worked-on marked pending row, marker and all", async () => {
    const { itemRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    const [worked] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: addDaysISO(today, -6),
        description: "PARKSIDE CAFE",
        amount: "-9.00",
        source: "plaid:chase",
        plaidTransactionId: "SWEEP-9",
        plaidAccountId: externalAcctId,
        pending: true,
        categoryId: DINING,
      })
      .returning();
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      status: "bank_removed",
      matchedTxnId: worked!.id,
    });
    nextGetResponse = { transactions: [], total_transactions: 0 };
    await runGapBackfillForItem(TEST_USER, itemRowId, { today: new Date() });
    expect(await rowByPlaidId("SWEEP-9")).toBeTruthy();
    expect(await markersOn(worked!.id)).toBe(1);
  });
});

describe("(decision 5) a pending row more than 14 days old is labelled, never $0, never counted twice", () => {
  it("⭐ a 20-day pending row is labelled and not $0: it moves cash, the register, spending and its Budget line once", async () => {
    const { acctRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    await setSnapshot(acctRowId, new Date(Date.now() - 30 * 86_400_000));
    const day = addDaysISO(today, -20);
    const [hold] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: day,
        description: "COUNTY FUEL STOP",
        amount: "-25.00",
        source: "plaid:chase",
        plaidTransactionId: "STALE-25",
        plaidAccountId: externalAcctId,
        pending: true,
        categoryId: AUTO,
        createdAt: createdAtStartOfHouseholdDay(day),
      })
      .returning();

    expect(await ledgerRow(addDaysISO(today, -25), today, hold!.id)).toMatchObject({
      pending: true,
      stalePending: true,
      countsInBalance: true,
      balanceReason: "counted",
      balanceAmount: "-25.00",
    });
    const lone = await measure(day, AUTO);
    expect(lone.cash).toBe(100_000 - 2_500);
    expect(lone.spend).toBe(2_500);
    expect(lone.budget).toBe(2_500);
    expect(await markersOn(hold!.id)).toBe(0);

    // Its posting three days later replaces it: the charge still counts once.
    const postedDay = addDaysISO(day, 3);
    const [posted] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: postedDay,
        description: "COUNTY FUEL STOP",
        amount: "-25.00",
        source: "plaid:chase",
        plaidTransactionId: "STALE-25-POSTED",
        plaidAccountId: externalAcctId,
        pending: false,
        createdAt: createdAtStartOfHouseholdDay(postedDay),
      })
      .returning();
    const signal = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 90 });
    expect(cents(signal.bankToday)).toBe(100_000 - 2_500);
    const facts = await request("GET", `/reports/spending-facts?from=${day}&to=${today}`);
    expect(cents((facts.json as { householdSpend: { total: number } }).householdSpend.total)).toBe(2_500);
    expect(await ledgerRow(addDaysISO(today, -25), today, hold!.id)).toMatchObject({
      stalePending: true,
      countsInBalance: false,
      balanceReason: "superseded",
      balanceAmount: "0.00",
    });
    expect(await ledgerRow(addDaysISO(today, -25), today, posted!.id)).toMatchObject({
      stalePending: false,
      countsInBalance: true,
      balanceAmount: "-25.00",
    });
  });
});
