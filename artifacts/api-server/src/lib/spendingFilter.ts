// (#850 — Spending overhaul, Phase 1; PR7 — one spending rule) Pure "is this
// real spending?" classification.
//
// "Real spending" = money leaving the household to a MERCHANT for goods or
// services. It explicitly does NOT include:
//   - transfers between the household's own accounts
//   - debt payments (a row tagged to a debt, or a category linked to one)
//   - payments to a credit card (the purchases were counted on the card)
//   - reimbursable charges (someone else pays them back)
//   - reimbursement / ignore / transfer categories, and income categories
//   - bank-noise ACH/transfer/payment description patterns
//
// ⭐ ONE RULE. `classifyOutflow()` is the only place that decides. Every other
// predicate here (`isRealSpend`, `isUncategorizedSpend`) is a thin wrapper, so
// the Spending report, the spine's spent week/month, the Amex payoff and the
// behaviour facts cannot drift apart on what a card payment is.
//
// Sign convention (matches the rest of the app): a bank/Chase outflow is a
// NEGATIVE amount; an Amex charge is a POSITIVE amount. `spendAmount()`
// normalizes both into a positive spend magnitude (0 when the row is not an
// outflow / is an inflow or refund).
//
// All functions here are PURE — no DB calls. The route layer builds the
// context (categoriesById + debtCategoryIds) once and passes it in.

import { CARD_PAYMENT_PATTERNS } from "./mappingSeed";

// Every field the rules read is REQUIRED on purpose: a caller that forgets to
// select a column fails to compile instead of silently classifying with a
// default (a missing `debtId` would count a debt payment as spending).
export interface SpendTxn {
  amount: string | number;
  source: string;
  isTransfer: boolean;
  categoryId: string | null;
  description: string;
  /** Tagged debt payment (rule 2). */
  debtId: string | null;
  /** The user's explicit "this is a card payment" flag (rule 3). */
  isExternalCardPayment: boolean;
  /** Paid back by someone else (rule 7). */
  reimbursable: boolean;
  /** Plaid `personal_finance_category.detailed` (rule 8). */
  pfcDetailed: string | null;
  /**
   * The user decided this row's transfer status by hand. With
   * `isTransfer=false` it skips the card-payment guesses (rules 8–9): see
   * `classifyOutflow`.
   */
  isTransferUserOverridden: boolean;
}

export interface SpendContext {
  categoriesById: Map<
    string,
    { name: string; debtId: string | null; kind: string }
  >;
  debtCategoryIds: Set<string>;
}

// Category NAMES that are never real spend (case-insensitive). The system
// "Uncategorized" category is deliberately NOT here: a row parked there is
// still money spent.
const EXCLUDED_CATEGORY_NAMES: ReadonlySet<string> = new Set(
  [
    "Reimbursement",
    "Ignore",
    "Transfer",
    "Transfers in",
    "Transfers out",
    "Uncategorized — transfer",
  ].map((s) => s.toLowerCase()),
);

// Bank-noise description patterns that signal a transfer or a debt/card
// payment rather than a merchant purchase. Tested against the RAW (lowercased)
// description: several of these tokens ("web id:", "ach pmt") only exist in
// the raw bank string and are stripped by merchant-name extraction.
const TRANSFER_PAYMENT_PATTERNS: ReadonlyArray<string> = [
  "online transfer",
  "ach pmt",
  "ach payment",
  "web id:",
  "credit card pmt",
  "autopay",
  "payment thank you",
  "card pmt",
  "epay",
  "chase credit",
  "bk of amer",
  "wells fargo card",
];

/** Plaid's detailed category for a payment to a credit card (rule 8). */
export const PFC_CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

export function spendAmount(tx: Pick<SpendTxn, "amount" | "source">): number {
  const a = typeof tx.amount === "number" ? tx.amount : parseFloat(tx.amount);
  if (!Number.isFinite(a)) return 0;
  if (tx.source === "amex") return a > 0 ? a : 0; // Amex charge is positive
  return a < 0 ? -a : 0; // bank outflow is negative
}

