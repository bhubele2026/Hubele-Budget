import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Regression coverage for task #503 — the Amex page's perf tweaks
// from #485 (cap-hint, bulk progress chip, virtualized day-group
// list) deserve their own assertions on top of the existing
// month-without-trend test.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

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
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
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
vi.mock("@/components/matched-rule-chip", () => ({ MatchedRuleChip: () => null }));

// Hoisted mutable mock state so individual tests can tune behavior
// before render without redefining the module mock.
const state = vi.hoisted(() => ({
  monthTxns: [] as Array<Record<string, unknown>>,
  pendingUpdate: false,
}));

const today = new Date();
const todayIso = today.toISOString().slice(0, 10);

function makeTxn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tx-1",
    occurredOn: todayIso,
    postedOn: todayIso,
    description: "STARBUCKS",
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
    reviewed: false,
    member: null,
    ...overrides,
  };
}

vi.mock("@workspace/api-client-react", () => {
  const TransactionWeeklyBucket = {
    groceries: "groceries",
    dining: "dining",
    alcohol: "alcohol",
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useGetAmexWeeklyPayoff: () => ({ data: undefined, isLoading: false }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    useListTransactions: (params: { limit?: number } = {}) => {
      // Trend (12-month) query: stays loading so the page doesn't
      // depend on it for first paint.
      if ((params.limit ?? 0) >= 5000) {
        return { data: undefined, isLoading: true };
      }
      return { data: state.monthTxns, isLoading: false };
    },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: () => ({
      mutateAsync: state.pendingUpdate
        ? () => new Promise(() => {})
        : async () => undefined,
      mutate: () => undefined,
    }),
    // Bulk runner powering every bulk action on the page (#502). The
    // perf-tweaks test exercises `runBulkPatch` via the
    // bulk-clear-owed-by button, so honor `pendingUpdate` here too —
    // a hanging bulk request is what keeps the progress chip on
    // screen long enough to assert against.
    useBulkUpdateTransactions: () => ({
      mutateAsync: state.pendingUpdate
        ? () => new Promise(() => {})
        : async (vars: { data: { ids: string[] } }) => ({
            results: vars.data.ids.map((id) => ({ id, ok: true })),
          }),
      mutate: () => undefined,
      isPending: state.pendingUpdate,
    }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    useDeleteMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    useUpdateMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({ data: [] }),
    useSyncPlaidTransactions: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
      isPending: false,
    }),
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    // Query-key helpers + mutations pulled in transitively by usePlaidSync,
    // PostLinkProgressBanner and MerchantRenamePopover (rendered per row).
    getListPlaidLiabilityAccountsQueryKey: () => ["/api/plaid/liabilities"],
    getListDebtsQueryKey: () => ["/api/debts"],
    getGetDashboardQueryKey: () => ["/api/dashboard"],
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
    usePutMerchantAlias: () => ({
      mutate: () => undefined,
      mutateAsync: async () => undefined,
      isPending: false,
    }),
    useDeleteMerchantAlias: () => ({
      mutate: () => undefined,
      mutateAsync: async () => undefined,
      isPending: false,
    }),
    customFetch: async () => undefined,
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

beforeEach(() => {
  state.monthTxns = [
    makeTxn({ id: "a", description: "PENDINGROW", reviewed: false }),
    makeTxn({ id: "b", description: "REVIEWEDROW", reviewed: true }),
  ];
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("Amex hide-reviewed (D2)", () => {
  it("a stale stored value hides reviewed rows only with a visible control to undo it", async () => {
    window.localStorage.setItem("amex.hideReviewed", "1");
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/PENDINGROW/).length).toBeGreaterThan(0));
    expect(screen.queryAllByText(/REVIEWEDROW/).length).toBe(0);
    const btn = screen.getByTestId("button-hide-reviewed");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getAllByText(/REVIEWEDROW/).length).toBeGreaterThan(0));
    expect(window.localStorage.getItem("amex.hideReviewed")).toBeNull();
  });
});
