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
}
