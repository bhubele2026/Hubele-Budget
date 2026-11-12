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
import { prefetchRouteSpeculatively } from "@/lib/routePrefetch";
import { markReady } from "@/lib/perfMarks";
import { whenForegroundIdle } from "@/lib/speculative";

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
 * builder + fetcher the destination page calls. (`/forecast` asks
 * `useGetForecast({ days: 90 })` at its default horizon: the key below, exactly.)
 *
 * (perf phase 2) WHEN: only after Home's real numbers are on screen (the
 * `h2:home-numbers-ready` and `h2:weekly-pay-ready` marks), no query or lazy
 * chunk is in flight and the network has been quiet for `WARMUP_QUIET_MS` —
 * never on Save-Data, a 2G/3G link or a ≤ 2 GB device (`lib/speculative.ts`).
 * If the marks never come (a failed read), after `WARMUP_GIVE_UP_MS` they are
 * no longer waited for; the quiet and device rules still are. Leaving Home
 * cancels whatever has not started. Each later stage runs 300 ms behind.
 *
 * WHAT: the likely next clicks, not every section. A page whose chunk would
 * bring the chart library is warmed only once a chart on screen has loaded it
 * (`prefetchRouteSpeculatively`); its data is warmed either way.
 */

type WarmStage = { href: string; warm: (qc: ReturnType<typeof useQueryClient>) => void };

const warmForecastBundle = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.prefetchQuery({
    queryKey: getGetForecastQueryKey({ days: 90 }),
    queryFn: () => getForecast({ days: 90 }),
  });
  void qc.prefetchQuery({
    queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
    queryFn: () => getForecastCashSignal({ horizonDays: 90 }),
  });
};

// ⭐ C11 — the landing IS the dashboard now, and it reads its own data (spine,
// money position, accounts, bills, debts, cash signal). Idle time warms the
// NEXT click: the area pages' chunks, and the forecast bundle the Forecast and
// Review pages read.
const STAGES: WarmStage[] = [
  {
    href: "/banking",
    // The command center's chunk; its data is the LAST stage (below).
    warm: () => {},
  },
  { href: "/forecast/overview", warm: warmForecastBundle },
  // Review renders the same ForecastPage in a different mode, reading the bundle
  // the stage above warmed (a no-op the second time: `prefetchQuery` honours staleTime).
  { href: "/review", warm: warmForecastBundle },
  {
    href: "/reports/spending",
    // No data warm: the Spending page's primary query takes a caller-chosen
    // date range with no single default key safe to assume here.
    warm: () => {},
  },
  {
    href: "/avalanche",
    warm: (qc) => {
      void qc.prefetchQuery({ queryKey: getListDebtsQueryKey(), queryFn: () => listDebts() });
    },
  },
  {
    // Banking's first reads (the review summary and Needs you) under the page's own keys
    // (`warmBanking`, the hover warm's). Both are built from the ledger on the server, so
    // they go last, behind the forecast bundle, and only under the same idle rules.
    href: "/banking",
    warm: (qc) => {
      void import("@/pages/banking/reviewParams").then((m) => m.warmBanking(qc)).catch(() => {});
    },
  },
];

/** After this long the warm-up stops waiting for the real-number marks (the quiet and device rules still hold). */
export const WARMUP_GIVE_UP_MS = 15_000;
/** How long the foreground (queries, chunks, the network) must stay quiet before the warm-up starts. */
export const WARMUP_QUIET_MS = 400;
/** The marks that say Home's real numbers are on screen. */
export const HOME_MARKS = ["h2:home-numbers-ready", "h2:weekly-pay-ready"] as const;
export const STAGE_GAP_MS = 300;

// Once per document: a re-mounted landing (a theme repaint, Back to Home) does not warm twice.
let warmed = false;

export function useLandingWarmup(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (warmed || typeof window === "undefined") return;
    const timers: number[] = [];
    const cancel = whenForegroundIdle(
      qc,
      { marks: HOME_MARKS, quietMs: WARMUP_QUIET_MS, giveUpMs: WARMUP_GIVE_UP_MS },
      () => {
        warmed = true;
        markReady("h2:warmup-start"); // (PERF-0) when the warm-up began, for traces
        STAGES.forEach((stage, i) => {
          timers.push(
            window.setTimeout(() => {
              prefetchRouteSpeculatively(stage.href);
              stage.warm(qc);
            }, i * STAGE_GAP_MS),
          );
        });
      },
    );
    // Leaving Home (or unmounting) cancels the wait and every stage not yet run.
    return () => {
      cancel();
      for (const t of timers) window.clearTimeout(t);
    };
  }, [qc]);
}

/** Tests only. */
export function _resetLandingWarmupForTests(): void {
  warmed = false;
}
