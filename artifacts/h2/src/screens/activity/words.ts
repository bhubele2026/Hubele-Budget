import type { ReviewItem } from "@workspace/api-client-react";
import { addDaysISO } from "@workspace/avalanche-core/householdTime";
import { weekdayDate } from "@/lib/dates";

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

export function isStatus(e: unknown, status: number): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === status;
}

/** "Corner Market" from a merchant signature such as "corner market". */
export function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
