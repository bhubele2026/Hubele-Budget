import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (W4) The Amex page as a review destination: every card in the selector
 * (debt-linked ones too, `name ••last4`), the summary first, the needs-attention
 * rows that jump to the activity, the bucket marks named, and the chart's
 * title. The server's figures are fixtures here; nothing is computed.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

vi.mock("recharts", () => import("@/test-recharts-stub"));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
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
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => <span>add</span> }));

const state = vi.hoisted(() => ({
  monthTxns: undefined as Array<Record<string, unknown>> | undefined,
  items: undefined as unknown[] | undefined,
  payoff: undefined as unknown,
  /** (WP7c) Every list read's params, in order. */
  listParams: [] as Array<Record<string, unknown>>,
  summary: undefined as unknown,
  summaryParams: [] as Array<Record<string, unknown>>,
}));

const today = new Date();
const todayIso = today.toISOString().slice(0, 10);

function makeTxn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tx-1",
    occurredOn: todayIso,
    postedOn: todayIso,
    description: "STARBUCKS",
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
    ...overrides,
  };
}

const ITEMS = [
  {
    id: "item-amex",
    institutionName: "American Express",
    institutionSlug: "amex",
    accounts: [
      { id: "row-plat", accountId: "ext-plat", name: "Platinum", mask: "1005", type: "credit", subtype: "credit card" },
      { id: "row-gold", accountId: "ext-gold", name: "Gold", mask: "2002", type: "credit", subtype: "credit card" },
    ],
  },
];
const PAYOFF = {
  weekStart: todayIso,
  weekEnd: todayIso,
  combinedWeekCharges: 20,
  combinedStatementBalance: 3000,
  cards: [
    { accountId: "ext-plat", plaidAccountId: "row-plat", debtId: null, name: "Platinum", brand: "platinum", cadence: "weekly", periodLabel: "", displayName: null, weekCharges: 20, chargeCount: 1, statementBalance: 2000, pctOfStatementThisWeek: 0.1, topMerchant: null },
  ],
  debtLinkedCards: [
    { accountId: "ext-gold", name: "Gold Card", mask: "2002", debtId: "d-gold", brand: "blue", cadence: "weekly", displayName: null },
  ],
};

