import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import React from "react";

// ⭐ (Readable forecast) The calm chart: paydays are the only resting markers, bills / cards / debts and the
// big-bill rings wait for "Show bills", the tooltip is date · balance · In / Out, and toggling never restarts
// the draw. Invented figures.
const areas: Array<Record<string, unknown>> = [];
let tooltipAt: { rawDate: string; balance: number } | null = null;
vi.mock("recharts", () => {
  const Wrap = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Wrap, AreaChart: Wrap, XAxis: Nothing, YAxis: Nothing, CartesianGrid: Nothing, Label: Nothing,
    Area: (p: Record<string, unknown>) => { areas.push(p); return null; },
    ReferenceLine: (p: Record<string, unknown>) => <i data-testid={String(p["data-testid"] ?? "ref")} />,
    ReferenceArea: (p: Record<string, unknown>) => <i data-testid={String(p["data-testid"])} />,
    // A dot with a `shape` draws it (the kind markers, the payday ticks); a plain one is its test id.
    ReferenceDot: (p: { shape?: (a: { cx: number; cy: number }) => React.ReactNode; [k: string]: unknown }) =>
      p.shape ? <svg>{p.shape({ cx: 10, cy: 10 })}</svg> : <i data-testid={String(p["data-testid"] ?? "dot")} />,
    Tooltip: ({ content }: { content: (a: unknown) => React.ReactNode }) =>
      tooltipAt ? <div>{content({ active: true, payload: [{ payload: tooltipAt }] })}</div> : null,
  };
});
vi.mock("@/lib/charts", async () => {
  const kit = await vi.importActual<Record<string, unknown>>("@/lib/charts");
  return { ...kit, useXTicks: () => [] };
});

import { ProjectedBalanceChart } from "./ProjectedBalanceChart";
import type { MarkerGroup } from "@/lib/forecastEventKinds";

const data = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map((rawDate, i) => ({
  date: rawDate.slice(5),
  rawDate,
  balance: [2400, 2300, 900, 3350][i],
}));
const ev = (date: string, label: string, amount: number, kind: MarkerGroup["kind"]) => ({
  date, label, amount, kind, dragged: false, occurrenceDate: date,
});
const markers: MarkerGroup[] = [
  { date: "2026-11-11", count: 1, kind: "bill", kinds: ["bill"], balance: 2300, events: [ev("2026-11-11", "Water", -100, "bill")] },
  { date: "2026-11-12", count: 2, kind: "debt", kinds: ["debt", "card"], balance: 900, events: [ev("2026-11-12", "Avalanche payment → Maple Card", -1300, "debt"), ev("2026-11-12", "Northwind card payment", -100, "card")] },
  { date: "2026-11-13", count: 1, kind: "payday", kinds: ["payday"], balance: 3350, events: [ev("2026-11-13", "Paycheck · Jordan", 2450, "payday")] },
];
const bigBillMarkers = [{ date: "2026-11-12", total: -1400, bills: [{ label: "Avalanche payment → Maple Card", amount: -1300, itemId: "avalanche:extra" }], balance: 900 }];
const dayTotals = new Map([["2026-11-12", { moneyIn: 0, moneyOut: -1400 }], ["2026-11-13", { moneyIn: 2450, moneyOut: 0 }]]);
const props = {
  data,
  cashBuffer: 500,
  lowestPoint: { x: "2026-11-12", y: 900, rawDate: "2026-11-12" },
  bigBillMarkers,
  eventsByDate: new Map([["2026-11-12", [{ label: "Avalanche payment → Maple Card", amount: -1300, itemId: "avalanche:extra", dragged: true, originalDate: "2026-11-05" }]]]),
  onJumpToPlan: () => {},
  onMarkMissed: () => {},
  variant: "expanded" as const,
  todayISO: "2026-11-10",
  markers,
  dayTotals,
  onSelectDate: () => {},
};

