import type { PlaidItemDetail } from "@workspace/api-client-react";

/**
 * (#373) Map the Amex card(s) currently shown on the Amex page back to
 * the Plaid item id(s) that own them. Used to scope the page's re-auth
 * banner, the header SyncButton's inline error chip / Reconnect popover,
 * and the per-item "Refresh from Plaid" button so a Chase failure never
 * surfaces on the Amex page (and vice versa).
 *
 * Two complementary signals are accepted (both optional, deduped):
 *
 * 1. `amexExternalAccountIds` — Plaid *external* account_ids drawn
 *    from the page's Amex-source transactions
 *    (`transactions.plaidAccountId`, which is Plaid's `account_id`).
 *    Matched against `PlaidItemDetail.accounts[].accountId`.
 *
 * 2. `amexInternalAccountRowIds` — internal `plaid_accounts.id` row
 *    ids drawn from the page's linked Amex debt
 *    (`debts.plaidAccountId`, which is the internal row id, not the
 *    external account_id). Matched against
 *    `PlaidItemDetail.accounts[].id`.
 *
 * Either signal alone is enough to surface the owning item, so a
 * brand-new linked Amex debt with zero synced transactions still
 * scopes correctly, and a stale debt link doesn't hide an item that
 * is actively producing transactions.
 */
export function relevantAmexPlaidItemIds(
  items: PlaidItemDetail[] | null | undefined,
  amexExternalAccountIds: Iterable<string>,
  amexInternalAccountRowIds: Iterable<string> = [],
): string[] {
  const wantedExternal = new Set(amexExternalAccountIds);
  const wantedInternal = new Set(amexInternalAccountRowIds);
  if (wantedExternal.size === 0 && wantedInternal.size === 0) return [];
  const ids = new Set<string>();
  for (const it of items ?? []) {
    for (const a of it.accounts ?? []) {
      if (
        wantedExternal.has(a.accountId) ||
        wantedInternal.has(a.id)
      ) {
        ids.add(it.id);
        break;
      }
    }
  }
  return Array.from(ids);
}
