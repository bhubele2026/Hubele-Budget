import { describe, it, expect } from "vitest";
import { dataState, hasData, type DataState } from "./queryState";

describe("dataState — the five honest states of a query", () => {
  const cases: Array<[string, Parameters<typeof dataState>[0], DataState]> = [
    ["first load in flight", { data: undefined, isFetching: true }, "cold"],
    ["not started", { data: undefined }, "cold"],
    ["first load failed", { data: undefined, isLoadingError: true }, "failed"],
    ["loaded, idle", { data: { a: 1 }, isFetching: false }, "loaded"],
    ["loaded, refetching", { data: { a: 1 }, isFetching: true }, "refreshing"],
    ["showing another key's data", { data: { a: 1 }, isPlaceholderData: true }, "refreshing"],
    ["a refetch failed, old data kept", { data: { a: 1 }, isRefetchError: true }, "refresh-failed"],
    [
      "a refetch failed and a retry is in flight",
      { data: { a: 1 }, isRefetchError: true, isFetching: true },
      "refresh-failed",
    ],
    ["a real null payload is data", { data: null }, "loaded"],
  ];

  for (const [name, query, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(dataState(query)).toBe(expected);
    });
  }
});

describe("hasData", () => {
  it("is true only when there are numbers to show", () => {
    expect(hasData("loaded")).toBe(true);
    expect(hasData("refreshing")).toBe(true);
    expect(hasData("refresh-failed")).toBe(true);
    expect(hasData("cold")).toBe(false);
    expect(hasData("failed")).toBe(false);
  });
});
