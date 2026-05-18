export const STALLED_PREPARING_MS = 6 * 60 * 60 * 1000;

export function formatPreparingElapsed(
  since: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!since) return null;
  const start = new Date(since).getTime();
  if (!Number.isFinite(start)) return null;
  const diffMs = now - start;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// (#723) Render a past timestamp as a short relative-time string
// suffixed with " ago" — e.g. "just now", "12m ago", "4h ago",
// "3d ago". Powers the Settings bank-tile last-synced line so users
// can see at a glance whether the Plaid anchor on each row is fresh
// without having to compute the delta themselves. Mirrors the
// formatPreparingElapsed bucketing so the two relative-time strings
// on the same row read consistently. Returns null when `at` is
// missing / unparseable so callers can simply skip the suffix.
export function formatRelativeTimeFromNow(
  at: Date | string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!at) return null;
  const ms = typeof at === "string" ? new Date(at).getTime() : at.getTime();
  if (!Number.isFinite(ms)) return null;
  const diffMs = now - ms;
  // Future timestamps (clock skew between client + server) read as
  // "just now" rather than a misleading negative duration.
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function isPreparingStalled(
  since: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!since) return false;
  const start = new Date(since).getTime();
  if (!Number.isFinite(start)) return false;
  return now - start >= STALLED_PREPARING_MS;
}
