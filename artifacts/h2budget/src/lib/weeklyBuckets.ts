import { useGetSettings, type Settings } from "@workspace/api-client-react";

export const SUB_BUCKETS = [
  "groceries",
  "dining",
  "alcohol",
  "entertainment",
  "misc",
] as const;
export type SubBucket = (typeof SUB_BUCKETS)[number];

export type AllowanceBucket = "weekly" | "monthly" | "unplanned";

/**
 * A transaction's effective allowance bucket. **Weekly is the default**: an item
 * counts as weekly unless it's been explicitly moved to Monthly or Unplanned.
 * Single source of truth shared by the Banking spending view (command-center)
 * and the Allowances page, so the two always agree.
 */
export function effectiveBucket(t: {
  weeklyAllowance?: boolean | null;
  monthlyAllowance?: boolean | null;
  unplannedAllowance?: boolean | null;
}): AllowanceBucket {
  if (t.unplannedAllowance) return "unplanned";
  if (t.monthlyAllowance) return "monthly";
  return "weekly";
}

export const DEFAULT_WEEKLY_BUCKET_LABELS: Record<SubBucket, string> = {
  groceries: "Groceries",
  dining: "Dining",
  alcohol: "Alcohol",
  entertainment: "Entertainment",
  misc: "Misc",
};

export function resolveWeeklyBucketLabels(
  settings?: Pick<Settings, "preferences"> | null,
): Record<SubBucket, string> {
  const overrides = settings?.preferences?.weeklyBucketLabels ?? {};
  const out = { ...DEFAULT_WEEKLY_BUCKET_LABELS };
  for (const k of SUB_BUCKETS) {
    const v = overrides[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

export function useWeeklyBucketLabels(): Record<SubBucket, string> {
  const { data } = useGetSettings();
  return resolveWeeklyBucketLabels(data);
}
