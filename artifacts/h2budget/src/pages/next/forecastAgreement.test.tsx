import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

vi.mock("wouter", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/components/plaid-reauth-banner", () => ({
  PlaidReauthBanner: () => null,
}));

vi.mock("@/components/ui/tabs", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Tabs: Passthrough,
    TabsList: Passthrough,
    TabsTrigger: Passthrough,
    TabsContent: Passthrough,
  };
});

vi.mock("@dnd-kit/core", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    DndContext: Passthrough,
    DragOverlay: Passthrough,
    PointerSensor: function () {},
    TouchSensor: function () {},
    useSensor: () => ({}),
    useSensors: () => [],
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      isDragging: false,
    }),
    useDroppable: () => ({
      setNodeRef: () => {},
      isOver: false,
    }),
  };
});


// Recharts is stubbed: the AreaChart stub records its rows and renders one
// button per row that fires the chart's own onClick({ activeLabel }), so a test
// can "tap a day" without a layout engine.
let chartRows: Array<Record<string, unknown>> = [];
vi.mock("recharts", () => {
  const Stub = ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => (
    <div data-testid={(rest as { "data-testid"?: string })["data-testid"]}>{children}</div>
  );
  const RefStub = ({ children, x, y, ...rest }: { children?: React.ReactNode; x?: string | number; y?: string | number; [k: string]: unknown }) => (
    <div
      data-testid={(rest as { "data-testid"?: string })["data-testid"]}
      data-x={x !== undefined ? String(x) : undefined}
      data-y={y !== undefined ? String(y) : undefined}
    >
      {children}
    </div>
  );
  const AreaChart = ({ children, data, onClick }: { children?: React.ReactNode; data?: Array<Record<string, unknown>>; onClick?: (s: unknown) => void }) => {
    chartRows = data ?? [];
    return (
      <div data-testid="area-chart">
        {(data ?? []).map((d) => (
          <button key={String(d.rawDate)} type="button" data-testid={`tap-${d.rawDate}`} onClick={() => onClick?.({ activeLabel: d.rawDate })} />
        ))}
        {children}
      </div>
    );
  };
  const Label = ({ value }: { value?: React.ReactNode }) => <span>{value}</span>;
  return {
    ResponsiveContainer: Stub, AreaChart, Area: Stub, XAxis: Stub, YAxis: Stub, CartesianGrid: Stub,
    Tooltip: Stub, ReferenceLine: RefStub, ReferenceDot: RefStub, ReferenceArea: RefStub, Label,
  };
});

const FORECAST_BASE = {
  fromDate: "2026-05-01", toDate: "2026-08-01", events: [], transactions: [], resolutions: [],
  closedMonths: [], monthSnapshots: {}, bankSnapshot: null, plaidCheckingAccounts: [],
  settings: { startingBalance: "1000", cashBuffer: "500" },
};
const SIGNAL = {
  status: "ok", startingBalance: "1000", endingBalance: "1200", endingDate: "2026-06-20", toDate: "2026-06-20",
  fromDate: "2026-06-10", acceptedImpact: "200", projectedIncome: "2000", projectedExpenses: "800",
  lowestProjected: "250.5", lowestDate: "2026-06-15", cashBuffer: "500", horizonDays: 30,
  daily: [
    { date: "2026-06-10", balance: "1000" },
    { date: "2026-06-15", balance: "250.5" },
    { date: "2026-06-20", balance: "2250.5" },
  ],
  events: [
    { date: "2026-06-15", label: "Rent", amount: "-800", itemId: "rent", originalDate: "2026-06-10", occurrenceDate: "2026-06-10" },
    { date: "2026-06-20", label: "Paycheck", amount: "2000", itemId: "pay" },
  ],
};
let cashSignal: unknown = SIGNAL;
vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({ mutate: () => {}, mutateAsync: async () => undefined, isPending: false });
  const empty = { data: [], isLoading: false };
  return {
    useGetForecast: () => ({ data: FORECAST_BASE, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: cashSignal, isLoading: false }),
    useUpsertForecastResolution: noopMutation, useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation, useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation, useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation, useRefreshForecastBank: noopMutation,
    useListCategories: () => empty, useListDebts: () => empty, useListRecurringItems: () => empty,
    useGetAvalancheSettings: () => ({ data: undefined }), useGetAvalancheExtra: () => ({ data: undefined }),
    useCreateRecurringItem: noopMutation,
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    getGetForecastQueryKey: () => ["forecast"], getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
  };
});
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: undefined, isLoading: false, isFetching: false, state: "cold", error: null, updatedAt: null, refetch: () => {} }),
}));

