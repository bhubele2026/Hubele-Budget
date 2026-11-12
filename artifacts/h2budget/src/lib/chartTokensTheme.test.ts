import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACCOUNT_ACCENT,
  AXIS_TICK,
  CAT8,
  CHART,
  CHART_INK,
  MARKER,
  NAVY_RAMP,
  OTHER_GREY,
  barColorForSign,
  byTheme,
  catColor,
  rampByRank,
  themed,
  washOf,
} from "./chartTokens";
import { setDarkNow } from "./themeNow";

/**
 * ⭐ THE CHART COLOURS IN LIGHT AND DARK. `chartTokens.test.ts` pins the light
 * hexes and is untouched; this file pins that each table is a VIEW (the same
 * name answers light or dark at the moment it is read), that light is still
 * the old hex, and that dark is legible on the card and never brown.
 */

afterEach(() => setDarkNow(false));

const CARD = "#17181b";
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h: string) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("byTheme / themed — a view, read at draw time", () => {
  it("answers the light table until the page is dark, then the dark one, with no new object", () => {
    const t = byTheme({ a: "L" }, { a: "D" });
    expect(t.a).toBe("L");
    setDarkNow(true);
    expect(t.a).toBe("D");
    expect({ ...t }).toEqual({ a: "D" });
    setDarkNow(false);
    expect(Object.keys(t)).toEqual(["a"]);
    expect(t.a).toBe("L");
  });

  it("a list keeps working as a list (length, index, includes, spread, map)", () => {
    const l = byTheme<readonly string[]>(["a", "b"], ["x", "y"]);
    expect(l.length).toBe(2);
    expect([...l]).toEqual(["a", "b"]);
    setDarkNow(true);
    expect(l[1]).toBe("y");
    expect(l.includes("x")).toBe(true);
    expect(l.map((v) => v + "!")).toEqual(["x!", "y!"]);
  });

  it("themed() rebuilds a table made of theme-aware values, so a module-level table does not freeze light", () => {
    const frozen = { lead: CHART.navy }; // ⚠️ what NOT to do
    const live = themed(() => ({ lead: CHART.navy, pair: { a: CHART.mid } }));
    setDarkNow(true);
    expect(frozen.lead).toBe("#19315b");
    expect(live.lead).toBe("#eef1f6");
    expect(live.pair.a).toBe("#8fa9d6");
    setDarkNow(false);
    expect(live.lead).toBe("#19315b");
  });
});

describe("light is exactly what it was", () => {
  it("every table reads its old hex", () => {
    expect({ ...CHART }).toEqual({
      navy: "#19315b", navy2: "#22406e", mid: "#3b5c8f", mist: "#8fa3bf", steel: "#4d5d73",
      // (2026-11-12, owner-approved light change) the grid is a quiet neutral hairline.
      orange: "#f68d2e", orangeDeep: "#e16d3e", badInk: "#c2410c", grid: "#e8eaee",
    });
    // (2026-11-12, owner) the two orange slots are now a muted teal and a muted plum.
    expect([...CAT8]).toEqual(["#19315b", "#3b5c8f", "#2f7f7a", "#4d5d73", "#8fa3bf", "#22406e", "#8e5b8c", "#a9bad2"]);
    expect([...NAVY_RAMP]).toEqual(["#e1e8f0", "#c4d0e2", "#a9bad2", "#8fa3bf", "#3b5c8f", "#19315b"]);
    expect({ ...ACCOUNT_ACCENT }).toEqual({ checking: "#19315b", amex: "#0f766e", card2: "#5b4bb3", other: "#5d6674" });
    // (2026-11-12, owner) the debt-payment diamond is navy, not orange.
    expect({ ...MARKER }).toEqual({ payday: "#19315b", bill: "#4d5d73", card: "#0f766e", debt: "#22406e" });
    expect({ ...AXIS_TICK }).toEqual({ fontSize: 12, fill: "#6b7280" });
    expect(OTHER_GREY).toBe("#767b83");
    // The literals these replaced in charts.tsx, reportsShared.tsx and ProjectedBalanceChart.tsx.
    expect({ ...CHART_INK }).toEqual({
      axis: "#6b7280", label: "#363d4a", plate: "#ffffff", band: "#f1f2f5", tooltipBg: "#ffffff", tooltipLine: "#e3e6eb",
      tooltipInk: "#1d2330", tooltipShadow: "0 4px 14px -4px rgb(17 24 39 / 0.12)", onFill: "#ffffff",
    });
    expect(washOf(CHART.orange)).toBe("#f68d2e");
    expect(washOf(CHART.orangeDeep)).toBe("#e16d3e");
  });
});

