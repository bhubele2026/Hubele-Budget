// (PR-E) THE DAILY PROGRESS METRICS — pure maths over inputs the server loader
// assembles. No clock, no I/O, no model: every field is a deterministic sum or
// a copy of a figure another function already computed.
//
//   debt flows     month-to-date sums over the debt progress snapshots
//                  (`debt_progress_snapshots`, written by PR-D): reproducible for
//                  any past day because the snapshots are stored.
//   point in time  the position's week figures, review counts and the bank's
//                  freshness are observations AS OF THE RUN. They are live for
//                  today and, on a recompute of a past day, kept from the stored
//                  row (`keepPointInTime`) — never rewritten from today's data.
//
// Money is summed in integer cents so the sums are exact.

import { effectiveDebtBalance } from "./index";

export const METRICS_VERSION = 1;

export type MetricsWithinPlan = "over" | "tight" | "yes";

/** One `debt_progress_snapshots` row, as the metrics read it (signs as stored: payments negative). */
export interface MetricsSnapshotRow {
  asOf: string;
  paymentsConfirmed: number | string;
  interest: number | string;
  fees: number | string;
  newCharges: number | string;
  transferPairTxnId: string | null;
}

/** A week row as the money position reads it (`PositionWeekRow`). */
export interface MetricsSpendRow {
  coverage: string;
  spend: number | string;
}

export interface DailyMetricsInputs {
  /** The household day the metrics describe, YYYY-MM-DD. */
  asOf: string;
  /** The debts' balances (with any pending payments) or null when there is nothing to total. */
  debts: Array<{ balance: number | string; pendingPaymentTotal?: number | string | null }> | null;
  /** Snapshot rows with `asOf` in the month containing `asOf`, up to and including it. */
  snapshotsMtd: MetricsSnapshotRow[];
  milestonesReached: number;
  /** The money position's cap and verdict; null when the day is not live. */
  position: { weekCap: number | string | null; withinPlan: MetricsWithinPlan | null } | null;
  weekRows: MetricsSpendRow[] | null;
  monthRows: MetricsSpendRow[] | null;
  uncategorizedCount: number | null;
  reviewQueueSize: number | null;
  freshness: { stale: boolean; staleReason: string | null } | null;
  /** Each Plaid item's last successful sync as a household day (null = never). */
  itemLastSyncedDays: Array<string | null> | null;
}

export interface DailyMetrics {
  /** Σ effective (netted) debt balances; null when there is no debt to total. */
  totalDebtEffective: number | null;
  /** Σ payments confirmed by the bank this month, transfer-marked days excluded (reads low, never high). */
  debtPaidDownGenuineMtd: number;
  /** Interest and fees the creditors charged this month. */
  interestChargedMtd: number;
  /** New purchases on the debts this month. */
  newChargesMtd: number;
  discretionaryWtd: number | null;
  discretionaryMtd: number | null;
  weeklyCap: number | null;
  withinPlan: MetricsWithinPlan | null;
  /** Σ payments confirmed by the bank this month, transfers included. */
  confirmedPaymentsMtd: number;
  milestonesReached: number;
  uncategorizedCount: number | null;
  reviewQueueSize: number | null;
  dataCompleteness: {
    stale: boolean | null;
    staleReason: string | null;
    accountsSilentDays: number | null;
  };
}

/** The point-in-time fields: what a past-day recompute keeps from the stored row. */
export const POINT_IN_TIME_FIELDS = [
  "totalDebtEffective",
  "discretionaryWtd",
  "discretionaryMtd",
  "weeklyCap",
  "withinPlan",
  "uncategorizedCount",
  "reviewQueueSize",
  "dataCompleteness",
] as const satisfies ReadonlyArray<keyof DailyMetrics>;

const cents = (v: number | string | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const money = (c: number): number => Math.round(c) / 100;

/** First day of the month containing `iso`. */
export function monthStartOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function dayNumber(iso: string): number {
  return Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);
}

/**
 * What counts against the weekly cap — the money position's own rule
 * (`computePosition`): filed to the weekly allowance, plus spending not yet
 * filed. In cents.
 */
export function discretionaryCents(rows: readonly MetricsSpendRow[]): number {
  let c = 0;
  for (const r of rows) {
    if (r.coverage === "allowance_weekly" || r.coverage === "needs_classification") c += cents(r.spend);
  }
  return c;
}

/** The longest any Plaid item has gone without a good sync, in whole days; null with none to judge. */
export function accountsSilentDaysOf(asOf: string, lastSyncedDays: ReadonlyArray<string | null>): number | null {
  let out: number | null = null;
  for (const d of lastSyncedDays) {
    if (!d) continue;
    const gap = Math.max(0, dayNumber(asOf) - dayNumber(d));
    if (out == null || gap > out) out = gap;
  }
  return out;
}

export function computeDailyMetrics(inputs: DailyMetricsInputs): DailyMetrics {
  const monthStart = monthStartOf(inputs.asOf);
  let paid = 0;
  let paidGenuine = 0;
  let interest = 0;
  let charges = 0;
  // A row counts once per debt-day; ignore anything outside the month window.
  for (const s of inputs.snapshotsMtd) {
    if (s.asOf < monthStart || s.asOf > inputs.asOf) continue;
    const pay = Math.abs(cents(s.paymentsConfirmed));
    paid += pay;
    if (s.transferPairTxnId == null) paidGenuine += pay;
    interest += cents(s.interest) + cents(s.fees);
    charges += cents(s.newCharges);
  }

  let total: number | null = null;
  if (inputs.debts && inputs.debts.length > 0) {
    total = 0;
    for (const d of inputs.debts) total += cents(effectiveDebtBalance(d));
    total = money(total);
  }

  const capNum = inputs.position?.weekCap == null ? null : Number(inputs.position.weekCap);
  return {
    totalDebtEffective: total,
    debtPaidDownGenuineMtd: money(paidGenuine),
    interestChargedMtd: money(interest),
    newChargesMtd: money(charges),
    discretionaryWtd: inputs.weekRows ? money(discretionaryCents(inputs.weekRows)) : null,
    discretionaryMtd: inputs.monthRows ? money(discretionaryCents(inputs.monthRows)) : null,
    weeklyCap: capNum != null && Number.isFinite(capNum) ? capNum : null,
    withinPlan: inputs.position?.withinPlan ?? null,
    confirmedPaymentsMtd: money(paid),
    milestonesReached: Math.max(0, Math.floor(inputs.milestonesReached)),
    uncategorizedCount: inputs.uncategorizedCount,
    reviewQueueSize: inputs.reviewQueueSize,
    dataCompleteness: {
      stale: inputs.freshness ? inputs.freshness.stale : null,
      staleReason: inputs.freshness ? inputs.freshness.staleReason : null,
      accountsSilentDays: inputs.itemLastSyncedDays ? accountsSilentDaysOf(inputs.asOf, inputs.itemLastSyncedDays) : null,
    },
  };
}

/**
 * A recompute of a PAST day: take the debt flows from the fresh computation
 * (they come from stored snapshots, so they are reproducible) and the
 * point-in-time fields from the row stored on the day. With no stored row they
 * stay as computed (null when the caller supplied no live inputs) — the past is
 * never filled from today's data.
 */
export function keepPointInTime(fresh: DailyMetrics, stored: Partial<DailyMetrics> | null): DailyMetrics {
  if (!stored) return fresh;
  const out: DailyMetrics = { ...fresh };
  for (const k of POINT_IN_TIME_FIELDS) {
    if (k in stored && stored[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = stored[k];
  }
  return out;
}
