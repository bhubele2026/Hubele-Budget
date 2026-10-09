import { Page } from "@/ui";
import { PageGrid } from "@/components/next";
import { AffordLauncher } from "@/components/afford/AffordLauncher";
import { RefreshBanner } from "@/components/data-state";
import { useSpine } from "@/hooks/useSpine";
import { useLandingWarmup } from "@/hooks/useLandingWarmup";
import { APP_VERSION } from "@/lib/version";
import BriefingPanel from "./dashboard/BriefingPanel";
import AccountsRow from "./dashboard/AccountsRow";
import CashPanel from "./dashboard/CashPanel";
import SpendingPanel from "./dashboard/SpendingPanel";
import UpcomingPanel from "./dashboard/UpcomingPanel";
import ForecastPanel from "./dashboard/ForecastPanel";
import DebtPanel from "./dashboard/DebtPanel";
import ActivityPanel from "./dashboard/ActivityPanel";
import ReviewPanel from "./dashboard/ReviewPanel";

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

/** The landing: one screen for the household's whole position (the front door
 *  retired in C11). Panel order is importance order, so a phone reads it top to
 *  bottom. */
export default function DashboardPage() {
  // Warm the area pages' chunks (and the forecast data) on idle, after the
  // open has paid for itself. Never on the critical path.
  useLandingWarmup();
  return (
    <div data-testid="page-next-dashboard" className="lg:pb-14">
      <Page title="Dashboard">
        <PageGrid>
          <div className="span-12 flex justify-end">
            <AffordLauncher />
          </div>
          <DashboardRefreshBanner />
          <BriefingPanel />
          <AccountsRow />
          <CashPanel />
          <SpendingPanel />
          <UpcomingPanel />
          <ForecastPanel />
          <DebtPanel />
          <ActivityPanel />
          <ReviewPanel />
          <div data-testid="dash-version" className="span-12 font-mono text-micro tabular-nums text-neutral-400">
            Version {APP_VERSION}
          </div>
        </PageGrid>
      </Page>
    </div>
  );
}
