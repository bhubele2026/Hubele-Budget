import { useGetSettings, type Settings } from "@workspace/api-client-react";

export const SUB_BUCKETS = ["groceries", "dining", "entertainment", "misc"] as const;
export type SubBucket = (typeof SUB_BUCKETS)[number];

export const DEFAULT_WEEKLY_BUCKET_LABELS: Record<SubBucket, string> = {
  groceries: "Groceries",
  dining: "Dining",
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
