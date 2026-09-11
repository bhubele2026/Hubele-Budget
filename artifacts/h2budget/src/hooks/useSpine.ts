import {
  useGetSpine,
  getGetSpineQueryKey,
  type Spine,
} from "@workspace/api-client-react";
import { dataState, type DataState } from "@/lib/queryState";

/**
 * ⭐ THE SPINE — one snapshot, read once, shared by every surface that quotes
 * it.
 *
 * The app used to open by firing four tile queries plus a badge query, which
 * meant five round trips before the front door settled AND five chances for two
 * surfaces to describe the same household at two different moments. `/api/spine`
 * computes them together, server-side, in one pass (see
 * `api-server/src/routes/spine.ts` — every field is produced by the same
 * function the owning page's endpoint calls, with an integration test asserting
 * they agree to the cent).
 *
 * ⚠️ NEVER RECOMPUTE A SPINE NUMBER LOCALLY. If a page shows a figure the spine
 * carries, it reads it from here. A page that re-derives its own copy is how
 * two tiles come to disagree, which is the exact failure this endpoint exists
 * to make impossible.
 *
 * ⚠️ IT SAYS WHEN IT CANNOT BE TRUSTED. `state` separates still loading,
 * loaded, refreshing, a failed refresh (the last good numbers stay on screen)
 * and a failed first load, so no surface paints "$0.00" or "All reconciled" for
 * a spine it never received. `updatedAt` is when the numbers on screen were
 * fetched, and `isFetching` says a request (a Retry, say) is in flight.
 *
 * `staleTime` is 60s. Moving between pages within a minute never refetches;
 * after that, a page that mounts a new reader refetches once. A page left open
 * does NOT refresh on its own (no focus refetch, no polling), so its numbers
 * can age on screen; that is why the refresh banner and the freshness line
 * state their age. Every successful mutation invalidates it centrally (see the
 * `mutationCache` in App.tsx), so the staleTime never hides a write.
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
