import { describe, expect, it } from "vitest";
import type { ReviewItem } from "@workspace/api-client-react";
import { badgeCount, byOldest, dayHeader, filedWords, reviewFlags, reviewWhy, titleCase } from "./reviewQueue";

const base = { source: "memory", explanation: "x", suggestedCategoryId: "c1" };
const flags = (o: Partial<ReviewItem["flags"]> = {}) => ({ novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false, ...o });

describe("reviewWhy", () => {
  it("maps each source to plain words", () => {
    expect(reviewWhy({ ...base, source: "rule" })).toBe("Matches a rule");
    expect(reviewWhy({ ...base, source: "memory" })).toBe("Learned from a correction");
    expect(reviewWhy({ ...base, source: "recurring" })).toBe("Looks like a recurring bill");
    expect(reviewWhy({ ...base, source: "inherited" })).toBe("Same as a related charge");
    expect(reviewWhy({ ...base, source: "refund" })).toBe("Looks like a refund");
    expect(reviewWhy({ ...base, source: "model" })).toBe("H2's best guess");
  });
  it("uses the server's explanation only when nothing was proposed", () => {
    expect(reviewWhy({ source: "rule", explanation: "The bank removed this charge.", suggestedCategoryId: null })).toBe("The bank removed this charge.");
    expect(reviewWhy({ source: "rule", explanation: "", suggestedCategoryId: null })).toBe("H2 needs a look at this one.");
  });
});

describe("reviewFlags", () => {
  it("names each flag", () => {
    expect(reviewFlags(flags())).toEqual([]);
    expect(reviewFlags(flags({ novelMerchant: true, amountAnomaly: true, splitNeedsRebalance: true }))).toEqual([
      "New merchant",
      "Unusual amount",
      "Split needs rebalance",
    ]);
  });
});

describe("dayHeader", () => {
  it("says Today, Yesterday, else the weekday and date", () => {
    expect(dayHeader("2026-10-07", "2026-10-07")).toBe("Today");
    expect(dayHeader("2026-10-06", "2026-10-07")).toBe("Yesterday");
    expect(dayHeader("2026-10-02", "2026-10-07")).toBe("Fri, Oct 2");
  });
});

describe("badgeCount", () => {
  it("adds the queue total and the forecast review count", () => {
    expect(badgeCount(4, 3)).toBe(7);
    expect(badgeCount(null, 3)).toBe(3);
    expect(badgeCount(undefined, undefined)).toBe(0);
    expect(badgeCount(0, 0)).toBe(0);
    expect(badgeCount(Number.NaN, 2)).toBe(0);
  });
});

describe("titleCase / filedWords / byOldest", () => {
  it("title-cases a merchant signature", () => {
    expect(titleCase("corner market")).toBe("Corner Market");
    expect(filedWords("Groceries", "corner market")).toBe("Filed under Groceries. H2 will remember Corner Market.");
  });
  it("sorts oldest first, ties by creation time", () => {
    const mk = (occurredOn: string, createdAt: string) => ({ occurredOn, createdAt }) as ReviewItem;
    const sorted = [mk("2026-10-03", "b"), mk("2026-10-01", "z"), mk("2026-10-01", "a")].sort(byOldest);
    expect(sorted.map((i) => i.createdAt)).toEqual(["a", "z", "b"]);
  });
});
