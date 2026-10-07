import { MutationCache, QueryClient, keepPreviousData } from "@tanstack/react-query";
import { getSpine, getGetSpineQueryKey } from "@workspace/api-client-react";
import { onWriteSuccess } from "./mutationInvalidation";
import { readAuthHint } from "@/lib/authHint";

/**
 * The query client, with the classic app's defaults ported as they are, so the
 * two apps cache the same data the same way while both are live.
 *
 * ⭐ ONE INVALIDATION RULE FOR THE SPINE, NOT THIRTY: any successful mutation,
 * anywhere, marks the spine (and the aggregates it feeds) stale through
 * `onWriteSuccess`. `invalidateQueries` only refetches what is mounted, so the
 * rule costs almost nothing and cannot be forgotten by the next mutation.
 */
export function createQueryClient(): QueryClient {
  const mutationCache = new MutationCache({
    // A block body: an expression body makes TypeScript infer the return
    // through `client`, which is built from this very cache (TS7022).
    onSuccess: (_data, _variables, _context, mutation) => {
      onWriteSuccess(client, mutation);
    },
  });

  const client: QueryClient = new QueryClient({
    mutationCache,
    defaultOptions: {
      queries: {
        // Fresh for 5 min so moving between screens renders from cache;
        // writes invalidate their keys explicitly.
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
        // Keep the previous figures on screen while a new key loads; screens
        // gate their skeleton on `!data`, never on `isLoading`.
        placeholderData: keepPreviousData,
      },
    },
  });

  // Forecast bundle and cash-signal projection: change only on a Sync or an
  // edit, both of which invalidate them.
  const FORECAST_CACHE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
  client.setQueryDefaults(["/api/forecast"], FORECAST_CACHE);
  client.setQueryDefaults(["/api/forecast/cash-signal"], FORECAST_CACHE);

  // Transaction lists and what derives from them.
  const TXN_CACHE = { staleTime: 2 * 60_000, refetchOnWindowFocus: false } as const;
  client.setQueryDefaults(["/api/transactions"], TXN_CACHE);
  client.setQueryDefaults(["/api/amex/weekly-payoff"], TXN_CACHE);

  // Slow-changing reference data: change only by explicit edits, each of
  // which invalidates its key. Fetched once and reused across the app.
  const SLOW_CACHE = { staleTime: 30 * 60_000, refetchOnWindowFocus: false } as const;
  for (const key of [
    "/api/settings",
    "/api/budget/categories",
    "/api/mapping-rules",
    "/api/debts",
    "/api/recurring-items",
    "/api/avalanche/settings",
    "/api/avalanche/extra",
    "/api/forecast/settings",
    "/api/plaid/items",
    "/api/plaid/liability-accounts",
  ]) {
    client.setQueryDefaults([key], SLOW_CACHE);
  }

  return client;
}

/**
 * ⚠️ FIRED BEFORE CLERK HAS BOOTED, IN PARALLEL WITH IT — NOT AFTER IT.
 * The API authenticates the browser by the same-origin `__session` cookie, so
 * this request is already authenticated before clerk-js finishes. Only when
 * this browser has been signed in before (the auth hint).
 *
 * `retry: false`: an expired session answers 401, and the right response is to
 * drop it. A screen that mounts meanwhile shares this request, so it is
 * `ProtectedShell` that asks again once Clerk has signed in
 * (`askForSpineAgainIfFailed`).
 */
export function prefetchSpineOnHint(client: QueryClient): void {
  if (typeof window === "undefined" || !readAuthHint()) return;
  void client
    .prefetchQuery({
      queryKey: getGetSpineQueryKey(),
      queryFn: ({ signal }) => getSpine({ signal }),
      staleTime: 60_000,
      retry: false,
    })
    .catch(() => {
      /* 401 before Clerk refreshes the cookie — ProtectedShell asks again */
    });
}
