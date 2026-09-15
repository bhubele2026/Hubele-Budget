// ⭐ PR-I round 2: the review's sync findings, as tests. Real Plaid sync (Plaid
// mocked), real readers, real clock. Synthetic merchants and amounts.
//
//   HIGH-1   the review carry needs the bank's word that the pending row is gone
//            — a second purchase at the same shop never takes another charge's
//            review and filing;
//   (M4b)    a later backfill leaves a choice on an existing posted row alone;
//   MEDIUM-1 a re-mint split across two syncs keeps the id the bank still
//            reports, so the old id's removal marks nothing;
//   MEDIUM-2 a payment the bank removed nets nothing toward "% paid", and the
//            Reports hub (/dashboard) totals skip a removed row;
//   NIT      one marker per row, whatever the calls.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";

const TEST_USER = `pri-sync-r2-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
          next_cursor: "cursor-pri-r2",
          has_more: false,
        },
      }),
      transactionsGet: async () => ({ data: nextGetResponse }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "item-pri-r2", consent_expiration_time: null } },
      }),
    }),
  };
});

import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO } from "@workspace/avalanche-core";
import { markBankRemoved } from "../lib/bankRemoved";
import { computeCashSignal } from "../lib/cashSignal";
import { loadPendingPayments } from "../lib/debtPending";
import { dedupeTransactionsForAccount } from "../lib/dedupeTransactions";
import { householdTodayISO } from "../lib/householdClock";
import { runGapBackfillForItem, syncPlaidItem } from "../lib/plaidSync";
import apiRouter from "../routes/index";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const routes = Router();
routes.use((req, _res, next) => {
  (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
routes.use(apiRouter);
const { request } = createTestApp(routes);

let DINING: string;
let HOME: string;
const HOME_NAME = `Home PR-I r2 ${randomUUID().slice(0, 6)}`;

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
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
  DINING = await category(`Dining PR-I r2 ${randomUUID().slice(0, 6)}`);
  HOME = await category(HOME_NAME);
});

afterAll(async () => {
  await cleanup();
  for (const t of [budgetCategoriesTable, avalancheSettingsTable, settingsTable]) {
    await db.delete(t).where(eq(t.userId, TEST_USER));
  }
});

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
  nextGetResponse = { transactions: [], total_transactions: 0 };
});

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
  const externalAcctId = `acct-pri-r2-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Checking",
      mask: "0303",
      type: "depository",
      subtype: "checking",
      firstSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  return { itemRowId: item!.id, acctRowId: acct!.id, externalAcctId };
}

async function setSnapshot(acctRowId: string, at: Date): Promise<void> {
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "1000.00",
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
  return (
    await db
      .select({ id: forecastResolutionsTable.id })
      .from(forecastResolutionsTable)
      .where(
        and(eq(forecastResolutionsTable.matchedTxnId, txnId), eq(forecastResolutionsTable.status, "bank_removed")),
      )
  ).length;
}

async function markRemoved(txnId: string): Promise<void> {
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    status: "bank_removed",
    matchedTxnId: txnId,
  });
}

const cashCents = async (): Promise<number> =>
  Math.round(Number((await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 90 })).bankToday) * 100);

