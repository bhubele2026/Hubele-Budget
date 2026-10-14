import { PeriodView } from "./spending/PeriodView";

/**
 * (W5) `/spending/week` and `/spending/month` — "Why over?". The plan, what
 * counts toward it, left or over, the categories that drove it and the
 * purchases behind them, for the week or month in `?start=`. `key` remounts the
 * view when the tab changes, so each tab reads its own URL state.
 */
export default function SpendingPeriodPage({ view }: { view: "week" | "month" }) {
  return <PeriodView key={view} view={view} />;
}
