import AllowancesPage from "./allowances";

/**
 * (W1) `/spending/week` and `/spending/month` — the two views at the head of
 * the Spending tabs. Their own content is a later batch; until then each shows
 * the Allowances page (it carries the weekly and monthly cards) under its own
 * title, so the tab is never a blank screen.
 */
export default function SpendingPeriodPage({ view }: { view: "week" | "month" }) {
  return (
    <div data-testid={`spending-${view}`} className="space-y-4">
      <h1 className="text-display font-semibold text-brand-navy">
        {view === "week" ? "This week" : "This month"}
      </h1>
      <AllowancesPage />
    </div>
  );
}
