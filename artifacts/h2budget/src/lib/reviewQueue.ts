import type { ReviewItem } from "@workspace/api-client-react";
import { addDaysISO } from "@workspace/avalanche-core/householdTime";
import { weekdayDate } from "@/lib/dates";

/**
 * ⭐ THE CATEGORIZATION QUEUE, IN WORDS (F1). Ported from the frozen h2 app's
 * `screens/activity/words.ts` and `data/activityData.ts` (never imported from
 * it). Display only: every figure here is one the server returned; the badge
 * only adds two server counts.
 *
 * Imports no generated hook, so the entry-resident layout can use it.
 */
export const REVIEW_LIMIT = 20;
export const reviewParams = { limit: REVIEW_LIMIT } as const;

/** The day heading over a group of charges: "Today", "Yesterday", else "Fri, Oct 9". */
export function dayHeader(iso: string, today: string): string {
  if (iso === today) return "Today";
  if (iso === addDaysISO(today, -1)) return "Yesterday";
  return weekdayDate(iso);
}

/**
 * Why H2 proposed this category, in one short line. The server's own
 * explanation is used only when it proposed nothing (a notice such as "the
 * bank removed this charge"); otherwise the source maps to plain words.
 */
export function reviewWhy(item: Pick<ReviewItem, "source" | "explanation" | "suggestedCategoryId">): string {
  if (!item.suggestedCategoryId) return item.explanation || "H2 needs a look at this one.";
  switch (item.source) {
    case "rule":
      return "Matches a rule";
    case "memory":
      return "Learned from a correction";
    case "recurring":
      return "Looks like a recurring bill";
    case "inherited":
      return "Same as a related charge";
    case "refund":
      return "Looks like a refund";
    default:
      return "H2's best guess";
  }
}

/** The flags, as words. */
export function reviewFlags(f: ReviewItem["flags"]): string[] {
  const out: string[] = [];
  if (f.novelMerchant) out.push("New merchant");
  if (f.amountAnomaly) out.push("Unusual amount");
  if (f.splitNeedsRebalance) out.push("Split needs rebalance");
  return out;
}

/** "Corner Market" from a merchant signature such as "corner market". */
export function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Oldest first; ties by when the decision was made. */
export function byOldest(a: ReviewItem, b: ReviewItem): number {
  return a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/**
 * ⭐ THE REVIEW BADGE — charges waiting on a person: the forecast review count
 * (the spine's) plus the categorization queue's own total. A source that has
 * not answered counts as nothing waiting HERE only because the badge hides at
 * zero; it never claims "all clear" from it.
 */
export function badgeCount(queueTotal: number | null | undefined, spineReviewCount: number | null | undefined): number {
  const n = (queueTotal ?? 0) + (spineReviewCount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** True when the browser event came from a field the person is typing in. */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** "Filed under Groceries. H2 will remember Corner Market." */
export function filedWords(categoryName: string, description: string): string {
  return `Filed under ${categoryName}. H2 will remember ${titleCase(description)}.`;
}
