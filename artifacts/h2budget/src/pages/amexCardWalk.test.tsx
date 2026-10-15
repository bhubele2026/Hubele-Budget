import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * ⭐ (Q3) THE AMEX PAGE WALKS PLAID CARD ROWS AS WHAT THE CARD OWES — through the
 * REAL page, with `plaid:amex` rows (the bank sign: a purchase is NEGATIVE).
 *
 *   - One card: each posted row's "bal" counts back from the card's current
 *     balance — down past each purchase (the worked example: 1,000.00 / 936.00
 *     / 897.25 / 845.15; it read 1,000 / 1,064 / 1,102.75 / 1,154.85). A
 *     pending row shows no "bal". The note says what the figures count from.
 *   - "All cards": no running balance and no combined chart; each card's own
 *     balance, labelled by card ("—" when unknown, never $0); picking one opens
 *     its history.
 * Synthetic cards, amounts and merchants.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

// Wednesday 2026-09-16, noon UTC (07:00 in Chicago).
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});

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
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));
// The chart draws only with a window: a marker stands in for the drawing.
vi.mock("@/components/account-page/balance-trend-chart", async () => {
  const R = await import("react");
  return {
    BalanceTrendChart: (p: { window?: unknown }) =>
      p.window ? R.createElement("div", { "data-testid": "card-balance-trend" }) : null,
  };
});

const PLAT = "ext-plat";
const BLUE = "ext-blue";
const row = (id: string, occurredOn: string, amount: string, more: Record<string, unknown> = {}) => ({
  id,
  occurredOn,
  occurredAt: null,
  postedOn: occurredOn,
  description: id.toUpperCase(),
  amount,
  source: "plaid:amex",
  plaidAccountId: PLAT,
  pending: false,
  categoryId: null,
  weeklyAllowance: false,
  monthlyAllowance: false,
  unplannedAllowance: false,
  reimbursable: false,
  reimbursed: false,
  reviewed: false,
  weeklyBucket: null,
  isTransfer: false,
  matchedRuleId: null,
  notes: null,
  owedBy: null,
  ...more,
});
// Platinum, this week (Sep 13–19): four purchases, newest first, and a pending hold.
const ROWS = [
  row("p-pending", "2026-09-16", "-12.00", { pending: true }),
  row("p1", "2026-09-15", "-64.00"),
  row("p2", "2026-09-14", "-38.75"),
  row("p3", "2026-09-13", "-52.10", { occurredAt: "2026-09-13T20:00:00.000Z" }),
  row("p4", "2026-09-13", "-86.40", { occurredAt: "2026-09-13T14:00:00.000Z" }),
  // Another card's purchase and a workbook row: never in Platinum's walk.
  row("b1", "2026-09-15", "-22.40", { plaidAccountId: BLUE }),
  row("w1", "2026-09-14", "40.00", { source: "amex", plaidAccountId: null }),
];

const summaryOf = (accountId: string) => {
  const base = {
    period: { from: "2026-09-13", to: "2026-09-19", timezone: "America/Chicago" },
    purchases: { amount: "0.00", count: 0, reimbursable: { amount: "0.00", count: 0 } },
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
  };
  const card = (id: string, name: string, mask: string, owed: string | null) => ({
    accountId: id, name, mask, institution: "American Express", brand: "silver", cadence: "weekly",
    debtLinked: false, debtId: null, owed, purchases: { amount: "0.00", count: 0 },
  });
  if (accountId === "all") {
    return {
      ...base,
      scope: {
        kind: "all", accountId: null, name: null, mask: null, institution: null,
        cards: [card(PLAT, "Platinum", "1002", "1000.00"), card(BLUE, "Blue Cash", "2003", null)],
      },
      owed: { current: "1000.00", statement: null, asOf: "2026-09-16T11:00:00.000Z", source: "plaid" },
    };
  }
  return {
    ...base,
    scope: { kind: "card", accountId, name: "Platinum", mask: "1002", institution: "American Express", cards: [] },
    // The card's current balance, read 06:00 in Chicago on Sep 16.
    owed: { current: "1000.00", statement: null, asOf: "2026-09-16T11:00:00.000Z", source: "plaid" },
  };
};

vi.mock("@workspace/api-client-react/features", () => ({
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
  useGetAmexSummary: (p: { accountId: string }, o?: { query?: { enabled?: boolean } }) => ({
    data: o?.query?.enabled === false ? undefined : summaryOf(p.accountId),
    isError: false,
  }),
}));

