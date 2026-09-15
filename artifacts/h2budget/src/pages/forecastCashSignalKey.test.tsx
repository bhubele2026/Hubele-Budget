import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { formatDate } from "@/lib/utils";

/**
 * (Owner decision 16, PR-K round 2 M1) ONE CACHE ENTRY FOR ONE DAY'S BALANCE.
 *
 * The Forecast page used to send `fromDate: <browser today>` on every request.
 * Its 90-day tab therefore cached under a different key from Forecast
 * Overview, the nav/landing prefetch and the Reports → Cash flow card, which
 * all ask for `{ horizonDays: 90 }`. After a background (webhook) bank sync,
 * the two entries could each stay "fresh" for 5 minutes with two different
 * balances for the same day. With look-back closed the page now leaves
 * `fromDate` out, so the server uses the household day and the keys match.
 * `cashFlowForecastMissing.test.tsx` pins the card's side of the same key.
 */

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
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});

vi.mock("recharts", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    ResponsiveContainer: Stub,
    AreaChart: Stub,
    Area: Stub,
    XAxis: Stub,
    YAxis: Stub,
    CartesianGrid: Stub,
    Tooltip: Stub,
    ReferenceLine: Stub,
    ReferenceDot: Stub,
    Label: Stub,
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: () => {} }),
}));

const calls = vi.hoisted(() => ({
  /** Every params object the page passed to `useGetForecastCashSignal`, in order. */
  params: [] as unknown[],
  signal: undefined as unknown,
}));

const FORECAST_BASE = {
  fromDate: "2026-05-01",
  toDate: "2026-08-01",
  events: [{ itemId: "rent", date: "2026-05-10", label: "Rent", amount: -1500 }],
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
  return {
    useGetForecast: () => ({ data: FORECAST_BASE, isLoading: false }),
    useGetForecastCashSignal: (params: unknown) => {
      calls.params.push(params);
      return { data: calls.signal, isLoading: false };
    },
    useUpsertForecastResolution: noopMutation,
    useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation,
    useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation,
    useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation,
    useRefreshForecastBank: noopMutation,
    useListCategories: () => ({ data: [], isLoading: false }),
    useListDebts: () => ({ data: [], isLoading: false }),
    useListRecurringItems: () => ({ data: [], isLoading: false }),
    useCreateRecurringItem: noopMutation,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    getGetForecastQueryKey: () => ["forecast"],
    getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
    getListRecurringItemsQueryKey: () => ["recurring-items"],
    getGetBillsSummaryQueryKey: () => ["bills-summary"],
    getGetDashboardQueryKey: () => ["dashboard"],
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    getForecastAvalancheSchedule: async () => ({}),
    getGetForecastAvalancheScheduleQueryKey: () => ["avalanche-schedule"],
  };
});

vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    state: "cold",
    error: null,
    updatedAt: null,
    refetch: () => {},
  }),
}));

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

function lastParams(): unknown {
  return calls.params[calls.params.length - 1];
}

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  calls.params = [];
  calls.signal = undefined;
});

describe("Forecast page — its cash-signal request shares the one cache key (decision 16, PR-K round 2 M1)", () => {
  it("90-day tab, look-back closed: exactly { horizonDays: 90 }, the key Forecast Overview, the prefetch and the Cash flow card use", () => {
    sessionStorage.setItem("h2budget:forecastHorizonDays", "90");
    renderPage();
    expect(calls.params.length).toBeGreaterThan(0);
    for (const params of calls.params) {
      // toStrictEqual: a `fromDate: undefined` key would fail too.
      expect(params).toStrictEqual({ horizonDays: 90 });
    }
  });

  it("the default 30-day tab, look-back closed, sends no fromDate either", () => {
    renderPage();
    expect(calls.params.length).toBeGreaterThan(0);
    for (const params of calls.params) {
      expect(params).toStrictEqual({ horizonDays: 30 });
    }
  });

  it("an open look-back still sends its start date", () => {
    sessionStorage.setItem("h2budget:forecastHorizonDays", "90");
    sessionStorage.setItem("h2budget:forecastLookbackOpen", "true");
    sessionStorage.setItem("h2budget:forecastFromDate", "2026-05-01");
    renderPage();
    expect(lastParams()).toStrictEqual({ horizonDays: 90, fromDate: "2026-05-01" });
  });

  it("closing look-back drops the date, back onto the shared key", () => {
    sessionStorage.setItem("h2budget:forecastHorizonDays", "90");
    sessionStorage.setItem("h2budget:forecastLookbackOpen", "true");
    sessionStorage.setItem("h2budget:forecastFromDate", "2026-05-01");
    renderPage();
    fireEvent.click(screen.getByTestId("toggle-forecast-lookback"));
    expect(lastParams()).toStrictEqual({ horizonDays: 90 });
  });

  it("'Bank before' names the day its figure was computed for (the response's fromDate), not the browser's own day", () => {
    calls.signal = {
      bankToday: "1000.00",
      lowestProjected: "900.00",
      lowestDate: "2026-05-20",
      cashBuffer: "100.00",
      status: "ready",
      maxSafeExtra: "800.00",
      snapshotAt: "2026-05-14T12:00:00.000Z",
      snapshotSource: "manual",
      account: { name: "Test Bank", mask: "0001", subtype: "checking", via: "pointer" },
      horizonDays: 90,
      fromDate: "2026-05-14",
      toDate: "2026-08-12",
      startingBalance: "1000.00",
      endingBalance: "900.00",
      endingDate: "2026-08-12",
      projectedIncome: "0.00",
      projectedExpenses: "100.00",
      acceptedImpact: "0.00",
      daily: [
        { date: "2026-05-14", balance: "1000.00" },
        { date: "2026-05-20", balance: "900.00" },
      ],
      events: [],
      matches: [],
      overdueOutsideForecast: [],
      incomeNotArrived: [],
      overdueAssumedPaid: [],
    };
    renderPage();
    expect(document.body.textContent).toContain(`Bank before ${formatDate("2026-05-14")}`);
  });
});
