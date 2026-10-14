export type BucketLabelKey = "weekly" | "monthly" | "unplanned" | "reimbursable";

/**
 * (W7) The bucket marks' words. The short form is ONE LETTER (a phone, and a
 * ledger wide enough to be a fixed-column grid); the legend above each ledger
 * names the letters. A plain module: page tests mock `bucket-bubbles.tsx` with
 * a fixed export list.
 */
export const BUCKET_LABELS: Record<BucketLabelKey, { short: string; full: string }> = {
  weekly: { short: "W", full: "Weekly" },
  monthly: { short: "M", full: "Monthly" },
  unplanned: { short: "U", full: "Unplanned" },
  reimbursable: { short: "R", full: "Reimbursable" },
};

export const BUCKET_LABEL_ORDER: BucketLabelKey[] = ["weekly", "monthly", "unplanned", "reimbursable"];
