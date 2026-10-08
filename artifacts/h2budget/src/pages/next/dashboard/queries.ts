import { useEffect, useRef } from "react";
import {
  useListPlaidItems, getListPlaidItemsQueryKey,
  useGetForecastCashSignal, getGetForecastCashSignalQueryKey,
  useListDebts, getListDebtsQueryKey,
  useGetAmexWeeklyPayoff, getGetAmexWeeklyPayoffQueryKey,
  useGetMoneyPosition, getGetMoneyPositionQueryKey,
  useGetSettings, getGetSettingsQueryKey,
  useGetBudgetMonth, getGetBudgetMonthQueryKey,
  useGetBillsSummary, getGetBillsSummaryQueryKey,
  useListRecurringItems, getListRecurringItemsQueryKey,
  useListTransactions, getListTransactionsQueryKey,
  useListCategories, getListCategoriesQueryKey,
  useListCategorizationReview, getListCategorizationReviewQueryKey,
  useGetDuplicateTransactionCount, getGetDuplicateTransactionCountQueryKey,
  usePreviewRecap,
  type ListTransactionsParams,
} from "@workspace/api-client-react";

/**
 * Every query the dashboard reads, each with an explicit key and staleTime so
 * a panel never invents its own copy. Keys match the pages that own the same
 * data, so navigating here from them (or back) refetches nothing new.
 */
const MIN = 60_000;
const GC = 30 * MIN;

export const usePlaidItemsQ = () =>
  useListPlaidItems({ query: { queryKey: getListPlaidItemsQueryKey(), staleTime: MIN, gcTime: GC } });

export const useCashSignalQ = (horizonDays: number) => {
  const params = { horizonDays };
  return useGetForecastCashSignal(params, {
    query: { queryKey: getGetForecastCashSignalQueryKey(params), staleTime: 5 * MIN, gcTime: GC },
  });
};

export const useDebtsQ = () =>
  useListDebts({ query: { queryKey: getListDebtsQueryKey(), staleTime: 5 * MIN, gcTime: GC } });

export const useAmexQ = () =>
  useGetAmexWeeklyPayoff(undefined, { query: { queryKey: getGetAmexWeeklyPayoffQueryKey(), staleTime: 5 * MIN, gcTime: GC } });

export const useMoneyPositionQ = () =>
  useGetMoneyPosition({ query: { queryKey: getGetMoneyPositionQueryKey(), staleTime: MIN, gcTime: GC } });

export const useSettingsQ = () =>
  useGetSettings({ query: { queryKey: getGetSettingsQueryKey(), staleTime: 10 * MIN, gcTime: GC } });

export const useBudgetMonthQ = (monthStart: string) =>
  useGetBudgetMonth(monthStart, {
    query: { queryKey: getGetBudgetMonthQueryKey(monthStart), staleTime: 5 * MIN, gcTime: GC },
  });

export const useBillsSummaryQ = () =>
  useGetBillsSummary(undefined, { query: { queryKey: getGetBillsSummaryQueryKey(), staleTime: 5 * MIN, gcTime: GC } });

export const useRecurringQ = () =>
  useListRecurringItems({ query: { queryKey: getListRecurringItemsQueryKey(), staleTime: 10 * MIN, gcTime: GC } });

/** Bounded: always from/to + a limit of at most 100. */
export const useTxnsQ = (params: ListTransactionsParams) =>
  useListTransactions(params, {
    query: { queryKey: getListTransactionsQueryKey(params), staleTime: MIN, gcTime: GC },
  });

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

/** The recap preview is a POST; ask once on mount and keep the answer. */
export function useRecapPreviewQ() {
  const m = usePreviewRecap();
  const asked = useRef(false);
  const { mutate } = m;
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    mutate({ data: {} });
  }, [mutate]);
  return {
    data: m.data,
    isLoading: m.isPending || (!m.data && !m.isError),
    isError: m.isError,
    retry: () => mutate({ data: {} }),
  };
}
