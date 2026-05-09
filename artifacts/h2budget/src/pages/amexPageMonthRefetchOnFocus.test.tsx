import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  focusManager,
} from "@tanstack/react-query";
import React from "react";

// Regression coverage for task #501 — the Amex page wires its month
// query to refetch in the background when the tab regains focus, and
// the cached rows must stay visible while that refetch is in flight
// (i.e. the loading skeleton must NOT reappear). A future change to
// the QueryClient defaults or to the page's per-query options could
// silently regress either half of that contract.

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

const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const monthTxn = {
  id: "tx-month-1",
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
};

// Hoisted spy so the api-client mock can reach the same vi.fn() that
// the test asserts on.
const monthQueryFn = vi.hoisted(() =>
  vi.fn(async () => [
    {
      id: "tx-month-1",
      occurredOn: new Date().toISOString().slice(0, 10),
      postedOn: new Date().toISOString().slice(0, 10),
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
    },
  ]),
);

vi.mock("@workspace/api-client-react", async () => {
  // Use the real react-query useQuery for the month query so the
  // page's `refetchOnWindowFocus` / `refetchOnMount` options actually
  // run through React Query and we can observe the refetch.
  const rq = await import("@tanstack/react-query");
  const TransactionWeeklyBucket = {
    groceries: "groceries",
    dining: "dining",
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useListTransactions: (
      params: { limit?: number; from?: string; to?: string; source?: string } = {},
      opts?: { query?: Record<string, unknown> },
    ) => {
      // Trend (12-month) query: stays loading so the page renders
      // entirely off the month query.
      if ((params.limit ?? 0) >= 5000) {
        return { data: undefined, isLoading: true };
      }
      const queryKey = ["/api/transactions", params];
      const query = rq.useQuery({
        queryKey,
        queryFn: monthQueryFn,
        ...(opts?.query ?? {}),
      });
      return {
        data: query.data,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
      };
    },
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
    useDeleteMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    useUpdateMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: (
      params: Record<string, unknown> = {},
    ) => ["/api/transactions", params],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({ data: [] }),
    useSyncPlaidTransactions: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
      isPending: false,
    }),
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    customFetch: async () => undefined,
  };
});

import AmexPage from "./amex";

function renderPage() {
  // Leave the QueryClient defaults alone (the page passes
  // `refetchOnWindowFocus: true` explicitly, so it overrides any
  // default we would set here anyway). `gcTime: 0` is fine.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  monthQueryFn.mockClear();
  // Start "focused" so the first mount's auto-fetch runs normally.
  focusManager.setFocused(true);
});
afterEach(() => {
  cleanup();
  // Reset to React Query's default focus tracking so other tests
  // aren't affected.
  focusManager.setFocused(undefined);
});

describe("Amex page — month query refetches on tab focus", () => {
  it("refetches the month query when the window regains focus and keeps cached rows visible (no skeleton)", async () => {
    renderPage();

    // Wait for the initial month fetch to settle and rows to render.
    await waitFor(() => {
      expect(screen.getAllByText(/STARBUCKS/).length).toBeGreaterThan(0);
    });
    const initialCalls = monthQueryFn.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // Park the queryFn on a never-resolving promise so the refetch
    // stays in flight long enough for us to assert the skeleton does
    // NOT reappear and the cached row is still visible.
    let resolveSecond: ((v: unknown) => void) | null = null;
    monthQueryFn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve as (v: unknown) => void;
        }),
    );

    // Simulate the tab losing then regaining focus. React Query
    // uses its own focusManager, so toggling it directly is the
    // most reliable way to trigger `refetchOnWindowFocus` in jsdom.
    act(() => {
      focusManager.setFocused(false);
    });
    act(() => {
      focusManager.setFocused(true);
    });

    // The page should have kicked off a background refetch.
    await waitFor(() => {
      expect(monthQueryFn.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    // Cached row is still on screen — the page never flipped back
    // into its loading-skeleton branch.
    expect(screen.getAllByText(/STARBUCKS/).length).toBeGreaterThan(0);
    // The loading-only branch returns three Skeleton elements as the
    // entire subtree; if it had re-rendered, the STARBUCKS row would
    // be gone. As an extra guard, make sure the day-group list root
    // (rendered only in the non-loading branch) is still mounted.
    // Any element with the description satisfies that — the assertion
    // above already covers it, so we just resolve the pending fetch.

    // Let the in-flight refetch finish so React doesn't warn about
    // pending state updates after the test ends.
    await act(async () => {
      resolveSecond?.([
        {
          ...monthTxn,
          description: "STARBUCKS REFRESHED",
        },
      ]);
    });

    // Once the refetch resolves, the new row should be visible too.
    await waitFor(() => {
      expect(screen.getAllByText(/STARBUCKS REFRESHED/).length).toBeGreaterThan(0);
    });
  });
});
