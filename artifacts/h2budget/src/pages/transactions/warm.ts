import type { QueryClient } from "@tanstack/react-query";
import {
  getGetTransactionsLedgerInfiniteQueryOptions,
} from "@workspace/api-client-react/ledger";
import { householdToday } from "@/lib/householdDay";
import { rangeForMode } from "@/lib/timeRange";
import {
  CHASE_HIDE_REVIEWED_STORAGE_KEY,
} from "./useChaseHideReviewed";
import { LEDGER_CACHE, registerFilterFor, toLedgerParams, type ChaseListFilter } from "./chaseLedger";

/**
 * (P4) The Chase register's FIRST request with an empty address: this week
 * (weekly-first), the default account, the saved "hide reviewed" seed. The
 * page builds the same filter through `registerFilterFor`.
 */
export function chaseFirstFilter(now: Date = new Date(), hideReviewed = false): ChaseListFilter | null {
  const base: ChaseListFilter = hideReviewed ? { reviewed: false } : {};
  return registerFilterFor(rangeForMode("wk", now), householdToday(now), base);
}

function hideSeed(): boolean {
  try {
    return window.localStorage.getItem(CHASE_HIDE_REVIEWED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function warmChase(qc: QueryClient): void {
  const filter = chaseFirstFilter(new Date(), hideSeed());
  if (!filter) return;
  const params = toLedgerParams(filter);
  void qc.prefetchInfiniteQuery(
    getGetTransactionsLedgerInfiniteQueryOptions(params, {
      query: { initialPageParam: undefined, staleTime: LEDGER_CACHE.staleTime, gcTime: LEDGER_CACHE.gcTime },
    }),
  );
}
