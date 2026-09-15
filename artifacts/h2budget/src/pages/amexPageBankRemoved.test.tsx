import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (PR-I, owner decision 14) The Amex page lists a charge the bank removed,
// labelled "Removed by bank" in both layouts, and no balance on the page counts
// it: the running "bal $X" walks past it. The month list asks the server for
// removed rows; the 12-month trend (the ending-balance roll-forward) does not.
// Synthetic merchants and amounts.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;

(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  useLocation: () => ["/amex", () => undefined] as const,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/plaid-link-button", () => ({ PlaidLinkButton: () => null }));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/category-picker", () => ({
  CategoryPicker: () => null,
  defaultRememberPattern: (s: string) => s,
}));
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));

// A past month, so the page jumps to it and shows the whole month.
const live = {
  id: "tx-live",
  occurredOn: "2026-06-10",
  postedOn: "2026-06-10",
  description: "VALLEY FOODS",
  amount: "-12.34",
  source: "amex",
  categoryId: null,
  weeklyAllowance: false,
  monthlyAllowance: false,
  unplannedAllowance: false,
  reimbursable: false,
  weeklyBucket: null,
  isTransfer: false,
  matchedRuleId: null,
  notes: null,
  owedBy: null,
  plaidAccountId: null,
  bankRemoved: false,
};
const removed = {
  ...live,
  id: "tx-removed",
  occurredOn: "2026-06-12",
  postedOn: "2026-06-12",
  description: "ORCHARD PRODUCE",
  amount: "-40.00",
  bankRemoved: true,
};
const listCalls: Array<{ limit?: number; includeBankRemoved?: boolean }> = [];

vi.mock("@workspace/api-client-react", () => {
  const TransactionWeeklyBucket = {
    groceries: "groceries",
    dining: "dining",
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useGetAmexWeeklyPayoff: () => ({ data: undefined, isLoading: false }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    // The month query (limit 1000) answers at once; the 12-month trend query
    // (limit 5000) stays loading, so the page rolls its balance from the month.
    useListTransactions: (params: { limit?: number; includeBankRemoved?: boolean } = {}) => {
      listCalls.push(params);
      if ((params.limit ?? 0) >= 5000) return { data: undefined, isLoading: true };
      return { data: [removed, live], isLoading: false };
    },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: () => ({ mutateAsync: async () => undefined, mutate: () => undefined }),
    useBulkUpdateTransactions: () => ({
      mutateAsync: async (vars: { data: { ids: string[] } }) => ({
        results: vars.data.ids.map((id) => ({ id, ok: true })),
      }),
      mutate: () => undefined,
      isPending: false,
    }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: () => ({ mutate: () => undefined, isPending: false }),
    useDeleteMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    useUpdateMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({ data: [] }),
    useSyncPlaidTransactions: () => ({ mutateAsync: async () => undefined, mutate: () => undefined, isPending: false }),
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    getListPlaidLiabilityAccountsQueryKey: () => ["/api/plaid/liabilities"],
    getListDebtsQueryKey: () => ["/api/debts"],
    getGetDashboardQueryKey: () => ["/api/dashboard"],
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
    usePutMerchantAlias: () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false }),
    useDeleteMerchantAlias: () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false }),
    // The saved anchor: $100.00 as of the end of June, after both charges.
    customFetch: async (url: string) =>
      url.startsWith("/api/amex/anchor")
        ? { amexEndingBalance: 100, asOf: "2026-06-30", source: "anchor" }
        : undefined,
  };
});

import AmexPage from "./amex";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("(PR-I) Amex page — a charge the bank removed", () => {
  it("is listed with 'Removed by bank' and counted in no running balance", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/ORCHARD PRODUCE/).length).toBeGreaterThan(0));

    expect(screen.getByTestId("badge-bank-removed-mobile-tx-removed").textContent).toBe("Removed by bank");
    expect(screen.getByTestId("badge-bank-removed-tx-removed").textContent).toBe("Removed by bank");
    expect(screen.queryByTestId("badge-bank-removed-tx-live")).toBeNull();

    // The live charge is the newest row that counts, so it carries the ending balance.
    await waitFor(() => expect(screen.getByTestId("text-running-balance-tx-live").textContent).toBe("bal $100.00"));
    expect(screen.getByTestId("text-running-balance-mobile-tx-live").textContent).toBe("bal $100.00");
    expect(screen.queryByTestId("text-running-balance-tx-removed")).toBeNull();

    expect(listCalls.some((p) => (p.limit ?? 0) < 5000 && p.includeBankRemoved === true)).toBe(true);
    expect(listCalls.some((p) => (p.limit ?? 0) >= 5000 && p.includeBankRemoved === undefined)).toBe(true);
  });
});
