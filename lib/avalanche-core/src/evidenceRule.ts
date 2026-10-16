// ⭐ (F2) THE EVIDENCE RULE — IS THIS UNFILED OUTFLOW A PURCHASE? Pure.
//
// The owner: "the week's 'counts toward plan' includes rows that are not
// purchases". A pending HELOC payment (Plaid LOAN_PAYMENTS), a savings
// transfer (TRANSFER_OUT_SAVINGS) and a bill's payment the forecast only
// SUGGESTED (a tier-3 pair) all sat in "Not filed yet" and counted against the
// weekly allowance. His decision: the headline compares CONFIRMED purchases
// only; the rest is shown apart ("may add up to $X"); safe-to-spend stays
// cautious (it keeps counting them). Nothing here writes: a correction is a
// proposal for a person.
//
// Every OUTFLOW lands in exactly one class, first match wins:
//
//   confirmed_payment  a household fact the one spending rule already reads
//                      (`classifyMovement`'s coverage): a transfer or bank
//                      noise, a debt tag or debt category, the card-payment
//                      flag or a card-payment description/category, an
//                      excluded category, a confirmed or tier-2 bill match.
//                      These are already left out of spending today.
//   known_purchase     the household filed it (a weekly / monthly / unplanned
//                      flag, or reimbursable) — or, unfiled, it carries
//                      purchase evidence (a purchase-type Plaid primary such as
//                      FOOD_AND_DRINK) or no contrary evidence at all. An ATM
//                      withdrawal (TRANSFER_OUT_WITHDRAWAL) and a payment to a
//                      person over a person-to-person rail (Zelle, Venmo, Cash
//                      App) stay purchases: the cash is spent.
//   unresolved         contrary evidence and no household confirmation:
//                        - Plaid primary LOAN_PAYMENTS (a credit card's payment
//                          is already `card_payment`, rule 8);
//                        - Plaid primary TRANSFER_OUT (savings, investment, an
//                          account transfer) or TRANSFER_IN;
//                        - Plaid primary INCOME;
//                        - a bill the forecast only suggests (a tier-3 pair, an
//                          ambiguous one, or one that underpays the bill);
//                        - money out filed under an INCOME category.
//
// A CREDIT has no purchase class. It is `unresolved` only when it is filed
// against its direction — money in under an EXPENSE category
// (`categoryDirectionConflict`: not on a card, not a refund) — and otherwise
// outside this rule (null).
//
// Every class says WHY (`reason`) and lists its evidence (`evidence`: the field
// and the value it read). An unresolved row also carries a `suggestion`: what
// it probably is, with the bill when the forecast names one.
//
// ⭐ (Task 6, A2) A SKIPPED OCCURRENCE NAMES A TARGET, NOT A REASON. When the
// forecast's matcher pairs an unfiled row with an occurrence the household
// SKIPPED (`suggestSkippedPlans`: a suggestion only, never off the curve), the
// row keeps the reason its own evidence gives ("bank says loan payment") and its
// suggestion gains that occurrence as its target, marked `skipped`, with the
// plan's amount — "Looks like <plan>, planned $P on <day> (skipped)". The class
// does not move: the row stays unresolved until the household answers. The server reads
// `pfc_primary` / `pfc_detailed` as stored (and, for a posted row with none,
// the pending row it replaced — `carriedPfc`), never a merchant name: the only
// words read from a description are the person-to-person rail names above.

import type { MovementClassification, MovementRow } from "./householdMoney";
import {
  categoryDirectionConflict,
  creditAmount,
  onCardAccount,
  spendAmount,
  type SpendContext,
} from "./spendingRule";

/** Plaid `personal_finance_category.primary` values (v1). */
export const PFC_PRIMARIES = [
  "INCOME",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "LOAN_PAYMENTS",
  "BANK_FEES",
  "ENTERTAINMENT",
  "FOOD_AND_DRINK",
  "GENERAL_MERCHANDISE",
  "HOME_IMPROVEMENT",
  "MEDICAL",
  "PERSONAL_CARE",
  "GENERAL_SERVICES",
  "GOVERNMENT_AND_NON_PROFIT",
  "TRANSPORTATION",
  "TRAVEL",
  "RENT_AND_UTILITIES",
] as const;

