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

describe("Amex header collapse toggle (#758)", () => {
  it("starts expanded; toggle hides tiles + filter bar while keeping month switcher and row count visible; restores on second click", async () => {
    renderPage();

    const toggle = await screen.findByTestId("button-toggle-amex-header");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toMatch(/Hide filters/);

    // Defaults: filter bar + summary row count visible.
    expect(screen.getByTestId("text-row-count")).toBeTruthy();
    expect(screen.getByTestId("button-hide-reviewed")).toBeTruthy();

    // Collapse.
    act(() => {
      fireEvent.click(toggle);
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/Show filters/);
    expect(screen.queryByTestId("text-row-count")).toBeNull();
    expect(screen.queryByTestId("button-hide-reviewed")).toBeNull();
    expect(screen.queryByTestId("stat-charges")).toBeNull();

    // Month switcher + collapsed row count still visible.
    expect(screen.getByTestId("text-row-count-collapsed")).toBeTruthy();
    expect(screen.getByTestId("button-prev-month")).toBeTruthy();
    expect(screen.getByTestId("button-next-month")).toBeTruthy();
    expect(screen.getByTestId("text-selected-month")).toBeTruthy();

    // Persisted to localStorage.
    expect(window.localStorage.getItem("amex.headerCollapsed")).toBe("1");

    // Restore.
    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("text-row-count")).toBeTruthy();
    expect(screen.getByTestId("button-hide-reviewed")).toBeTruthy();
    expect(screen.queryByTestId("text-row-count-collapsed")).toBeNull();
    expect(window.localStorage.getItem("amex.headerCollapsed")).toBeNull();
  });

  it("reapplies the persisted collapsed preference on remount", async () => {
    window.localStorage.setItem("amex.headerCollapsed", "1");
    renderPage();

    const toggle = await screen.findByTestId("button-toggle-amex-header");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/Show filters/);
    expect(screen.queryByTestId("text-row-count")).toBeNull();
    expect(screen.queryByTestId("button-hide-reviewed")).toBeNull();
    expect(screen.getByTestId("text-row-count-collapsed")).toBeTruthy();
  });
});
