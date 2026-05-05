import { describe, it, expect } from "vitest";
import { pickCategoryDrillDownHref } from "./budget";

describe("pickCategoryDrillDownHref — Task #168 Amex-aware drill-down", () => {
  const month = "2026-04-01";

  it("routes to /transactions when no source breakdown is available", () => {
    expect(pickCategoryDrillDownHref("Groceries", month, null)).toBe(
      "/transactions?category=Groceries&month=2026-04-01",
    );
    expect(pickCategoryDrillDownHref("Groceries", month, undefined)).toBe(
      "/transactions?category=Groceries&month=2026-04-01",
    );
    expect(pickCategoryDrillDownHref("Groceries", month, [])).toBe(
      "/transactions?category=Groceries&month=2026-04-01",
    );
  });

  it("routes to /amex when Amex contributed more transactions than Bank", () => {
    expect(
      pickCategoryDrillDownHref("Dining", month, [
        { source: "Amex", count: 7, amount: "210.00" },
        { source: "Bank", count: 1, amount: "12.50" },
      ]),
    ).toBe("/amex?category=Dining&month=2026-04-01");
  });

  it("routes to /transactions when Bank contributed at least as many as Amex", () => {
    expect(
      pickCategoryDrillDownHref("Utilities", month, [
        { source: "Bank", count: 4, amount: "320.00" },
        { source: "Amex", count: 1, amount: "12.00" },
      ]),
    ).toBe("/transactions?category=Utilities&month=2026-04-01");
  });

  it("treats a tie as Bank-favored (keeps the legacy Transactions destination)", () => {
    expect(
      pickCategoryDrillDownHref("Misc", month, [
        { source: "Bank", count: 2, amount: "50.00" },
        { source: "Amex", count: 2, amount: "50.00" },
      ]),
    ).toBe("/transactions?category=Misc&month=2026-04-01");
  });

  it("routes to /amex for Amex-only lines (no Bank entry)", () => {
    expect(
      pickCategoryDrillDownHref("Streaming", month, [
        { source: "Amex", count: 3, amount: "45.00" },
      ]),
    ).toBe("/amex?category=Streaming&month=2026-04-01");
  });

  it("ignores `Other` source counts when picking the destination", () => {
    expect(
      pickCategoryDrillDownHref("Cash", month, [
        { source: "Other", count: 10, amount: "500.00" },
        { source: "Amex", count: 1, amount: "20.00" },
      ]),
    ).toBe("/amex?category=Cash&month=2026-04-01");
    expect(
      pickCategoryDrillDownHref("Cash", month, [
        { source: "Other", count: 10, amount: "500.00" },
      ]),
    ).toBe("/transactions?category=Cash&month=2026-04-01");
  });

  it("URL-encodes category names with spaces and special characters", () => {
    expect(
      pickCategoryDrillDownHref("Coffee & Tea", month, [
        { source: "Amex", count: 5, amount: "100.00" },
      ]),
    ).toBe("/amex?category=Coffee%20%26%20Tea&month=2026-04-01");
  });
});
