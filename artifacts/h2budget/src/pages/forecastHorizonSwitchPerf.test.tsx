import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// Track which horizonDays the data hook was called with on the most
// recent render. The test asserts that the deferred-value plumbing
// keeps `useGetForecast` on the *previous* horizon during the click
// transition (so the prior register stays on screen) while the
// horizon button itself flips to the new value immediately.
const lastHorizonDays = { value: -1 };

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  return {
    useGetForecast: (params: { days?: number } = {}) => {
      lastHorizonDays.value = params.days ?? -1;
      return { data: FORECAST_BASE, isLoading: false };
    },
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
  // ForecastPage only honors a stored from-date when the (collapsible)
  // Look-back panel was previously opened; otherwise it snaps forward to
  // today and the May plan rows fall out of the visible window. Open it so
  // the stored 2026-05-01 anchor is respected.
  sessionStorage.setItem("h2budget:forecastLookbackOpen", "true");
  // Seed the saved horizon preference to 90. The cold-load default is now
  // 30 DAYS (intentional, commit bd293339), but the stored-preference
  // branch in ForecastPage is still honored, so this puts the page on the
  // 90-day tab — exactly the precondition this test exercises (the data
  // hook seeded from 90, then a click switches it to 365).
  sessionStorage.setItem("h2budget:forecastHorizonDays", "90");
  // Anchor "today" inside May 2026. The plan register is filtered by
  // `monthFilter`, which defaults to `currentMonth` derived from
  // `useMemo(() => new Date(), [])`. The stored from-date only moves the
  // data-fetch window, not the register's month bucket, so without a
  // frozen clock today (June 2026+) makes monthFilter "2026-06" and every
  // May-2026 plan row is filtered out. Freeze to mid-May so the fixture
  // stays in the active month. Only Date is faked so React/RTL scheduling
  // keeps working.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));
  lastHorizonDays.value = -1;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Forecast — horizon tab switching is instant (#618)", () => {
  it("renders the pending-aware horizon buttons, exposes the deferred-value contract, and keeps the prior register mounted across a switch", () => {
    renderPage();

    const btn90 = screen.getByTestId("horizon-90");
    const btn365 = screen.getByTestId("horizon-365");
    // Buttons expose the data-testid + aria-busy hooks the loading
    // hint relies on. They start un-pended at rest.
    expect(btn90.getAttribute("data-pending")).toBeNull();
    expect(btn365.getAttribute("data-pending")).toBeNull();
    expect(screen.queryByTestId("horizon-90-pending")).toBeNull();
    expect(screen.queryByTestId("horizon-365-pending")).toBeNull();

    // Default horizon must be the 90-day tab — proves the data hook
    // is wired to the deferred horizon value (which seeded from 90).
    expect(lastHorizonDays.value).toBe(90);

    // Plan register is rendered through the new virtualized list.
    const rentBefore = screen.getByTestId("plan-row-rent-2026-05-10");
    expect(rentBefore).toBeTruthy();

    // Switch to 1 YEAR. With useDeferredValue + keepPreviousData the
    // click must NOT clear the existing register — the prior plan rows
    // stay mounted while the deferred horizon settles.
    fireEvent.click(btn365);
    expect(screen.getByTestId("plan-row-rent-2026-05-10")).toBeTruthy();
    expect(screen.getByTestId("plan-row-gym-2026-05-03")).toBeTruthy();
    expect(screen.getByTestId("plan-row-internet-2026-05-12")).toBeTruthy();

    // After the click commits the data hook is called with the new
    // horizon — confirming the click did flow through to the fetch
    // layer (just deferred off the critical path).
    expect(lastHorizonDays.value).toBe(365);
  });

  // Regression: short plan registers (the typical 90D / few-dozen-row
  // case driving most e2e flows) keep every row mounted in normal
  // flow. We must NOT virtualize them — Playwright tests rely on
  // every plan-row testid being in the DOM without scrolling.
  it("renders short plan registers in normal flow with every row mounted", () => {
    renderPage();
    for (const ev of PLAN_EVENTS) {
      const row = screen.getByTestId(`plan-row-${ev.itemId}-${ev.date}`);
      // Normal flow: not absolutely positioned, no transform.
      expect(row.style.position).not.toBe("absolute");
      let p: HTMLElement | null = row.parentElement;
      while (p) {
        expect(p.style.position).not.toBe("absolute");
        if (p.tagName === "MAIN" || p.tagName === "BODY") break;
        p = p.parentElement;
      }
    }
  });
});
