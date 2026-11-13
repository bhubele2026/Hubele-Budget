import { cn } from "@/lib/utils";
import { BUCKET_LABELS, BUCKET_LABEL_ORDER, BUCKET_MEANINGS } from "@/lib/bucketLabels";
import { Help } from "@/ui";

/** "W Weekly allowance · M Monthly allowance · U Unplanned allowance · R Someone pays it back". */
export const BUCKET_LEGEND = BUCKET_LABEL_ORDER.map((b) => `${BUCKET_LABELS[b].short} ${BUCKET_MEANINGS[b]}`).join(" · ");

/**
 * What each bucket mark means (2026-11-12: the owner could not tell them apart) — one hover away, not a line on the
 * page (owner, 2026-11-12: "remove so many words … we know what shit is"). The word "Buckets" and a "?".
 */
export function BucketLegend({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-micro text-neutral-500", className)} data-testid="bucket-legend">
      Buckets <Help>{BUCKET_LEGEND}</Help>
    </span>
  );
}
