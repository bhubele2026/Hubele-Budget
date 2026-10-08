// (PR-E) The daily metrics against a real Postgres: the snapshot loader (upsert,
// definition version, reproducibility of a past day), the nightly job (one row
// per day however often it runs), and GET /metrics / POST /metrics/recompute
// (household scoping, the 93-day cap, owner gate).
//
// Synthetic data only.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const OWNER = `pre-owner-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `pre-other-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";
let HH_OTHER = "";
let current = { user: OWNER, hh: () => HH };

process.env.OWNER_EMAIL = "owner@example.com";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = current.user;
    req.actualUserId = current.user;
    req.householdId = current.hh();
    req.householdOwnerId = current.user;
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: async (userId: string) => ({
        id: userId,
        primaryEmailAddressId: "e1",
        emailAddresses: [{ id: "e1", emailAddress: userId === OWNER ? "owner@example.com" : "member@example.com" }],
      }),
    },
  },
}));

import {
  db,
  debtBalanceHistoryTable,
  debtMilestonesTable,
  debtProgressSnapshotsTable,
  debtsTable,
  forecastSettingsTable,
  householdMetricsDailyTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { METRICS_VERSION, addDaysISO, type DailyMetrics } from "@workspace/avalanche-core";
import express from "express";
import metricsRouter from "../routes/metrics";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { computeBankFreshness } from "../lib/bankFreshness";
import { computeCashSignalDetailed } from "../lib/cashSignal";
import { householdTodayISO } from "../lib/householdClock";
import { buildMoneyPosition } from "../lib/moneyPosition";
import {
  MetricsDayError,
  computeMetricsForDay,
  loadStoredMetrics,
  writeDailyMetrics,
} from "../lib/metricsSnapshot";
import {
  handleMetricsSnapshot,
  metricsSendOptions,
  runMetricsSnapshot,
} from "../jobs/handlers/metricsSnapshot";
import { _emittedForTests } from "../jobs/emit";
import { QUEUES } from "../jobs/queues";

const router = express.Router();
router.use(metricsRouter);
const { request } = createTestApp(router);

const TODAY = householdTodayISO();
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
const CHECKING = `chk-${randomUUID()}`;
let checkingId = "";

async function wipe(hh: string): Promise<void> {
  await db.delete(householdMetricsDailyTable).where(eq(householdMetricsDailyTable.householdId, hh));
  await db.delete(debtMilestonesTable).where(eq(debtMilestonesTable.householdId, hh));
  await db.delete(debtProgressSnapshotsTable).where(eq(debtProgressSnapshotsTable.householdId, hh));
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, hh));
  await db.delete(debtBalanceHistoryTable).where(eq(debtBalanceHistoryTable.householdId, hh));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, hh));
}

async function addDebt(o: Partial<typeof debtsTable.$inferInsert> & { name: string }, hh = HH, user = OWNER) {
  const [d] = await db
    .insert(debtsTable)
    .values({ userId: user, householdId: hh, balance: "1000.00", originalBalance: "2000.00", apr: "0.2", minPayment: "50.00", type: "credit_card", ...o })
    .returning();
  return d!;
}

async function addSnap(debtId: string, asOf: string, o: Partial<typeof debtProgressSnapshotsTable.$inferInsert> = {}, hh = HH) {
  await db.insert(debtProgressSnapshotsTable).values({
    householdId: hh,
    debtId,
    asOf,
    balanceEffective: "1000.00",
    delta: "0.00",
    paymentsConfirmed: "0.00",
    interest: "0.00",
    fees: "0.00",
    newCharges: "0.00",
    credits: "0.00",
    unexplained: "0.00",
    ...o,
  });
}

