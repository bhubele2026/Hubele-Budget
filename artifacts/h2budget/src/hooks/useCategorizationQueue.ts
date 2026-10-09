import { getListCategorizationReviewQueryKey, useListCategorizationReview } from "@workspace/api-client-react";
import { reviewParams } from "@/lib/reviewQueue";

/**
 * The categorization queue (`GET /categorization/review`, 20 at a time), under
 * ONE key and one set of cache options for every reader: the Review screen,
 * the nav badge and the dashboard's "Needs review" panel (CLAUDE.md §2: no
 * duplicate queries, normalized keys). It lives in the main generated module
 * because the entry-resident layout reads it for the Review badge.
 */
export function useCategorizationQueue(enabled = true) {
  return useListCategorizationReview(reviewParams, {
    query: {
      queryKey: getListCategorizationReviewQueryKey(reviewParams),
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      enabled,
    },
  });
}

/** The queue's total, or null while it has not answered (never a zero). */
export function useCategorizationQueueTotal(): number | null {
  const { data } = useCategorizationQueue();
  return data ? data.total : null;
}
