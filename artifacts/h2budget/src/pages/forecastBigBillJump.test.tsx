import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #388 — When the user clicks a big-bill marker on the projected-balance
// chart (or a bill button inside its tooltip), the matching plan row in the
// register below should scroll into view and briefly pulse with a sky ring.
// This is the regression guard for #335's click-to-jump deep-link.

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

// Recharts mock that:
//  * captures the AreaChart `data` so the Tooltip mock can render its
//    `content` render-prop for every daily point — without that, the
//    tooltip-bill buttons (which only exist inside the tooltip content)
//    would never reach the DOM in jsdom,
//  * forwards `onClick` on ReferenceDot so the big-bill marker click
//    actually fires `jumpToPlan`.
let lastChartData: Array<{ rawDate?: string; balance?: number }> = [];
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
  const AreaChart = ({
    children,
    data,
  }: {
    children?: React.ReactNode;
    data?: Array<{ rawDate?: string; balance?: number }>;
  }) => {
    lastChartData = data ?? [];
    return <div>{children}</div>;
  };
  const TooltipMock = ({
    content,
  }: {
    content?: (args: {
      active: boolean;
      payload: Array<{ payload: unknown }>;
    }) => React.ReactNode;
  }) => {
    if (!content) return null;
    return (
      <div>
        {lastChartData.map((d, i) => (
          <div key={i}>
            {content({ active: true, payload: [{ payload: d }] })}
          </div>
        ))}
      </div>
    );
  };
  const RefDot = ({
    children,
    onClick,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    [key: string]: unknown;
  }) => {
    const testId = (rest as { ["data-testid"]?: string })["data-testid"];
    return (
      <div data-testid={testId} onClick={onClick}>
        {children}
      </div>
    );
  };
  return {
    ResponsiveContainer: Stub,
    LineChart: Stub,
    Line: Stub,
    AreaChart,
    Area: Stub,
    BarChart: Stub,
    Bar: Stub,
    ComposedChart: Stub,
    XAxis: Stub,
    YAxis: Stub,
    CartesianGrid: Stub,
    Tooltip: TooltipMock,
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
    ReferenceDot: RefDot,
    Label: ({ value }: { value?: React.ReactNode }) => <span>{value}</span>,
  };
});

const FORECAST_BASE = {
  fromDate: "2026-05-01",
  toDate: "2026-08-01",
  // Two pending plan rows so the click can pick out a specific one.
  events: [
    { itemId: "rent", date: "2026-05-01", label: "Rent", amount: -1500 },
    { itemId: "gym", date: "2026-05-15", label: "Gym", amount: -300 },
  ],
  transactions: [],
  resolutions: [],
  closedMonths: [],
  monthSnapshots: {},
  bankSnapshot: null,
  plaidCheckingAccounts: [],
  settings: { startingBalance: "5000", cashBuffer: "500" },
};

const CASH_SIGNAL = {
  status: "ok",
  startingBalance: "5000",
  endingBalance: "3460",
  endingDate: "2026-05-31",
  toDate: "2026-05-31",
  acceptedImpact: "-1540",
  projectedIncome: "0",
  projectedExpenses: "1540",
  lowestProjected: "3460",
  lowestDate: "2026-05-15",
  cashBuffer: "500",
  daily: [
    { date: "2026-05-01", balance: "3500" },
    { date: "2026-05-15", balance: "3460" },
    { date: "2026-05-31", balance: "3460" },
  ],
  // Both events match a daily date and exceed the 50%-of-buffer ($250)
  // threshold, so each becomes a big-bill marker.
  events: [
    { itemId: "rent", date: "2026-05-01", label: "Rent", amount: -1500 },
    { itemId: "gym", date: "2026-05-15", label: "Gym", amount: -300 },
  ],
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
    useGetForecastCashSignal: () => ({ data: CASH_SIGNAL, isLoading: false }),
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

const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  cleanup();
  scrollIntoViewMock.mockClear();
  // jsdom doesn't implement scrollIntoView; install a stub so the
  // requestAnimationFrame callback inside `jumpToPlan` doesn't throw and
  // we can also assert the row was scrolled into view.
  (
    Element.prototype as unknown as { scrollIntoView: typeof scrollIntoViewMock }
  ).scrollIntoView = scrollIntoViewMock;
});

describe("Forecast — big-bill marker click jumps to plan row (#335 / #388)", () => {
  it("clicking a big-bill marker scrolls and briefly highlights the matching plan row", async () => {
    renderPage();

    // Both markers should be on-chart.
    const marker = screen.getByTestId("big-bill-marker-2026-05-01");
    expect(marker).toBeTruthy();
    expect(screen.getByTestId("big-bill-marker-2026-05-15")).toBeTruthy();

    // Pre-click: the matching plan row exists and has no sky highlight ring.
    const rentRowBefore = screen.getByTestId("plan-row-rent-2026-05-01");
    expect(rentRowBefore.className).not.toMatch(/ring-sky-400/);

    fireEvent.click(marker);

    // Defer a frame so the requestAnimationFrame inside jumpToPlan fires.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });

    // The matching row now carries the highlight ring class.
    const rentRowAfter = screen.getByTestId("plan-row-rent-2026-05-01");
    expect(rentRowAfter.className).toMatch(/ring-sky-400/);

    // And it was scrolled into view (the call lives on the matched element,
    // so its `this` is that element).
    expect(scrollIntoViewMock).toHaveBeenCalled();
    const lastCall =
      scrollIntoViewMock.mock.instances[
        scrollIntoViewMock.mock.instances.length - 1
      ];
    expect((lastCall as HTMLElement).getAttribute("data-plan-key")).toBe(
      "rent|2026-05-01",
    );

    // The OTHER plan row (gym) is not highlighted — we only ring the row
    // tied to the marker that was clicked.
    const gymRow = screen.getByTestId("plan-row-gym-2026-05-15");
    expect(gymRow.className).not.toMatch(/ring-sky-400/);
  });

  it("clicking a bill inside the marker tooltip jumps to that specific plan row", async () => {
    renderPage();

    // The Tooltip mock renders the content render-prop for every daily
    // point, so the tooltip-bill button for the May 15 gym marker is in
    // the DOM and clickable.
    const tooltipBill = screen.getByTestId("tooltip-bill-2026-05-15-gym");
    expect(tooltipBill).toBeTruthy();
    expect((tooltipBill as HTMLButtonElement).disabled).toBe(false);

    // Sanity: the gym row starts un-highlighted.
    expect(
      screen.getByTestId("plan-row-gym-2026-05-15").className,
    ).not.toMatch(/ring-sky-400/);

    fireEvent.click(tooltipBill);

    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });

    // The gym plan row is now ringed and was scrolled into view.
    const gymRowAfter = screen.getByTestId("plan-row-gym-2026-05-15");
    expect(gymRowAfter.className).toMatch(/ring-sky-400/);

    expect(scrollIntoViewMock).toHaveBeenCalled();
    const lastCall =
      scrollIntoViewMock.mock.instances[
        scrollIntoViewMock.mock.instances.length - 1
      ];
    expect((lastCall as HTMLElement).getAttribute("data-plan-key")).toBe(
      "gym|2026-05-15",
    );

    // The unrelated rent row stays un-highlighted.
    expect(
      screen.getByTestId("plan-row-rent-2026-05-01").className,
    ).not.toMatch(/ring-sky-400/);
  });
});
