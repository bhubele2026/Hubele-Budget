// ⭐ PR-I: every reader of `forecast_resolutions` copes with the bank-removed
// marker (status `bank_removed`, `recurring_item_id` NULL, `matched_txn_id` = the
// row the bank removed). The marker is not a bill resolution, not a match, and
// not "paid" — and nothing that deletes resolutions by `matched_txn_id` may wipe
// it, or the removed row would silently start counting again.
//
// Clock pinned: today is 2026-05-14 in Chicago. Synthetic merchants and amounts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `pri-readers-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => {
      throw new Error("no Plaid calls in this test");
    },
  };
});

import {
  db,
  budgetCategoriesTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { computeCashSignal, type CashSignal } from "../lib/cashSignal";
import { computeReviewCount } from "../lib/reviewCount";
import { buildBillsSummary } from "../lib/billsSummary";
import { dedupeTransactionsForAccount } from "../lib/dedupeTransactions";
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

const PINNED_NOW = new Date("2026-05-14T17:00:00Z"); // noon in Chicago
const CHASE = `chase-pri-readers-${randomUUID()}`;
let CAT: string;

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  const [c] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `Utilities PR-I ${randomUUID().slice(0, 6)}`, kind: "expense" })
    .returning({ id: budgetCategoriesTable.id });
  CAT = c!.id;
});
afterAll(async () => {
  await cleanup();
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  await cleanup();
});
afterEach(() => {
  vi.useRealTimers();
});

async function snapshotOnChase(balance = "1000"): Promise<void> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionSlug: "chase",
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, itemId: item!.id, accountId: CHASE, name: "Chase Checking", type: "depository", subtype: "checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: balance,
    bankSnapshotAt: new Date("2026-05-01T15:00:00Z"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
  });
}

async function plan(
  name: string,
  amount: string,
  over: Partial<typeof recurringItemsTable.$inferInsert> = {},
): Promise<string> {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name,
      kind: "expense",
      amount,
      frequency: "monthly",
      dayOfMonth: 20,
      anchorDate: "2026-01-20",
      active: "true",
      ...over,
    })
    .returning();
  return r!.id;
}

async function row(
  occurredOn: string,
  amount: string,
  description: string,
  extra: Partial<typeof transactionsTable.$inferInsert> = {},
): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description,
      amount,
      plaidAccountId: CHASE,
      source: "plaid:chase",
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
      ...extra,
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

/** The marker a sync writes for a removed row someone worked on. */
async function markRemoved(txnId: string): Promise<string> {
  const [m] = await db
    .insert(forecastResolutionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: null,
      occurrenceDate: null,
      status: "bank_removed",
      matchedTxnId: txnId,
    })
    .returning({ id: forecastResolutionsTable.id });
  return m!.id;
}

async function resolutions(): Promise<string[]> {
  return (
    await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, TEST_HOUSEHOLD_ID))
  )
    .map((r) => `${r.status}:${r.recurringItemId ? "plan" : "-"}#${r.matchedTxnId ?? "-"}`)
    .sort();
}

const signal = () => computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 90 });
const matchFor = (sig: CashSignal, planKey: string) => sig.matches?.find((m) => m.planKey === planKey);

describe("forecast ledger (lib/forecastLedger.ts)", () => {
  it("a removed row is not cash and pays no bill", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    await row("2026-04-20", "-150.00", "CITY WATER UTIL"); // April paid on time, before the snapshot
    const removed = await row("2026-05-12", "-150.00", "CITY WATER UTIL", { categoryId: CAT });
    await markRemoved(removed);

    const sig = await signal();
    expect(sig.bankToday).toBe("1000.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toBeUndefined();
    expect((sig.matches ?? []).some((m) => m.txnId === removed)).toBe(false);
  });

  it("the posted row that replaced a removed pending row still pays its bill: the marker claims nothing", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    // April paid on time, before the snapshot, so May's pair is not held back (as in cashSignalProbablyPaid).
    await row("2026-04-20", "-150.00", "CITY WATER UTIL");
    const pending = await row("2026-05-11", "-150.00", "CITY WATER UTIL", { pending: true, categoryId: CAT });
    await markRemoved(pending);
    const posted = await row("2026-05-12", "-150.00", "CITY WATER UTIL", { categoryId: CAT });

    const sig = await signal();
    // The charge counts once, on its posted row.
    expect(sig.bankToday).toBe("850.00");
    expect(matchFor(sig, `${water}|2026-05-20`)).toMatchObject({ txnId: posted, tier: 2, offCurve: true });
  });
});

