import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #615 — picking a bucket bubble (WK / MO / UN / RE) is itself
// the act of reviewing the row, so the standalone RV bubble was
// removed and the bucket toggle handler now folds `reviewed` into
// the same PATCH. These tests lock in that behavior for both the
// turn-on and the clear-bucket-back-to-none cases.

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
vi.mock("@/components/matched-rule-chip", () => ({ MatchedRuleChip: () => null }));

// Real-ish BucketBubbles mock that surfaces a clickable button per
// bucket so the page's onBubbleToggle wiring is exercised end-to-end.
vi.mock("@/components/bucket-bubbles", () => ({
  BucketBubbles: ({
    flags,
    onToggle,
  }: {
    flags: Record<string, boolean>;
    onToggle: (b: string, next: boolean) => void;
  }) => (
    <div>
      {(["weekly", "monthly", "unplanned", "reimbursable"] as const).map((b) => (
        <button
          key={b}
          type="button"
          data-testid={`bucket-${b}`}
          data-on={flags[b] ? "true" : "false"}
          onClick={() => onToggle(b, !flags[b])}
        >
          {b}
        </button>
      ))}
    </div>
  ),
}));

const state = vi.hoisted(() => ({
  monthTxns: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{ id: string; data: Record<string, unknown> }>,
}));

const today = new Date();
const todayIso = today.toISOString().slice(0, 10);

function makeTxn(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useListTransactions: (params: { limit?: number } = {}) => {
      if ((params.limit ?? 0) >= 5000) {
        return { data: undefined, isLoading: true };
      }
      return { data: state.monthTxns, isLoading: false };
    },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: () => ({
      mutateAsync: async (args: { id: string; data: Record<string, unknown> }) => {
        state.updateCalls.push(args);
        return { ...makeTxn({ id: args.id }), ...args.data };
      },
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
    getListTransactionsQueryKey: () => ["/api/transactions"],
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
  state.monthTxns = [];
  state.updateCalls = [];
});
afterEach(() => cleanup());

describe("Amex bucket bubble auto-reviews the row (#615)", () => {
  it("does not render the standalone RV bubble", async () => {
    state.monthTxns = [makeTxn()];
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText(/STARBUCKS/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId(/^button-reviewed-/)).toBeNull();
  });

  it("clicking the WK bubble PATCHes weeklyAllowance=true AND reviewed=true in one call", async () => {
    state.monthTxns = [makeTxn()];
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId("bucket-weekly").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByTestId("bucket-weekly")[0]);

    await waitFor(() => {
      expect(state.updateCalls.length).toBeGreaterThan(0);
    });
    const call = state.updateCalls[0];
    expect(call.data).toMatchObject({
      weeklyAllowance: true,
      monthlyAllowance: false,
      unplannedAllowance: false,
      reviewed: true,
    });
  });

  it("clicking the currently-on bucket clears it AND clears reviewed in one call", async () => {
    state.monthTxns = [
      makeTxn({ weeklyAllowance: true, weeklyBucket: "misc", reviewed: true }),
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId("bucket-weekly").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByTestId("bucket-weekly")[0]);

    await waitFor(() => {
      expect(state.updateCalls.length).toBeGreaterThan(0);
    });
    const call = state.updateCalls[0];
    expect(call.data).toMatchObject({
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      reviewed: false,
    });
  });

  it("clicking RE on PATCHes reimbursable=true AND reviewed=true in one call (#616)", async () => {
    state.monthTxns = [makeTxn()];
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId("bucket-reimbursable").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByTestId("bucket-reimbursable")[0]);
    await waitFor(() => {
      expect(state.updateCalls.length).toBeGreaterThan(0);
    });
    expect(state.updateCalls[0].data).toMatchObject({
      reimbursable: true,
      reviewed: true,
    });
  });

  it("clicking RE off when no other bucket is on PATCHes reviewed=false in the same call (#616)", async () => {
    state.monthTxns = [makeTxn({ reimbursable: true, reviewed: true })];
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId("bucket-reimbursable").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByTestId("bucket-reimbursable")[0]);
    await waitFor(() => {
      expect(state.updateCalls.length).toBeGreaterThan(0);
    });
    const call = state.updateCalls[0];
    expect(call.data).toMatchObject({
      reimbursable: false,
      reimbursed: false,
      reviewed: false,
    });
  });

  it("clicking RE off when WK is still on leaves reviewed=true (#616)", async () => {
    state.monthTxns = [
      makeTxn({
        reimbursable: true,
        weeklyAllowance: true,
        weeklyBucket: "misc",
        reviewed: true,
      }),
    ];
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId("bucket-reimbursable").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByTestId("bucket-reimbursable")[0]);
    await waitFor(() => {
      expect(state.updateCalls.length).toBeGreaterThan(0);
    });
    const call = state.updateCalls[0];
    expect(call.data.reimbursable).toBe(false);
    expect(call.data.reimbursed).toBe(false);
    expect("reviewed" in call.data).toBe(false);
  });
});
