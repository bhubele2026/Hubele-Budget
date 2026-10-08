// (V5) A week the household chose to start lower, and a way back when the week
// is over — the pure rules, one test per rule. No database: synthetic curves,
// weeks and rows. Every figure is worked by hand in the test that pins it.
//
// The fixture week (the brief's): cap $300, spent $340 → over by $40 → the
// household carries −$40 into next week.

import { describe, it, expect } from "vitest";
import {
  addDaysISO,
  computePosition,
  computeWaysBack,
  medianCents,
  POSITION_ASSUMPTIONS,
  type MovementCoverage,
  type PositionInputs,
  type WaysBackInputs,
  type WaysBackRow,
} from "@workspace/avalanche-core";

const WEEK1 = "2026-10-07"; // Wed; week Sun 10/4 – Sat 10/10
const WEEK2 = "2026-10-14"; // Wed; week Sun 10/11 – Sat 10/17

function inputs(todayISO: string, over: Partial<PositionInputs> = {}): PositionInputs {
  // 2,000 → 1,900 → payday +2,000 on day 3: the window's low is 1,900 (payday read before its paycheck).
  const daily = [2000, 1900, 3900, 3800, 3700, 3600, 3500, 3400].map((b, i) => ({
    date: addDaysISO(todayISO, i),
    balance: b.toFixed(2),
  }));
  return {
    todayISO,
    daily,
    events: [
      { date: addDaysISO(todayISO, 1), amount: -100, kind: "expense", itemId: "bill", label: "Bill" },
      { date: addDaysISO(todayISO, 2), amount: 2000, kind: "income", itemId: "pay", label: "Paycheck" },
    ],
    incomeItems: [{ id: "pay", amount: "2000", frequency: "biweekly", active: true }],
    cashBuffer: "500",
    reservesHeld: 0,
    weekCap: "300",
    weekRows: [],
    freshness: { stale: false, staleReason: null, asOfBank: `${todayISO}T13:00:00.000Z` },
    status: "ready",
    ...over,
  };
}
const spent = (dollars: number, coverage: MovementCoverage = "allowance_weekly") => [{ coverage, spend: dollars }];

