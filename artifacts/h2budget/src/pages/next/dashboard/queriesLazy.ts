import {
  useListCategories, getListCategoriesQueryKey,
  useGetDuplicateTransactionCount, getGetDuplicateTransactionCountQueryKey,
  useGetBudgetMonth, getGetBudgetMonthQueryKey,
  useListRecurringItems, getListRecurringItemsQueryKey,
  useListTransactions, getListTransactionsQueryKey,
  type ListTransactionsParams,
} from "@workspace/api-client-react";
import { useCategorizationQueue } from "@/hooks/useCategorizationQueue";

/**
 * (C11b, dashboard refinement) The queries only the panels after first paint
 * read (coming up, spending pace, needs attention, recent activity). They live
 * here, not in `queries.ts`, so their hooks join the lazy `BelowFold` chunk
 * instead of the landing chunk.
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

export const useBudgetMonthQ = (monthStart: string) =>
  useGetBudgetMonth(monthStart, {
    query: { queryKey: getGetBudgetMonthQueryKey(monthStart), staleTime: 5 * MIN, gcTime: GC },
  });

export const useRecurringQ = () =>
  useListRecurringItems({ query: { queryKey: getListRecurringItemsQueryKey(), staleTime: 10 * MIN, gcTime: GC } });

/** Bounded: always from/to + a limit of at most 100. */
export const useTxnsQ = (params: ListTransactionsParams) =>
  useListTransactions(params, {
    query: { queryKey: getListTransactionsQueryKey(params), staleTime: MIN, gcTime: GC },
  });

/** The recent window both Recent activity (its newest 6) and the
 *  income-in-expense check read: ONE bounded request, shared by key. */
export const RECENT_WINDOW_DAYS = 30;
export const RECENT_LIMIT = 100;
export const useRecentTxnsQ = (today: string, from: string) =>
  useTxnsQ({ from, to: today, limit: RECENT_LIMIT });
