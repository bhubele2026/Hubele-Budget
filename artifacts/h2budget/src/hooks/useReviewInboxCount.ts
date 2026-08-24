import { useSpine } from "@/hooks/useSpine";

/**
 * Count of unmatched current-month bank txns for the Review badge.
 *
 * ⚠️ THIS NOW READS THE SPINE, NOT ITS OWN ENDPOINT. It used to call
 * `GET /forecast/review-count` under a hand-picked `["/api/forecast",
 * "review-count"]` key so that forecast invalidations would sweep it. That was
 * a good trick for one badge, but it meant the number on the landing hero and
 * the number in the nav ribbon were two independent fetches of the same claim —
 * two caches, two moments, and a real chance of showing "3" in one place and
 * "2" in the other. They are the same fact, so they are now one read.
 *
 * The server-side count is unchanged (`lib/reviewCount.ts`, called by both
 * `/forecast/review-count` and `/spine`, with a parity test asserting they
 * match); this hook just stopped asking for it twice. Dropping the separate
 * request is also what lets `/home` open on exactly ONE API call.
 */
export function useReviewInboxCount(): number {
  const { data } = useSpine();
  return data?.reviewCount ?? 0;
}
