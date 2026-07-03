import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { PlanLine, PlanSuggestion } from "@/lib/forecastMatch";

export function SuggestionStrip({
  suggestions,
  onPick,
  txnId,
}: {
  suggestions: PlanSuggestion[];
  onPick: (p: PlanLine) => void;
  txnId: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-card-border bg-muted/30 px-2.5 py-1.5"
      data-testid={`bank-suggestions-${txnId}`}
    >
      <span className="mr-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
        Suggested
      </span>
      {suggestions.map((s) => {
        const cls =
          s.confidence === "high"
            ? "bg-primary/15 text-primary border-primary/30"
            : s.confidence === "medium"
              ? "bg-warning/10 text-warning border-warning/30"
              : "bg-muted text-muted-foreground";
        return (
          <Button
            key={`${s.plan.itemId}|${s.plan.date}`}
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5 px-2"
            onClick={() => onPick(s.plan)}
            data-testid={`suggest-match-${txnId}-${s.plan.itemId}-${s.plan.date}`}
            title={`${s.daysAway}d away · Δ ${formatCurrency(s.amountDelta)}${s.labelMatch ? " · label match" : ""}`}
            aria-label={`Match to ${s.plan.label} on ${s.plan.date}, ${s.confidence} confidence`}
          >
            <span className="font-semibold">Match:</span>
            <span className="truncate max-w-[140px]">{s.plan.label}</span>
            <span className="text-muted-foreground tabular-nums">
              {formatDate(s.plan.date)}
            </span>
            <Badge variant="outline" className={`${cls} text-[9px] px-1 py-0`}>
              {s.confidence}
            </Badge>
          </Button>
        );
      })}
    </div>
  );
}