describe("GET /forecast and POST / DELETE /forecast/resolutions (routes/forecast.ts)", () => {
  it("the bundle carries neither the marker nor the removed row; the review count agrees", async () => {
    await snapshotOnChase();
    const removed = await row("2026-05-12", "-60.00", "HILLSIDE GAS CO", { categoryId: CAT });
    const live = await row("2026-05-13", "-20.00", "HILLSIDE GAS CO");
    await markRemoved(removed);

    const r = await request("GET", "/forecast");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const bundle = r.json as { resolutions: { status: string }[]; transactions: { id: string }[] };
    expect(bundle.resolutions.some((x) => x.status === "bank_removed")).toBe(false);
    expect(bundle.transactions.map((t) => t.id)).toContain(live);
    expect(bundle.transactions.map((t) => t.id)).not.toContain(removed);

    // (lib/reviewCount.ts) The badge counts what the bundle lists: the live row only.
    expect(await computeReviewCount(TEST_HOUSEHOLD_ID, TEST_USER)).toBe(1);
  });

  it("no request can write a marker, and answering a pair on a removed row keeps its marker", async () => {
    await snapshotOnChase();
    const water = await plan("City Water", "150");
    const removed = await row("2026-05-12", "-150.00", "CITY WATER UTIL");
    await markRemoved(removed);

    const forged = await request("POST", "/forecast/resolutions", { status: "bank_removed", matchedTxnId: removed });
    expect(forged.status).toBe(400);

    const answered = await request("POST", "/forecast/resolutions", {
      recurringItemId: water,
      occurrenceDate: "2026-05-20",
      status: "matched",
      matchedTxnId: removed,
    });
    expect(answered.status).toBe(200);
    expect(await resolutions()).toEqual([`bank_removed:-#${removed}`, `matched:plan#${removed}`]);
  });

  it("DELETE /forecast/resolutions/:id does not delete a marker", async () => {
    await snapshotOnChase();
    const removed = await row("2026-05-12", "-15.00", "CORNER NEWSSTAND");
    const marker = await markRemoved(removed);
    const r = await request("DELETE", `/forecast/resolutions/${marker}`);
    expect(r.status).toBe(204);
    expect(await resolutions()).toEqual([`bank_removed:-#${removed}`]);
  });
});

describe("bills (lib/billsSummary.ts) and one-time bill moves (lib/oneTimeBillMove.ts)", () => {
  it("a marker is no bill's actual, archives nothing, and survives a one-time bill's move", async () => {
    await snapshotOnChase();
    const garden = await plan("Garden Service", "80", {
      frequency: "onetime",
      dayOfMonth: null,
      anchorDate: "2026-05-16",
      categoryId: CAT,
    });
    const removed = await row("2026-05-12", "-80.00", "GARDEN SERVICE LLC", { categoryId: CAT });
    await markRemoved(removed);

    const summary = await buildBillsSummary(TEST_HOUSEHOLD_ID, TEST_USER, "2026-05-01");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(removed);
    const [item] = await db.select().from(recurringItemsTable).where(eq(recurringItemsTable.id, garden));
    expect(item!.active).toBe("true");

    const moved = await request("PATCH", `/recurring-items/${garden}`, { name: "Garden Service", anchorDate: "2026-05-18" });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(await resolutions()).toEqual([`bank_removed:-#${removed}`]);
  });
});

describe("dedupe (lib/dedupeTransactions.ts)", () => {
  it("a removed row never outlives its live twin: the live row survives with the review work, and no marker moves onto it", async () => {
    await snapshotOnChase();
    const removed = await row("2026-05-12", "-42.00", "PINE STREET MARKET", {
      plaidTransactionId: `old-${randomUUID()}`,
      reviewed: true,
      categoryId: CAT,
      isTransferUserOverridden: true,
    });
    await markRemoved(removed);
    const liveId = `new-${randomUUID()}`;
    const live = await row("2026-05-12", "-42.00", "PINE STREET MARKET", { plaidTransactionId: liveId });

    const report = await dedupeTransactionsForAccount(TEST_USER, CHASE);
    expect(report.duplicatesRemoved).toBe(1);
    expect(report.resolutionsRepointed).toBe(0);
    const left = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
    expect(left.map((t) => t.id)).toEqual([live]);
    expect(left[0]).toMatchObject({ plaidTransactionId: liveId, reviewed: true, categoryId: CAT });
    expect(await resolutions()).toEqual([]);
  });

  it("a duplicate's reviewed mark carries to the survivor", async () => {
    await snapshotOnChase();
    const survivor = await row("2026-05-12", "-18.00", "ELM ROAD DELI", { categoryId: CAT });
    await row("2026-05-12", "-18.00", "ELM ROAD DELI", { reviewed: true });
    await dedupeTransactionsForAccount(TEST_USER, CHASE);
    const left = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
    expect(left.map((t) => t.id)).toEqual([survivor]);
    expect(left[0]).toMatchObject({ categoryId: CAT, reviewed: true });
  });
});

describe("deletes by matched_txn_id when the forecast flag is turned off (routes/transactions.ts)", () => {
  async function futureRemovedRow(description: string): Promise<{ id: string; water: string }> {
    const water = await plan(`Water ${description}`, "30");
    const id = await row("2026-05-20", "-30.00", description, { forecastFlag: true });
    await markRemoved(id);
    // A real match on the same row is still deleted, as before.
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: water,
      occurrenceDate: "2026-05-20",
      status: "matched",
      matchedTxnId: id,
    });
    return { id, water };
  }

  it("PATCH /transactions/:id keeps the marker", async () => {
    await snapshotOnChase();
    const { id } = await futureRemovedRow("AUTOPAY ONE");
    const r = await request("PATCH", `/transactions/${id}`, { forecastFlag: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await resolutions()).toEqual([`bank_removed:-#${id}`]);
  });

  it("POST /transactions/bulk-update keeps the marker", async () => {
    await snapshotOnChase();
    const { id } = await futureRemovedRow("AUTOPAY TWO");
    const r = await request("POST", "/transactions/bulk-update", { ids: [id], patch: { forecastFlag: false } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await resolutions()).toEqual([`bank_removed:-#${id}`]);
  });

  it("POST /transactions/bulk-set-forecast-flag keeps the marker", async () => {
    await snapshotOnChase();
    const { id } = await futureRemovedRow("AUTOPAY THREE");
    const r = await request("POST", "/transactions/bulk-set-forecast-flag", { ids: [id], forecastFlag: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await resolutions()).toEqual([`bank_removed:-#${id}`]);
  });
});
