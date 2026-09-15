import type { Query, QueryClient } from "@tanstack/react-query";

/**
 * ⭐ ONE HORIZON FAMILY, ONE ANSWER (PR-K follow-up, LOW).
 *
 * The Forecast page's 30-day tab and the Reports → Cash flow card's 90-day
 * request cache under different keys — `["/api/forecast/cash-signal",
 * { horizonDays: 30 }]` vs `{ horizonDays: 90 }` — even though the server
 * computes both with the same function (`computeCashSignal`). Each entry
 * keeps its own 5-minute `staleTime` (`App.tsx`'s `FORECAST_CACHE`), so after
 * a background bank sync the two can each stay "fresh" with two different
 * balances for the same calendar day, for up to five minutes (the PR-K round
 * 2 residual this closes).
 *
 * The fix does not touch the calculation or the staleTime: it watches the
 * query cache, and whenever ANY cash-signal response finishes fetching,
 * compares its `bankToday`/`snapshotAt` — the two fields that must be
 * identical across every horizon/from-date at a given instant — against
 * every OTHER cached cash-signal entry. One that disagrees is marked stale
 * (`invalidateQueries`, the same call the spine's mutation-cache rule already
 * uses elsewhere in this file's neighbourhood), never force-refetched: a
 * mounted page picks up the marker immediately, an unmounted one just gets a
 * correct answer next time it's opened.
 *
 * What keeps this from ever looping is that an entry whose fingerprint
 * already agrees with the one that just arrived is left untouched — so the
 * only way this fires twice for the same pair is a genuine THIRD change in
 * the underlying bank data, never the reconciliation itself: a stale entry
 * that refetches and comes back matching produces no further invalidation.
 * `cashSignalFamilyInvalidation.test.ts` proves a converged pair stays quiet.
 * (An already-invalidated entry is also skipped, so a burst of arrivals
 * never calls `invalidateQueries` on it twice.)
 *
 * The loop below also explicitly skips the query that just arrived, as a
 * second, belt-and-braces line against ever invalidating it — though in
 * practice that query's own freshly-written data always trivially agrees
 * with itself, so the fingerprint check above would already exclude it. The
 * explicit skip costs nothing and stays correct even if the fingerprint
 * ever grows a field that isn't reflexive under `===` (this file compares
 * two string/nullable fields, which always are).
 */
export const CASH_SIGNAL_KEY_PREFIX = "/api/forecast/cash-signal" as const;

export function isCashSignalQueryKey(key: readonly unknown[]): boolean {
  return key[0] === CASH_SIGNAL_KEY_PREFIX;
}

type CashSignalFingerprint = { bankToday: unknown; snapshotAt: unknown };

/**
 * The only two fields decision 16 promises are identical across every
 * horizon/from-date at a given instant. `null` when the payload carries
 * neither (an error shape, or not a cash signal at all) — nothing to compare.
 */
export function cashSignalFingerprint(data: unknown): CashSignalFingerprint | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!("bankToday" in d) && !("snapshotAt" in d)) return null;
  return { bankToday: d["bankToday"] ?? null, snapshotAt: d["snapshotAt"] ?? null };
}

function fingerprintsAgree(a: CashSignalFingerprint, b: CashSignalFingerprint): boolean {
  return a.bankToday === b.bankToday && a.snapshotAt === b.snapshotAt;
}

/**
 * Runs once per successful cash-signal fetch. `arrived` is the query that
 * just finished — see rule 1 above, it is never itself a candidate.
 */
export function reconcileCashSignalFamily(
  queryClient: QueryClient,
  arrived: Query,
  arrivedData: unknown,
): void {
  const arrivedFingerprint = cashSignalFingerprint(arrivedData);
  if (!arrivedFingerprint) return;

  const family = queryClient
    .getQueryCache()
    .findAll({ predicate: (q) => isCashSignalQueryKey(q.queryKey) });

  for (const query of family) {
    if (query === arrived) continue; // rule 1: never the entry that just arrived
    if (query.state.data === undefined) continue; // nothing cached to disagree with
    const theirFingerprint = cashSignalFingerprint(query.state.data);
    if (!theirFingerprint) continue;
    if (fingerprintsAgree(arrivedFingerprint, theirFingerprint)) continue; // rule 2: already in sync
    if (query.state.isInvalidated) continue; // rule 2: already marked, nothing new to do
    void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
  }
}

/**
 * Wires the rule into the app's one `QueryClient`, once. `App.tsx` calls this
 * at module scope, alongside its other one-time cache setup
 * (`setQueryDefaults`) — not per page, so no page has to remember it.
 * Returns the unsubscribe function (unused in the app itself; there is
 * exactly one `QueryClient` for the life of the tab).
 */
export function watchCashSignalFamily(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (!isCashSignalQueryKey(event.query.queryKey)) return;
    reconcileCashSignalFamily(queryClient, event.query, event.action.data);
  });
}
