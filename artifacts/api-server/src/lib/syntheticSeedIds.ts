/**
 * Identifiers for the synthetic "April 2026 Chase" Plaid rows.
 *
 * The one-shot seeder that originally wrote these rows is gone, but the rows
 * it created still exist in the production database. Several guards key off
 * these exact literals — the account-dedupe tie-breaker
 * (`dedupePlaidAccounts.ts`) and the Plaid token/synthetic-item checks — so
 * the constants must outlive the seeder. Do not change the values: they are
 * primary-key-ish data in a live DB, not configuration.
 */

// (#398) Placeholder access_token on the synthetic Chase row.
// MUST pass `isValidPlaidAccessToken` (see
// `artifacts/api-server/src/lib/plaid.ts:30-50`) so the malformed-token
// sweep (`flagMalformedAccessTokens` in plaidSync.ts) never has to
// "rescue" this row. The previous value (`"synthetic-no-access"`, length
// 19, no `access-<env>-` prefix) failed the validator regex
// `^access-(sandbox|development|production)-[!-~]+$` and lit up the
// dashboard yellow "needs reconnect" banner plus the Chase header chip
// every time the API rebooted (#395 was the manual hand-clean).
// Synthetic-row classification still works downstream because
// `isSyntheticPlaidItem` keys off the `seed-` itemId prefix — no Plaid
// call is ever made against this token.
export const SYNTHETIC_CHASE_SEED_ACCESS_TOKEN =
  "access-sandbox-seed-april-2026-chase-placeholder";

export const SYNTHETIC_ITEM_ID = "seed-april-2026-chase";
export const SYNTHETIC_ACCOUNT_ID = "seed-april-2026-chase-checking";
