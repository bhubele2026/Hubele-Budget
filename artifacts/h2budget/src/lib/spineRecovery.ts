import type { QueryClient } from "@tanstack/react-query";
import { getGetSpineQueryKey } from "@workspace/api-client-react";

/**
 * ⚠️ A PAGE CAN JOIN THE PREFETCH'S FAILURE. Ask for the spine once more.
 *
 * `App.tsx` prefetches the spine at module scope with `retry: false`, before
 * Clerk has booted, and a 401 from a cookie Clerk has not refreshed yet is
 * expected. A page that mounts while that request is out shares it rather than
 * starting its own, so when it fails the page is left with an error, no
 * numbers, and nothing that will ask again: "Couldn't load" for a session that
 * is perfectly valid.
 *
 * Called once Clerk has signed in:
 *   - the prefetch already failed with nothing to show: ask again now;
 *   - it is still out: wait for it, and ask again if it fails;
 *   - anything else (loaded, or a failed refresh with numbers on screen, which
 *     the refresh banner's Retry covers): do nothing.
 *
 * It asks once, never in a loop. Returns the cleanup for the calling effect.
 */
export function askForSpineAgainIfFailed(queryClient: QueryClient): () => void {
  const queryKey = getGetSpineQueryKey();
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query) return () => {};

  const askIfFailed = () => {
    if (query.state.status === "error" && query.state.data === undefined) {
      void queryClient.refetchQueries({ queryKey, exact: true });
    }
  };

  if (query.state.fetchStatus === "idle") {
    askIfFailed();
    return () => {};
  }

  // Still out (or paused offline): decide when it settles, then stop listening.
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.query !== query || query.state.fetchStatus !== "idle") return;
    unsubscribe();
    askIfFailed();
  });
  return unsubscribe;
}
