/**
 * (#642) Shared transfer / card-payment heuristic.
 *
 * Both the API server (auto-categorize, startup reclassify sweep, write-path
 * guards) and the web client (dashboard bucket membership predicate, chip
 * detection) must agree on what "looks like a transfer" so the dashboard's
 * Unplanned bucket can never sum a transfer-looking row regardless of how
 * its allowance flag got set. Lifting the patterns into the shared
 * `@workspace/api-zod` package keeps the two sides in lockstep — there is
 * no zod dependency here so this remains a zero-cost addition for both
 * runtimes.
 */
/**
 * Plaid `personal_finance_category.primary` values that always represent
 * money-movement between the user's own accounts and must NOT count toward
 * either budgeted income or budgeted spending.
 *
 * `LOAN_PAYMENTS` covers credit-card payments from a checking account
 * (Plaid's detailed code `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`).
 */
export declare const TRANSFER_PFC_PRIMARY: ReadonlySet<string>;
/**
 * Description fragments (case-insensitive) that flag obvious internal
 * transfers / card payments even when no Plaid PFC is available
 * (e.g. ODP between checking/savings, the credit-card side of a payment
 * row, etc).
 */
export declare const TRANSFER_DESC_PATTERNS: readonly string[];
/**
 * Returns true when the input matches any card-payment / transfer
 * heuristic (PFC OR description pattern). Pure function, safe to call
 * from both the server and the browser.
 */
export declare function isHeuristicTransfer(description: string | null | undefined, pfcPrimary?: string | null): boolean;
//# sourceMappingURL=transferHeuristic.d.ts.map