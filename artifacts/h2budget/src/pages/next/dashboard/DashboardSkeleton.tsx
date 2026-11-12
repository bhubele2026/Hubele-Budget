import { cn } from "@/lib/utils";
import { BelowFoldSkeleton } from "./BelowFoldSkeleton";
import { FOUR_BOX, FOUR_BOX_BAR, FOUR_GRID } from "./tileParts";

/**
 * ⭐ THE SHELL THAT PAINTS BEFORE CLERK ANSWERS. The dashboard's layout with
 * zero numbers, so a browser whose session turns out to be stale cannot have
 * seen a single figure. Nothing here reads a query. App.tsx renders it while
 * Clerk is still resolving on a returning visitor.
 *
 * ⚠️ SAME SIZE AS THE PAGE'S OWN SKELETON, BY CONSTRUCTION. The two lazy slots
 * are the very `BelowFoldSkeleton`s the page shows (one `BELOW_FOLD` constant
 * feeds spans and minimum heights), so when Clerk answers and the page mounts,
 * nothing jumps. The header, the "Pay this week" slot, the four number boxes
 * and the closed "More" line match the page's first paint (a test pins the
 * slot sizes).
 */
export function DashboardSkeleton() {
  return (
    <div data-testid="dashboard-skeleton" aria-busy="true" className="lg:pb-14">
      <div className="grid-12">
        <div className="span-12" data-testid="dashboard-skeleton-header">
          <div className="skeleton h-8 w-48 rounded-control" />
          <div className="skeleton mt-2 h-4 w-24 max-w-full rounded" />
        </div>
        <BelowFoldSkeleton slot="pay" />
        <div className={FOUR_GRID}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn("panel border-l-4", i < 2 ? FOUR_BOX : FOUR_BOX_BAR)} data-testid="dashboard-skeleton-tile">
              <div className="skeleton h-4 w-24 max-w-full rounded" />
              <div className="skeleton mt-4 h-7 w-28 max-w-full rounded" />
            </div>
          ))}
        </div>
        <div className="span-12 flex h-10 items-center">
          <div className="skeleton h-4 w-16 rounded" />
        </div>
        <BelowFoldSkeleton slot="forecast" />
      </div>
    </div>
  );
}
