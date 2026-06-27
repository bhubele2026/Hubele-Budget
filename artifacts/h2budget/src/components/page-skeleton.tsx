import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared loading skeleton for routed pages. Use INSTEAD of `return null` while
 * data loads so a route can never paint a blank white screen inside the shell.
 */
export function PageSkeleton() {
  return (
    <div className="space-y-4" data-testid="page-skeleton">
      <Skeleton className="h-7 w-44" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}
