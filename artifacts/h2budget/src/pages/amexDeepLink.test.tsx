import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (WP7c) The card ledger (the Amex page) embedded for ONE card, and opened on
 * one row.
 *
 * - Embedded (`/next/accounts/:id`) it asks for that card's rows by its Plaid
 *   account (`plaidAccountId`), never by the Amex source list, so a card from
 *   another bank (a Chase Freedom, `source: "plaid:chase"`) lists its own rows.
 *   Standalone it keeps the source list: All cards is the one view that lists
 *   the workbook rows.
 * - Embedded, the card band does not filter in place (the page holds one
 *   card's rows): another card opens that card's page, All cards opens /amex.
 * - `?tx=<id>&month=YYYY-MM-01` opens Month mode on that month, the first-load
 *   jump never moves it, and the page says "Showing <Month> for the row you
 *   opened".
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
      return { data: state.rows, isLoading: false };
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
  state.params = [];
  state.items = ITEMS;
  state.payoff = PAYOFF;
  state.navigate.mockReset();
});
afterEach(() => cleanup());

describe("(WP7c) embedded for one card: its rows by its Plaid account", () => {
  it("a Chase Freedom's page asks by plaidAccountId, never by the Amex source list, and lists its own rows", async () => {
    state.rows = [txn({ id: "f1", description: "PANERA", source: "plaid:chase", plaidAccountId: "ext-freedom" })];
    show({ embedded: true, accountId: "ext-freedom" });
    await waitFor(() => expect(screen.getByTestId("row-amex-f1")).toBeTruthy());
    expect(state.params.length).toBeGreaterThan(0);
    for (const p of state.params) {
      expect(p.plaidAccountId).toBe("ext-freedom");
      expect("source" in p).toBe(false);
    }
  });

  it("standalone keeps the Amex source list (All cards lists the workbook rows) and never sends plaidAccountId", async () => {
    state.rows = [txn({ id: "p1" }), txn({ id: "w1", source: "amex", plaidAccountId: null })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-w1")).toBeTruthy());
    for (const p of state.params) {
      expect(p.source).toBe("amex,plaid:amex,plaid:apple-card,apple-card");
      expect("plaidAccountId" in p).toBe(false);
    }
  });

  it("the card band opens the other card's page, and All cards the American Express page, instead of filtering in place", async () => {
    state.rows = [txn({ id: "f1", source: "plaid:chase", plaidAccountId: "ext-freedom" })];
    show({ embedded: true, accountId: "ext-freedom" });
    await waitFor(() => expect(screen.getByTestId("row-amex-f1")).toBeTruthy());
    const platTile = document.querySelector('[data-account-id="ext-plat"]') as HTMLElement;
    fireEvent.click(within(platTile).getAllByRole("button")[0]!);
    expect(state.navigate).toHaveBeenCalledWith("/next/accounts/ext-plat");
    fireEvent.click(screen.getByTestId("amex-tile-all"));
    expect(state.navigate).toHaveBeenCalledWith("/amex");
    // The card's own rows stay.
    expect(screen.getByTestId("row-amex-f1")).toBeTruthy();
  });
});

describe("(WP7c) a link to one row opens Month mode on its month", () => {
  it("?tx=&month= on this month: Month mode, the status line, and a row from before this week is listed", async () => {
    window.history.replaceState(null, "", "/amex?tx=early&month=2026-10-01");
    state.rows = [txn({ id: "early", occurredOn: "2026-10-03", description: "EARLY OCTOBER" }), txn({ id: "now", occurredOn: "2026-10-14" })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-early")).toBeTruthy());
    expect(screen.getByTestId("amex-row-link-status").textContent).toBe("Showing October 2026 for the row you opened");
    expect(screen.getByTestId("amex-row-link-status").getAttribute("role")).toBe("status");
  });

  it("without a row link the week opens (unchanged): the earlier row is not listed", async () => {
    state.rows = [txn({ id: "early", occurredOn: "2026-10-03" }), txn({ id: "now", occurredOn: "2026-10-14" })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-now")).toBeTruthy());
    expect(screen.queryByTestId("row-amex-early")).toBeNull();
    expect(screen.queryByTestId("amex-row-link-status")).toBeNull();
  });

  it("the first-load jump to the latest month never moves a month the link chose", async () => {
    window.history.replaceState(null, "", "/amex?tx=aug&month=2026-08-01");
    // The latest data is in September, not this month: without the guard the page jumped there.
    state.rows = [txn({ id: "aug", occurredOn: "2026-08-20", description: "AUGUST" }), txn({ id: "sep", occurredOn: "2026-09-25", description: "SEPTEMBER" })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-aug")).toBeTruthy());
    expect(screen.getByTestId("text-selected-month").textContent).toContain("Aug");
    expect(screen.queryByTestId("row-amex-sep")).toBeNull();
    expect(screen.getByTestId("amex-row-link-status").textContent).toBe("Showing August 2026 for the row you opened");
  });

  it("embedded with a row link: the card's own rows, on the row's month", async () => {
    window.history.replaceState(null, "", "/next/accounts/ext-freedom?tx=f-old&month=2026-10-01");
    state.rows = [txn({ id: "f-old", occurredOn: "2026-10-02", source: "plaid:chase", plaidAccountId: "ext-freedom" })];
    show({ embedded: true, accountId: "ext-freedom" });
    await waitFor(() => expect(screen.getByTestId("row-amex-f-old")).toBeTruthy());
    expect(screen.getByTestId("amex-row-link-status")).toBeTruthy();
    expect(state.params.every((p) => p.plaidAccountId === "ext-freedom")).toBe(true);
  });
});
