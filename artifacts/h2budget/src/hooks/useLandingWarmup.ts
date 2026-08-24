import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getDashboard,
  getGetDashboardQueryKey,
  getForecast,
  getGetForecastQueryKey,
  getForecastCashSignal,
  getGetForecastCashSignalQueryKey,
  getBillsSummary,
  getGetBillsSummaryQueryKey,
  listDebts,
  getListDebtsQueryKey,
  getBudgetMonth,
  getGetBudgetMonthQueryKey,
  listCategories,
  getListCategoriesQueryKey,
} from "@workspace/api-client-react";
import { prefetchRoute } from "@/lib/routePrefetch";

/**
 * ⭐ THE LANDING BUYS THE NEXT CLICK, AFTER IT HAS PAID FOR ITS OWN.
 *
 * The landing itself needs exactly one request. That leaves the browser idle
 * while the owner reads six tiles and decides where to go — so we spend that
 * idle time warming the area pages' chunks AND their data, staggered so the
 * warm-up can never contend with the open it is supposed to make feel fast.
 *
 * ⚠️ THE KEYS HERE MUST BE THE PAGES' OWN KEY BUILDERS, NOT HAND-WRITTEN
 * STRINGS. A warmed key that differs by one argument from what the page asks
 * for is worse than no warm-up at all: it pays the full cost of the request and
 * the page still shows a skeleton, while the cache quietly holds two copies of
 * the same data under two keys. Every entry below calls the same generated
 * builder + fetcher the destination page calls.
 *
 * Timing follows the dashboard's pattern: first stage at 400 ms (after first
 * paint has certainly settled), each subsequent stage 300 ms behind the last.
 */

type WarmStage = { href: string; warm: (qc: ReturnType<typeof useQueryClient>) => void };

const STAGES: WarmStage[] = [
  {
    href: "/banking",
    warm: (qc) => {
      void qc.prefetchQuery({
        queryKey: getGetDashboardQueryKey(),
        queryFn: () => getDashboard(),
      });
    },
  },
  {
    href: "/bills",
    warm: (qc) => {
      // No `month` param — the param-less key is the one the Bills page and the
      // nav hover-prefetch share. An explicit current-month param forks a
      // duplicate cache entry for identical data.
      void qc.prefetchQuery({
        queryKey: getGetBillsSummaryQueryKey(),
        queryFn: () => getBillsSummary(),
      });
    },
  },
  {
    href: "/forecast/overview",
    warm: (qc) => {
      void qc.prefetchQuery({
        queryKey: getGetForecastQueryKey({ days: 90 }),
        queryFn: () => getForecast({ days: 90 }),
      });
      void qc.prefetchQuery({
        queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
        queryFn: () => getForecastCashSignal({ horizonDays: 90 }),
      });
    },
  },
  {
    href: "/avalanche",
    warm: (qc) => {
      void qc.prefetchQuery({
        queryKey: getListDebtsQueryKey(),
        queryFn: () => listDebts(),
      });
    },
  },
  {
    href: "/budget",
    warm: (qc) => {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      void qc.prefetchQuery({
        queryKey: getGetBudgetMonthQueryKey(month),
        queryFn: () => getBudgetMonth(month),
      });
      void qc.prefetchQuery({
        queryKey: getListCategoriesQueryKey(),
        queryFn: () => listCategories(),
      });
    },
  },
];

export function useLandingWarmup(): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timers: number[] = [];
    const start = () => {
      STAGES.forEach((stage, i) => {
        timers.push(
          window.setTimeout(() => {
            prefetchRoute(stage.href);
            stage.warm(qc);
          }, i * 300),
        );
      });
    };
    const kickoff = window.setTimeout(start, 400);
    return () => {
      window.clearTimeout(kickoff);
      for (const t of timers) window.clearTimeout(t);
    };
  }, [qc]);
}
