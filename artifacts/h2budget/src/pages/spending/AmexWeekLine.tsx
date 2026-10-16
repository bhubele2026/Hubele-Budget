import { getGetAmexSummaryQueryKey, useGetAmexSummary } from "@workspace/api-client-react/features";
import { formatCurrency } from "@/lib/utils";

/**
 * (E5) One line that ties the Amex tile's week figure to this page: "Amex purchases $X · counted $Y ·
 * not counted $Z", every number the server's own (`GET /amex/summary`, the tile's key, all cards, this
 * week). Counted = what the cards added to this plan (known); not counted = their unconfirmed part.
 * The three are never forced to add up. Nothing while it loads or fails; never "$0.00" for a missing figure.
 */
export function AmexWeekLine({ start, end, onOpen }: { start: string; end: string; onOpen: () => void }) {
  const params = { accountId: "all", from: start, to: end };
  const q = useGetAmexSummary(params, { query: { queryKey: getGetAmexSummaryQueryKey(params) } });
  const x = q.data?.purchases.amount;
  const hc = q.data?.householdContribution;
  if (x == null || hc == null) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-label text-neutral-700" data-testid="sp-amex-week">
      <span data-testid="sp-amex-week-words">
        Amex purchases {formatCurrency(x)} · counted {formatCurrency(hc.weeklyKnown)} · not counted {formatCurrency(hc.weeklyUnresolved)}
      </span>
      <button type="button" className="font-medium text-brand-navy underline" onClick={onOpen} data-testid="sp-amex-week-link">Breakdown</button>
    </p>
  );
}
