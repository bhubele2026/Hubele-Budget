import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, screen, fireEvent } from "@testing-library/react";
import React from "react";

// ⭐ (Readable forecast) The calm chart: bills / cards / debts and the big-bill rings wait for "Show bills", the
// tooltip is date · balance · In / Out, and toggling never restarts the draw.
// ⭐ (Clean forecast line) With the bills hidden it is ONE solid navy line, paydays as ticks on the bottom edge,
// horizontal grid lines only and three plated labels; it sweeps in once per session, never remounts on a horizon
// change, and its hover dot / hairline glide — none of it under reduced motion. Invented figures.
const areas: Array<Record<string, unknown>> = [];
const grids: Array<Record<string, unknown>> = [];
const lines: Array<Record<string, unknown>> = [];
const tips: Array<Record<string, unknown>> = [];
let tooltipAt: { rawDate: string; balance: number } | null = null;
vi.mock("recharts", () => {
  const Wrap = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Wrap, AreaChart: Wrap, XAxis: Nothing, YAxis: Nothing,
    CartesianGrid: (p: Record<string, unknown>) => { grids.push(p); return null; },
    // A label with `content` paints it (the plated labels); a plain one is its words.
    Label: (p: { value?: string; content?: (a: unknown) => React.ReactNode }) =>
      p.content ? <svg>{p.content({ viewBox: { x: 60, y: 14, width: 300, height: 0, cx: 100, cy: 100 } })}</svg> : <span>{p.value}</span>,
    Area: (p: Record<string, unknown>) => { areas.push(p); return null; },
    ReferenceLine: (p: Record<string, unknown> & { children?: React.ReactNode }) => {
      lines.push(p);
      return <i data-testid={String(p["data-testid"] ?? "ref")}>{p.children}</i>;
    },
    ReferenceArea: (p: Record<string, unknown>) => <i data-testid={String(p["data-testid"])} />,
    // A dot with a `shape` draws it (the kind markers, the payday ticks, the pulse); a plain one is its test id.
    ReferenceDot: (p: { shape?: (a: { cx: number; cy: number }) => React.ReactNode; y?: number; children?: React.ReactNode; [k: string]: unknown }) =>
      p.shape ? <svg data-y={String(p.y)}>{p.shape({ cx: 10, cy: 10 })}</svg> : <i data-testid={String(p["data-testid"] ?? "dot")}>{p.children}</i>,
    // The tooltip paints its card for `tooltipAt`, and its cursor the way the library hands it the active day.
    Tooltip: (p: { content: (a: unknown) => React.ReactNode; cursor?: React.ReactElement; [k: string]: unknown }) => {
      tips.push(p);
      if (!tooltipAt) return null;
      const payload = [{ payload: tooltipAt }];
      return (
        <div>
          {p.content({ active: true, payload })}
          {p.cursor ? <svg>{React.cloneElement(p.cursor, { points: [{ x: 120, y: 14 }, { x: 120, y: 314 }], payload } as object)}</svg> : null}
        </div>
      );
    },
  };
});
vi.mock("@/lib/charts", async () => {
  const kit = await vi.importActual<Record<string, unknown>>("@/lib/charts");
  return { ...kit, useXTicks: () => [] };
});

import { LINE_SLOTS, linePads, ProjectedBalanceChart } from "./ProjectedBalanceChart";
import type { MarkerGroup } from "@/lib/forecastEventKinds";
import { CHART, DRAW_MS, MORPH_MS, niceAxis, PULSE_MS } from "@/lib/chartTokens";

/** The axis the chart draws these figures on (its own helper; $0 up to the rounded top). */
const [AXIS_LO, AXIS_HI] = niceAxis(0, 3350).domain;

const DAYS = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
const data = DAYS.map((rawDate, i) => ({ date: rawDate.slice(5), rawDate, balance: [2400, 2300, 900, 3350][i] }));
/** Another horizon's answer: more days, another shape. */
const longer = [...DAYS, "2026-11-14", "2026-11-15"].map((rawDate, i) => ({ date: rawDate.slice(5), rawDate, balance: [2400, 2300, 900, 3350, 3100, 2750][i] }));
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

/** The test setup answers "reduce" to every media query; this turns motion ON for one test. */
function motionOn() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as unknown as MediaQueryList,
  );
}
const last = () => areas[areas.length - 1]!;
const wrapper = (c: HTMLElement) => c.firstElementChild as HTMLElement;

