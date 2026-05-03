import type { Transaction } from "@workspace/api-client-react";

export type DaysSinceTracker = {
  id: string;
  label: string;
  matchType: "category" | "keyword";
  matchValue: string;
};

export const DEFAULT_DAYS_SINCE_TRACKERS: DaysSinceTracker[] = [
  { id: "default-dining", label: "Dining out", matchType: "keyword", matchValue: "dining" },
  { id: "default-amazon", label: "Amazon", matchType: "keyword", matchValue: "amazon" },
  {
    id: "default-coffee",
    label: "Coffee shop",
    matchType: "keyword",
    matchValue: "starbucks|coffee|cafe|dunkin",
  },
];

export function makeMatcher(
  tracker: DaysSinceTracker,
  catNameById: Map<string, string>,
): (t: Transaction) => boolean {
  const value = tracker.matchValue.trim().toLowerCase();
  if (!value) return () => false;
  if (tracker.matchType === "category") {
    return (t: Transaction) => {
      if (Number(t.amount) >= 0) return false;
      const cat = (t.categoryId ? catNameById.get(t.categoryId) ?? "" : "").toLowerCase();
      return cat.includes(value);
    };
  }
  let re: RegExp | null = null;
  try {
    re = new RegExp(value, "i");
  } catch {
    re = null;
  }
  return (t: Transaction) => {
    if (Number(t.amount) >= 0) return false;
    const desc = (t.description ?? "").toLowerCase();
    const cat = (t.categoryId ? catNameById.get(t.categoryId) ?? "" : "").toLowerCase();
    if (re) return re.test(desc) || re.test(cat);
    return desc.includes(value) || cat.includes(value);
  };
}

export function newTrackerId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