export function matchesTransferPattern(description: string): boolean {
  const d = (description ?? "").toLowerCase();
  return TRANSFER_PAYMENT_PATTERNS.some((p) => d.includes(p));
}

/** Rule 9: the description names a payment to a credit card. */
export function matchesCardPaymentPattern(description: string): boolean {
  const d = (description ?? "").toLowerCase().replace(/\s+/g, " ");
  return CARD_PAYMENT_PATTERNS.some((p) => d.includes(p));
}

export function isExcludedCategoryName(name: string | null | undefined): boolean {
  return EXCLUDED_CATEGORY_NAMES.has((name ?? "").trim().toLowerCase());
}

export function isDebtCategory(
  tx: Pick<SpendTxn, "categoryId">,
  ctx: SpendContext,
): boolean {
  if (!tx.categoryId) return false;
  if (ctx.debtCategoryIds.has(tx.categoryId)) return true;
  const cat = ctx.categoriesById.get(tx.categoryId);
  return !!cat?.debtId;
}

export type OutflowKind =
  | "not_outflow"
  | "transfer"
  | "debt_payment"
  | "card_payment"
  | "excluded_category"
  | "income"
  | "reimbursable"
  | "bank_noise"
  | "spend";

/** Which rule decided, for tests and the transparency panel. */
export type OutflowRule =
  | "inflow"
  | "1-transfer"
  | "2-debt-id"
  | "3-external-card-payment"
  | "4-debt-category"
  | "5-excluded-category"
  | "6-income-category"
  | "7-reimbursable"
  | "8-pfc-card-payment"
  | "9-card-payment-pattern"
  | "9b-bank-noise"
  | "10-spend";

export interface OutflowClassification {
  kind: OutflowKind;
  rule: OutflowRule;
  /**
   * Only meaningful for `spend`: true when the row sits in a category that
   * still exists. No category, or a category that was deleted, is
   * uncategorized spend — still spending, shown in its own bucket.
   */
  categorized: boolean;
}

export interface ClassifyOptions {
  /**
   * Skip rule 7. The Amex payoff counts what is owed on the card, and a
   * reimbursable charge is owed to Amex whoever pays it back. Spending never
   * sets this.
   */
  reimbursableIsSpend?: boolean;
}

const out = (
  kind: OutflowKind,
  rule: OutflowRule,
  categorized = false,
): OutflowClassification => ({ kind, rule, categorized });

/**
 * ⭐ THE spending rule. First match wins:
 *
 *   1. `isTransfer`                                   → transfer
 *   2. tagged to a debt (`debtId`)                     → debt payment
 *   3. `isExternalCardPayment`                         → card payment
 *   4. category linked to a debt                       → debt payment
 *   5. excluded category name (Transfer, Ignore, …)    → excluded category
 *   6. income category                                 → income
 *   7. `reimbursable`                                  → reimbursable
 *   8. Plaid PFC LOAN_PAYMENTS_CREDIT_CARD_PAYMENT     → card payment  ┐ skipped when the
 *   9. `CARD_PAYMENT_PATTERNS` (mappingSeed.ts)        → card payment  ┘ user overrode
 *   9b. bank-noise patterns (ACH PMT, WEB ID:, …)      → bank noise
 *   10. otherwise                                      → spend
 *
 * A category id that no longer resolves (the category was deleted) is treated
 * as no category: rules 4–6 cannot apply, and the row is uncategorized spend.
 *
 * ⚠️ "This was a purchase." A row with `isTransferUserOverridden=true` and
 * `isTransfer=false` is one where the user decided its transfer status by
 * hand, and it skips rules 8–9: our guess that it is a card payment never
 * beats their decision. Rules 1–7 are recorded facts (flags, tags, categories)
 * and still apply. Bank noise (9b) is unchanged from before PR7 and still
 * applies too, so the override can never count a row that was not already
 * countable before card payments were recognized.
 *
 * Nothing is written. This decides spending totals only; `isTransfer` stays a
 * manual flag (#666).
 */
