import {
  useListPlaidItems, getListPlaidItemsQueryKey,
  useGetForecastCashSignal, getGetForecastCashSignalQueryKey,
  useListDebts, getListDebtsQueryKey,
  useGetAmexWeeklyPayoff, getGetAmexWeeklyPayoffQueryKey,
  useListPlaidLiabilityAccounts, getListPlaidLiabilityAccountsQueryKey,
  // (F3b) The first screen's one fold-in read comes from the MAIN module, on
  // purpose. This file is on the entry path, and importing `/features` here
  // pulled the WHOLE sub-module into the entry chunk (Rollup keeps a module
  // whole in the chunk that statically imports it, and retains every export a
  // lazy chunk uses). The main module is in the entry chunk anyway and carries
  // the same operation; featuresImportGraph.test.ts allows exactly this one.
  // (Dashboard refinement) The recap preview left: it loads on demand now.
  useGetMoneyPosition, getGetMoneyPositionQueryKey,
} from "@workspace/api-client-react";

/**
 * Every query the dashboard's FIRST SCREEN reads (header, summary row,
 * accounts), each with an explicit key and staleTime so a panel never invents
 * its own copy. Keys match the pages that own the same data, so navigating
 * here from them (or back) refetches nothing new. The panels that load after
 * first paint read `queriesLazy.ts` (plus these, shared by key).
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

/**
 * The card and loan figures Plaid's liabilities product stored (balance,
 * minimum, due day), for an account that is not on the debt list. Asked ONLY
 * when such an account exists (`enabled`), never with `refresh`, so it reads
 * the stored columns. ⚠️ The endpoint makes one opportunistic liabilities
 * fetch when the household has NEVER had liability data; a household with
 * cards on the debt list never asks.
 */
export const useLiabilityAccountsQ = (enabled: boolean) =>
  useListPlaidLiabilityAccounts(undefined, {
    query: { queryKey: getListPlaidLiabilityAccountsQueryKey(), staleTime: 30 * MIN, gcTime: GC, enabled },
  });
