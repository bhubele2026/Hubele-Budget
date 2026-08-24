import {
  useGetSpine,
  getGetSpineQueryKey,
  type Spine,
} from "@workspace/api-client-react";

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
 * `staleTime` is 60s: long enough that moving between pages never refetches,
 * short enough that the numbers can't visibly age during a session. Every
 * successful mutation invalidates it centrally (see the `mutationCache` in
 * App.tsx), so the staleTime never hides a write.
 */
export const SPINE_QUERY_KEY = getGetSpineQueryKey();

export function useSpine(): { data: Spine | undefined; isLoading: boolean } {
  const { data, isLoading } = useGetSpine({
    query: {
      queryKey: SPINE_QUERY_KEY,
      staleTime: 60_000,
      gcTime: 30 * 60_000,
    },
  });
  return { data, isLoading };
}
