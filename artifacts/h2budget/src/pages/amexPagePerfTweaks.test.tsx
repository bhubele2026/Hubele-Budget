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
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
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
  state.pendingUpdate = false;
});
afterEach(() => cleanup());

describe("Amex page perf tweaks", () => {
  it("shows the cap-hit hint when the month query returns ≥ 1000 rows", async () => {
    // Park the rows on a date far outside the selected month so the
    // page's `monthScoped` filter keeps the visible list empty — we
    // only need `monthAll.length` to clear the cap to surface the
    // hint, not to render 1000 rows.
    state.monthTxns = Array.from({ length: 1000 }, (_, i) =>
      makeTxn({ id: `tx-cap-${i}`, occurredOn: "1900-01-01", postedOn: "1900-01-01" }),
    );
    renderPage();
    await waitFor(() => {
      const hint = screen.getByTestId("text-month-cap-hit");
      expect(hint.textContent ?? "").toMatch(/Showing first 1000/);
    });
  });

  it("does not show the cap-hit hint when the month query returns fewer rows", async () => {
    state.monthTxns = [makeTxn()];
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText(/STARBUCKS/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("text-month-cap-hit")).toBeNull();
  });

  it("shows the bulk progress chip while a bulk action is in flight", async () => {
    // Two visible transactions so we can select one and run a bulk
    // action on it. `pendingUpdate` makes the underlying mutateAsync
    // hang so the chip stays visible while we assert.
    state.monthTxns = [
      makeTxn({ id: "tx-bulk-1", description: "STARBUCKS A" }),
      makeTxn({ id: "tx-bulk-2", description: "STARBUCKS B" }),
    ];
    state.pendingUpdate = true;
    renderPage();

    // Wait for rows to render, then select the first row via its
    // checkbox. Both the mobile and desktop layouts render in jsdom,
    // so we just take the first matching checkbox.
    await waitFor(() => {
      expect(screen.getAllByText(/STARBUCKS A/).length).toBeGreaterThan(0);
    });
    const checkboxes = screen.getAllByLabelText("Select");
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]);

    // The bulk action bar appears once a row is selected; trigger a
    // bulk owed-by clear (it routes through `runBulkPatch`, which is
    // what drives the progress chip).
    await waitFor(() => {
      expect(screen.getByTestId("button-bulk-clear-owed-by")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("button-bulk-clear-owed-by"));

    // The chip text uses an ellipsis character — match loosely so a
    // future copy tweak doesn't break the assertion.
    await waitFor(() => {
      const chip = screen.getByTestId("text-bulk-progress");
      expect(chip).toBeTruthy();
      expect(within(chip).getByText(/Updating\s+\d+\/1/)).toBeTruthy();
    });
  });
});
