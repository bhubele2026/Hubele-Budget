/**
 * The first day of the month AFTER `monthStart` — the exclusive upper bound of
 * a budget month's window.
 *
 * ⚠️ WHY THIS IS NOT `new Date(m).setMonth(getMonth() + 1)`.
 *
 * That was the pattern here, and it is wrong anywhere the process is not on
 * UTC. `new Date("2026-06-01")` parses an ISO date-only string as UTC
 * midnight, but `getMonth`/`setMonth` read and write LOCAL fields. In a
 * negative-offset zone the instant is still the previous day locally, so the
 * arithmetic runs on the wrong month AND the wrong day-of-month — and a
 * day-of-month that does not exist in the target month silently rolls forward.
 *
 * Measured in America/Chicago before the fix:
 *
 *     2026-05-01 → 2026-05-31   ← May 31st's spending dropped entirely
 *     2026-06-01 → 2026-07-02   ← July 1st's spending counted as June
 *     2026-02-01 → 2026-03-04   ← FOUR days of March counted as February
 *
 * Render runs UTC so production was right, which is exactly why this survived:
 * it is invisible until someone runs the server anywhere else. Doing the
 * arithmetic in UTC, where the string was parsed, makes the answer independent
 * of the host's zone. `Date.UTC` normalises month 12 to January of the next
 * year on its own.
 */
export function monthEndExclusive(monthStart: string): string {
  const [y, m] = monthStart.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    throw new Error(`monthEndExclusive: bad monthStart ${monthStart}`);
  }
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** Days in the month beginning `monthStart`. */
export function daysInMonth(monthStart: string): number {
  return Math.round(
    (Date.parse(monthEndExclusive(monthStart)) - Date.parse(monthStart)) /
      86_400_000,
  );
}