vi.mock("@workspace/api-client-react/features", () => ({
  useGetAmexSummary: (params: Record<string, unknown>) => {
    state.summaryParams.push(params);
    return { data: state.summary, isError: false, isLoading: false };
  },
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
}));
vi.mock("@workspace/api-client-react", () => {
  const TransactionWeeklyBucket = {
    groceries: "groceries",
    dining: "dining",
    alcohol: "alcohol",
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  const mutation = () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false });
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useGetAmexWeeklyPayoff: () => ({ data: state.payoff, isLoading: false }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    useListTransactions: (params: { limit?: number } = {}) => {
      state.listParams.push(params as Record<string, unknown>);
      if ((params.limit ?? 0) >= 5000) return { data: undefined, isLoading: true };
      return { data: state.monthTxns, isLoading: state.monthTxns === undefined };
    },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: mutation,
    useBulkUpdateTransactions: () => ({
      mutateAsync: async (vars: { data: { ids: string[] } }) => ({
        results: vars.data.ids.map((id) => ({ id, ok: true })),
      }),
      mutate: () => undefined,
      isPending: false,
    }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: mutation,
    useDeleteMappingRule: mutation,
    useUpdateMappingRule: mutation,
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
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
import { BRAND_LABEL } from "@/lib/amexBrand";

let qc: QueryClient;
function tree(props: React.ComponentProps<typeof AmexPage> = {}) {
  return (
    <QueryClientProvider client={qc}>
      <AmexPage {...props} />
    </QueryClientProvider>
  );
}

const ROWS = () => [
  // Plaid rows: money out is negative, money in is positive.
  makeTxn({ id: "p1", description: "PLATROW", source: "plaid", plaidAccountId: "ext-plat", amount: "-40.00" }),
  makeTxn({ id: "pay1", description: "AUTOPAY PAYMENT THANK YOU", source: "plaid", plaidAccountId: "ext-plat", amount: "200.00" }),
  makeTxn({ id: "ref1", description: "REFUND BEST BUY", source: "plaid", plaidAccountId: "ext-plat", amount: "15.00" }),
  makeTxn({ id: "g1", description: "GOLDROW", source: "plaid", plaidAccountId: "ext-gold", amount: "-25.00" }),
];

const total = (amount: string, count: number) => ({ amount, count });
function summaryFixture(over: Record<string, unknown> = {}) {
  return {
    scope: { kind: "all", accountId: null, name: null, mask: null, institution: null, cards: [] },
    period: { from: todayIso, to: todayIso, timezone: "America/Chicago" },
    owed: { current: "842.10", statement: "800.00", asOf: null, source: "plaid" },
    purchases: { amount: "425.00", count: 7, reimbursable: total("30.00", 1) },
    refunds: total("15.00", 1),
    payments: total("200.00", 1),
    otherCredits: total("10.00", 1),
    otherCharges: total("5.00", 1),
    notMine: total("0.00", 0),
    householdContribution: { weeklyPlan: "560.00", monthlyPlan: "45.00", unfiled: "0.00", link: "/spending/week" },
    planLink: { kind: "weekly_hook", payoff: "600.00", payoffDate: todayIso, basis: "plan", debtId: null, name: null, minimum: null, avalancheRank: null, status: null },
    needsAttention: {
      unplanned: {
        amount: "40.00", count: 1, truncated: false,
        rows: [{ id: "p1", date: todayIso, displayName: "Best Buy", amount: "40.00", pending: false, category: null, flags: ["unplanned"], card: { accountId: "ext-plat", name: "Platinum", mask: "1005" } }],
      },
      unfiled: { amount: "0.00", count: 0, truncated: false, rows: [] },
      uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
      truncated: false,
    },
    limitations: [],
    ...over,
  };
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  window.localStorage.clear();
  window.history.replaceState(null, "", "/amex");
  state.monthTxns = ROWS();
  state.items = ITEMS;
  state.payoff = PAYOFF;
  state.listParams = [];
  state.summary = summaryFixture();
  state.summaryParams = [];
});
afterEach(() => cleanup());

const tile = (accountId: string) => document.querySelector(`[data-account-id="${accountId}"]`) as HTMLElement;
async function ready() {
  await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
}

describe("Amex page — the card selector (W4)", () => {
  it("lists a debt-linked card with its full name and last four", async () => {
    render(tree());
    await ready();
    const gold = tile("ext-gold");
    expect(gold.textContent).toContain(BRAND_LABEL.blue);
    expect(gold.textContent).toContain("••2002");
    expect(gold.textContent).toContain("On the payoff plan");
    expect(screen.getByTestId("amex-tile-all")).toBeTruthy();
    expect(tile("ext-plat").textContent).toContain("••1005");
  });

  it("a debt-linked card selects: the ledger and the summary follow", async () => {
    render(tree());
    await ready();
    fireEvent.click(tile("ext-gold"));
    await waitFor(() => expect(screen.queryByTestId("row-amex-p1")).toBeNull());
    expect(screen.getByTestId("row-amex-g1")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("card")).toBe("ext-gold");
    expect(state.summaryParams[state.summaryParams.length - 1]!.accountId).toBe("ext-gold");
  });

  it("?card= and the older ?accountId= both open a card; no param is All cards", async () => {
    window.history.replaceState(null, "", "/amex?accountId=ext-gold");
    render(tree());
    await waitFor(() => expect(screen.getByTestId("row-amex-g1")).toBeTruthy());
    expect(screen.queryByTestId("row-amex-p1")).toBeNull();
    expect(state.summaryParams[0]!.accountId).toBe("ext-gold");
    cleanup();
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    state.summaryParams = [];
    render(tree());
    await ready();
    expect(screen.queryByTestId("row-amex-g1")).toBeNull();
    expect(state.summaryParams[0]!.accountId).toBe("ext-plat");
    cleanup();
    window.history.replaceState(null, "", "/amex");
    state.summaryParams = [];
    render(tree());
    await ready();
    expect(state.summaryParams[0]!.accountId).toBe("all");
  });
});

describe("Amex page — summary first (W4)", () => {
  it("owed, purchases, payments and credits are separate figures", async () => {
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-fig-owed").textContent).toContain("$842.10");
    expect(screen.getByTestId("amex-fig-owed").textContent).toContain("Statement $800.00");
    expect(screen.getByTestId("amex-fig-purchases").textContent).toContain("$425.00");
    expect(screen.getByTestId("amex-fig-purchases").textContent).toContain("7 rows");
    expect(screen.getByTestId("amex-fig-payments").textContent).toContain("$200.00");
    expect(screen.getByTestId("amex-fig-credits").textContent).toContain("$15.00");
    expect(screen.getByTestId("amex-fig-credits").textContent).toContain("other credits $10.00");
  });

  it("an unknown owed amount is a dash, never $0", async () => {
    state.summary = summaryFixture({ owed: { current: null, statement: null, asOf: null, source: "missing" } });
    render(tree());
    await ready();
    const owed = screen.getByTestId("amex-fig-owed");
    expect(owed.textContent).toContain("—");
    expect(owed.textContent).not.toContain("$0");
    expect(owed.textContent).toContain("Not known yet");
  });

  it("plan line by kind: Saturday payoff → Forecast, debt → Debt, none → no line", async () => {
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-plan-line").textContent).toContain("Saturday payoff $600.00");
    expect(within(screen.getByTestId("amex-plan-line")).getByRole("link").getAttribute("href")).toBe("/forecast");
    cleanup();
    state.summary = summaryFixture({ planLink: { kind: "debt", payoff: null, payoffDate: null, basis: null, debtId: "d", name: "Gold", minimum: "35.00", avalancheRank: 1, status: "active" } });
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-plan-line").textContent).toContain("On the payoff plan: minimum $35.00");
    expect(within(screen.getByTestId("amex-plan-line")).getByRole("link").getAttribute("href")).toBe("/debts");
    cleanup();
    state.summary = summaryFixture({ planLink: { kind: "none", payoff: null, payoffDate: null, basis: null, debtId: null, name: null, minimum: null, avalancheRank: null, status: null } });
    render(tree());
    await ready();
    expect(screen.queryByTestId("amex-plan-line")).toBeNull();
    // The household line is there in every case.
    expect(screen.getByTestId("amex-household-line")).toBeTruthy();
  });

  it("household contribution: 'Adds $X to this week's household plan', linking to the week", async () => {
    render(tree());
    await ready();
    const line = screen.getByTestId("amex-household-line");
    expect(line.textContent).toContain("Adds $560.00 to this week's household plan");
    expect(line.textContent).not.toMatch(/card'?s? (budget|allowance)/i);
    expect(within(screen.getByTestId("amex-household-line")).getByRole("link").getAttribute("href")).toBe("/spending/week");
  });

  it("a figure opens its rows: Payments filters the activity to payments; again clears it", async () => {
    render(tree());
    await ready();
    expect(screen.getByTestId("row-amex-pay1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("amex-fig-payments"));
    await waitFor(() => expect(screen.queryByTestId("row-amex-p1")).toBeNull());
    expect(screen.getByTestId("row-amex-pay1")).toBeTruthy();
    expect(screen.queryByTestId("row-amex-ref1")).toBeNull();
    fireEvent.click(screen.getByTestId("amex-fig-credits"));
    await waitFor(() => expect(screen.getByTestId("row-amex-ref1")).toBeTruthy());
    expect(screen.queryByTestId("row-amex-pay1")).toBeNull();
    fireEvent.click(screen.getByTestId("amex-fig-purchases"));
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    expect(screen.queryByTestId("row-amex-ref1")).toBeNull();
    fireEvent.click(screen.getByTestId("amex-fig-purchases"));
    await waitFor(() => expect(screen.getByTestId("row-amex-pay1")).toBeTruthy());
  });

  it("the summary sits above the activity; the summary asks for this week", async () => {
    render(tree());
    await ready();
    const page = screen.getByTestId("amex-page");
    const order = ["amex-summary", "amex-needs-attention", "amex-ledger"].map((id) => screen.getByTestId(id));
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(page.contains(order[0]!)).toBe(true);
    const p = state.summaryParams[0]!;
    expect(String(p.from) <= todayIso && todayIso <= String(p.to)).toBe(true);
  });
});

describe("Amex page — needs attention (W4)", () => {
  it("lists each group's count and amount; a row jumps to its place in the activity with ?tx=", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    render(tree());
    await ready();
    const group = screen.getByTestId("amex-attn-Unplanned");
    expect(group.textContent).toContain("1 · $40.00");
    expect(screen.queryByTestId("amex-attn-Not filed yet")).toBeNull();
    const before = window.history.length;
    fireEvent.click(screen.getByTestId("amex-attn-row-p1"));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tx")).toBe("p1"));
    expect(new URLSearchParams(window.location.search).get("mode")).toBe("month");
    expect(window.history.length).toBe(before + 1); // its own entry: Back returns
    await waitFor(() => expect(document.querySelector('[data-focused="true"]')?.getAttribute("data-testid")).toMatch(/^row-amex(-mobile)?-p1$/));
  });

  it("says so when nothing needs attention", async () => {
    state.summary = summaryFixture({
      needsAttention: {
        unplanned: { amount: "0.00", count: 0, truncated: false, rows: [] },
        unfiled: { amount: "0.00", count: 0, truncated: false, rows: [] },
        uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
        truncated: false,
      },
    });
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-attn-none")).toBeTruthy();
  });
});

describe("Amex page — the activity and the chart (W4)", () => {
  it("bucket marks keep accessible names (not WK/MO/UN/RE alone)", async () => {
    render(tree());
    await ready();
    const row = screen.getByTestId("row-amex-p1");
    for (const name of ["Weekly bucket", "Monthly bucket", "Unplanned bucket", "Reimbursable"]) {
      expect(within(row).getByRole("button", { name })).toBeTruthy();
    }
  });

  it("the chart is 'Balance history · last 12 months', never 'forward'", async () => {
    render(tree());
    await ready();
    expect(screen.queryByText(/forward/i)).toBeNull();
  });
});
