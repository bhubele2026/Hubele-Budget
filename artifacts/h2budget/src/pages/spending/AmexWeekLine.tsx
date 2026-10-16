import { lazy, Suspense } from "react";
import {
  getGetAmexSummaryQueryKey,
  useGetAmexSummary,
  type AmexSummaryReconciliation,
  type AmexSummaryReconciliationRow,
} from "@workspace/api-client-react/features";
import type { TxnRoute } from "@/lib/accountRoute";
import { formatCurrency } from "@/lib/utils";

const AmexWeekBreakdown = lazy(() => import("./AmexWeekBreakdown"));

/** `?open=` token of the Amex breakdown (its groups: `amex:<key>`). */
export const AMEX_TOKEN = "amex";

const UNRESOLVED: ReadonlySet<string> = new Set(["weekly_unresolved", "monthly_unresolved"]);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * (Task 5) "Amex purchases $X · this week's plan $Y · monthly allowance $Z ·
 * awaiting a decision $W". Every figure is the server's partition
 * (`reconciliation`): only the groups that hold a purchase, at most three
 * inline (the rest are in Breakdown), the two "awaiting a decision" groups as
 * one figure. Words only: nothing is added up here.
 */
export function amexWeekWords(rec: AmexSummaryReconciliation, isCurrent: boolean): string {
  if (rec.purchases.count === 0) return isCurrent ? "No Amex purchases this week" : "No Amex purchases that week";
  const inline = rec.groups
    .filter((g) => g.count > 0 && !UNRESOLVED.has(g.key))
    .slice(0, 3)
    .map((g) => `${lower(g.label)} ${formatCurrency(g.amount)}`);
  const parts = [`Amex purchases ${formatCurrency(rec.purchases.amount)}`, ...inline];
  if (rec.unresolved.count > 0) parts.push(`awaiting a decision ${formatCurrency(rec.unresolved.amount)}`);
  return parts.join(" · ");
}

/**
 * (E5, Task 5) One line on Spending › This week that ties the Amex tile's
 * figure (`GET /amex/summary`, all cards, this week — the tile's own key) to
 * where each purchase went. Breakdown opens the Amex reconciliation in place
 * (`?open=amex`, so Back from a row lands on it open). Nothing while it loads
 * or fails; never "$0.00" for a missing figure.
 */
export function AmexWeekLine({ start, end, isCurrent, open, onToggle, routeOf }: {
  start: string;
  end: string;
  isCurrent: boolean;
  open: readonly string[];
  onToggle: (token: string) => void;
  routeOf: (r: AmexSummaryReconciliationRow) => TxnRoute;
}) {
  const params = { accountId: "all", from: start, to: end };
  const q = useGetAmexSummary(params, { query: { queryKey: getGetAmexSummaryQueryKey(params) } });
  const rec = q.data?.reconciliation;
  if (rec == null) return null;
  const words = <span data-testid="sp-amex-week-words">{amexWeekWords(rec, isCurrent)}</span>;
  if (rec.purchases.count === 0 && rec.refunds.count === 0) {
    return <p className="text-label text-neutral-700" data-testid="sp-amex-week">{words}</p>;
  }
  const isOpen = open.includes(AMEX_TOKEN);
  return (
    <details open={isOpen} className="text-label text-neutral-700" data-testid="sp-amex-week">
      <summary
        className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy [&::-webkit-details-marker]:hidden"
        onClick={(e) => {
          // The address holds the state (`?open=`): the page opens and closes it.
          e.preventDefault();
          onToggle(AMEX_TOKEN);
        }}
      >
        {words}
        <span className="font-medium text-brand-navy underline" data-testid="sp-amex-week-link">Breakdown</span>
      </summary>
      {isOpen ? (
        <Suspense fallback={<div className="skeleton mt-2 h-16 w-full rounded-card" aria-busy="true" />}>
          <AmexWeekBreakdown rec={rec} start={start} end={end} isCurrent={isCurrent} open={open} onToggle={onToggle} routeOf={routeOf} />
        </Suspense>
      ) : null}
    </details>
  );
}
