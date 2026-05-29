// (#826 — Phase 1) Deterministic avalanche extra-payment scheduler.
//
// Replaces the static "MAX SAFE EXTRA PAYMENT" tile (which collapsed to
// $0 the moment any single day in the next 90 dipped below the cash
// buffer) with a multi-date schedule that looks across the next 12
// months. For every safe paycheck-to-paycheck window it proposes a
// specific avalanche extra payment (date, amount, rationale, confidence).
//
// The numbers here are DETERMINISTIC ground truth. The Claude narrative
// (avalancheAdvisorSummary.ts) only ever narrates these facts — it never
// invents its own dates or amounts.
//
// Pipeline:
//   1. Reuse computeCashSignal(daysAhead = 365) to get the 12-month daily
//      projected balance array (already accounts for recurring items,
//      debt minimums, the existing avalanche extra series, locked weeks,
//      and pending-plan drag).
//   2. Expand recurring INCOME items to find paycheck anchors (> $1000).
//   3. For each consecutive paycheck-to-paycheck window, find the lowest
//      projected balance and compute headroom over the cash buffer.
//   4. Propose a payment per viable window (headroom > MIN_HEADROOM),
//      capped cumulatively at the user's monthly avalanche budget × 12.

import { and, eq } from "drizzle-orm";
import {
  db,
  recurringItemsTable,
  debtsTable,
  avalancheSettingsTable,
} from "@workspace/db";
import {
  computeCashSignal,
  expandItem,
  fmtISO,
  parseISO,
  addDays,
  nextBusinessDay,
} from "./cashSignal";
import { resolveAvalancheTargetDebt } from "./avalancheSim";

// A window is only treated as a payment slot when it has at least this
// much projected headroom over the cash buffer at its lowest point.
const MIN_HEADROOM = 250;
// Fraction of a window's headroom we propose committing — leaves a small
// safety margin so a slightly-worse-than-projected month doesn't dip the
// account below buffer.
const PROPOSAL_FRACTION = 0.85;
// Proposals round down to this increment for clean, memorable amounts.
const ROUND_TO = 50;
// Income events at or below this dollar amount are not treated as a
// "paycheck" anchor (filters out small/irregular deposits).
const PAYCHECK_MIN = 1000;
// Hard ceiling on how many payments we surface, matching the card's
// "4-12 specific dates" contract.
const MAX_PROPOSALS = 12;
// When the user hasn't set a monthly avalanche budget (manualExtra = 0),
// use this as a sane per-month default so the schedule still proposes
// payments instead of collapsing to zero.
const DEFAULT_MONTHLY_BUDGET = 1000;
const HORIZON_DAYS = 365;

export type Confidence = "high" | "medium" | "low";

export interface ProposedPayment {
  date: string; // ISO; paycheck date + 1 business day
  amount: number;
  rationale: string; // one-sentence deterministic rationale
  confidence: Confidence;
  paycheckAnchor: string; // label of the anchoring paycheck (e.g. "Brad's paycheck (KFI)")
  // The lowest projected balance in [thisPaycheck, nextPaycheck).
  lowestBetweenThisAndNextPaycheck: number;
  headroom: number; // lowestBetweenThisAndNextPaycheck − cashBuffer
}

