import { eq, lte, or } from "drizzle-orm";
import { transactionsTable } from "@workspace/db";
import { householdTodayISO } from "./householdClock";

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
 * Today's calendar date as the forecast reads it: the household's
 * (America/Chicago), the same date the curve, the Review bundle and the badge
 * use — so which rows have "already happened" never depends on the server's
 * timezone. Takes an INSTANT.
 */
export function forecastTodayISO(now: Date = new Date()): string {
  return householdTodayISO(now);
}
