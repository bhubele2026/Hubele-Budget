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
/** (2026-11-12) No chart sweeps in any more: the wrapper never carries an entrance class. */
const swept = (c: HTMLElement) => !!c.querySelector(".chart-in, .area-draw, .draw-once");

describe("no chart draws itself on (owner, 2026-11-12: no entrance motion)", () => {
  it("no mount sweeps, with a session key or a new one", () => {
    const a = render(<ProjectedBalanceChart {...base} data={mk(5)} sessionKey="draw-once-a" />);
    expect(swept(a.container)).toBe(false);
    a.unmount();
    const b = render(<ProjectedBalanceChart {...base} data={mk(5)} sessionKey="draw-once-a" />);
    expect(swept(b.container)).toBe(false);
    b.unmount();
    const c = render(<ProjectedBalanceChart {...base} data={mk(5)} sessionKey="draw-once-b" />);
    expect(swept(c.container)).toBe(false);
  });

  it("new data on the mounted chart (a horizon switch) keeps the same node and adds no sweep", () => {
    const a = render(<ProjectedBalanceChart {...base} data={mk(5)} sessionKey="draw-once-c" />);
    const el = a.container.querySelector(".recharts-wrapper")?.parentElement?.parentElement ?? null;
    a.rerender(<ProjectedBalanceChart {...base} data={mk(9)} sessionKey="draw-once-c" />);
    expect(swept(a.container)).toBe(false);
    if (el) expect(el.isConnected).toBe(true);
  });

  it("without a key no mount sweeps either", () => {
    const a = render(<ProjectedBalanceChart {...base} data={mk(5)} />);
    a.unmount();
    const b = render(<ProjectedBalanceChart {...base} data={mk(5)} />);
    expect(swept(b.container)).toBe(false);
  });
});