const stored = async (hh: string, day: string) =>
  (await db.select().from(householdMetricsDailyTable).where(and(eq(householdMetricsDailyTable.householdId, hh), eq(householdMetricsDailyTable.asOf, day))));

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  await wipe(HH);
  await wipe(HH_OTHER);
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: OWNER,
      householdId: HH,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionSlug: "bank",
      lastSyncedAt: new Date(`${addDaysISO(TODAY, -3)}T15:00:00-05:00`),
    })
    .returning();
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values({ userId: OWNER, householdId: HH, itemId: item!.id, accountId: CHECKING, name: "Checking", type: "depository", subtype: "checking" })
    .returning();
  checkingId = chk!.id;
  await db.insert(forecastSettingsTable).values({
    userId: OWNER,
    householdId: HH,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "5000.00",
    bankSnapshotAt: new Date(`${addDaysISO(TODAY, -1)}T12:00:00-05:00`),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: checkingId,
  });
});

beforeEach(async () => {
  current = { user: OWNER, hh: () => HH };
  _emittedForTests.length = 0;
  await wipe(HH);
  await wipe(HH_OTHER);
});

afterAll(async () => {
  await wipe(HH);
  await wipe(HH_OTHER);
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
});

describe("writeDailyMetrics: today", () => {
  it("sums the stored snapshots, nets the debts, and ties the week to the money position", async () => {
    const a = await addDebt({ name: "Visa", balance: "1000.00" });
    const b = await addDebt({ name: "Store", balance: "500.00" });
    await addSnap(a.id, MONTH_START, { paymentsConfirmed: "-300.00", interest: "10.00", fees: "2.00", newCharges: "40.00" });
    await addSnap(b.id, TODAY, { paymentsConfirmed: "-150.00", newCharges: "5.00", transferPairTxnId: null, balanceEffective: "500.00" });
    await db.insert(debtMilestonesTable).values([
      { householdId: HH, key: "pct_25", label: "25% paid", achievedOn: MONTH_START },
      { householdId: HH, key: `debt_zero:${a.id}`, label: "x", achievedOn: addDaysISO(TODAY, 1) }, // after today: not counted
    ]);
    // Spending today: one unfiled row, one filed to the weekly allowance.
    await db.insert(transactionsTable).values([
      { userId: OWNER, householdId: HH, occurredOn: TODAY, amount: "-25.00", description: "COFFEE", source: "plaid:bank", plaidAccountId: CHECKING, plaidTransactionId: `p-${randomUUID()}` },
      { userId: OWNER, householdId: HH, occurredOn: TODAY, amount: "-10.00", description: "LUNCH", source: "plaid:bank", plaidAccountId: CHECKING, plaidTransactionId: `p-${randomUUID()}`, weeklyAllowance: true },
    ]);

    const r = await writeDailyMetrics(HH, OWNER, TODAY);
    expect(r.written).toBe(true);
    const [row] = await stored(HH, TODAY);
    expect(row!.version).toBe(METRICS_VERSION);
    const m = row!.metrics as DailyMetrics;
    expect(m).toMatchObject({
      totalDebtEffective: 1500,
      debtPaidDownGenuineMtd: 450,
      confirmedPaymentsMtd: 450,
      interestChargedMtd: 12,
      newChargesMtd: 45,
      milestonesReached: 1,
      reviewQueueSize: 0,
    });
    expect(m.dataCompleteness.accountsSilentDays).toBe(3);
    // The week figure IS the position's, not a second computation.
    const cash = await computeCashSignalDetailed(HH, OWNER, { horizonDays: 90 });
    const freshness = await computeBankFreshness(HH, OWNER);
    const position = await buildMoneyPosition(HH, OWNER, { cash, freshness });
    expect(m.discretionaryWtd).toBe(Number(position.spentWeekDiscretionary));
    expect(m.discretionaryWtd).toBeGreaterThanOrEqual(35);
    expect(m.discretionaryMtd).toBeGreaterThanOrEqual(m.discretionaryWtd!);
    expect(m.weeklyCap).toBe(position.weekCap == null ? null : Number(position.weekCap));
    expect(m.dataCompleteness.stale).toBe(freshness.stale);
  });

  it("refuses a day after today", async () => {
    await expect(writeDailyMetrics(HH, OWNER, addDaysISO(TODAY, 1))).rejects.toBeInstanceOf(MetricsDayError);
    expect(await stored(HH, addDaysISO(TODAY, 1))).toHaveLength(0);
  });

  it("upserts: a second run the same day is the same one row", async () => {
    await addDebt({ name: "Visa" });
    await writeDailyMetrics(HH, OWNER, TODAY);
    const first = (await stored(HH, TODAY))[0]!;
    await writeDailyMetrics(HH, OWNER, TODAY);
    const rows = await stored(HH, TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.computedAt.getTime()).toBeGreaterThanOrEqual(first.computedAt.getTime());
  });
});

