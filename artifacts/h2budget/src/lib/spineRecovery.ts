import type { Query, QueryClient } from "@tanstack/react-query";
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
 * ONE ASK, NEVER A LOOP — but read "one" carefully:
 *   - The ask follows the query's own retry setting. Once a page is mounted the
 *     query carries the app's `retry: 1`, so one ask can be two requests.
 *   - It waits on whichever first spine request is out at sign-in, the prefetch
 *     or a page's own mount fetch, and asks again only if that one fails.
 *   So a spine that keeps failing at open costs a handful of requests, bounded.
 *
 * Returns the cleanup for the calling effect.
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

// ── Any query that met a 401 before Clerk had settled ───────────────────────
//
// (#perf) With the auth hint set the routes mount before Clerk answers, so every
// page query goes out on the `__session` cookie as it stood at page load. That
// cookie lives ~60 s; Clerk refreshes it as part of its boot. A query that lands
// on the expired window gets a 401, and (like the spine prefetch above) would
// otherwise sit on "Couldn't load" for a perfectly valid session.

let clerkSettled = false;
/** Clerk has answered (signed in or out). From here a 401 is a real one. */
export function noteClerkSettled(): void {
  clerkSettled = true;
}
export function clerkHasSettled(): boolean {
  return clerkSettled;
}

/** True for the API client's HTTP 401 (`ApiError`), and nothing else. */
export function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 401
  );
}

/**
 * Called once Clerk has signed in. Every query whose latest result is a 401 is
 * fetched again, exactly once; one still out is waited for and treated the same
 * way when it settles. A 500, a timeout or any other failure is left alone (the
 * query's own retry and Retry buttons cover those). The spine has its own helper
 * above and is skipped here so it is not asked twice.
 *
 * ONE ASK PER QUERY, NEVER A LOOP: a query is re-asked at most once per call,
 * and a second 401 after Clerk settled is a real sign-out, not ours to chase.
 * Returns the cleanup for the calling effect.
 */
export function askForUnauthorizedAgain(queryClient: QueryClient): () => void {
  const cache = queryClient.getQueryCache();
  const spineHash = JSON.stringify(getGetSpineQueryKey());
  const asked = new Set<Query>();
  const waiting = new Set<Query>();

  const ask = (query: Query) => {
    if (asked.has(query) || query.queryHash === spineHash) return;
    asked.add(query);
    void queryClient.refetchQueries({ queryKey: query.queryKey, exact: true });
  };

  for (const query of cache.getAll()) {
    if (query.queryHash === spineHash) continue;
    if (query.state.fetchStatus === "idle") {
      if (query.state.status === "error" && isUnauthorized(query.state.error)) {
        if (query.getObserversCount() > 0) ask(query);
      }
    } else {
      waiting.add(query);
    }
  }
  if (waiting.size === 0) return () => {};

  const unsubscribe = cache.subscribe((event) => {
    const query = event.query;
    if (!waiting.has(query) || query.state.fetchStatus !== "idle") return;
    waiting.delete(query);
    if (query.state.status === "error" && isUnauthorized(query.state.error)) ask(query);
    if (waiting.size === 0) unsubscribe();
  });
  return unsubscribe;
}
