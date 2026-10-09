import ForecastPanel from "./ForecastPanel";
import DebtPanel from "./DebtPanel";
import ActivityPanel from "./ActivityPanel";
import ReviewPanel from "./ReviewPanel";
import AttentionPanel from "./AttentionPanel";

/** (C11b) The panels below the first screen, as one lazy chunk. A fragment, so
 *  they sit in the page's own grid exactly where the eager ones would. */
export default function BelowFold() {
  return (
    <>
      <ForecastPanel />
      <DebtPanel />
      <ActivityPanel />
      <ReviewPanel />
      <AttentionPanel />
    </>
  );
}