describe("definition version", () => {
  const DAY = addDaysISO(TODAY, -5);

  it("replaces a row written under an older definition", async () => {
    await db.insert(householdMetricsDailyTable).values({ householdId: HH, asOf: DAY, version: METRICS_VERSION - 1, metrics: { old: true } });
    const r = await writeDailyMetrics(HH, OWNER, DAY);
    expect(r.written).toBe(true);
    const [row] = await stored(HH, DAY);
    expect(row!.version).toBe(METRICS_VERSION);
    expect(row!.metrics).not.toHaveProperty("old");
  });

  it("never overwrites a row written under a newer definition", async () => {
    await db.insert(householdMetricsDailyTable).values({ householdId: HH, asOf: DAY, version: METRICS_VERSION + 1, metrics: { newer: true } });
    const r = await writeDailyMetrics(HH, OWNER, DAY);
    expect(r.written).toBe(false);
    const [row] = await stored(HH, DAY);
    expect(row!.version).toBe(METRICS_VERSION + 1);
    expect(row!.metrics).toEqual({ newer: true });
  });
});

describe("a past day is reproducible", () => {
  // Same month for the flows to land in one window; a fixed past month avoids
  // depending on today's date.
  const DAY = "2026-08-20";

  it("recomputing it from stored snapshots gives the same numbers after everything else moved", async () => {
    const a = await addDebt({ name: "Visa", balance: "1000.00" });
    const b = await addDebt({ name: "Store", balance: "400.00" });
    await addSnap(a.id, "2026-08-03", { paymentsConfirmed: "-200.00", interest: "9.99", balanceEffective: "1100.00" });
    await addSnap(a.id, DAY, { paymentsConfirmed: "-75.50", newCharges: "12.00", balanceEffective: "1036.49" });
    await addSnap(b.id, DAY, { paymentsConfirmed: "-60.00", transferPairTxnId: randomUUID(), balanceEffective: "420.00" });
    await db.insert(debtMilestonesTable).values({ householdId: HH, key: "pct_25", label: "25%", achievedOn: "2026-08-10" });

    await writeDailyMetrics(HH, OWNER, DAY);
    const before = (await stored(HH, DAY))[0]!.metrics as DailyMetrics;
    expect(before).toMatchObject({
      totalDebtEffective: 1456.49, // the snapshots' balances: 1036.49 + 420.00
      debtPaidDownGenuineMtd: 275.5, // 200 + 75.50; the transfer-marked 60.00 is out
      confirmedPaymentsMtd: 335.5,
      interestChargedMtd: 9.99,
      newChargesMtd: 12,
      milestonesReached: 1,
      // Not an observation anyone made that day: null, never today's figure.
      discretionaryWtd: null,
      uncategorizedCount: null,
      reviewQueueSize: null,
    });

    // Everything afterwards moves: balances, later snapshots, later milestones.
    await db.update(debtsTable).set({ balance: "1.00" }).where(eq(debtsTable.householdId, HH));
    await addSnap(a.id, "2026-08-25", { paymentsConfirmed: "-999.00", balanceEffective: "37.49" });
    await db.insert(debtMilestonesTable).values({ householdId: HH, key: "pct_50", label: "50%", achievedOn: "2026-08-28" });

    await writeDailyMetrics(HH, OWNER, DAY);
    const after = (await stored(HH, DAY))[0]!.metrics as DailyMetrics;
    expect(after).toEqual(before);
    // And the read-only computation agrees without writing anything.
    expect(await computeMetricsForDay(HH, OWNER, DAY)).toEqual(before);
  });

  it("keeps the observations the day's own row recorded", async () => {
    const a = await addDebt({ name: "Visa" });
    await addSnap(a.id, DAY, { paymentsConfirmed: "-10.00" });
    const observed = {
      totalDebtEffective: 777.77,
      discretionaryWtd: 12.5,
      discretionaryMtd: 99,
      weeklyCap: 250,
      withinPlan: "yes",
      uncategorizedCount: 6,
      reviewQueueSize: 2,
      dataCompleteness: { stale: false, staleReason: null, accountsSilentDays: 1 },
    };
    await db.insert(householdMetricsDailyTable).values({
      householdId: HH,
      asOf: DAY,
      version: METRICS_VERSION,
      metrics: { ...observed, debtPaidDownGenuineMtd: 0, confirmedPaymentsMtd: 0, interestChargedMtd: 0, newChargesMtd: 0, milestonesReached: 0 },
    });
    await writeDailyMetrics(HH, OWNER, DAY);
    const m = (await stored(HH, DAY))[0]!.metrics as DailyMetrics;
    expect(m).toMatchObject(observed);
    expect(m.confirmedPaymentsMtd).toBe(10); // the flow is refreshed from the snapshots
    expect(await loadStoredMetrics(HH, DAY)).toMatchObject({ version: METRICS_VERSION });
  });
});

