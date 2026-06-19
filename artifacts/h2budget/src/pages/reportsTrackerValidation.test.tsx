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
  };
});

vi.mock("@workspace/api-client-react", () => {
  const empty = { data: [], isLoading: false };
  const SETTINGS = {
    weeklyAllowanceAmount: "0",
    monthlyAllowanceAmount: "0",
    unplannedAllowanceAmount: "0",
    primaryAccount: "",
    preferences: {
      daysSinceTrackers: [
        {
          id: "tracker-broken",
          label: "Coffee",
          matchType: "keyword",
          matchValue: "(unclosed",
        },
        {
          id: "tracker-ok",
          label: "Dining",
          matchType: "keyword",
          matchValue: "dining",
        },
      ],
    },
  };
  return {
    useListTransactions: () => ({ data: [], isLoading: false }),
    useGetBudgetMonth: () => ({ data: undefined }),
    useListCategories: () => empty,
    useListDebts: () => empty,
    useListDebtBalanceHistory: () => empty,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    useListRecurringItems: () => empty,
    useGetForecast: () => ({ data: undefined }),
    useGetSettings: () => ({ data: SETTINGS, isLoading: false }),
    // The Reports page mounts several report-facts/advisor cards alongside
    // the behavior-tracker tile under test. Each must be present in the mock
    // or render throws "No useX export is defined". The tiles guard on
    // isLoading/isError/empty data, so undefined data is safe here.
    useGetDashboard: () => ({ data: undefined, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: undefined, isLoading: false }),
    useListPlaidLiabilityAccounts: () => empty,
    useGetReportsAdvisorSummary: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    useGetReportsBehaviorFacts: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    useGetReportsBudgetFacts: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    useGetReportsSpendingFacts: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    useUpdateTransaction: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    }),
    getGetReportsAdvisorSummaryQueryKey: () => ["/api/reports/advisor-summary"],
    getGetReportsSpendingFactsQueryKey: () => ["/api/reports/spending-facts"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    // AdvisorSummaryCard.handleRefresh imports this plain async API fn at
    // module load; only invoked on the (un-clicked) refresh button here.
    getReportsAdvisorSummary: async () => undefined,
    // <AiInsightBar /> renders unconditionally above the tabs and reads the
    // cached advisor nudge. Undefined data -> the bar renders nothing.
    useGetAdvisorNudge: () => ({ data: undefined, isLoading: false }),
    // SubscriptionInsightsSection renders live in the Behavior tab (Tabs is
    // stubbed to a passthrough, so every TabsContent mounts). It mutates via
    // useCreateRecurringItem and references these two query-key factories.
    useCreateRecurringItem: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    }),
    getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
    getListRecurringItemsQueryKey: () => ["/api/recurring-items"],
  };
});

import ReportsPage from "./reports";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
});

describe("Reports — Behavior tracker tile gracefully degrades on invalid regex", () => {
  it("shows 'Couldn't read this rule' for a broken tracker without crashing, while a valid tracker still renders", () => {
    renderPage();

    // Broken tracker shows the inline error tile.
    const errorTile = screen.getByTestId("tracker-tile-error-Coffee");
    expect(errorTile.textContent ?? "").toContain("Couldn't read this rule");

    // The valid tracker tile is rendered normally (no error tile for it).
    expect(screen.queryByTestId("tracker-tile-error-Dining")).toBeNull();
    expect(screen.getByText("Dining")).toBeTruthy();
  });
});
