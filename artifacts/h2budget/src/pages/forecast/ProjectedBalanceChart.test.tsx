import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

// (PR5b review M1) The chart tooltip's "Mark missed" on a dragged plan. For a
// partly-paid plan the dragged event is its unpaid remainder; marking it missed
// would replace the partial server-side and un-pay its row, so the tooltip
// must not offer it.

vi.mock("recharts", () => {
  const Wrap = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Wrap,
    AreaChart: Wrap,
    Area: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
    CartesianGrid: Nothing,
    ReferenceLine: Nothing,
    ReferenceDot: Nothing,
    Label: Nothing,
    // Render the tooltip as if the pointer rested on 05-15.
    Tooltip: ({ content }: { content: (p: unknown) => React.ReactNode }) => (
      <div>{content({ active: true, payload: [{ payload: { rawDate: "2026-05-15", balance: 750 } }] })}</div>
    ),
  };
});
vi.mock("@/lib/charts", async () => {
  const tokens = await vi.importActual<Record<string, unknown>>("@/lib/chartTokens");
  return { ...tokens, useXTicks: () => [] };
});

import { ProjectedBalanceChart, type DayEvent } from "./ProjectedBalanceChart";

type Props = Parameters<typeof ProjectedBalanceChart>[0];

const events = new Map<string, DayEvent[]>([
  [
    "2026-05-15",
    [
      { label: "Rent", amount: -250, itemId: "rent2", dragged: true, originalDate: "2026-05-13" },
      { label: "Gym", amount: -40, itemId: "gym", dragged: true, originalDate: "2026-05-12" },
    ],
  ],
]);
const data = [
  { date: "05-14", rawDate: "2026-05-14", balance: 1000 },
  { date: "05-15", rawDate: "2026-05-15", balance: 750 },
] as unknown as Props["data"];

function show(lockedPlanKeys?: ReadonlySet<string>) {
  const onMarkMissed = vi.fn();
  render(
    <ProjectedBalanceChart
      data={data}
      cashBuffer={500}
      lowestPoint={null}
      bigBillMarkers={[]}
      eventsByDate={events}
      onJumpToPlan={() => {}}
      onMarkMissed={onMarkMissed}
      lockedPlanKeys={lockedPlanKeys}
    />,
  );
  return onMarkMissed;
}

afterEach(cleanup);

describe("ProjectedBalanceChart tooltip — Mark missed on dragged plans", () => {
  it("offers no Mark missed for a partly-paid plan's remainder; another dragged plan keeps it", () => {
    const onMarkMissed = show(new Set(["rent2|2026-05-13"]));
    expect(screen.queryByTestId("tooltip-mark-missed-rent2-2026-05-13")).toBeNull();
    fireEvent.click(screen.getByTestId("tooltip-mark-missed-gym-2026-05-12"));
    expect(onMarkMissed).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "gym", originalDate: "2026-05-12" }),
    );
  });

  it("control: with no locked plans both dragged plans offer Mark missed", () => {
    show();
    expect(screen.getByTestId("tooltip-mark-missed-rent2-2026-05-13")).toBeTruthy();
    expect(screen.getByTestId("tooltip-mark-missed-gym-2026-05-12")).toBeTruthy();
  });
});
