import { Suspense, useEffect, useState } from "react";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
import { PageGrid } from "@/components/next";
import { RefreshBanner } from "@/components/data-state";
import { useSpine } from "@/hooks/useSpine";
import { useLandingWarmup } from "@/hooks/useLandingWarmup";
import { APP_VERSION } from "@/lib/version";
import DashboardHeader from "./dashboard/DashboardHeader";
import FourNumbers from "./dashboard/FourNumbers";
import { BelowFoldSkeleton } from "./dashboard/BelowFoldSkeleton";
import { CompactFold } from "./dashboard/foldDensity";
import { usePlaidItemsQ } from "./dashboard/queries";
import { hasLinkedBank } from "./dashboard/bankState";

// (Home is four numbers, 2026-11-11) Three lazy chunks behind same-size
// skeletons, none on the open path: "Pay this week" (directly under the header,
// asked for at once), the "More" drawer (the six tiles and the header's old
// small print, mounted when opened) and the forecast graph (after first paint;
// the chart library is a further lazy chunk inside it).
const PayThisWeek = lazyWithPreload(() => import("./dashboard/AvalancheWeekBox"));
const MoreDrawer = lazyWithPreload(() => import("./dashboard/MoreDrawer"));
const ForecastRow = lazyWithPreload(() => import("./dashboard/BelowFold").then((m) => ({ default: m.ForecastRow })));

/** The closed drawer's own height (its one line), so nothing moves when it arrives. */
const MoreSkeleton = () => (
  <div className="span-12 flex h-10 items-center" data-testid="dash-more-skeleton" aria-busy="true">
    <div className="skeleton h-4 w-16 rounded" />
  </div>
);

/** Start the chunk when the browser is idle after first paint, then show it. */
export function useBelowFoldReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const go = () => void ForecastRow.preload().then(() => !cancelled && setReady(true), () => !cancelled && setReady(true));
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    if (typeof w.requestIdleCallback === "function") {
      const h = w.requestIdleCallback(go, { timeout: 1500 });
      return () => { cancelled = true; w.cancelIdleCallback?.(h); };
    }
    const t = window.setTimeout(go, 0);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, []);
  return ready;
}

/** (C11) A failed refresh keeps the last good numbers on screen, so the page
 *  says so, with Retry. Without this the panels' `Gate` would hide it. */
function DashboardRefreshBanner() {
  const spine = useSpine();
  if (spine.state !== "refresh-failed" && spine.state !== "failed") return null;
  return (
    <div className="span-12">
      <RefreshBanner
        state={spine.state}
        updatedAt={spine.updatedAt}
        onRetry={spine.refetch}
        refreshing={spine.isFetching}
        data-testid="dash-refresh-banner"
      />
    </div>
  );
}

/**
 * The landing, in four numbers (owner, 2026-11-11): the day, what to pay this
 * week, then checking · lowest · spent this week · debt paid. Everything the
 * page used to open with is one tap away under "More", unchanged; the forecast
 * graph follows. No `Page` wrapper: the shell already pads the page, and the
 * header is this page's title.
 */
export default function DashboardPage() {
  // Warm the area pages' chunks (and the forecast data) on idle, after the
  // open has paid for itself. Never on the critical path.
  useLandingWarmup();
  const below = useBelowFoldReady();
  const items = usePlaidItemsQ();
  const compact = items.data !== undefined && !hasLinkedBank(items.data);
  return (
    <div data-testid="page-next-dashboard" data-compact={compact ? "true" : undefined} className="lg:pb-14">
      <CompactFold.Provider value={compact}>
      <PageGrid>
        <DashboardHeader />
        <DashboardRefreshBanner />
        <Suspense fallback={<BelowFoldSkeleton slot="pay" />}>
          <PayThisWeek />
        </Suspense>
        <FourNumbers />
        {below ? (
          <Suspense fallback={<MoreSkeleton />}>
            <MoreDrawer />
          </Suspense>
        ) : (
          <MoreSkeleton />
        )}
        {below ? (
          <Suspense fallback={<BelowFoldSkeleton slot="forecast" />}>
            <ForecastRow />
          </Suspense>
        ) : (
          <BelowFoldSkeleton slot="forecast" />
        )}
        <div data-testid="dash-version" className="span-12 font-mono text-micro tabular-nums text-neutral-500">
          Version {APP_VERSION}
        </div>
      </PageGrid>
      </CompactFold.Provider>
    </div>
  );
}
