// ⭐ Which checking rows belong to the forecast? One answer, shared by the cash
// curve and the review badge (server) and the Review inbox (client).
//
// A row dated on or before today has already moved real money. It is cash —
// on the curve, in Review until it is resolved, and in the badge — whatever its
// forecast flag says. The flag only decides whether a FUTURE-dated row (an
// expected payment typed in by hand) is projected.
//
// Until 2026-09-10 the flag gated past rows too. A posted row whose flag was
// off (a gap-backfill row, a manual entry, "Remove from Forecast") moved the
// balance while staying invisible to Review, so nothing could match it to its
// bill — the bill kept projecting and the same money was subtracted twice.
//
// Account scope is a separate question: callers still apply their own
// bank-account check. `todayISO` is the caller's calendar date (YYYY-MM-DD).
export function inForecast(
  row: { occurredOn: string; forecastFlag?: boolean | null },
  todayISO: string,
): boolean {
  return row.occurredOn <= todayISO || row.forecastFlag === true;
}