describe("(round 2, review HIGH-1) the review carry needs the bank's word that the pending row is gone", () => {
  it("⭐ a second purchase at the same shop never takes a still-pending charge's review and filing (cursor sync)", async () => {
    const { itemRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    nextSyncResponse = {
      added: [plaidRow("PEND-C1", externalAcctId, addDaysISO(today, -3), 5, "HARBOR COFFEE ROASTERS", true)],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    const first = await rowByPlaidId("PEND-C1");
    await db
      .update(transactionsTable)
      .set({
        reviewed: true,
        categoryId: DINING,
        isTransferUserOverridden: true,
        weeklyAllowance: true,
        weeklyBucket: "dining",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .where(eq(transactionsTable.id, first!.id));

    // A SECOND purchase posts directly, $5.75. The first is still pending at the
    // bank: Plaid removes nothing.
    nextSyncResponse = {
      added: [plaidRow("POST-C2", externalAcctId, addDaysISO(today, -1), 5.75, "HARBOR COFFEE ROASTERS")],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    const unfiled = { reviewed: false, categoryId: null, weeklyAllowance: false, weeklyBucket: null, isTransferUserOverridden: false };
    expect(await rowByPlaidId("POST-C2")).toMatchObject(unfiled);

    // The first purchase then posts through `pending_transaction_id`.
    nextSyncResponse = {
      added: [
        {
          ...plaidRow("POST-C1", externalAcctId, addDaysISO(today, -2), 5, "HARBOR COFFEE ROASTERS"),
          pending_transaction_id: "PEND-C1",
        },
      ],
      modified: [],
      removed: [{ transaction_id: "PEND-C1" }],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    expect(await rowByPlaidId("POST-C1")).toMatchObject({ id: first!.id, pending: false, reviewed: true, categoryId: DINING });
    // The second charge is still the household's to review and file.
    expect(await rowByPlaidId("POST-C2")).toMatchObject(unfiled);
  });

  it("the gap backfill carries nothing while /transactions/get still lists the pending row", async () => {
    const { itemRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    const day = addDaysISO(today, -4);
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: day,
      description: "HILLTOP HARDWARE",
      amount: "-30.00",
      source: "plaid:chase",
      plaidTransactionId: "PEND-LISTED",
      plaidAccountId: externalAcctId,
      pending: true,
      reviewed: true,
      categoryId: HOME,
      isTransferUserOverridden: true,
      monthlyAllowance: true,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    nextGetResponse = {
      transactions: [
        plaidRow("PEND-LISTED", externalAcctId, day, 30, "HILLTOP HARDWARE", true),
        plaidRow("POST-SECOND", externalAcctId, addDaysISO(day, 2), 33, "HILLTOP HARDWARE"),
      ],
      total_transactions: 2,
    };
    await runGapBackfillForItem(TEST_USER, itemRowId, { today: new Date() });
    expect(await rowByPlaidId("POST-SECOND")).toMatchObject({ reviewed: false, categoryId: null, monthlyAllowance: false });
  });

  it("(M4b) a later backfill leaves a choice made on an existing posted row alone", async () => {
    const { itemRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    const day = addDaysISO(today, -4);
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: day,
      description: "HILLTOP HARDWARE",
      amount: "-30.00",
      source: "plaid:chase",
      plaidTransactionId: "PEND-GONE",
      plaidAccountId: externalAcctId,
      pending: true,
      reviewed: true,
      categoryId: HOME,
      isTransferUserOverridden: true,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    // The posted row is already on file; the household un-reviewed it and filed it elsewhere.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: addDaysISO(day, 2),
      description: "HILLTOP HARDWARE",
      amount: "-33.00",
      source: "plaid:chase",
      plaidTransactionId: "POST-KEPT",
      plaidAccountId: externalAcctId,
      reviewed: false,
      categoryId: DINING,
      isTransferUserOverridden: true,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    nextGetResponse = {
      transactions: [plaidRow("POST-KEPT", externalAcctId, addDaysISO(day, 2), 33, "HILLTOP HARDWARE")],
      total_transactions: 1,
    };
    await runGapBackfillForItem(TEST_USER, itemRowId, { today: new Date() });
    expect(await rowByPlaidId("POST-KEPT")).toMatchObject({ reviewed: false, categoryId: DINING });
  });
});

describe("(round 2, review MEDIUM-1) a re-mint split across two syncs", () => {
  it("⭐ the surviving row takes the id Plaid issued last, so the old id's removal marks nothing: cash does not move", async () => {
    const { itemRowId, acctRowId, externalAcctId } = await seedChase();
    const today = householdTodayISO();
    await setSnapshot(acctRowId, new Date(Date.now() - 5 * 86_400_000));
    const day = addDaysISO(today, -2);
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const [worked] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: day,
        description: "BIRCH LANE BOOKS",
        amount: "-25.00",
        source: "plaid:chase",
        plaidTransactionId: "OLD-RM",
        plaidAccountId: externalAcctId,
        categoryId: HOME,
        reviewed: true,
        forecastFlag: true,
        createdAt,
      })
      .returning();
    const counted = await cashCents();

    // Sync N: the same charge arrives as NEW. Dedupe folds it into the worked row.
    nextSyncResponse = {
      added: [plaidRow("NEW-RM", externalAcctId, day, 25, "BIRCH LANE BOOKS")],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: worked!.id, plaidTransactionId: "NEW-RM", reviewed: true, categoryId: HOME });
    expect(rows[0]!.createdAt.getTime()).toBe(createdAt.getTime());
    expect(await cashCents()).toBe(counted);

    // Sync N+1: Plaid removes OLD.
    nextSyncResponse = { added: [], modified: [], removed: [{ transaction_id: "OLD-RM" }] };
    await syncPlaidItem(TEST_USER, itemRowId);
    expect(await markersOn(worked!.id)).toBe(0);
    expect(await cashCents()).toBe(counted);
  });

  it("never hands the survivor an id the bank already removed", async () => {
    const { externalAcctId } = await seedChase();
    const day = addDaysISO(householdTodayISO(), -2);
    const base = {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: day,
      description: "ELM ROAD DELI",
      amount: "-18.00",
      source: "plaid:chase",
      plaidAccountId: externalAcctId,
    };
    const [live] = await db
      .insert(transactionsTable)
      .values({ ...base, plaidTransactionId: "LIVE-ID", categoryId: HOME, createdAt: new Date(Date.now() - 2 * 3_600_000) })
      .returning();
    const [gone] = await db
      .insert(transactionsTable)
      .values({ ...base, plaidTransactionId: "GONE-ID", reviewed: true, createdAt: new Date(Date.now() - 3_600_000) })
      .returning();
    await markRemoved(gone!.id);
    await dedupeTransactionsForAccount(TEST_USER, externalAcctId);
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: live!.id, plaidTransactionId: "LIVE-ID", reviewed: true, categoryId: HOME });
    expect(await markersOn(live!.id)).toBe(0);
  });
});

describe("(round 2, review MEDIUM-2) a payment the bank removed paid nothing", () => {
  it("⭐ pending-payment netting (the '% paid' basis) nets 0 for it", async () => {
    const today = householdTodayISO();
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `PR-I Card ${randomUUID().slice(0, 4)}`,
        balance: "1000.00",
        lastBalanceUpdate: new Date(Date.now() - 10 * 86_400_000),
      })
      .returning();
    const [pay] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: addDaysISO(today, -2),
        description: "CARD PAYMENT RECEIVED",
        amount: "200.00",
        source: "plaid:amex",
        plaidTransactionId: `PAY-${randomUUID()}`,
        plaidAccountId: `card-${randomUUID()}`,
        debtId: debt!.id,
        categoryId: HOME,
        reviewed: true,
      })
      .returning();
    expect((await loadPendingPayments(TEST_HOUSEHOLD_ID, [debt!])).get(debt!.id)?.total).toBe(200);
    await markRemoved(pay!.id);
    expect((await loadPendingPayments(TEST_HOUSEHOLD_ID, [debt!])).get(debt!.id)).toBeUndefined();
  });

  it("GET /dashboard: this month's spend and top categories skip a removed row", async () => {
    const today = householdTodayISO();
    const row = {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: today,
      categoryId: HOME,
    };
    await db.insert(transactionsTable).values({ ...row, description: "LIVE HARDWARE", amount: "-20.00", source: "manual" });
    const [gone] = await db
      .insert(transactionsTable)
      .values({
        ...row,
        description: "GONE HARDWARE",
        amount: "-30.00",
        source: "plaid:chase",
        plaidTransactionId: `G-${randomUUID()}`,
        plaidAccountId: `acct-${randomUUID()}`,
        reviewed: true,
      })
      .returning();
    await markRemoved(gone!.id);
    const r = await request("GET", "/dashboard");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const body = r.json as { monthlySpend: string; topCategories: { categoryName: string; total: string }[] };
    expect(Number(body.monthlySpend)).toBeCloseTo(20, 2);
    expect(Number(body.topCategories.find((c) => c.categoryName === HOME_NAME)?.total)).toBeCloseTo(20, 2);
  });
});

describe("(round 2, review NIT) markBankRemoved writes one marker per row", () => {
  it("repeated ids and repeated calls leave exactly one marker, on the household owner", async () => {
    const { externalAcctId } = await seedChase();
    const [r] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: addDaysISO(householdTodayISO(), -1),
        description: "CEDAR MARKET",
        amount: "-9.00",
        source: "plaid:chase",
        plaidTransactionId: `M-${randomUUID()}`,
        plaidAccountId: externalAcctId,
        reviewed: true,
      })
      .returning();
    expect(await markBankRemoved(TEST_HOUSEHOLD_ID, TEST_USER, [r!.id, r!.id])).toBe(1);
    expect(await markBankRemoved(TEST_HOUSEHOLD_ID, TEST_USER, [r!.id])).toBe(0);
    const markers = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.matchedTxnId, r!.id));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      status: "bank_removed",
      recurringItemId: null,
      occurrenceDate: null,
    });
  });
});
