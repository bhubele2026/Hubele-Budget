import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (W4 → P1) The Amex page as a review destination: ONE Summary titled by its
 * period, with each card's line on All cards (debt-linked ones too, `name
 * ••last4`) and how one card is paid; the To-review buttons that narrow the
 * activity; the household link that says what is true (over / view / set a
 * plan); the bucket marks named; and the chart's title. The server's figures
 * are fixtures here; nothing is computed.
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
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string; "data-state"?: string }) => (
    <a href={href} data-testid={rest["data-testid"]} data-state={rest["data-state"]}>{children}</a>
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
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => <span>add</span> }));

const state = vi.hoisted(() => ({
  wideTxns: undefined as Array<Record<string, unknown>> | undefined, // the 12-month read; undefined = still loading
  monthTxns: undefined as Array<Record<string, unknown>> | undefined,
  items: undefined as unknown[] | undefined,
  payoff: undefined as unknown,
  /** (WP7c) Every list read's params, in order. */
  listParams: [] as Array<Record<string, unknown>>,
  summary: undefined as unknown,
  summaryParams: [] as Array<Record<string, unknown>>,
  summaryError: false,
  refetch: vi.fn(),
  /** (P1) The plan state the household link reads: the spine (this week), a month's breakdown, the owner. */
  spine: { data: undefined, state: "cold" } as { data: unknown; state: string },
  owner: true as boolean | "unknown",
  breakdown: undefined as Record<string, unknown> | undefined,
  breakdownError: false,
  breakdownParams: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => state.spine }));
vi.mock("@/hooks/useOwner", () => ({ useOwner: () => state.owner }));

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
    // (Q4) The server echoes the card and the days it read; the page shows an answer only for what it asked.
    const s = state.summary as { scope: Record<string, unknown>; period: Record<string, unknown> } | undefined;
    const data = s && {
      ...s,
      scope: { ...s.scope, accountId: params.accountId === "all" ? null : params.accountId },
      period: { ...s.period, from: params.from, to: params.to },
    };
    return { data: state.summaryError ? undefined : data, isError: state.summaryError, isLoading: false, refetch: state.refetch };
  },
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
  // (P1) Mounted only for a month's link: the Spending page's own read.
  useGetPeriodBreakdown: (params: Record<string, unknown>) => {
    state.breakdownParams.push(params);
    const data = state.breakdown && { ...state.breakdown, start: params.start, period: params.period };
    return { data: state.breakdownError ? undefined : data, isError: state.breakdownError };
  },
  getGetPeriodBreakdownQueryKey: (p: unknown) => ["/api/money/period-breakdown", p],
  useSetAmexCardPayoffMode: () => ({ mutate: vi.fn(), isPending: false }),
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
      if ((params.limit ?? 0) >= 5000) return { data: state.wideTxns, isLoading: state.wideTxns === undefined, isSuccess: state.wideTxns !== undefined, isPlaceholderData: false, isFetching: false };
      return { data: state.monthTxns, isLoading: state.monthTxns === undefined, isSuccess: state.monthTxns !== undefined, isPlaceholderData: false, isFetching: false };
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

const CARD_SCOPE = { kind: "card", accountId: "ext-plat", name: "Platinum", mask: "1001", institution: "American Express", cards: [] };
const total = (amount: string, count: number) => ({ amount, count });
const scopeCard = (accountId: string, name: string, mask: string, owed: string | null, o: Record<string, unknown> = {}) => ({
  accountId, name, mask, institution: "American Express", brand: "silver", cadence: "weekly",
  debtLinked: false, debtId: null, owed, purchases: { amount: "0.00", count: 0 },
  paidAs: { effectiveMode: "in_full_weekly", source: "default_no_debt" },
  payoffMode: { mode: "in_full", source: "default", reason: "no_debt" },
  payDown: { available: false, reason: "no_debt" },
  defaultMode: { mode: "in_full", reason: "no_debt" },
  ...o,
});
const ALL_CARDS = [
  scopeCard("ext-plat", "Platinum", "1005", "642.10", { purchases: { amount: "400.00", count: 6 } }),
  scopeCard("ext-gold", "Gold Card", "2002", "200.00", {
    debtLinked: true, debtId: "d-gold", purchases: { amount: "25.00", count: 1 },
    paidAs: { effectiveMode: "debt_plan", source: "default_debt_active" },
    payoffMode: { mode: "debt_plan", source: "default", reason: "debt_active" },
    payDown: { available: true, reason: null },
  }),
];
/** Week over / set / not set, as the spine's position words it (`knownWithinPlan`). */
const position = (remainingWeekKnown: string | null, withinPlan: string | null = null) => ({
  data: { position: { remainingWeekKnown, withinPlan, provisional: false, knownWeek: "100.00", unresolvedWeek: "0.00" } },
  state: "loaded",
});
function summaryFixture(over: Record<string, unknown> = {}) {
  return {
    scope: { kind: "all", accountId: null, name: null, mask: null, institution: null, cards: ALL_CARDS },
    period: { from: todayIso, to: todayIso, timezone: "America/Chicago" },
    owed: { current: "842.10", statement: "800.00", asOf: null, source: "plaid" },
    purchases: { amount: "425.00", count: 7, reimbursable: total("30.00", 1) },
    refunds: total("15.00", 1),
    payments: total("200.00", 1),
    otherCredits: total("10.00", 1),
    otherCharges: total("5.00", 1),
    notMine: total("0.00", 0),
    // (hh-split) The server's own split of the same figure: $40.00 of the $560.00 is unconfirmed.
    householdContribution: { weeklyPlan: "560.00", weeklyKnown: "520.00", weeklyUnresolved: "40.00", monthlyPlan: "45.00", monthlyKnown: "45.00", monthlyUnresolved: "0.00", unfiled: "0.00", link: "/spending/week" },
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
  state.summaryError = false;
  state.refetch.mockReset();
  state.spine = { data: undefined, state: "cold" };
  state.owner = true;
  state.breakdown = undefined;
  state.breakdownError = false;
  state.breakdownParams = [];
});

/** A section tab: wouter is mocked here, so fire the event its history patch would. */
const pushTab = (url: string) =>
  act(() => {
    window.history.pushState(null, "", url);
    window.dispatchEvent(new Event("pushState"));
  });
afterEach(() => cleanup());

async function ready() {
  await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
}

describe("Amex page — the card list in the Summary (P1)", () => {
  it("All cards lists every card (a debt-linked one too) by name ••last4, owed, purchases and pay word", async () => {
    render(tree());
    await ready();
    const list = screen.getByTestId("amex-card-balances");
    expect(screen.getByTestId("amex-summary").contains(list)).toBe(true);
    const gold = screen.getByTestId("amex-card-balance-ext-gold");
    expect(gold.textContent).toContain("Gold Card ••2002");
    expect(screen.getByTestId("amex-card-owed-ext-gold").textContent).toBe("$200.00");
    expect(screen.getByTestId("amex-card-purchases-ext-gold").textContent).toContain("$25.00");
    expect(screen.getByTestId("amex-card-payword-ext-gold").textContent).toBe("Paying down");
    expect(screen.getByTestId("amex-card-balance-ext-plat").textContent).toContain("Platinum ••1005");
    // No band, no "Balance by card" panel, no per-card pay blocks: each fact once.
    expect(screen.queryByTestId("amex-tile-all")).toBeNull();
    expect(screen.queryByText("Balance by card")).toBeNull();
    expect(screen.queryByTestId("amex-paymodes")).toBeNull();
  });

  it("a card's line selects it: the ledger and the summary follow, in one history entry", async () => {
    render(tree());
    await ready();
    fireEvent.click(screen.getByTestId("amex-card-balance-ext-gold"));
    await waitFor(() => expect(screen.queryByTestId("row-amex-p1")).toBeNull());
    expect(screen.getByTestId("row-amex-g1")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("card")).toBe("ext-gold");
    expect(state.summaryParams[state.summaryParams.length - 1]!.accountId).toBe("ext-gold");
  });

  it("?card= and the older ?accountId= both open a card; no param is All cards; the summary asks for 50 rows a group", async () => {
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
    expect(state.summaryParams[0]!.rowsPerGroup).toBe(50);
  });
});

describe("Amex page — one summary (W4 → P1)", () => {
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

  it("plan line by kind (a card tab): Saturday payoff → Forecast, debt → Debt, none → no line", async () => {
    state.summary = summaryFixture({ scope: CARD_SCOPE });
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-plan-line").textContent).toContain("Saturday payoff $600.00");
    expect(within(screen.getByTestId("amex-plan-line")).getByRole("link").getAttribute("href")).toBe("/forecast");
    cleanup();
    state.summary = summaryFixture({ scope: CARD_SCOPE, planLink: { kind: "debt", payoff: null, payoffDate: null, basis: null, debtId: "d", name: "Gold", minimum: "35.00", avalancheRank: 1, status: "active" } });
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-plan-line").textContent).toContain("On the payoff plan: minimum $35.00");
    expect(within(screen.getByTestId("amex-plan-line")).getByRole("link").getAttribute("href")).toBe("/debts");
    cleanup();
    state.summary = summaryFixture({ scope: CARD_SCOPE, planLink: { kind: "none", payoff: null, payoffDate: null, basis: null, debtId: null, name: null, minimum: null, avalancheRank: null, status: null } });
    render(tree());
    await ready();
    expect(screen.queryByTestId("amex-plan-line")).toBeNull();
    // The household line is there in every case.
    expect(screen.getByTestId("amex-household-line")).toBeTruthy();
  });

  it("All cards quotes no single plan line (it would read as every card's plan)", async () => {
    render(tree());
    await ready();
    expect(screen.queryByTestId("amex-plan-line")).toBeNull();
    expect(screen.getByTestId("amex-household-line")).toBeTruthy();
  });

  it("household contribution: 'Adds $X to this week's household plan', linking to the week", async () => {
    render(tree());
    await ready();
    const line = screen.getByTestId("amex-household-line");
    // (hh-split) The unconfirmed part is the server's own figure, said exactly.
    expect(line.textContent).toContain("Adds $560.00 to this week's household plan (includes $40.00 unconfirmed)");
    expect(line.textContent).not.toContain("may include");
    expect(line.textContent).not.toMatch(/card'?s? (budget|allowance)/i);
    expect(within(screen.getByTestId("amex-household-line")).getByRole("link").getAttribute("href")).toBe("/spending/week");
  });

  it("(hh-split) nothing unconfirmed: the household line says nothing about it", async () => {
    state.summary = summaryFixture({
      householdContribution: { weeklyPlan: "560.00", weeklyKnown: "560.00", weeklyUnresolved: "0.00", monthlyPlan: "45.00", monthlyKnown: "45.00", monthlyUnresolved: "0.00", unfiled: "0.00", link: "/spending/week" },
    });
    render(tree());
    await ready();
    const line = screen.getByTestId("amex-household-line");
    expect(line.textContent).toContain("Adds $560.00 to this week's household plan · ");
    expect(line.textContent).not.toMatch(/unconfirmed/i);
  });

  it("a figure opens its rows: Payments filters the activity to payments; again clears it", async () => {
    render(tree());
    await ready();
    expect(screen.getByTestId("row-amex-pay1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("amex-fig-payments"));
    await waitFor(() => expect(screen.queryByTestId("row-amex-p1")).toBeNull());
    expect(screen.getByTestId("row-amex-pay1")).toBeTruthy();
    expect(screen.queryByTestId("row-amex-ref1")).toBeNull();
    // (P1) The filter note sits in the ledger's pane, with Show all.
    expect(within(screen.getByTestId("ledger-pane")).getByTestId("amex-figure-note").textContent).toContain("Showing payments.");
    fireEvent.click(screen.getByTestId("amex-fig-credits"));
    await waitFor(() => expect(screen.getByTestId("row-amex-ref1")).toBeTruthy());
    expect(screen.queryByTestId("row-amex-pay1")).toBeNull();
    fireEvent.click(screen.getByTestId("amex-fig-purchases"));
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    expect(screen.queryByTestId("row-amex-ref1")).toBeNull();
    fireEvent.click(screen.getByTestId("amex-fig-purchases"));
    await waitFor(() => expect(screen.getByTestId("row-amex-pay1")).toBeTruthy());
    expect(screen.queryByTestId("amex-figure-note")).toBeNull();
  });

  it("the order: Summary, then Activity; the summary asks for this week and is titled by it", async () => {
    render(tree());
    await ready();
    const sum = screen.getByTestId("amex-summary");
    const ledger = screen.getByTestId("amex-ledger");
    expect(sum.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("amex-needs-attention")).toBeNull();
    expect(within(sum).getByRole("heading", { level: 2 }).textContent).toMatch(/^This week · /);
    const p = state.summaryParams[0]!;
    expect(String(p.from) <= todayIso && todayIso <= String(p.to)).toBe(true);
  });
});

describe("Amex page — a card tab selects the card (W7)", () => {
  it("a section tab (pushState to ?card=<external id>) re-points the head and the summary query; All cards undoes it", async () => {
    window.history.replaceState(null, "", "/amex");
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-head-all-cards")).toBeTruthy();
    state.summaryParams.length = 0;
    pushTab("/amex?card=ext-plat");
    await waitFor(() => expect(screen.getByTestId("account-head-identity").textContent).toContain("••1005"));
    expect(state.summaryParams.some((p) => p.accountId === "ext-plat")).toBe(true);
    pushTab("/amex");
    await waitFor(() => expect(screen.getByTestId("amex-head-all-cards")).toBeTruthy());
  });
});

describe("Amex page — the To-review line (P1)", () => {
  it("lists each group's count and amount, and nothing when nothing is to review", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-review-count").textContent).toBe("To review:1 unplanned · $40.00");
    expect(screen.queryByTestId("amex-attn-unfiled")).toBeNull();
    cleanup();
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
    expect(screen.getByTestId("amex-attn-none").textContent).toBe("Nothing to review in this period.");
  });
});

describe("(P1) the household link says what is true", () => {
  it("this week over (the spine's known figure): 'Why are we over? →' to the week", async () => {
    state.spine = position("-20.00", "over");
    render(tree());
    await ready();
    const link = screen.getByTestId("amex-household-link");
    expect(link.textContent).toBe("Why are we over? →");
    expect(link.getAttribute("href")).toBe("/spending/week");
    expect(link.getAttribute("data-state")).toBe("over");
  });

  it("this week on plan (or tight): 'View this week's spending →'", async () => {
    state.spine = position("35.00", "yes");
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-household-link").textContent).toBe("View this week's spending →");
    cleanup();
    state.spine = position("5.00", "over"); // the cautious total is over, the known figure is not: tight
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-household-link").textContent).toBe("View this week's spending →");
  });

  it("no weekly plan: the owner is asked to set one, anyone else to review; never 'over'", async () => {
    state.spine = position(null);
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-household-link").textContent).toBe("Set a weekly plan →");
    expect(screen.getByTestId("amex-household-link").getAttribute("href")).toBe("/spending/week");
    cleanup();
    state.owner = false;
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-household-link").textContent).toBe("Review this week →");
  });

  it("the spine still loading, or failed: a plain view link, never 'Why are we over?'", async () => {
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-household-link").textContent).toBe("View this week's spending →");
    cleanup();
    state.spine = { data: undefined, state: "failed" };
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-household-link").textContent).toBe("View this week's spending →");
  });

  it("a month reads its own breakdown (the Spending page's request): over, not set on a past month", async () => {
    window.history.replaceState(null, "", "/amex?mode=month&month=2026-09-01");
    state.breakdown = { isCurrent: false, plan: { status: "set" }, remaining: "-12.00" };
    render(tree());
    await waitFor(() => expect(screen.getByTestId("amex-household-link").textContent).toBe("Why are we over? →"));
    expect(screen.getByTestId("amex-household-link").getAttribute("href")).toBe("/spending/month?start=2026-09-01");
    expect(state.breakdownParams[0]).toEqual({ period: "month", start: "2026-09-01", rowsPerGroup: 50 });
    cleanup();
    state.breakdown = { isCurrent: false, plan: { status: "not_set" }, remaining: null };
    render(tree());
    await waitFor(() => expect(screen.getByTestId("amex-household-link").textContent).toBe("View September spending →"));
  });

  it("a year views spending by month; no plan is read", async () => {
    window.history.replaceState(null, "", "/amex?mode=year");
    render(tree());
    await waitFor(() => expect(screen.getByTestId("amex-household-link").textContent).toBe("View spending by month →"));
    expect(state.breakdownParams).toHaveLength(0);
  });

  it("Month sends the link to the month the Summary shows", async () => {
    window.history.replaceState(null, "", "/amex?mode=month");
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-household-link").getAttribute("href")).toMatch(/^\/spending\/month\?start=\d{4}-\d{2}-01$/);
  });
});

describe("Amex page — the activity and the chart (W4)", () => {
  it("bucket marks keep accessible names: in the row (Categorize), in the details (Review)", async () => {
    render(tree());
    await ready();
    const row = screen.getByTestId("row-amex-p1");
    // Review (the default): the row says its spending in words; the marks wait in its details.
    expect(within(row).queryByRole("button", { name: "Weekly bucket" })).toBeNull();
    expect(within(row).getByTestId("spending-p1").textContent).toBe("Spending: No bucket");
    fireEvent.click(within(row).getByTestId("button-row-details-p1"));
    const details = screen.getByTestId("amex-row-details-p1");
    for (const name of ["Weekly bucket", "Monthly bucket", "Unplanned bucket", "Reimbursable"]) {
      expect(within(details).getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("amex-rowmode-toggle"));
    for (const name of ["Weekly bucket", "Monthly bucket", "Unplanned bucket", "Reimbursable"]) {
      expect(within(screen.getByTestId("row-amex-p1")).getAllByRole("button", { name }).length).toBeGreaterThan(0);
    }
  });

  it("the chart is 'Balance history · last 12 months', never 'forward'", async () => {
    render(tree());
    await ready();
    expect(screen.queryByText(/forward/i)).toBeNull();
  });
});

describe("Amex page — the top summary and the journey fixes (Q6b → P1)", () => {
  it("the page opens at the top: nothing scrolls when it loads or a card opens", async () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      render(tree());
      await ready();
      fireEvent.click(screen.getByTestId("amex-card-balance-ext-plat"));
      await waitFor(() => expect(screen.queryByTestId("row-amex-g1")).toBeNull());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("?tx= scrolls once, to the row, from the top of the view; the row is marked", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat&tx=p1");
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      render(tree());
      await waitFor(() => expect(document.querySelector('[data-focused="true"]')).toBeTruthy());
      await new Promise((r) => setTimeout(r, 50));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({ block: "start" });
      // The row clears the sticky stack: pinned pane + day head + a gap.
      const row = document.querySelector('[data-focused="true"]') as HTMLElement;
      expect(row.getAttribute("data-testid")).toBe("row-amex-p1");
      expect(row.style.scrollMarginTop).toContain("--page-sticky-top");
    } finally {
      spy.mockRestore();
    }
  });

  it("the card is named once (the header chip); the Summary is the period; owed says when", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    state.summary = summaryFixture({ scope: { ...CARD_SCOPE, mask: "1005" }, owed: { current: "842.10", statement: null, asOf: "2026-10-14T15:00:00Z", source: "plaid" } });
    render(tree());
    await ready();
    const sum = screen.getByTestId("amex-summary");
    expect(screen.getByTestId("account-head-identity").textContent).toContain("Platinum");
    expect(screen.getByTestId("account-head-identity").textContent).toContain("••1005");
    expect(sum.textContent).not.toContain("Platinum");
    expect(within(sum).getByRole("heading", { level: 2 }).textContent).toMatch(/^This week · /);
    expect(screen.getByTestId("amex-fig-owed").textContent).toContain("as of Oct 14");
    expect(screen.getByTestId("amex-household-link").getAttribute("href")).toBe("/spending/week");
    // One card: its balance history is a link away (the chart sits below the activity).
    expect(screen.getByTestId("amex-owed-history-link").textContent).toBe("Balance history");
  });

  it("one card's Summary says how it is paid, with Add to Avalanche for a card not on the debt plan", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    state.summary = summaryFixture({
      scope: {
        ...CARD_SCOPE,
        mask: "1005",
        cards: [scopeCard("ext-plat", "Platinum", "1005", "1649.35", { paidAs: { effectiveMode: "in_full_weekly", source: "default_debt_inactive" }, payDown: { available: false, reason: "debt_not_active" } })],
      },
    });
    render(tree());
    await ready();
    const pay = within(screen.getByTestId("amex-summary")).getByTestId("amex-paymodes");
    expect(within(pay).getByTestId("amex-paymode-word").textContent).toBe("Paid in full weekly");
    expect(pay.textContent).not.toMatch(/paid off/i);
    expect(within(pay).getByText("add")).toBeTruthy();
  });

  it("an error says so with Retry, never $0", async () => {
    state.summaryError = true;
    render(tree());
    await ready();
    const err = screen.getByTestId("amex-summary-error");
    expect(err.textContent).toContain("The summary did not load.");
    expect(screen.queryByTestId("amex-fig-owed")).toBeNull();
    fireEvent.click(within(err).getByTestId("amex-summary-retry"));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it("a pending row says Pending", async () => {
    state.monthTxns = [...ROWS(), makeTxn({ id: "pend1", description: "PENDINGROW", source: "plaid", plaidAccountId: "ext-plat", amount: "-9.00", pending: true })];
    render(tree());
    await waitFor(() => expect(screen.getByTestId("row-amex-pend1")).toBeTruthy());
    expect(screen.getByTestId("chip-pending-pend1").textContent).toBe("Pending");
    expect(screen.queryByTestId("chip-pending-p1")).toBeNull();
  });

  it("(Q6b) a single card whose summary failed is still named by that card in the header", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    state.summaryError = true;
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-summary-error")).toBeTruthy();
    expect(screen.getByTestId("account-head-identity").textContent).toContain("••1005");
    expect(screen.getByTestId("amex-summary").textContent).not.toContain("All cards");
  });

  it("(Q6b) a ?tx= whose row never appears is dropped from the URL and its status goes away", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat&tx=nope");
    render(tree());
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    expect(screen.getByTestId("amex-row-link-status")).toBeTruthy();
    await waitFor(() => expect(window.location.search).not.toContain("tx="), { timeout: 4000 });
    await waitFor(() => expect(screen.queryByTestId("amex-row-link-status")).toBeNull());
    expect(window.location.search).toContain("card=ext-plat");
  });
});
