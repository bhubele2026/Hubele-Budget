import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * ⭐ (P1) THE TO-REVIEW LINE NARROWS THE ACTIVITY — it replaced the "Needs
 * attention" panel and its second copy of the rows. A group's button shows that
 * group's rows (the server's own ids, up to 50) in the activity, whatever the
 * week, Hide reviewed or the search say; the note says what is shown, what sits
 * in another month and what the cap left out; the rows chosen stay on screen as
 * they are filed; a figure and a group never both narrow it. Synthetic rows.
 *
 * The clock is Wednesday 2026-10-14 (local); the page opens on Month.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

vi.mock("recharts", () => import("@/test-recharts-stub"));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  useLocation: () => ["/amex", () => undefined] as const,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/plaid-link-button", () => ({ PlaidLinkButton: () => null }));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/category-picker", () => ({ CategoryPicker: () => null, defaultRememberPattern: (s: string) => s }));
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));
vi.mock("@/components/amex-over-link", () => ({ AmexOverLink: () => null }));

type Row = { id: string; date: string };
const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  groups: {} as Record<string, { count: number; amount: string; truncated: boolean; rows: Row[] }>,
}));

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 0));
afterAll(() => {
  vi.useRealTimers();
});

const txn = (id: string, occurredOn: string, o: Record<string, unknown> = {}) => ({
  id,
  occurredOn,
  description: id.toUpperCase(),
  amount: "-10.00",
  source: "plaid",
  categoryId: null,
  weeklyAllowance: false,
  monthlyAllowance: false,
  unplannedAllowance: false,
  reimbursable: false,
  reimbursed: false,
  weeklyBucket: null,
  isTransfer: false,
  isTransferUserOverridden: false,
  isExternalCardPayment: false,
  matchedRuleId: null,
  notes: null,
  owedBy: null,
  plaidAccountId: "ext-plat",
  reviewed: false,
  pending: false,
  member: null,
  ...o,
});
const empty = { count: 0, amount: "0.00", truncated: false, rows: [] as Row[] };
const group = (key: string) => {
  const g = state.groups[key] ?? empty;
  return {
    amount: g.amount,
    count: g.count,
    truncated: g.truncated,
    rows: g.rows.map((r) => ({ ...r, displayName: r.id, amount: "10.00", pending: false, category: null, flags: [], card: { accountId: "ext-plat", name: "Platinum", mask: "1005" } })),
  };
};

vi.mock("@workspace/api-client-react/features", () => ({
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
  useSetAmexCardPayoffMode: () => ({ mutate: () => undefined, isPending: false }),
  useGetAmexSummary: (p: { accountId: string; from: string; to: string }) => ({
    data: {
      scope: { kind: p.accountId === "all" ? "all" : "card", accountId: p.accountId === "all" ? null : p.accountId, name: null, mask: null, institution: null, cards: [] },
      period: { from: p.from, to: p.to, timezone: "America/Chicago" },
      owed: { current: "100.00", statement: null, asOf: null, source: "plaid" },
      purchases: { amount: "40.00", count: 4, reimbursable: { amount: "0.00", count: 0 } },
      refunds: { amount: "0.00", count: 0 }, payments: { amount: "0.00", count: 0 }, otherCredits: { amount: "0.00", count: 0 },
      otherCharges: { amount: "0.00", count: 0 }, notMine: { amount: "0.00", count: 0 },
      householdContribution: { weeklyPlan: "0.00", weeklyKnown: "0.00", weeklyUnresolved: "0.00", monthlyPlan: "0.00", monthlyKnown: "0.00", monthlyUnresolved: "0.00", unfiled: "0.00", link: "/spending/week" },
      planLink: { kind: "none", payoff: null, payoffDate: null, basis: null, debtId: null, name: null, minimum: null, avalancheRank: null, status: null },
      needsAttention: { unplanned: group("unplanned"), unfiled: group("unfiled"), uncategorized: group("uncategorized"), truncated: false },
      limitations: [],
    },
    isError: false,
    isFetching: false,
  }),
}));

