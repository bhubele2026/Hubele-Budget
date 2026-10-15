import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, keepPreviousData, useQuery } from "@tanstack/react-query";
import React from "react";

/**
 * ⭐ (Q4) NO STALE NUMBER UNDER A NEW SCOPE — through the REAL Amex page, with
 * `keepPreviousData` on (as the app has it) and answers the test releases by
 * hand, in any order.
 *
 *   - Switching All cards -> Platinum: the all-cards owed ($3,456.78) is never
 *     on screen under the Platinum heading; the summary says it is loading.
 *   - Rapid switches with out-of-order answers: the last card asked is the one
 *     shown, whichever answer lands last.
 *   - A month change says "Loading <Month>..." and never "No transactions match
 *     these filters" over the old month's rows.
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
// (P1) The household link reads the plan state (spine / period breakdown): not this test's subject.
vi.mock("@/components/amex-over-link", () => ({ AmexOverLink: () => null }));
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
const GOLD = "ext-gold";
const row = (id: string, occurredOn: string, amount: string) => ({
  id, occurredOn, occurredAt: null, postedOn: occurredOn, description: id.toUpperCase(), amount,
  source: "plaid:amex", plaidAccountId: PLAT, pending: false, categoryId: null,
  weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false, reimbursable: false,
  reimbursed: false, reviewed: false, weeklyBucket: null, isTransfer: false, matchedRuleId: null,
  notes: null, owedBy: null,
});
const SEPT = [row("s1", "2026-09-15", "-64.00"), row("s2", "2026-09-14", "-38.75"), { ...row("g1", "2026-09-15", "-25.00"), plaidAccountId: GOLD }];
const AUG = [row("a1", "2026-08-20", "-11.00")];

/** Every request the page makes to the summary / month rows, held until the test releases it. */
const held = vi.hoisted(() => ({
  summary: new Map<string, (v: unknown) => void>(),
  month: new Map<string, (v: unknown) => void>(),
}));

const OWED: Record<string, string> = { all: "3456.78", [PLAT]: "1000.00", [GOLD]: "250.00" };
function summaryFor(p: { accountId: string; from: string; to: string }) {
  const cards = [
    { accountId: PLAT, name: "Platinum", mask: "1002", institution: "American Express", brand: "silver", cadence: "weekly", debtLinked: false, debtId: null, owed: OWED[PLAT], purchases: { amount: "0.00", count: 0 } },
    { accountId: GOLD, name: "Gold", mask: "2003", institution: "American Express", brand: "silver", cadence: "weekly", debtLinked: false, debtId: null, owed: OWED[GOLD], purchases: { amount: "0.00", count: 0 } },
  ];
  const zero = { amount: "0.00", count: 0 };
  return {
    scope: p.accountId === "all"
      ? { kind: "all", accountId: null, name: null, mask: null, institution: null, cards }
      : { kind: "card", accountId: p.accountId, name: p.accountId === PLAT ? "Platinum" : "Gold", mask: "1002", institution: "American Express", cards: [] },
    period: { from: p.from, to: p.to, timezone: "America/Chicago" },
    owed: { current: OWED[p.accountId], statement: null, asOf: "2026-09-16T11:00:00.000Z", source: "plaid" },
    purchases: { amount: "0.00", count: 0, reimbursable: zero },
    refunds: zero, payments: zero, otherCredits: zero, otherCharges: zero, notMine: zero,
    householdContribution: { weeklyPlan: "560.00", weeklyKnown: "560.00", weeklyUnresolved: "0.00", monthlyPlan: "45.00", monthlyKnown: "45.00", monthlyUnresolved: "0.00", unfiled: "0.00", link: "/spending/week" },
    planLink: { kind: "none" },
    needsAttention: {
      unplanned: { amount: "0.00", count: 0, truncated: false, rows: [] },
      unfiled: { amount: "0.00", count: 0, truncated: false, rows: [] },
      uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
      truncated: false,
    },
    limitations: [],
  };
}

vi.mock("@workspace/api-client-react/features", () => ({
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
  useGetAmexSummary: (p: { accountId: string; from: string; to: string }, o?: { query?: { enabled?: boolean } }) =>
    useQuery({
      queryKey: ["/api/amex/summary", p],
      enabled: o?.query?.enabled !== false,
      // The app-wide default, as App.tsx sets it.
      placeholderData: keepPreviousData,
      queryFn: () =>
        new Promise((resolve) => {
          held.summary.set(`${p.accountId}|${p.from}`, () => resolve(summaryFor(p)));
        }),
    }),
}));

