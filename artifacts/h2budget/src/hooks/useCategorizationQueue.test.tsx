import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getListCategorizationReviewQueryKey } from "@workspace/api-client-react";
import { useCategorizationQueueTotal } from "./useCategorizationQueue";

afterEach(() => vi.unstubAllGlobals());

describe("review badge (P4)", () => {
  it("asks the one-number count endpoint, under the queue's key so invalidations still hit it", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: RequestInfo | URL) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ total: 7 }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useCategorizationQueueTotal(), { wrapper });
    expect(result.current).toBeNull(); // unknown while loading, never 0
    await waitFor(() => expect(result.current).toBe(7));
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain("/api/categorization/review/count");
    expect(urls[0]).not.toContain("limit=");
    // An invalidation of the queue's key marks the badge stale.
    const key = qc.getQueryCache().getAll()[0]!.queryKey;
    expect(key.slice(0, 1)).toEqual(getListCategorizationReviewQueryKey());
    await qc.invalidateQueries({ queryKey: getListCategorizationReviewQueryKey() });
    await waitFor(() => expect(urls.length).toBe(2));
  });
});