describe("the money position with a week adjustment (V5)", () => {
  it("week 1 — cap 300, spent 340: over by 40.00, nothing safe to spend, no adjustment", () => {
    const p = computePosition(inputs(WEEK1, { weekRows: spent(340) }));
    expect(p.weekCap).toBe("300.00");
    expect(p.remainingWeek).toBe("-40.00");
    expect(p.withinPlan).toBe("over");
    expect(p.safeToSpendNow).toBe("0.00");
    expect(p.weekAdjustment).toBeNull();
  });

  it("week 2 — the −40.00 carried in: remaining = 300 − 40 − 100 = 160.00, to the cent", () => {
    const p = computePosition(
      inputs(WEEK2, { weekRows: spent(100), weekAdjustmentCents: -4000, weekAdjustmentReason: "Over by $40" }),
    );
    expect(p.weekStart).toBe("2026-10-11");
    expect(p.weekCap).toBe("300.00"); // the cap the household set — not moved
    expect(p.weekAdjustment).toEqual({ amount: "-40.00", reason: "Over by $40", weekStart: "2026-10-11" });
    expect(p.remainingWeek).toBe("160.00");
    // available = 1,900 − 500 = 1,400 → safe = min(160, 1,400)
    expect(p.availableUntilPayday).toBe("1400.00");
    expect(p.safeToSpendNow).toBe("160.00");
    // tight: 160 × 7 = 1,120 < 300 × 4 days left = 1,200 (the pace stays on the cap)
    expect(p.withinPlan).toBe("tight");
    expect(p.paceAllowedToday).toBe("171.43");
    expect(p.assumptions).toContain("This week starts $40.00 lower (you chose this)");
    expect(p.assumptions.at(-1)).toBe(POSITION_ASSUMPTIONS.thisWeekLower("40.00"));
  });

  it("the adjusted week's boundary: exactly at zero is not over; one cent past it is", () => {
    const at = computePosition(inputs(WEEK2, { weekRows: spent(260), weekAdjustmentCents: -4000 }));
    expect(at.remainingWeek).toBe("0.00");
    expect(at.withinPlan).toBe("tight");
    const past = computePosition(inputs(WEEK2, { weekRows: spent(260.01), weekAdjustmentCents: -4000 }));
    expect(past.remainingWeek).toBe("-0.01");
    expect(past.withinPlan).toBe("over");
    expect(past.safeToSpendNow).toBe("0.00");
  });

  it("next week's adjustment is said in the assumptions and moves no figure this week", () => {
    const without = computePosition(inputs(WEEK1, { weekRows: spent(340) }));
    const withNext = computePosition(inputs(WEEK1, { weekRows: spent(340), nextWeekAdjustmentCents: -4000 }));
    expect(withNext.assumptions).toEqual([...without.assumptions, "Next week starts $40.00 lower (you chose this)"]);
    const { assumptions: _a, ...a } = without;
    const { assumptions: _b, ...b } = withNext;
    expect(b).toEqual(a);
  });

  it("with no cap there is nothing to lower: remaining stays null, the row is still reported, nothing is said", () => {
    const p = computePosition(inputs(WEEK2, { weekCap: null, weekAdjustmentCents: -4000, nextWeekAdjustmentCents: -100 }));
    expect(p.remainingWeek).toBeNull();
    expect(p.safeToSpendNow).toBe("1400.00");
    expect(p.weekAdjustment).toEqual({ amount: "-40.00", reason: null, weekStart: "2026-10-11" });
    expect(p.assumptions.some((s) => /starts \$/.test(s))).toBe(false);
  });

  it("a positive adjustment throws — an adjustment can only LOWER a week (and so does a fractional cent)", () => {
    expect(() => computePosition(inputs(WEEK2, { weekAdjustmentCents: 1 }))).toThrow(RangeError);
    expect(() => computePosition(inputs(WEEK2, { weekAdjustmentCents: 4000 }))).toThrow(/must not be positive/);
    expect(() => computePosition(inputs(WEEK2, { weekAdjustmentCents: -0.5 }))).toThrow(/whole cents/);
    expect(() => computePosition(inputs(WEEK2, { nextWeekAdjustmentCents: 100 }))).toThrow(RangeError);
  });

  it("no adjustment (absent, null or 0) → the parent's figures exactly, on 1,000 seeded weeks", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 1000; i++) {
      const today = addDaysISO("2026-06-07", Math.floor(rnd() * 120));
      const cap = rnd() < 0.15 ? null : (Math.floor(rnd() * 60000) / 100).toFixed(2);
      const kinds: MovementCoverage[] = ["allowance_weekly", "needs_classification", "unplanned", "allowance_monthly", "bill_matched"];
      const weekRows = Array.from({ length: Math.floor(rnd() * 6) }, () => ({
        coverage: kinds[Math.floor(rnd() * kinds.length)]!,
        spend: Math.floor(rnd() * 25000) / 100,
      }));
      const base = inputs(today, { weekCap: cap, weekRows });
      const absent = computePosition(base);
      expect(computePosition({ ...base, weekAdjustmentCents: null, nextWeekAdjustmentCents: null })).toEqual(absent);
      expect(computePosition({ ...base, weekAdjustmentCents: 0, nextWeekAdjustmentCents: 0 })).toEqual(absent);
      expect(absent.weekAdjustment).toBeNull();
      // The parent's own rules (PR-B1), re-derived independently.
      if (cap == null) {
        expect(absent.remainingWeek).toBeNull();
        expect(absent.withinPlan).toBeNull();
        continue;
      }
      const capC = Math.round(Number(cap) * 100);
      const counted = weekRows
        .filter((r) => r.coverage === "allowance_weekly" || r.coverage === "needs_classification")
        .reduce((s, r) => s + Math.round(r.spend * 100), 0);
      const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
      const rem = capC - counted;
      expect(absent.remainingWeek).toBe((rem / 100).toFixed(2));
      expect(absent.withinPlan).toBe(counted > capC ? "over" : rem * 7 < capC * (7 - dow) ? "tight" : "yes");
      expect(absent.safeToSpendNow).toBe((Math.max(0, Math.min(rem, 140000)) / 100).toFixed(2));
    }
  });
});

