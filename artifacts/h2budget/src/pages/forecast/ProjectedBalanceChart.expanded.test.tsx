import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";

// Series props are captured so the test can read what the chart asked recharts
// to draw: which lines, whether the draw animates, which tints.
const areas: Array<Record<string, unknown>> = [];
vi.mock("recharts", () => {
  const Wrap = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Wrap, AreaChart: Wrap, XAxis: Nothing, YAxis: Nothing, CartesianGrid: Nothing,
    Tooltip: Nothing, ReferenceDot: Nothing, Label: Nothing,
    Area: (p: Record<string, unknown>) => { areas.push(p); return null; },
    ReferenceLine: ({ ...p }: Record<string, unknown>) => <i data-testid={String(p["data-testid"] ?? "ref")} />,
    ReferenceArea: ({ ...p }: Record<string, unknown>) => <i data-testid={String(p["data-testid"])} />,
  };
});
// (C13) The chart takes its recharts primitives from the kit now (`Rc*`), so
// the kit is the real one — over the recharts stub above — with only the
// tick measurer stubbed.
vi.mock("@/lib/charts", async () => {
  const kit = await vi.importActual<Record<string, unknown>>("@/lib/charts");
  return { ...kit, useXTicks: () => [] };
});

import { ProjectedBalanceChart } from "./ProjectedBalanceChart";

const mk = (bal: number[]) =>
  bal.map((balance, i) => ({ date: `0${i + 1}`, rawDate: `2026-06-0${i + 1}`, balance }));
const base = {
  cashBuffer: 500, lowestPoint: null, bigBillMarkers: [], eventsByDate: new Map(),
  onJumpToPlan: () => {}, onMarkMissed: () => {},
};
afterEach(() => { cleanup(); areas.length = 0; vi.useRealTimers(); });

describe("ProjectedBalanceChart — expanded variant", () => {
  it("classic stays one 'Forecast' area with no extras", () => {
    const { queryByTestId } = render(<ProjectedBalanceChart {...base} data={mk([900, 400, 900])} />);
    expect(areas.map((a) => a.dataKey)).toEqual(["balance"]);
    expect(areas[0].name).toBe("Forecast");
    expect(queryByTestId("ref-today")).toBeNull();
    expect(queryByTestId("risk-below-buffer")).toBeNull();
  });

  it("draws solid actual then dashed projected, a today rule, and risk tints", () => {
    const { getByTestId, getAllByTestId } = render(
      <ProjectedBalanceChart {...base} variant="expanded" todayISO="2026-06-02" riskShading data={mk([900, 400, -20, 900])} />,
    );
    const [past, future] = areas;
    expect([past.dataKey, future.dataKey]).toEqual(["past", "future"]);
    expect(past.strokeDasharray).toBeUndefined();
    expect(future.strokeDasharray).toBeTruthy();
    expect(getByTestId("ref-today")).toBeTruthy();
    expect(getAllByTestId("risk-below-buffer").length).toBe(1);
    expect(getAllByTestId("risk-below-zero").length).toBe(1);
    expect(getByTestId("ref-zero")).toBeTruthy();
  });

  it("animates the draw only until it settles, and again only when the data changes", () => {
    vi.useFakeTimers();
    const props = { ...base, variant: "expanded" as const };
    const { rerender } = render(<ProjectedBalanceChart {...props} data={mk([900, 400])} />);
    const last = () => areas[areas.length - 1].isAnimationActive;
    const first = last();
    // An unrelated re-render (new array, same content) keeps animating.
    rerender(<ProjectedBalanceChart {...props} data={mk([900, 400])} selectedDate="2026-06-01" />);
    expect(last()).toBe(first);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(last()).toBe(false);
    // Same content again: still off.
    rerender(<ProjectedBalanceChart {...props} data={mk([900, 400])} selectedDate="2026-06-02" />);
    expect(last()).toBe(false);
    // New content: animates again.
    rerender(<ProjectedBalanceChart {...props} data={mk([900, 450])} />);
    expect(last()).toBe(first);
  });
});
