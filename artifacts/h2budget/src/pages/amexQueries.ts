import type { QueryClient } from "@tanstack/react-query";
import {
  getListTransactionsQueryKey,
  listTransactions,
} from "@workspace/api-client-react";
import { getAmexSummary, getGetAmexSummaryQueryKey } from "@workspace/api-client-react/features";
import {
  monthFirstISO,
  monthKeyOf,
  monthLastISO,
  type MonthKey,
} from "@/components/account-page/month-navigator";
import { AMEX_SOURCES } from "@/lib/amexSources";
import { amexSummaryPeriod } from "@/lib/amexSummaryView";

/**
 * (P4) The Amex page's FIRST requests, built in one place so the page and the
 * nav's hover warm-up ask for identical keys. A warmed key that differs by one
 * argument from the page's is worse than no warm-up (it pays for the request
 * and the page still shows a skeleton).
 */
export const AMEX_MONTH_LIMIT = 1000;

/** "All cards" lists the workbook rows by source; one card lists its own rows by account. */
export type AmexScope = { plaidAccountId: string } | { source: string };
export const amexAllScope = (): AmexScope => ({ source: AMEX_SOURCES.join(",") });

/** The focused month's rows. */
export function amexMonthParams(month: MonthKey, scope: AmexScope) {
  return { limit: AMEX_MONTH_LIMIT, from: monthFirstISO(month), to: monthLastISO(month), ...scope };
}

/** The summary's request (`accountId` is "all" or one card's external account id). */
export function amexSummaryParams(accountId: string, period: { from: string; to: string } | null) {
  return { accountId, from: period?.from ?? "", to: period?.to ?? "" };
}

/** What /amex asks first with an empty address: the "all cards" summary for this week, and this month's rows. */
export function amexFirstParams(now: Date = new Date()) {
  const month = monthKeyOf(now);
  return {
    summary: amexSummaryParams("all", amexSummaryPeriod("wk", month, now)),
    month: amexMonthParams(month, amexAllScope()),
    summaryOn: amexSummaryPeriod("wk", month, now) != null,
  };
}

export function warmAmex(qc: QueryClient): void {
  const first = amexFirstParams();
  if (first.summaryOn) {
    void qc.prefetchQuery({
      queryKey: getGetAmexSummaryQueryKey(first.summary),
      queryFn: () => getAmexSummary(first.summary),
    });
  }
  void qc.prefetchQuery({
    queryKey: getListTransactionsQueryKey(first.month),
    queryFn: () => listTransactions(first.month),
  });
}
