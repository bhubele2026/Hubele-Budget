import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (W1) The Amex page keeps its view in the address: `?card=` (and the older
 *   `?accountId=`), `?month=`, `?mode=`. A refresh or a shared link opens the
 *   same view, the Summary's By-card list writes `?card=` (P1: the shell's card tabs
 *   and that list select; the band is the embedded page's), and other params survive.
 *
 * The clock is Wednesday 2026-10-14 (local): this week is Sun 10-11 – Sat 10-17.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  wide: undefined as Array<Record<string, unknown>> | null | undefined, // null = the 12-month read is still loading
  params: [] as Array<Record<string, unknown>>,
  items: undefined as unknown[] | undefined,
  payoff: undefined as unknown,
  navigate: vi.fn(),
}));

vi.mock("recharts", () => import("@/test-recharts-stub"));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  useLocation: () => ["/next/accounts/x", state.navigate] as const,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
// (P1) The household link reads the plan state (spine / period breakdown): not this test's subject.
vi.mock("@/components/amex-over-link", () => ({ AmexOverLink: () => null }));
// The All cards summary lists each card (the By card list): synthetic figures.
vi.mock("@workspace/api-client-react/features", () => ({
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
  useGetAmexSummary: (p: { accountId: string; from: string; to: string }) => ({
    data: {
      scope: {
        kind: p.accountId === "all" ? "all" : "card",
        accountId: p.accountId === "all" ? null : p.accountId,
        name: null, mask: null, institution: null,
        cards: [{ accountId: "ext-plat", name: "Platinum", mask: "1005", institution: "American Express", brand: "silver", cadence: "weekly", debtLinked: false, debtId: null, owed: "100.00", paidAs: null, purchases: { amount: "12.34", count: 1 } }],
      },
      period: { from: p.from, to: p.to, timezone: "America/Chicago" },
      owed: { current: "100.00", statement: null, asOf: null, source: "plaid" },
      purchases: { amount: "12.34", count: 1, reimbursable: { amount: "0.00", count: 0 } },
      refunds: { amount: "0.00", count: 0 }, payments: { amount: "0.00", count: 0 }, otherCredits: { amount: "0.00", count: 0 },
      otherCharges: { amount: "0.00", count: 0 }, notMine: { amount: "0.00", count: 0 },
      householdContribution: { weeklyPlan: "0.00", weeklyKnown: "0.00", weeklyUnresolved: "0.00", monthlyPlan: "0.00", monthlyKnown: "0.00", monthlyUnresolved: "0.00", unfiled: "0.00", link: "/spending/week" },
      planLink: { kind: "none", payoff: null, payoffDate: null, basis: null, debtId: null, name: null, minimum: null, avalancheRank: null, status: null },
      needsAttention: {
        unplanned: { amount: "0.00", count: 0, truncated: false, rows: [] },
        unfiled: { amount: "0.00", count: 0, truncated: false, rows: [] },
        uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
        truncated: false,
      },
      limitations: [],
    },
    isError: false,
    isFetching: false,
  }),
}));
vi.mock("@/components/plaid-link-button", () => ({ PlaidLinkButton: () => null }));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/category-picker", () => ({
  CategoryPicker: () => null,
  defaultRememberPattern: (s: string) => s,
}));
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));
vi.mock("@/components/matched-rule-chip", () => ({ MatchedRuleChip: () => null }));
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => <span>add</span> }));

vi.mock("@workspace/api-client-react", () => {
  const TransactionWeeklyBucket = { groceries: "groceries", dining: "dining", alcohol: "alcohol", entertainment: "entertainment", misc: "misc" } as const;
  const mutation = () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false });
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useGetAmexWeeklyPayoff: () => ({ data: state.payoff, isLoading: false }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    // Every list read is recorded; the month read answers the rows, the wide one too.
    useListTransactions: (params: Record<string, unknown> = {}) => {
      state.params.push(params);
      // The 12-month trend read (limit 5000) may be answered apart from the month's rows.
      const isWide = state.wide !== undefined && params.limit === 5000;
      return { data: isWide ? (state.wide ?? undefined) : state.rows, isLoading: isWide && state.wide === null, isPlaceholderData: false };
    },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: mutation,
    useBulkUpdateTransactions: () => ({
      mutateAsync: async (vars: { data: { ids: string[] } }) => ({ results: vars.data.ids.map((id) => ({ id, ok: true })) }),
      mutate: () => undefined,
      isPending: false,
    }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: mutation,
    useDeleteMappingRule: mutation,
    useUpdateMappingRule: mutation,
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: (p?: unknown) => ["/api/transactions", p],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({ data: state.items }),
    useSyncPlaidTransactions: mutation,
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    getListPlaidLiabilityAccountsQueryKey: () => ["/api/plaid/liabilities"],
    getListDebtsQueryKey: () => ["/api/debts"],
    getGetDashboardQueryKey: () => ["/api/dashboard"],
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
    usePutMerchantAlias: mutation,
    useDeleteMerchantAlias: mutation,
    customFetch: async () => undefined,
  };
});

