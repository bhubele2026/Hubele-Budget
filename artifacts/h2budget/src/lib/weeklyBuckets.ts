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
 * A transaction's effective allowance bucket by **EXPLICIT SELECTION ONLY**.
 * The user marks each Chase/Amex expense weekly, monthly, or unplanned via the
 * bucket bubbles; an unmarked expense is `null` (unassigned) and counts in NONE
 * of the three totals. There is NO auto-default — blank means blank.
 *
 * Single source of truth shared by the Banking spending view (command-center),
 * the Allowances page, and the shared bucket-spend lib, so every surface agrees.
 * (This replaces the earlier "weekly is the default" behavior: unmarked expenses
 * used to fall into weekly, which double-counted uncategorized spend.)
 */
export function effectiveBucket(t: {
  weeklyAllowance?: boolean | null;
  monthlyAllowance?: boolean | null;
  unplannedAllowance?: boolean | null;
}): AllowanceBucket | null {
  if (t.unplannedAllowance) return "unplanned";
  if (t.monthlyAllowance) return "monthly";
  if (t.weeklyAllowance) return "weekly";
  return null;
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
