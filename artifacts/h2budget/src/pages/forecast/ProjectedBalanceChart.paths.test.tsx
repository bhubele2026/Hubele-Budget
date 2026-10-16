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

describe("(T1/T2) the curve is the daily points, its start is named, zero and the low point are honest", () => {
  const pts = (balances: number[]) =>
    balances.map((balance, i) => {
      const rawDate = `2026-10-${String(15 + i).padStart(2, "0")}`;
      return { date: rawDate.slice(5), rawDate, balance };
    });

  it("linear, not monotone: the path is straight segments between the daily points (no false dips)", () => {
    const { container } = render(<ProjectedBalanceChart {...base} todayISO="2026-10-15" data={pts([0, 500, 120, 900])} />);
    const ds = Array.from(curves(container)).map((p) => p.getAttribute("d") ?? "").filter(Boolean);
    expect(ds.length).toBeGreaterThan(0);
    // A monotone curve is drawn with cubic Béziers (C); a linear one only moves and lines.
    for (const d of ds) expect(d).not.toMatch(/C/);
  });

  it("draws 'Starting at $X · as of <day>' at the first point", () => {
    const { getByTestId } = render(
      <ProjectedBalanceChart {...base} todayISO="2026-10-15" data={pts([0, 300, 600])} startLabel="Starting at $0.00 · as of Oct 15" />,
    );
    expect(getByTestId("chart-start-label").textContent).toBe("Starting at $0.00 · as of Oct 15");
  });

  it("a zero rule whenever the curve touches $0 (here: it starts at exactly $0.00)", () => {
    const lines = (balances: number[]) => {
      const { container, unmount } = render(<ProjectedBalanceChart {...base} todayISO="2026-10-15" data={pts(balances)} />);
      const n = container.querySelectorAll(".recharts-reference-line").length;
      unmount();
      return n;
    };
    // Today and the buffer always; the zero rule only when a point is at or under $0.
    expect(lines([0, 300, 600])).toBe(lines([10, 300, 600]) + 1);
  });

  it("the low point is rust only below zero; at or above $0 (even under the buffer) it is navy", () => {
    const low = (y: number) => ({ x: "10-16", y, rawDate: "2026-10-16" });
    const a = render(<ProjectedBalanceChart {...base} todayISO="2026-10-15" data={pts([300, 120, 600])} lowestPoint={low(120)} />);
    const t1 = a.container.querySelector('text[data-tone]');
    expect(t1?.getAttribute("data-tone")).toBe("neutral");
    a.unmount();
    const b = render(<ProjectedBalanceChart {...base} todayISO="2026-10-15" data={pts([300, -40, 600])} lowestPoint={low(-40)} />);
    expect(b.container.querySelector('text[data-tone]')?.getAttribute("data-tone")).toBe("bad");
  });
});
