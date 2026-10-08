// ⭐ (PR-B1) THE MONEY POSITION'S SERVER LOADER — one read of everything
// `computePosition` (avalanche-core) needs, and nothing computed here.
//
// `GET /money/position` and the spine's `position` both come from
// `buildMoneyPosition`, so the two can never disagree
// (`spineParity.integration.test.ts` asserts it to the cent).
//
//   the curve      `computeCashSignalDetailed` — the SAME call the spine makes
//                  for its forecast fields (horizon 90), and the SAME ledger:
//                  its daily balances, the plans and rows on it, its status
//                  and buffer. Nothing is re-walked.
//   the payday     the curve's income plans + the household's income items
//                  (the largest active one sets the 25% threshold).
//   estimates      each plan on the curve carries its item's `amount_kind`.
//   the week       the current Sunday–Saturday household week, read through
//                  `loadMoneyContext` (PR-H's loader — this is its first
//                  production caller) with the ledger's tier-2 off-curve pairs
//                  as `tier2PairedTxnIds`, classified by `classifyMovement` and
//                  sized by `allowanceRowOf` (B6: a refund nets its account).
//   the cap        `allowance_plans` through `everydayPlanFromRows`, with the
//                  week's override from `preferences.weeklyAllowanceOverrides`.
//   freshness      `computeBankFreshness` — the spine's own bank verdict.
//   reserves       (PR-C) `reservesHeld` — money the active goals hold back in
//                  checking (`lib/goals.ts`); a goal backed by a savings
//                  account never enters it.
//   adjustments    (V5) `plan_adjustments` rows for THIS week (it lowers
//                  `remainingWeek`) and NEXT week (an assumption only) — the
//                  household's own carry-over choice. A plain SELECT: this
//                  module never writes the table, and must not import the
//                  week-adjustment writer — the agent reads the position, and
//                  nothing it reaches may write an adjustment (the V5 laws
//                  test scans for it).
//
// ⚠️ READ-ONLY. No write, no Plaid call: it sits on the spine's path.

import { and, eq, inArray } from "drizzle-orm";
import { db, planAdjustmentsTable, recurringItemsTable } from "@workspace/db";
import {
  addDaysISO,
  allowanceRowOf,
  classifyMovement,
  computePosition,
  everydayPlanFromRows,
  weekBounds,
  type MoneyPosition,
  type PositionEvent,
  type PositionInputs,
} from "@workspace/avalanche-core";
import { computeCashSignalDetailed, type DetailedCashSignal } from "./cashSignal";
import { computeBankFreshness, type BankFreshness } from "./bankFreshness";
import { loadMoneyContext, loadMovementRows, type MoneyContextSupersede } from "./moneyContext";
import { loadAllowancePlans, planRowsOf } from "./allowancePlans";
import { TRACKING_START } from "./spendingFacts";
import { reservesHeld as loadReservesHeld } from "./goals";

/** The horizon the spine and the Forecast tile ask for; the position reads the same curve. */
export const POSITION_HORIZON_DAYS = 90;

export interface BuildMoneyPositionOptions {
  /** The spine's own cash-signal read, so one request builds one ledger. */
  cash?: Promise<DetailedCashSignal> | DetailedCashSignal;
  /** The spine's own freshness read. */
  freshness?: Promise<BankFreshness> | BankFreshness;
  /**
   * The spine's own pending pairs: a `findSupersededPendingForRange` answer
   * whose range covers this household week (the spine reads one for its month
   * and week windows together). Omitted, `loadMoneyContext` reads them for the
   * week.
   */
  supersede?: Promise<MoneyContextSupersede> | MoneyContextSupersede;
}

/** The ledger's events on the curve, as the position reads them. */
export function positionEventsOf(ledger: DetailedCashSignal["ledger"]): PositionEvent[] {
  return ledger.items.map((it) =>
    it.kind === "plan"
      ? {
          date: it.date,
          amount: it.amount,
          kind: it.eventKind,
          itemId: it.itemId,
          label: it.label,
          assumption: it.assumption ?? null,
          amountKind: it.amountKind,
        }
      : { date: it.date, amount: it.amount, kind: "actual" as const, itemId: it.txnId, label: "" },
  );
}

/**
 * The rows a tier-2 pair matches to a bill and that pair took off the curve —
 * the bill is already in the plan, so `classifyMovement` files an unflagged
 * one `bill_matched` rather than as spending to file.
 */
export function tier2PairedTxnIdsOf(ledger: DetailedCashSignal["ledger"]): Set<string> {
  return new Set(ledger.matches.filter((m) => m.tier === 2 && m.offCurve).map((m) => m.txnId));
}

/** (V5) A `plan_adjustments` row as the position and the ways back read it. */
export interface WeekAdjustmentRead {
  weekStart: string;
  /** Whole cents, negative. */
  amountCents: number;
  reason: string | null;
}

/** (PR-F1) One read of the household: `computePosition`'s exact inputs, and the curve they came from. */
export interface MoneyPositionRead {
  inputs: PositionInputs;
  cash: DetailedCashSignal;
  /**
   * (V5) Next week as the same read sees it: its Sunday, its cap in whole
   * cents (null with none — the same $0-is-no-cap rule as this week) and the
   * carry-over already applied to it. Read for `GET /money/ways-back`.
   */
  nextWeek: { start: string; capCents: number | null; adjustment: WeekAdjustmentRead | null };
}

/**
 * (V5) The household's carry-over rows for the given weeks (read-only).
 * Only kind `carry_over` exists; the CHECKs keep every amount negative.
 */
