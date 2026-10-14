import type { MovementCoverage } from "./householdMoney";
import { MATCH_STRICT_DAYS, pairDayDelta, pairDifference, withinStrictTolerance } from "./planMatch";

/**
 * ⭐ (S4) THE BANKING REVIEW — "WHAT WASN'T IN THE PLAN?", ONE ROW AT A TIME.
 *
 * The owner: "I want to review banking and immediately see what wasn't in the
 * plan." Every bank row the register counts in the period lands in EXACTLY ONE
 * place, first matching rule wins. Pure: the server (`lib/bankingReview.ts`)
 * reads the inputs — the household's answers, the forecast ledger's own pairs
 * and fates, the spending rule's kind — and this module only places and sums.
 *
 *   1. CONFIRMED by the household (`matched` / `partial`, on the row or on the
 *      pending row it replaced) → compared with its plan:
 *        partial, or |difference| > max($1, 1% of the plan) → amountDifference;
 *        else |days| > MATCH_STRICT_DAYS                     → timingDifference;
 *        else                                                → asPlanned.
 *      A confirmed row whose plan the ledger did not load (dated before its
 *      window) is asPlanned on the household's word, with no plan detail.
 *   2. MARKED NOT IN THE PLAN (`ignored_unforecasted` / `unplanned`) → confirmedUnplanned.
 *   3. A PAIR WAITING FOR REVIEW (`needs_review*`) → uncertain (needs_review).
 *   4. AUTOMATIC: the forecast ledger counted the row as paying a plan (a tier-1
 *      or tier-2 pair that is not ambiguous, or the row behind a plan the ledger
 *      took as paid on evidence — `overdueAssumedPaid`, a paycheck that arrived,
 *      an everyday hook's card payoff) → the same three-way split as rule 1.
 *   5. A SUGGESTION only (a tier-3 or ambiguous pair) → uncertain (suggested_match).
 *   6. NOT COMPARED: dated before the comparison window, after today, or on an
 *      account the forecast does not read → uncertain (not_compared). Never
 *      "unplanned": the plan was not asked.
 *   7. Otherwise → unmatched, by kind (spending, card payment, debt payment,
 *      transfer, income, refund, other).
 *
 * ⚠️ "Not this" (`not_match`) only rejects one pairing; it never decides a row.
 * The unplanned-allowance flag ("UN") and a missing category are attributes of
 * a row, never a rule here: an unflagged uncategorized purchase that paid a plan
 * is planned, and a UN-flagged purchase nobody answered is unmatched spending.
 */

export const BANK_REVIEW_BUCKETS = [
  "amountDifference",
  "timingDifference",
  "confirmedUnplanned",
  "uncertain",
  "unmatched",
] as const;
export type BankReviewBucket = (typeof BANK_REVIEW_BUCKETS)[number];
/** Where a row lands: one of the five "not in the plan" buckets, or as planned. */
export type BankReviewPlacement = BankReviewBucket | "asPlanned";

export const BANK_REVIEW_KINDS = [
  "spending",
  "card_payment",
  "debt_payment",
  "transfer",
  "income",
  "refund",
  "other",
] as const;
export type BankReviewKind = (typeof BANK_REVIEW_KINDS)[number];

/**
 * A row's kind, from its `classifyMovement` coverage (which runs the core
 * spending rule, `classifyOutflow`, first). Every purchase placement — a weekly,
 * monthly or unplanned flag, reimbursable, unfiled, a bill — is "spending"; an
 * excluded category or an unmarked deposit is "other".
 */
export function bankReviewKindOf(coverage: MovementCoverage): BankReviewKind {
  switch (coverage) {
    case "transfer":
    case "debt_payment":
    case "card_payment":
    case "income":
    case "refund":
      return coverage;
    case "excluded":
      return "other";
    case "bill_matched":
    case "unplanned":
    case "allowance_monthly":
    case "allowance_weekly":
    case "reimbursable":
    case "needs_classification":
      return "spending";
  }
}

