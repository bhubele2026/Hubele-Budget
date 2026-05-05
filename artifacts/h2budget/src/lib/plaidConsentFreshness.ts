/**
 * (#260) Threshold + helpers for warning when a Plaid item's
 * `consentExpirationLastRefreshedAt` has gone too long without being
 * advanced by the daily cron. Mirrors the "stale" pattern in
 * `plaidPreparing.ts`.
 *
 * Why 3 days: the cron runs daily, so a one-day gap is normal slack
 * (timezones, brief outages). At ~3 days the silence is no longer
 * routine — that's when we surface the amber chip in Settings so the
 * user (or support) can hit Sync and confirm whether the upstream
 * disconnect date moved.
 */
export const STALE_CONSENT_REFRESH_MS = 3 * 24 * 60 * 60 * 1000;

export function isConsentRefreshStale(
  refreshedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!refreshedAt) return false;
  const ts = new Date(refreshedAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return now - ts >= STALE_CONSENT_REFRESH_MS;
}

/**
 * Human-friendly age of the timestamp, used in the badge tooltip
 * ("not verified in 5 days"). Returns null for missing/invalid input.
 */
export function formatConsentRefreshAge(
  refreshedAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!refreshedAt) return null;
  const ts = new Date(refreshedAt).getTime();
  if (!Number.isFinite(ts)) return null;
  const diffMs = Math.max(0, now - ts);
  const days = Math.floor(diffMs / (24 * 60 * 60_000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(diffMs / (60 * 60_000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return "less than an hour";
}
