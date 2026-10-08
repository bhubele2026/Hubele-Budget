import { describe, it, expect } from "vitest";
import { pickAction, type ActionInput } from "../recap/action";
import { allowedNumbers, NUMBER_RE } from "../recap/validate";
import { renderRecapTemplate } from "../recap/template";
import type { RecapFacts } from "../recap/facts";

// (V2) The one action line: chosen by code, first match wins, and every figure
// in it is a figure the facts already hold.

const BASE: ActionInput = {
  forDate: "2026-10-07",
  yesterday: "2026-10-06",
  yesterdayWeekday: "Tue",
  spentYesterday: { total: 40, count: 2, topCategories: [] },
  lateArrivals: { count: 0, total: 0, fromDate: null, fromWeekday: null },
  weekToDate: { spent: 100, cap: 250, remainingWeek: 150, withinPlan: "yes" },
  position: { safeToSpendNow: 300, availableUntilPayday: 1234, paydayDate: "2026-10-16", paydayWeekday: "Fri", horizonKind: "payday", confidence: "firm", degraded: false },
  billsNext3Days: [],
  reviewCount: 0,
  categorizationReviewCount: 0,
  needsLookCount: 0,
  nextStep: null,
  debt: { payoffPct: 40, confirmedPaymentsYesterday: 0, topAprName: "Visa" },
  freshness: { stale: false, staleReason: null, asOfBank: "2026-10-07T01:00:00.000Z", daysSinceBank: 0 },
  progress: { lowerThanLastWeek: false, debtPayment: false },
  findings: [],
};
const with_ = (over: Partial<ActionInput>): ActionInput => ({ ...BASE, ...over });
const shortfall = { id: "f", kind: "shortfall_before_income", severity: "high" as const, summary: "cash may dip $210 under the buffer before payday", surfaced: false, shortBy: 210 };
const electric = { name: "Electric", date: "2026-10-08", weekday: "Thu", amount: 90, dueTomorrow: true };

