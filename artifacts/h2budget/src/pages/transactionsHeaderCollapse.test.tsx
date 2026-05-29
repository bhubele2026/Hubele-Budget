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
    useGetForecastCashSignal: () => ({ data: undefined }),
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

describe("Transactions (Chase) filter collapse toggle (#806)", () => {
  it("starts with filters collapsed; tiles + row count stay visible; toggle reveals the filter fields and flips back", async () => {
    renderPage();

    const toggle = await screen.findByTestId("button-toggle-filters");
    // Filters collapsed by default on every load (no persistence).
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toMatch(/Show filters/);

    // Summary tiles + row-count chip are ALWAYS visible regardless of
    // the filter collapse state.
    expect(screen.getByTestId("text-row-count")).toBeTruthy();
    expect(screen.getByTestId("stat-money-in")).toBeTruthy();
    expect(screen.getByTestId("stat-money-out")).toBeTruthy();
    // Month switcher still visible.
    expect(screen.getByTestId("button-prev-month")).toBeTruthy();
    expect(screen.getByTestId("button-next-month")).toBeTruthy();
    expect(screen.getByTestId("text-selected-month")).toBeTruthy();

    // Filter fields hidden while collapsed.
    expect(screen.queryByTestId("input-search")).toBeNull();

    // Expand.
    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toMatch(/Hide filters/);
    expect(screen.getByTestId("input-search")).toBeTruthy();
    // Tiles + row count remain visible while expanded.
    expect(screen.getByTestId("text-row-count")).toBeTruthy();
    expect(screen.getByTestId("stat-money-in")).toBeTruthy();

    // No persistence — nothing is written to localStorage.
    expect(
      window.localStorage.getItem("transactions.headerCollapsed"),
    ).toBeNull();

    // Collapse again.
    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("input-search")).toBeNull();
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