describe("the nightly job", () => {
  it("runs twice and leaves one metrics row, one snapshot row per debt, one set of milestones", async () => {
    const d = await addDebt({ name: "Visa", balance: "1000.00", originalBalance: "1200.00" }); // 16.7% paid: no milestone
    await db.insert(debtBalanceHistoryTable).values({ userId: OWNER, householdId: HH, debtId: d.id, recordedOn: addDaysISO(TODAY, -1), balance: "1100.00" });
    await db.insert(debtBalanceHistoryTable).values({ userId: OWNER, householdId: HH, debtId: d.id, recordedOn: TODAY, balance: "1000.00" });
    const one = await runMetricsSnapshot(HH, OWNER);
    const two = await runMetricsSnapshot(HH, OWNER);
    expect(one).toMatchObject({ asOf: TODAY, snapshotsWritten: 1, metricsWritten: true });
    expect(two.snapshotsWritten).toBe(1);
    expect(two.milestonesInserted).toEqual([]);
    expect(await stored(HH, TODAY)).toHaveLength(1);
    const snaps = await db.select().from(debtProgressSnapshotsTable).where(eq(debtProgressSnapshotsTable.householdId, HH));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ balanceEffective: "1000.00", delta: "-100.00" });
    const m = (await stored(HH, TODAY))[0]!.metrics as DailyMetrics;
    expect(m.totalDebtEffective).toBe(1000);
  });

  it("handleMetricsSnapshot: a per-household job runs the pass; the fan-out enqueues one singleton per household", async () => {
    await addDebt({ name: "Visa" });
    await addDebt({ name: "Other Visa" }, HH_OTHER, OTHER);
    const out = await handleMetricsSnapshot([
      { id: "j1", data: { householdId: HH, ownerUserId: OWNER } } as never,
      { id: "j2", data: { fanout: true } } as never,
      { id: "j3", data: {} } as never,
    ]);
    expect(out).toMatchObject({ households: 1 });
    expect(await stored(HH, TODAY)).toHaveLength(1);
    const mine = _emittedForTests.filter((e) => e.queue === QUEUES.metricsSnapshot);
    for (const id of [HH, HH_OTHER]) {
      const e = mine.find((x) => (x.data as { householdId?: string }).householdId === id);
      expect(e, `fan-out reached ${id}`).toBeTruthy();
      expect(e!.opts).toMatchObject({ singletonKey: `metrics:${id}:${TODAY}` });
    }
    expect(metricsSendOptions(HH, TODAY).singletonKey).toBe(`metrics:${HH}:${TODAY}`);
  });
});

