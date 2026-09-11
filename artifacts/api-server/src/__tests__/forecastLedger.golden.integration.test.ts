// ⭐ PR4a GOLDEN — the full `computeCashSignal` output, recorded BEFORE the ledger
// refactor and asserted deep-equal after it.
//
// PR4a extracts `buildForecastLedger()` out of `computeCashSignal` and merges its
// two roll-forwards (the `bankToday` roll and the curve's actual rows) into one.
// That refactor must not move a single cent or a single event. The scattered
// field assertions elsewhere pin the numbers someone thought to check; this file
// pins EVERYTHING the function returns — every daily point, every event, every
// status field — for fixtures chosen to exercise each branch the refactor
// touches:
//   - snapshot anchor, account resolution (pointer / unresolved), isBankRow
//     (other account, manual, `amex`-sourced manual)
//   - anchor-day, posted, pending, future forecast-flagged, future unflagged rows
//   - matched (with a matched Chase txn), rescheduled, skipped, missed, dragged
//     past-due plans; debt minimum and avalanche extra synthetic events
//   - a fromDate window after the anchor, a window that ends before today, and
//     the no-snapshot fallback
//
// The snapshot file is written once, on the pre-refactor code, and committed.
// ⚠️ Vitest never writes snapshots under CI=true, so CI can only compare.
//
// Not covered, because it cannot exist: two rows with the same plaid transaction
// id. `transactions.plaid_transaction_id` is unique (`transactions_plaid_txn_uq`),
// so the plaid-id de-duplication in `computeCashSignal` is defensive only, and
// whether the roll and the curve de-duplicate over the same rows cannot change a
// number.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  db,
  forecastSettingsTable,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  plaidAccountsTable,
  plaidItemsTable,
  debtsTable,
  avalancheSettingsTable,
} from "@workspace/db";
import { computeCashSignal } from "../lib/cashSignal";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const TEST_USER = `ledger-golden-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HOUSEHOLD: string;

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

// Same pinned "now" as cashSignal.integration.test.ts: Thursday 2026-05-14.
const PINNED_NOW = new Date("2026-05-14T12:00:00Z");

beforeAll(async () => {
  HOUSEHOLD = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
  await cleanup();
});
afterEach(() => {
  vi.useRealTimers();
});

/** UUIDs (item ids, synthetic `debt:<uuid>` ids) differ per run; the shape does not. */
function normalised(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "<uuid>",
    ),
  );
}

async function settings(opts: { balance?: string | null; at?: Date | null; startingBalance?: string; cashBuffer?: string }) {
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: HOUSEHOLD,
    daysAhead: 90,
    startingBalance: opts.startingBalance ?? "0",
    cashBuffer: opts.cashBuffer ?? "500",
    bankSnapshotBalance: opts.balance ?? null,
    bankSnapshotAt: opts.at ?? null,
    bankSnapshotSource: opts.balance != null ? "manual" : null,
  });
}

async function recurring(over: Partial<typeof recurringItemsTable.$inferInsert>) {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      name: "Bill",
      kind: "expense",
      amount: "100",
      frequency: "monthly",
      dayOfMonth: 15,
      anchorDate: "2026-01-15",
      active: "true",
      ...over,
    })
    .returning();
  return r;
}

async function chaseAccount(): Promise<{ id: string; externalId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionSlug: "chase",
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      itemId: item.id,
      accountId: "golden-chase-1",
      name: "Chase Checking",
      mask: "1111",
      subtype: "checking",
      type: "depository",
    })
    .returning();
  return { id: acct.id, externalId: acct.accountId };
}

async function txn(opts: {
  occurredOn: string;
  amount: string;
  plaidAccountId?: string | null;
  source?: string;
  pending?: boolean;
  forecastFlag?: boolean;
  plaidTransactionId?: string | null;
  /** When the row reached the ledger. Defaults to 00:00 Chicago on its own date. */
  createdAt?: Date;
  /** The institution's own transaction time (`occurred_at`). */
  occurredAt?: string;
}) {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      occurredOn: opts.occurredOn,
      description: `golden ${opts.occurredOn} ${opts.amount}`,
      amount: opts.amount,
      plaidAccountId: opts.plaidAccountId ?? null,
      source: opts.source ?? "manual",
      pending: opts.pending ?? false,
      forecastFlag: opts.forecastFlag ?? false,
      plaidTransactionId: opts.plaidTransactionId ?? null,
      createdAt: opts.createdAt ?? createdAtStartOfHouseholdDay(opts.occurredOn),
      occurredAt: opts.occurredAt ?? null,
    })
    .returning();
  return t;
}

async function resolution(over: Partial<typeof forecastResolutionsTable.$inferInsert>) {
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: HOUSEHOLD,
    ...over,
  } as typeof forecastResolutionsTable.$inferInsert);
}

/** The full household: every branch the ledger refactor touches, on one snapshot. */
async function fullHousehold(opts: { snapshotAt?: Date } = {}): Promise<void> {
  const chase = await chaseAccount();
  await settings({ balance: "3000", at: opts.snapshotAt ?? new Date("2026-05-08T15:00:00Z"), cashBuffer: "500" });
  await db
    .update(forecastSettingsTable)
    .set({ bankSnapshotAccountId: chase.id, bankSnapshotMask: "1111", bankSnapshotSource: "plaid" })
    .where(eq(forecastSettingsTable.userId, TEST_USER));

  await recurring({ name: "Rent", amount: "1500", dayOfMonth: 1, anchorDate: "2026-01-01" });
  await recurring({ name: "Paycheck", kind: "income", amount: "2000", frequency: "biweekly", dayOfMonth: null, anchorDate: "2026-05-08" });
  await recurring({ name: "Phone", amount: "95", dayOfMonth: 12, anchorDate: "2026-01-12" }); // past-due → dragged
  const utility = await recurring({ name: "Utility", amount: "140", dayOfMonth: 20, anchorDate: "2026-01-20" });
  const gym = await recurring({ name: "Gym", amount: "40", dayOfMonth: 16, anchorDate: "2026-01-16" });
  const insurance = await recurring({ name: "Insurance", amount: "120", dayOfMonth: 13, anchorDate: "2026-01-13" });
  const streaming = await recurring({ name: "Streaming", amount: "15", dayOfMonth: 18, anchorDate: "2026-01-18" });
  await recurring({ name: "Paused", amount: "999", dayOfMonth: 19, anchorDate: "2026-01-19", active: "false" });

  await db.insert(debtsTable).values({
    userId: TEST_USER,
    householdId: HOUSEHOLD,
    name: "Golden Card",
    type: "credit_card",
    balance: "1200",
    minPayment: "38",
    dueDay: 25,
    status: "active",
  });
  await db.insert(avalancheSettingsTable).values({ userId: TEST_USER, manualExtra: "150" });

  const ext = chase.externalId;
  await txn({ occurredOn: "2026-05-08", amount: "-60", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "g-anchor-day" });
  await txn({ occurredOn: "2026-05-09", amount: "-20", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "g-small" });
  await txn({ occurredOn: "2026-05-10", amount: "-200", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "g-posted" });
  await txn({ occurredOn: "2026-05-11", amount: "50", plaidAccountId: ext, source: "plaid:chase", pending: true, plaidTransactionId: "g-pending" });
  await txn({ occurredOn: "2026-05-12", amount: "-75", plaidAccountId: "someone-elses-account", source: "plaid:chase", plaidTransactionId: "g-other" });
  await txn({ occurredOn: "2026-05-12", amount: "-30", source: "manual" });
  await txn({ occurredOn: "2026-05-12", amount: "-45", source: "amex" });
  const streamingPaid = await txn({ occurredOn: "2026-05-13", amount: "-15", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "g-streaming" });
  await txn({ occurredOn: "2026-05-25", amount: "-100", plaidAccountId: ext, source: "plaid:chase", forecastFlag: true, plaidTransactionId: "g-future-flagged" });
  await txn({ occurredOn: "2026-05-26", amount: "-999", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "g-future-unflagged" });

  await resolution({ recurringItemId: utility.id, occurrenceDate: "2026-05-20", status: "rescheduled", rescheduledTo: "2026-05-22" });
  await resolution({ recurringItemId: gym.id, occurrenceDate: "2026-05-16", status: "skipped" });
  await resolution({ recurringItemId: insurance.id, occurrenceDate: "2026-05-13", status: "missed" });
  await resolution({ recurringItemId: streaming.id, occurrenceDate: "2026-05-18", status: "matched", matchedTxnId: streamingPaid.id });
}

/**
 * Ties and edge paths (added after PR4a's review, recorded on the merged PR4a code,
 * which a 637-combination comparison showed equal to the pre-refactor code):
 *   - two bills due on the 15th tie with the past-due Phone dragged onto 05-15;
 *   - a bill due 05-07, the day before the 05-08 snapshot (#688 exception);
 *   - a bill moved from 2026-02-15, outside the expansion range, to 05-27 (recovery).
 */
async function edgeHousehold(): Promise<void> {
  const chase = await chaseAccount();
  await settings({ balance: "2000", at: new Date("2026-05-08T15:00:00Z"), cashBuffer: "200" });
  await db
    .update(forecastSettingsTable)
    .set({ bankSnapshotAccountId: chase.id, bankSnapshotMask: "1111", bankSnapshotSource: "plaid" })
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await recurring({ name: "Water", amount: "30", dayOfMonth: 15, anchorDate: "2026-01-15" });
  await recurring({ name: "Internet", amount: "45", dayOfMonth: 15, anchorDate: "2026-01-15" });
  await recurring({ name: "Phone", amount: "95", dayOfMonth: 12, anchorDate: "2026-01-12" });
  await recurring({ name: "Early bill", amount: "70", dayOfMonth: 7, anchorDate: "2026-01-07" });
  const moved = await recurring({ name: "Moved bill", amount: "55", frequency: "onetime", dayOfMonth: null, anchorDate: "2026-02-15" });
  await resolution({ recurringItemId: moved.id, occurrenceDate: "2026-02-15", status: "rescheduled", rescheduledTo: "2026-05-27" });
  await txn({ occurredOn: "2026-05-10", amount: "-120", plaidAccountId: chase.externalId, source: "plaid:chase", plaidTransactionId: "e-posted" });
  await txn({ occurredOn: "2026-05-15", amount: "-15.37", plaidAccountId: chase.externalId, source: "plaid:chase", forecastFlag: true, plaidTransactionId: "e-future-cents" });
}

describe("PR4a golden — computeCashSignal output, byte for byte", () => {
  it("full household, default window from today", async () => {
    await fullHousehold();
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 45 });
    expect(normalised(sig)).toMatchSnapshot();
  });

  it("full household, a fromDate window after the anchor", async () => {
    await fullHousehold();
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { fromDate: "2026-05-10", horizonDays: 30 });
    expect(normalised(sig)).toMatchSnapshot();
  });

  it("full household, a window that ends before today", async () => {
    // toDate 05-11 < today 05-14. `bankToday` still rolls through today while the
    // curve stops at its window's end: a merged roll-forward bounded by the
    // window alone would drop 05-12 and 05-13 from bankToday.
    await fullHousehold();
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { fromDate: "2026-05-01", horizonDays: 10 });
    expect(normalised(sig)).toMatchSnapshot();
  });

  it("full household, snapshot dated after today", async () => {
    await fullHousehold({ snapshotAt: new Date("2026-05-20T15:00:00Z") });
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 45 });
    expect(normalised(sig)).toMatchSnapshot();
  });

  it("full household, a window that starts after today", async () => {
    await fullHousehold();
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { fromDate: "2026-05-20", horizonDays: 20 });
    expect(normalised(sig)).toMatchSnapshot();
  });

  it("no snapshot, a window that starts after today: a plan before the window lands on its first day", async () => {
    await settings({ startingBalance: "1800", cashBuffer: "200" });
    await recurring({ name: "Mid-month bill", amount: "65", dayOfMonth: 16, anchorDate: "2026-01-16" });
    await recurring({ name: "Paycheck", kind: "income", amount: "1500", frequency: "biweekly", dayOfMonth: null, anchorDate: "2026-05-22" });
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { fromDate: "2026-05-20", horizonDays: 20 });
    expect(normalised(sig)).toMatchSnapshot();
  });

  it("ties and edge paths: same-day bills with a dragged plan, the day-before-snapshot bill, a recovered moved bill", async () => {
    await edgeHousehold();
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 30 });
    expect(normalised(sig)).toMatchSnapshot();
  });

  it("a snapshot time with no balance, and a balance with no time", async () => {
    await settings({ balance: null, at: new Date("2026-05-10T15:00:00Z"), startingBalance: "700", cashBuffer: "100" });
    await recurring({ name: "Bill", amount: "40", dayOfMonth: 18, anchorDate: "2026-01-18" });
    await txn({ occurredOn: "2026-05-12", amount: "-10", source: "manual" });
    const timeOnly = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 15 });
    await db
      .update(forecastSettingsTable)
      .set({ bankSnapshotBalance: "900", bankSnapshotAt: null, bankSnapshotSource: "manual" })
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    const balanceOnly = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 15 });
    expect(normalised({ timeOnly, balanceOnly })).toMatchSnapshot();
  });

  it("no snapshot: the starting-balance fallback with flagged and unflagged rows", async () => {
    await settings({ startingBalance: "2500", cashBuffer: "300" });
    await recurring({ name: "Rent", amount: "1500", dayOfMonth: 1, anchorDate: "2026-01-01" });
    await recurring({ name: "Paycheck", kind: "income", amount: "1800", frequency: "biweekly", dayOfMonth: null, anchorDate: "2026-05-08" });
    await txn({ occurredOn: "2026-05-10", amount: "-40", forecastFlag: true });
    await txn({ occurredOn: "2026-05-20", amount: "-80", forecastFlag: true });
    await txn({ occurredOn: "2026-05-21", amount: "-60", forecastFlag: false });
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 40 });
    expect(normalised(sig)).toMatchSnapshot();
  });

  it("snapshot with no account pointer: manual rows count, Plaid rows do not", async () => {
    await settings({ balance: "1200", at: new Date("2026-05-12T16:00:00Z"), cashBuffer: "0" });
    await recurring({ name: "Water", amount: "60", dayOfMonth: 16, anchorDate: "2026-01-16" });
    await txn({ occurredOn: "2026-05-13", amount: "-25", source: "manual" });
    await txn({ occurredOn: "2026-05-13", amount: "-70", plaidAccountId: "unresolved-acct", source: "plaid:chase", plaidTransactionId: "g-unresolved" });
    await txn({ occurredOn: "2026-05-14", amount: "300", source: "manual" });
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 20 });
    expect(normalised(sig)).toMatchSnapshot();
  });
});

/**
 * ⭐ PR4b — THE SNAPSHOT RULE, ON THE FULL HOUSEHOLD (balance read 05-08 15:00Z).
 * The entries above are unchanged by the rule: every fixture row is created at
 * 00:00 on its own day and carries no transaction time.
 *   −35 dated 05-08, real time 18:23Z (after the read)    → counts
 *   −15 dated 05-08, arrived 05-09, no time              → held (feed latency)
 *   −22 Plaid charge dated 05-10, in the ledger at the read → held
 *   +500 Plaid deposit dated 05-10, in the ledger at the read → counts (not in `available`)
 *   −18 Plaid charge dated 05-10, arrived after the read  → counts
 *   −90 Plaid charge dated 05-14 (+6)                     → counts
 *   −12 manual, dated 05-09                               → counts
 * bankToday = 2785 − 35 + 500 − 18 − 90 − 12 = 3130.00
 * (PR4a's day rule: 2785 − 22 + 500 − 18 − 90 − 12 = 3143.00).
 */
describe("PR4b golden — the snapshot rule", () => {
  it("counts rows shown to happen after the read, holds rows the balance already had", async () => {
    await fullHousehold();
    const ext = "golden-chase-1";
    const atRead = new Date("2026-05-08T14:00:00Z");
    await txn({ occurredOn: "2026-05-08", amount: "-35", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "r-sameday-happened-after", createdAt: new Date("2026-05-08T18:30:00Z"), occurredAt: "2026-05-08T18:23:41.000Z" });
    await txn({ occurredOn: "2026-05-08", amount: "-15", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "r-sameday-late", createdAt: new Date("2026-05-09T12:00:00Z") });
    await txn({ occurredOn: "2026-05-10", amount: "-22", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "r-held-charge", createdAt: atRead });
    await txn({ occurredOn: "2026-05-10", amount: "500", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "r-pending-deposit", createdAt: atRead });
    await txn({ occurredOn: "2026-05-10", amount: "-18", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "r-after", createdAt: new Date("2026-05-09T12:00:00Z") });
    await txn({ occurredOn: "2026-05-14", amount: "-90", plaidAccountId: ext, source: "plaid:chase", plaidTransactionId: "r-plus6", createdAt: atRead });
    await txn({ occurredOn: "2026-05-09", amount: "-12", source: "manual", createdAt: atRead });
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 45 });
    expect(sig.bankToday).toBe("3130.00");
    expect(normalised(sig)).toMatchSnapshot();
  });
});