export async function readWeekAdjustments(
  householdId: string,
  weekStarts: readonly string[],
): Promise<Map<string, WeekAdjustmentRead>> {
  const rows = await db
    .select({
      weekStart: planAdjustmentsTable.weekStart,
      amountCents: planAdjustmentsTable.amountCents,
      reason: planAdjustmentsTable.reason,
    })
    .from(planAdjustmentsTable)
    .where(
      and(
        eq(planAdjustmentsTable.householdId, householdId),
        eq(planAdjustmentsTable.kind, "carry_over"),
        inArray(planAdjustmentsTable.weekStart, [...weekStarts]),
      ),
    );
  return new Map(rows.map((r) => [r.weekStart, r]));
}

/**
 * (PR-F1) Everything `buildMoneyPosition` reads, before `computePosition` runs:
 * "Can we afford this?" (`afford.ts`) re-runs the position on these SAME
 * inputs, so the two can never read the household differently.
 * `buildMoneyPosition` is `computePosition(loadPositionInputs(...).inputs)` —
 * `GET /money/position` is byte-identical (afford.integration.test.ts).
 */
export async function loadPositionInputs(
  householdId: string,
  ownerUserId: string,
  opts: BuildMoneyPositionOptions = {},
): Promise<MoneyPositionRead> {
  const cashRead = Promise.resolve(
    opts.cash ?? computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS }),
  );
  const freshnessRead = Promise.resolve(opts.freshness ?? computeBankFreshness(householdId, ownerUserId));
  const [{ signal, ledger }, freshness, incomeRows, planRows, reserves, adjustments] = await Promise.all([
    cashRead,
    freshnessRead,
    db
      .select({
        id: recurringItemsTable.id,
        kind: recurringItemsTable.kind,
        amount: recurringItemsTable.amount,
        frequency: recurringItemsTable.frequency,
        active: recurringItemsTable.active,
      })
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.householdId, householdId)),
    loadAllowancePlans(householdId),
    loadReservesHeld(householdId),
    // (V5) This week and next, on the ledger's today (read below with the curve).
    cashRead.then(({ ledger: l }) => {
      const start = weekBounds(l.todayISO).start;
      return readWeekAdjustments(householdId, [start, addDaysISO(start, 7)]);
    }),
  ]);

  // The household week on the ledger's own today, clamped to the tracking
  // start exactly as the spine's `spentWeek` is (`buildSpendingFacts`).
  const todayISO = ledger.todayISO;
  const week = weekBounds(todayISO);
  const from = week.start < TRACKING_START ? TRACKING_START : week.start;
  const money = await loadMoneyContext(
    householdId,
    { start: from, end: week.end },
    {
      tier2PairedTxnIds: tier2PairedTxnIdsOf(ledger),
      ...(opts.supersede ? { supersede: await opts.supersede } : {}),
    },
  );
  const rows = await loadMovementRows(householdId, from, week.end, money);
  // (B6) `allowanceRowOf`: a refund carries the coverage it nets and a negative
  // amount, and its account, so `computePosition` nets it there.
  const weekRows = rows.map((r) => allowanceRowOf(r, classifyMovement(r, money)));

  const plan = everydayPlanFromRows(week.start, planRowsOf(planRows), money.settings.weeklyAllowanceOverrides);
  // (Lead's ruling on PR-B1 Q2) A $0 week — no plan, a $0 plan, or a $0
  // override — means no cap was set: null, never a $0 cap.
  const weekCap = plan.weeklySource === "none" || plan.weeklyCents === 0 ? null : plan.weeklyCents / 100;
  // (V5) The household's own carry-over: this week's lowers the week; next
  // week's is said, not counted.
  const nextStart = addDaysISO(week.start, 7);
  const thisAdj = adjustments.get(week.start) ?? null;
  const nextAdj = adjustments.get(nextStart) ?? null;
  const nextPlan = everydayPlanFromRows(nextStart, planRowsOf(planRows), money.settings.weeklyAllowanceOverrides);
  const nextCapCents = nextPlan.weeklySource === "none" || nextPlan.weeklyCents === 0 ? null : nextPlan.weeklyCents;

  const inputs: PositionInputs = {
    todayISO,
    daily: signal.daily ?? [],
    events: positionEventsOf(ledger),
    incomeItems: incomeRows
      .filter((r) => r.kind === "income")
      .map((r) => ({ id: r.id, amount: r.amount, frequency: r.frequency, active: r.active === "true" })),
    cashBuffer: signal.cashBuffer,
    reservesHeld: reserves,
    weekCap,
    weekRows,
    freshness: {
      stale: freshness.stale,
      staleReason: freshness.staleReason,
      asOfBank: signal.snapshotAt,
    },
    status: signal.status,
    weekAdjustmentCents: thisAdj ? thisAdj.amountCents : null,
    weekAdjustmentReason: thisAdj ? thisAdj.reason : null,
    nextWeekAdjustmentCents: nextAdj ? nextAdj.amountCents : null,
  };
  return {
    inputs,
    cash: { signal, ledger },
    nextWeek: { start: nextStart, capCents: nextCapCents, adjustment: nextAdj },
  };
}

export async function buildMoneyPosition(
  householdId: string,
  ownerUserId: string,
  opts: BuildMoneyPositionOptions = {},
): Promise<MoneyPosition> {
  return computePosition((await loadPositionInputs(householdId, ownerUserId, opts)).inputs);
}
