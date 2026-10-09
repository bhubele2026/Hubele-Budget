import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading state for the account pages (Chase, Amex, `/next/accounts`): the
 * real layout's shape on the 12-column grid — head, controls, the summary
 * panels, the chart panel, then the ledger panel's rows — so the page fills
 * in where it already stands instead of jumping from a generic block. Zero
 * numbers: a skeleton never shows a figure.
 */
export function AccountPageSkeleton({ tiles = 2 }: { tiles?: number }) {
  // The summary row: two panels side by side on the account pages; a count
  // other than 2–4 still lays out (3 or 4 across on a desktop).
  const n = Math.min(Math.max(tiles, 1), 4);
  const span = n === 1 ? "span-12" : n === 2 ? "span-6" : n === 3 ? "span-4" : "span-3";
  return (
    <div className="space-y-4" data-testid="account-page-skeleton" aria-busy="true">
      {/* Head: title + actions */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-6 w-56" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>

      {/* Range controls */}
      <Skeleton className="h-8 w-48" />

      <div className="grid-12">
        {Array.from({ length: n }).map((_, i) => (
          <div key={i} className={`panel ${span}`}>
            <div className="panel-head">
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="space-y-3 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-6 w-28" />
            </div>
          </div>
        ))}

        {/* Chart panel */}
        <div className="panel span-12">
          <div className="panel-head">
            <Skeleton className="h-4 w-56" />
          </div>
          <div className="p-4">
            <Skeleton className="h-[220px] w-full md:h-[260px]" />
          </div>
        </div>

        {/* Ledger panel: pane, then rows */}
        <div className="panel span-12">
          <div className="panel-head">
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="border-b border-brand-line px-4 py-2">
            <Skeleton className="h-8 w-72" />
          </div>
          <div className="divide-y divide-brand-line/70">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex min-h-10 items-center gap-3 px-4 py-1">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-4 max-w-[220px] flex-1" />
                <Skeleton className="hidden h-4 w-24 md:block" />
                <Skeleton className="hidden h-8 w-40 md:block" />
                <Skeleton className="hidden h-4 w-24 md:block" />
                <Skeleton className="ml-auto h-5 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
