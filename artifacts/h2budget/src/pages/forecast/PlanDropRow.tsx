import { useDroppable } from "@dnd-kit/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCurrency, formatDate } from "@/lib/utils";
import { fmtMonth } from "@/lib/avalanche";
import type { PlanLine } from "@/lib/forecastMatch";
import type { PayoffInfo } from "@/lib/forecastDebts";
import { Flame } from "lucide-react";
import { isPlanRowMatchEligible, statusBadge } from "./statusBadge";

export function PlanDropRow({
  row,
  onSelect,
  onMove,
  onMarkMissed,
  activeDragId,
  payoff,
  isBestSuggestion = false,
  isHighlighted = false,
}: {
  row: PlanLine;
  onSelect: (row: PlanLine) => void;
  onMove?: (row: PlanLine) => void;
  /** (#480) Per-row "Mark missed" handler. Surfaced as an explicit button
   *  alongside "Move to…" so users don't have to discover the row click
   *  (which now also routes through this same handler). */
  onMarkMissed?: (row: PlanLine) => void;
  activeDragId: string | null;
  payoff?: PayoffInfo;
  /**
   * (#26) When a bank inbox card is being dragged or hovered, the row whose
   * plan key matches that card's top suggestion gets a tinted ring so the
   * user can see exactly where to drop. Parent owns the "is this the best
   * suggestion right now" decision so we don't recompute scoring per row.
   */
  isBestSuggestion?: boolean;
  /**
   * (#335) When the user clicks a big-bill marker (or a bill inside its
   * tooltip), the matching plan row briefly pulses so they can see exactly
   * which bill the dot was pointing at.
   */
  isHighlighted?: boolean;
}) {
  // (#456) Keep ALL plan rows registered as droppable — even matched/missed
  // ones — so a stray drop doesn't silently no-op. The parent decides
  // whether to apply the match or surface a rejection toast based on
  // `row.status` in `onDragEnd`. Eligibility uses the shared helper so the
  // visual "blocked" state and the drop handler can never disagree.
  const isEligible = isPlanRowMatchEligible(row);
  const droppable = useDroppable({
    id: `plan:${row.itemId}|${row.date}`,
    data: { kind: "plan", planRow: row },
  });
  const isDragActive = activeDragId !== null;
  // (#456) Only treat hover-over as a "valid drop" highlight when the row
  // is actually eligible. Ineligible rows stay registered as droppable
  // (so `onDragEnd` can surface a rejection toast) but must NEVER render
  // the strong primary-ring affordance — otherwise the UI implies a
  // valid drop and then rejects on release. Ineligible-hover gets its
  // own distinct destructive treatment so the user knows they're over a
  // blocked target.
  const isOverEligible = droppable.isOver && isDragActive && isEligible;
  const isOverBlocked = droppable.isOver && isDragActive && !isEligible;
  const showSuggestion = !isOverEligible && isBestSuggestion;
  const canMove =
    !!onMove && (row.status === "pending_plan" || row.status === "future");
  // (#480) Mark-missed is only meaningful while the row is still pending —
  // once it's matched/missed/rescheduled there's nothing to "miss".
  const canMarkMissed =
    !!onMarkMissed &&
    (row.status === "pending_plan" || row.status === "future");
  // (#456) During an active drag, mark every eligible plan row as a valid
  // drop target so the user sees there are many places they can land. The
  // row directly under the cursor (`isOverEligible`) gets a stronger
  // highlight via the existing primary ring. Ineligible rows show a clear
  // disabled style.
  const showDropAffordance = isDragActive && isEligible && !isOverEligible;
  const showDropBlocked = isDragActive && !isEligible;
  return (
    <div
      ref={droppable.setNodeRef}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(row)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(row);
        }
      }}
      data-suggested-drop={showSuggestion ? "true" : undefined}
      data-drop-eligible={
        isDragActive ? (isEligible ? "true" : "false") : undefined
      }
      data-plan-key={`${row.itemId}|${row.date}`}
      data-testid={`plan-row-${row.itemId}-${row.date}`}
      className={`w-full text-left px-3 py-2 flex items-center justify-between transition-colors cursor-pointer ${
        isOverEligible
          ? "bg-primary/10 ring-2 ring-primary ring-inset"
          : isOverBlocked
            ? "bg-destructive/5 ring-2 ring-destructive/60 ring-inset opacity-60 cursor-not-allowed"
            : isHighlighted
              ? "bg-sky-50 ring-2 ring-sky-400 ring-inset dark:bg-sky-950/30"
              : showSuggestion
                ? "bg-amber-50 ring-2 ring-amber-400/70 ring-inset dark:bg-amber-950/20"
                : showDropAffordance
                  ? "bg-primary/[0.04] ring-1 ring-dashed ring-primary/40 ring-inset"
                  : showDropBlocked
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Badge
          variant="outline"
          className="bg-amber-50 text-amber-900 border-amber-200"
        >
          Plan
        </Badge>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate flex items-center gap-2">
            <span className="truncate">{row.label}</span>
            {payoff && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="bg-orange-50 text-orange-900 border-orange-200 dark:bg-orange-950/30 dark:text-orange-200 dark:border-orange-900 text-[10px] gap-1 px-1.5 py-0"
                    >
                      <Flame className="h-3 w-3" />
                      ends {fmtMonth(payoff.payoffDate)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    Avalanche projects {payoff.debtName} paid off in {fmtMonth(payoff.payoffDate)}.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatDate(row.date)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4">
        {statusBadge(row.status)}
        <span
          className={`font-medium tabular-nums ${
            row.amount < 0 ? "text-destructive" : "text-primary"
          }`}
        >
          {formatCurrency(row.amount)}
        </span>
        {canMove && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              onMove?.(row);
            }}
            data-testid={`move-plan-${row.itemId}-${row.date}`}
            title="Move this occurrence to another day (next 30 days)"
          >
            Move to…
          </Button>
        )}
        {canMarkMissed && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-amber-700 hover:text-amber-800 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/30"
            onClick={(e) => {
              e.stopPropagation();
              onMarkMissed?.(row);
            }}
            data-testid={`mark-missed-${row.itemId}-${row.date}`}
            title="Move this occurrence into the Missed bucket"
          >
            Mark missed
          </Button>
        )}
      </div>
    </div>
  );
}
