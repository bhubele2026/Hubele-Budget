import { useDroppable } from "@dnd-kit/core";
import { btnLink } from "@/ui";
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
      // ⚠️ `ring-primary` is the NAVY focus treatment — B1 rebound `--primary`
      // to #19315b. Keep the token name: the drag tests assert on it, and it
      // already resolves to the right colour.
      // ⭐ ONE MARKUP, TWO SHAPES. On a phone the label, the amount and two
      // buttons cannot share a line: the name collapses to "Pa…" and the date
      // wraps to three lines. Below `sm` the row breaks — name and date own
      // the first line, status/amount/actions the second, right-aligned. Same
      // DOM, no second mobile render, no duplicated testids.
      className={`flex w-full cursor-pointer flex-wrap items-center justify-between gap-y-2 px-4 py-2.5 text-left transition-colors ${
        isOverEligible
          ? "bg-primary/10 ring-2 ring-primary ring-inset"
          : isOverBlocked
            ? "cursor-not-allowed bg-bad-bg opacity-60 ring-2 ring-bad/60 ring-inset"
            : isHighlighted
              ? "bg-primary/10 ring-2 ring-primary ring-inset"
              : showSuggestion
                ? "bg-brand-navy/[0.06] ring-2 ring-brand-navy/40 ring-inset"
                : showDropAffordance
                  ? "bg-brand-navy/[0.03] ring-1 ring-dashed ring-brand-navy/30 ring-inset"
                  : showDropBlocked
                    ? "cursor-not-allowed opacity-50"
                    : "hover:bg-neutral-50"
      }`}
    >
      <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-auto">
        <div className="min-w-0">
          <div className="flex items-center gap-2 truncate text-body font-medium text-neutral-700">
            <span className="truncate">{row.label}</span>
            {payoff && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="chip ok inline-flex items-center gap-1">
                      <Flame className="h-3 w-3" aria-hidden="true" />
                      ends {fmtMonth(payoff.payoffDate)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Avalanche projects {payoff.debtName} paid off in {fmtMonth(payoff.payoffDate)}.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="whitespace-nowrap font-mono text-micro tabular-nums text-neutral-400">
            {formatDate(row.date)}
          </div>
        </div>
      </div>
      <div className="flex w-full items-center justify-end gap-3 sm:w-auto sm:gap-4">
        {statusBadge(row.status)}
        <span
          className={`font-mono text-label tabular-nums ${
            row.amount < 0 ? "text-bad" : "text-brand-navy"
          }`}
        >
          {formatCurrency(row.amount)}
        </span>
        {canMove && (
          <button
            type="button"
            // Local `whitespace-nowrap`, not a kit change: the kit is frozen
            // for the Phase C page passes, and "Move to…" is the only label in
            // it long enough to break across two lines in a phone-width row.
            className={`${btnLink} whitespace-nowrap`}
            onClick={(e) => {
              e.stopPropagation();
              onMove?.(row);
            }}
            data-testid={`move-plan-${row.itemId}-${row.date}`}
            title="Move this occurrence to another day (next 30 days)"
          >
            Move to…
          </button>
        )}
        {canMarkMissed && (
          <button
            type="button"
            className={`${btnLink} whitespace-nowrap`}
            onClick={(e) => {
              e.stopPropagation();
              onMarkMissed?.(row);
            }}
            data-testid={`mark-missed-${row.itemId}-${row.date}`}
            title="Move this occurrence into the Missed bucket"
          >
            Mark missed
          </button>
        )}
      </div>
    </div>
  );
}
