import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #524 / regression for #522 — the amber "Inbox clear, but the forecast
// and the bank disagree by $X" badge (data-testid="badge-balance-mismatch")
// must compare the forecast's projected balance AS OF the bank snapshot date
// against the snapshot balance, NOT the forecast end-of-month balance. If
// remaining planned future activity in the same month leaks into the gap,
// the badge fires whenever any plan is still pending — even when the books
// actually reconcile — and that's exactly the regression we're pinning.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
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
    Label: ({ value }: { value?: React.ReactNode }) => <span>{value}</span>,
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: () => ({ dismiss: () => {} }) }),
}));

// Freeze "today" so the fixture (May 2026) keeps lining up with
// `currentMonth` and `isPriorMonth` gating in forecast.tsx no matter when
// the suite runs. Without this, once real-world time rolls past May 2026
// the snapshot becomes a prior-month snapshot, the badge is suppressed
// for an unrelated reason, and the test starts failing for calendar
// reasons rather than product behavior.
const TODAY_ISO = "2026-05-08";
const FROZEN_NOW = new Date(`${TODAY_ISO}T12:00:00.000Z`);

type ForecastFixture = {
  fromDate: string;
  toDate: string;
  events: Array<{
    itemId: string;
    date: string;
    label: string;
    amount: number;
  }>;
  transactions: unknown[];
  resolutions: unknown[];
  closedMonths: string[];
  monthSnapshots: Record<string, unknown>;
  bankSnapshot: { at: string; balance: string; source: string } | null;
  plaidCheckingAccounts: unknown[];
  settings: { startingBalance: string; cashBuffer: string };
};

// Mutable holder so each test can swap in a different bank snapshot
// balance without re-mocking the module.
let currentForecast: ForecastFixture;

function makeForecast(snapshotBalance: string): ForecastFixture {
  return {
    fromDate: "2026-05-01",
    toDate: "2026-08-01",
    // Non-zero remaining planned activity in the SAME month, dated AFTER
    // the bank snapshot. Under the buggy definition this leaks into the
    // gap (forecastEnd − bankEnd = -800) and would falsely fire the
    // badge. Under the correct snapshot-date projection it doesn't.
    events: [
      { itemId: "rent", date: "2026-05-20", label: "Rent", amount: -1500 },
      { itemId: "paycheck", date: "2026-05-25", label: "Paycheck", amount: 700 },
    ],
    transactions: [],
    resolutions: [],
    closedMonths: [],
    monthSnapshots: {},
    bankSnapshot: {
      at: `${TODAY_ISO}T12:00:00.000Z`,
      balance: snapshotBalance,
      source: "manual",
    },
    plaidCheckingAccounts: [],
    settings: { startingBalance: "5000", cashBuffer: "500" },
  };
}

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  return {
    useGetForecast: () => ({ data: currentForecast, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: undefined, isLoading: false }),
    useUpsertForecastResolution: noopMutation,
    useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation,
    useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation,
    useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation,
    useRefreshForecastBank: noopMutation,
    useCreateRecurringItem: noopMutation,
    useListCategories: () => ({ data: [], isLoading: false }),
    useListDebts: () => ({ data: [], isLoading: false }),
    useListRecurringItems: () => ({ data: [], isLoading: false }),
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
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers({
    // Keep timers we don't care about (queueMicrotask, setImmediate, etc.)
    // running normally so React/RTL effects flush as usual; we only need
    // a frozen wall-clock for `new Date()` inside ForecastPage.
    toFake: ["Date"],
  });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("Forecast — amber 'off from bank' badge gating (#524 / regression for #522)", () => {
  it("stays hidden when the books reconcile, even with non-zero remaining planned activity in the month", () => {
    // Snapshot balance equals the forecast's projection AS OF the snapshot
    // date (no plan items between fromDate and snapshot, so the projection
    // is just the configured startingBalance). The reconciliation gap is
    // therefore $0, even though -1500 of rent and +700 of paycheck are
    // still pending later in the same month.
    currentForecast = makeForecast("5000");
    renderPage();

    expect(screen.queryByTestId("badge-balance-mismatch")).toBeNull();
    // The celebratory cleared state should be the one that surfaces.
    expect(screen.getByTestId("badge-inbox-cleared")).toBeTruthy();
  });

  it("does render with the correct gap text when there is a real reconciliation mismatch", () => {
    // Same fixture, but the snapshot is contrived to disagree with the
    // forecast-at-snapshot projection by exactly $250 (forecast says
    // 5000, bank says 4750 → gap = +250). Books do NOT reconcile, so
    // the amber badge must surface with the formatted gap.
    currentForecast = makeForecast("4750");
    renderPage();

    const badge = screen.getByTestId("badge-balance-mismatch");
    expect(badge).toBeTruthy();
    expect(badge.textContent ?? "").toMatch(/\$250\.00/);
    expect(screen.queryByTestId("badge-inbox-cleared")).toBeNull();
  });
});
