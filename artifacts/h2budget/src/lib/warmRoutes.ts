import type { QueryClient } from "@tanstack/react-query";
import {
  getAvalancheExtra,
  getAvalancheSettings,
  getBillsSummary,
  getBudgetMonth,
  getForecast,
  getForecastCashSignal,
  getGetAvalancheExtraQueryKey,
  getGetAvalancheSettingsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetBudgetMonthQueryKey,
  getGetForecastCashSignalQueryKey,
  getGetForecastQueryKey,
  getListCategoriesQueryKey,
  getListDebtsQueryKey,
  listCategories,
  listDebts,
} from "@workspace/api-client-react";
import { prefetchRoute } from "./routePrefetch";

/**
 * (P4) ⭐ EACH SECTION WARMS ITS REAL FIRST QUERIES.
 *
 * Hover, focus, pointer-down and touch-start on a nav link (and a dashboard
 * tile) call `warmRoute`: the route's JS chunk, then the requests its page
 * makes first, under the page's own keys (the pages export the param builders
 * this file calls, so a warmed key cannot drift from the page's).
 *
 * The pages' builders sit in lazy modules that import the features/ledger
 * clients, which the landing must not import: they are loaded on demand here.
 *
 * Nothing here is a figure; `prefetchQuery` honours staleTime, so repeated
 * hovers cost nothing.
 */
export const WARM_EVENTS = ["onMouseEnter", "onFocus", "onPointerDown", "onTouchStart"] as const;

/** The props that warm `href` on hover, focus and the first touch of the press. */
export function warmHandlers(warm: (href: string) => void, href: string) {
  const go = () => warm(href);
  return { onMouseEnter: go, onFocus: go, onPointerDown: go, onTouchStart: go };
}

const pathOf = (href: string) => href.split("?")[0]!;
const lazyWarm = (load: () => Promise<void>) => void load().catch(() => {});

/** (Q4) Every ledger row's category word reads this list: warmed so it is not "Unknown" on the first paint. */
function warmCategories(qc: QueryClient): void {
  void qc.prefetchQuery({ queryKey: getListCategoriesQueryKey(), queryFn: () => listCategories() });
}

export function warmRoute(qc: QueryClient, rawHref: string): void {
  const href = pathOf(rawHref);
  // The route's JS chunk first: the data is no use before the page can render it.
  prefetchRoute(href);
  const query = new URLSearchParams(rawHref.includes("?") ? rawHref.slice(rawHref.indexOf("?") + 1) : "");
  if (href === "/banking") {
    // A tile names its account (`?account=`); that is the account the page asks for.
    const account = query.get("account") ?? "";
    lazyWarm(async () => (await import("@/pages/banking/reviewParams")).warmBanking(qc, account));
  } else if ([...query.keys()].length > 0) {
    // A link that names a month, card or period asks for a view the empty address does not: no guess.
    return;
  } else if (href === "/transactions") {
    lazyWarm(async () => (await import("@/pages/transactions/warm")).warmChase(qc));
    warmCategories(qc);
  } else if (href === "/amex") {
    lazyWarm(async () => (await import("@/pages/amexQueries")).warmAmex(qc));
    warmCategories(qc);
  } else if (href === "/spending/week" || href === "/spending/month") {
    const view = href === "/spending/week" ? "week" : "month";
    lazyWarm(async () => (await import("@/pages/spending/periodParams")).warmPeriod(qc, view));
  } else if (href === "/forecast/overview" || href === "/forecast" || href === "/review") {
    // Review renders the same ForecastPage in a different mode, reading the identical bundle.
    void qc.prefetchQuery({ queryKey: getGetForecastQueryKey({ days: 90 }), queryFn: () => getForecast({ days: 90 }) });
    void qc.prefetchQuery({
      queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
      queryFn: () => getForecastCashSignal({ horizonDays: 90 }),
    });
  } else if (href === "/avalanche" || href === "/debts") {
    void qc.prefetchQuery({ queryKey: getListDebtsQueryKey(), queryFn: () => listDebts() });
    void qc.prefetchQuery({ queryKey: getGetAvalancheSettingsQueryKey(), queryFn: () => getAvalancheSettings() });
    void qc.prefetchQuery({ queryKey: getGetAvalancheExtraQueryKey(), queryFn: () => getAvalancheExtra() });
  } else if (href === "/bills") {
    void qc.prefetchQuery({ queryKey: getGetBillsSummaryQueryKey(), queryFn: () => getBillsSummary() });
  } else if (href === "/budget") {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    void qc.prefetchQuery({ queryKey: getGetBudgetMonthQueryKey(month), queryFn: () => getBudgetMonth(month) });
    void qc.prefetchQuery({ queryKey: getListCategoriesQueryKey(), queryFn: () => listCategories() });
  }
}
