import { describe, it, expect } from "vitest";
import { H2_PALETTE, CHART_SERIES } from "./reportsAnalytics";

describe("H2_PALETTE token bindings", () => {
  it("anchors every semantic slot to the expected design token", () => {
    expect(H2_PALETTE).toEqual({
      primary: "hsl(var(--chart-1))",
      primarySoft: "hsl(var(--chart-1) / 0.55)",
      purple: "hsl(var(--chart-5))",
      purpleSoft: "hsl(var(--chart-5) / 0.55)",
      amber: "hsl(var(--chart-4))",
      amberSoft: "hsl(var(--chart-4) / 0.55)",
      warning: "hsl(var(--warning))",
      red: "hsl(var(--negative))",
      rose: "hsl(var(--negative) / 0.7)",
      sky: "hsl(var(--chart-2))",
      violet: "hsl(var(--chart-5))",
      emerald: "hsl(var(--positive))",
      slate: "hsl(var(--chart-3))",
    });
  });

  it("keeps emerald pointed at --positive (net surplus semantic)", () => {
    expect(H2_PALETTE.emerald).toBe("hsl(var(--positive))");
  });

  it("keeps red pointed at --negative (loss / over-spend semantic)", () => {
    expect(H2_PALETTE.red).toBe("hsl(var(--negative))");
  });
});

describe("CHART_SERIES snapshot", () => {
  it("locks the ordered list of series colors", () => {
    expect(CHART_SERIES).toEqual([
      "hsl(var(--chart-1))",
      "hsl(var(--chart-5))",
      "hsl(var(--chart-4))",
      "hsl(var(--chart-2))",
      "hsl(var(--chart-3))",
      "hsl(var(--negative))",
      "hsl(var(--chart-1) / 0.55)",
      "hsl(var(--chart-5) / 0.55)",
      "hsl(var(--chart-4) / 0.6)",
      "hsl(var(--chart-3) / 0.7)",
    ]);
  });
});
