import { getGetAmexSummaryQueryKey, useGetAmexSummary } from "@workspace/api-client-react/features";
import { moneyFace } from "@/components/data-state";
import { currentWeekRange } from "@/lib/timeRange";

/**
 * (W4) "Amex purchases · this week $X" on the Amex tile: every card, this Sun–Sat
 * week, the server's own figure (`GET /amex/summary`). Its own lazy chunk,
 * asked for after first paint (the landing has no room for the features
 * client). Nothing while it loads, fails or has no figure: never $0.
 */
export default function AmexWeekCharges() {
  const wk = currentWeekRange();
  const params = { accountId: "all", from: wk.from, to: wk.to };
  const q = useGetAmexSummary(params, { query: { queryKey: getGetAmexSummaryQueryKey(params) } });
  const amount = q.data?.purchases.amount;
  if (amount == null) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-brand-line pt-2" data-testid="tile-amex-purchases-week">
      <span className="text-label text-neutral-600">Amex purchases · this week</span>
      <span className="font-mono text-body font-semibold tabular-nums text-brand-navy">{moneyFace(amount)}</span>
    </div>
  );
}
