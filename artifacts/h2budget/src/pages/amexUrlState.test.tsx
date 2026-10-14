import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (W1) The Amex page keeps its view in the address: `?card=` (and the older
 *   `?accountId=`), `?month=`, `?mode=`. A refresh or a shared link opens the
 *   same view, the band writes `?card=`, and other params (`?tx=`) survive.
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

describe("(W1) the Amex page's view is in the address", () => {
  it("?card= opens that card; the older ?accountId= does too", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    state.rows = [txn({ id: "p1" })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    const tile = document.querySelector('[data-account-id="ext-plat"] button[aria-pressed]') as HTMLElement;
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("amex-tile-all").getAttribute("aria-pressed")).toBe("false");
    cleanup();
    window.history.replaceState(null, "", "/amex?accountId=ext-plat");
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    expect((document.querySelector('[data-account-id="ext-plat"] button[aria-pressed]') as HTMLElement).getAttribute("aria-pressed")).toBe("true");
  });

  it("choosing a card in the band writes ?card=, All cards removes it, and ?tx= is kept", async () => {
    window.history.replaceState(null, "", "/amex?category=Dining");
    state.rows = [txn({ id: "p1" })];
    show();
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    fireEvent.click(document.querySelector('[data-account-id="ext-plat"] button[aria-pressed]') as HTMLElement);
    expect(new URLSearchParams(window.location.search).get("card")).toBe("ext-plat");
    expect(new URLSearchParams(window.location.search).get("category")).toBe("Dining");
    fireEvent.click(screen.getByTestId("amex-tile-all"));
    expect(new URLSearchParams(window.location.search).has("card")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("category")).toBe("Dining");
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