// ── Ways back ───────────────────────────────────────────────────────────────

const r = (date: string, categoryId: string | null, cents: number, coverage: MovementCoverage = "allowance_weekly"): WaysBackRow => ({
  date,
  categoryId,
  coverage,
  spendCents: cents,
});
const NAMES = new Map([
  ["dining", "Dining"],
  ["groceries", "Groceries"],
  ["fun", "Fun"],
  ["gas", "Gas"],
  ["hardware", "Hardware"],
  ["clothes", "Clothes"],
]);
function wb(over: Partial<WaysBackInputs> & { remainingWeek?: string | null; availableUntilPayday?: string | null; todayISO?: string } = {}) {
  const { remainingWeek = "-40.00", availableUntilPayday = "1400.00", todayISO = WEEK1, ...rest } = over;
  return computeWaysBack({
    position: { todayISO, weekStart: "2026-10-04", weekEnd: "2026-10-10", remainingWeek, availableUntilPayday },
    rows: [],
    categoryNames: NAMES,
    nextWeek: { capCents: 30000, adjustment: null },
    ...rest,
  });
}

// Dining's 8 weeks before 10/4, by week (Sunday): 9/27 100.01 (on Sat 10/3) · 9/20 none ·
// 9/13 120.00 · 9/6 80.00 · 8/30 none · 8/23 90.01 · 8/16 110.00 · 8/9 70.00.
// Sorted [0, 0, 70.00, 80.00, 90.01, 100.01, 110.00, 120.00] → median floor((8,000 + 9,001) / 2) = 8,500.
const DINING_HISTORY = [
  r("2026-10-03", "dining", 10001),
  r("2026-09-15", "dining", 12000),
  r("2026-09-08", "dining", 8000),
  r("2026-08-25", "dining", 9001),
  r("2026-08-18", "dining", 11000),
  r("2026-08-11", "dining", 7000),
  r("2026-08-02", "dining", 99999), // 9 weeks back: outside the 8
];
const THIS_WEEK = [
  r("2026-10-05", "dining", 15000),
  r("2026-10-06", "dining", 3000),
  r("2026-10-06", "groceries", 12000, "needs_classification"),
  r("2026-10-07", "fun", 4000),
  r("2026-10-07", "gas", 4000),
  r("2026-10-06", "hardware", 50000, "unplanned"), // beside the cap: never a trim
  r("2026-10-07", "clothes", 30000, "allowance_monthly"), // beside the cap: never a trim
  r("2026-10-06", null, 20000, "needs_classification"), // no category: nothing to name
];

