// (PR-E) The daily progress metrics, pure. Synthetic fixtures; every expected
// value is worked by hand in the comment beside it.

import { describe, it, expect } from "vitest";
import {
  METRICS_VERSION,
  POINT_IN_TIME_FIELDS,
  accountsSilentDaysOf,
  computeDailyMetrics,
  discretionaryCents,
  keepPointInTime,
  monthStartOf,
  type DailyMetricsInputs,
} from "@workspace/avalanche-core";

const snap = (asOf: string, o: Partial<DailyMetricsInputs["snapshotsMtd"][number]> = {}) => ({
  asOf,
  paymentsConfirmed: "0.00",
  interest: "0.00",
  fees: "0.00",
  newCharges: "0.00",
  transferPairTxnId: null,
  ...o,
});

const base: DailyMetricsInputs = {
  asOf: "2026-10-08",
  debts: [
    { balance: "1000.00", pendingPaymentTotal: "100.00" }, // 900.00 netted
    { balance: "250.50" },
    { balance: "40.00", pendingPaymentTotal: "75.00" }, // clamped at 0
  ],
  snapshotsMtd: [
    snap("2026-10-02", { paymentsConfirmed: "-300.00", interest: "12.34", newCharges: "20.00" }),
    snap("2026-10-05", { paymentsConfirmed: "-200.00", fees: "5.00", transferPairTxnId: "t-1" }),
    snap("2026-10-08", { paymentsConfirmed: "-50.25", interest: "0.66", newCharges: "10.10" }),
    snap("2026-09-30", { paymentsConfirmed: "-999.00", interest: "99.00" }), // last month: ignored
    snap("2026-10-09", { paymentsConfirmed: "-999.00" }), // after asOf: ignored
  ],
  milestonesReached: 3,
  position: { weekCap: "250.00", withinPlan: "tight" },
  weekRows: [
    { coverage: "allowance_weekly", spend: "60.10" },
    { coverage: "needs_classification", spend: "19.90" },
    { coverage: "unplanned", spend: "500.00" }, // beside the cap, not inside it
    { coverage: "allowance_monthly", spend: "7.00" },
    { coverage: "bill_matched", spend: "900.00" },
  ],
  monthRows: [
    { coverage: "allowance_weekly", spend: "300.00" },
    { coverage: "needs_classification", spend: "45.55" },
    { coverage: "unplanned", spend: "80.00" },
  ],
  uncategorizedCount: 4,
  reviewQueueSize: 7,
  freshness: { stale: true, staleReason: "old" },
  itemLastSyncedDays: ["2026-10-08", "2026-10-03", null],
};

