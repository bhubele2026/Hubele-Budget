// (PR-B1) `everydayPlanFromRows` (allowance_plans) agrees with `everydayPlan`
// (the settings row) for every household the backfill can produce — until the
// settings columns are retired. The backfill is modelled exactly as
// lib/db/migrations/0040_allowance_plans.sql writes it: one weekly and one
// monthly household-pool row, effective 2026-05-01, for each non-zero amount.
// `allowancePlans.integration.test.ts` runs the real SQL against real rows.

import { describe, it, expect } from "vitest";
import {
  addDaysISO,
  allowancePlanInEffect,
  everydayPlan,
  everydayPlanFromRows,
  type AllowancePlanRow,
} from "@workspace/avalanche-core";

/** What 0040_allowance_plans.sql writes for one owner's settings row. */
function backfill(settings: { weekly: string; monthly: string }): AllowancePlanRow[] {
  const rows: AllowancePlanRow[] = [];
  if (Number(settings.weekly) !== 0) rows.push({ memberUserId: null, period: "weekly", amount: settings.weekly, effectiveFrom: "2026-05-01" });
  if (Number(settings.monthly) !== 0) rows.push({ memberUserId: null, period: "monthly", amount: settings.monthly, effectiveFrom: "2026-05-01" });
  return rows;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every week from the one holding the tracking start (Sun 4/26 – Sat 5/2) to a
// year out, and a few keys that are not week starts (a Friday, a Wednesday, an
// impossible date). Weeks that ended before 2026-05-01 had no plan: see below.
const SUNDAYS = Array.from({ length: 60 }, (_, i) => addDaysISO("2026-04-26", i * 7));
const NOT_SUNDAYS = ["2026-10-07", "2026-05-01", "2026-09-31", "2026-06-15"];

describe("everydayPlanFromRows ⇔ everydayPlan, through the backfill", () => {
  it("agrees on 1,000 seeded households × every week (numeric(12,2) amounts, overrides of every shape)", () => {
    const rand = rng(424242);
    const money = () => {
      const r = rand();
      if (r < 0.2) return "0.00";
      if (r < 0.25) return "-25.00";
      return (Math.floor(rand() * 200_000) / 100).toFixed(2);
    };
    let compared = 0;
    let usedOverride = 0;
    for (let h = 0; h < 1000; h++) {
      const settings = { weekly: money(), monthly: money() };
      const overrides: Record<string, string | number> = {};
      for (const s of SUNDAYS) {
        const r = rand();
        if (r < 0.05) overrides[s] = (Math.floor(rand() * 90_000) / 100).toFixed(2);
        else if (r < 0.07) overrides[s] = "12abc";
        else if (r < 0.08) overrides[s] = 0;
        else if (r < 0.09) overrides[s] = " 40 ";
      }
      if (rand() < 0.1) overrides["2026-10-07"] = "999"; // a Wednesday key: never an override
      const plans = backfill(settings);
      for (const sunday of [...SUNDAYS, ...NOT_SUNDAYS]) {
        const want = everydayPlan(sunday, { weeklyAllowanceAmount: settings.weekly, monthlyAllowanceAmount: settings.monthly }, overrides);
        const got = everydayPlanFromRows(sunday, plans, overrides);
        expect({ weeklyCents: got.weeklyCents, monthlyCents: got.monthlyCents }, `${h} ${sunday}`).toEqual(want);
        if (got.weeklySource === "override") usedOverride++;
        compared++;
      }
    }
    expect(compared).toBe(1000 * 64);
    expect(usedOverride).toBeGreaterThan(2000);
  });

  it("by design they differ only before the backfill's start: a week that ended before 2026-05-01 had no plan", () => {
    const plans = backfill({ weekly: "300.00", monthly: "400.00" });
    expect(everydayPlan("2026-04-19", { weeklyAllowanceAmount: "300.00", monthlyAllowanceAmount: "400.00" }).weeklyCents).toBe(30000);
    expect(everydayPlanFromRows("2026-04-19", plans).weeklyCents).toBe(0);
    // The week holding 5/1 already has it.
    expect(everydayPlanFromRows("2026-04-26", plans).weeklyCents).toBe(30000);
  });

  it("no plan rows and no override is 0 — the same as an unset settings row", () => {
    expect(everydayPlanFromRows("2026-10-04", [], null)).toEqual({
      weeklyCents: 0,
      monthlyCents: 0,
      weeklySource: "none",
      monthlySource: "none",
    });
  });
});

describe("which plan is in effect", () => {
  const plans: AllowancePlanRow[] = [
    { memberUserId: null, period: "weekly", amount: "300", effectiveFrom: "2026-05-01" },
    { memberUserId: null, period: "weekly", amount: "350", effectiveFrom: "2026-10-07" }, // a Wednesday
    { memberUserId: "member-2", period: "weekly", amount: "9999", effectiveFrom: "2026-05-01" },
    { memberUserId: null, period: "monthly", amount: "400", effectiveFrom: "2026-06-01" },
  ];

  it("the newest row that has started by the end of the week governs the whole week", () => {
    expect(everydayPlanFromRows("2026-09-27", plans).weeklyCents).toBe(30000);
    expect(everydayPlanFromRows("2026-10-04", plans).weeklyCents).toBe(35000); // starts Wed 10/7, inside this week
    expect(everydayPlanFromRows("2026-10-11", plans).weeklyCents).toBe(35000);
  });

  it("a member's own plan is never the household's cap", () => {
    expect(allowancePlanInEffect("2026-05-03", plans, "weekly")?.amount).toBe("300");
    expect(everydayPlanFromRows("2026-04-26", plans.slice(2)).weeklyCents).toBe(0);
  });

  it("before any plan started there is none", () => {
    expect(everydayPlanFromRows("2026-04-19", plans)).toMatchObject({ weeklyCents: 0, weeklySource: "none" });
    expect(everydayPlanFromRows("2026-05-24", plans)).toMatchObject({ monthlyCents: 0, monthlySource: "none" });
    expect(everydayPlanFromRows("2026-05-31", plans)).toMatchObject({ monthlyCents: 40000, monthlySource: "plan" });
  });

  it("an override still wins for its own week", () => {
    expect(everydayPlanFromRows("2026-10-04", plans, { "2026-10-04": "120.5" })).toMatchObject({
      weeklyCents: 12050,
      weeklySource: "override",
    });
  });
});
