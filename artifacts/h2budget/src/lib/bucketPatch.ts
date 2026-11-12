import type { BucketLabelKey } from "@/lib/bucketLabels";

/**
 * The PATCH a bucket mark writes on a transaction (the Chase register and the
 * in-place row drawer send the same body). Reimbursable is its own flag and
 * leaves the spend bucket alone; Weekly / Monthly / Unplanned are mutually
 * exclusive: marking one clears the others, so a charge lives in exactly one
 * bucket (or none).
 */
export function bucketPatchOf(
  tx: { weeklyBucket?: string | null },
  bucket: BucketLabelKey,
  next: boolean,
): Record<string, boolean | string | null> {
  if (bucket === "reimbursable") return { reimbursable: next };
  return {
    weeklyAllowance: bucket === "weekly" ? next : false,
    monthlyAllowance: bucket === "monthly" ? next : false,
    unplannedAllowance: bucket === "unplanned" ? next : false,
    weeklyBucket: bucket === "weekly" && next ? (tx.weeklyBucket ?? "misc") : null,
  };
}
