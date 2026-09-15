// ⭐ (PR8r, plan section A; owner decisions 7 and 12) THE EVERYDAY RESERVE — the
// weekly and monthly Amex payoff hooks, as pure functions. The server adapter
// (`artifacts/api-server/src/lib/everydayHooks.ts`) reads the rows, the owed
// figures and the resolutions; everything decided here is arithmetic on what it
// hands in, so the rules are pinned without a database
// (`artifacts/api-server/src/lib/everydayReserve.test.ts`, including the "never
// reads high" property test).
//
// DECISION 7: the Allowances settings own the everyday amount — the weekly plan is
// `weeklyAllowanceAmount` or that week's override, the monthly plan
// `monthlyAllowanceAmount` (`everydayPlan`). Once linked
// (`preferences.everydayHooks`), the Weekly Spend and Monthly Spend bills are
// payoff DATE hooks and their own amounts are ignored.
//
// ONE PAYOFF PER PERIOD (`buildPayoffs`):
//   - WEEKLY (Sun–Sat), paid on the Saturday: the owed charges on the weekly cards
//     + max(0, plan − everyday spend) while the week is open;
//   - MONTHLY, paid on the 1st of the next month: the monthly card's charges for
//     the month + max(0, the month's plan − everyday spend) while it is open;
//   - the everyday spend that shrinks a plan is spend the forecast already sees
//     leave (`covered`): a checking row, which is already cash, or a card row
//     inside a linked hook's owed figure. Spend it cannot see leave — a card the
//     hooks do not pay, a charge the owed figure leaves out — does NOT shrink the
//     plan. "The forecast may read low, never high" (owner, 2026-09-15);
//   - CLOSED AND UNPAID: the owed charges only, moved to the next business day
//     (`amex_payoff_not_posted`) while its payoff date is at most 14 days back —
//     the overdue floor every plan shares; older, it is off the curve;
//   - DUE TODAY AND STILL OPEN (a Saturday): the next business day
//     (`due_today_not_posted`), so day 0 still equals the bank, as for every plan;
//   - A MATCHED AMEX PAYMENT (tier 1: a checking payment naming Amex,
//     `isAmexPayoffPayment`, within max($1, 1%) of the owed figure, dated from the
//     period's first day to 14 days after its payoff date) removes the payoff.
//     While the period is still open it removes only the owed part: charges after
//     the payment, up to the plan, are still to pay. Oldest period first; one
//     payment settles one period;
//   - AN EXPLICIT ANSWER on the payoff (its resolution) wins over the automatic
//     match: matched / skipped / missed / dismissed take it off, partial leaves
//     what the confirmed row did not pay (nothing at $1 or less), rescheduled
//     moves its date.

import {
  classifyMovement,
  type MovementClassification,
  type MovementConflict,
  type MovementContext,
  type MovementRow,
} from "./householdMoney";
import { addDaysISO } from "./householdTime";
import { nextBusinessDayISO, type EverydayCadence, type EverydayPeriod } from "./everydayPeriod";
import {
  matchesCardPaymentPattern,
  matchesTransferPattern,
  normalizeDescription,
  PFC_CARD_PAYMENT,
  spendAmount,
} from "./spendingRule";

// ── Which plan a row's spending uses up ───────────────────────────────────────

export type EverydayBucket = "weekly" | "monthly" | "unplanned";

export interface EverydayRowFacts {
  /** The plan the row uses up: weekly, monthly, unplanned (sits on top of both), or none. */
  bucket: EverydayBucket | null;
  /** True when an UNFLAGGED row uses up the weekly plan provisionally (`needs_classification`). */
  viaNeedsClassification: boolean;
  /** Whole cents the row spends (`spendAmount`); 0 for an inflow or a $0 row. */
  spendCents: number;
  /** `classifyMovement`'s answer, for the caller that reads timing or coverage. */
  movement: MovementClassification;
  /**
   * Set when a CONFIRMED bill match keeps a spending row out of every plan
   * (decision 12): with the flag it beat — `flag_ignored_matched` (weekly or
   * monthly, ignored with a note) or `unplanned_on_matched` (a conflict for Review).
   */
  billMatched: { conflict: MovementConflict | null } | null;
}

