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
      className="p-4 flex items-center justify-between gap-3 bg-[hsl(var(--chart-3)/0.12)] border border-[hsl(var(--chart-3)/0.35)] rounded-md"
    >
      <div className="flex items-center gap-3 min-w-0">
        <Badge
          variant="outline"
          className="bg-[hsl(var(--chart-3)/0.2)] text-warning border-[hsl(var(--chart-3)/0.45)] gap-1"
        >
          <Sparkles className="h-3 w-3" />
          Cash Freed
        </Badge>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate text-foreground">
            {transition.debtName} is gone
          </div>
          <div className="text-xs text-muted-foreground">
            starting {nextMonthLabel(transition.payoffYM)}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="font-semibold tabular-nums text-positive">
          +{formatCurrency(transition.freedAmount)}/mo
        </div>
        <div className="text-[10px] uppercase tracking-wide text-warning/70">
          freed up
        </div>
      </div>
    </div>
  );
}