vi.mock("@workspace/api-client-react", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    useGetSettings: () => ({ data: undefined }),
    useGetAmexWeeklyPayoff: () => ({ data: { cards: [], debtLinkedCards: [] }, isLoading: false }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    useListTransactions: (p: { limit?: number; from?: string; to?: string }) => {
      // The 12-month read is not under test.
      const wide = (p.limit ?? 0) >= 5000;
      return useQuery({
        queryKey: ["/api/transactions", p],
        enabled: !wide,
        placeholderData: keepPreviousData,
        queryFn: () =>
          new Promise((resolve) => {
            const month = (p.from ?? "").slice(0, 7);
            held.month.set(month, () => resolve(month === "2026-08" ? AUG : SEPT));
          }),
      });
    },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [], isError: false }),
    useUpdateTransaction: () => ({ mutateAsync: async () => undefined, mutate: () => undefined, isPending: false }),
    useBulkUpdateTransactions: () => ({ mutateAsync: async () => ({ results: [] }), mutate: () => undefined, isPending: false }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: () => ({ mutate: () => undefined, isPending: false }),
    useDeleteMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    useUpdateMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: (p: unknown) => ["/api/transactions", p],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({
      data: [
        {
          id: "it-amex", itemId: "item-amex", institutionName: "American Express", institutionSlug: "amex",
          accounts: [
            { id: "row-plat", accountId: PLAT, name: "Platinum Card", mask: "1002", type: "credit", subtype: "credit card" },
            { id: "row-gold", accountId: GOLD, name: "Gold Card", mask: "2003", type: "credit", subtype: "credit card" },
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0, placeholderData: keepPreviousData } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage />
    </QueryClientProvider>,
  );
}
const release = async (map: Map<string, (v: unknown) => void>, key: string) => {
  await waitFor(() => expect(map.has(key)).toBe(true));
  await act(async () => {
    map.get(key)!(undefined);
    map.delete(key);
  });
};
const WEEK = "2026-09-13";
const owedOnScreen = () => document.body.textContent ?? "";

beforeEach(() => {
  localStorage.clear();
  held.summary.clear();
  held.month.clear();
});
afterEach(() => cleanup());

describe("(Q4) Amex: a new card never shows the old card's owed", () => {
  it("All cards -> Platinum: the all-cards $3,456.78 is gone the moment Platinum is asked", async () => {
    renderAt("?month=2026-09-01&mode=week");
    await release(held.summary, `all|${WEEK}`);
    await release(held.month, "2026-09");
    await waitFor(() => expect(owedOnScreen()).toContain("$3,456.78"));

    fireEvent.click(screen.getByTestId(`amex-card-balance-${PLAT}`));
    // Platinum's answer is still out: its heading is up, the old card's owed is not.
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("card")).toBe(PLAT));
    await waitFor(() => expect(screen.getByTestId("amex-summary-loading")).toBeTruthy());
    expect(within(screen.getByTestId("amex-summary")).queryByText("$3,456.78")).toBeNull();
    expect(screen.queryByTestId("amex-card-balances")).toBeNull();

    await release(held.summary, `${PLAT}|${WEEK}`);
    await waitFor(() => expect(within(screen.getByTestId("amex-summary")).getByText("$1,000.00")).toBeTruthy());
    expect(within(screen.getByTestId("amex-summary")).queryByText("$3,456.78")).toBeNull();
  });

  it("rapid switches, answers out of order: the last card asked is the one shown", async () => {
    renderAt("?month=2026-09-01&mode=week");
    await release(held.summary, `all|${WEEK}`);
    await release(held.month, "2026-09");
    await waitFor(() => expect(owedOnScreen()).toContain("$3,456.78"));

    fireEvent.click(screen.getByTestId(`amex-card-balance-${PLAT}`));
    await waitFor(() => expect(held.summary.has(`${PLAT}|${WEEK}`)).toBe(true));
    // A link elsewhere on the page (the section tabs) pushes the card; wouter's patch fires `pushState`.
    act(() => {
      window.history.pushState(null, "", `/amex?month=2026-09-01&mode=week&card=${GOLD}`);
      window.dispatchEvent(new Event("pushState"));
    });
    await waitFor(() => expect(held.summary.has(`${GOLD}|${WEEK}`)).toBe(true));

    // Gold (asked last) lands FIRST, Platinum's late answer after it.
    await release(held.summary, `${GOLD}|${WEEK}`);
    await waitFor(() => expect(within(screen.getByTestId("amex-summary")).getByText("$250.00")).toBeTruthy());
    await release(held.summary, `${PLAT}|${WEEK}`);
    const panel = within(screen.getByTestId("amex-summary"));
    expect(panel.getByText("$250.00")).toBeTruthy();
    expect(panel.queryByText("$1,000.00")).toBeNull();
    expect(panel.queryByText("$3,456.78")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("card")).toBe(GOLD);
  });

  it("one history entry per card chosen: Back returns to the card before", async () => {
    renderAt("?month=2026-09-01&mode=week");
    await release(held.summary, `all|${WEEK}`);
    await release(held.month, "2026-09");
    const before = window.history.length;
    fireEvent.click(screen.getByTestId(`amex-card-balance-${PLAT}`));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("card")).toBe(PLAT));
    expect(window.history.length).toBe(before + 1);
  });
});

describe("(Q4) Amex: a month change says it is loading", () => {
  it("shows 'Loading August...' - never 'No transactions match' - over the September rows", async () => {
    renderAt("?month=2026-09-01&mode=month");
    await release(held.month, "2026-09");
    await waitFor(() => expect(screen.getAllByText("S1").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId("button-prev-month"));
    await waitFor(() => expect(screen.getByTestId("amex-month-loading").textContent).toBe("Loading August\u2026"));
    expect(screen.queryByTestId("amex-empty")).toBeNull();
    expect(screen.queryAllByText("S1")).toHaveLength(0);

    await release(held.month, "2026-08");
    await waitFor(() => expect(screen.getAllByText("A1").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("amex-month-loading")).toBeNull();
  });
});
