import type { QueryClient } from "@tanstack/react-query";

/**
 * ⭐ REFRESH THE WHOLE FORECAST FAMILY, NOT ONE MEMBER OF IT.
 *
 * The projection is served by two separate queries with two separate keys:
 *
 *   ["/api/forecast", …]              the bundle — the register, the curve
 *   ["/api/forecast/cash-signal", …]  the projection — ENDING BALANCE, low
 *                                     point, runway
 *
 * Neither key is a prefix of the other, so `invalidateQueries({queryKey:
 * getGetForecastQueryKey()})` refreshes the first and silently leaves the
 * second alone. Both are cached for five minutes with `refetchOnWindowFocus:
 * false` (see `App.tsx`), deliberately, on the stated assumption that "every
 * write path invalidates".
 *
 * When a write path forgets the second key, the app tells the user their change
 * did nothing: Brad set his avalanche extra to $5,000 and watched the ending
 * balance sit unchanged — the server had already applied it, and only a hard
 * reload revealed the new number. That is the worst kind of bug, because the
 * honest response to it is to distrust the app.
 *
 * So: any mutation that moves money calls this. Matching by key PREFIX means
 * future forecast queries are covered the day they are added, without anyone
 * having to remember this file exists.
 *
 * ⚠️ Deliberately not called on every mutation. The bundle is expensive, and
 * the caching around it was tuned on purpose — this belongs on writes that
 * actually change the projection (transactions, bills, debts, avalanche
 * settings, bank snapshots, a sync), not on UI preferences.
 */
export function invalidateForecastFamily(qc: QueryClient): void {
  void qc.invalidateQueries({
    predicate: (q) => {
      const first = q.queryKey[0];
      return typeof first === "string" && first.startsWith("/api/forecast");
    },
  });
}