afterEach(() => { cleanup(); areas.length = 0; tooltipAt = null; vi.useRealTimers(); });

describe("ProjectedBalanceChart — calm (readable forecast)", () => {
  it("rests with small payday ticks only: no bill / card / debt marker, no count, no big-bill ring", () => {
    render(<ProjectedBalanceChart {...props} calm />);
    expect(screen.getByTestId("payday-tick-2026-11-13")).toBeTruthy();
    expect(screen.queryByTestId("marker-2026-11-11")).toBeNull();
    expect(screen.queryByTestId("marker-2026-11-12")).toBeNull();
    expect(screen.queryByTestId("big-bill-marker-2026-11-12")).toBeNull();
    // The single low-point label and the lines the reader needs stay.
    expect(screen.getByTestId("ref-lowest-point")).toBeTruthy();
    expect(screen.getByTestId("ref-today")).toBeTruthy();
    expect(screen.getByTestId("ref-cash-buffer")).toBeTruthy();
  });

  it("the selected day still draws its own marker (no count on it)", () => {
    render(<ProjectedBalanceChart {...props} calm selectedDate="2026-11-12" />);
    const m = screen.getByTestId("marker-2026-11-12");
    expect(m.getAttribute("data-kind")).toBe("debt");
    expect(m.textContent).toBe("");
    expect(screen.getByTestId("ref-selected-day")).toBeTruthy();
  });

  it("'Show bills' brings back the full chart: the big-bill ring and the payday / big-bill markers", () => {
    render(<ProjectedBalanceChart {...props} calm showBills />);
    expect(screen.getByTestId("big-bill-marker-2026-11-12")).toBeTruthy();
    // No count on the low point's own day: it would sit on the "Lowest …" words, which already name the day.
    expect(screen.getByTestId("marker-2026-11-12").textContent).toBe("");
    expect(screen.getByTestId("marker-2026-11-13")).toBeTruthy();
    expect(screen.queryByTestId("payday-tick-2026-11-13")).toBeNull();
  });

  it("off (default) the expanded chart is unchanged: markers and rings as before", () => {
    render(<ProjectedBalanceChart {...props} />);
    expect(screen.getByTestId("big-bill-marker-2026-11-12")).toBeTruthy();
    expect(screen.getByTestId("marker-2026-11-12").textContent).toBe("2");
    expect(screen.getByTestId("marker-2026-11-13")).toBeTruthy();
    expect(screen.queryByTestId("payday-tick-2026-11-13")).toBeNull();
  });

  it("the calm tooltip is the date, the balance and In / Out — no names, no buttons", () => {
    tooltipAt = { rawDate: "2026-11-12", balance: 900 };
    render(<ProjectedBalanceChart {...props} calm />);
    const tip = screen.getByTestId("tooltip-calm");
    expect(tip.getAttribute("data-date")).toBe("2026-11-12");
    expect(tip.textContent).toBe("Nov 12, 2026Balance$900.00In $0.00 · Out $1,400.00");
    expect(tip.querySelector("button")).toBeNull();
    cleanup();
    // The full tooltip (off) still lists the dragged plan with its Mark missed.
    render(<ProjectedBalanceChart {...props} />);
    expect(screen.queryByTestId("tooltip-calm")).toBeNull();
    expect(screen.getByTestId("tooltip-mark-missed-avalanche:extra-2026-11-05")).toBeTruthy();
  });

  it("toggling 'Show bills' never restarts the draw", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ProjectedBalanceChart {...props} calm />);
    act(() => { vi.advanceTimersByTime(5000); });
    const last = () => areas[areas.length - 1].isAnimationActive;
    expect(last()).toBe(false);
    rerender(<ProjectedBalanceChart {...props} calm showBills />);
    expect(last()).toBe(false);
    rerender(<ProjectedBalanceChart {...props} calm showBills={false} selectedDate="2026-11-13" />);
    expect(last()).toBe(false);
  });
});