import AmexPage from "./amex";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 0));
afterAll(() => {
  vi.useRealTimers();
});

const ITEMS = [
  {
    id: "item-amex",
    institutionName: "American Express",
    institutionSlug: "amex",
    accounts: [{ id: "row-plat", accountId: "ext-plat", name: "Platinum", mask: "1005", type: "credit", subtype: "credit card" }],
  },
  {
    id: "item-chase",
    institutionName: "Chase",
    institutionSlug: "chase",
    accounts: [{ id: "row-free", accountId: "ext-freedom", name: "Freedom", mask: "4417", type: "credit", subtype: "credit card" }],
  },
];
const PAYOFF = {
  weekStart: "2026-10-11",
  weekEnd: "2026-10-17",
  combinedWeekCharges: 20,
  combinedStatementBalance: 2000,
  cards: [
    { accountId: "ext-plat", plaidAccountId: "row-plat", debtId: null, name: "Platinum", brand: "platinum", cadence: "weekly", periodLabel: "", displayName: null, weekCharges: 20, chargeCount: 1, statementBalance: 2000, pctOfStatementThisWeek: 0.1, topMerchant: null },
  ],
};

function txn(o: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "tx",
    occurredOn: "2026-10-14",
    description: "ROW",
    amount: "12.34",
    source: "plaid:amex",
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
    plaidAccountId: "ext-plat",
    reviewed: false,
    member: null,
    pending: false,
    ...o,
  };
}

let qc: QueryClient;
function show(props: React.ComponentProps<typeof AmexPage> = {}) {
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  window.localStorage.clear();
  window.history.replaceState(null, "", "/amex");
  state.rows = [];
  state.wide = undefined;
  state.params = [];
  state.items = ITEMS;
  state.payoff = PAYOFF;
  state.navigate.mockReset();
});
afterEach(() => cleanup());

describe("(W1) the Amex page's view is in the address", () => {
  it("?card= opens that card; the older ?accountId= does too", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    state.rows = [txn({ id: "p1" })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    // (P1) The card is named once, in the header chip, with its tab's words.
    expect(screen.getByTestId("account-head-identity").textContent).toContain("Platinum");
    expect(screen.getByTestId("account-head-identity").textContent).toContain("••1005");
    expect(screen.queryByTestId("amex-head-all-cards")).toBeNull();
    cleanup();
    window.history.replaceState(null, "", "/amex?accountId=ext-plat");
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    expect(screen.getByTestId("account-head-identity").textContent).toContain("••1005");
  });

  it("(Q6b r3) a card with no rows in the opened month stays chosen: the 12-month rows know it", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat&month=2026-09-01");
    state.rows = [];
    state.wide = null; // the month answered (no rows) before the 12-month read did
    show();
    await waitFor(() => expect(state.params.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(new URLSearchParams(window.location.search).get("card")).toBe("ext-plat");
    expect(screen.getByTestId("account-head-identity").textContent).toContain("Platinum");
    expect(screen.queryByTestId("amex-head-all-cards")).toBeNull();
  });

  it("(P1) choosing a card in the By card list writes ?card= (one history entry) and keeps other params", async () => {
    window.history.replaceState(null, "", "/amex?category=Dining");
    state.rows = [txn({ id: "p1" })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    const before = window.history.length;
    fireEvent.click(screen.getByTestId("amex-card-balance-ext-plat"));
    expect(new URLSearchParams(window.location.search).get("card")).toBe("ext-plat");
    expect(new URLSearchParams(window.location.search).get("category")).toBe("Dining");
    expect(window.history.length).toBe(before + 1);
    await waitFor(() => expect(screen.getByTestId("account-head-identity").textContent).toContain("••1005"));
  });

  it("the month and the Wk/Mo/Yr mode are written, and a reload (remount) opens the same view", async () => {
    state.rows = [txn({ id: "p1" })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("range-mo"));
    fireEvent.click(screen.getByTestId("button-prev-month"));
    const p = new URLSearchParams(window.location.search);
    expect(p.get("mode")).toBe("month");
    expect(p.get("month")).toBe("2026-09-01");
    cleanup();
    show();
    await waitFor(() => expect(screen.getByTestId("text-selected-month")).toBeTruthy());
    expect(screen.getByTestId("text-selected-month").textContent).toContain("Sep");
    expect(screen.getByTestId("range-mo").getAttribute("aria-pressed")).toBe("true");
  });

  it("embedded for one card, the address is left alone by the card (the route names it)", async () => {
    window.history.replaceState(null, "", "/next/accounts/ext-freedom?card=other");
    state.rows = [txn({ id: "f1", source: "plaid:chase", plaidAccountId: "ext-freedom" })];
    show({ embedded: true, accountId: "ext-freedom" });
    await waitFor(() => expect(screen.getByTestId("row-amex-f1")).toBeTruthy());
    expect(new URLSearchParams(window.location.search).get("card")).toBe("other");
  });
});
