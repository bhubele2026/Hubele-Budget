// (#850 — Spending overhaul, Phase 1) Pure "is this real spending?" predicate.
//
// "Real spending" = money leaving the household to a MERCHANT for goods or
// services. It explicitly does NOT include:
//   - transfers between the household's own accounts
//   - debt payments (any category linked to a tracked debt row)
//   - reimbursements / ignore / transfer categories
//   - bank-noise ACH/transfer/payment description patterns
//
// Sign convention (matches the rest of the app): a bank/Chase outflow is a
// NEGATIVE amount; an Amex charge is a POSITIVE amount. `spendAmount()`
// normalizes both into a positive spend magnitude (0 when the row is not an
// outflow / is an inflow or refund).
//
// All functions here are PURE — no DB calls. The route layer builds the
// context (categoriesById + debtCategoryIds) once and passes it in.

export interface SpendTxn {
  amount: string | number;
  source: string;
  isTransfer: boolean;
  categoryId: string | null;
  description: string;
}

export interface SpendContext {
  categoriesById: Map<
    string,
    { name: string; debtId: string | null; kind: string }
  >;
  debtCategoryIds: Set<string>;
}

// Category NAMES that are never real spend (case-insensitive).
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

export function spendAmount(tx: SpendTxn): number {
  const a = typeof tx.amount === "number" ? tx.amount : parseFloat(tx.amount);
  if (!Number.isFinite(a)) return 0;
  if (tx.source === "amex") return a > 0 ? a : 0; // Amex charge is positive
  return a < 0 ? -a : 0; // bank outflow is negative
}

export function matchesTransferPattern(description: string): boolean {
  const d = (description ?? "").toLowerCase();
  return TRANSFER_PAYMENT_PATTERNS.some((p) => d.includes(p));
}

export function isExcludedCategoryName(name: string | null | undefined): boolean {
  return EXCLUDED_CATEGORY_NAMES.has((name ?? "").trim().toLowerCase());
}

export function isDebtCategory(tx: SpendTxn, ctx: SpendContext): boolean {
  if (!tx.categoryId) return false;
  if (ctx.debtCategoryIds.has(tx.categoryId)) return true;
  const cat = ctx.categoriesById.get(tx.categoryId);
  return !!cat?.debtId;
}

// A categorized merchant purchase. Uncategorized rows return false here — the
// backlog is its own surface (see buildSpendingFacts.uncategorized).
export function isRealSpend(tx: SpendTxn, ctx: SpendContext): boolean {
  if (spendAmount(tx) <= 0) return false; // not an outflow
  if (tx.isTransfer === true) return false;
  if (!tx.categoryId) return false; // uncategorized -> separate bucket
  const cat = ctx.categoriesById.get(tx.categoryId);
  if (!cat) return false;
  if (cat.kind === "income") return false; // income/refund/cashback is not spend
  if (isExcludedCategoryName(cat.name)) return false;
  if (cat.debtId || ctx.debtCategoryIds.has(tx.categoryId)) return false;
  if (matchesTransferPattern(tx.description)) return false;
  return true;
}

// Would-be real spend that is only excluded because it has no category yet.
export function isUncategorizedSpend(tx: SpendTxn): boolean {
  if (spendAmount(tx) <= 0) return false;
  if (tx.isTransfer === true) return false;
  if (tx.categoryId) return false;
  if (matchesTransferPattern(tx.description)) return false;
  return true;
}
