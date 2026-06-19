import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

// Drive the Radix Select via a plain native <select> so the month
// picker can be exercised end-to-end in jsdom (Radix's pointer-only
// dropdown is impractical there). The mock preserves the
// `value`/`onValueChange` contract the page relies on.
vi.mock("@/components/ui/select", () => {
  const SelectContext = React.createContext<{
    value?: string;
    onValueChange?: (v: string) => void;
  }>({});

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  }) {
    return (
      <SelectContext.Provider value={{ value, onValueChange }}>
        <select
          data-testid="month-filter-native"
          value={value ?? ""}
          onChange={(e) => onValueChange?.(e.target.value)}
        >
          {children}
        </select>
      </SelectContext.Provider>
    );
  }
  function SelectTrigger({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement>) {
    // Preserve the trigger's data-testid / aria-busy / data-pending
    // hooks the page sets — the test reads them to assert the deferred
    // contract is wired up.
    return <div {...rest}>{children}</div>;
  }
  function SelectValue() {
    return null;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectItem({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) {
    return <option value={value}>{String(children)}</option>;
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

const PLAN_EVENTS = [
  { itemId: "rent", date: "2026-05-10", label: "Rent", amount: -1500 },
  { itemId: "gym", date: "2026-05-03", label: "Gym", amount: -40 },
  { itemId: "internet", date: "2026-05-12", label: "Internet", amount: -90 },
];

const FORECAST_BASE = {
  fromDate: "2026-05-01",
  toDate: "2026-08-01",
  events: PLAN_EVENTS,
  transactions: [],
  resolutions: [],
  closedMonths: [],
  monthSnapshots: {},
  bankSnapshot: null,
  plaidCheckingAccounts: [],
  settings: { startingBalance: "5000", cashBuffer: "500" },
};

// Track which fromDate the cash-signal data hook was called with on
// the most recent render. The deferred plumbing should keep the prior
// value flowing to the heavy refetch through the click transition.
const lastCashSignalFromDate = { value: "" };

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  return {
    useGetForecast: () => ({ data: FORECAST_BASE, isLoading: false }),
    useGetForecastCashSignal: (params: { fromDate?: string } = {}) => {
      lastCashSignalFromDate.value = params.fromDate ?? "";
      return { data: undefined, isLoading: false };
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

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  sessionStorage.setItem("h2budget:forecastFromDate", "2026-05-01");
  // The "Forecast from" input lives inside the collapsible Look-back panel
  // (closed by default), and ForecastPage only honors a stored from-date
  // when that panel was previously opened. Open it so the input renders and
  // the stored 2026-05-01 anchor (which keeps the May plan rows visible) is
  // respected instead of snapping forward to today.
  sessionStorage.setItem("h2budget:forecastLookbackOpen", "true");
  lastCashSignalFromDate.value = "";
});

describe("Forecast — From-date and month switching is snappy (#621)", () => {
  it("exposes the deferred-value contract on the From date input and keeps the prior register mounted across a change", () => {
    renderPage();

    const input = screen.getByTestId("input-forecast-from") as HTMLInputElement;
    // Hooks the loading hint relies on are present and quiet at rest.
    expect(input.getAttribute("data-pending")).toBeNull();
    expect(screen.queryByTestId("forecast-from-pending")).toBeNull();

    // Default from-date drives the cash-signal fetch via the deferred
    // value (seeded from the live state).
    expect(lastCashSignalFromDate.value).toBe("2026-05-01");

    // Plan register is rendered.
    expect(screen.getByTestId("plan-row-rent-2026-05-10")).toBeTruthy();

    // Change the From date. With useDeferredValue the change must NOT
    // unmount the existing register — the prior plan rows stay on
    // screen while the deferred from-date settles. (We pick a date
    // that keeps every event visible so this assertion isolates the
    // deferral behavior from the visibleFromISO filter itself.)
    fireEvent.change(input, { target: { value: "2026-05-02" } });
    expect(screen.getByTestId("plan-row-rent-2026-05-10")).toBeTruthy();
    expect(screen.getByTestId("plan-row-gym-2026-05-03")).toBeTruthy();
    expect(screen.getByTestId("plan-row-internet-2026-05-12")).toBeTruthy();

    // The input itself flips to the new value synchronously.
    expect(input.value).toBe("2026-05-02");

    // After the change commits, the cash-signal hook is called with
    // the new from-date — confirming the change did flow through to
    // the fetch layer (just deferred off the critical path).
    expect(lastCashSignalFromDate.value).toBe("2026-05-02");
  });

  it("exposes the deferred-value contract on the month picker and keeps the prior register mounted across a switch", () => {
    renderPage();

    const trigger = screen.getByTestId("select-month-filter");
    // Hooks the loading hint relies on are present and quiet at rest.
    expect(trigger.getAttribute("data-pending")).toBeNull();
    expect(screen.queryByTestId("month-filter-pending")).toBeNull();

    // Plan register is rendered for the default month.
    expect(screen.getByTestId("plan-row-rent-2026-05-10")).toBeTruthy();
    expect(screen.getByTestId("plan-row-gym-2026-05-03")).toBeTruthy();
    expect(screen.getByTestId("plan-row-internet-2026-05-12")).toBeTruthy();

    // Switch to a different month via the (mocked) native select. With
    // useDeferredValue the change must NOT unmount the existing
    // register — the prior plan rows stay on screen while the deferred
    // monthFilter settles. (The register is built off the deferred
    // forecast data, not the month bucket — same property the #618
    // horizon test relies on.)
    const native = screen.getByTestId(
      "month-filter-native",
    ) as HTMLSelectElement;
    const otherMonth = Array.from(native.options)
      .map((o) => o.value)
      .find((v) => v && v !== native.value);
    expect(otherMonth).toBeTruthy();
    fireEvent.change(native, { target: { value: otherMonth } });

    // The select itself flips to the new value synchronously.
    expect((screen.getByTestId("month-filter-native") as HTMLSelectElement).value)
      .toBe(otherMonth);

    // Register rows remain mounted across the transition.
    expect(screen.getByTestId("plan-row-rent-2026-05-10")).toBeTruthy();
    expect(screen.getByTestId("plan-row-gym-2026-05-03")).toBeTruthy();
    expect(screen.getByTestId("plan-row-internet-2026-05-12")).toBeTruthy();
  });
});
