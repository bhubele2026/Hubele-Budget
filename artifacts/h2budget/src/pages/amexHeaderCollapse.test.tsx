import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
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

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useLocation: () => ["/amex", () => undefined] as const,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));
vi.mock("@/components/sync-button", () => ({
  SyncButton: () => null,
}));
vi.mock("@/components/category-picker", () => ({
  CategoryPicker: () => null,
  defaultRememberPattern: (s: string) => s,
}));
vi.mock("@/components/bucket-bubbles", () => ({
  BucketBubbles: () => null,
}));

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
    useListTransactions: () => ({ data: [], isLoading: false }),
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
    }),
    useBulkUpdateTransactions: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
      isPending: false,
    }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    useDeleteMappingRule: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    useUpdateMappingRule: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({ data: [] }),
    useSyncPlaidTransactions: () => ({
      mutateAsync: async () => ({ added: 0, modified: 0, removed: 0 }),
      isPending: false,
    }),
    // (#806 follow-up) usePlaidSync (called by PostLinkProgressBanner,
    // which the Amex page renders live) and the banner itself read these
    // query-key factories. A missing export resolves to `undefined` and
    // crashes the first sync/`ready` effect — so provide stable arrays.
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
    getListPlaidLiabilityAccountsQueryKey: () => ["/api/plaid/liabilities"],
    getListDebtsQueryKey: () => ["/api/debts"],
    getGetDashboardQueryKey: () => ["/api/dashboard"],
    customFetch: async () => undefined,
  };
});

import AmexPage from "./amex";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Amex filter collapse toggle (#806)", () => {
  it("starts with filters collapsed; tiles + row count stay visible; toggle reveals the filter fields and flips back", async () => {
    renderPage();

    const toggle = await screen.findByTestId("button-toggle-filters");
    // Filters collapsed by default on every load (no persistence).
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/Show filters/);

    // Row-count chip is ALWAYS visible regardless of collapse state.
    expect(screen.getByTestId("text-row-count")).toBeTruthy();
    // Month switcher still visible.
    expect(screen.getByTestId("button-prev-month")).toBeTruthy();
    expect(screen.getByTestId("button-next-month")).toBeTruthy();
    expect(screen.getByTestId("text-selected-month")).toBeTruthy();

    // Filter fields (incl. the Hide reviewed toggle) hidden while collapsed.
    expect(screen.queryByTestId("input-search")).toBeNull();
    expect(screen.queryByTestId("button-hide-reviewed")).toBeNull();

    // Expand.
    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toMatch(/Hide filters/);
    expect(screen.getByTestId("input-search")).toBeTruthy();
    expect(screen.getByTestId("button-hide-reviewed")).toBeTruthy();
    // Row count remains visible while expanded.
    expect(screen.getByTestId("text-row-count")).toBeTruthy();

    // No persistence — nothing is written to localStorage.
    expect(window.localStorage.getItem("amex.headerCollapsed")).toBeNull();

    // Collapse again.
    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("input-search")).toBeNull();
    expect(screen.queryByTestId("button-hide-reviewed")).toBeNull();
  });

  it("resets to collapsed on remount even after expanding (no persistence)", async () => {
    const first = renderPage();
    const toggle = await screen.findByTestId("button-toggle-filters");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(screen.getByTestId("input-search")).toBeTruthy();
    first.unmount();

    renderPage();
    const toggle2 = await screen.findByTestId("button-toggle-filters");
    expect(toggle2.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("input-search")).toBeNull();
  });
});
