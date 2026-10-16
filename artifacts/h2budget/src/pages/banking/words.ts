import type {
  BankingReviewBucket,
  BankingReviewBucketName,
  BankingReviewKind,
  BankingReviewPlanFate,
  BankingReviewPlanned,
  BankingReviewPlanOutcome,
  BankingReviewReason,
  BankingReviewRow,
  BankingReviewVarianceKind,
} from "@workspace/api-client-react/features";
import { formatCurrency } from "@/lib/utils";

/** (W3) The words on the Banking review. Short; the owner asked for fewer. */

export const BUCKETS: Array<{ name: BankingReviewBucketName; title: string; line: string }> = [
  { name: "unmatched", title: "Unplanned activity", line: "Money in or out the plan did not list" },
  { name: "amountDifference", title: "Amount differences", line: "On the plan, but a different amount" },
  { name: "timingDifference", title: "Timing differences", line: "On the plan, but more than 3 days early or late" },
  { name: "confirmedUnplanned", title: "Marked unplanned", line: "You marked these unplanned" },
  { name: "uncertain", title: "Unclear", line: "H2 can't tell yet" },
];

/** The pill's second line: "In $135.13 · Out $4,603.46", a zero side left out. Never a net. */
export function inOutWords(t: { moneyIn: string; moneyOut: string }): string {
  const parts: string[] = [];
  if (!isZeroMoney(t.moneyIn)) parts.push(`In ${formatCurrency(t.moneyIn)}`);
  if (!isZeroMoney(t.moneyOut)) parts.push(`Out ${formatCurrency(t.moneyOut)}`);
  return parts.join(" · ");
}

/** A kind chip: "Spending 3 · Out $112.80" (the kind's own in and out, apart). */
export function kindChipWords(kind: BankingReviewKind, t: { count: number; moneyIn: string; moneyOut: string }): string {
  return [`${KIND_WORDS[kind]} ${t.count}`, inOutWords(t)].filter(Boolean).join(" · ");
}

/**
 * The one line under the selected title, only when it says something the pill does not.
 * Amount differences: the direction-aware lines; timing: the rule; unclear: the reason counts.
 */
export function bucketNote(name: BankingReviewBucketName, b: Pick<BankingReviewBucket, "varianceIn" | "varianceOut" | "byReason">): string | null {
  switch (name) {
    case "amountDifference": {
      const sides = [sideWords("in", b.varianceIn), sideWords("out", b.varianceOut)].filter((x): x is string => !!x);
      return sides.length ? sides.join(" · ") : "On the plan, but a different amount";
    }
    case "timingDifference":
      return "On the plan, but more than 3 days early or late";
    case "uncertain": {
      const r = b.byReason;
      const parts: string[] = [];
      if (r && r.needs_review.count > 0) parts.push(`${r.needs_review.count} needs review`);
      if (r && r.suggested_match.count > 0) parts.push(`${r.suggested_match.count} suggested ${r.suggested_match.count === 1 ? "match" : "matches"}`);
      // (Task 6) Spending's own word for the same rows: the bank's evidence leaves them open.
      if (r?.evidence_unresolved && r.evidence_unresolved.count > 0) parts.push(`${r.evidence_unresolved.count} unconfirmed`);
      return parts.length ? parts.join(" · ") : null;
    }
    default:
      return null;
  }
}

/**
 * (Q5) One bucket in words for a screen reader (and the tooltip): the count,
 * then money in and money out apart. The server's `net` (in − out) is never
 * called a total moved: in and out are both said.
 */
export function bucketAria(
  title: string,
  b: Pick<BankingReviewBucket, "count" | "moneyIn" | "moneyOut"> & Partial<Pick<BankingReviewBucket, "varianceIn" | "varianceOut">>,
): string {
  // The variance leads, as on the card (the brief): the same lines the card shows, then the count, then in and out.
  const parts = [sideWords("in", b.varianceIn), sideWords("out", b.varianceOut)].filter((x): x is string => !!x);
  parts.push(`${b.count} ${b.count === 1 ? "row" : "rows"}`);
  if (!isZeroMoney(b.moneyIn)) parts.push(`money in ${formatCurrency(b.moneyIn)}`);
  if (!isZeroMoney(b.moneyOut)) parts.push(`money out ${formatCurrency(b.moneyOut)}`);
  return `${title}: ${parts.join(", ")}`;
}

export const isZeroMoney = (v: string | null | undefined): boolean => Math.round(Number(v ?? 0) * 100) === 0;

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
  // (Task 6) The word Spending uses for the same row ("Unconfirmed").
  evidence_unresolved: "Unconfirmed",
};

const TRANSFER_TO: Record<string, string> = {
  savings: "a transfer to savings",
  investment: "a transfer to investments",
  account: "a transfer between accounts",
  in: "a transfer in",
  other: "a transfer",
};

