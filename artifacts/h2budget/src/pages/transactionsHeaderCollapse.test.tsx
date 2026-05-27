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
  useLocation: () => ["/transactions", () => undefined] as const,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-opportunistic-plaid-sync", () => ({
  useOpportunisticPlaidSync: () => undefined,
}));

vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({
    offerBulkRecategorize: () => undefined,
    previewDialog: null,
  }),
  bulkRuleFromRepointed: () => null,
  bulkRuleFromRuleAction: () => null,
}));

vi.mock("@/lib/useRuleActionUndo", () => ({
  useRuleActionUndo: () => () => undefined,
}));

vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));
vi.mock("@/components/sync-button", () => ({
  SyncButton: () => null,
}));
vi.mock("@/components/post-link-progress", () => ({
  PostLinkProgressBanner: () => null,
}));
vi.mock("@/components/plaid-reauth-banner", () => ({
  PlaidReauthBanner: () => null,
}));
vi.mock("@/components/bank-snapshot-freshness", () => ({
  BankSnapshotFreshness: () => null,
}));
vi.mock("@/components/transaction-row-chips", () => ({
  TransactionRowChips: () => null,
}));
vi.mock("@/components/matched-rule-chip", () => ({
  MatchedRuleChip: () => null,
}));

vi.mock("@workspace/api-client-react", () => {
  const noop = { mutate: () => undefined, mutateAsync: async () => undefined, isPending: false };
  return {
    useListTransactions: () => ({ data: [], isLoading: false }),
    useCreateTransaction: () => noop,
    useUpdateTransaction: () => noop,
    useClearTransferOverride: () => noop,
    useDeleteTransaction: () => noop,
    useListCategories: () => ({ data: [] }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useGetForecast: () => ({ data: undefined }),
    useRefreshForecastBank: () => ({ ...noop, isPending: false }),
    useSeedAprilChase: () => ({
      mutate: (_v: unknown, opts?: { onSuccess?: (r: unknown) => void }) => {
        opts?.onSuccess?.({ inserted: 0, rulesAdded: 0, snapshotRepaired: false });
      },
    }),
    useBulkSetForecastFlag: () => noop,
    // (#762 — Phase B) Manual Send-to-Review gate hooks consumed by
    // the Chase page wiring. Header-collapse tests don't exercise
    // them, so wired to no-ops.
    useSendTransactionsToReview: () => noop,
    useUnsendTransactionsFromReview: () => noop,
    useListPlaidItems: () => ({ data: [] }),
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
  };
});

import TransactionsPage from "./transactions";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage />
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

describe("Transactions (Chase) header collapse toggle (#759)", () => {
  it("starts expanded; toggle hides tiles + filter bar while keeping month switcher and row count visible; restores on second click", async () => {
    renderPage();

    const toggle = await screen.findByTestId(
      "button-toggle-transactions-header",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toMatch(/Hide filters/);

    // Defaults: filter bar + summary row count + tiles visible.
    expect(screen.getByTestId("text-row-count")).toBeTruthy();
    expect(screen.getByTestId("stat-money-in")).toBeTruthy();
    expect(screen.getByTestId("stat-money-out")).toBeTruthy();

    // Collapse.
    act(() => {
      fireEvent.click(toggle);
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/Show filters/);
    expect(screen.queryByTestId("text-row-count")).toBeNull();
    expect(screen.queryByTestId("stat-money-in")).toBeNull();
    expect(screen.queryByTestId("stat-money-out")).toBeNull();

    // Month switcher + collapsed row count still visible.
    expect(screen.getByTestId("text-row-count-collapsed")).toBeTruthy();
    expect(screen.getByTestId("button-prev-month")).toBeTruthy();
    expect(screen.getByTestId("button-next-month")).toBeTruthy();
    expect(screen.getByTestId("text-selected-month")).toBeTruthy();

    // Persisted to localStorage under the transactions-specific key
    // (must not collide with the Amex page's preference).
    expect(window.localStorage.getItem("transactions.headerCollapsed")).toBe(
      "1",
    );
    expect(window.localStorage.getItem("amex.headerCollapsed")).toBeNull();

    // Restore.
    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("text-row-count")).toBeTruthy();
    expect(screen.getByTestId("stat-money-in")).toBeTruthy();
    expect(screen.queryByTestId("text-row-count-collapsed")).toBeNull();
    expect(
      window.localStorage.getItem("transactions.headerCollapsed"),
    ).toBeNull();
  });

  it("reapplies the persisted collapsed preference on remount", async () => {
    window.localStorage.setItem("transactions.headerCollapsed", "1");
    renderPage();

    const toggle = await screen.findByTestId(
      "button-toggle-transactions-header",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/Show filters/);
    expect(screen.queryByTestId("text-row-count")).toBeNull();
    expect(screen.queryByTestId("stat-money-in")).toBeNull();
    expect(screen.getByTestId("text-row-count-collapsed")).toBeTruthy();
  });
});
