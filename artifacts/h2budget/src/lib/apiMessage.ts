/**
 * (F5/F9/F10) What an API refusal says on screen. The server's own `error`
 * string when it sent one ("The hard limit cannot be lower than the monthly
 * budget."), "Only the household owner can do this." for a 403 without one,
 * else the caller's plain fallback. Ported from the frozen h2 app's
 * `screens/household/words.ts` `apiMessage`.
 */
export const OWNER_ONLY = "Only the household owner can do this.";

export function apiMessage(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error.trim()) return data.error;
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return OWNER_ONLY;
  return fallback;
}

/**
 * h2's Automation `errWords`: a 403 reads as owner-only and anything else as
 * the fallback — the server's `owner_only` code never reaches the screen.
 */
export function ownerOnlyOr(e: unknown, fallback: string): string {
  return (e as { status?: number } | null)?.status === 403 ? OWNER_ONLY : fallback;
}
