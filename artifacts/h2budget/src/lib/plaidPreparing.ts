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

export function isPreparingStalled(
  since: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!since) return false;
  const start = new Date(since).getTime();
  if (!Number.isFinite(start)) return false;
  return now - start >= STALLED_PREPARING_MS;
}
