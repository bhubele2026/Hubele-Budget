import { useGetForecastReviewCount } from "@workspace/api-client-react";

/**
 * Count of unmatched current-month bank txns for the nav's Review badge.
 * Served by the dedicated GET /forecast/review-count endpoint (three tiny
 * queries) — the layout used to pull the entire /forecast bundle on every
 * route just to derive this integer. The server mirrors
 * lib/forecastMatch.ts's filterForecastTxns/isBankTxn semantics.
 */
export function useReviewInboxCount(): number {
  const { data } = useGetForecastReviewCount({
    query: {
      // Deliberately keyed UNDER the '/api/forecast' prefix so every
      // existing `invalidateQueries({queryKey: getGetForecastQueryKey()})`
      // site (sync, match, resolution mutations) refreshes this badge too.
      queryKey: ["/api/forecast", "review-count"],
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
    },
  });
  return data?.count ?? 0;
}