/**
 * ⭐ THE EVERYDAY-SPEND RULE — which plan a row uses up.
 *
 * A row the household FLAGGED keeps TODAY'S ALLOWANCE SCREENS (the four the Budget
 * allowance card applies: transfer, card-payment flag, reimbursable, debt tag),
 * never the one spending rule's description and category rules. ⚠️ OWNER QUESTION
 * OPEN: `classifyOutflow` drops a description containing "autopay", "epay",
 * "web id:" or "ach pmt", real bills included; until the owner answers, a flagged
 * row is never newly dropped by it here. Then decision 12: a confirmed bill match
 * uses up no plan. Otherwise its flag, unplanned > monthly > weekly.
 *
 * An UNFLAGGED row follows `classifyMovement`: only `needs_classification` uses up
 * a plan (the weekly one, provisionally). A reimbursable row (answer 1), a
 * confirmed match or a tier-2 pair, a transfer, a card or debt payment use up none.
 */
export function everydayRowFacts(row: MovementRow, ctx: MovementContext): EverydayRowFacts {
  const movement = classifyMovement(row, ctx);
  const spendCents = Math.round(spendAmount(row) * 100);
  const flagged = row.unplannedAllowance || row.monthlyAllowance || row.weeklyAllowance;
  const none = { bucket: null, viaNeedsClassification: false, spendCents, movement, billMatched: null };
  if (flagged) {
    if (row.isTransfer || row.isExternalCardPayment || row.reimbursable || row.debtId) return none;
    if (ctx.matchedTxnIds.has(row.id)) {
      return spendCents > 0
        ? { ...none, billMatched: { conflict: row.unplannedAllowance ? "unplanned_on_matched" : "flag_ignored_matched" } }
        : none;
    }
    const bucket: EverydayBucket = row.unplannedAllowance ? "unplanned" : row.monthlyAllowance ? "monthly" : "weekly";
    return { ...none, bucket };
  }
  if (movement.coverage === "needs_classification") {
    return { ...none, bucket: "weekly", viaNeedsClassification: true };
  }
  if (movement.coverage === "bill_matched" && ctx.matchedTxnIds.has(row.id) && spendCents > 0) {
    return { ...none, billMatched: { conflict: null } };
  }
  return none;
}

// ── A period's everyday spend ─────────────────────────────────────────────────

export interface EverydaySpendRow {
  occurredOn: string;
  bucket: EverydayBucket | null;
  viaNeedsClassification: boolean;
  spendCents: number;
  /**
   * The forecast already sees this money leave: a checking row (cash), or a card
   * row inside a LINKED hook's owed figure. Only covered spend shrinks a payoff.
   */
  covered: boolean;
}

export interface PeriodSpend {
  /** Everyday spend against the period's plan, from any account. */
  spentCents: number;
  /** The covered part of it: what shrinks the payoff. */
  coveredSpentCents: number;
  /** Unplanned spend dated in the period (sits on top of the plan). */
  unplannedCents: number;
  /** Unflagged spend dated in the period (part of `spentCents` for a week). */
  needsClassificationCents: number;
}

/** Sum a period's everyday spend: the rows dated in it whose plan is the period's own. */
export function periodSpend(period: EverydayPeriod, rows: readonly EverydaySpendRow[]): PeriodSpend {
  const out: PeriodSpend = { spentCents: 0, coveredSpentCents: 0, unplannedCents: 0, needsClassificationCents: 0 };
  for (const r of rows) {
    if (r.occurredOn < period.start || r.occurredOn > period.end) continue;
    if (r.bucket === "unplanned") out.unplannedCents += r.spendCents;
    if (r.viaNeedsClassification) out.needsClassificationCents += r.spendCents;
    if (r.bucket !== period.cadence) continue;
    out.spentCents += r.spendCents;
    if (r.covered) out.coveredSpentCents += r.spendCents;
  }
  return out;
}

// ── The Amex payment that settles a period (tier 1) ───────────────────────────

export interface AmexPaymentRow {
  amount: number | string;
  description: string | null;
  isExternalCardPayment: boolean;
  pfcDetailed: string | null;
  debtId: string | null;
}

const NAMES_AMEX = /(^| )(amex|american express)( |$)/;