export interface AvalancheScheduleFacts {
  proposedPayments: ProposedPayment[];
  totalProposed: number;
  lowestPostScheduleBalance: number;
  lowestPostScheduleDate: string | null;
  currentAvalancheTarget: {
    debtName: string;
    apr: number;
    balance: number;
  } | null;
  cashBuffer: number;
  bankBalance: number;
  // Convenience for the narrative + footer: the last covered month.
  scheduleThroughDate: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Short, locale-stable date label, e.g. "Jun 16". */
function shortDate(iso: string): string {
  const d = parseISO(iso);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Build the deterministic avalanche extra-payment schedule for the next
 * ~12 months. Pure-ish (reads DB, no writes). Safe to call repeatedly —
 * the result feeds both the API response and the Claude narrative facts.
 */
export async function buildAvalancheSchedule(
  householdId: string,
  ownerUserId: string,
): Promise<AvalancheScheduleFacts> {
  // 1. 12-month daily projection (reuse the cash-signal expansion).
  const signal = await computeCashSignal(householdId, ownerUserId, {
    horizonDays: HORIZON_DAYS,
  });
  const cashBuffer = Number(signal.cashBuffer) || 0;
  const bankBalance = Number(signal.bankToday) || 0;
  const daily = signal.daily ?? [];

  // Debts + avalanche target (for the narrative facts).
  const debtsList = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));
  const targetDebt = resolveAvalancheTargetDebt(debtsList);
  const currentAvalancheTarget = targetDebt
    ? { debtName: targetDebt.name, apr: targetDebt.apr, balance: targetDebt.balance }
    : null;

