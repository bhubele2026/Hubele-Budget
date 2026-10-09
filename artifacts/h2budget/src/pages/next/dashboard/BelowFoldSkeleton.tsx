import { cn } from "@/lib/utils";
import { BELOW_FOLD, type BelowFoldKey } from "./belowFoldSizes";

const ROWS: Record<BelowFoldKey, number> = { forecast: 8, debt: 6, activity: 7, review: 4 };

/** Zero-number placeholders for the lazy panels, the same size as the panels. */
export function BelowFoldSkeleton() {
  return (
    <>
      {(Object.keys(BELOW_FOLD) as BelowFoldKey[]).map((k) => (
        <div
          key={k}
          data-testid={`below-fold-skeleton-${k}`}
          aria-busy="true"
          className={cn("panel p-4", `span-${BELOW_FOLD[k].span}`, BELOW_FOLD[k].minH)}
        >
          <div className="skeleton h-4 w-32 rounded" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: ROWS[k] }, (_, i) => (
              <div key={i} className="skeleton h-5 w-full rounded-control" />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
