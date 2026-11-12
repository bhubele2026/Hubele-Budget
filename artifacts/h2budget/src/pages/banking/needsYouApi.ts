import type { QueryClient } from "@tanstack/react-query";
import {
  getBankingNeedsYou,
  getGetBankingAutoDoneQueryKey,
  getGetBankingNeedsYouQueryKey,
  useGetBankingAutoDone,
  useGetBankingNeedsYou,
  type BankingAutoDone,
  type BankingAutoDoneItem,
  type BankingNeedsYou,
  type BankingNeedsYouAutoDone,
  type BankingNeedsYouItem,
  type BankingNeedsYouItemKind,
  type BankingNeedsYouSuggestion,
  type BankingNeedsYouSuggestionConfidence,
} from "@workspace/api-client-react/features";

/**
 * ⭐ THE ONE DOOR TO `GET /api/banking/needs-you` (and its "See them" list,
 * `GET /api/banking/auto-done`) — the generated hooks, under ONE key and one
 * set of cache options for every reader. The types are codegen's; the short
 * names below are what the screen uses.
 *
 * Every figure is the server's string; the screen adds nothing up. `count`
 * covers every charge that waits; `items` may be fewer (`truncated`).
 */

export type NeedsYou = BankingNeedsYou;
export type NeedsYouItem = BankingNeedsYouItem;
export type NeedsYouSuggestion = BankingNeedsYouSuggestion;
export type NeedsYouAutoDone = BankingNeedsYouAutoDone;
export type NeedsYouKind = BankingNeedsYouItemKind;
export type NeedsYouConfidence = BankingNeedsYouSuggestionConfidence;
export type AutoDone = BankingAutoDone;
export type AutoDoneItem = BankingAutoDoneItem;

/** The list's key with no params: the prefix every invalidation uses (`mutationInvalidation.ts` spells the same). */
export const getNeedsYouQueryKey = () => getGetBankingNeedsYouQueryKey();
export const getAutoDoneQueryKey = () => getGetBankingAutoDoneQueryKey();

/**
 * The server builds the list from the ledger, so it is not asked for again on every visit: a minute fresh, kept half an
 * hour, and refreshed by every answer (the answers invalidate it, and so does every write through `mutationCache`).
 */
const NEEDS_YOU_CACHE = { staleTime: 60_000, gcTime: 30 * 60_000 } as const;

export function useNeedsYou() {
  return useGetBankingNeedsYou(undefined, {
    query: { queryKey: getGetBankingNeedsYouQueryKey(), ...NEEDS_YOU_CACHE },
  });
}

/** Warm the list under the page's own key and cache (the nav's hover and the landing's idle warm-up). */
export function warmNeedsYou(qc: QueryClient): void {
  void qc.prefetchQuery({
    queryKey: getGetBankingNeedsYouQueryKey(),
    queryFn: ({ signal }) => getBankingNeedsYou(undefined, { signal }),
    ...NEEDS_YOU_CACHE,
  });
}

/** What H2 matched and filed on its own, each with its undo id. Read only while "See them" is open. */
export function useAutoDone(enabled: boolean) {
  return useGetBankingAutoDone(undefined, {
    query: { queryKey: getGetBankingAutoDoneQueryKey(), staleTime: 60_000, gcTime: 10 * 60_000, enabled },
  });
}

/** A match suggestion's planned occurrence, read off its resolution key; null when it does not name one. */
export function planOccurrenceOf(s: Pick<NeedsYouSuggestion, "planOccurrenceId"> | NeedsYouSuggestion | null | undefined): { recurringItemId: string; occurrenceDate: string } | null {
  const raw = s?.planOccurrenceId ?? "";
  const bar = raw.lastIndexOf("|");
  if (bar <= 0) return null;
  const recurringItemId = raw.slice(0, bar);
  const occurrenceDate = raw.slice(bar + 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) ? { recurringItemId, occurrenceDate } : null;
}
