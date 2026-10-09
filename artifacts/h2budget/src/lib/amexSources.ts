/**
 * The sources the American Express page lists. It is really the credit-cards
 * view: Apple Card rows are folded in so they show alongside the Amex cards
 * without renaming the page — both the Plaid form ("plaid:apple-card", if it
 * ever links) and the FinanceKit/manual form ("apple-card", how it'll actually
 * arrive from the iOS app). "amex" is the Amex workbook import.
 *
 * Shared so the page's query and the transaction route rules (`accountRoute.ts`)
 * agree on which rows its "All cards" view shows: a row that view lists is
 * never told it has no ledger.
 */
export const AMEX_SOURCES: readonly string[] = ["amex", "plaid:amex", "plaid:apple-card", "apple-card"];
