import {
  getListCategorizationReviewQueryKey,
  useGetCategorizationReviewCount,
  useListCategorizationReview,
} from "@workspace/api-client-react";
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

/**
 * The queue's total for the nav badge, or null while it has not answered (never
 * a zero). (P4) It asks `GET /categorization/review/count` (one number), not the
 * 20-row queue. The key sits UNDER the queue's list key, so every invalidation of
 * the queue still refreshes the badge.
 */
export function useCategorizationQueueTotal(): number | null {
  const { data } = useGetCategorizationReviewCount({
    query: {
      queryKey: [...getListCategorizationReviewQueryKey(), "count"],
      staleTime: 60_000,
      gcTime: 30 * 60_000,
    },
  });
  return data ? data.total : null;
}
