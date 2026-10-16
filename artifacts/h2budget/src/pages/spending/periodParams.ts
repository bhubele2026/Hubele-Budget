import type { QueryClient } from "@tanstack/react-query";
import { getListPlaidItemsQueryKey, listPlaidItems, type GetPeriodBreakdownParams } from "@workspace/api-client-react";
import { getGetPeriodBreakdownQueryKey, getPeriodBreakdown } from "@workspace/api-client-react/features";
import { householdToday } from "@/lib/householdDay";
import { resolveStart, type PeriodView } from "./periodDates";

/**
 * (P4) The This week / This month request, built in one place so the page and
 * the nav's hover warm-up ask for the same key.
 */
export const PERIOD_MIN = 60_000;

export function periodParams(view: PeriodView, start: string, account?: string): GetPeriodBreakdownParams {
  return { period: view, start, rowsPerGroup: 50, ...(account ? { account } : {}) };
}

/** The current period's first request (an empty `?start=`). */
export function currentPeriodParams(view: PeriodView, now: Date = new Date()): GetPeriodBreakdownParams {
  return periodParams(view, resolveStart(view, "", householdToday(now)));
}

export function warmPeriod(qc: QueryClient, view: PeriodView): void {
  const params = currentPeriodParams(view);
  void qc.prefetchQuery({
    queryKey: getGetPeriodBreakdownQueryKey(params),
    queryFn: () => getPeriodBreakdown(params),
    staleTime: PERIOD_MIN,
  });
  void qc.prefetchQuery({
    queryKey: getListPlaidItemsQueryKey(),
    queryFn: () => listPlaidItems(),
    staleTime: PERIOD_MIN,
  });
}
