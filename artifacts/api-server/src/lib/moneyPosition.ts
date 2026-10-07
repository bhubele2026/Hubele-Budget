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
//                  sized by `spendAmount`.
//   the cap        `allowance_plans` through `everydayPlanFromRows`, with the
//                  week's override from `preferences.weeklyAllowanceOverrides`.
//   freshness      `computeBankFreshness` — the spine's own bank verdict.
//
// ⚠️ READ-ONLY. No write, no Plaid call: it sits on the spine's path.

import { eq } from "drizzle-orm";
import { db, recurringItemsTable } from "@workspace/db";
import {
  classifyMovement,
  computePosition,
  everydayPlanFromRows,
  spendAmount,
  weekBounds,
  type MoneyPosition,
  type PositionEvent,
} from "@workspace/avalanche-core";
import { computeCashSignalDetailed, type DetailedCashSignal } from "./cashSignal";
import { computeBankFreshness, type BankFreshness } from "./bankFreshness";
import { loadMoneyContext, loadMovementRows } from "./moneyContext";
import { loadAllowancePlans, planRowsOf } from "./allowancePlans";
import { TRACKING_START } from "./spendingFacts";

/** The horizon the spine and the Forecast tile ask for; the position reads the same curve. */
export const POSITION_HORIZON_DAYS = 90;

export interface BuildMoneyPositionOptions {
  /** The spine's own cash-signal read, so one request builds one ledger. */
  cash?: Promise<DetailedCashSignal> | DetailedCashSignal;
  /** The spine's own freshness read. */
  freshness?: Promise<BankFreshness> | BankFreshness;
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

export async function buildMoneyPosition(
  householdId: string,
  ownerUserId: string,
  opts: BuildMoneyPositionOptions = {},
): Promise<MoneyPosition> {
  const cashRead = Promise.resolve(
    opts.cash ?? computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS }),
  );
  const freshnessRead = Promise.resolve(opts.freshness ?? computeBankFreshness(householdId, ownerUserId));
  const [{ signal, ledger }, freshness, incomeRows, planRows] = await Promise.all([
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
  ]);

  // The household week on the ledger's own today, clamped to the tracking
  // start exactly as the spine's `spentWeek` is (`buildSpendingFacts`).
  const todayISO = ledger.todayISO;
  const week = weekBounds(todayISO);
  const from = week.start < TRACKING_START ? TRACKING_START : week.start;
  const money = await loadMoneyContext(
    householdId,
    { start: from, end: week.end },
    { tier2PairedTxnIds: tier2PairedTxnIdsOf(ledger) },
  );
  const rows = await loadMovementRows(householdId, from, week.end, money);
  const weekRows = rows.map((r) => ({ coverage: classifyMovement(r, money).coverage, spend: spendAmount(r) }));

  const plan = everydayPlanFromRows(week.start, planRowsOf(planRows), money.settings.weeklyAllowanceOverrides);
  const weekCap = plan.weeklySource === "none" ? null : plan.weeklyCents / 100;

  return computePosition({
    todayISO,
    daily: signal.daily ?? [],
    events: positionEventsOf(ledger),
    incomeItems: incomeRows
      .filter((r) => r.kind === "income")
      .map((r) => ({ id: r.id, amount: r.amount, frequency: r.frequency, active: r.active === "true" })),
    cashBuffer: signal.cashBuffer,
    reservesHeld: 0,
    weekCap,
    weekRows,
    freshness: {
      stale: freshness.stale,
      staleReason: freshness.staleReason,
      asOfBank: signal.snapshotAt,
    },
    status: signal.status,
  });
}