describe("computeWaysBack (V5)", () => {
  it("the fixture week: over by 4,000 cents, 4 days left, nothing left to hold per day, next week 26,000", () => {
    const w = wb({ rows: [...THIS_WEEK, ...DINING_HISTORY, r("2026-09-29", "groceries", 5000), r("2026-08-12", "groceries", 6000)] });
    expect(w).toEqual({
      weekStart: "2026-10-04",
      weekEnd: "2026-10-10",
      overBy: 4000,
      daysLeft: 4,
      hold: { perDay: 0, leavesUntilPayday: 140000 },
      trims: [
        { categoryId: "dining", name: "Dining", spentWeek: 18000, usualWeek: 8500 },
        // Groceries in 2 of the 8 weeks: [0 ×6, 5,000, 6,000] → median 0.
        { categoryId: "groceries", name: "Groceries", spentWeek: 12000, usualWeek: 0 },
        // Fun and Gas tie at 4,000: by name, Fun first; Gas is the fourth and is left out.
        { categoryId: "fun", name: "Fun", spentWeek: 4000, usualWeek: 0 },
      ],
      carryOver: { nextWeekStart: "2026-10-11", nextWeekCap: 26000, applied: false, adjustment: null },
    });
  });

  it("hold per day is what is left spread over the days left, rounded DOWN to the cent", () => {
    expect(wb({ remainingWeek: "100.01" }).hold.perDay).toBe(2500); // 10,001 / 4 = 2,500.25
    expect(wb({ remainingWeek: "100.03" }).hold.perDay).toBe(2500); // 10,003 / 4 = 2,500.75 — down, never up
    expect(wb({ remainingWeek: "100.01" }).overBy).toBe(0);
    expect(wb({ remainingWeek: "0.03", todayISO: "2026-10-10" })).toMatchObject({ daysLeft: 1, hold: { perDay: 3 } });
    expect(wb({ remainingWeek: "70.00", todayISO: "2026-10-04" })).toMatchObject({ daysLeft: 7, hold: { perDay: 1000 } });
  });

  it("no cap: nothing is over, nothing to hold per day; no bank data: leaves until payday is null — never a false zero", () => {
    const w = wb({ remainingWeek: null, availableUntilPayday: null, nextWeek: { capCents: null, adjustment: null } });
    expect(w.overBy).toBe(0);
    expect(w.hold).toEqual({ perDay: null, leavesUntilPayday: null });
    expect(w.carryOver.nextWeekCap).toBeNull();
  });

  it("weeks before the tracking start are not counted in the usual week", () => {
    // From 2026-09-01 only 9/6, 9/13, 9/20, 9/27 count: [80.00, 120.00, 0, 100.01] → floor((8,000 + 10,001) / 2) = 9,000.
    const w = wb({ rows: [...THIS_WEEK, ...DINING_HISTORY], trackingStart: "2026-09-01" });
    expect(w.trims[0]).toEqual({ categoryId: "dining", name: "Dining", spentWeek: 18000, usualWeek: 9000 });
    // Every week before the tracking start: no week counts → null, never a false 0.
    expect(wb({ rows: THIS_WEEK, trackingStart: "2026-10-04" }).trims[0]!.usualWeek).toBeNull();
  });

  it("only rows that count against the cap, with a category, can be trims", () => {
    const w = wb({ rows: THIS_WEEK });
    expect(w.trims.map((t) => t.categoryId)).toEqual(["dining", "groceries", "fun"]);
    expect(wb({ rows: [r("2026-10-05", "hardware", 90000, "unplanned"), r("2026-10-05", null, 5000)] }).trims).toEqual([]);
  });

  it("carry-over: the applied adjustment wins over the proposal; the cap is floored at $0", () => {
    const applied = { weekStart: "2026-10-11", amountCents: -10000, reason: "Over by $100" };
    expect(wb({ nextWeek: { capCents: 30000, adjustment: applied } }).carryOver).toEqual({
      nextWeekStart: "2026-10-11",
      nextWeekCap: 20000,
      applied: true,
      adjustment: applied,
    });
    expect(wb({ remainingWeek: "-400.00" }).carryOver.nextWeekCap).toBe(0);
    expect(wb({ remainingWeek: "12.00" }).carryOver.nextWeekCap).toBe(30000);
  });

  it("medianCents", () => {
    expect(medianCents([])).toBeNull();
    expect(medianCents([5])).toBe(5);
    expect(medianCents([3, 1, 2])).toBe(2);
    expect(medianCents([1, 2])).toBe(1); // 1.5 rounded down
    expect(medianCents([0, 0, 0, 7])).toBe(0);
  });
});
