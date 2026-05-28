import { useMemo } from "react";
import { useListWeeklyDebriefs } from "@workspace/api-client-react";

/**
 * Count of `awaiting_review` weeks across the last ~6 months. Drives
 * the "Debrief" sidebar badge — mirrors `useReviewInboxCount`'s
 * pattern (read existing endpoint, derive a number, hide-at-zero
 * handled by the layout).
 *
 * We use a fixed 180-day backwards window from today rather than
 * pulling unbounded history — the badge is meant to surface the
 * actionable backlog, not historic locked weeks, and a fixed window
 * keeps the underlying query cacheable.
 */
export function useDebriefAwaitingCount(): number {
  const today = new Date();
  const toISO = fmtISO(today);
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 180);
  const fromISO = fmtISO(fromDate);

  const { data } = useListWeeklyDebriefs({ from: fromISO, to: toISO });

  return useMemo(() => {
    if (!data?.weeks) return 0;
    return data.weeks.filter((w) => w.status === "awaiting_review").length;
  }, [data]);
}

function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
