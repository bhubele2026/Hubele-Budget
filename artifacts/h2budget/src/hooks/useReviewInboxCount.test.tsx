import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReviewInboxCount } from "./useReviewInboxCount";

// The counting logic (unmatched current-month bank txns, isBankTxn scoping,
// resolution exclusion) lives server-side in `lib/reviewCount.ts`, shared by
// GET /forecast/review-count and GET /spine — covered by
// api-server/src/__tests__/badgeCounts.integration.test.ts and pinned to agree
// by spineParity.integration.test.ts.
//
// The hook itself is now a thin read OFF THE SPINE rather than off its own
// endpoint. That is the contract these tests pin: the badge in the nav and the
// bell on the landing must be the same fetch, so they can never disagree.

const mockData: { current: { reviewCount: number } | undefined } = {
  current: undefined,
};
let spineCallCount = 0;
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => {
    spineCallCount++;
    return { data: mockData.current, isLoading: false };
  },
}));

describe("useReviewInboxCount (reads the shared spine)", () => {
  it("returns the count the spine carries", () => {
    mockData.current = { reviewCount: 3 };
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(3);
  });

  it("returns 0 while loading / when no data", () => {
    mockData.current = undefined;
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(0);
  });

  it("sources the badge from the spine, not a second request", () => {
    mockData.current = { reviewCount: 1 };
    spineCallCount = 0;
    renderHook(() => useReviewInboxCount());
    // The point of the change: one shared snapshot feeds the badge. If this
    // ever goes back to its own endpoint, the nav and the landing can drift.
    expect(spineCallCount).toBeGreaterThan(0);
  });
});
