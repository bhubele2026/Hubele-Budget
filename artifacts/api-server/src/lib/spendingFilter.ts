// (#850 — Spending overhaul, Phase 1; PR7 — one spending rule)
//
// ⭐ The rule itself lives in `@workspace/avalanche-core` (spendingRule.ts) so
// the web app runs the SAME code, not a copy. This module is the server's
// import path for it; add nothing here that decides spending.
export {
  CARD_PAYMENT_PATTERNS,
  CARD_PAYMENT_WORD_PREFIXES,
  GENERIC_CARD_PAYMENT_PHRASES,
  PFC_CARD_PAYMENT,
  classifyOutflow,
  incomeAmount,
  isDebtCategory,
  isExcludedCategoryName,
  isRealIncome,
  isRealSpend,
  isUncategorizedSpend,
  matchesCardPaymentPattern,
  matchesTransferPattern,
  normalizeDescription,
  spendAmount,
  type ClassifyOptions,
  type OutflowClassification,
  type OutflowKind,
  type OutflowRule,
  type SpendContext,
  type SpendTxn,
} from "@workspace/avalanche-core";
