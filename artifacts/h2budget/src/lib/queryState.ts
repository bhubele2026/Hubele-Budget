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

/**
 * ⭐ DOES THIS ANSWER BELONG TO WHAT THE SCREEN ASKED FOR?
 *
 * `keepPreviousData` hands a query the LAST key's response while the new one
 * loads. Under a new heading that is a wrong number (the all-cards owed under
 * "Platinum"). `scoped` splits a query result by the scope the response
 * echoes (`scope.accountId`, `period`, `monthStart` …):
 *
 *   data        only when `matches(response)` is true - safe under the new heading
 *   previous    the old scope's response, for an optional, LABELLED state
 *               ("Showing All cards while Platinum loads"); never unlabelled
 *   isSwitching the new scope has no answer yet and the old one is still held
 *
 * `isPlaceholderData` also means "not this key's answer". A response that matches is shown even while a refetch runs (that is a
 * refresh of the same scope, not a switch).
 */
export interface Scoped<T> {
  data: T | undefined;
  previous: T | undefined;
  isSwitching: boolean;
}

export function scoped<T>(
  q: { data: T | undefined; isPlaceholderData?: boolean },
  matches: (data: T) => boolean,
): Scoped<T> {
  const d = q.data;
  if (d === undefined || d === null) return { data: undefined, previous: undefined, isSwitching: false };
  // A placeholder is, by definition, another key's response.
  if (!q.isPlaceholderData && matches(d)) return { data: d, previous: undefined, isSwitching: false };
  return { data: undefined, previous: d, isSwitching: true };
}

/**
 * Does an Amex summary answer THIS card and period? The server echoes the
 * card (`scope.accountId`, null for all cards) and the days it read. A `from`
 * the server moved up to the tracking start is announced in `limitations`,
 * and still counts as the asked-for period.
 */
export function amexSummaryMatches(
  s: {
    scope: { accountId: string | null };
    period: { from: string; to: string };
    limitations?: string[];
  },
  req: { accountId: string; from: string; to: string },
): boolean {
  const card = s.scope?.accountId ?? "all";
  if (card !== req.accountId) return false;
  // (A response with no period echo cannot be compared; `isPlaceholderData` still guards it.)
  if (!s.period) return true;
  if (s.period.to !== req.to) return false;
  if (s.period.from === req.from) return true;
  return (s.limitations ?? []).includes(`tracking_start:${s.period.from}`) && s.period.from > req.from;
}
