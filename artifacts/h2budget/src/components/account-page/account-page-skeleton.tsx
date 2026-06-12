import { Skeleton } from "@/components/ui/skeleton";

/**
 * Premium loading state for the Chase / Amex account pages — a skeleton that
 * mirrors the real page shape (header → stat tiles → chart → rows) so the
 * page shimmers into its final layout instead of flashing blank or snapping
 * generic gray blocks.
 */
export function AccountPageSkeleton({ tiles = 5 }: { tiles?: number }) {
  return (
    <div className="space-y-6">
      {/* Header: title + actions */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <Skeleton className="h-8 w-48" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-36" />
        </div>
      </div>

      {/* Period nav */}
      <Skeleton className="h-9 w-32" />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Array.from({ length: tiles }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border bg-card px-4 py-3.5 space-y-2.5"
          >
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-7 w-28" />
          </div>
        ))}
      </div>

      {/* Chart */}
      <Skeleton className="h-[160px] w-full rounded-lg" />

      {/* Transaction rows */}
      <div className="rounded-lg border bg-card divide-y divide-border overflow-hidden">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 flex-1 max-w-[220px]" />
            <Skeleton className="hidden md:block h-4 w-24" />
            <Skeleton className="hidden md:block h-8 w-40" />
            <Skeleton className="hidden md:block h-4 w-24" />
            <Skeleton className="h-5 w-20 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
