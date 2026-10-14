import type {
  BankingReviewBucketName,
  BankingReviewKind,
  BankingReviewPlanFate,
  BankingReviewReason,
  BankingReviewRow,
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

/** A server difference as text: "+$260.00" / "-$5.00". Display only. */
const signed = (v: string) => `${Number(v) > 0 ? "+" : ""}${formatCurrency(v)}`;

export function daysWords(n: number): string {
  if (n === 0) return "same day";
  const a = Math.abs(n);
  return `${a} ${a === 1 ? "day" : "days"} ${n > 0 ? "late" : "early"}`;
}

/** "Planned $40.00 on Oct 3 → paid $300.00 on Oct 4 (+$260.00 / 2 days late)". Null without a plan. */
export function planLine(row: BankingReviewRow): string | null {
  const p = row.plan;
  if (!p) return null;
  const paid = `paid ${formatCurrency(Math.abs(Number(row.amount)))} on ${dayWords(row.date)}`;
  const planned = p.planned != null ? `Planned ${formatCurrency(Math.abs(Number(p.planned)))} on ${dayWords(p.scheduledDate)}` : `${p.label} due ${dayWords(p.scheduledDate)}`;
  const bits: string[] = [];
  if (p.difference != null && Number(p.difference) !== 0) bits.push(signed(p.difference));
  if (p.dayDelta != null && p.dayDelta !== 0) bits.push(daysWords(p.dayDelta));
  return `${planned} → ${paid}${bits.length ? ` (${bits.join(" / ")})` : ""}`;
}