export function classifyOutflow(
  tx: SpendTxn,
  ctx: SpendContext,
  opts: ClassifyOptions = {},
): OutflowClassification {
  if (spendAmount(tx) <= 0) return out("not_outflow", "inflow");

  if (tx.isTransfer === true) return out("transfer", "1-transfer");
  if (tx.debtId) return out("debt_payment", "2-debt-id");
  if (tx.isExternalCardPayment === true) {
    return out("card_payment", "3-external-card-payment");
  }

  const cat = tx.categoryId ? ctx.categoriesById.get(tx.categoryId) : undefined;
  if (cat) {
    if (isDebtCategory(tx, ctx)) return out("debt_payment", "4-debt-category");
    if (isExcludedCategoryName(cat.name)) {
      return out("excluded_category", "5-excluded-category");
    }
    if (cat.kind === "income") return out("income", "6-income-category");
  }

  if (tx.reimbursable === true && !opts.reimbursableIsSpend) {
    return out("reimbursable", "7-reimbursable");
  }

  // `isTransfer` is false here (rule 1 returned otherwise), so an overridden
  // row reaching this line is one the user decided is NOT a transfer.
  const userSaidPurchase = tx.isTransferUserOverridden === true;
  if (!userSaidPurchase) {
    if ((tx.pfcDetailed ?? "").toUpperCase() === PFC_CARD_PAYMENT) {
      return out("card_payment", "8-pfc-card-payment");
    }
    if (matchesCardPaymentPattern(tx.description)) {
      return out("card_payment", "9-card-payment-pattern");
    }
  }

  if (matchesTransferPattern(tx.description)) {
    return out("bank_noise", "9b-bank-noise");
  }

  return out("spend", "10-spend", !!cat);
}

// A categorized merchant purchase. Uncategorized rows return false here — the
// backlog is its own surface (see buildSpendingFacts.uncategorized).
export function isRealSpend(
  tx: SpendTxn,
  ctx: SpendContext,
  opts?: ClassifyOptions,
): boolean {
  const c = classifyOutflow(tx, ctx, opts);
  return c.kind === "spend" && c.categorized;
}

// Would-be real spend that is only excluded because it has no category yet
// (or its category was deleted).
export function isUncategorizedSpend(tx: SpendTxn, ctx: SpendContext): boolean {
  const c = classifyOutflow(tx, ctx);
  return c.kind === "spend" && !c.categorized;
}

// The inflow mirror of `spendAmount()`. A bank deposit is a POSITIVE amount;
// an Amex row is never income — a credit there is a refund or the monthly
// payment arriving, both of which are the household moving its own money.
export function incomeAmount(tx: Pick<SpendTxn, "amount" | "source">): number {
  const a = typeof tx.amount === "number" ? tx.amount : parseFloat(tx.amount);
  if (!Number.isFinite(a)) return 0;
  if (tx.source === "amex") return 0;
  return a > 0 ? a : 0;
}

// "Real income" = money arriving from OUTSIDE the household — the mirror of
// `isRealSpend`, and the denominator behind "how much of what we earned did we
// spend". It is deliberately category-led: an inflow counts only when it sits
// in a category the household itself classes as income, which is what keeps
// transfers in, refunds, reimbursements and debt draws out of the figure.
//
// ⚠️ Unlike the spend side this does NOT screen on description patterns. A real
// direct deposit routinely carries the same raw ACH tokens ("web id:") the
// spend filter uses to catch bank noise, so pattern-matching here would drop
// paychecks — the one row that must never go missing. An explicit `isTransfer`
// flag still excludes, because that is a human/importer decision about THIS
// row rather than a guess from its wording.
export function isRealIncome(
  tx: Pick<SpendTxn, "amount" | "source" | "isTransfer" | "categoryId">,
  ctx: SpendContext,
): boolean {
  if (incomeAmount(tx) <= 0) return false; // not an inflow
  if (tx.isTransfer === true) return false;
  if (!tx.categoryId) return false; // uncategorized -> not yet claimed as income
  const cat = ctx.categoriesById.get(tx.categoryId);
  if (!cat) return false;
  if (cat.kind !== "income") return false;
  if (isExcludedCategoryName(cat.name)) return false;
  if (cat.debtId || ctx.debtCategoryIds.has(tx.categoryId)) return false;
  return true;
}
