import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";

// Real recharts; only the container is given a size (jsdom has no layout).
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children, { width: 800, height: 400 } as object),
  };
});
vi.mock("@/lib/chartAnim", () => ({ CHART_ANIM: { isAnimationActive: false } }));

import { ProjectedBalanceChart } from "./ProjectedBalanceChart";

const mk = (dates: string[]) =>
  dates.map((rawDate, i) => ({ date: rawDate.slice(5), rawDate, balance: 2500 - i * 100 }));
const base = {
  cashBuffer: 500, lowestPoint: null, bigBillMarkers: [], eventsByDate: new Map(),
  onJumpToPlan: () => {}, onMarkMissed: () => {}, variant: "expanded" as const, riskShading: true,
};
afterEach(cleanup);
const curves = (c: HTMLElement) => c.querySelectorAll("path.recharts-area-curve");

describe("expanded chart draws its balance line", () => {
  it("first point before today, rest after: Actual and Projected both draw", () => {
    const { container } = render(
      <ProjectedBalanceChart {...base} todayISO="2026-10-08" data={mk(["2026-10-04", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"])} />,
    );
    expect(curves(container).length).toBe(2);
  });
  it("all points after today: Projected draws", () => {
    const { container } = render(
      <ProjectedBalanceChart {...base} todayISO="2026-10-01" data={mk(["2026-10-04", "2026-10-05", "2026-10-06"])} />,
    );
    expect(Array.from(curves(container)).some((p) => (p.getAttribute("d") ?? "").length > 0)).toBe(true);
  });
});
