import { describe, it, expect } from "vitest";
import * as reportsAnalytics from "./reportsAnalytics";
import { CAT8, CHART, NAVY_RAMP, catColor } from "./chartTokens";
import { CASHFLOW_SERIES } from "../pages/reports/CashFlowPage";
import { DEBT_SERIES } from "../pages/reports/DebtPage";
import { REIMBURSABLE_SERIES } from "../pages/reports/SpendingPage";
import { budgetStatusColor } from "../pages/reports/BudgetPage";

/**
 * THE DUPLICATE-HEX AUDIT.
 *
 * This file replaces the old `reportsAnalyticsPalette` spec, which locked the
 * alias palette and the ordered series list in place with a `toEqual`
 * snapshot — i.e. it pinned the bug rather than catching it. What actually
 * needed testing was never the binding, it was the INVARIANT: inside one
 * chart, two marks must never resolve to the same pixel.
 *
 * At the time of deletion the aliases resolved to:
 *   primary → #19315b   emerald → #19315b   ← the collision
 *   navy    → #c4d0e2   amber   → #a9bad2   ← names that lied
 *
 * The absence check below is deliberately GENERIC rather than a check for the
 * two old names: it fails on any future export shaped like a colour alias, so
 * the pattern cannot come back under a new name.
 */

/** Every value in a colour map must be a distinct hex. */
function expectNoDuplicateHexes(name: string, map: Record<string, string>) {
  const seen = new Map<string, string[]>();
  for (const [key, hex] of Object.entries(map)) {
    const norm = hex.toLowerCase();
    seen.set(norm, [...(seen.get(norm) ?? []), key]);
  }
  const collisions = [...seen.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([hex, keys]) => `${name}: ${keys.join(" === ")} all resolve to ${hex}`);
  expect(collisions).toEqual([]);
}

describe("the alias palette is gone", () => {
  it("reportsAnalytics exports no palette or series list at all", () => {
    // The module is pure derivation now. Colour lives in chartTokens only.
    const paletteish = /(_PALETTE|_SERIES|^PALETTE$|^COLORS?$)/i;
    const offenders = Object.keys(reportsAnalytics).filter((k) =>
      paletteish.test(k),
    );
    expect(offenders).toEqual([]);
  });

  it("exports no key named after a colour", () => {
    const colourish =
      /^(primary|primarySoft|emerald|amber|amberSoft|navySoft|red|rose|sky|slate|teal|crimson|warning)$/i;
    const offenders = Object.keys(reportsAnalytics).filter((k) =>
      colourish.test(k),
    );
    expect(offenders).toEqual([]);
  });

  it("exports no value that is a raw CSS colour string", () => {
    // The old palette's values were all `hsl(var(--…))` strings. Nothing in
    // this module may hold a colour of any form again.
    const colourValue = /^(#|rgb|hsl)/i;
    const offenders = Object.entries(reportsAnalytics)
      .filter(([, v]) => typeof v === "string" && colourValue.test(v))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});

describe("per-chart colour maps carry no duplicate hexes", () => {
  it("cash flow · income vs expense (with the compare overlay)", () => {
    expectNoDuplicateHexes("cashflow.inOut", CASHFLOW_SERIES.inOut);
  });

  it("cash flow · net bars, running line and previous-period line", () => {
    expectNoDuplicateHexes("cashflow.net", CASHFLOW_SERIES.net);
  });

  it("debt · snowball waterfall", () => {
    expectNoDuplicateHexes("debt.waterfall", DEBT_SERIES.waterfall);
  });

  it("debt · interest vs principal", () => {
    expectNoDuplicateHexes("debt.split", DEBT_SERIES.split);
  });

  it("spending · reimbursable vs personal", () => {
    expectNoDuplicateHexes("spending.reimbursable", REIMBURSABLE_SERIES);
  });

  it("budget · the three line states", () => {
    expectNoDuplicateHexes("budget.status", {
      good: budgetStatusColor("good"),
      watch: budgetStatusColor("watch"),
      miss: budgetStatusColor("miss"),
    });
  });
});

describe("the categorical set stays categorical", () => {
  it("CAT8 has eight distinct hues", () => {
    expect(new Set(CAT8).size).toBe(CAT8.length);
    expect(CAT8.length).toBe(8);
  });

  it("catColor is stable per index — a colour marks an item, not a rank", () => {
    for (let i = 0; i < CAT8.length; i += 1) {
      expect(catColor(i)).toBe(CAT8[i]);
      expect(catColor(i)).toBe(catColor(i));
    }
  });

  it("a six-category trend chart draws six distinct colours", () => {
    // SpendingPage caps `trendTopCatNames` at 6 and colours by index.
    const used = Array.from({ length: 6 }, (_, i) => catColor(i));
    expect(new Set(used).size).toBe(6);
  });

  /**
   * ⚠️ REGRESSION GUARD FOR A REAL KIT BUG.
   *
   * `OTHER_GREY` is #8fa3bf, byte-identical to `CAT8[4]`. So a chart with the
   * kit's documented "cap at 8 + roll the tail into Other" shape draws slice 4
   * and the Other slice in ONE colour. SpendingPage therefore does NOT use
   * `OTHER_GREY` for its rollup; it uses `NAVY_RAMP[1]`. This test pins that
   * the substitute is genuinely distinct from every categorical slot, so the
   * nine-slice pie can never collide.
   */
  it("the Other rollup colour is absent from CAT8", () => {
    const other = NAVY_RAMP[1];
    expect(CAT8).not.toContain(other);
    const ninePie = [...Array.from({ length: 8 }, (_, i) => catColor(i)), other];
    expect(new Set(ninePie).size).toBe(9);
  });
});

describe("the sequential ramp stays sequential", () => {
  it("NAVY_RAMP steps are all distinct", () => {
    expect(new Set(NAVY_RAMP).size).toBe(NAVY_RAMP.length);
  });

  it("the heatmap's intensity buckets never collapse two levels into one", () => {
    // SpendingPage maps intensity → 1 + floor(intensity * (len - 1)).
    const step = (intensity: number) =>
      Math.min(
        NAVY_RAMP.length - 1,
        1 + Math.floor(intensity * (NAVY_RAMP.length - 1)),
      );
    expect(step(0.01)).toBeGreaterThan(0);
    expect(step(1)).toBe(NAVY_RAMP.length - 1);
    // Zero spend uses index 0, which no non-zero intensity can reach.
    const nonZero = [0.01, 0.25, 0.5, 0.75, 1].map(step);
    expect(nonZero.every((s) => s >= 1)).toBe(true);
  });
});

describe("the semantic anchors still mean what the pages assume", () => {
  it("navy is the resting good state and deep orange is the bad one", () => {
    expect(CHART.navy).toBe("#19315b");
    expect(CHART.orangeDeep).toBe("#e16d3e");
    expect(CHART.navy).not.toBe(CHART.orangeDeep);
  });

  it("budget statuses map onto navy / neutral / deep orange", () => {
    expect(budgetStatusColor("good")).toBe(CHART.navy);
    expect(budgetStatusColor("watch")).toBe(CHART.steel);
    expect(budgetStatusColor("miss")).toBe(CHART.orangeDeep);
  });
});
