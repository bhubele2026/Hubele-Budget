import { Page } from "@/ui";
import { PageGrid } from "@/components/next";
import { AffordLauncher } from "@/components/afford/AffordLauncher";
import BriefingPanel from "./dashboard/BriefingPanel";
import AccountsRow from "./dashboard/AccountsRow";
import CashPanel from "./dashboard/CashPanel";
import SpendingPanel from "./dashboard/SpendingPanel";
import UpcomingPanel from "./dashboard/UpcomingPanel";
import ForecastPanel from "./dashboard/ForecastPanel";
import DebtPanel from "./dashboard/DebtPanel";
import ActivityPanel from "./dashboard/ActivityPanel";
import ReviewPanel from "./dashboard/ReviewPanel";

/** The preview dashboard: one screen for the household's whole position.
 *  Panel order is importance order, so a phone reads it top to bottom. */
export default function NextDashboardPage() {
  return (
    <div data-testid="page-next-dashboard" className="lg:pb-14">
      <Page title="Dashboard" sub="Preview">
        <PageGrid>
          <div className="span-12 flex justify-end">
            <AffordLauncher />
          </div>
          <BriefingPanel />
          <AccountsRow />
          <CashPanel />
          <SpendingPanel />
          <UpcomingPanel />
          <ForecastPanel />
          <DebtPanel />
          <ActivityPanel />
          <ReviewPanel />
        </PageGrid>
      </Page>
    </div>
  );
}