describe("dark — legible on the card, one orange, never brown", () => {
  it("the lead series is near-white, the second a soft blue-grey, orange is unchanged", () => {
    setDarkNow(true);
    expect(CHART.navy).toBe("#eef1f6");
    expect(CHART.mid).toBe("#8fa9d6");
    expect(CHART.orange).toBe("#f68d2e");
    expect(barColorForSign(1)).toBe(CHART.navy);
    expect(barColorForSign(-1)).toBe(CHART.orangeDeep);
    expect(catColor(0)).toBe("#eef1f6");
    expect(catColor(99)).toBe(OTHER_GREY);
    expect(rampByRank(0, 6)).toBe("#eef1f6"); // the largest item is the brightest
  });

  it("every series colour, marker and account accent is at least 3:1 on the card; chart text at least 4.5:1", () => {
    setDarkNow(true);
    const marks = [CHART.navy, CHART.navy2, CHART.mid, CHART.mist, CHART.steel, CHART.orange, CHART.orangeDeep, ...CAT8, OTHER_GREY, ...Object.values(MARKER), ...Object.values(ACCOUNT_ACCENT)];
    for (const c of marks) expect(contrast(c, CARD), `${c} on the card`).toBeGreaterThanOrEqual(3);
    for (const c of [CHART.badInk, CHART_INK.axis, CHART_INK.label, AXIS_TICK.fill]) expect(contrast(c, CARD), `${c} text on the card`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(CHART_INK.tooltipInk, CHART_INK.tooltipBg)).toBeGreaterThanOrEqual(4.5);
    expect(CHART_INK.plate).toBe(CARD);
    expect(new Set(CAT8).size).toBe(8);
    expect(CAT8).not.toContain(OTHER_GREY);
  });

  it("(owner, 2026-11-12) the categorical set holds no orange, in light or dark: orange is for warnings", () => {
    const oranges = ["#f68d2e", "#e16d3e", "#ee7d50", "#c2410c"];
    for (const dark of [false, true]) {
      setDarkNow(dark);
      for (const c of CAT8) expect(oranges, `${c} (${dark ? "dark" : "light"})`).not.toContain(c.toLowerCase());
    }
    setDarkNow(false);
  });

  it("a translucent fill of orange or the alarm colour becomes neutral (their half-alpha over black is brown); others keep their colour", () => {
    setDarkNow(true);
    expect(washOf(CHART.orange)).toBe("#9aa1ad");
    expect(washOf(CHART.orangeDeep)).toBe("#9aa1ad");
    expect(washOf(CHART.badInk)).toBe("#9aa1ad");
    expect(washOf(CHART.navy)).toBe(CHART.navy);
    expect(washOf(CHART.mid)).toBe(CHART.mid);
  });

  it("the dark account accents, alarm ink and card equal the DARK block of index.css", () => {
    setDarkNow(true);
    const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");
    const dark = css.slice(css.indexOf('html[data-theme="dark"] {'));
    const v = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(dark)?.[1]?.toLowerCase();
    expect(v("--color-acct-checking")).toBe(ACCOUNT_ACCENT.checking);
    expect(v("--color-acct-amex")).toBe(ACCOUNT_ACCENT.amex);
    expect(v("--color-acct-card2")).toBe(ACCOUNT_ACCENT.card2);
    expect(v("--color-acct-other")).toBe(ACCOUNT_ACCENT.other);
    expect(v("--color-bad-ink")).toBe(CHART.badInk);
    expect(v("--background-color-white")).toBe(CHART_INK.plate);
  });
});

describe("no chart file keeps a colour literal or a frozen copy", () => {
  const SRC = resolve(import.meta.dirname, "..");
  const read = (f: string) => readFileSync(resolve(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("the chart files hold no hex literal (colours come from chartTokens)", () => {
    for (const f of ["lib/charts.tsx", "lib/cssBars.tsx", "pages/reports/reportsShared.tsx", "pages/forecast/ProjectedBalanceChart.tsx", "pages/reports/SpendingPage.tsx", "pages/reports/CashFlowPage.tsx", "pages/reports/DebtPage.tsx", "pages/reports/BehaviorPage.tsx", "pages/reports/BudgetPage.tsx", "pages/amex.tsx"]) {
      expect(read(f).match(/["'`]#[0-9a-fA-F]{3,8}["'`]/g), f).toBeNull();
    }
  });
  it("no module-level `const X = CHART.…` (it would stay light for ever)", () => {
    for (const f of ["lib/charts.tsx", "pages/reports/reportsShared.tsx", "pages/reports/SpendingPage.tsx", "pages/reports/CashFlowPage.tsx", "pages/reports/DebtPage.tsx", "pages/reports/BehaviorPage.tsx", "pages/reports/BudgetPage.tsx", "pages/reports.tsx"]) {
      expect(read(f).match(/^(export )?const \w+\s*(:[^=]+)?=\s*(CHART|CHART_INK|MARKER|ACCOUNT_ACCENT)\.\w+/gm), f).toBeNull();
    }
  });
});