/** Why a row is where it is. */
export type BankReviewReason =
  | "partial"
  | "amount"
  | "timing"
  | "as_planned"
  | "marked_unplanned"
  | "ignored_unforecasted"
  | "needs_review"
  | "suggested_match"
  | "not_compared"
  | "no_plan";

/** A plan occurrence a row is compared with. `planned` is signed; null when not known. */
export interface BankReviewPlanRef {
  key: string;
  label: string;
  /** The date it was due (after any reschedule). */
  scheduledDate: string;
  planned: number | null;
}

export interface BankReviewRowInput {
  occurredOn: string;
  /** Signed: negative is money out. */
  amount: number;
  /**
   * The statuses of the household's answers that name this row (or the pending
   * row it replaced). "Not this" never decides a row and is ignored here.
   */
  resolutions: ReadonlyArray<{ status: string; plan: BankReviewPlanRef | null }>;
  /** The plan the forecast ledger counted this row as paying (rule 4). */
  evidence: BankReviewPlanRef | null;
  /** The plan a tier-3 or ambiguous pair suggests (rule 5). */
  suggestion: BankReviewPlanRef | null;
  /** False: before the comparison window, after today, or not the forecast's account (rule 6). */
  compared: boolean;
}

/** A plan beside a row: what was planned, and how the row differs. */
export interface BankReviewPlanComparison extends BankReviewPlanRef {
  /** |row| − |plan| (positive: more than planned); null when the plan amount is not known. */
  difference: number | null;
  /** Row date − due date, in days (negative: early). */
  dayDelta: number | null;
}

export interface BankReviewRowPlacement {
  bucket: BankReviewPlacement;
  reason: BankReviewReason;
  /** Who tied the row to its plan: the household, or the forecast ledger. */
  evidence: "confirmed" | "automatic" | null;
  plan: BankReviewPlanComparison | null;
}

function compare(plan: BankReviewPlanRef, row: Pick<BankReviewRowInput, "occurredOn" | "amount">): BankReviewPlanComparison {
  return {
    ...plan,
    difference: plan.planned == null ? null : pairDifference(plan.planned, row.amount),
    dayDelta: pairDayDelta(plan.scheduledDate, row.occurredOn),
  };
}

/** Rules 1 and 4: a row tied to a plan, split by amount, then timing. */
function split(
  row: Pick<BankReviewRowInput, "occurredOn" | "amount">,
  plan: BankReviewPlanRef | null,
  evidence: "confirmed" | "automatic",
  partial: boolean,
): BankReviewRowPlacement {
  const p = plan ? compare(plan, row) : null;
  if (partial) return { bucket: "amountDifference", reason: "partial", evidence, plan: p };
  if (!p || p.planned == null) return { bucket: "asPlanned", reason: "as_planned", evidence, plan: p };
  if (!withinStrictTolerance(p.planned, row.amount)) {
    return { bucket: "amountDifference", reason: "amount", evidence, plan: p };
  }
  if (Math.abs(p.dayDelta ?? 0) > MATCH_STRICT_DAYS) {
    return { bucket: "timingDifference", reason: "timing", evidence, plan: p };
  }
  return { bucket: "asPlanned", reason: "as_planned", evidence, plan: p };
}

/** ⭐ Where one bank row lands. See the file header for the rules, in order. */
export function placeBankReviewRow(row: BankReviewRowInput): BankReviewRowPlacement {
  const has = (...statuses: string[]) => row.resolutions.find((r) => statuses.includes(r.status));
  const confirmed = has("matched", "partial");
  if (confirmed) return split(row, confirmed.plan, "confirmed", confirmed.status === "partial");
  const unplanned = has("ignored_unforecasted", "unplanned");
  if (unplanned) {
    return {
      bucket: "confirmedUnplanned",
      reason: unplanned.status === "unplanned" ? "marked_unplanned" : "ignored_unforecasted",
      evidence: null,
      plan: null,
    };
  }
  const review = has("needs_review", "needs_review_partial");
  if (review) {
    return { bucket: "uncertain", reason: "needs_review", evidence: null, plan: review.plan ? compare(review.plan, row) : null };
  }
  if (row.evidence) return split(row, row.evidence, "automatic", false);
  if (row.suggestion) {
    return { bucket: "uncertain", reason: "suggested_match", evidence: null, plan: compare(row.suggestion, row) };
  }
  if (!row.compared) return { bucket: "uncertain", reason: "not_compared", evidence: null, plan: null };
  return { bucket: "unmatched", reason: "no_plan", evidence: null, plan: null };
}

