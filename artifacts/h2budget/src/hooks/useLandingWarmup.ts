import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getForecast,
  getGetForecastQueryKey,
  getForecastCashSignal,
  getGetForecastCashSignalQueryKey,
  listDebts,
  getListDebtsQueryKey,
} from "@workspace/api-client-react";
import { prefetchRoute } from "@/lib/routePrefetch";

/**
 * ⭐ THE LANDING BUYS THE NEXT CLICK, AFTER IT HAS PAID FOR ITS OWN.
 *
 * The landing paid for its own panels. That leaves the browser idle while the
 * owner reads them and decides where to go — so we spend that idle time warming the area pages' chunks AND their data, staggered so the
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

// ⭐ C11 — the landing IS the dashboard now, and it reads its own data (spine,
// money position, accounts, bills, debts, cash signal). Idle time warms the
// NEXT click: the area pages' chunks, and the forecast bundle the Forecast and
// Review pages read. The old first stage warmed `getDashboard`, which neither
// the old landing nor `/banking` read, and is gone.
const STAGES: WarmStage[] = [
  {
    href: "/banking",
    // The command center reads the spine, which the dashboard already holds.
    warm: () => {},
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
    href: "/reports/spending",
    // No data warm: the Spending page's primary query takes a caller-chosen
    // date range with no single default key safe to assume here — see the
    // module doc above (a mismatched key is worse than no warm-up). The
    // route's JS chunk still warms via `prefetchRoute` below.
    warm: () => {},
  },
  {
    href: "/review",
    // Review renders the same ForecastPage in a different mode, reading the
    // identical bundle Forecast just warmed — so it warms the same way.
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
