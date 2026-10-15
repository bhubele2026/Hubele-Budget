import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within, act } from "@testing-library/react";
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
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string }) => <a href={href} data-testid={rest["data-testid"]}>{children}</a>,
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
    // (Q6b) "On the payoff plan" only for a card whose paidAs is debt_plan; this fixture has none.
    expect(gold.textContent).not.toContain("On the payoff plan");
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

describe("Amex page — a card tab selects the card (W7)", () => {
  it("a section tab (pushState to ?card=<external id>) re-points the head, the band and the summary query; All cards undoes it", async () => {
    window.history.replaceState(null, "", "/amex");
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-head-all-cards")).toBeTruthy();
    state.summaryParams.length = 0;
    // wouter is mocked here, so it does not patch history: fire the event it would.
    const push = (url: string) => act(() => { window.history.pushState(null, "", url); window.dispatchEvent(new Event("pushState")); });
    push("/amex?card=ext-plat");
    await waitFor(() => expect(screen.getByTestId("account-head-identity").textContent).toContain("••1005"));
    expect(screen.getByTestId("amex-tile-all").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector('[data-account-id="ext-plat"]')!.className).toContain("ring-2");
    expect(state.summaryParams.some((p) => p.accountId === "ext-plat")).toBe(true);
    push("/amex");
    await waitFor(() => expect(screen.getByTestId("amex-head-all-cards")).toBeTruthy());
    expect(screen.getByTestId("amex-tile-all").getAttribute("aria-pressed")).toBe("true");
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


describe("Amex page — the top summary and the journey fixes (Q6b)", () => {
  it("the page opens at the top: nothing scrolls when it loads or a card opens", async () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      render(tree());
      await ready();
      fireEvent.click(within(tile("ext-plat")).getAllByRole("button")[0]!);
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
      expect(row.style.scrollMarginTop).toContain("--page-sticky-top");
    } finally {
      spy.mockRestore();
    }
  });

  it("the summary names the card and the period once; owed says when; household links to the matching spending page", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    state.summary = summaryFixture({ scope: { ...CARD_SCOPE, mask: "1005" }, owed: { current: "842.10", statement: null, asOf: "2026-10-14T15:00:00Z", source: "plaid" } });
    render(tree());
    await ready();
    const sum = screen.getByTestId("amex-summary");
    expect(sum.textContent).toContain("Platinum ••1005");
    expect(screen.getByRole("heading", { name: "Platinum ••1005" })).toBeTruthy();
    expect(screen.getByTestId("amex-fig-owed").textContent).toContain("as of Oct 14");
    const link = screen.getByTestId("amex-household-link");
    expect(link.textContent).toContain("Why are we over?");
    expect(link.getAttribute("href")).toBe("/spending/week");
    expect(screen.getByTestId("amex-review-count").textContent).toBe("1 to review");
  });

  it("Month sends 'Why are we over?' to the month", async () => {
    window.history.replaceState(null, "", "/amex?mode=month");
    render(tree());
    await ready();
    // (Q6b) The month the Summary shows, not the current one.
    expect(screen.getByTestId("amex-household-link").getAttribute("href")).toMatch(/^\/spending\/month\?start=\d{4}-\d{2}-01$/);
  });

  it("the summary sits above the card selector, which shows name and owed only", async () => {
    render(tree());
    await ready();
    const sum = screen.getByTestId("amex-summary");
    const all = screen.getByTestId("amex-tile-all");
    expect(sum.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tile("ext-plat").textContent).not.toMatch(/Purchases|cleared/);
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
    expect(screen.getByTestId("chip-pending-mobile-pend1").textContent).toBe("Pending");
    expect(screen.queryByTestId("chip-pending-p1")).toBeNull();
  });

  it("(Q6b) a single card whose summary failed is still titled by that card", async () => {
    window.history.replaceState(null, "", "/amex?card=ext-plat");
    state.summaryError = true;
    render(tree());
    await ready();
    expect(screen.getByTestId("amex-summary-error")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Platinum ••1005$/ })).toBeTruthy();
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
