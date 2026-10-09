import {
  useListCategories, getListCategoriesQueryKey,
  useListCategorizationReview, getListCategorizationReviewQueryKey,
  useGetDuplicateTransactionCount, getGetDuplicateTransactionCountQueryKey,
} from "@workspace/api-client-react";

/**
 * (C11b) The queries only the below-the-fold panels read (Recent activity,
 * Needs review). They live here, not in `queries.ts`, so their hooks join the
 * lazy `BelowFold` chunk instead of the landing chunk.
 */
const MIN = 60_000;
const GC = 30 * MIN;

export const useCategoriesQ = () =>
  useListCategories({ query: { queryKey: getListCategoriesQueryKey(), staleTime: 10 * MIN, gcTime: GC } });

/** Only the queue total is used, so the page asks for one row. */
export const useReviewQueueQ = () => {
  const params = { limit: 1 };
  return useListCategorizationReview(params, {
    query: { queryKey: getListCategorizationReviewQueryKey(params), staleTime: MIN, gcTime: GC },
  });
};

export const useDuplicateCountQ = () =>
  useGetDuplicateTransactionCount({
    query: { queryKey: getGetDuplicateTransactionCountQueryKey(), staleTime: 5 * MIN, gcTime: GC },
  });
