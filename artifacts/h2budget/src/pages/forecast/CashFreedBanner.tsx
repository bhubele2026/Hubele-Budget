import { formatCurrency } from "@/lib/utils";
import { fmtMonth } from "@/lib/avalanche";
import type { PayoffTransition } from "@/lib/forecastDebts";

export function nextMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return "";
  const d = new Date(y, m, 1);
  return fmtMonth(d);
}

/**
 * A debt clears mid-register, so the money that was servicing it comes back.
 *
 * ⚠️ THIS IS THE NORTH STAR EVENT — a payoff — so it is the one row allowed to
 * look different from a plan row. It stays a hairline card in the navy set,
 * not a celebration: the app's own rule is that good news is navy and does not
 * shout. The "✨ Cash Freed" badge and the "freed up" caption under the number
 * both went; the chip says what happened and the number says how much.
 */
export function CashFreedBanner({ transition }: { transition: PayoffTransition }) {
  return (
    <div
      data-testid={`cash-freed-${transition.debtId}`}
      className="flex items-center justify-between gap-3 border-b border-brand-line/70 bg-brand-navy/[0.03] px-4 py-3 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="chip ok">Paid off</span>
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-neutral-700">
            {transition.debtName} is gone
          </div>
          <div className="text-micro text-neutral-400">
            from {nextMonthLabel(transition.payoffYM)}
          </div>
        </div>
      </div>
      <span className="font-mono text-label font-semibold tabular-nums text-brand-navy">
        +{formatCurrency(transition.freedAmount)}/mo
      </span>
    </div>
  );
}
