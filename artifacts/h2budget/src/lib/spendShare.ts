/**
 * (P) ONE calculation for "what share of spending is this?", used by the Reports Spending tile, the
 * Spending report (rows, pie, legend, tooltip) and anything else that prints a spending percentage.
 *
 * Measure: a category's share of ALL spending in the span. The denominator is declared, not implied:
 *   denominator = categorized spend (the server's `realSpend.total`, refunds that match a category
 *                 already netted off the category) + uncategorized spend (its own explicit row).
 * Uncategorized is never hidden and never folded into a category; it is a row of its own with its share.
 * No denominator (zero or less) means no share: "—", never NaN and never 100%.
 *
 * Pure: amounts in, numbers out. Money is held in cents inside so the sum is exact.
 */

export { shareOf, formatShare, spendingShares, spanLabel, denominatorWords } from "./reportsAnalytics";
export type { ShareInput, ShareRow, SpendShares } from "./reportsAnalytics";
