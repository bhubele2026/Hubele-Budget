import { useQuery } from "@tanstack/react-query";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import {
  useListPlaidItems, getListPlaidItemsQueryKey,
  useGetForecastCashSignal, getGetForecastCashSignalQueryKey,
  useListDebts, getListDebtsQueryKey,
  useGetAmexWeeklyPayoff, getGetAmexWeeklyPayoffQueryKey,
  useGetSettings, getGetSettingsQueryKey,
  useGetBudgetMonth, getGetBudgetMonthQueryKey,
  useGetBillsSummary, getGetBillsSummaryQueryKey,
  useListRecurringItems, getListRecurringItemsQueryKey,
  useListTransactions, getListTransactionsQueryKey,
        type ListTransactionsParams,
} from "@workspace/api-client-react";
// (C0) Fold-in operations come from the features module, which only lazy
// pages import — from the main module they would sit in the landing chunk.
import {
  useGetMoneyPosition, getGetMoneyPositionQueryKey,
  previewRecap,
} from "@workspace/api-client-react/features";

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

/**
 * (D14) The recap preview is a POST that reads the household and may spend one
 * of the six daily model calls, so it is a query, not a mutation: one request
 * per open at most, none while the answer is under ten minutes old, no retry
 * (a retry is a second model call), and `meta: OWN_INVALIDATION` so it can never
 * be mistaken for a write that marks the spine, reports and ledger stale. A
 * mutation here ran the after-write rule on every open.
 */
export const RECAP_PREVIEW_KEY = ["/api/recap/preview"] as const;
export function useRecapPreviewQ() {
  const q = useQuery({
    queryKey: RECAP_PREVIEW_KEY,
    queryFn: ({ signal }) => previewRecap({}, { signal }),
    staleTime: 10 * MIN,
    gcTime: GC,
    retry: false,
    refetchOnWindowFocus: false,
    meta: OWN_INVALIDATION,
  });
  return {
    data: q.data,
    isLoading: q.isPending,
    isError: q.isError,
    retry: () => void q.refetch(),
  };
}
