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

  it("reconstructs end-of-anchor-month from a mid-month snapshot", () => {
    // Snapshot taken Apr 15 showing $1000. After Apr 15: +$200 income, -$50
    // expense in April. Pre-Apr-15 activity is irrelevant — the snapshot
    // already accounts for it. End of April = 1000 + 200 - 50 = 1150.
    const aprMid = "2026-04-15T12:00:00Z";
    const anchorMonthApr = monthKeyFromISO(aprMid);
    const anchorMonthTxns = [
      { occurredOn: "2026-04-10", amount: -75 }, // pre-anchor: ignored
      { occurredOn: "2026-04-15", amount: -25 }, // same day: ignored
      { occurredOn: "2026-04-20", amount: 200 }, // post-anchor: counted
      { occurredOn: "2026-04-28", amount: -50 }, // post-anchor: counted
    ];
    const result = computeBalanceAtEndOf({
      anchorBalance: 1000,
      anchorMonth: anchorMonthApr,
      netChangeByMonth: new Map(),
      target: monthKeyFromISO("2026-04-30"),
      anchorAt: aprMid,
      anchorMonthTxns,
    });
    expect(result).toBeCloseTo(1150, 2);
  });

  it("rolls a mid-month-anchored balance backward to a prior month", () => {
    // Apr 15 / $1000 snapshot. April activity: pre=-75-25, post=+200-50 →
    // April net = +50. End-of-April = 1000 + 200 - 50 = 1150.
    // To get end-of-March, subtract April's full net change: 1150 - 50 = 1100.
    const aprMid = "2026-04-15T12:00:00Z";
    const anchorMonthApr = monthKeyFromISO(aprMid);
    const anchorMonthTxns = [
      { occurredOn: "2026-04-10", amount: -75 },
      { occurredOn: "2026-04-15", amount: -25 },
      { occurredOn: "2026-04-20", amount: 200 },
      { occurredOn: "2026-04-28", amount: -50 },
    ];
    const netChangeByMonth = new Map<string, number>([
      ["2026-3", 50], // April full-month net (sum of all 4 txns above)
    ]);
    const result = computeBalanceAtEndOf({
      anchorBalance: 1000,
      anchorMonth: anchorMonthApr,
      netChangeByMonth,
      target: monthKeyFromISO("2026-03-15"),
      anchorAt: aprMid,
      anchorMonthTxns,
    });
    expect(result).toBeCloseTo(1100, 2);
  });

  it("treats an anchorAt exactly at month-end as having zero post-anchor activity", () => {
    // Anchor at end-of-day Apr 30; only April 28 txns exist (pre-anchor).
    // End-of-April should equal the snapshot, with the txn ignored.
    const aprEnd = "2026-04-30T23:59:59Z";
    const result = computeBalanceAtEndOf({
      anchorBalance: 500,
      anchorMonth: monthKeyFromISO(aprEnd),
      netChangeByMonth: new Map(),
      target: monthKeyFromISO("2026-04-15"),
      anchorAt: aprEnd,
      anchorMonthTxns: [{ occurredOn: "2026-04-28", amount: -123.45 }],
    });
    expect(result).toBeCloseTo(500, 2);
  });

  it("rolls a mid-month-anchored balance forward to a later month", () => {
    // Apr 15 / $1000 snapshot, post-anchor April activity = +150.
    // End-of-April = 1150. May net = -300. End-of-May = 850.
    const aprMid = "2026-04-15T12:00:00Z";
    const result = computeBalanceAtEndOf({
      anchorBalance: 1000,
      anchorMonth: monthKeyFromISO(aprMid),
      netChangeByMonth: new Map([["2026-4", -300]]),
      target: monthKeyFromISO("2026-05-15"),
      anchorAt: aprMid,
      anchorMonthTxns: [
        { occurredOn: "2026-04-20", amount: 200 },
        { occurredOn: "2026-04-28", amount: -50 },
      ],
    });
    expect(result).toBeCloseTo(850, 2);
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
