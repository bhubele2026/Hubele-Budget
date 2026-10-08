import { useGetSpine } from "@workspace/api-client-react";
import { SPINE_QUERY_KEY } from "./useSpine";
import { badgeCount, useReviewQueue } from "./activityData";

/**
 * The number beside Activity in the masthead and the dock. Same spine key and
 * options as `useSpine`, but `enabled` only once signed in, so a signed-out
 * browser never asks for it from the shell.
 */
export function useActivityBadge(enabled: boolean): number {
  const spine = useGetSpine({
    query: { queryKey: SPINE_QUERY_KEY, staleTime: 60_000, gcTime: 30 * 60_000, enabled },
  });
  const queue = useReviewQueue(enabled);
  return enabled ? badgeCount(queue.data?.total, spine.data?.reviewCount) : 0;
}