vi.mock("@workspace/api-client-react", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    useGetSettings: () => ({ data: undefined }),
    useGetAmexWeeklyPayoff: () => ({ data: { cards: [], debtLinkedCards: [] }, isLoading: false }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    useListTransactions: () => ({ data: ROWS, isLoading: false, isError: false }),
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [], isError: false }),
    useUpdateTransaction: () => ({ mutateAsync: async () => undefined, mutate: () => undefined, isPending: false }),
    useBulkUpdateTransactions: () => ({ mutateAsync: async () => ({ results: [] }), mutate: () => undefined, isPending: false }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: () => ({ mutate: () => undefined, isPending: false }),
    useDeleteMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    useUpdateMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({
      data: [
        {
          id: "it-amex",
          itemId: "item-amex",
          institutionName: "American Express",
          institutionSlug: "amex",
          accounts: [
            { id: "row-plat", accountId: PLAT, name: "Platinum Card", mask: "1002", type: "credit", subtype: "credit card" },
            { id: "row-blue", accountId: BLUE, name: "Blue Cash", mask: "2003", type: "credit", subtype: "credit card" },
          ],
        },
      ],
    }),
    useSyncPlaidTransactions: () => ({ mutateAsync: async () => undefined, mutate: () => undefined, isPending: false }),
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    getListPlaidLiabilityAccountsQueryKey: () => ["/api/plaid/liabilities"],
    getListDebtsQueryKey: () => ["/api/debts"],
    getGetDashboardQueryKey: () => ["/api/dashboard"],
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
    usePutMerchantAlias: () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false }),
    useDeleteMerchantAlias: () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false }),
    customFetch: async () => ({ amexEndingBalance: 1000, asOf: "2026-09-16T11:00:00.000Z", source: "plaid" }),
  };
});

import AmexPage from "./amex";

function renderAt(search: string) {
  window.history.replaceState(null, "", `/amex${search}`);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

const bal = (id: string) => screen.queryByTestId(`text-running-balance-${id}`)?.textContent ?? null;

describe("(Q3) one card: Plaid purchases walk DOWN going back in time", () => {
  it("counts back from the card's current balance: 1,000.00 / 936.00 / 897.25 / 845.15", async () => {
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() => expect(bal("p1")).toBe("bal $1,000.00"));
    // Worked by hand (purchases raise what is owed, so going back it falls):
    //   p1 Sep 15 −64.00  after 1,000.00
    //   p2 Sep 14 −38.75  after 1,000.00 − 64.00 = 936.00
    //   p3 Sep 13 −52.10  after   936.00 − 38.75 = 897.25   (20:00, newer)
    //   p4 Sep 13 −86.40  after   897.25 − 52.10 = 845.15   (14:00, older)
    expect(bal("p2")).toBe("bal $936.00");
    expect(bal("p3")).toBe("bal $897.25");
    expect(bal("p4")).toBe("bal $845.15");
    // The mobile layout reads the same map.
    expect(screen.getByTestId("text-running-balance-mobile-p2").textContent).toBe("bal $936.00");
  });

  it("a pending row shows no bal; other cards' and workbook rows are not in this card's list", async () => {
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() => expect(bal("p1")).toBe("bal $1,000.00"));
    expect(screen.getAllByText("P-PENDING").length).toBeGreaterThan(0);
    expect(bal("p-pending")).toBeNull();
    expect(screen.queryAllByText("B1")).toHaveLength(0);
    expect(screen.queryAllByText("W1")).toHaveLength(0);
  });

  it("the note says what the figures count back from, with its date; the card's chart draws", async () => {
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() =>
      expect(screen.getByTestId("amex-anchor-note").textContent).toBe(
        "Balance after each row, counting back from $1,000.00 (as of Sep 16).",
      ),
    );
    expect(screen.getByTestId("card-balance-trend")).toBeTruthy();
    expect(screen.queryByTestId("amex-card-balances")).toBeNull();
    expect(screen.getByText("Amount · Bal")).toBeTruthy();
  });
});

describe("(Q3) All cards: each card's balance, no combined walk or chart", () => {
  it("no bal on any row, no chart; the cards' balances, labelled, unknown as —", async () => {
    renderAt("?month=2026-09-01&mode=week");
    const panel = await screen.findByTestId("amex-card-balances");
    await waitFor(() => expect(screen.getAllByText("P1").length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId(/^text-running-balance-/)).toHaveLength(0);
    expect(screen.queryByTestId("card-balance-trend")).toBeNull();
    expect(screen.queryByTestId("amex-anchor-note")).toBeNull();
    // The column says only Amount: there is no "bal" here.
    expect(screen.getByText("Amount")).toBeTruthy();
    expect(screen.queryByText("Amount · Bal")).toBeNull();
    const plat = within(panel).getByTestId(`amex-card-balance-${PLAT}`);
    expect(plat.textContent).toContain("Platinum ••1002");
    expect(plat.textContent).toContain("$1,000.00");
    const blue = within(panel).getByTestId(`amex-card-balance-${BLUE}`);
    expect(blue.textContent).toContain("Blue Cash ••2003");
    expect(blue.textContent).toContain("—");
    expect(blue.textContent).not.toContain("$0.00");
    // Rows of every card (and the workbook) are still listed.
    expect(screen.getAllByText("B1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("W1").length).toBeGreaterThan(0);
  });

  it("picking a card opens its own walk", async () => {
    renderAt("?month=2026-09-01&mode=week");
    const panel = await screen.findByTestId("amex-card-balances");
    fireEvent.click(within(panel).getByTestId(`amex-card-balance-${PLAT}`));
    await waitFor(() => expect(bal("p2")).toBe("bal $936.00"));
    expect(new URLSearchParams(window.location.search).get("card")).toBe(PLAT);
    expect(screen.queryByTestId("amex-card-balances")).toBeNull();
  });
});
