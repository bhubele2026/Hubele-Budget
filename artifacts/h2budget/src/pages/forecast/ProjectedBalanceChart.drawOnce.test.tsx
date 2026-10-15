import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children, { width: 800, height: 400 } as object),
  };
});

import { ProjectedBalanceChart } from "./ProjectedBalanceChart";

const mk = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const rawDate = `2026-10-${String(10 + i).padStart(2, "0")}`;
    return { date: rawDate.slice(5), rawDate, balance: 2500 - i * 100 };
  });
const base = { cashBuffer: 500, lowestPoint: null, bigBillMarkers: [], eventsByDate: new Map(), onJumpToPlan: () => {}, onMarkMissed: () => {} };
afterEach(cleanup);
const swept = (c: HTMLElement) => !!c.querySelector(".chart-in.area-draw");

describe("the classic chart draws in once per session key", () => {
  it("the first mount sweeps; a later mount with the same key appears without a sweep; a new key sweeps", () => {
    const a = render(<ProjectedBalanceChart {...base} data={mk(5)} sessionKey="draw-once-a" />);
    expect(swept(a.container)).toBe(true);
    a.unmount();
    const b = render(<ProjectedBalanceChart {...base} data={mk(5)} sessionKey="draw-once-a" />);
    expect(swept(b.container)).toBe(false);
    b.unmount();
    const c = render(<ProjectedBalanceChart {...base} data={mk(5)} sessionKey="draw-once-b" />);
    expect(swept(c.container)).toBe(true);
  });

  it("new data on the mounted chart (a horizon switch) does not restart the sweep", () => {
    const a = render(<ProjectedBalanceChart {...base} data={mk(5)} sessionKey="draw-once-c" />);
    expect(swept(a.container)).toBe(true);
    const el = a.container.querySelector(".chart-in");
    a.rerender(<ProjectedBalanceChart {...base} data={mk(9)} sessionKey="draw-once-c" />);
    // the same node, never remounted
    expect(a.container.querySelector(".chart-in")).toBe(el);
  });

  it("without a key the chart sweeps every mount (the Forecast page is unchanged)", () => {
    const a = render(<ProjectedBalanceChart {...base} data={mk(5)} />);
    a.unmount();
    const b = render(<ProjectedBalanceChart {...base} data={mk(5)} />);
    expect(swept(b.container)).toBe(true);
  });
});
