import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (P) The Reports hub's Spending tile and the Spending report quote the SAME percentage for the
 * same category: one amount, one declared denominator, one percent, one date range. The span has an
 * uncategorized remainder and more categories than the tile shows, so neither "share of the five
 * shown" nor "share of categorized only" can pass by accident.
 */

vi.mock("recharts", async () => {
  const Nothing = () => null;
  return {
    ...(await import("@/test-recharts-stub")),
    AreaChart: Nothing,
    Area: Nothing,
    BarChart: Nothing,
    ReferenceLine: Nothing,
  };
});

const TODAY = new Date(2026, 4, 15, 12, 0, 0);

// Synthetic. 6 categories (the tile shows 5), categorized 1,075.00, uncategorized 125.00 => 1,200.00.
const FACTS = {
  range: { start: "2026-04-15", end: "2026-05-15", daysCovered: 31, trackingStart: "2026-05-01", floorApplied: false },
  householdSpend: { total: 1200, transactionCount: 9 },
  realSpend: { total: 1075, transactionCount: 8 },
  realIncome: { total: 3000, transactionCount: 1 },
  unplanned: { total: 0, transactionCount: 0, transactions: [] },
  uncategorized: { total: 125, transactionCount: 1, sampleMerchants: [] },
  excluded: { transfersTotal: 0, debtPaymentsTotal: 0, reimbursementTotal: 0, ignoreTotal: 0, cardPayments: 0, reimbursable: 0, replacedPending: 0 },
  byCategory: [
    { categoryId: "c1", name: "Alpha", total: 400, txnCount: 2, pctOfRealSpend: 37.21 },
    { categoryId: "c2", name: "Bravo", total: 300, txnCount: 2, pctOfRealSpend: 27.91 },
    { categoryId: "c3", name: "Charlie", total: 200, txnCount: 1, pctOfRealSpend: 18.6 },
    { categoryId: "c4", name: "Delta", total: 100, txnCount: 1, pctOfRealSpend: 9.3 },
    { categoryId: "c5", name: "Echo", total: 50, txnCount: 1, pctOfRealSpend: 4.65 },
    { categoryId: "c6", name: "Foxtrot", total: 25, txnCount: 1, pctOfRealSpend: 2.33 },
  ],
  byMerchant: [],
  dailyBuckets: [],
  dailyNet: [],
  dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, dow) => ({ dow, label, avgPerDay: 0, total: 0, topMerchants: [] })),
  monthlyTrends: [],
  reimbursable: { personalTotal: 0, outstandingReimbursableTotal: 0 },
};

const state = vi.hoisted(() => ({ facts: undefined as unknown }));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetSpine: () => ({ data: undefined, isLoading: true, isLoadingError: false }),
  useListTransactions: () => ({ data: [], isLoading: false }),
  useListCategories: () => ({ data: [] }),
  useListDebts: () => ({ data: [] }),
  useListDebtBalanceHistory: () => ({ data: [] }),
  useGetForecast: () => ({ data: undefined, isError: false }),
  useGetDashboard: () => ({ data: undefined }),
  useListPlaidLiabilityAccounts: () => ({ data: [], isError: false }),
  useGetReportsSpendingFacts: () => ({ data: state.facts, isLoading: false, isError: false, refetch: vi.fn() }),
  getGetReportsSpendingFactsQueryKey: (p: unknown) => ["/api/reports/spending-facts", p],
  useUpdateTransaction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  getListTransactionsQueryKey: (p: unknown) => ["/api/transactions", p],
}));

import ReportsPage from "../reports";
import SpendingPage from "./SpendingPage";

const wrap = (node: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TODAY);
  state.facts = FACTS;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rowText = (name: string, testid: string) =>
  Array.from(document.querySelectorAll(testid === "stackbar-legend-row" ? ".stagger-children [data-share-name]" : `[data-testid="${testid}"]`))
    .find((el) => el.getAttribute("data-share-name") === name)?.textContent ?? "";

describe("(P) tile and report agree on a category's percentage", () => {
  it("same amount, same percent, same denominator in words, same dates; uncategorized explicit on both", () => {
    wrap(<ReportsPage />);
    const tile = {
      alpha: rowText("Alpha", "stackbar-legend-row"),
      uncat: rowText("Uncategorized", "stackbar-legend-row"),
      denom: screen.getByTestId("stackbar-denominator").textContent ?? "",
    };
    cleanup();
    wrap(<SpendingPage />);
    const rep = {
      alpha: rowText("Alpha", "spend-share-row"),
      uncat: rowText("Uncategorized", "spend-share-row"),
      denom: screen.getByTestId("spend-share-denominator").textContent ?? "",
      top: screen.getByTestId("spending-top-category").textContent ?? "",
    };

    // 400 / (1,075 + 125) = 33%. Not 37% (of categorized), not 38% (of the five shown, 1,050).
    expect(tile.alpha).toContain("$400.00");
    expect(tile.alpha).toContain("33%");
    expect(rep.alpha).toContain("$400.00");
    expect(rep.alpha).toContain("33%");
    expect(rep.top).toContain("33%");
    expect(rep.top).toContain("of $1,200.00 spent Apr 15 – May 15");

    // Uncategorized is a row of its own on both: 125 / 1,200 = 10%.
    for (const u of [tile.uncat, rep.uncat]) {
      expect(u).toContain("$125.00");
      expect(u).toContain("10%");
    }

    // The same denominator, in the same words, over the same dates.
    expect(tile.denom).toBe("% of $1,200.00 spent Apr 15 – May 15");
    expect(rep.denom).toBe(tile.denom);
  });

  it("the tile's bar tooltip names the denominator too", () => {
    const { container } = wrap(<ReportsPage />);
    const titles = Array.from(container.querySelectorAll("[title]")).map((e) => e.getAttribute("title") ?? "");
    expect(titles).toContain("Alpha · $400.00 · 33% of $1,200.00 spent Apr 15 – May 15");
    expect(titles).toContain("Uncategorized · $125.00 · 10% of $1,200.00 spent Apr 15 – May 15");
  });

  it("no uncategorized spend: no Uncategorized row, shares are of the categorized total, still equal", () => {
    state.facts = { ...FACTS, householdSpend: { total: 1075, transactionCount: 8 }, uncategorized: { total: 0, transactionCount: 0, sampleMerchants: [] } };
    wrap(<ReportsPage />);
    const tile = rowText("Alpha", "stackbar-legend-row");
    expect(rowText("Uncategorized", "stackbar-legend-row")).toBe("");
    cleanup();
    wrap(<SpendingPage />);
    const rep = rowText("Alpha", "spend-share-row");
    expect(tile).toContain("37%");
    expect(rep).toContain("37%");
  });
});
