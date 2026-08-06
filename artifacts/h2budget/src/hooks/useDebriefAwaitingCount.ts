import { useGetDebriefAwaitingCount } from "@workspace/api-client-react";

/**
 * Count of `awaiting_review` weeks across the last ~6 months. Drives the
 * "Debrief" sidebar badge. Served by GET /debrief/awaiting-count, which
 * derives week status from the stored rows alone (one query) — the layout
 * used to trigger the full /debrief/weeks variance recompute (~6 queries
 * per week) on every navigation just for this integer.
 *
 * Fixed 180-day backwards window from today: the badge surfaces the
 * actionable backlog, not historic locked weeks, and a fixed window keeps
 * the query cacheable.
 */
export function useDebriefAwaitingCount(): number {
  const today = new Date();
  const toISO = fmtISO(today);
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 180);
  const fromISO = fmtISO(fromDate);

  const params = { from: fromISO, to: toISO };
  const { data } = useGetDebriefAwaitingCount(params, {
    query: {
      // Deliberately keyed UNDER the '/api/debrief/weeks' prefix so every
      // existing `invalidateQueries({queryKey: getListWeeklyDebriefsQueryKey()})`
      // site (lock week, resolve items) refreshes this badge too.
      queryKey: ["/api/debrief/weeks", "awaiting-count", params],
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
    },
  });
  return data?.count ?? 0;
}

function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
