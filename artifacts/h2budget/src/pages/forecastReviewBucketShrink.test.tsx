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

// Six matched resolutions in May 2026 — enough rows to exercise the
// scrollable cap (~5 rows) and to make the header total/count
// observable.
const PLAN_EVENTS = [
  { itemId: "rent", date: "2026-05-10", label: "Rent", amount: -1500 },
  { itemId: "gym", date: "2026-05-03", label: "Gym", amount: -40 },
  { itemId: "internet", date: "2026-05-12", label: "Internet", amount: -90 },
  { itemId: "power", date: "2026-05-15", label: "Power", amount: -120 },
  { itemId: "water", date: "2026-05-18", label: "Water", amount: -50 },
  { itemId: "gas", date: "2026-05-20", label: "Gas", amount: -60 },
];

const FORECAST_BASE = {
  fromDate: "2026-05-01",
  toDate: "2026-08-01",
  events: PLAN_EVENTS,
  transactions: [],
  resolutions: PLAN_EVENTS.map((p, i) => ({
    id: `res-${p.itemId}`,
    recurringItemId: p.itemId,
    occurrenceDate: p.date,
    status: "matched",
    matchedTxnId: `txn-${i}`,
  })),
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
    useGetForecastCashSignal: () => ({ data: undefined, isLoading: false }),
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
});

describe("Forecast — Review Bucket shrink + total (#602)", () => {
  it("shows the row count and the signed sum in the header", () => {
    renderPage();
    const count = screen.getByTestId("review-bucket-count");
    expect(count.textContent ?? "").toBe(String(PLAN_EVENTS.length));
    const total = screen.getByTestId("review-bucket-total");
    const expectedSum = PLAN_EVENTS.reduce((s, p) => s + p.amount, 0);
    // formatCurrency renders negative amounts as "-$1,860.00".
    expect(total.textContent ?? "").toContain("1,860");
    expect(total.textContent ?? "").toMatch(/[-−]/);
    // Negative totals use the destructive color cue used per row.
    expect(total.className).toMatch(/text-destructive/);
    // Sanity: the assertion above matches the actual sum we built.
    expect(expectedSum).toBe(-1860);
  });

  it("caps the list to a fixed scrollable height while keeping all rows in the DOM", () => {
    renderPage();
    const list = screen.getByTestId("review-bucket-list");
    expect(list.className).toMatch(/max-h-\[360px\]/);
    expect(list.className).toMatch(/overflow-y-auto/);
    // All bucket rows are still rendered inside the (now scrollable)
    // container — shrinking the card must not drop rows from the DOM.
    for (const p of PLAN_EVENTS) {
      expect(list.querySelector(`[data-plan-key="${p.itemId}|${p.date}"]`))
        .not.toBeNull();
    }
  });
});
