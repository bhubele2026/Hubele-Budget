import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #418 — The Forecast page hard-floors its "Forecast from" date at
// 2026-05-01 (the app's start date) so planned items earlier in the month
// don't slide off the top of the register. This test guards that anchor.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

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
  const Stub = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
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
    ReferenceLine: Stub,
    ReferenceDot: Stub,
    Label: ({ value }: { value?: React.ReactNode }) => <span>{value}</span>,
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
  settings: { startingBalance: "5000", cashBuffer: "500" },
};

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  const empty = { data: [], isLoading: false };
  return {
    useGetForecast: () => ({ data: FORECAST_BASE, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: undefined, isLoading: false }),
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
    useCreateRecurringItem: noopMutation,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    getGetForecastQueryKey: () => ["forecast"],
    getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
    getListRecurringItemsQueryKey: () => ["recurring-items"],
    getGetBillsSummaryQueryKey: () => ["bills-summary"],
    getGetDashboardQueryKey: () => ["dashboard"],
    // AvalancheScheduleCard renders inside ForecastPage's loaded branch and
    // calls useGetForecastAvalancheSchedule at render; the refresh handler
    // also reaches for the imperative fetcher + query-key helper.
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    getForecastAvalancheSchedule: async () => ({}),
    getGetForecastAvalancheScheduleQueryKey: () => ["avalanche-schedule"],
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

const FORECAST_FROM_KEY = "h2budget:forecastFromDate";
const FORECAST_LOOKBACK_OPEN_KEY = "h2budget:forecastLookbackOpen";
const MIN_FROM = "2026-05-01";

beforeEach(() => {
  cleanup();
  try {
    sessionStorage.clear();
  } catch {
    /* no-op */
  }
  // The "Forecast from" input now lives inside the collapsible Look-back
  // panel, which is closed by default; open it so the input renders. Opening
  // it (wasOpen=true) is also what tells ForecastPage to honor a stored
  // start date instead of snapping forward to today.
  try {
    sessionStorage.setItem(FORECAST_LOOKBACK_OPEN_KEY, "true");
  } catch {
    /* no-op */
  }
  // Pin "today" to the app start date so the empty-storage default
  // (todayISO()) equals the MIN_FROM floor this test asserts against.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${MIN_FROM}T12:00:00.000Z`));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Forecast — 'Forecast from' anchored at 2026-05-01 (#418)", () => {
  it("defaults to 2026-05-01 on first load when sessionStorage is empty", () => {
    renderPage();
    const input = screen.getByTestId(
      "input-forecast-from",
    ) as HTMLInputElement;
    expect(input.value).toBe(MIN_FROM);
  });

  it("clamps a stored sessionStorage value earlier than 2026-05-01 up to 2026-05-01", () => {
    sessionStorage.setItem(FORECAST_FROM_KEY, "2026-04-15");
    renderPage();
    const input = screen.getByTestId(
      "input-forecast-from",
    ) as HTMLInputElement;
    expect(input.value).toBe(MIN_FROM);
  });

  it("snaps an earlier picked date back to 2026-05-01", () => {
    renderPage();
    const input = screen.getByTestId(
      "input-forecast-from",
    ) as HTMLInputElement;
    expect(input.value).toBe(MIN_FROM);

    act(() => {
      fireEvent.change(input, { target: { value: "2026-03-10" } });
    });

    const after = screen.getByTestId(
      "input-forecast-from",
    ) as HTMLInputElement;
    expect(after.value).toBe(MIN_FROM);
  });

  it("preserves a stored date on or after 2026-05-01", () => {
    sessionStorage.setItem(FORECAST_FROM_KEY, "2026-06-12");
    renderPage();
    const input = screen.getByTestId(
      "input-forecast-from",
    ) as HTMLInputElement;
    expect(input.value).toBe("2026-06-12");
  });

  it("preserves a picked date on or after 2026-05-01", () => {
    renderPage();
    const input = screen.getByTestId(
      "input-forecast-from",
    ) as HTMLInputElement;

    act(() => {
      fireEvent.change(input, { target: { value: "2026-07-04" } });
    });

    const after = screen.getByTestId(
      "input-forecast-from",
    ) as HTMLInputElement;
    expect(after.value).toBe("2026-07-04");
  });
});
