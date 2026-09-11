import { useMemo } from "react";
import type { LedgerPage, LedgerRow } from "@workspace/api-client-react";
import { useGetTransactionsLedgerInfinite } from "@workspace/api-client-react/ledger";
import {
  LEDGER_CACHE,
  flattenLedgerPages,
  toLedgerParams,
  type ChaseListFilter,
} from "./chaseLedger";

export type ChaseLedgerRead = {
  /** False when there is nothing to ask for (e.g. no day of the range is through today). */
  enabled: boolean;
  /** Every loaded row, in the server's order, each id once. */
  rows: LedgerRow[];
  /** The first page: counts, totals and balances (identical on every page). */
  first: LedgerPage | undefined;
  /** Showing another filter's rows while this one loads. */
  isPlaceholderData: boolean;
  isLoading: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  /** The server's error code (`invalid_account`, …) when the request failed. */
  errorCode: string | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => Promise<unknown>;
};

/**
 * One list of the Chase ledger, paged 50 at a time with "Load more".
 *
 * A generated infinite-query hook (orval `useInfinite` on the `cursor` param),
 * with an explicit cache (CLAUDE.md §2). `null` asks for nothing.
 */
export function useChaseLedger(filter: ChaseListFilter | null): ChaseLedgerRead {
  const key = filter ? JSON.stringify(filter) : null;
  // Keyed on the serialised filter so a re-render with an equal filter keeps the
  // same params object (and the same query).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const params = useMemo(() => (filter ? toLedgerParams(filter) : undefined), [key]);
  const enabled = filter !== null;
  const q = useGetTransactionsLedgerInfinite(params, {
    query: {
      enabled,
      initialPageParam: undefined,
      getNextPageParam: (last: LedgerPage) => last.nextCursor ?? undefined,
      staleTime: LEDGER_CACHE.staleTime,
      gcTime: LEDGER_CACHE.gcTime,
    },
  });
  const pages = enabled ? q.data?.pages : undefined;
  const rows = useMemo(() => flattenLedgerPages(pages), [pages]);
  const code = (q.error as { data?: { code?: unknown } } | null)?.data?.code;
  return {
    enabled,
    rows,
    first: pages?.[0],
    isPlaceholderData: enabled && q.isPlaceholderData,
    isLoading: enabled && q.isLoading,
    isLoadingError: enabled && q.isLoadingError,
    isRefetchError: enabled && q.isRefetchError,
    errorCode: enabled && typeof code === "string" ? code : null,
    hasNextPage: enabled && q.hasNextPage,
    isFetchingNextPage: q.isFetchingNextPage,
    fetchNextPage: () => {
      void q.fetchNextPage();
    },
    refetch: () => q.refetch(),
  };
}