vi.mock("@workspace/api-client-react", () => {
  const mutation = () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false });
  return {
    TransactionWeeklyBucket: { groceries: "groceries", dining: "dining", alcohol: "alcohol", entertainment: "entertainment", misc: "misc" },
    useGetSettings: () => ({ data: undefined }),
    useGetAmexWeeklyPayoff: () => ({ data: { cards: [], debtLinkedCards: [] }, isLoading: false }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    useListTransactions: (params: { limit?: number; from?: string } = {}) =>
      (params.limit ?? 0) >= 5000
        ? { data: undefined, isLoading: true }
        : {
            data: state.rows.filter((r) => String(r.occurredOn).slice(0, 7) === String(params.from).slice(0, 7)),
            isLoading: false,
            isSuccess: true,
            isPlaceholderData: false,
            isFetching: false,
          },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: mutation,
    useBulkUpdateTransactions: () => ({ mutateAsync: async () => ({ results: [] }), mutate: () => undefined, isPending: false }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: mutation,
    useDeleteMappingRule: mutation,
    useUpdateMappingRule: mutation,
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({ data: [] }),
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

let qc: QueryClient;
const tree = () => (
  <QueryClientProvider client={qc}>
    <AmexPage />
  </QueryClientProvider>
);
function show(search = "?mode=month&month=2026-10-01") {
  window.history.replaceState(null, "", `/amex${search}`);
  return render(tree());
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  window.localStorage.clear();
  state.rows = [
    txn("o1", "2026-10-02"),
    txn("o2", "2026-10-05", { reviewed: true }),
    txn("o3", "2026-10-09"),
    txn("o4", "2026-10-12"),
    txn("s1", "2026-09-20"),
  ];
  state.groups = {
    unfiled: { count: 2, amount: "20.00", truncated: false, rows: [{ id: "o2", date: "2026-10-05" }, { id: "o3", date: "2026-10-09" }] },
    unplanned: { count: 1, amount: "10.00", truncated: false, rows: [{ id: "o1", date: "2026-10-02" }] },
  };
});
afterEach(() => cleanup());

const ready = () => waitFor(() => expect(screen.getByTestId("row-amex-o1")).toBeTruthy());
const listed = () =>
  Array.from(document.querySelectorAll('[data-testid^="row-amex-"]')).map((e) => e.getAttribute("data-testid")!.slice("row-amex-".length)).sort();

describe("(P1) a To-review group narrows the activity", () => {
  it("to the server's rows for it — even a reviewed row while Hide reviewed is on — and says so, with Show all", async () => {
    window.localStorage.setItem("amex.hideReviewed", "1");
    show();
    await ready();
    expect(listed()).toEqual(["o1", "o3", "o4"]);
    fireEvent.click(screen.getByTestId("amex-attn-unfiled"));
    expect(listed()).toEqual(["o2", "o3"]);
    expect(screen.getByTestId("amex-attn-unfiled").getAttribute("aria-pressed")).toBe("true");
    const note = within(screen.getByTestId("ledger-pane")).getByTestId("amex-attn-note");
    expect(note.textContent).toBe("Showing 2 not filed yet. Show all");
    fireEvent.click(within(note).getByTestId("amex-attn-show-all"));
    expect(listed()).toEqual(["o1", "o3", "o4"]);
    expect(screen.getByTestId("amex-attn-unfiled").getAttribute("aria-pressed")).toBe("false");
  });

  it("moves the keyboard to the Activity heading", async () => {
    show();
    await ready();
    fireEvent.click(screen.getByTestId("amex-attn-unplanned"));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Activity"));
    expect(document.activeElement?.tagName).toBe("H2");
  });

  it("keeps the rows it was given on screen as they are filed (a snapshot), and the counts move on", async () => {
    const view = show();
    await ready();
    fireEvent.click(screen.getByTestId("amex-attn-unfiled"));
    expect(listed()).toEqual(["o2", "o3"]);
    // o3 was filed: the server's group no longer lists it.
    state.groups.unfiled = { count: 1, amount: "10.00", truncated: false, rows: [{ id: "o2", date: "2026-10-05" }] };
    state.rows = state.rows.map((r) => (r.id === "o3" ? { ...r, weeklyAllowance: true, reviewed: true } : r));
    view.rerender(tree());
    expect(listed()).toEqual(["o2", "o3"]);
    expect(screen.getByTestId("amex-attn-unfiled").textContent).toBe("1 not filed yet · $10.00");
  });

  it("a figure and a group never both narrow it", async () => {
    show();
    await ready();
    fireEvent.click(screen.getByTestId("amex-attn-unplanned"));
    fireEvent.click(screen.getByTestId("amex-fig-purchases"));
    expect(screen.getByTestId("amex-attn-unplanned").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("amex-attn-note")).toBeNull();
    expect(screen.getByTestId("amex-figure-note")).toBeTruthy();
    fireEvent.click(screen.getByTestId("amex-attn-unplanned"));
    expect(screen.getByTestId("amex-fig-purchases").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("amex-figure-note")).toBeNull();
    expect(listed()).toEqual(["o1"]);
  });

  it("a row in another month is counted in the note, with a way to open that month", async () => {
    state.groups.uncategorized = { count: 2, amount: "20.00", truncated: false, rows: [{ id: "o4", date: "2026-10-12" }, { id: "s1", date: "2026-09-20" }] };
    show("?mode=year&month=2026-10-01");
    await ready();
    fireEvent.click(screen.getByTestId("amex-attn-uncategorized"));
    expect(listed()).toEqual(["o4"]);
    const note = screen.getByTestId("amex-attn-note");
    expect(note.textContent).toBe("Showing 1 with no category; 1 more is in September. Open September Show all");
    fireEvent.click(within(note).getByTestId("amex-attn-open-month"));
    await waitFor(() => expect(listed()).toEqual(["s1"]));
    expect(new URLSearchParams(window.location.search).get("month")).toBe("2026-09-01");
    expect(new URLSearchParams(window.location.search).get("mode")).toBe("month");
  });

  it("a capped group says how many it shows", async () => {
    state.groups.unfiled = { count: 63, amount: "630.00", truncated: true, rows: [{ id: "o2", date: "2026-10-05" }, { id: "o3", date: "2026-10-09" }] };
    show();
    await ready();
    fireEvent.click(screen.getByTestId("amex-attn-unfiled"));
    expect(screen.getByTestId("amex-attn-note").textContent).toBe("Showing the largest 2 of 63 not filed yet. Show all");
  });
});