/**
 * A payment TO AMERICAN EXPRESS: an outflow, not tagged to a debt (a card tracked
 * as a debt is paid through its debt plan), whose description names Amex and reads
 * as a card payment — the user's flag, Plaid's card-payment category, an issuer
 * payment phrase (`matchesCardPaymentPattern`: "AMERICAN EXPRESS ACH", "AMEX
 * EPAYMENT") or ACH payment boilerplate (`matchesTransferPattern`: "AMEX DES:ACH
 * PMT"). "AMERICAN EXPRESS TRAVEL" is a purchase. The caller checks the row is
 * checking cash.
 */
export function isAmexPayoffPayment(row: AmexPaymentRow): boolean {
  const amount = typeof row.amount === "number" ? row.amount : parseFloat(row.amount);
  if (!(amount < 0)) return false;
  if (row.debtId) return false;
  if (!NAMES_AMEX.test(normalizeDescription(row.description))) return false;
  const description = row.description ?? "";
  return (
    row.isExternalCardPayment === true ||
    (row.pfcDetailed ?? "").toUpperCase() === PFC_CARD_PAYMENT ||
    matchesCardPaymentPattern(description) ||
    matchesTransferPattern(description)
  );
}

/** A payment settles an owed figure within max($1, 1%) of it. */
export function payoffMatchToleranceCents(owedCents: number): number {
  return Math.max(100, Math.round(owedCents * 0.01));
}

/** A payment settles a period paid at most this many days after its payoff date. */
export const PAYOFF_PAYMENT_LATE_DAYS = 14;

// ── The payoffs ──────────────────────────────────────────────────────────────

export interface PayoffPeriodInput {
  period: EverydayPeriod;
  /** The period's plan, in cents (`everydayPlan`). */
  planCents: number;
  /** The owed charges on the hook's cards dated in the period, in cents; 0 for a period not yet begun. */
  owedCents: number;
  /** Covered everyday spend against the period's plan (`periodSpend`), in cents. */
  coveredSpentCents: number;
}

export interface PayoffPayment {
  txnId: string;
  occurredOn: string;
  /** The payment's size, positive cents. */
  amountCents: number;
}

export interface PayoffResolution {
  status: string;
  rescheduledTo?: string | null;
  /** For `partial`: what the confirmed row paid, positive cents. */
  paidCents?: number | null;
}

export type PayoffAssumption = "due_today_not_posted" | "amex_payoff_not_posted";

export interface BuildPayoffsInput {
  todayISO: string;
  /** A plan dated on or before this is due: max(snapshot day, today), as for every plan. */
  dragCutoffISO: string;
  /** A closed, unpaid period whose payoff date is before this is off the curve: today − 14. */
  dragFloorISO: string;
  periods: readonly PayoffPeriodInput[];
  /** Eligible Amex payments (`isAmexPayoffPayment`, on checking, not claimed by any answer). */
  payments: readonly PayoffPayment[];
  /** Explicit answers, keyed `${cadence}|${payoffDate}`. */
  resolutions?: ReadonlyMap<string, PayoffResolution>;
}

export interface PayoffOutcome {
  period: EverydayPeriod;
  /** The period's last day is today or later. */
  open: boolean;
  planCents: number;
  owedCents: number;
  coveredSpentCents: number;
  /** max(0, plan − covered spend) while open; 0 once closed. */
  reserveCents: number;
  /** The Amex payment that settled the owed charges, if one did. */
  payment: PayoffPayment | null;
  /** The explicit answer's status, if any. */
  resolution: string | null;
  /** What is on the curve for the period: positive cents, where, and why it moved. Null when nothing is. */
  curve: { amountCents: number; date: string; originalDate: string; assumption: PayoffAssumption | null } | null;
  /** Closed, unpaid, and its payoff date is before the overdue floor: off the curve. */
  outsideForecast: boolean;
}

const CLOSING_STATUSES: ReadonlySet<string> = new Set(["matched", "skipped", "missed", "dismissed"]);
/** The answers a payoff reads; any other status on its key (a review marker, "Not this") leaves it unanswered. */
export const PAYOFF_RESOLUTION_STATUSES: ReadonlySet<string> = new Set([...CLOSING_STATUSES, "partial", "rescheduled"]);
const CADENCE_ORDER: Record<EverydayCadence, number> = { weekly: 0, monthly: 1 };

/** The resolution key of a period's payoff within one cadence. */
export const payoffResolutionKey = (period: EverydayPeriod): string => `${period.cadence}|${period.payoffDate}`;