afterEach(() => { cleanup(); areas.length = 0; grids.length = 0; lines.length = 0; tips.length = 0; tooltipAt = null; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("ProjectedBalanceChart — calm (readable forecast)", () => {
  it("rests clean: no bill / card / debt marker, no count, no big-bill ring", () => {
    render(<ProjectedBalanceChart {...props} calm />);
    expect(screen.getByTestId("payday-tick-2026-11-13")).toBeTruthy();
    expect(screen.queryByTestId("marker-2026-11-11")).toBeNull();
    expect(screen.queryByTestId("marker-2026-11-12")).toBeNull();
    expect(screen.queryByTestId("marker-2026-11-13")).toBeNull();
    expect(screen.queryByTestId("big-bill-marker-2026-11-12")).toBeNull();
    // The single low-point label and the lines the reader needs stay.
    expect(screen.getByTestId("ref-lowest-point")).toBeTruthy();
    expect(screen.getByTestId("ref-today")).toBeTruthy();
    expect(screen.getByTestId("ref-cash-buffer")).toBeTruthy();
  });

  it("(Clean forecast line) ONE solid navy line over the soft navy fill — no dashes, no past / future split", () => {
    render(<ProjectedBalanceChart {...props} calm todayISO="2026-11-12" />);
    // One series for the whole window, look-back days included (today is the third day here).
    expect(areas.map((a) => a.dataKey)).toEqual(["balance"]);
    expect(last().stroke).toBe(CHART.navy);
    expect(last().strokeWidth).toBe(1.75); // (2026-11-12) restrained line weight
    expect(last().strokeDasharray).toBeUndefined();
    expect(last().fill).toBe("url(#projectedBalanceGrad)");
    expect(last().name).toBe("Balance");
    // The "Today" rule marks the split.
    expect(lines.find((l) => l["data-testid"] === "ref-today")!.x).toBe("2026-11-12");
  });

  it("(Clean forecast line) paydays are ticks on the plot's bottom edge, each still selecting its day", () => {
    const pick = vi.fn();
    render(<ProjectedBalanceChart {...props} calm onSelectDate={pick} />);
    const tick = screen.getByTestId("payday-tick-2026-11-13");
    expect(tick.getAttribute("data-edge")).toBe("bottom");
    // Placed at the axis's own lowest value ($0 here), never at the day's balance on the line.
    expect(AXIS_LO).toBe(0);
    expect(tick.closest("svg")!.getAttribute("data-y")).toBe(String(AXIS_LO));
    expect(tick.querySelector("path")).toBeNull(); // no triangle
    expect(tick.querySelector("line")).toBeTruthy();
    fireEvent.click(tick);
    expect(pick).toHaveBeenCalledWith("2026-11-13");
    // The tick stays when its day is the selected one (the line's marker and the edge tick do not collide).
    cleanup();
    render(<ProjectedBalanceChart {...props} calm selectedDate="2026-11-13" />);
    expect(screen.getByTestId("payday-tick-2026-11-13")).toBeTruthy();
  });

  it("(Clean forecast line) horizontal grid lines only; the cushion rule is thin; exactly three plated labels", () => {
    render(<ProjectedBalanceChart {...props} calm />);
    expect(grids).toHaveLength(1);
    expect(grids[0]!.vertical).toBe(false);
    expect(grids[0]!.strokeDasharray).toBeUndefined();
    const rule = lines.find((l) => l["data-testid"] === "ref-cash-buffer")!;
    expect(rule.strokeWidth).toBe(1);
    expect(rule.stroke).toBe(CHART.orangeDeep);
    expect(rule.strokeDasharray).toBeTruthy();
    expect(screen.getByTestId("chart-today-plate").textContent).toBe("Today");
    expect(screen.getByTestId("chart-cushion-plate").textContent).toBe("Cushion $500.00");
    expect(screen.getByTestId("chart-low-plate").textContent).toBe("Low $900.00 · Nov 12");
    expect(document.querySelectorAll("[data-testid$='-plate']")).toHaveLength(3);
    // Each plate is the panel's surface token, never a colour literal.
    for (const r of document.querySelectorAll("[data-testid$='-plate'] rect")) expect(r.getAttribute("style")).toContain("fill: var(--color-platinum-0)");
    expect(document.body.textContent).not.toContain("Cash buffer");
  });

  it("the selected day still draws its own marker (no count on it)", () => {
    render(<ProjectedBalanceChart {...props} calm selectedDate="2026-11-12" />);
    const m = screen.getByTestId("marker-2026-11-12");
    expect(m.getAttribute("data-kind")).toBe("debt");
    expect(m.textContent).toBe("");
    expect(screen.getByTestId("ref-selected-day")).toBeTruthy();
  });

  it("'Show bills' brings back the full chart: the split line, the dashed grid, the big-bill ring and the markers on the line", () => {
    render(<ProjectedBalanceChart {...props} calm showBills />);
    expect(screen.getByTestId("big-bill-marker-2026-11-12")).toBeTruthy();
    // No count on the low point's own day: it would sit on the "Lowest …" words, which already name the day.
    expect(screen.getByTestId("marker-2026-11-12").textContent).toBe("");
    expect(screen.getByTestId("marker-2026-11-13")).toBeTruthy();
    expect(screen.queryByTestId("payday-tick-2026-11-13")).toBeNull();
    expect(areas.map((a) => a.dataKey)).toEqual(["past", "future"]);
    expect(areas[1]!.strokeDasharray).toBe("6 4");
    expect(grids[0]!.strokeDasharray).toBe("3 3");
    expect(grids[0]!.vertical).toBeUndefined();
    expect(lines.find((l) => l["data-testid"] === "ref-cash-buffer")!.strokeWidth).toBe(1.5);
    expect(screen.getByTestId("ref-cash-buffer").textContent).toBe("Cash buffer $500.00");
    expect(screen.queryByTestId("chart-today-plate")).toBeNull();
    expect(screen.getByTestId("chart-low-plate").textContent).toBe("Lowest $900.00 · Nov 12, 2026");
  });

  it("off (default) the expanded chart is unchanged: markers and rings as before", () => {
    const { container } = render(<ProjectedBalanceChart {...props} horizonKey={90} />);
    expect(screen.getByTestId("big-bill-marker-2026-11-12")).toBeTruthy();
    expect(screen.getByTestId("marker-2026-11-12").textContent).toBe("2");
    expect(screen.getByTestId("marker-2026-11-13")).toBeTruthy();
    expect(screen.queryByTestId("payday-tick-2026-11-13")).toBeNull();
    expect(areas.map((a) => a.dataKey)).toEqual(["past", "future"]);
    expect(grids[0]!.strokeDasharray).toBe("3 3");
    expect(wrapper(container).className).toContain("chart-in area-draw");
    expect(wrapper(container).className).not.toContain("draw-once");
    expect(tips[0]!.cursor).toBeUndefined();
    expect(screen.queryByTestId("low-pulse")).toBeNull();
  });

  it("the calm tooltip is the date, the balance and In / Out — no names, no buttons", () => {
    tooltipAt = { rawDate: "2026-11-12", balance: 900 };
    render(<ProjectedBalanceChart {...props} calm />);
    const tip = screen.getByTestId("tooltip-calm");
    expect(tip.getAttribute("data-date")).toBe("2026-11-12");
    expect(tip.textContent).toBe("Nov 12, 2026Balance$900.00In $0.00 · Out $1,400.00");
    expect(tip.querySelector("button")).toBeNull();
    cleanup();
    // A payday: the same three lines, money in first. A day with nothing moving: date and balance only.
    tooltipAt = { rawDate: "2026-11-13", balance: 3350 };
    render(<ProjectedBalanceChart {...props} calm />);
    expect(screen.getByTestId("tooltip-calm").textContent).toBe("Nov 13, 2026Balance$3,350.00In $2,450.00 · Out $0.00");
    cleanup();
    tooltipAt = { rawDate: "2026-11-11", balance: 2300 };
    render(<ProjectedBalanceChart {...props} calm showBills />);
    expect(screen.getByTestId("tooltip-calm").textContent).toBe("Nov 11, 2026Balance$2,300.00");
    cleanup();
    // The full tooltip (off) still lists the dragged plan with its Mark missed.
    tooltipAt = { rawDate: "2026-11-12", balance: 900 };
    render(<ProjectedBalanceChart {...props} />);
    expect(screen.queryByTestId("tooltip-calm")).toBeNull();
    expect(screen.getByTestId("tooltip-mark-missed-avalanche:extra-2026-11-05")).toBeTruthy();
  });

  it("(Clean forecast line) hover: a dot ON the line and a hairline, moved by transform so they glide", () => {
    motionOn();
    tooltipAt = { rawDate: "2026-11-12", balance: 900 };
    render(<ProjectedBalanceChart {...props} calm />);
    const hair = screen.getByTestId("hover-hairline");
    const dot = screen.getByTestId("hover-dot");
    expect(hair.getAttribute("class")).toBe("chart-glide");
    expect(dot.getAttribute("class")).toBe("chart-glide");
    expect(hair.style.transform).toBe("translateX(120px)");
    // $900 on the chart's own axis, drawn from y=14 to y=314.
    expect(dot.style.transform).toBe(`translate(120px, ${14 + ((AXIS_HI - 900) / (AXIS_HI - AXIS_LO)) * 300}px)`);
    // The card follows, briefly; the library's own jumping dot is off.
    expect(tips.at(-1)!.isAnimationActive).toBe(true);
    expect(tips.at(-1)!.animationDuration).toBe(160);
    expect(last().activeDot).toBe(false);
  });

  it("toggling 'Show bills' never restarts the draw", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ProjectedBalanceChart {...props} calm />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(last().isAnimationActive).toBe(false);
    rerender(<ProjectedBalanceChart {...props} calm showBills />);
    expect(last().isAnimationActive).toBe(false);
    rerender(<ProjectedBalanceChart {...props} calm showBills={false} selectedDate="2026-11-13" />);
    expect(last().isAnimationActive).toBe(false);
  });
});

describe("ProjectedBalanceChart — calm motion (clean forecast line)", () => {
  it("draws in ONCE: the mask sweep alone on the first mount of a session key, never the library's reveal", () => {
    motionOn();
    const a = render(<ProjectedBalanceChart {...props} calm sessionKey="calm-once-a" />);
    expect(wrapper(a.container).className).toContain("area-draw draw-once");
    // One effect, not two: no wrapper rise, and the series does not animate its own first draw.
    expect(wrapper(a.container).className).not.toContain("chart-in");
    expect(areas.every((p) => p.isAnimationActive === false)).toBe(true);
    a.unmount();
    // Back on the page in the same session: no sweep, no pulse.
    const b = render(<ProjectedBalanceChart {...props} calm sessionKey="calm-once-a" />);
    expect(wrapper(b.container).className).not.toContain("area-draw");
    expect(screen.queryByTestId("low-pulse")).toBeNull();
    b.unmount();
    const c = render(<ProjectedBalanceChart {...props} calm sessionKey="calm-once-b" />);
    expect(wrapper(c.container).className).toContain("area-draw draw-once");
  });

  it("no replay on Show bills, a selected day, or a refetch that answers the same numbers", () => {
    motionOn();
    vi.useFakeTimers();
    const a = render(<ProjectedBalanceChart {...props} calm sessionKey="calm-replay" horizonKey={90} />);
    const node = wrapper(a.container);
    const cls = node.className;
    for (const next of [
      { showBills: true },
      { showBills: false, selectedDate: "2026-11-12" },
      { data: data.map((d) => ({ ...d })) }, // a refetch: new objects, the same numbers
    ]) {
      a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-replay" horizonKey={90} {...next} />);
      expect(wrapper(a.container)).toBe(node); // the same node: a CSS animation cannot restart on it
      expect(node.className).toBe(cls);
      expect(last().isAnimationActive).toBe(false);
    }
  });

  it("a horizon change does NOT remount: the same node, no re-sweep, and the line reshapes for MORPH_MS", () => {
    motionOn();
    vi.useFakeTimers();
    const a = render(<ProjectedBalanceChart {...props} calm sessionKey="calm-horizon" horizonKey={30} />);
    const node = wrapper(a.container);
    // The horizon is picked (the key changes) while the last curve is still the one on screen.
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-horizon" horizonKey={90} />);
    expect(wrapper(a.container)).toBe(node);
    expect(last().isAnimationActive).toBe(false);
    // The new horizon answers: the series reshapes from the old curve.
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-horizon" horizonKey={90} data={longer} />);
    expect(wrapper(a.container)).toBe(node);
    expect(node.className).toContain("area-draw draw-once");
    expect(last().isAnimationActive).toBe(true);
    expect(last().animationDuration).toBe(MORPH_MS);
    act(() => { vi.advanceTimersByTime(MORPH_MS + 200); });
    expect(last().isAnimationActive).toBe(false);
    // …and a selected day afterwards starts nothing.
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-horizon" horizonKey={90} data={longer} selectedDate="2026-11-14" />);
    expect(last().isAnimationActive).toBe(false);
    // Back to the first horizon: it reshapes again. Toggling the bills in the middle of a reshape ends it for
    // good (a swapped-in series must never draw itself in), on and off.
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-horizon" horizonKey={30} />);
    expect(last().isAnimationActive).toBe(true);
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-horizon" horizonKey={30} showBills />);
    expect(areas.slice(-2).every((p) => p.isAnimationActive === false)).toBe(true);
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-horizon" horizonKey={30} />);
    expect(last().isAnimationActive).toBe(false);
    // The non-calm expanded chart still remounts per horizon, as before.
    cleanup();
    const b = render(<ProjectedBalanceChart {...props} horizonKey={30} />);
    const before = wrapper(b.container);
    b.rerender(<ProjectedBalanceChart {...props} horizonKey={90} />);
    expect(wrapper(b.container)).not.toBe(before);
  });

  it("(Motion pass) the line keeps its place among the chart's children however many tints the data draws", () => {
    // The chart library keys the line by its position. One more tint ahead of it used to move it one place,
    // which threw the line away and drew it again from the left edge on a refresh or a new horizon.
    const ahead = (c: HTMLElement) =>
      c.querySelectorAll("[data-testid='risk-below-buffer'], [data-testid='risk-below-zero'], [data-testid='ref-zero'], [data-line-slot]").length;
    const a = render(<ProjectedBalanceChart {...props} calm riskShading sessionKey="calm-slots" />);
    expect(a.container.querySelectorAll("[data-testid='risk-below-buffer']").length).toBe(0);
    expect(ahead(a.container)).toBe(LINE_SLOTS);
    // The same days, now under the cushion once.
    const dips = data.map((d, i) => (i === 2 ? { ...d, balance: 300 } : d));
    a.rerender(<ProjectedBalanceChart {...props} calm riskShading sessionKey="calm-slots" data={dips} />);
    expect(a.container.querySelectorAll("[data-testid='risk-below-buffer']").length).toBe(1);
    expect(ahead(a.container)).toBe(LINE_SLOTS);
    // Under zero as well: a second tint and the zero rule.
    const under = data.map((d, i) => (i === 2 ? { ...d, balance: -200 } : d));
    a.rerender(<ProjectedBalanceChart {...props} calm riskShading sessionKey="calm-slots" data={under} />);
    expect(a.container.querySelectorAll("[data-testid='risk-below-zero']").length).toBe(1);
    expect(a.container.querySelectorAll("[data-testid='ref-zero']").length).toBe(1);
    expect(ahead(a.container)).toBe(LINE_SLOTS);
    expect(linePads(0)).toBe(LINE_SLOTS);
    expect(linePads(LINE_SLOTS + 5)).toBe(0);
    // The classic expanded chart remounts per horizon anyway: no held places there.
    cleanup();
    const b = render(<ProjectedBalanceChart {...props} riskShading />);
    expect(b.container.querySelectorAll("[data-line-slot]").length).toBe(0);
  });

  it("the low point pulses ONCE after the first draw, then the ring is gone for good", () => {
    motionOn();
    vi.useFakeTimers();
    const a = render(<ProjectedBalanceChart {...props} calm sessionKey="calm-pulse" />);
    const ring = screen.getByTestId("low-pulse");
    expect(ring.getAttribute("class")).toBe("low-pulse");
    // A re-render while it plays keeps the same node (the keyframe cannot restart).
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-pulse" selectedDate="2026-11-13" />);
    expect(screen.getByTestId("low-pulse")).toBe(ring);
    act(() => { vi.advanceTimersByTime(DRAW_MS + PULSE_MS + 250); });
    expect(screen.queryByTestId("low-pulse")).toBeNull();
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-pulse" data={longer} />);
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-pulse" data={longer} showBills />);
    expect(screen.queryByTestId("low-pulse")).toBeNull();
  });

  it("reduced motion: no pulse, no glide transition, no reshape animation, no card animation", () => {
    // The test setup's matchMedia answers "reduce".
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    tooltipAt = { rawDate: "2026-11-12", balance: 900 };
    const a = render(<ProjectedBalanceChart {...props} calm sessionKey="calm-reduced" />);
    expect(screen.queryByTestId("low-pulse")).toBeNull();
    expect(document.querySelector(".low-pulse")).toBeNull();
    // The hover dot and hairline are still there, placed at once.
    expect(screen.getByTestId("hover-dot").getAttribute("class")).toBeNull();
    expect(screen.getByTestId("hover-hairline").getAttribute("class")).toBeNull();
    expect(document.querySelector(".chart-glide")).toBeNull();
    expect(tips.at(-1)!.isAnimationActive).toBe(false);
    a.rerender(<ProjectedBalanceChart {...props} calm sessionKey="calm-reduced" data={longer} />);
    expect(last().isAnimationActive).toBe(false);
  });
});
