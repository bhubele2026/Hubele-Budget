import { cn } from "@/lib/utils";
import { BELOW_FOLD, slotKeys, type BelowFoldKey, type BelowFoldSlot } from "./belowFoldSizes";

const ROWS: Record<BelowFoldKey, number> = { forecast: 9, upcoming: 6, spending: 5, debt: 5, attention: 5, activity: 6 };

/** Zero-number placeholders for one lazy slot, each the size of its panel. */
export function BelowFoldSkeleton({ slot }: { slot: BelowFoldSlot }) {
  return (
    <>
      {slotKeys(slot).map((k) => (
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