const byPayoffDate = <T extends { period: EverydayPeriod }>(periods: readonly T[]): T[] =>
  [...periods].sort(
    (a, b) =>
      (a.period.payoffDate < b.period.payoffDate ? -1 : a.period.payoffDate > b.period.payoffDate ? 1 : 0) ||
      CADENCE_ORDER[a.period.cadence] - CADENCE_ORDER[b.period.cadence],
  );

export interface SettlePayoffPaymentsInput {
  periods: readonly Pick<PayoffPeriodInput, "period" | "owedCents">[];
  payments: readonly PayoffPayment[];
  resolutions?: ReadonlyMap<string, PayoffResolution>;
}

/**
 * Tier 1: which Amex payment settled which period's owed charges, keyed by
 * `payoffResolutionKey` — oldest payoff date first, each payment at most once,
 * the earliest eligible payment first. A period with an explicit answer, or with
 * nothing owed, takes none. `buildPayoffs` calls this; the ledger calls it first
 * too, to claim those rows before it matches bills.
 */
export function settlePayoffPayments(input: SettlePayoffPaymentsInput): Map<string, PayoffPayment> {
  const payments = [...input.payments].sort(
    (a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.txnId < b.txnId ? -1 : a.txnId > b.txnId ? 1 : 0),
  );
  const used = new Set<string>();
  const settled = new Map<string, PayoffPayment>();
  for (const p of byPayoffDate(input.periods)) {
    const key = payoffResolutionKey(p.period);
    if (input.resolutions?.has(key) || p.owedCents <= 0) continue;
    const tolerance = payoffMatchToleranceCents(p.owedCents);
    const lastDay = addDaysISO(p.period.payoffDate, PAYOFF_PAYMENT_LATE_DAYS);
    const payment = payments.find(
      (x) =>
        !used.has(x.txnId) &&
        x.occurredOn >= p.period.start &&
        x.occurredOn <= lastDay &&
        Math.abs(x.amountCents - p.owedCents) <= tolerance,
    );
    if (!payment) continue;
    used.add(payment.txnId);
    settled.set(key, payment);
  }
  return settled;
}

/** ⭐ ONE OUTCOME PER PERIOD — see the file header. Periods are settled oldest payoff date first. */
export function buildPayoffs(input: BuildPayoffsInput): PayoffOutcome[] {
  const settled = settlePayoffPayments(input);
  const dragTarget = nextBusinessDayISO(input.todayISO);

  return byPayoffDate(input.periods).map((p): PayoffOutcome => {
    const { period } = p;
    const open = period.end >= input.todayISO;
    const reserveCents = open ? Math.max(0, p.planCents - p.coveredSpentCents) : 0;
    const resolution = input.resolutions?.get(payoffResolutionKey(period));
    const outcome: PayoffOutcome = {
      period,
      open,
      planCents: p.planCents,
      owedCents: p.owedCents,
      coveredSpentCents: p.coveredSpentCents,
      reserveCents,
      payment: null,
      resolution: resolution?.status ?? null,
      curve: null,
      outsideForecast: false,
    };
    if (resolution && CLOSING_STATUSES.has(resolution.status)) return outcome;
    // Tier 1: the payment that settled the owed charges (none when answered).
    outcome.payment = settled.get(payoffResolutionKey(period)) ?? null;

    let amountCents = (outcome.payment ? 0 : p.owedCents) + reserveCents;
    if (resolution?.status === "partial" && resolution.paidCents != null) {
      amountCents -= resolution.paidCents;
      if (amountCents <= 100) return outcome;
    }
    if (amountCents <= 0) return outcome;

    const originalDate =
      resolution?.status === "rescheduled" && resolution.rescheduledTo ? resolution.rescheduledTo : period.payoffDate;
    if (originalDate > input.dragCutoffISO) {
      outcome.curve = { amountCents, date: originalDate, originalDate, assumption: null };
    } else if (open) {
      outcome.curve = { amountCents, date: dragTarget, originalDate, assumption: "due_today_not_posted" };
    } else if (originalDate >= input.dragFloorISO) {
      outcome.curve = { amountCents, date: dragTarget, originalDate, assumption: "amex_payoff_not_posted" };
    } else {
      outcome.outsideForecast = true;
    }
    return outcome;
  });
}
