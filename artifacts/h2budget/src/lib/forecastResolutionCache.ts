import type { Resolution } from "./forecastMatch";

/**
 * (PR5b second review N2) Apply one resolution write to a cached list the way
 * `POST /forecast/resolutions` applies it to the table, so the cached
 * `GET /forecast` bundle can carry an answer before its refetch lands.
 *
 * Why: after Confirm / Not this / Partial the page refetches the bundle and
 * the cash signal together, and the lighter signal usually lands first. The
 * OLD bundle with the NEW signal rebuilt a rejected pair as a client
 * suggestion (and a just-partialled plan as still pending) — one click in that
 * window wrote `matched` over the user's answer.
 *
 * Mirrors the route's neighbour delete (`routes/forecast.ts`):
 *   - `not_match` replaces the identical pair's rejection, match or partial;
 *   - any other status replaces the plan occurrence's resolutions (except
 *     `not_match`; a `partial` and a `rescheduled` keep each other), the row's
 *     resolutions (except `not_match`), and the identical pair's rejection.
 */
export function applyResolutionWrite(
  list: ReadonlyArray<Resolution>,
  row: Resolution,
): Resolution[] {
  const hasPlan = !!row.recurringItemId && !!row.occurrenceDate;
  const samePlan = (r: Resolution) =>
    hasPlan && r.recurringItemId === row.recurringItemId && r.occurrenceDate === row.occurrenceDate;
  const sameTxn = (r: Resolution) => !!row.matchedTxnId && r.matchedTxnId === row.matchedTxnId;
  const samePair = (r: Resolution) => samePlan(r) && sameTxn(r);

  const kept = list.filter((r) => {
    if (r.id === row.id) return false;
    if (row.status === "not_match") {
      return !(samePair(r) && (r.status === "not_match" || r.status === "matched" || r.status === "partial"));
    }
    if (r.status === "not_match") return !samePair(r);
    if (samePlan(r)) {
      if (row.status === "partial" && r.status === "rescheduled") return true;
      if (row.status === "rescheduled" && r.status === "partial") return true;
      return false;
    }
    return !sameTxn(r);
  });
  return [...kept, row];
}

/** `applyResolutionWrite` on a cached bundle (`{ resolutions }`); anything else passes through. */
export function withResolutionWrite<T>(bundle: T, row: Resolution): T {
  if (!bundle || typeof bundle !== "object") return bundle;
  const b = bundle as { resolutions?: unknown };
  if (!Array.isArray(b.resolutions)) return bundle;
  return { ...bundle, resolutions: applyResolutionWrite(b.resolutions as Resolution[], row) };
}
