import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  debtMilestonesTable,
  debtProgressSnapshotsTable,
  debtsTable,
  householdMetricsDailyTable,
  plaidItemsTable,
} from "@workspace/db";
import {
  METRICS_VERSION,
  allowanceRowOf,
  classifyMovement,
  computeDailyMetrics,
  keepPointInTime,
  monthStartOf,
  weekBounds,
  type DailyMetrics,
  type DailyMetricsInputs,
  type MetricsSpendRow,
} from "@workspace/avalanche-core";
import { computeBankFreshness } from "./bankFreshness";
import { computeCashSignalDetailed } from "./cashSignal";
import { listReviewQueue } from "./categorizer/review";
import { withPendingPayments } from "./debtPending";
import { householdDayOf, householdTodayISO } from "./householdClock";
import { loadMoneyContext, loadMovementRows } from "./moneyContext";
import {
  POSITION_HORIZON_DAYS,
  buildMoneyPosition,
  tier2PairedTxnIdsOf,
} from "./moneyPosition";
import { TRACKING_START, buildSpendingFacts } from "./spendingFacts";
import { loadGoalsWithCurrent } from "./goals";

// (PR-E) THE DAILY METRICS LOADER: reads what `computeDailyMetrics` (avalanche-core)
// sums, and upserts one `household_metrics_daily` row per household per day.
//
//   - today        every input is live: the money position, the month's spend, the
//                  review queue, the bank's freshness.
//   - a past day   the debt flows come from the STORED debt progress snapshots and
//                  milestones, so recomputing the day gives the same numbers; the
//                  point-in-time fields are kept from the row stored that day (or
//                  stay null when there is none) — never refilled from today.
//   - the future   refused.
//
// The upsert only replaces a row written under the same or an older metric
// DEFINITION version (`METRICS_VERSION`).
//
// ⚠️ READ-ONLY apart from the one upsert. No Plaid call, no model call.

export { METRICS_VERSION };

export class MetricsDayError extends Error {}

/** Where a household day sits relative to today (ISO strings compare as dates). */
function classifyDayOf(day: string, today: string): "past" | "today" | "future" {
  return day < today ? "past" : day > today ? "future" : "today";
}

