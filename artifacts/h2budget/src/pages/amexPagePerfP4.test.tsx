import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Regression coverage for task #485 — the Amex page splits its data
// fetches into a fast month-window query and a slower 12-month trend
// query. The day-grouped list must render as soon as the month query
// resolves, even while the trend query is still pending.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

// (P4) A controllable IntersectionObserver: nothing is "near" until a test says so.
const io = vi.hoisted(() => ({ cbs: [] as Array<(e: Array<{ isIntersecting: boolean }>) => void> }));
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
    io.cbs.push(cb);
  }
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
};

const h = vi.hoisted(() => ({
  txCalls: [] as Array<{ limit: number; enabled: boolean | undefined }>,
  fetched: [] as string[],
  monthPending: false,
}));

vi.mock("@workspace/api-client-react/features", () => ({
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
  useGetAmexSummary: (_p: unknown, o?: { query?: { enabled?: boolean } }) => ({
    data:
      o?.query?.enabled === false
        ? undefined
        : {
            scope: { kind: "all", accountId: null, name: null, mask: null, institution: null, cards: [] },
            period: { from: "2026-10-11", to: "2026-10-17", timezone: "America/Chicago" },
            owed: { current: "1234.50", statement: null, asOf: "2026-10-14T12:00:00Z", source: "plaid" },
            purchases: { amount: "10.00", count: 1, reimbursable: { amount: "0.00", count: 0 } },
            refunds: { amount: "0.00", count: 0 },
            payments: { amount: "0.00", count: 0 },
            otherCredits: { amount: "0.00", count: 0 },
            otherCharges: { amount: "0.00", count: 0 },
            notMine: { amount: "0.00", count: 0 },
            householdContribution: { amount: "0.00", count: 0, spent: "0.00", weekPlan: null, remaining: null, scope: "all" },
            planLink: { kind: "none" },
            needsAttention: {
              unplanned: { amount: "0.00", count: 0, truncated: false, rows: [] },
              unfiled: { amount: "0.00", count: 0, truncated: false, rows: [] },
              uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
              truncated: false,
            },
            limitations: [],
          },
    isError: false,
  }),
}));

vi.mock("@workspace/api-client-react", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const TransactionWeeklyBucket = {
    groceries: "groceries",
    dining: "dining",
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  return {
    ...real,
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useGetAmexWeeklyPayoff: () => ({ data: { cards: [{ accountId: "card-1", name: "Blue Cash", brand: "blue", pctOfStatementThisWeek: 0.5, debtId: null }], debtLinkedCards: [] }, isLoading: false }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    // First call: month query — resolves immediately. Second call:
    // trend query — never resolves (still loading). The page must
    // still render the day group.
    // Distinguish the month query (limit 1000) from the trend query
    // (limit 5000) by params, so re-renders keep returning the right
    // shape rather than racing through `mockImplementationOnce`.
    useListTransactions: (params: { limit?: number } = {}, opts?: { query?: { enabled?: boolean } }) => {
      h.txCalls.push({ limit: params.limit ?? 0, enabled: opts?.query?.enabled });
      if ((params.limit ?? 0) >= 5000) {
        return { data: undefined, isLoading: opts?.query?.enabled !== false, isError: false };
      }
      if (h.monthPending) return { data: undefined, isLoading: true };
      return { data: [monthTxn], isLoading: false };
    },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
    }),
    // (#502) The page calls `useBulkUpdateTransactions` at top level
    // even when no bulk action is in flight, so the mock has to
    // exist for the page to render at all.
    useBulkUpdateTransactions: () => ({
      mutateAsync: async (vars: { data: { ids: string[] } }) => ({
        results: vars.data.ids.map((id) => ({ id, ok: true })),
      }),
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
    customFetch: async (url: string) => {
      h.fetched.push(url);
      return { amexEndingBalance: 100, asOf: "2026-10-14T12:00:00Z", source: "plaid" };
    },
  };
});

import AmexPage from "./amex";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.txCalls.length = 0;
  h.fetched.length = 0;
  h.monthPending = false;
  io.cbs.length = 0;
});
afterEach(() => cleanup());

const trendCalls = () => h.txCalls.filter((c) => c.limit >= 5000);

describe("Amex page — fewer, earlier calls (P4)", () => {
  it("the card band and the summary render while the month's rows are still loading", async () => {
    h.monthPending = true;
    renderPage();
    await waitFor(() => expect(screen.getByTestId("amex-tile-all")).toBeTruthy());
    expect(screen.queryByTestId("account-page-skeleton")).toBeNull();
    expect(screen.getByTestId("ledger-chart-skeleton")).toBeTruthy();
  });

  it("the 12-month trend waits until the chart is near the viewport", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/STARBUCKS/).length).toBeGreaterThan(0));
    expect(trendCalls().length).toBeGreaterThan(0);
    expect(trendCalls().every((c) => c.enabled === false)).toBe(true);
    // (Q3) "All cards" draws no combined chart: the cards' balances hold its
    // slot, and the 12-month read still waits until that slot is near.
    expect(screen.getByTestId("amex-card-balances")).toBeTruthy();
    expect(screen.queryByTestId("amex-trend-pending")).toBeNull();
    act(() => {
      for (const cb of io.cbs) cb([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(trendCalls().some((c) => c.enabled === true)).toBe(true));
  });

  it("asks the summary for the balance: no /amex/anchor call where the summary is on", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/STARBUCKS/).length).toBeGreaterThan(0));
    expect(h.fetched.filter((u) => u.includes("/api/amex/anchor"))).toEqual([]);
  });
});
