import { BelowFoldSkeleton } from "./BelowFoldSkeleton";

/**
 * ⭐ THE SHELL THAT PAINTS BEFORE CLERK ANSWERS. The dashboard's layout with
 * zero numbers, so a browser whose session turns out to be stale cannot have
 * seen a single figure. Nothing here reads a query. App.tsx renders it while
 * Clerk is still resolving on a returning visitor.
 *
 * ⚠️ SAME SIZE AS THE PAGE'S OWN SKELETON, BY CONSTRUCTION. The two lazy slots
 * are the very `BelowFoldSkeleton`s the page shows (one `BELOW_FOLD` constant
 * feeds spans and minimum heights), so when Clerk answers and the page mounts,
 * nothing below the tiles jumps. The header and the six tile
 * placeholders match the page's first paint (a test pins the slot sizes).
 */
export function DashboardSkeleton() {
  return (
    <div data-testid="dashboard-skeleton" aria-busy="true" className="lg:pb-14">
      <div className="grid-12">
        <div className="span-12" data-testid="dashboard-skeleton-header">
          <div className="skeleton h-8 w-48 rounded-control" />
          <div className="skeleton mt-2 h-4 w-80 max-w-full rounded" />
          <div className="skeleton mt-2 h-3 w-56 max-w-full rounded" />
        </div>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="panel tile-in span-4 min-h-[11.5rem] border-l-4 p-4" data-testid="dashboard-skeleton-tile">
            <div className="skeleton h-4 w-24 rounded" />
            <div className="skeleton mt-4 h-7 w-32 max-w-full rounded" />
            <div className="skeleton mt-3 h-3 w-40 max-w-full rounded" />
          </div>
        ))}
        <BelowFoldSkeleton slot="forecast" />
      </div>
    </div>
  );
}