describe("computeDailyMetrics", () => {
  it("sums every field by hand", () => {
    expect(computeDailyMetrics(base)).toEqual({
      totalDebtEffective: 1150.5, // 900 + 250.50 + 0
      debtPaidDownGenuineMtd: 350.25, // 300 + 50.25 (the transfer-marked 200 is out)
      interestChargedMtd: 18, // 12.34 + 5.00 + 0.66
      newChargesMtd: 30.1, // 20 + 10.10
      discretionaryWtd: 80, // 60.10 + 19.90
      discretionaryMtd: 345.55,
      weeklyCap: 250,
      withinPlan: "tight",
      confirmedPaymentsMtd: 550.25, // 300 + 200 + 50.25 (transfers included)
      milestonesReached: 3,
      uncategorizedCount: 4,
      reviewQueueSize: 7,
      dataCompleteness: { stale: true, staleReason: "old", accountsSilentDays: 5 },
    });
  });

  it("is deterministic and does not mutate its inputs", () => {
    const copy = JSON.parse(JSON.stringify(base));
    const a = computeDailyMetrics(base);
    const b = computeDailyMetrics(base);
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(base))).toEqual(copy);
  });

  it("sums in whole cents (no float drift)", () => {
    const m = computeDailyMetrics({
      ...base,
      snapshotsMtd: Array.from({ length: 10 }, (_, i) => snap(`2026-10-0${(i % 8) + 1}`, { interest: "0.10" })),
    });
    expect(m.interestChargedMtd).toBe(1);
  });

  it("an empty household reads zeros for flows and null for what it cannot know", () => {
    const m = computeDailyMetrics({
      ...base,
      debts: null,
      snapshotsMtd: [],
      milestonesReached: 0,
      position: null,
      weekRows: null,
      monthRows: null,
      uncategorizedCount: null,
      reviewQueueSize: null,
      freshness: null,
      itemLastSyncedDays: null,
    });
    expect(m).toEqual({
      totalDebtEffective: null, // never a false zero
      debtPaidDownGenuineMtd: 0,
      interestChargedMtd: 0,
      newChargesMtd: 0,
      discretionaryWtd: null,
      discretionaryMtd: null,
      weeklyCap: null,
      withinPlan: null,
      confirmedPaymentsMtd: 0,
      milestonesReached: 0,
      uncategorizedCount: null,
      reviewQueueSize: null,
      dataCompleteness: { stale: null, staleReason: null, accountsSilentDays: null },
    });
  });

  it("a $0 debt list totals 0, not null; no cap is null, not 0", () => {
    const m = computeDailyMetrics({ ...base, debts: [{ balance: 0 }], position: { weekCap: null, withinPlan: null } });
    expect(m.totalDebtEffective).toBe(0);
    expect(m.weeklyCap).toBeNull();
    expect(m.withinPlan).toBeNull();
  });

  it("the month window is the month of asOf", () => {
    expect(monthStartOf("2026-10-31")).toBe("2026-10-01");
    const m = computeDailyMetrics({ ...base, asOf: "2026-09-30" });
    expect(m.confirmedPaymentsMtd).toBe(999); // only the 09-30 row
    expect(m.interestChargedMtd).toBe(99);
  });

  it("discretionary follows the position's rule: weekly allowance + not-yet-filed", () => {
    expect(
      discretionaryCents([
        { coverage: "allowance_weekly", spend: 1.1 },
        { coverage: "needs_classification", spend: 2.2 },
        { coverage: "unplanned", spend: 9 },
        { coverage: "excluded", spend: 9 },
      ]),
    ).toBe(330);
  });

  it("accountsSilentDays is the longest gap, never negative, null with nothing to judge", () => {
    expect(accountsSilentDaysOf("2026-10-08", ["2026-10-08", "2026-10-01"])).toBe(7);
    expect(accountsSilentDaysOf("2026-10-08", ["2026-10-09"])).toBe(0);
    expect(accountsSilentDaysOf("2026-10-08", [null])).toBeNull();
    expect(accountsSilentDaysOf("2026-10-08", [])).toBeNull();
    expect(accountsSilentDaysOf("2026-03-10", ["2026-02-27"])).toBe(11);
  });

  it("the definition version is a positive integer", () => {
    expect(Number.isInteger(METRICS_VERSION) && METRICS_VERSION >= 1).toBe(true);
  });
});

describe("keepPointInTime", () => {
  const fresh = computeDailyMetrics({
    ...base,
    position: null,
    weekRows: null,
    monthRows: null,
    uncategorizedCount: null,
    reviewQueueSize: null,
    freshness: null,
    itemLastSyncedDays: null,
  });
  const stored = computeDailyMetrics(base);

  it("takes the point-in-time fields from the stored row and the flows from the fresh one", () => {
    const merged = keepPointInTime({ ...fresh, confirmedPaymentsMtd: 1, debtPaidDownGenuineMtd: 2 }, stored);
    for (const k of POINT_IN_TIME_FIELDS) expect(merged[k]).toEqual(stored[k]);
    expect(merged.confirmedPaymentsMtd).toBe(1);
    expect(merged.debtPaidDownGenuineMtd).toBe(2);
  });

  it("with no stored row the past is not filled from anywhere", () => {
    expect(keepPointInTime(fresh, null)).toEqual(fresh);
    expect(keepPointInTime(fresh, null).discretionaryWtd).toBeNull();
  });
});