import ForecastPage from "../forecast";
import NextForecastPage from "./Forecast";

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const money = (el: HTMLElement) => (el.textContent ?? "").match(/-?\$[\d,]+(?:\.\d+)?/g) ?? [];
const KPIS = ["kpi-lowest-point", "kpi-ending-balance", "kpi-projected-income", "kpi-projected-expenses"];

beforeEach(() => {
  cleanup();
  cashSignal = SIGNAL;
  chartRows = [];
  try { sessionStorage.clear(); } catch { /* no-op */ }
});

describe("/next/forecast agrees with the classic page", () => {
  it("shows the same summary figures, chart points, past-due rows and day figures from the same data", () => {
    const classic = mount(<ForecastPage />);
    const classicFigures = Object.fromEntries(KPIS.map((k) => [k, money(within(classic.container).getByTestId(k))]));
    const classicPastDue = within(classic.container).getByTestId("dragging-plans-list").textContent;
    cleanup();

    mount(<NextForecastPage />);
    for (const k of KPIS) expect(money(screen.getByTestId(k))).toEqual(classicFigures[k]);

    // Chart points are the cash signal's own daily rows, in order.
    expect(chartRows.map((r) => [r.rawDate, r.balance])).toEqual(
      SIGNAL.daily.map((d) => [d.date, Number(d.balance)]),
    );

    // Past-due register row: same list on the new page's "Month & bank" tab.
    fireEvent.click(screen.getByTestId("tab-plan"));
    expect(screen.getByTestId("dragging-plans-list").textContent).toBe(classicPastDue);

    // The selected day: close = the chart point, rent = the register row, pay = the event.
    fireEvent.click(screen.getByTestId("tap-2026-06-15"));
    expect(screen.getByTestId("day-close").textContent).toBe("$250.50");
    expect(screen.getByTestId("day-opening").textContent).toBe("$1,000.00");
    expect(screen.getByTestId("day-out-bill").textContent).toBe("-$800.00");
    expect(screen.getByTestId("day-event-rent").textContent).toContain("Rent");
    expect(screen.getByTestId("dragging-plan-rent-2026-06-10")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tap-2026-06-20"));
    expect(screen.getByTestId("day-income").textContent).toBe("$2,000.00");
  });

  it("keeps the selected day across a refetch and a horizon change, and says when it left the window", () => {
    const view = mount(<NextForecastPage />);
    fireEvent.click(screen.getByTestId("tap-2026-06-15"));
    expect(screen.getByTestId("day-panel-date")).toBeTruthy();

    fireEvent.click(screen.getByTestId("horizon-90"));
    expect(screen.getByTestId("day-close").textContent).toBe("$250.50");

    // A refetch brings a window that no longer holds that day.
    cashSignal = { ...SIGNAL, daily: SIGNAL.daily.filter((d) => d.date !== "2026-06-15") };
    fireEvent.click(screen.getByTestId("horizon-120"));
    expect(screen.getByTestId("day-outside-window")).toBeTruthy();
    expect(screen.getByTestId("day-close").textContent).toBe("—");
    view.unmount();
  });

  it("clears the selection with Escape and moves it with the arrow keys", () => {
    mount(<NextForecastPage />);
    const surface = screen.getByTestId("chart-surface");
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(screen.getByTestId("day-panel-date").textContent).toContain("Jun 10");
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(screen.getByTestId("day-panel-date").textContent).toContain("Jun 15");
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(screen.getByTestId("day-panel-empty")).toBeTruthy();
  });

  it("lists every marker kind in the legend and tints risk days", () => {
    mount(<NextForecastPage />);
    for (const k of ["payday", "bill", "card", "debt", "under-buffer", "below-zero"]) {
      expect(screen.getByTestId(`legend-${k}`)).toBeTruthy();
    }
    expect(screen.getAllByTestId("risk-below-buffer").length).toBeGreaterThan(0);
  });
});
