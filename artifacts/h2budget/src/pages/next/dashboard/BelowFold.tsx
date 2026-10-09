import ForecastPanel from "./ForecastPanel";
import UpcomingPanel from "./UpcomingPanel";
import SpendingPanel from "./SpendingPanel";
import DebtPanel from "./DebtPanel";
import AttentionPanel from "./AttentionPanel";
import ActivityPanel from "./ActivityPanel";

/**
 * (C11b, dashboard refinement) The panels after the first screen, as ONE lazy
 * chunk with two slots. Fragments, so they sit in the page's own grid exactly
 * where eager panels would: the forecast row above the account list, the
 * lower rows below it.
 */
export function ForecastRow() {
  return (
    <>
      <ForecastPanel />
      <UpcomingPanel />
    </>
  );
}

export function LowerRows() {
  return (
    <>
      <SpendingPanel />
      <DebtPanel />
      <AttentionPanel />
      <ActivityPanel />
    </>
  );
}
