import { describe, it, expect } from "vitest";
import { buildBalanceWindow } from "./amexBalanceWindow";
import { type MonthKey, monthKeyOf } from "@/components/account-page";

// (PR-I round 2, review LOW) The Amex balance window's weekly and today points
// add this month's charges on top of last month's end. A charge the bank removed
// is not one of them — the same skip as the month-end closure.

describe("buildBalanceWindow skips a charge the bank removed", () => {
  // Wed May 27, 2026; last month ended at $1,000.
  const now = new Date(2026, 4, 27, 14, 30, 0);
  const currentMonth: MonthKey = monthKeyOf(now);
  const window = (removed: boolean) =>
    buildBalanceWindow({
      anchorPresent: true,
      currentMonth,
      balanceAtEndOf: () => 1000,
      now,
      transactions: [
        { occurredOn: "2026-05-10", amount: "20.00" },
        { occurredOn: "2026-05-11", amount: "40.00", bankRemoved: removed },
      ],
    })!;
  const pointOn = (w: NonNullable<ReturnType<typeof window>>, month: number, day: number) =>
    w.series.find((p) => new Date(p.x).getMonth() === month && new Date(p.x).getDate() === day)!.balance;

  it("the Saturday and today points move only by the charges that count", () => {
    const skipped = window(true);
    expect(pointOn(skipped, 4, 16)).toBeCloseTo(1020, 2);
    expect(pointOn(skipped, 4, 27)).toBeCloseTo(1020, 2);
    // Not vacuous: counted, the same charge moves both points.
    const counted = window(false);
    expect(pointOn(counted, 4, 16)).toBeCloseTo(1060, 2);
    expect(pointOn(counted, 4, 27)).toBeCloseTo(1060, 2);
  });
});
