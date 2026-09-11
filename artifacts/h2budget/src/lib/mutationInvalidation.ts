import type { QueryClient } from "@tanstack/react-query";
import {
  getGetSpineQueryKey,
  getGetForecastBankBalanceExplainQueryKey,
} from "@workspace/api-client-react";

/**
 * ⭐ WHAT EVERY SUCCESSFUL WRITE MARKS STALE. `App.tsx`'s `mutationCache` calls
 * this on every mutation's success, so no page has to remember it.
 *
 * - The spine: almost any write can move one of its numbers.
 * - "Why this number?": it explains the spine's bank balance, so it must never
 *   be older than it.
 * - Every `/api/reports/*` aggregate: spending facts include category and
 *   unplanned edits, and must refresh with the ledger even when a page only
 *   invalidates transactions.
 *
 * `invalidateQueries` refetches only mounted queries; anything else is simply
 * marked stale for its next reader. `mutationInvalidation.test.ts` pins every
 * key, so dropping one fails a test.
 */
export function invalidateAfterWrite(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: getGetSpineQueryKey() });
  void queryClient.invalidateQueries({ queryKey: getGetForecastBankBalanceExplainQueryKey() });
  void queryClient.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/reports/"),
  });
  invalidateBankLedger(queryClient);
}

/**
 * (PR14) Every ledger or ledger-balance query: the Chase list's pages (an
 * infinite key, `["infinite", "/api/transactions/ledger", …]`) and the balances
 * behind its charts. Their review counts, totals and running balances move with
 * any transaction write, and neither key starts with `/api/transactions`'s own
 * list key, so the list pages' `getListTransactionsQueryKey()` never reached
 * them.
 */
export function isBankLedgerQueryKey(key: readonly unknown[]): boolean {
  return key.some(
    (k) =>
      typeof k === "string" &&
      (k.startsWith("/api/transactions/ledger") || k.startsWith("/api/transactions/balances")),
  );
}

export function invalidateBankLedger(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (q) => isBankLedgerQueryKey(q.queryKey) });
}

/** (PR14 review M3) The Chase list's pages only: not the balances behind its charts. */
export function isBankLedgerListKey(key: readonly unknown[]): boolean {
  return key.some((k) => typeof k === "string" && k.startsWith("/api/transactions/ledger"));
}

/**
 * (PR14 review M3) Marks the Chase list's pages stale once. A review write
 * moves the `reviewed` flag and nothing else (`chaseReviewMovesNoMoney`
 * integration test): no balance, spending figure or spine number, so it
 * refetches the lists and nothing more.
 */
export function invalidateBankLedgerLists(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (q) => isBankLedgerListKey(q.queryKey) });
}

/**
 * (PR14 review M3) Mutation `meta` for a write that invalidates exactly what it
 * moves itself, once, instead of the rule above firing per request: the Chase
 * review writes (a 200-id chunk loop would fire it per chunk, each refetch
 * cancelling the last while the server still did the work) and the UI-preference
 * save (it moves no data at all).
 */
export const OWN_INVALIDATION = { invalidateAfterWrite: false } as const;

export function shouldInvalidateAfterWrite(meta: Record<string, unknown> | undefined): boolean {
  return meta?.invalidateAfterWrite !== false;
}

/** What `App.tsx`'s `mutationCache` runs after every successful write. */
export function onWriteSuccess(
  queryClient: QueryClient,
  mutation: { meta?: Record<string, unknown> },
): void {
  if (shouldInvalidateAfterWrite(mutation.meta)) invalidateAfterWrite(queryClient);
}
