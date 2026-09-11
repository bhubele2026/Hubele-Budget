import { eq, lte, or } from "drizzle-orm";
import { transactionsTable } from "@workspace/db";

export { inForecast } from "@workspace/avalanche-core";

/**
 * SQL twin of `inForecast` (lib/avalanche-core/src/forecastInclusion.ts): a
 * transaction is in the forecast when it is dated on or before today, or when
 * it is a future row flagged for the forecast. Keep the two in lockstep —
 * forecastPastRows.integration.test.ts checks the curve, the Review bundle and
 * the badge agree on the same rows.
 */
export function inForecastWhere(todayISO: string) {
  return or(
    eq(transactionsTable.forecastFlag, true),
    lte(transactionsTable.occurredOn, todayISO),
  );
}

/**
 * Today's calendar date as the forecast reads it. This is the server's local
 * date — the same one `cashSignal` projects from — so the curve, the Review
 * bundle and the badge agree on which rows have "already happened".
 */
export function forecastTodayISO(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
