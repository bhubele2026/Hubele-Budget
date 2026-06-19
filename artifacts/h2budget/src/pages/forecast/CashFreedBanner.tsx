import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { fmtMonth } from "@/lib/avalanche";
import type { PayoffTransition } from "@/lib/forecastDebts";
import { Sparkles } from "lucide-react";

export function nextMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return "";
  const d = new Date(y, m, 1);
  return fmtMonth(d);
}

export function CashFreedBanner({ transition }: { transition: PayoffTransition }) {
  return (
    <div
      data-testid={`cash-freed-${transition.debtId}`}
      className="p-4 flex items-center justify-between gap-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md"
    >
      <div className="flex items-center gap-3 min-w-0">
        <Badge
          variant="outline"
          className="bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-900/40 dark:text-orange-100 dark:border-orange-800 gap-1"
        >
          <Sparkles className="h-3 w-3" />
          Cash Freed
        </Badge>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate text-orange-950 dark:text-orange-100">
            {transition.debtName} is gone
          </div>
          <div className="text-xs text-orange-800/80 dark:text-orange-200/80">
            starting {nextMonthLabel(transition.payoffYM)}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="font-semibold tabular-nums text-orange-900 dark:text-orange-100">
          +{formatCurrency(transition.freedAmount)}/mo
        </div>
        <div className="text-[10px] uppercase tracking-wide text-orange-800/70 dark:text-orange-200/70">
          freed up
        </div>
      </div>
    </div>
  );
}