async function snapshotInputs(householdId: string, asOfDay: string) {
  const monthStart = monthStartOf(asOfDay);
  const [snapshotsMtd, latestPerDebt, milestones] = await Promise.all([
    db
      .select({
        asOf: debtProgressSnapshotsTable.asOf,
        paymentsConfirmed: debtProgressSnapshotsTable.paymentsConfirmed,
        interest: debtProgressSnapshotsTable.interest,
        fees: debtProgressSnapshotsTable.fees,
        newCharges: debtProgressSnapshotsTable.newCharges,
        transferPairTxnId: debtProgressSnapshotsTable.transferPairTxnId,
      })
      .from(debtProgressSnapshotsTable)
      .where(
        and(
          eq(debtProgressSnapshotsTable.householdId, householdId),
          gte(debtProgressSnapshotsTable.asOf, monthStart),
          lte(debtProgressSnapshotsTable.asOf, asOfDay),
        ),
      ),
    db
      .selectDistinctOn([debtProgressSnapshotsTable.debtId], {
        debtId: debtProgressSnapshotsTable.debtId,
        balance: debtProgressSnapshotsTable.balanceEffective,
      })
      .from(debtProgressSnapshotsTable)
      .where(
        and(
          eq(debtProgressSnapshotsTable.householdId, householdId),
          lte(debtProgressSnapshotsTable.asOf, asOfDay),
        ),
      )
      .orderBy(debtProgressSnapshotsTable.debtId, sql`${debtProgressSnapshotsTable.asOf} desc`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(debtMilestonesTable)
      .where(
        and(eq(debtMilestonesTable.householdId, householdId), lte(debtMilestonesTable.achievedOn, asOfDay)),
      ),
  ]);
  return { snapshotsMtd, latestPerDebt, milestonesReached: Number(milestones[0]?.n ?? 0) };
}

/** Rows classified for the position's own rule: [{ coverage, spend }] by date. */
async function liveSpend(
  householdId: string,
  ownerUserId: string,
  today: string,
  tier2: Set<string>,
): Promise<{ weekRows: MetricsSpendRow[]; monthRows: MetricsSpendRow[] }> {
  const week = weekBounds(today);
  const clamp = (d: string) => (d < TRACKING_START ? TRACKING_START : d);
  const weekFrom = clamp(week.start);
  const monthFrom = clamp(monthStartOf(today));
  const from = weekFrom < monthFrom ? weekFrom : monthFrom;
  const to = week.end > today ? week.end : today;
  const money = await loadMoneyContext(householdId, { start: from, end: to }, { tier2PairedTxnIds: tier2 });
  const rows = await loadMovementRows(householdId, from, to, money);
  // (B6) `allowanceRowOf`: the position's own row, refunds netted on their account.
  const asRow = (r: (typeof rows)[number]): MetricsSpendRow => allowanceRowOf(r, classifyMovement(r, money));
  return {
    weekRows: rows.filter((r) => r.occurredOn >= weekFrom && r.occurredOn <= week.end).map(asRow),
    monthRows: rows.filter((r) => r.occurredOn >= monthFrom && r.occurredOn <= today).map(asRow),
  };
}

export async function loadStoredMetrics(
  householdId: string,
  asOfDay: string,
): Promise<{ version: number; metrics: DailyMetrics } | null> {
  const [row] = await db
    .select({ version: householdMetricsDailyTable.version, metrics: householdMetricsDailyTable.metrics })
    .from(householdMetricsDailyTable)
    .where(and(eq(householdMetricsDailyTable.householdId, householdId), eq(householdMetricsDailyTable.asOf, asOfDay)));
  return row ? { version: row.version, metrics: row.metrics as DailyMetrics } : null;
}

/** Assemble the day's metrics without writing them. */
export async function computeMetricsForDay(
  householdId: string,
  ownerUserId: string,
  asOfDay: string,
): Promise<DailyMetrics> {
  const today = householdTodayISO();
  if (classifyDayOf(asOfDay, today) === "future") {
    throw new MetricsDayError(`cannot compute metrics for ${asOfDay}: it is after today (${today})`);
  }
  const snap = await snapshotInputs(householdId, asOfDay);
  const base: DailyMetricsInputs = {
    asOf: asOfDay,
    debts: snap.latestPerDebt.length > 0 ? snap.latestPerDebt.map((d) => ({ balance: d.balance })) : null,
    snapshotsMtd: snap.snapshotsMtd,
    milestonesReached: snap.milestonesReached,
    position: null,
    weekRows: null,
    monthRows: null,
    uncategorizedCount: null,
    reviewQueueSize: null,
    freshness: null,
    itemLastSyncedDays: null,
  };

  if (classifyDayOf(asOfDay, today) === "past") {
    const stored = await loadStoredMetrics(householdId, asOfDay);
    return keepPointInTime(computeDailyMetrics(base), stored?.metrics ?? null);
  }

  // Today: everything live, off the same reads the spine makes.
  const cashRead = computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS });
  const freshnessRead = computeBankFreshness(householdId, ownerUserId);
  const [cash, freshness, debtRows, items, queue] = await Promise.all([
    cashRead,
    freshnessRead,
    db.select().from(debtsTable).where(eq(debtsTable.householdId, householdId)),
    db
      .select({ lastSyncedAt: plaidItemsTable.lastSyncedAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.householdId, householdId)),
    listReviewQueue(householdId, 1),
  ]);
  const [position, netted, spend, facts, goals] = await Promise.all([
    buildMoneyPosition(householdId, ownerUserId, { cash, freshness }),
    withPendingPayments(householdId, debtRows),
    liveSpend(householdId, ownerUserId, today, tier2PairedTxnIdsOf(cash.ledger)),
    buildSpendingFacts(householdId, monthStartOf(today), today),
    loadGoalsWithCurrent(householdId, ownerUserId),
  ]);
  return computeDailyMetrics({
    ...base,
    debts: netted.length > 0 ? netted : null,
    position: { weekCap: position.weekCap, withinPlan: position.withinPlan },
    weekRows: spend.weekRows,
    monthRows: spend.monthRows,
    uncategorizedCount: facts.uncategorized.transactionCount,
    reviewQueueSize: queue.total,
    freshness: { stale: freshness.stale, staleReason: freshness.staleReason },
    itemLastSyncedDays: items.map((i) => (i.lastSyncedAt ? householdDayOf(i.lastSyncedAt) : null)),
    goals,
  });
}

/**
 * Compute and upsert the day's row. Returns whether a row was written (false
 * only when a newer-definition row already stands).
 */
export async function writeDailyMetrics(
  householdId: string,
  ownerUserId: string,
  asOfDay: string,
): Promise<{ asOf: string; written: boolean; metrics: DailyMetrics }> {
  const metrics = await computeMetricsForDay(householdId, ownerUserId, asOfDay);
  const rows = await db
    .insert(householdMetricsDailyTable)
    .values({ householdId, asOf: asOfDay, version: METRICS_VERSION, metrics })
    .onConflictDoUpdate({
      target: [householdMetricsDailyTable.householdId, householdMetricsDailyTable.asOf],
      set: { version: METRICS_VERSION, metrics, computedAt: new Date() },
      setWhere: sql`${householdMetricsDailyTable.version} <= excluded.version`,
    })
    .returning({ id: householdMetricsDailyTable.id });
  return { asOf: asOfDay, written: rows.length > 0, metrics };
}