/** The primaries that say "a purchase": goods, services, fees. */
export const PURCHASE_PFC_PRIMARIES: ReadonlySet<string> = new Set([
  "BANK_FEES",
  "ENTERTAINMENT",
  "FOOD_AND_DRINK",
  "GENERAL_MERCHANDISE",
  "HOME_IMPROVEMENT",
  "MEDICAL",
  "PERSONAL_CARE",
  "GENERAL_SERVICES",
  "GOVERNMENT_AND_NON_PROFIT",
  "TRANSPORTATION",
  "TRAVEL",
  "RENT_AND_UTILITIES",
]);

/** An ATM or teller cash withdrawal: the cash is spent. */
export const PFC_WITHDRAWAL = "TRANSFER_OUT_WITHDRAWAL";
/** Detailed transfers that may be a payment to a person (when a person-to-person rail names it). */
const P2P_CAPABLE_DETAILED: ReadonlySet<string> = new Set([
  "TRANSFER_OUT_ACCOUNT_TRANSFER",
  "TRANSFER_OUT_OTHER_TRANSFER_OUT",
]);

/** Person-to-person payment rails, as whole words of a description (normalized). */
const P2P_RAILS: readonly (readonly string[])[] = [["zelle"], ["venmo"], ["cashapp"], ["cash", "app"], ["square", "cash"]];

export type EvidenceClass = "known_purchase" | "confirmed_payment" | "unresolved";

export type EvidenceReason =
  // known_purchase
  | "household_flag"
  | "purchase_category"
  | "atm_withdrawal"
  | "person_to_person"
  | "no_contrary_evidence"
  // confirmed_payment
  | "transfer"
  | "bank_noise"
  | "debt_payment"
  | "card_payment"
  | "excluded_category"
  | "bill_match"
  // unresolved
  | "bill_suggestion"
  | "loan_payment"
  | "transfer_evidence"
  | "income_evidence"
  | "debit_in_income_category"
  | "credit_in_expense_category";

/** Which field the rule read. */
export type EvidenceField = "pfc_primary" | "pfc_detailed" | "bill_suggestion" | "category" | "household";

export interface EvidenceItem {
  field: EvidenceField;
  /** The value read: a Plaid category, a bill's label, a category's name, a flag. */
  value: string;
}

export type SuggestionKind = "loan_payment" | "transfer" | "income" | "bill";

export interface EvidenceSuggestion {
  kind: SuggestionKind;
  /**
   * A finer word for the kind: for a transfer `savings` · `investment` ·
   * `account` · `other` · `in`; null otherwise.
   */
  detail: string | null;
  /**
   * The bill the forecast suggests; null when none is named. A `bill`
   * suggestion's own bill, or (Task 6, A2) a skipped occurrence the matcher
   * pairs with an otherwise unresolved row (`skipped: true`).
   */
  target: EvidenceTarget | null;
}

/** (Task 6, A2) The occurrence a suggestion names. `planned` is signed (negative: money out); null when not known. */
export interface EvidenceTarget {
  kind: "bill";
  itemId: string;
  label: string;
  planKey: string;
  occurrenceDate: string;
  planned: number | null;
  /** The household skipped this occurrence: Match un-skips it and matches the row in one write. */
  skipped: boolean;
}

export interface RowEvidence {
  class: EvidenceClass;
  reason: EvidenceReason;
  evidence: EvidenceItem[];
  /** Unresolved rows only: what it probably is. */
  suggestion: EvidenceSuggestion | null;
}

/** A bill a tier-3 / ambiguous / underpaying pair suggests for a row (the forecast ledger's `matches`). */
export interface BillSuggestionRef {
  planKey: string;
  itemId: string;
  label: string;
  occurrenceDate: string;
  /** (Task 6, A2) The occurrence's planned amount, signed; null or absent when not known. */
  planned?: number | null;
  /** (Task 6, A2) A SKIPPED occurrence (`suggestSkippedPlans`): a target only, never a `bill_suggestion` reason. */
  skipped?: boolean;
}

const targetOf = (b: BillSuggestionRef): EvidenceTarget => ({
  kind: "bill",
  itemId: b.itemId,
  label: b.label,
  planKey: b.planKey,
  occurrenceDate: b.occurrenceDate,
  planned: b.planned ?? null,
  skipped: b.skipped === true,
});

/** The Plaid category a posted row borrows from the pending row it replaced, when it has none of its own. */
export interface CarriedPfc {
  pfcPrimary: string | null;
  pfcDetailed: string | null;
}

/** A row as the rule reads it: `classifyMovement`'s row, plus Plaid's primary category. */
export interface EvidenceRow extends MovementRow {
  /** Plaid `personal_finance_category.primary` as stored (null on a manual row, or one before #636). */
  pfcPrimary: string | null;
  /** (pending→posted) The replaced pending row's categories, when this posted row has none. */
  carriedPfc?: CarriedPfc | null;
}

