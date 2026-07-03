import { effectiveBucket, type AllowanceBucket } from "@/lib/weeklyBuckets";

/**
 * Single source of truth for weekly / monthly / unplanned SPEND.
 *
 * A transaction counts toward a bucket ONLY if the user explicitly marked it
 * that bucket (see `effectiveBucket` — blank is unassigned and counts nowhere).
 * The Banking dashboard, the Allowances page, and the budget's allowance lines
 * all sum through here so their numbers are identical by construction.
 *
 * Spend magnitude uses the app's standard convention (`amount < 0` = charge),
 * matching `reportsAnalytics.expense` / allowances' `expenseAmount`. True
 * non-spend (transfers, external card payments, reimbursables, debt payments) is
 * never counted even if somehow flagged.
 */
export type BucketTxn = {
  occurredOn?: string | null;
  amount?: string | number | null;
  source?: string | null;
  weeklyAllowance?: boolean | null;
  monthlyAllowance?: boolean | null;
  unplannedAllowance?: boolean | null;
  isTransfer?: boolean | null;
  isExternalCardPayment?: boolean | null;
  reimbursable?: boolean | null;
  debtId?: string | null;
};

/**
 * Positive spend magnitude for an expense; 0 for income/credits.
 * Source-aware, mirroring the SERVER convention exactly (spendingFilter.ts:68,
 * budgetFacts.ts, bankingInsightsSummary.ts): only the manual/workbook `"amex"`
 * source is stored POSITIVE-for-charges. Plaid-synced cards — including
 * `plaid:amex` — store charges NEGATIVE like the bank, so they go through the
 * bank branch. (Previously this also matched `plaid:amex`, which zeroed every
 * real negative Amex charge → Amex bucket filings summed to $0.)
 */
export function expenseMagnitude(t: BucketTxn): number {
  const a = Number(t.amount) || 0;
  const isManualAmex = t.source === "amex";
  return isManualAmex ? (a > 0 ? a : 0) : a < 0 ? -a : 0;
}

/** True unless the row is a transfer / card payment / reimbursable / debt pay. */
export function isCountableSpend(t: BucketTxn): boolean {
  if (t.isTransfer) return false;
  if (t.isExternalCardPayment) return false;
  if (t.reimbursable) return false;
  if (t.debtId) return false;
  return true;
}

/** Sum spend in [startISO, endISO] whose explicit bucket === `bucket`. */
export function bucketSpendInWindow(
  txns: readonly BucketTxn[],
  bucket: AllowanceBucket,
  startISO: string,
  endISO: string,
): number {
  let sum = 0;
  for (const t of txns) {
    if (!t.occurredOn || t.occurredOn < startISO || t.occurredOn > endISO)
      continue;
    if (!isCountableSpend(t)) continue;
    if (effectiveBucket(t) !== bucket) continue;
    sum += expenseMagnitude(t);
  }
  return sum;
}

/** The txns (in window) that belong to `bucket` — for drill-downs. */
export function bucketTxnsInWindow<T extends BucketTxn>(
  txns: readonly T[],
  bucket: AllowanceBucket,
  startISO: string,
  endISO: string,
): T[] {
  const out: T[] = [];
  for (const t of txns) {
    if (!t.occurredOn || t.occurredOn < startISO || t.occurredOn > endISO)
      continue;
    if (!isCountableSpend(t)) continue;
    if (effectiveBucket(t) !== bucket) continue;
    out.push(t);
  }
  return out;
}
