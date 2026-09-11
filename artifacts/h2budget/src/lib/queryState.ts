/**
 * ⭐ WHAT STATE IS THIS DATA IN? One answer for every screen.
 *
 * A money figure has five honest states. A screen that collapses them shows
 * "$0.00", or "All reconciled", while it is still loading or after the request
 * failed. `dataState` names them from a TanStack Query result:
 *
 *   cold            no data yet, still fetching (or not started)
 *   loaded          data on screen, nothing in flight
 *   refreshing      data on screen, a newer copy on the way
 *   refresh-failed  data on screen, but the newest request failed
 *   failed          no data, and the request failed
 *
 * ⚠️ The app-wide `placeholderData: keepPreviousData` lets a query show another
 * key's data while its own loads. That counts as refreshing, never loaded.
 */
export type DataState =
  | "cold"
  | "loaded"
  | "refreshing"
  | "refresh-failed"
  | "failed";

/** The fields `dataState` reads; a TanStack `UseQueryResult` satisfies it. */
export interface QueryLike {
  data: unknown;
  isFetching?: boolean;
  isLoadingError?: boolean;
  isRefetchError?: boolean;
  isPlaceholderData?: boolean;
}

export function dataState(q: QueryLike): DataState {
  if (q.data === undefined) return q.isLoadingError ? "failed" : "cold";
  if (q.isRefetchError) return "refresh-failed";
  if (q.isFetching || q.isPlaceholderData) return "refreshing";
  return "loaded";
}

/** There is data to show: loaded, refreshing, or kept after a failed refresh. */
export function hasData(state: DataState): boolean {
  return state === "loaded" || state === "refreshing" || state === "refresh-failed";
}
