import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (Q6a) CALM AMEX ROWS through the REAL page (synthetic `plaid:amex` rows).
 *   - No financial row is faded: reviewed / ignored read as a small chip.
 *   - The checkbox name carries the merchant.
 *   - Amounts are signed ("-$64.00" a purchase, "+$10.00" a refund); a workbook
 *     charge is flipped for display ("-$40.00").
 *   - A day total shows money out and money in apart, never a sum of absolutes.
 *   - (P1) One row per transaction, phone and desktop alike (no "-mobile-" copy).
 *   - (P1) The card-payment flag and the date moves live in the row's Details.
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
vi.mock("@/components/amex-over-link", () => ({ AmexOverLink: () => null }));
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
  row("p1", "2026-09-15", "-64.00"),
  row("p1r", "2026-09-15", "10.00", { description: "REFUND CAFE" }),
  row("p2", "2026-09-14", "-38.75", { reviewed: true }),
  row("p3", "2026-09-13", "-52.10", { isTransfer: true, description: "PAYMENT THANK YOU" }),
  row("w1", "2026-09-14", "40.00", { source: "amex", plaidAccountId: null }),
];
// (F6 ⇄ Q6 merge) Rows a test adds: the server's answer on them (`expiredHold`) is what the page reads.
const EXTRA: ReturnType<typeof row>[] = [];

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
    useListTransactions: () => ({ data: [...ROWS, ...EXTRA], isLoading: false, isError: false }),
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

beforeEach(() => {
  localStorage.clear();
  EXTRA.length = 0;
});
afterEach(() => cleanup());

describe("(Q6a) calm Amex rows", () => {
  it("fades no row: a reviewed row carries a Reviewed chip, never opacity", async () => {
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() => expect(screen.getByTestId("row-amex-p2")).toBeTruthy());
    for (const id of ["row-amex-p1", "row-amex-p2"]) {
      expect(screen.getByTestId(id).className).not.toMatch(/opacity/);
    }
    expect(screen.getByTestId("chip-state-p2").textContent).toBe("Reviewed");
    expect(screen.queryByTestId("chip-state-p1")).toBeNull();
    // (P1) One DOM row per transaction.
    expect(screen.queryByTestId("row-amex-mobile-p2")).toBeNull();
    expect(document.querySelectorAll('[data-testid="row-amex-p2"]').length).toBe(1);
  });

  it("each checkbox is named for its merchant", async () => {
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    expect(within(screen.getByTestId("row-amex-p1")).getByRole("checkbox", { name: "Select P1" })).toBeTruthy();
  });

  it("amounts are signed; a day total is money out and money in, apart", async () => {
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    expect(screen.getByTestId("amount-p1").textContent).toBe("-$64.00");
    expect(screen.getByTestId("amount-p1r").textContent).toBe("+$10.00");
    // Sep 15: one purchase of 64.00 and one refund of 10.00 (not 74.00, not 54.00).
    const total = screen.getByTestId("day-total-2026-09-15").textContent;
    expect(total).toBe("-$64.00 out · +$10.00 in");
    // Sep 13: a lone card payment of -52.10 here reads as money out.
    expect(screen.getByTestId("day-total-2026-09-13").textContent).toBe("-$52.10 out");
  });

  it("(F6 ⇄ Q6) an expired hold is listed with its own label (not \"Pending\" too) and adds nothing to its day's out / in", async () => {
    // A hotel hold the server calls expired (`expiredHold`: pending more than 7
    // days, never posted) and a young pending row beside it, on Sep 15.
    EXTRA.push(
      row("hx", "2026-09-15", "-150.00", { pending: true, expiredHold: true, description: "HARBOR HOTEL HOLD" }),
      row("py", "2026-09-15", "-7.00", { pending: true, description: "CORNER CAFE" }),
    );
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() => expect(screen.getByTestId("row-amex-hx")).toBeTruthy());
    // The out / in still leave the hold out: 64.00 + 7.00 out, 10.00 in (not 221.00 out).
    expect(screen.getByTestId("day-total-2026-09-15").textContent).toBe("-$71.00 out · +$10.00 in");
    // One label says what it is, on desktop and phone; "Pending" stays on the young row only.
    expect(within(screen.getByTestId("row-amex-hx")).getByTestId("label-expired-hold-hx").textContent).toBe("Expired hold · not counted");
    expect(screen.queryByTestId("chip-pending-hx")).toBeNull();
    expect(screen.getByTestId("chip-pending-py").textContent).toBe("Pending");
    // (P1) Its spending cell says nothing more: the label already says "not counted".
    expect(screen.queryByTestId("spending-hx")).toBeNull();
    // The row and its amount stay visible (nothing hidden, nothing deleted).
    expect(screen.getByTestId("amount-hx").textContent).toBe("-$150.00");
  });

  it("a workbook charge (stored positive) reads as money out on All cards", async () => {
    renderAt(`?card=all&month=2026-09-01&mode=week`);
    await waitFor(() => expect(screen.getByTestId("amount-w1")).toBeTruthy());
    expect(screen.getByTestId("amount-w1").textContent).toBe("-$40.00");
    expect(screen.getByTestId("day-total-2026-09-14").textContent).toBe("-$78.75 out");
  });

  it("(P1) a transfer row says Transfer; marking a card payment lives in its details", async () => {
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() => expect(screen.getByTestId("row-amex-p3")).toBeTruthy());
    expect(screen.getByTestId("badge-transfer-p3").textContent).toBe("Transfer");
    expect(screen.queryByTestId("button-mark-external-card-p3")).toBeNull();
    fireEvent.click(screen.getByTestId("button-row-details-p3"));
    expect(within(screen.getByTestId("amex-row-details-p3")).getByTestId("button-mark-external-card-p3").textContent).toBe(
      "Paid to a card outside the debt plan",
    );
  });

  it("(P1) dates move in the row's details (posted rows only); no row menu", async () => {
    EXTRA.push(row("pp", "2026-09-15", "-7.00", { pending: true, description: "CORNER CAFE" }));
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
    expect(screen.queryByTestId("button-row-menu-p1")).toBeNull();
    expect(screen.queryByTestId("button-bump-date-back-p1")).toBeNull();
    fireEvent.click(screen.getByTestId("button-row-details-p1"));
    const d = screen.getByTestId("amex-row-details-p1");
    expect(within(d).getByTestId("button-bump-date-back-p1").textContent).toBe("Move back 1 day");
    expect((within(d).getByTestId("input-inline-date-p1") as HTMLInputElement).value).toBe("2026-09-15");
    // A pending row: the bank sets its date.
    fireEvent.click(screen.getByTestId("button-row-details-pp"));
    const dp = screen.getByTestId("amex-row-details-pp");
    expect(within(dp).queryByTestId("button-bump-date-back-pp")).toBeNull();
    expect(within(dp).getByTestId("text-pending-date-pp").textContent).toBe("The bank sets the date when it posts.");
  });

  it("the hide-reviewed toggle says what it does", async () => {
    renderAt(`?card=${PLAT}&month=2026-09-01&mode=week`);
    const t = await screen.findByTestId("button-hide-reviewed");
    expect(t.textContent).toBe("Hide reviewed");
    fireEvent.click(t);
    expect(screen.getByTestId("button-hide-reviewed").textContent).toBe("Show reviewed");
    expect(screen.queryByTestId("row-amex-p2")).toBeNull();
  });
});
