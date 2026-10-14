import type { RowEvidence, RowEvidenceReason } from "@workspace/api-client-react";

/**
 * (F4) The plain words for the server's evidence rule (`RowEvidence`). Display
 * only: the class, reason, items and suggestion come from the server; nothing
 * here decides whether a row counts.
 */

const TRANSFER_TO: Record<string, string> = {
  savings: "a transfer to savings",
  investment: "a transfer to investments",
  account: "a transfer between accounts",
  in: "a transfer in",
  other: "a transfer",
};

/** "bank says loan payment" — the evidence in a few words (lower-case, no full stop). */
export function evidenceWords(e: RowEvidence | null | undefined): string {
  if (!e) return "";
  switch (e.reason) {
    case "loan_payment":
      return "bank says loan payment";
    case "transfer_evidence":
      return `bank says ${TRANSFER_TO[e.suggestion?.detail ?? "other"] ?? "a transfer"}`;
    case "income_evidence":
      return "bank says income";
    case "bill_suggestion":
      return e.suggestion?.target?.label ? `may be the ${e.suggestion.target.label} bill` : "may be a bill";
    case "debit_in_income_category":
      return "money out filed under an income category";
    case "credit_in_expense_category":
      return "money in filed under an expense category";
    default:
      return "";
  }
}

/** One line: why an unconfirmed row is not counted yet. */
export function whyNotCounted(e: RowEvidence | null | undefined): string {
  const w = evidenceWords(e);
  return w ? `Not counted yet: ${w}.` : "Not counted yet.";
}

/** What H2 thinks it is, as a short suggestion ("Probably a loan payment"). */
export function suggestionWords(e: RowEvidence | null | undefined): string {
  const s = e?.suggestion;
  if (!s) return "";
  switch (s.kind) {
    case "loan_payment":
      return "Probably a loan payment";
    case "transfer":
      return `Probably ${TRANSFER_TO[s.detail ?? "other"] ?? "a transfer"}`;
    case "income":
      return "Probably income";
    case "bill":
      return s.target?.label ? `Probably the ${s.target.label} bill` : "Probably a bill";
    default:
      return "";
  }
}

const PAYMENT_WORDS: Partial<Record<RowEvidenceReason, string>> = {
  transfer: "Transfer",
  bank_noise: "Bank entry",
  debt_payment: "Debt payment",
  card_payment: "Card payment",
  excluded_category: "Excluded category",
  bill_match: "Matched to a bill",
};

/** Why a payment is not spending ("Card payment"). */
export function paymentWords(e: RowEvidence | null | undefined): string {
  return (e && PAYMENT_WORDS[e.reason]) || "";
}
