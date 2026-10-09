/**
 * The account page of one linked account: `/next/accounts/<id>`, by Plaid's
 * EXTERNAL `account_id` (the id a transaction carries, and the one the account
 * chips and the route param use). The page also accepts the internal
 * `plaid_accounts` row id, so an account whose external id is missing falls
 * back to it rather than to a link that matches no route.
 *
 * (WP7) Its own tiny module so the landing's Accounts panel can link an account
 * without loading the transaction route rules (`accountRoute.ts`), which only
 * the lazy panels and pages need: the open path has almost no headroom.
 */
export function accountPageHref(account: { plaidAccountId?: string | null; rowId?: string | null }): string {
  const id = (account.plaidAccountId ?? "").trim() || (account.rowId ?? "").trim();
  return `/next/accounts/${encodeURIComponent(id)}`;
}
