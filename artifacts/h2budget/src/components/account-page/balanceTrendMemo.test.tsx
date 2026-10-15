import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";

const seen: unknown[] = [];
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children, { width: 800, height: 300 } as object),
    LineChart: (p: React.ComponentProps<typeof actual.LineChart>) => {
      seen.push(p.data);
      return <actual.LineChart {...p} />;
    },
  };
});

import { BalanceTrendChart } from "./balance-trend-chart";

afterEach(() => {
  cleanup();
  seen.length = 0;
});

describe("the multi-series trend chart keeps its data reference across re-renders", () => {
  const props = () => ({
    caption: "Balance",
    historicalActual: [{ date: "2026-09-06", balance: 100 }, { date: "2026-09-13", balance: 120 }],
    actualFromToday: [{ date: "2026-10-04", balance: 130 }],
    forecastFromToday: [{ date: "2026-10-11", balance: 140 }],
    todayISO: "2026-10-04",
  });

  it("same content, new arrays: the chart gets the very same rows (no restarted draw); new content: new rows", () => {
    const view = render(<BalanceTrendChart {...(props() as unknown as React.ComponentProps<typeof BalanceTrendChart>)} />);
    view.rerender(<BalanceTrendChart {...(props() as unknown as React.ComponentProps<typeof BalanceTrendChart>)} />);
    const rows = seen.filter(Boolean);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[rows.length - 1]).toBe(rows[0]);
    const changed = props();
    changed.forecastFromToday = [{ date: "2026-10-11", balance: 999 }];
    view.rerender(<BalanceTrendChart {...(changed as unknown as React.ComponentProps<typeof BalanceTrendChart>)} />);
    expect(seen[seen.length - 1]).not.toBe(rows[0]);
  });
});
