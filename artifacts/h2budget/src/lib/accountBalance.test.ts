import { describe, it, expect } from "vitest";
import { computeBalanceAtEndOf } from "./accountBalance";
import { monthKeyFromISO } from "@/components/account-page";

describe("computeBalanceAtEndOf (snapshot-anchored)", () => {
  const aprilSnapshotDate = "2026-04-30";
  const anchorBalance = 3565.09;
  const anchorMonth = monthKeyFromISO(aprilSnapshotDate);

  it("returns the anchor balance verbatim for the anchor month, ignoring later-month activity", () => {
    // Even with arbitrary May activity, asking for April should return the
    // snapshot value untouched. This is the regression: previously the page
    // anchored to today's month (May), so April was computed as
    // 3565.09 - netChange(May), which is wrong.
    const netChangeByMonth = new Map<string, number>([
      ["2026-4", -1234.56], // May (month index 4)
      ["2026-5", 9999], // June
    ]);
    const result = computeBalanceAtEndOf({
      anchorBalance,
      anchorMonth,
      netChangeByMonth,
      target: monthKeyFromISO("2026-04-15"),
    });
    expect(result).toBeCloseTo(3565.09, 2);
  });

  it("walks forward by adding net change for months after the anchor", () => {
    const netChangeByMonth = new Map<string, number>([
      ["2026-4", 100], // May
      ["2026-5", -50], // June
    ]);
    const may = computeBalanceAtEndOf({
      anchorBalance,
      anchorMonth,
      netChangeByMonth,
      target: monthKeyFromISO("2026-05-15"),
    });
    expect(may).toBeCloseTo(3565.09 + 100, 2);

    const june = computeBalanceAtEndOf({
      anchorBalance,
      anchorMonth,
      netChangeByMonth,
      target: monthKeyFromISO("2026-06-15"),
    });
    expect(june).toBeCloseTo(3565.09 + 100 - 50, 2);
  });

  it("walks backward by subtracting net change for months before the anchor", () => {
    const netChangeByMonth = new Map<string, number>([
      ["2026-3", -200], // April
      ["2026-2", 75], // March
    ]);
    const march = computeBalanceAtEndOf({
      anchorBalance,
      anchorMonth,
      netChangeByMonth,
      target: monthKeyFromISO("2026-03-15"),
    });
    // End of March = end of April − net(April) = 3565.09 − (−200) = 3765.09
    expect(march).toBeCloseTo(3565.09 - -200, 2);

    const february = computeBalanceAtEndOf({
      anchorBalance,
      anchorMonth,
      netChangeByMonth,
      target: monthKeyFromISO("2026-02-15"),
    });
    // End of Feb = end of March − net(March) = 3765.09 − 75 = 3690.09
    expect(february).toBeCloseTo(3565.09 - -200 - 75, 2);
  });
});
