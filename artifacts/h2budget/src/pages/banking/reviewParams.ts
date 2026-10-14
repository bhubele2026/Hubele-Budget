import type { QueryClient } from "@tanstack/react-query";
import { getListPlaidItemsQueryKey, listPlaidItems } from "@workspace/api-client-react";
import {
  getBankingReview,
  getGetBankingReviewQueryKey,
  type GetBankingReviewParams,
} from "@workspace/api-client-react/features";
import { householdToday } from "@/lib/householdDay";
import { sanitizeRange } from "./reviewDates";

/**
 * (P4) The Banking page's request params, built in ONE place so the page and
 * the nav's hover warm-up ask for byte-identical keys.
 *
 * ONE first call: the summary asks for `rowsPerBucket = PAGE`, so every
 * bucket's first page rides in the summary itself and the default bucket
 * renders without a second review. The paged requests (`Show more`, a kind
 * filter) keep `rowsPerBucket: 1` as they always did.
 */
export const BANKING_PAGE = 25;
export const BANKING_MIN = 60_000;

/** Params every request on the page shares (account + range). */
export function bankingBase(account: string, range: { from: string; to: string }): GetBankingReviewParams {
  return { ...(account ? { account } : {}), from: range.from, to: range.to, rowsPerBucket: 1 };
}

/** The page's first (summary) request: the base, with each bucket's first page included. */
export function bankingSummaryParams(base: GetBankingReviewParams): GetBankingReviewParams {
  return { ...base, rowsPerBucket: BANKING_PAGE };
}

/** The first call the page makes with an empty address (default account, this month). */
export function bankingDefaultSummaryParams(now: Date = new Date(), account = ""): GetBankingReviewParams {
  const range = sanitizeRange("", "", householdToday(now));
  return bankingSummaryParams(bankingBase(account, range));
}

/** Warm what /banking asks first: the review (summary + first pages) and the Plaid items. */
export function warmBanking(qc: QueryClient, account = ""): void {
  const params = bankingDefaultSummaryParams(new Date(), account);
  void qc.prefetchQuery({
    queryKey: getGetBankingReviewQueryKey(params),
    queryFn: () => getBankingReview(params),
    staleTime: BANKING_MIN,
  });
  void qc.prefetchQuery({
    queryKey: getListPlaidItemsQueryKey(),
    queryFn: () => listPlaidItems(),
    staleTime: BANKING_MIN,
  });
}
