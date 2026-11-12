import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

/**
 * ⭐ THE ONE DOOR TO `GET /api/banking/needs-you` — the rows H2 could not settle
 * on its own, each with its suggested answer.
 *
 * ⚠️ TEMPORARY HAND-WRITTEN ADAPTER. The server half (spec + codegen) is being
 * built beside this screen; at merge this file swaps to the generated hook and
 * types and nothing else changes. Keep the surface small: the types below, the
 * key, the fetch and `useNeedsYou()`.
 *
 * Every figure here is the server's string; the screen adds nothing up.
 */

export type NeedsYouKind = "match" | "category";
export type NeedsYouConfidence = "high" | "medium" | "low";

export interface NeedsYouSuggestion {
  /** What H2 thinks it is, said plainly ("Car insurance payment, planned $112 on Nov 3" / "Groceries"). */
  label: string;
  /** match: the planned occurrence, `<recurringItemId>|<YYYY-MM-DD>` (the resolution key). */
  planOccurrenceId?: string;
  /** category: the category H2 would file it under. */
  categoryId?: string;
  /** category: the categorization review item (its decision id) that OK accepts. */
  reviewItemId?: string;
  confidence: NeedsYouConfidence;
}

export interface NeedsYouItem {
  id: string;
  txId: string;
  accountName: string;
  mask: string | null;
  date: string;
  name: string;
  /** Signed, the bank's sign (money out is negative). */
  amount: string;
  pending: boolean;
  /** The row's category today (null: none). Optional until the generated type lands. */
  categoryName?: string | null;
  kind: NeedsYouKind;
  suggestion: NeedsYouSuggestion | null;
  /** One short line on why it waits for the household. */
  reason: string;
}

export interface NeedsYouAutoDone {
  matched: number;
  categorized: number;
  since: string;
}

export interface NeedsYou {
  throughDate: string;
  /** Every row that waits; may be more than `items` when `truncated`. */
  count: number;
  items: NeedsYouItem[];
  /** True when the server sent only the first `items.length` of `count`. */
  truncated?: boolean;
  autoDone: NeedsYouAutoDone;
}

/** Shaped like the generated key, so the swap at merge keeps every invalidation. */
export const getNeedsYouQueryKey = () => ["/api/banking/needs-you"] as const;

export const getNeedsYou = (options?: RequestInit) =>
  customFetch<NeedsYou>("/api/banking/needs-you", { ...options, method: "GET" });

/** The list moves with every answer and every bank sync: a minute fresh, kept half an hour. */
export function useNeedsYou() {
  return useQuery({
    queryKey: getNeedsYouQueryKey(),
    queryFn: ({ signal }) => getNeedsYou({ signal }),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
  });
}

/** A match suggestion's planned occurrence, read off its resolution key; null when it does not name one. */
export function planOccurrenceOf(s: NeedsYouSuggestion | null | undefined): { recurringItemId: string; occurrenceDate: string } | null {
  const raw = s?.planOccurrenceId ?? "";
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const recurringItemId = raw.slice(0, bar);
  const occurrenceDate = raw.slice(bar + 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) ? { recurringItemId, occurrenceDate } : null;
}
