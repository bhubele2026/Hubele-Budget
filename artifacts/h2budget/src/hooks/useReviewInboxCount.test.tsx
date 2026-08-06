import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReviewInboxCount } from "./useReviewInboxCount";

// The counting logic (unmatched current-month bank txns, isBankTxn scoping,
// resolution exclusion) moved server-side to GET /forecast/review-count —
// covered by api-server/src/__tests__/badgeCounts.integration.test.ts. The
// hook is now a thin read; these tests pin its two remaining contracts:
// the passthrough shape and the deliberate query key that keeps the badge
// inside the '/api/forecast' invalidation prefix.

const captured: { queryKey?: unknown } = {};
const mockData: { current: { count: number } | undefined } = {
  current: undefined,
};
vi.mock("@workspace/api-client-react", () => ({
  useGetForecastReviewCount: (opts?: { query?: { queryKey?: unknown } }) => {
    captured.queryKey = opts?.query?.queryKey;
    return { data: mockData.current };
  },
}));

describe("useReviewInboxCount (server-count passthrough)", () => {
  it("returns the server count", () => {
    mockData.current = { count: 3 };
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(3);
  });

  it("returns 0 while loading / when no data", () => {
    mockData.current = undefined;
    const { result } = renderHook(() => useReviewInboxCount());
    expect(result.current).toBe(0);
  });

  it("keys the query under the '/api/forecast' prefix so existing forecast invalidations refresh the badge", () => {
    mockData.current = { count: 1 };
    renderHook(() => useReviewInboxCount());
    expect(captured.queryKey).toEqual(["/api/forecast", "review-count"]);
  });
});