describe("pickAction — first match wins", () => {
  it("(a) stale bank data: no action", () => {
    expect(pickAction(with_({ freshness: { ...BASE.freshness, stale: true }, weekToDate: { ...BASE.weekToDate, withinPlan: "over" }, needsLookCount: 3 }))).toBeNull();
  });
  it("(b) over plan: hold non-essentials, keeping the room until payday", () => {
    const a = pickAction(with_({ weekToDate: { ...BASE.weekToDate, withinPlan: "over" }, needsLookCount: 2, findings: [shortfall] }))!;
    expect(a).toEqual({ kind: "hold_spending", text: "Hold non-essentials until Sunday; that keeps $1,234 until payday.", figures: [1234] });
  });
  it("(b) with no payday it says through Saturday; with no figure it drops the clause", () => {
    expect(pickAction(with_({ weekToDate: { ...BASE.weekToDate, withinPlan: "over" }, position: { ...BASE.position, horizonKind: "week_end", paydayDate: null, paydayWeekday: null } }))!.text).toBe(
      "Hold non-essentials until Sunday; that keeps $1,234 through Saturday.",
    );
    const none = pickAction(with_({ weekToDate: { ...BASE.weekToDate, withinPlan: "over" }, position: { ...BASE.position, availableUntilPayday: null } }))!;
    expect(none).toEqual({ kind: "hold_spending", text: "Hold non-essentials until Sunday.", figures: [] });
  });
  it("(c) a shortfall finding: the gap", () => {
    expect(pickAction(with_({ findings: [shortfall], needsLookCount: 2 }))).toEqual({ kind: "shortfall", text: "Cash may dip $210 under the buffer before payday.", figures: [210] });
  });
  it("(c) a shortfall finding without a gap figure is skipped", () => {
    expect(pickAction(with_({ findings: [{ ...shortfall, shortBy: null }], needsLookCount: 1 }))!.kind).toBe("review");
  });
  it("(d) charges need a look", () => {
    expect(pickAction(with_({ needsLookCount: 1, reviewCount: 1, billsNext3Days: [electric] }))).toEqual({ kind: "review", text: "1 charge needs a look.", figures: [1] });
    expect(pickAction(with_({ needsLookCount: 4, reviewCount: 4 }))!.text).toBe("4 charges need a look.");
  });
  it("(e) a bill due tomorrow", () => {
    expect(pickAction(with_({ billsNext3Days: [{ ...electric, dueTomorrow: false }, electric] }))).toEqual({ kind: "bill_tomorrow", text: "Electric $90 is due tomorrow.", figures: [90] });
  });
  it("(f) on plan with payday within 3 days: extra toward the highest-APR debt, no amount", () => {
    const a = pickAction(with_({ position: { ...BASE.position, paydayDate: "2026-10-09" } }))!;
    expect(a).toEqual({ kind: "extra_debt", text: "On plan. Extra toward Visa is on the table.", figures: [] });
  });
  it("(f) needs a debt, a near payday, and an on-plan week", () => {
    const near = { ...BASE.position, paydayDate: "2026-10-09" };
    expect(pickAction(with_({ position: near, debt: { ...BASE.debt, topAprName: null } }))!.kind).toBe("nothing");
    expect(pickAction(with_({ position: near, weekToDate: { ...BASE.weekToDate, withinPlan: "tight" } }))!.kind).toBe("nothing");
  });
  it("(g) otherwise: nothing to do", () => {
    expect(pickAction(BASE)).toEqual({ kind: "nothing", text: "On plan. Nothing to do today.", figures: [] });
    expect(pickAction(with_({ weekToDate: { ...BASE.weekToDate, withinPlan: "tight" } }))!.text).toBe("Nothing to do today.");
  });
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

describe("property: every number in an action exists in the facts", () => {
  it("1000 random fact sets", () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 1000; seed++) {
      const r = rng(seed);
      const money = (max: number) => Math.round(r() * max * 100) / 100;
      const bill = { name: ["Rent", "Electric", "Water 2"][Math.floor(r() * 3)]!, date: "2026-10-08", weekday: "Thu", amount: money(2500), dueTomorrow: r() < 0.5 };
      const f: ActionInput = {
        ...BASE,
        weekToDate: { spent: money(700), cap: 300, remainingWeek: 50, withinPlan: ([null, "yes", "tight", "over"] as const)[Math.floor(r() * 4)] ?? null },
        position: { ...BASE.position, availableUntilPayday: r() < 0.8 ? money(9000) : null, horizonKind: r() < 0.7 ? "payday" : "week_end", paydayDate: ["2026-10-07", "2026-10-09", "2026-10-20", null][Math.floor(r() * 4)] ?? null },
        billsNext3Days: r() < 0.6 ? [bill] : [],
        needsLookCount: r() < 0.3 ? Math.floor(r() * 12) : 0,
        debt: { ...BASE.debt, topAprName: r() < 0.6 ? "Store Card" : null },
        freshness: { ...BASE.freshness, stale: r() < 0.2 },
        findings: r() < 0.3 ? [{ ...shortfall, shortBy: r() < 0.8 ? money(900) : null }] : [],
      };
      const a = pickAction(f);
      if (!a) continue;
      kinds.add(a.kind);
      const allowed = allowedNumbers({ ...f, action: null } as RecapFacts);
      const nums = [...a.text.matchAll(NUMBER_RE)];
      expect(nums.length, `seed ${seed}`).toBe(a.figures.length);
      for (const m of nums) {
        const n = Number(m[0].replace(/[$,]/g, ""));
        const pool = m[0].startsWith("$") ? allowed.amounts : allowed.counts;
        expect(pool.has((Math.round(n * 100) / 100).toFixed(2)), `seed ${seed}: ${a.text}`).toBe(true);
        expect(a.figures.some((x) => Math.abs(Math.round(x) - n) < 1 || x === n), `seed ${seed}: ${a.text}`).toBe(true);
      }
    }
    expect([...kinds].sort()).toEqual(["bill_tomorrow", "extra_debt", "hold_spending", "nothing", "review", "shortfall"]);
  });
});

describe("the template carries the action", () => {
  it("after the plan line, before bills, and never says the review line twice", () => {
    const action = pickAction(with_({ needsLookCount: 2, reviewCount: 2, billsNext3Days: [electric] }))!;
    const f = { ...BASE, needsLookCount: 2, reviewCount: 2, billsNext3Days: [electric], action } as RecapFacts;
    const t = renderRecapTemplate(f);
    expect(t).toBe("Yesterday: $40 spent. Room in the plan: $1,234 until Fri. On track this week. 2 charges need a look. Due soon: Electric $90 tomorrow.");
    expect(t.split("need a look").length).toBe(2);
    const quiet = renderRecapTemplate({ ...BASE, action: pickAction(BASE) } as RecapFacts);
    expect(quiet).toBe("Yesterday: $40 spent. Room in the plan: $1,234 until Fri. On track this week. On plan. Nothing to do today.");
  });
});
