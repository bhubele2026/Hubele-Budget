import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

vi.mock("canvas-confetti", () => ({ default: () => undefined }));

vi.mock("wouter", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/components/plaid-reauth-banner", () => ({
  PlaidReauthBanner: () => null,
}));

vi.mock("@/components/avalanche-ready-card", () => ({
  AvalancheReadyCard: () => null,
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

vi.mock("recharts", () => {
  const Stub = ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    const testId = (rest as { ["data-testid"]?: string })["data-testid"];
    return <div data-testid={testId}>{children}</div>;
  };
  // ReferenceDot/ReferenceLine: expose `x`/`y` props as data-attrs so tests
  // can verify the dot is plotted on the day matching `lowestDate`, not just
  // that the label text contains it.
  const RefStub = ({
    children,
    x,
    y,
    ...rest
  }: {
    children?: React.ReactNode;
    x?: string | number;
    y?: string | number;
    [key: string]: unknown;
  }) => {
    const testId = (rest as { ["data-testid"]?: string })["data-testid"];
    return (
      <div
        data-testid={testId}
        data-x={x !== undefined ? String(x) : undefined}
        data-y={y !== undefined ? String(y) : undefined}
      >
        {children}
      </div>
    );
  };
  const Label = ({ value }: { value?: React.ReactNode }) => (
    <span>{value}</span>
  );
  return {
    ResponsiveContainer: Stub,
    LineChart: Stub,
    Line: Stub,
    AreaChart: Stub,
    Area: Stub,
    BarChart: Stub,
    Bar: Stub,
    ComposedChart: Stub,
    XAxis: Stub,
    YAxis: Stub,
    CartesianGrid: Stub,
    Tooltip: Stub,
    Legend: Stub,
    PieChart: Stub,
    Pie: Stub,
    Cell: Stub,
    PolarAngleAxis: Stub,
    PolarGrid: Stub,
    PolarRadiusAxis: Stub,
    Radar: Stub,
    RadarChart: Stub,
    ReferenceLine: RefStub,
    ReferenceDot: RefStub,
    Label,
  };
});

const FORECAST_BASE = {
  fromDate: "2026-05-01",
  toDate: "2026-08-01",
  events: [],
  transactions: [],
  resolutions: [],
  closedMonths: [],
  monthSnapshots: {},
  bankSnapshot: null,
  plaidCheckingAccounts: [],
  settings: { startingBalance: "1000", cashBuffer: "500" },
};

let cashSignal: unknown = undefined;
let forecastData: unknown = { ...FORECAST_BASE };

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  const empty = { data: [], isLoading: false };
  return {
    useGetForecast: () => ({ data: forecastData, isLoading: false }),
    useGetForecastCashSignal: () => ({
      data: cashSignal,
      isLoading: false,
    }),
    useUpsertForecastResolution: noopMutation,
    useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation,
    useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation,
    useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation,
    useRefreshForecastBank: noopMutation,
    useListCategories: () => empty,
    useListDebts: () => empty,
    useListRecurringItems: () => empty,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    getGetForecastQueryKey: () => ["forecast"],
    getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
  };
});

import ForecastPage from "./forecast";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ForecastPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  forecastData = { ...FORECAST_BASE };
  cashSignal = undefined;
});

describe("Forecast — chart cash-buffer line and lowest-point dot", () => {
  it("renders the buffer reference line and the lowest-point dot label when projection has data", () => {
    cashSignal = {
      status: "ok",
      startingBalance: "1000",
      endingBalance: "1200",
      endingDate: "2026-07-30",
      toDate: "2026-07-30",
      acceptedImpact: "200",
      projectedIncome: "3000",
      projectedExpenses: "1800",
      lowestProjected: "250.5",
      lowestDate: "2026-06-15",
      cashBuffer: "500",
      daily: [
        { date: "2026-05-05", balance: "900" },
        { date: "2026-06-15", balance: "250.5" },
        { date: "2026-07-30", balance: "1200" },
      ],
    };

    renderPage();

    const buffer = screen.getByTestId("ref-cash-buffer");
    expect(buffer).toBeTruthy();
    expect(buffer.textContent ?? "").toContain("Cash buffer");
    expect(buffer.textContent ?? "").toContain("$500");

    const dot = screen.getByTestId("ref-lowest-point");
    expect(dot).toBeTruthy();
    // Placement: the dot's x is the day matching `lowestDate`, and y is the
    // lowest projected amount.
    expect(dot.getAttribute("data-x")).toBe("2026-06-15");
    expect(dot.getAttribute("data-y")).toBe("250.5");
    const dotText = dot.textContent ?? "";
    expect(dotText).toContain("Lowest");
    expect(dotText).toContain("$250.50");
    expect(dotText).toContain("Jun 15, 2026");
  });

  it("omits the buffer line when cashBuffer is not present but still draws the lowest dot", () => {
    cashSignal = {
      status: "ok",
      startingBalance: "1000",
      endingBalance: "1100",
      endingDate: "2026-07-30",
      toDate: "2026-07-30",
      acceptedImpact: "100",
      projectedIncome: "2000",
      projectedExpenses: "1800",
      lowestProjected: "400",
      lowestDate: "2026-06-01",
      // cashBuffer intentionally omitted
      daily: [
        { date: "2026-05-05", balance: "900" },
        { date: "2026-06-01", balance: "400" },
        { date: "2026-07-30", balance: "1100" },
      ],
    };

    renderPage();

    expect(screen.queryByTestId("ref-cash-buffer")).toBeNull();
    expect(screen.getByTestId("ref-lowest-point")).toBeTruthy();
  });

  it("does not render either annotation when there is no projection data", () => {
    cashSignal = {
      status: "no_data",
      startingBalance: "0",
      endingBalance: "0",
      endingDate: null,
      toDate: null,
      acceptedImpact: "0",
      projectedIncome: "0",
      projectedExpenses: "0",
      lowestProjected: null,
      lowestDate: null,
      cashBuffer: "500",
      daily: [],
    };

    renderPage();

    expect(screen.getByTestId("empty-projected-balance")).toBeTruthy();
    expect(screen.queryByTestId("ref-cash-buffer")).toBeNull();
    expect(screen.queryByTestId("ref-lowest-point")).toBeNull();
  });
});
