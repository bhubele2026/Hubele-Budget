import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (PR7) The Spending page's "Total real spend" says what it leaves out:
 * "+ $X uncategorized". (PR7b) That figure is money, so it renders in mono
 * numerals like every other figure on the page.
 */

// The shared stub covers `@/lib/charts`; the Reports family also reaches for
// these four through `reportsShared.tsx`. Every one renders nothing.
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

const state = vi.hoisted(() => ({ facts: undefined as unknown }));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetSpine: () => ({ data: undefined, isLoading: true, isLoadingError: false }),
  useListTransactions: () => ({ data: [], isLoading: false }),
  useListCategories: () => ({ data: [] }),
  useGetReportsSpendingFacts: () => ({ data: state.facts, isLoading: false }),
  getGetReportsSpendingFactsQueryKey: (p: unknown) => ["/api/reports/spending-facts", p],
  useUpdateTransaction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  getListTransactionsQueryKey: (p: unknown) => ["/api/transactions", p],
}));

import SpendingPage from "./SpendingPage";

const baseFacts = {
  range: {
    start: "2026-09-04",
    end: "2026-09-11",
    daysCovered: 8,
    trackingStart: "2026-05-01",
    floorApplied: false,
  },
  householdSpend: { total: 195.75, transactionCount: 2 },
  realSpend: { total: 195.75, transactionCount: 2 },
  realIncome: { total: 0, transactionCount: 0 },
  unplanned: { total: 0, transactionCount: 0, transactions: [] },
  uncategorized: { total: 0, transactionCount: 0, sampleMerchants: [] },
  excluded: {
    transfersTotal: 0,
    debtPaymentsTotal: 0,
    reimbursementTotal: 0,
    ignoreTotal: 0,
    cardPayments: 0,
    reimbursable: 0,
    replacedPending: 0,
  },
  byCategory: [
    { categoryId: "c1", name: "Groceries", total: 195.75, txnCount: 2, pctOfRealSpend: 100 },
  ],
  byMerchant: [],
  dailyBuckets: [],
  dailyNet: [],
  dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, dow) => ({
    dow,
    label,
    avgPerDay: 0,
    total: 0,
    topMerchants: [],
  })),
  monthlyTrends: [],
  reimbursable: { personalTotal: 0, outstandingReimbursableTotal: 0 },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SpendingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.facts = baseFacts;
});
afterEach(() => cleanup());

describe("Spending page — Total real spend", () => {
  it("adds '+ $X uncategorized' in mono numerals when anything is uncategorized", () => {
    state.facts = {
      ...baseFacts,
      householdSpend: { total: 220.25, transactionCount: 3 },
      uncategorized: { total: 24.5, transactionCount: 1, sampleMerchants: [] },
    };
    renderPage();
    const tile = screen.getByTestId("spending-total").textContent ?? "";
    expect(tile).toContain("$195.75");
    expect(tile).toContain("2 transactions");
    expect(tile).toContain("+ $24.50 uncategorized");
    const amount = screen.getByTestId("spending-total-uncategorized");
    expect(amount.textContent).toBe("$24.50");
    expect(amount.className).toContain("font-mono");
    expect(amount.className).toContain("tabular-nums");
  });

  it("says nothing about uncategorized spend when there is none", () => {
    renderPage();
    expect(screen.getByTestId("spending-total").textContent).not.toContain("uncategorized");
    expect(screen.queryByTestId("spending-total-uncategorized")).toBeNull();
  });
});
