import AvalancheWeekBox from "./AvalancheWeekBox";
import ForecastPanel from "./ForecastPanel";

/**
 * The forecast graph, the only panel after the tiles, as ONE lazy chunk — with
 * (AVAL-W) the weekly avalanche's "Avalanche this week" box above it (nothing
 * with the monthly cadence). The other panels (coming up, spending pace, debt
 * progress, needs attention, recent activity) no longer render on /home; their
 * files stay for the pages that reuse them.
 */
export function ForecastRow() {
  return (
    <>
      <AvalancheWeekBox />
      <ForecastPanel />
    </>
  );
}
