import { cn } from "@/lib/utils";
import { BUCKET_LABELS, BUCKET_LABEL_ORDER, BUCKET_MEANINGS } from "@/lib/bucketLabels";

/**
 * "W Weekly allowance · M Monthly allowance · U Unplanned allowance · R Someone pays it back" — what each mark
 * means, not only which word its letter stands for (2026-11-12: the owner could not tell them apart).
 */
export function BucketLegend({ className }: { className?: string }) {
  return (
    <p className={cn("text-micro text-neutral-500", className)} data-testid="bucket-legend">
      {/* Each "letter meaning" pair stays whole; the line may break at the separators (outside the pairs). */}
      {BUCKET_LABEL_ORDER.map((b, i) => (
        <span key={b}>
          {i > 0 ? " · " : ""}
          <span className="whitespace-nowrap">
            <span className="font-semibold text-neutral-600">{BUCKET_LABELS[b].short}</span> {BUCKET_MEANINGS[b]}
          </span>
        </span>
      ))}
    </p>
  );
}
