import { useEffect, useRef } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
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
 * Timing: the first stage starts once the dashboard's queries have settled and
 * the browser is idle (see `useLandingWarmup`); each later stage 300 ms behind.
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

/** Longest the warm-up waits for a quiet moment before it goes anyway. */
export const WARMUP_GIVE_UP_MS = 15_000;
/** How long the dashboard's queries must stay settled before the warm-up starts. */
export const WARMUP_QUIET_MS = 400;

/**
 * (P4) Starts only once the dashboard's OWN queries have settled (nothing in
 * flight for a quiet moment) AND the browser is idle, so the warm-up can never
 * compete with the open it is meant to make feel fast. A new request in flight
 * cancels a pending start; the warm-up then waits for the next quiet moment.
 */
export function useLandingWarmup(): void {
  const qc = useQueryClient();
  const inFlight = useIsFetching();
  const startedRef = useRef(false);
  const timers = useRef<number[]>([]);

  // Gives up waiting: a poll that never rests must not starve the warm-up for good.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = window.setTimeout(() => run(), WARMUP_GIVE_UP_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const idleRef = useRef<{ quiet?: number; idle?: number }>({});
  const clearPending = () => {
    const p = idleRef.current;
    if (p.quiet !== undefined) window.clearTimeout(p.quiet);
    if (p.idle !== undefined) (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(p.idle);
    idleRef.current = {};
  };
  const run = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    STAGES.forEach((stage, i) => {
      timers.current.push(
        window.setTimeout(() => {
          prefetchRoute(stage.href);
          stage.warm(qc);
        }, i * 300),
      );
    });
  };
  function arm() {
    if (startedRef.current || typeof window === "undefined") return;
    clearPending();
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    }).requestIdleCallback;
    idleRef.current.quiet = window.setTimeout(() => {
      if (typeof ric === "function") idleRef.current.idle = ric(run, { timeout: 2_000 });
      else run();
    }, WARMUP_QUIET_MS);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (inFlight === 0) arm();
    else clearPending();
    return clearPending;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight]);

  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );
}
