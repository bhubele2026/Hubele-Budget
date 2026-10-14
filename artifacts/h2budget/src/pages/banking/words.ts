import type {
  BankingReviewBucketName,
  BankingReviewKind,
  BankingReviewPlanFate,
  BankingReviewReason,
  BankingReviewRow,
  BankingReviewVarianceKind,
} from "@workspace/api-client-react/features";
import { formatCurrency } from "@/lib/utils";

/** (W3) The words on the Banking review. Short; the owner asked for fewer. */

export const BUCKETS: Array<{ name: BankingReviewBucketName; title: string; line: string }> = [
  { name: "unmatched", title: "Unmatched", line: "Paid, but not on the plan" },
  { name: "amountDifference", title: "Different amount", line: "Paid a different amount than planned" },
  { name: "timingDifference", title: "Different date", line: "Paid on a different day" },
  { name: "confirmedUnplanned", title: "Marked not in plan", line: "You marked these not in the plan" },
  { name: "uncertain", title: "Not sure", line: "H2 can't tell yet" },
];

export const isBucketName = (raw: string | null | undefined): raw is BankingReviewBucketName =>
  BUCKETS.some((b) => b.name === raw);

export const KIND_ORDER: BankingReviewKind[] = [
  "spending",
  "card_payment",
  "debt_payment",
  "transfer",
  "income",
  "refund",
  "other",
];

export const KIND_WORDS: Record<BankingReviewKind, string> = {
  spending: "Spending",
  card_payment: "Card payment",
  debt_payment: "Debt payment",
  transfer: "Transfer",
  income: "Income",
  refund: "Refund",
  other: "Other",
};

export const isKind = (raw: string | null | undefined): raw is BankingReviewKind =>
  KIND_ORDER.includes(raw as BankingReviewKind);

export const REASON_WORDS: Partial<Record<BankingReviewReason, string>> = {
  needs_review: "Needs review",
  suggested_match: "Suggested match",
  not_compared: "Not compared",
};

/** How a planned item fared, in plain words. */
export function fateWords(fate: BankingReviewPlanFate): string {
  switch (fate) {
    case "matched":
    case "paid_on_evidence":
      return "Paid";
    case "partial":
      return "Paid, different amount";
    case "suggested":
      return "Maybe paid";
    case "missed":
      return "Missed";
    case "skipped":
      return "Skipped";
    default:
      return "Not paid yet";
  }
}

const DAY = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayWords = (iso: string) => `${DAY[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** A money string without its sign: "−108.60" → "$108.60". The sign is said in words next to it. */
export const unsigned = (v: string): string => formatCurrency(String(v).replace(/^-/, ""));

/** "−$108.60" / "+$12.00": a cash effect, signed. Display only. */
export const signedCash = (v: string): string => {
  const n = Number(v);
  return n === 0 ? formatCurrency(0) : `${n < 0 ? "−" : "+"}${unsigned(v)}`;
};

/**
 * (F4) The variance in words, from the server's direction-aware kind: an income
 * is "less / more than expected", an expense is "over / under". Null when the
 * row compares exactly (no variance) or the server gave no kind.
 */
export function varianceWords(plan: Pick<NonNullable<BankingReviewRow["plan"]>, "variance" | "varianceKind">): string | null {
  if (plan.variance == null || plan.varianceKind == null) return null;
  const amount = unsigned(plan.variance);
  switch (plan.varianceKind) {
    case "less_than_expected":
      return `${amount} less than expected`;
    case "more_than_expected":
      return `${amount} more than expected`;
    case "over_planned":
      return `${amount} over`;
    case "under_planned":
      return `${amount} under`;
    default:
      return null;
  }
}

/** The same, short, for the big number on a row: "$108.60 less" / "$12.00 over". */
export function varianceShort(plan: Pick<NonNullable<BankingReviewRow["plan"]>, "variance" | "varianceKind">): string | null {
  const full = varianceWords(plan);
  return full ? full.replace(" than expected", "") : null;
}

/** True when the variance costs cash (income short, or an expense over). */
export const variancePinches = (kind: BankingReviewVarianceKind): boolean => kind === "less_than_expected" || kind === "over_planned";

/** One side of a bucket: "Income $108.60 less than expected" / "Bills $12.00 over". Null when nothing compares or it is exact. */
export function sideWords(side: "in" | "out", v: string | null | undefined): string | null {
  if (v == null || Number(v) === 0) return null;
  const n = Number(v);
  return side === "in"
    ? `Income ${unsigned(v)} ${n < 0 ? "less" : "more"} than expected`
    : `Bills ${unsigned(v)} ${n < 0 ? "over" : "under"}`;
}

export function daysWords(n: number): string {
  if (n === 0) return "same day";
  const a = Math.abs(n);
  return `${a} ${a === 1 ? "day" : "days"} ${n > 0 ? "late" : "early"}`;
}

/**
 * Direction-aware, no sign tricks.
 * Income: "Expected $2,500.00 · received $2,391.40 · $108.60 less than expected".
 * Expense: "Planned $140.00 · paid $152.00 · $12.00 over".
 * Null without a plan.
 */
export function planLine(row: BankingReviewRow): string | null {
  const p = row.plan;
  if (!p) return null;
  const income = p.direction === "in";
  const expected = p.expected ?? (p.planned != null ? String(p.planned).replace(/^-/, "") : null);
  const actual = p.actual ?? String(row.amount).replace(/^-/, "");
  const bits: string[] = [];
  bits.push(expected != null ? `${income ? "Expected" : "Planned"} ${formatCurrency(expected)}` : `${p.label} due ${dayWords(p.scheduledDate)}`);
  bits.push(`${income ? "received" : "paid"} ${formatCurrency(actual)}`);
  const v = varianceWords(p);
  if (v) bits.push(v);
  if (p.dayDelta != null && p.dayDelta !== 0) bits.push(daysWords(p.dayDelta));
  return bits.join(" · ");
}

/** (F4) "Filed as Dining & Coffee — looks like income": a row filed against its direction. */
export function classificationNote(row: BankingReviewRow): string | null {
  if (!row.classificationIssue) return null;
  const filed = row.category?.name ?? "a category";
  return row.classificationIssue === "inflow_into_expense"
    ? `Filed as ${filed} — looks like income`
    : `Filed as ${filed} — looks like an expense`;
}
