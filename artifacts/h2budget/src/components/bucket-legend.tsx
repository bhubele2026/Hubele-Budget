import { cn } from "@/lib/utils";
import { BUCKET_LABELS, BUCKET_LABEL_ORDER } from "@/lib/bucketLabels";

/** "W Weekly · M Monthly · U Unplanned · R Reimbursable" — what the one-letter marks mean. */
export function BucketLegend({ className }: { className?: string }) {
  return (
    <p className={cn("text-micro text-neutral-500", className)} data-testid="bucket-legend">
      {BUCKET_LABEL_ORDER.map((b, i) => (
        <span key={b}>
          {i > 0 ? " · " : ""}
          <span className="font-semibold text-neutral-600">{BUCKET_LABELS[b].short}</span> {BUCKET_LABELS[b].full}
        </span>
      ))}
    </p>
  );
}
