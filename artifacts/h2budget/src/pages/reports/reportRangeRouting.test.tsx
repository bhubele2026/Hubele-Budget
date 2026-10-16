import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (R) A report keeps the period it was opened with. The address carries it
 * (`?mode=` or `?from=&to=`); the dates asked of the server, the lit control and the
 * label all come from that one place, through reload (remount) and Back (popstate).
 */

vi.mock("recharts", async () => {
  const Nothing = () => null;
  return { ...(await import("@/test-recharts-stub")), AreaChart: Nothing, Area: Nothing, BarChart: Nothing, ReferenceLine: Nothing };
});

const seen = vi.hoisted(() => ({ spending: [] as Array<{ from: string; to: string }>, behavior: [] as Array<{ from: string; to: string }>, budget: [] as Array<{ monthStart: string }> }));
const FACTS = vi.hoisted(() => ({
  range: { start: "2026-09-04", end: "2026-09-11", daysCovered: 8, trackingStart: "2026-05-01", floorApplied: false },
  householdSpend: { total: 195.75, transactionCount: 2 },
  realSpend: { total: 195.75, transactionCount: 2 },
  realIncome: { total: 0, transactionCount: 0 },
  unplanned: { total: 0, transactionCount: 0, transactions: [] },
  uncategorized: { total: 0, transactionCount: 0, sampleMerchants: [] },
  excluded: { transfersTotal: 0, debtPaymentsTotal: 0, reimbursementTotal: 0, ignoreTotal: 0, cardPayments: 0, reimbursable: 0, replacedPending: 0 },
  byCategory: [{ categoryId: "c1", name: "Groceries", total: 195.75, txnCount: 2, pctOfRealSpend: 100 }],
  byMerchant: [],
  dailyBuckets: [],
  dailyNet: [],
  dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, dow) => ({ dow, label, avgPerDay: 0, total: 0, topMerchants: [] })),
  monthlyTrends: [],
  reimbursable: { personalTotal: 0, outstandingReimbursableTotal: 0 },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetSpine: () => ({ data: undefined, isLoading: true, isLoadingError: false }),
  useListTransactions: () => ({ data: [], isLoading: false }),
  useListCategories: () => ({ data: [] }),
  useGetReportsSpendingFacts: (p: { from: string; to: string }) => {
    seen.spending.push(p);
    return { data: FACTS, isLoading: false, isError: false, refetch: vi.fn() };
  },
  useGetReportsBehaviorFacts: (p: { from: string; to: string }) => {
    seen.behavior.push(p);
    return { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
  },
  useGetReportsBudgetFacts: (p: { monthStart: string }) => {
    seen.budget.push(p);
    return { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
  },
  getGetReportsSpendingFactsQueryKey: (p: unknown) => ["/api/reports/spending-facts", p],
  useUpdateTransaction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  getListTransactionsQueryKey: (p: unknown) => ["/api/transactions", p],
}));

import SpendingPage from "./SpendingPage";
import BehaviorPage from "./BehaviorPage";
import BudgetPage from "./BudgetPage";

const CUSTOM = "?from=2026-04-15&to=2026-05-15"; // the hub's "Last 30 days" on the fixed clock below
const last = <T,>(a: T[]) => a[a.length - 1]!;
const lit = () => (["wk", "mo", "yr"] as const).filter((m) => screen.getByTestId(`range-${m}`).getAttribute("aria-pressed") === "true");

function mount(el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
}
const go = (search: string) => window.history.replaceState(null, "", `/reports/x${search}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));
  seen.spending.length = 0;
  seen.behavior.length = 0;
  seen.budget.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("(R) Spending keeps the period the tile promised", () => {
  it("opens on the tile's span: asked for those dates, no preset lit, the dates shown", () => {
    go(CUSTOM);
    mount(<SpendingPage />);
    expect(last(seen.spending)).toEqual({ from: "2026-04-15", to: "2026-05-15" });
    expect(lit()).toEqual([]);
    expect(screen.getByTestId("report-range-custom").textContent).toBe("Apr 15 – May 15");
  });

  it("no params: the week, lit, no custom dates", () => {
    go("");
    mount(<SpendingPage />);
    expect(last(seen.spending)).toEqual({ from: "2026-05-08", to: "2026-05-15" });
    expect(lit()).toEqual(["wk"]);
    expect(screen.queryByTestId("report-range-custom")).toBeNull();
  });

  it("choosing Mo writes ?mode=mo, drops the span and asks for the month window", () => {
    go(CUSTOM + "&tx=keep");
    mount(<SpendingPage />);
    fireEvent.click(screen.getByTestId("range-mo"));
    expect(window.location.search).toBe("?tx=keep&mode=mo");
    expect(lit()).toEqual(["mo"]);
    expect(screen.queryByTestId("report-range-custom")).toBeNull();
    expect(last(seen.spending).to).toBe("2026-05-15");
    expect(last(seen.spending).from).not.toBe("2026-04-15");
  });

  it("reload (a fresh mount of the same address) is the same period", () => {
    go(CUSTOM);
    const first = mount(<SpendingPage />);
    first.unmount();
    mount(<SpendingPage />);
    expect(last(seen.spending)).toEqual({ from: "2026-04-15", to: "2026-05-15" });
    expect(lit()).toEqual([]);
  });

  it("Back: the address returns to the span and the page follows it", () => {
    go(CUSTOM);
    mount(<SpendingPage />);
    fireEvent.click(screen.getByTestId("range-yr"));
    expect(lit()).toEqual(["yr"]);
    act(() => {
      go(CUSTOM);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(lit()).toEqual([]);
    expect(last(seen.spending)).toEqual({ from: "2026-04-15", to: "2026-05-15" });
    expect(screen.getByTestId("report-range-custom").textContent).toBe("Apr 15 – May 15");
  });
});

describe("(R) Habits keeps it too", () => {
  it("asks for the tile's dates and lights no preset", () => {
    go(CUSTOM);
    mount(<BehaviorPage />);
    expect(last(seen.behavior)).toEqual({ from: "2026-04-15", to: "2026-05-15" });
    expect(lit()).toEqual([]);
  });
});

describe("(R) Budget keeps its month in the address", () => {
  it("?month=2 asks for two months back; this month is not written", () => {
    go("?month=2");
    mount(<BudgetPage />);
    expect(last(seen.budget).monthStart).toBe("2026-03-01");
    cleanup();
    go("");
    mount(<BudgetPage />);
    expect(last(seen.budget).monthStart).toBe("2026-05-01");
    expect(window.location.search).toBe("");
  });
});
