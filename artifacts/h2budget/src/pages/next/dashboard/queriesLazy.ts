import {
  useListCategories, getListCategoriesQueryKey,
  useGetDuplicateTransactionCount, getGetDuplicateTransactionCountQueryKey,
} from "@workspace/api-client-react";
import { useCategorizationQueue } from "@/hooks/useCategorizationQueue";

/**
 * (C11b) The queries only the below-the-fold panels read (Recent activity,
 * Needs review). They live here, not in `queries.ts`, so their hooks join the
 * lazy `BelowFold` chunk instead of the landing chunk.
 */
const MIN = 60_000;
const GC = 30 * MIN;

export const useCategoriesQ = () =>
  useListCategories({ query: { queryKey: getListCategoriesQueryKey(), staleTime: 10 * MIN, gcTime: GC } });

/** (F1) Only the queue total is used here, but the read shares the Review
 *  badge's key (`useCategorizationQueue`) so the queue is fetched once. */
export const useReviewQueueQ = () => useCategorizationQueue();

export const useDuplicateCountQ = () =>
  useGetDuplicateTransactionCount({
    query: { queryKey: getGetDuplicateTransactionCountQueryKey(), staleTime: 5 * MIN, gcTime: GC },
  });