/**
 * ⭐ (Task 6, A2) Why an Unclear row is unclear, in the evidence rule's own words
 * — the very words Spending prints (`@/lib/evidenceWords` `evidenceWords`),
 * capitalised: "Bank says loan payment". Null when the row is not unresolved.
 * ⚠️ Kept here, not imported: importing that module from a second lazy page
 * splits it into a chunk of its own, and the new chunk's name in the landing's
 * preload map costs 44 bytes the landing cap does not have. `words.test.ts`
 * pins these equal to `evidenceWords` for every reason.
 */
export function evidenceLine(row: Pick<BankingReviewRow, "rowEvidence">): string | null {
  const e = row.rowEvidence;
  if (!e || e.class !== "unresolved") return null;
  switch (e.reason) {
    case "loan_payment":
      return "Bank says loan payment";
    case "transfer_evidence":
      return `Bank says ${TRANSFER_TO[e.suggestion?.detail ?? "other"] ?? "a transfer"}`;
    case "income_evidence":
      return "Bank says income";
    case "bill_suggestion":
      return e.suggestion?.target?.label ? `May be the ${e.suggestion.target.label} bill` : "May be a bill";
    case "debit_in_income_category":
      return "Money out filed under an income category";
    case "credit_in_expense_category":
      return "Money in filed under an expense category";
    default:
      return null;
  }
}

/** The occurrence an unresolved row's suggestion names, when there is one (a skipped one included). */
export function suggestionTarget(row: Pick<BankingReviewRow, "rowEvidence">) {
  const e = row.rowEvidence;
  if (!e || e.class !== "unresolved") return null;
  return e.suggestion?.target ?? null;
}

/**
 * (Task 6, A2) "Looks like Credit Line (Northwind), planned $820.00 on May 2 (skipped)".
 * The plan, its planned amount and its day — and "(skipped)" when the household skipped it.
 */
export function suggestionTargetLine(t: { label: string; planned: string | null; occurrenceDate: string; skipped: boolean }): string {
  const planned = t.planned != null ? `, planned ${unsigned(t.planned)} on ${dayWords(t.occurrenceDate)}` : ` on ${dayWords(t.occurrenceDate)}`;
  return `Looks like ${t.label}${planned}${t.skipped ? " (skipped)" : ""}`;
}

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
    case "carried":
      return "Carried";
    default:
      return "Not paid yet";
  }
}

/**
 * (Q5) A planned item's outcome in the direction of its money: income is
 * "Received / Received, different amount / Not received yet", a payment is
 * "Paid / Paid, different amount / Not paid yet". The server names it
 * (`outcome`, core `bankReviewPlanOutcome`); older answers fall back to `fate`.
 */
export function outcomeWords(outcome: BankingReviewPlanOutcome, direction: "in" | "out"): string {
  const inn = direction === "in";
  switch (outcome) {
    case "received":
      return "Received";
    case "received_different":
      return "Received, different amount";
    case "not_received_yet":
      return "Not received yet";
    case "paid":
      return "Paid";
    case "paid_different":
      return "Paid, different amount";
    case "not_paid_yet":
      return "Not paid yet";
    case "suggested":
      return inn ? "Maybe received" : "Maybe paid";
    case "skipped":
      return "Skipped";
    case "missed":
      return "Missed";
    case "carried":
      return "Carried";
    case "not_due":
      return "Not due yet";
    default:
      return "Not decided";
  }
}

/**
 * ⭐ (F5 round 2, Q5) A planned item's fate as the household reads it: a card week
 * whose unpaid purchases moved on reads "Carried to Oct 15" (never "Missed"); one
 * paid in part reads "Part paid · $210.00 still owed". Otherwise the direction-aware
 * outcome (`Received, different amount` for a paycheck, `Paid, different amount` for a bill).
 */
export function plannedFateWords(
  p: Pick<BankingReviewPlanned, "fate" | "carriedTo" | "onCurve" | "remainder"> & { outcome?: BankingReviewPlanOutcome; direction?: "in" | "out" },
): string {
  if (p.fate === "carried") return p.carriedTo ? `Carried to ${dayWords(p.carriedTo)}` : "Carried";
  if (p.fate === "paid_on_evidence" && p.onCurve && p.remainder != null && Number(p.remainder) !== 0) return `Part paid · ${unsigned(p.remainder)} still owed`;
  if (p.outcome) return outcomeWords(p.outcome, p.direction ?? "out");
  return fateWords(p.fate);
}

const DAY = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayWords = (iso: string) => `${DAY[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** A money string without its sign: "−108.60" → "$108.60". The sign is said in words next to it. */
export const unsigned = (v: string): string => formatCurrency(String(v).replace(/^-/, ""));

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

/** A pill's short side: "Income $60.00 less" / "Bills $12.00 over" (`sideWords` without " than expected"). */
export function sideShort(side: "in" | "out", v: string | null | undefined): string | null {
  return sideWords(side, v)?.replace(" than expected", "") ?? null;
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