describe("GET /metrics", () => {
  async function seedRows() {
    for (const [hh, day, marker] of [
      [HH, addDaysISO(TODAY, -2), 1],
      [HH, addDaysISO(TODAY, -1), 2],
      [HH, TODAY, 3],
      [HH_OTHER, TODAY, 99],
    ] as const) {
      await db.insert(householdMetricsDailyTable).values({ householdId: hh, asOf: day, metrics: { milestonesReached: marker } });
    }
  }

  it("returns this household's rows oldest first, with the latest on or before `to`", async () => {
    await seedRows();
    const { status, json } = await request("GET", `/metrics?from=${addDaysISO(TODAY, -2)}&to=${TODAY}`);
    expect(status).toBe(200);
    const body = json as { rows: Array<{ asOf: string; metrics: { milestonesReached: number } }>; latest: { asOf: string } | null };
    expect(body.rows.map((r) => r.metrics.milestonesReached)).toEqual([1, 2, 3]);
    expect(body.latest?.asOf).toBe(TODAY);
  });

  it("is scoped to the household: the other household's row never appears", async () => {
    await seedRows();
    current = { user: OTHER, hh: () => HH_OTHER };
    const { json } = await request("GET", `/metrics?from=${TODAY}&to=${TODAY}`);
    const body = json as { rows: Array<{ metrics: { milestonesReached: number } }> };
    expect(body.rows.map((r) => r.metrics.milestonesReached)).toEqual([99]);
  });

  it("latest can be older than `from`; an empty range is rows [] and latest null with no history", async () => {
    await seedRows();
    const old = await request("GET", `/metrics?from=${addDaysISO(TODAY, -30)}&to=${addDaysISO(TODAY, -10)}`);
    expect((old.json as { rows: unknown[]; latest: unknown }).rows).toEqual([]);
    expect((old.json as { latest: unknown }).latest).toBeNull();
    const later = await request("GET", `/metrics?from=${addDaysISO(TODAY, 1)}&to=${addDaysISO(TODAY, 5)}`);
    expect((later.json as { rows: unknown[] }).rows).toEqual([]);
    expect((later.json as { latest: { asOf: string } }).latest.asOf).toBe(TODAY);
  });

  it("defaults to the last 30 days and caps a range at 93 days", async () => {
    const d = await request("GET", "/metrics");
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ from: addDaysISO(TODAY, -29), to: TODAY });
    const edge = await request("GET", `/metrics?from=${addDaysISO(TODAY, -92)}&to=${TODAY}`);
    expect(edge.status).toBe(200); // 93 days inclusive
    const over = await request("GET", `/metrics?from=${addDaysISO(TODAY, -93)}&to=${TODAY}`);
    expect(over.status).toBe(400);
  });

  it("rejects a malformed or inverted range", async () => {
    expect((await request("GET", "/metrics?from=10/01/2026")).status).toBe(400);
    expect((await request("GET", "/metrics?from=2026-02-30&to=2026-03-01")).status).toBe(400);
    expect((await request("GET", `/metrics?from=${TODAY}&to=${addDaysISO(TODAY, -1)}`)).status).toBe(400);
  });

  it("writes nothing", async () => {
    const before = await db.select().from(householdMetricsDailyTable).where(eq(householdMetricsDailyTable.householdId, HH));
    await request("GET", "/metrics");
    const after = await db.select().from(householdMetricsDailyTable).where(eq(householdMetricsDailyTable.householdId, HH));
    expect(after).toEqual(before);
  });
});

describe("POST /metrics/recompute", () => {
  it("is owner-only, validates the date, refuses the future, and runs the pass", async () => {
    current = { user: OTHER, hh: () => HH_OTHER };
    expect((await request("POST", "/metrics/recompute")).status).toBe(403);
    current = { user: OWNER, hh: () => HH };
    expect((await request("POST", "/metrics/recompute?date=10/07/2026")).status).toBe(400);
    expect((await request("POST", `/metrics/recompute?date=${addDaysISO(TODAY, 1)}`)).status).toBe(400);
    await addDebt({ name: "Visa" });
    const ok = await request("POST", `/metrics/recompute?date=${TODAY}`);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ asOf: TODAY, metricsWritten: true });
    expect(await stored(HH, TODAY)).toHaveLength(1);
    const again = await request("POST", "/metrics/recompute");
    expect(again.status).toBe(200);
    expect(await stored(HH, TODAY)).toHaveLength(1);
  });
});
