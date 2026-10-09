import { Suspense, lazy, useEffect, useState } from "react";
import { PageGrid } from "@/components/next";
import { RefreshBanner } from "@/components/data-state";
import { useSpine } from "@/hooks/useSpine";
import { useLandingWarmup } from "@/hooks/useLandingWarmup";
import { APP_VERSION } from "@/lib/version";
import DashboardHeader from "./dashboard/DashboardHeader";
import SummaryRow from "./dashboard/SummaryRow";
import AccountsPanel from "./dashboard/AccountsPanel";
import { BelowFoldSkeleton } from "./dashboard/BelowFoldSkeleton";

// (C11b, refinement) Everything after the first screen is ONE lazy chunk with
// two slots: the forecast row (forecast + coming up) above the account list,
// and the lower rows (spending pace, debt progress, needs attention, recent
// activity) below it. Each slot stands behind same-size skeletons. The chart
// library is a further lazy chunk inside the forecast panel.
// One promise for both slots and the idle warm-up: the chunk is asked for once.
let belowFold: Promise<typeof import("./dashboard/BelowFold")> | null = null;
const loadBelowFold = () =>
  (belowFold ??= import("./dashboard/BelowFold").catch((e: unknown) => {
    belowFold = null; // a failed fetch may be retried by the next ask
    throw e;
  }));
const ForecastRow = lazy(() => loadBelowFold().then((m) => ({ default: m.ForecastRow })));
const LowerRows = lazy(() => loadBelowFold().then((m) => ({ default: m.LowerRows })));

/** Start the chunk when the browser is idle after first paint, then show it. */
export function useBelowFoldReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const go = () => void loadBelowFold().then(() => !cancelled && setReady(true), () => !cancelled && setReady(true));
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
 * The landing: the household's whole position on one screen, in the order the
 * owner asks it — what cash do we have; what can we spend before payday; will
 * we run short, and when; are we making progress on debt; what needs us today.
 * The header and the summary row answer the first four at a glance; every
 * panel below is the detail one look further down. On a phone it reads top to
 * bottom in the same order. No `Page` wrapper: the shell already pads the
 * page, and the header is this page's title.
 */
export default function DashboardPage() {
  // Warm the area pages' chunks (and the forecast data) on idle, after the
  // open has paid for itself. Never on the critical path.
  useLandingWarmup();
  const below = useBelowFoldReady();
  return (
    <div data-testid="page-next-dashboard" className="lg:pb-14">
      <PageGrid>
        <DashboardHeader />
        <DashboardRefreshBanner />
        <SummaryRow />
        {below ? (
          <Suspense fallback={<BelowFoldSkeleton slot="forecast" />}>
            <ForecastRow />
          </Suspense>
        ) : (
          <BelowFoldSkeleton slot="forecast" />
        )}
        <AccountsPanel />
        {below ? (
          <Suspense fallback={<BelowFoldSkeleton slot="lower" />}>
            <LowerRows />
          </Suspense>
        ) : (
          <BelowFoldSkeleton slot="lower" />
        )}
        <div data-testid="dash-version" className="span-12 font-mono text-micro tabular-nums text-neutral-400">
          Version {APP_VERSION}
        </div>
      </PageGrid>
    </div>
  );
}