  // Monthly avalanche budget → cumulative cap over 12 months.
  const [avaSettingsRow] = await db
    .select()
    .from(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, ownerUserId));
  const manualExtra = Number(avaSettingsRow?.manualExtra ?? 0) || 0;
  const monthlyBudget = manualExtra > 0 ? manualExtra : DEFAULT_MONTHLY_BUDGET;
  const cumulativeCap = monthlyBudget * 12;

  const empty: AvalancheScheduleFacts = {
    proposedPayments: [],
    totalProposed: 0,
    lowestPostScheduleBalance: round2(Number(signal.lowestProjected) || 0),
    lowestPostScheduleDate: signal.lowestDate ?? null,
    currentAvalancheTarget,
    cashBuffer: round2(cashBuffer),
    bankBalance: round2(bankBalance),
    scheduleThroughDate: null,
  };

  if (daily.length === 0) return empty;

  // The schedule exists to accelerate debt payoff. With no active
  // avalanche-target debt there is nothing to pay extra toward, so we
  // return an empty schedule even when cash headroom exists.
  if (!currentAvalancheTarget) return empty;

  // 2. Paycheck anchors: expand recurring INCOME items, keep events
  // > PAYCHECK_MIN that land inside the projection window. We need the
  // income series because the cash-signal `events` array only carries
  // expense (downward) markers.
  const fromISO = daily[0].date;
  const toISO = daily[daily.length - 1].date;
  const fromDate = parseISO(fromISO);
  const toDate = parseISO(toISO);

  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));

  type Anchor = { date: string; label: string };
  const anchors: Anchor[] = [];
  for (const item of recurring) {
    if (item.kind !== "income") continue;
    if (item.active !== "true") continue;
    if (Math.abs(Number(item.amount) || 0) <= PAYCHECK_MIN) continue;
    for (const ev of expandItem(item, fromDate, toDate)) {
      if (ev.amount <= PAYCHECK_MIN) continue;
      anchors.push({ date: ev.date, label: ev.label });
    }
  }
  // Sort + dedupe by date (keep the first label seen for a date).
  anchors.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dedupedAnchors: Anchor[] = [];
  for (const a of anchors) {
    if (dedupedAnchors.length > 0 && dedupedAnchors[dedupedAnchors.length - 1].date === a.date) {
      continue;
    }
    dedupedAnchors.push(a);
  }

  if (dedupedAnchors.length < 2) {
    // Without at least two paychecks we can't form a window. Fall back to
    // the empty schedule (card still renders the deterministic lowest).
    return empty;
  }

  // Index daily balances for O(1)-ish window scans.
  const balanceByDate = new Map<string, number>();
  for (const pt of daily) balanceByDate.set(pt.date, Number(pt.balance) || 0);

  // 3 + 4. Walk consecutive paycheck-to-paycheck windows.
  const proposals: ProposedPayment[] = [];
  let cumulative = 0;
  for (let i = 0; i < dedupedAnchors.length - 1; i++) {
    if (proposals.length >= MAX_PROPOSALS) break;
    const thisPay = dedupedAnchors[i];
    const nextPay = dedupedAnchors[i + 1];

    // Lowest projected balance in [thisPaycheck, nextPaycheck).
    let lowestInWindow = Infinity;
    let cur = parseISO(thisPay.date);
    const end = parseISO(nextPay.date);
    while (cur < end) {
      const bal = balanceByDate.get(fmtISO(cur));
      if (bal != null && bal < lowestInWindow) lowestInWindow = bal;
      cur = addDays(cur, 1);
    }
    if (!Number.isFinite(lowestInWindow)) continue;

    // Every already-proposed payment is dated before this window starts
    // (anchors are ascending), so each one uniformly lowers this window's
    // balances by the running `cumulative`. Subtract it before sizing this
    // payment so the schedule stays sequentially safe — later windows
    // never assume cash that earlier payments already committed.
    const effectiveLow = lowestInWindow - cumulative;
    const headroom = effectiveLow - cashBuffer;
    if (headroom <= MIN_HEADROOM) continue;

    let amount = Math.floor((headroom * PROPOSAL_FRACTION) / ROUND_TO) * ROUND_TO;
    if (amount < ROUND_TO) continue;

    // Cap cumulative proposals at the annual avalanche budget.
    const remainingCap = cumulativeCap - cumulative;
    if (remainingCap < ROUND_TO) break;
    if (amount > remainingCap) {
      amount = Math.floor(remainingCap / ROUND_TO) * ROUND_TO;
    }
    if (amount < ROUND_TO) break;

    let confidence: Confidence;
    if (amount < headroom * 0.7) confidence = "high";
    else if (amount < headroom * 0.9) confidence = "medium";
    else confidence = "low";

    const payDate = fmtISO(nextBusinessDay(parseISO(thisPay.date)));
    const rationale =
      `Window after ${thisPay.label} bottoms out at $${Math.round(effectiveLow).toLocaleString("en-US")}, ` +
      `leaving $${Math.round(headroom).toLocaleString("en-US")} over your $${Math.round(cashBuffer).toLocaleString("en-US")} buffer.`;

    proposals.push({
      date: payDate,
      amount,
      rationale,
      confidence,
      paycheckAnchor: thisPay.label,
      lowestBetweenThisAndNextPaycheck: round2(effectiveLow),
      headroom: round2(headroom),
    });
    cumulative = round2(cumulative + amount);
  }

  const totalProposed = round2(
    proposals.reduce((s, p) => s + p.amount, 0),
  );

  // 5. Recompute the projection lowest AFTER applying the proposed
  // payments, so the card can promise the schedule still stays above
  // buffer. For each day we subtract every proposed payment dated on or
  // before that day.
  let lowestPostScheduleBalance = Infinity;
  let lowestPostScheduleDate: string | null = null;
  for (const pt of daily) {
    let applied = 0;
    for (const p of proposals) {
      if (p.date <= pt.date) applied += p.amount;
    }
    const bal = (Number(pt.balance) || 0) - applied;
    if (bal < lowestPostScheduleBalance) {
      lowestPostScheduleBalance = bal;
      lowestPostScheduleDate = pt.date;
    }
  }
  if (!Number.isFinite(lowestPostScheduleBalance)) {
    lowestPostScheduleBalance = Number(signal.lowestProjected) || 0;
    lowestPostScheduleDate = signal.lowestDate ?? null;
  }

  const scheduleThroughDate =
    proposals.length > 0 ? proposals[proposals.length - 1].date : null;

  return {
    proposedPayments: proposals,
    totalProposed,
    lowestPostScheduleBalance: round2(lowestPostScheduleBalance),
    lowestPostScheduleDate,
    currentAvalancheTarget,
    cashBuffer: round2(cashBuffer),
    bankBalance: round2(bankBalance),
    scheduleThroughDate,
  };
}

export { shortDate };
