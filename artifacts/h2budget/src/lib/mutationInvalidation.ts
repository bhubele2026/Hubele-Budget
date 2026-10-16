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
 * - (T4) The period breakdown (Spending) and the Amex summary.
 * - (T1) The banking review (`/api/banking/review`, every account and range):
 *   it shows the same balance and check as the spine.
 *
 * `invalidateQueries` refetches only mounted queries; anything else is simply
 * marked stale for its next reader. `mutationInvalidation.test.ts` pins every
 * key, so dropping one fails a test.
 */
export const MONEY_POSITION_KEY = ["/api/money/position"] as const;
export const WAYS_BACK_KEY = ["/api/money/ways-back"] as const;
/** (T1) The banking review: its balance, its check and its buckets move with any write (a prefix: every account and range). */
export const BANKING_REVIEW_KEY = ["/api/banking/review"] as const;
/** (T4) Spending's period breakdown and the Amex summary: prefixes, so every param suffix is covered. */
export const PERIOD_BREAKDOWN_KEY = ["/api/money/period-breakdown"] as const;
export const AMEX_SUMMARY_KEY = ["/api/amex/summary"] as const;

export function invalidateAfterWrite(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: getGetSpineQueryKey() });
  void queryClient.invalidateQueries({ queryKey: getGetForecastBankBalanceExplainQueryKey() });
  // (F7) The money position and the ways back move with any spend, and a
  // carry-over moves both. Literal keys, not the `features` module's key
  // functions: this file is on the entry path and must not import that module.
  void queryClient.invalidateQueries({ queryKey: MONEY_POSITION_KEY });
  void queryClient.invalidateQueries({ queryKey: WAYS_BACK_KEY });
  void queryClient.invalidateQueries({ queryKey: BANKING_REVIEW_KEY });
  // (T4) Spending (every week and month, any account) and the Amex summary move with any write too.
  void queryClient.invalidateQueries({ queryKey: PERIOD_BREAKDOWN_KEY });
  void queryClient.invalidateQueries({ queryKey: AMEX_SUMMARY_KEY });
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