// ── Sums, in whole cents ─────────────────────────────────────────────────────

export interface BankReviewTotalsCents {
  count: number;
  moneyInCents: number;
  moneyOutCents: number;
  netCents: number;
  pendingNetCents: number;
}

export const emptyBankReviewTotals = (): BankReviewTotalsCents => ({
  count: 0,
  moneyInCents: 0,
  moneyOutCents: 0,
  netCents: 0,
  pendingNetCents: 0,
});

/** Adds one row (signed whole cents) to a running total. */
export function addToBankReviewTotals(t: BankReviewTotalsCents, amountCents: number, pending: boolean): void {
  t.count += 1;
  if (amountCents > 0) t.moneyInCents += amountCents;
  else t.moneyOutCents -= amountCents;
  t.netCents += amountCents;
  if (pending) t.pendingNetCents += amountCents;
}

export interface BankReviewSummaryRow {
  amountCents: number;
  pending: boolean;
  kind: BankReviewKind;
  placement: BankReviewRowPlacement;
}

export interface BankReviewSummary {
  buckets: Record<BankReviewBucket, BankReviewTotalsCents>;
  asPlanned: BankReviewTotalsCents;
  /** Unmatched rows by kind. */
  unmatchedByKind: Record<BankReviewKind, BankReviewTotalsCents>;
  /** Uncertain rows by reason. */
  uncertainByReason: Record<"needs_review" | "suggested_match" | "not_compared", BankReviewTotalsCents>;
  /** Σ difference (whole cents) over the amountDifference rows whose plan amount is known. */
  differenceTotalCents: number;
  /** Σ every bucket's net + asPlanned's net: every row exactly once. */
  netCents: number;
  count: number;
}

const toCents = (n: number): number => Math.round(n * 100);

/** ⭐ Sums the placed rows: each row is in exactly one total, so Σ buckets + asPlanned = every row. */
export function summarizeBankReview(rows: readonly BankReviewSummaryRow[]): BankReviewSummary {
  const buckets = Object.fromEntries(BANK_REVIEW_BUCKETS.map((b) => [b, emptyBankReviewTotals()])) as Record<
    BankReviewBucket,
    BankReviewTotalsCents
  >;
  const unmatchedByKind = Object.fromEntries(BANK_REVIEW_KINDS.map((k) => [k, emptyBankReviewTotals()])) as Record<
    BankReviewKind,
    BankReviewTotalsCents
  >;
  const uncertainByReason = {
    needs_review: emptyBankReviewTotals(),
    suggested_match: emptyBankReviewTotals(),
    not_compared: emptyBankReviewTotals(),
  };
  const asPlanned = emptyBankReviewTotals();
  let differenceTotalCents = 0;
  let netCents = 0;
  for (const r of rows) {
    const { bucket, reason, plan } = r.placement;
    netCents += r.amountCents;
    if (bucket === "asPlanned") {
      addToBankReviewTotals(asPlanned, r.amountCents, r.pending);
      continue;
    }
    addToBankReviewTotals(buckets[bucket], r.amountCents, r.pending);
    if (bucket === "unmatched") addToBankReviewTotals(unmatchedByKind[r.kind], r.amountCents, r.pending);
    if (bucket === "uncertain" && (reason === "needs_review" || reason === "suggested_match" || reason === "not_compared")) {
      addToBankReviewTotals(uncertainByReason[reason], r.amountCents, r.pending);
    }
    if (bucket === "amountDifference" && plan?.difference != null) differenceTotalCents += toCents(plan.difference);
  }
  return { buckets, asPlanned, unmatchedByKind, uncertainByReason, differenceTotalCents, netCents, count: rows.length };
}