export interface EvidenceContext extends SpendContext {
  /** The household's system "Uncategorized" category ids (a row parked there is unfiled, never a conflict). */
  uncategorizedIds: ReadonlySet<string>;
  /** External ids of the household's Plaid credit accounts: a credit on one is a refund or a payment, never a conflict. */
  cardAccountIds: ReadonlySet<string>;
  /** Row id → the bill the forecast suggests for it (never a confirmed or tier-2 off-curve pair). */
  billSuggestions: ReadonlyMap<string, BillSuggestionRef>;
}

const upper = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim().toUpperCase();
  return t === "" ? null : t;
};

/** The primary a detailed category starts with (Plaid's detailed always does). */
function primaryOfDetailed(detailed: string | null): string | null {
  if (!detailed) return null;
  let best: string | null = null;
  for (const p of PFC_PRIMARIES) {
    if ((detailed === p || detailed.startsWith(`${p}_`)) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

/** The row's Plaid primary and detailed category, the posted row's own first, else the pending row's it replaced. */
export function pfcOf(row: Pick<EvidenceRow, "pfcPrimary" | "pfcDetailed" | "carriedPfc">): {
  primary: string | null;
  detailed: string | null;
} {
  const ownDetailed = upper(row.pfcDetailed);
  const ownPrimary = upper(row.pfcPrimary) ?? primaryOfDetailed(ownDetailed);
  if (ownPrimary || ownDetailed) return { primary: ownPrimary, detailed: ownDetailed };
  const cDetailed = upper(row.carriedPfc?.pfcDetailed);
  const cPrimary = upper(row.carriedPfc?.pfcPrimary) ?? primaryOfDetailed(cDetailed);
  return { primary: cPrimary, detailed: cDetailed };
}

/** Does the description name a person-to-person rail (Zelle, Venmo, Cash App) as whole words? */
export function namesPersonToPersonRail(description: string | null | undefined): boolean {
  const words = (description ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  for (let i = 0; i < words.length; i += 1) {
    for (const rail of P2P_RAILS) {
      if (rail.every((w, j) => words[i + j] === w)) return true;
    }
  }
  return false;
}

const TRANSFER_DETAIL: Readonly<Record<string, string>> = {
  TRANSFER_OUT_SAVINGS: "savings",
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: "investment",
  TRANSFER_OUT_ACCOUNT_TRANSFER: "account",
  TRANSFER_OUT_OTHER_TRANSFER_OUT: "other",
};

const known = (reason: EvidenceReason, evidence: EvidenceItem[]): RowEvidence => ({
  class: "known_purchase",
  reason,
  evidence,
  suggestion: null,
});
const paid = (reason: EvidenceReason, evidence: EvidenceItem[] = []): RowEvidence => ({
  class: "confirmed_payment",
  reason,
  evidence,
  suggestion: null,
});

/** The Plaid evidence items for a row (what a screen shows beside the class). */
function pfcItems(pfc: { primary: string | null; detailed: string | null }): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  if (pfc.primary) out.push({ field: "pfc_primary", value: pfc.primary });
  if (pfc.detailed) out.push({ field: "pfc_detailed", value: pfc.detailed });
  return out;
}

/** What Plaid's category says against a purchase, if anything. */
function pfcContrary(
  pfc: { primary: string | null; detailed: string | null },
  description: string,
): { reason: EvidenceReason; suggestion: EvidenceSuggestion } | "atm" | "p2p" | null {
  switch (pfc.primary) {
    case "LOAN_PAYMENTS":
      return { reason: "loan_payment", suggestion: { kind: "loan_payment", detail: null, target: null } };
    case "TRANSFER_OUT": {
      if (pfc.detailed === PFC_WITHDRAWAL) return "atm";
      if ((pfc.detailed == null || P2P_CAPABLE_DETAILED.has(pfc.detailed)) && namesPersonToPersonRail(description)) return "p2p";
      return {
        reason: "transfer_evidence",
        suggestion: { kind: "transfer", detail: (pfc.detailed && TRANSFER_DETAIL[pfc.detailed]) ?? "other", target: null },
      };
    }
    case "TRANSFER_IN":
      return { reason: "transfer_evidence", suggestion: { kind: "transfer", detail: "in", target: null } };
    case "INCOME":
      return { reason: "income_evidence", suggestion: { kind: "income", detail: null, target: null } };
    default:
      return null;
  }
}

/**
 * ⭐ THE EVIDENCE RULE for one row. `m` is `classifyMovement`'s answer for the
 * same row and context (the caller already has it). Returns null for a row
 * outside the rule: a $0 row, or a credit that is not filed against its
 * direction. See the file header for every class.
 */
export function classifyEvidence(
  row: EvidenceRow,
  m: Pick<MovementClassification, "coverage" | "rule">,
  ctx: EvidenceContext,
): RowEvidence | null {
  const pfc = pfcOf(row);
  if (spendAmount(row) > 0) {
    switch (m.coverage) {
      case "transfer":
        return paid(m.rule === "bank_noise" ? "bank_noise" : "transfer", pfcItems(pfc));
      case "debt_payment":
        return paid("debt_payment", pfcItems(pfc));
      case "card_payment":
        return paid("card_payment", pfcItems(pfc));
      case "excluded":
        return paid("excluded_category", categoryItem(row, ctx));
      case "bill_matched":
        return paid("bill_match", pfcItems(pfc));
      case "income": {
        // Money out filed under an income category: excluded from spending
        // today, and filed against its direction.
        const contrary = pfcContrary(pfc, row.description);
        return {
          class: "unresolved",
          reason: "debit_in_income_category",
          evidence: [...categoryItem(row, ctx), ...pfcItems(pfc)],
          suggestion: contrary && typeof contrary === "object" ? contrary.suggestion : null,
        };
      }
      case "reimbursable":
        return known("household_flag", [{ field: "household", value: "reimbursable" }]);
      case "unplanned":
        return known("household_flag", [{ field: "household", value: "unplanned_allowance" }]);
      case "allowance_monthly":
        return known("household_flag", [{ field: "household", value: "monthly_allowance" }]);
      case "allowance_weekly":
        return known("household_flag", [{ field: "household", value: "weekly_allowance" }]);
      case "needs_classification":
        return unfiledOutflow(row, pfc, ctx);
      case "refund": // an inflow; unreachable for an outflow
        return null;
    }
  }
  if (creditAmount(row) > 0) {
    const conflict = categoryDirectionConflict(row, row.categoryId, ctx, {
      isCardAccount: onCardAccount(row, ctx.cardAccountIds),
      uncategorizedIds: ctx.uncategorizedIds,
    });
    if (conflict !== "inflow_into_expense") return null;
    const contrary = pfcContrary(pfc, row.description);
    return {
      class: "unresolved",
      reason: "credit_in_expense_category",
      evidence: [...categoryItem(row, ctx), ...pfcItems(pfc)],
      suggestion: contrary && typeof contrary === "object" ? contrary.suggestion : null,
    };
  }
  return null;
}

function categoryItem(row: Pick<EvidenceRow, "categoryId">, ctx: SpendContext): EvidenceItem[] {
  const name = row.categoryId ? ctx.categoriesById.get(row.categoryId)?.name : undefined;
  return name ? [{ field: "category", value: name }] : [];
}

/** An outflow nobody filed: contrary evidence makes it unresolved; otherwise it is a purchase. */
function unfiledOutflow(
  row: EvidenceRow,
  pfc: { primary: string | null; detailed: string | null },
  ctx: EvidenceContext,
): RowEvidence {
  const suggested = ctx.billSuggestions.get(row.id);
  // (Task 6, A2) A skipped occurrence is a target for the row's own suggestion, never a reason.
  const bill = suggested && !suggested.skipped ? suggested : null;
  const skipped = suggested?.skipped ? suggested : null;
  const contrary = pfcContrary(pfc, row.description);
  if (bill) {
    return {
      class: "unresolved",
      reason: "bill_suggestion",
      evidence: [{ field: "bill_suggestion", value: bill.label }, ...pfcItems(pfc)],
      suggestion: { kind: "bill", detail: null, target: targetOf(bill) },
    };
  }
  if (contrary === "atm") return known("atm_withdrawal", pfcItems(pfc));
  if (contrary === "p2p") return known("person_to_person", pfcItems(pfc));
  if (contrary) {
    return {
      class: "unresolved",
      reason: contrary.reason,
      evidence: pfcItems(pfc),
      suggestion: skipped ? { ...contrary.suggestion, target: targetOf(skipped) } : contrary.suggestion,
    };
  }
  if (pfc.primary && PURCHASE_PFC_PRIMARIES.has(pfc.primary)) return known("purchase_category", pfcItems(pfc));
  return known("no_contrary_evidence", pfcItems(pfc));
}
