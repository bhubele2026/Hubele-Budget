import { useGetSpine, getGetSpineQueryKey, type Spine } from "@workspace/api-client-react";
import { dataState, type DataState } from "@/lib/queryState";

/**
 * ⭐ THE SPINE — one snapshot, read once, shared by every surface that quotes
 * it. Ported from the classic app (`hooks/useSpine.ts`); same key, same cache.
 *
 * `/api/spine` computes the household's shared figures server-side in one pass,
 * each from the same function its owning page's endpoint calls, with an
 * integration test asserting they agree to the cent.
 *
 * ⚠️ NEVER RECOMPUTE A SPINE NUMBER LOCALLY. A screen that shows a figure the
 * spine carries reads it from here.
 *
 * ⚠️ IT SAYS WHEN IT CANNOT BE TRUSTED. `state` separates cold, loaded,
 * refreshing, a failed refresh (the last good numbers stay on screen) and a
 * failed first load, so no surface paints "$0" for a spine it never received.
 *
 * `staleTime` is 60 s. Every successful mutation invalidates it centrally (the
 * `mutationCache` in data/queryClient.ts), so the staleTime never hides a write.
 */
export const SPINE_QUERY_KEY = getGetSpineQueryKey();

export interface SpineRead {
  data: Spine | undefined;
  isLoading: boolean;
  /** A request is in flight: the first load, a refresh, or a Retry. */
  isFetching: boolean;
  state: DataState;
  error: unknown;
  /** When the data on screen was fetched (ISO), or null before the first success. */
  updatedAt: string | null;
  refetch: () => void;
}

export function useSpine(): SpineRead {
  const q = useGetSpine({
    query: {
      queryKey: SPINE_QUERY_KEY,
      staleTime: 60_000,
      gcTime: 30 * 60_000,
    },
  });
  return {
    data: q.data,
    isLoading: q.isLoading,
    isFetching: q.isFetching ?? false,
    state: dataState(q),
    error: q.error ?? null,
    updatedAt: q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null,
    refetch: () => {
      void q.refetch();
    },
  };
}
