import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// The spine query result, as TanStack Query would hand it to the hook.
const query = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@workspace/api-client-react", () => ({
  useGetSpine: () => query.current,
  getGetSpineQueryKey: () => ["/api/spine"],
}));

import { useSpine } from "./useSpine";

const SPINE = { reviewCount: 3, bank: { balance: "1000.00" } };
const FETCHED_AT = Date.parse("2026-09-11T17:00:00.000Z");

beforeEach(() => {
  query.current = {};
});

describe("useSpine — says when the numbers cannot be trusted", () => {
  it("is cold while the first load is in flight: no data and no time", () => {
    query.current = { data: undefined, isLoading: true, isFetching: true, dataUpdatedAt: 0 };
    const { result } = renderHook(() => useSpine());
    expect(result.current.state).toBe("cold");
    expect(result.current.data).toBeUndefined();
    expect(result.current.updatedAt).toBeNull();
  });

  it("is failed when the first load failed", () => {
    const error = new Error("offline");
    query.current = { data: undefined, isLoadingError: true, error, dataUpdatedAt: 0 };
    const { result } = renderHook(() => useSpine());
    expect(result.current.state).toBe("failed");
    expect(result.current.error).toBe(error);
  });

  it("is loaded with the time the data was fetched", () => {
    query.current = { data: SPINE, isFetching: false, dataUpdatedAt: FETCHED_AT };
    const { result } = renderHook(() => useSpine());
    expect(result.current.state).toBe("loaded");
    expect(result.current.updatedAt).toBe("2026-09-11T17:00:00.000Z");
  });

  it("keeps the last good data when a refresh fails", () => {
    const error = new Error("502");
    query.current = {
      data: SPINE,
      isRefetchError: true,
      error,
      dataUpdatedAt: FETCHED_AT,
    };
    const { result } = renderHook(() => useSpine());
    expect(result.current.state).toBe("refresh-failed");
    expect(result.current.data).toBe(SPINE);
    expect(result.current.updatedAt).toBe("2026-09-11T17:00:00.000Z");
  });

  it("retries through the query", () => {
    const refetch = vi.fn(async () => undefined);
    query.current = { data: SPINE, isRefetchError: true, refetch, dataUpdatedAt: FETCHED_AT };
    const { result } = renderHook(() => useSpine());
    result.current.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
