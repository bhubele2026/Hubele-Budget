import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * ⭐ (P1) CALM ROWS BY DEFAULT, A CATEGORIZE SWITCH, PER-ROW DETAILS — through the
 * real page (synthetic rows).
 *   - Review (the default) says each row's spending in words; the legend is off.
 *   - "Categorize" (aria-pressed, kept per browser) shows the marks and the legend.
 *   - The switch keeps the first row in view where it was, and leaves the selection.
 *   - Details open in place; Escape or Done closes them and gives focus back.
 *   - A row with open details stays listed when Hide reviewed is on.
 *   - Choosing a bucket in the details sends the very PATCH the row's marks send.
 *   - One card's page has no Card column.
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
vi.mock("@/components/category-picker", () => ({
  CategoryPicker: () => <button type="button" role="combobox" aria-label="Category" data-testid="button-category-picker" />,
  defaultRememberPattern: (s: string) => s,
}));
vi.mock("@/components/amex-over-link", () => ({ AmexOverLink: () => null }));
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => null }));

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
  bulk: [] as Array<{ ids: string[]; patch: Record<string, unknown> }>,
}));

const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const txn = (o: Record<string, unknown>) => ({
  id: "tx",
  occurredOn: todayIso,
  description: "ROW",
  amount: "-12.00",
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

vi.mock("@workspace/api-client-react/features", () => ({
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
  useSetAmexCardPayoffMode: () => ({ mutate: () => undefined, isPending: false }),
  useGetAmexSummary: (p: { accountId: string; from: string; to: string }) => ({
    data: {
      scope: {
        kind: p.accountId === "all" ? "all" : "card",
        accountId: p.accountId === "all" ? null : p.accountId,
        name: null, mask: null, institution: null,
        cards: [{ accountId: "ext-plat", name: "Platinum", mask: "1005", institution: "American Express", brand: "silver", cadence: "weekly", debtLinked: false, debtId: null, owed: "100.00", paidAs: null, purchases: { amount: "0.00", count: 0 } }],
      },
      period: { from: p.from, to: p.to, timezone: "America/Chicago" },
      owed: { current: "100.00", statement: null, asOf: null, source: "plaid" },
      purchases: { amount: "0.00", count: 0, reimbursable: { amount: "0.00", count: 0 } },
      refunds: { amount: "0.00", count: 0 }, payments: { amount: "0.00", count: 0 }, otherCredits: { amount: "0.00", count: 0 },
      otherCharges: { amount: "0.00", count: 0 }, notMine: { amount: "0.00", count: 0 },
      householdContribution: { weeklyPlan: "0.00", weeklyKnown: "0.00", weeklyUnresolved: "0.00", monthlyPlan: "0.00", monthlyKnown: "0.00", monthlyUnresolved: "0.00", unfiled: "0.00", link: "/spending/week" },
      planLink: { kind: "none", payoff: null, payoffDate: null, basis: null, debtId: null, name: null, minimum: null, avalancheRank: null, status: null },
      needsAttention: {
        unplanned: { amount: "0.00", count: 0, truncated: false, rows: [] },
        unfiled: { amount: "12.00", count: 1, truncated: false, rows: [{ id: "a", date: todayIso, displayName: "Alpha", amount: "12.00", pending: false, category: null, flags: [], card: { accountId: "ext-plat", name: "Platinum", mask: "1005" } }] },
        uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
        truncated: false,
      },
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
    useGetAmexWeeklyPayoff: () => ({
      data: { cards: [{ accountId: "ext-plat", plaidAccountId: "row-plat", debtId: null, name: "Platinum", brand: "silver", cadence: "weekly", statementBalance: 100 }], debtLinkedCards: [] },
      isLoading: false,
    }),
    getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
    useListTransactions: (params: { limit?: number } = {}) =>
      (params.limit ?? 0) >= 5000 ? { data: undefined, isLoading: true } : { data: state.rows, isLoading: false, isSuccess: true, isPlaceholderData: false, isFetching: false },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: () => ({
      mutateAsync: async (args: { id: string; data: Record<string, unknown> }) => {
        state.updates.push(args);
        return { ...txn({ id: args.id }), ...args.data };
      },
      mutate: (args: { id: string; data: Record<string, unknown> }) => {
        state.updates.push(args);
      },
      isPending: false,
    }),
    useBulkUpdateTransactions: () => ({
      mutateAsync: async (vars: { data: { ids: string[]; patch: Record<string, unknown> } }) => {
        state.bulk.push(vars.data);
        return { results: vars.data.ids.map((id) => ({ id, ok: true })) };
      },
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
    useListPlaidItems: () => ({
      data: [{ id: "item-amex", institutionName: "American Express", institutionSlug: "amex", accounts: [{ id: "row-plat", accountId: "ext-plat", name: "Platinum Card", mask: "1005", type: "credit", subtype: "credit card" }] }],
    }),
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

function show(search = "") {
  window.history.replaceState(null, "", `/amex${search}`);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <div data-shell-scroller="" data-testid="scroller">
        <AmexPage />
      </div>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  state.rows = [
    txn({ id: "a", description: "ALPHA" }),
    txn({ id: "b", description: "BRAVO", weeklyAllowance: true, reviewed: true }),
    txn({ id: "c", description: "CHARLIE", isTransfer: true, amount: "50.00" }),
  ];
  state.updates = [];
  state.bulk = [];
});
afterEach(() => cleanup());

const ready = () => waitFor(() => expect(screen.getByTestId("row-amex-a")).toBeTruthy());

describe("(P1) Review is the default: words, no marks, no legend", () => {
  it("each row says its spending; the column is 'Spending'", async () => {
    show("?mode=month");
    await ready();
    expect(screen.getByTestId("spending-a").textContent).toBe("Spending: Not filed yet");
    expect(screen.getByTestId("spending-b").textContent).toBe("Spending: Weekly");
    expect(screen.getByTestId("spending-c").textContent).toBe("Spending: Not counted");
    expect(screen.queryByRole("button", { name: "Weekly bucket" })).toBeNull();
    expect(screen.queryByTestId("bucket-legend")).toBeNull();
    expect(screen.getByTestId("ledger-columns").textContent).toContain("Spending");
    const toggle = screen.getByTestId("amex-rowmode-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("Categorize");
  });
});

describe("(P1) the Categorize switch", () => {
  it("shows the marks and the legend, says how to finish, and is kept for the next visit", async () => {
    show("?mode=month");
    await ready();
    fireEvent.click(screen.getByTestId("amex-rowmode-toggle"));
    const toggle = screen.getByTestId("amex-rowmode-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Done categorizing");
    expect(within(screen.getByTestId("row-amex-a")).getByRole("button", { name: "Weekly bucket" })).toBeTruthy();
    expect(screen.queryByTestId("spending-a")).toBeNull();
    expect(screen.getByTestId("bucket-legend")).toBeTruthy();
    expect(screen.getByTestId("ledger-columns").textContent).toContain("Buckets");
    expect(window.localStorage.getItem("amex.rowMode")).toBe("categorize");
    cleanup();
    show("?mode=month");
    await ready();
    expect(screen.getByTestId("amex-rowmode-toggle").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("amex-rowmode-toggle"));
    expect(window.localStorage.getItem("amex.rowMode")).toBeNull();
  });

  it("leaves the selection alone", async () => {
    show("?mode=month");
    await ready();
    fireEvent.click(within(screen.getByTestId("row-amex-a")).getByRole("checkbox", { name: "Select ALPHA" }));
    expect(screen.getByTestId("amex-bulk-bar").textContent).toContain("1 selected");
    fireEvent.click(screen.getByTestId("amex-rowmode-toggle"));
    expect(screen.getByTestId("amex-bulk-bar").textContent).toContain("1 selected");
    expect(within(screen.getByTestId("row-amex-a")).getByRole("checkbox", { name: "Select ALPHA" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the first row in view where it was (the scroller moves by what the rows above it grew)", async () => {
    show("?mode=month");
    await ready();
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 500;
    // Scrolled into the activity: the pane is pinned and ends at 80 px. The first row (60–100 px) is the first row in view; the switch
    // makes the rows above it taller, so after it that row sits at 70 px: the scroller follows by 10.
    const first = document.querySelector('[data-testid^="row-amex-"]')!.getAttribute("data-testid");
    let phase: "before" | "after" = "before";
    const rect = (top: number) => ({ top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const id = this.getAttribute("data-testid");
      if (id === "amex-ledger") return rect(-300); // scrolled into the activity: the pane is pinned
      if (id === "ledger-pane") return rect(40);
      if (id === first) return rect(phase === "before" ? 60 : 70);
      if (id?.startsWith("row-amex-")) return rect(phase === "before" ? 200 : 260);
      return rect(0);
    });
    try {
      act(() => {
        screen.getByTestId("amex-rowmode-toggle").click(); // measured here, before the new layout
        phase = "after"; // what the next layout reports
      });
      await waitFor(() => expect(scroller.scrollTop).toBe(510));
    } finally {
      spy.mockRestore();
    }
  });

  it("above the activity (nothing pinned) the page is left alone: the switch stays under the finger", async () => {
    show("?mode=month");
    await ready();
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 0;
    fireEvent.click(screen.getByTestId("amex-rowmode-toggle"));
    expect(scroller.scrollTop).toBe(0);
  });
});

describe("(P1) a row's details", () => {
  it("open in place; Escape inside closes them and the focus goes back to the row's Details button", async () => {
    show("?mode=month");
    await ready();
    const toggle = screen.getByTestId("button-row-details-a");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const region = screen.getByTestId("amex-row-details-a");
    expect(screen.getByTestId("row-amex-a").contains(region)).toBe(true);
    fireEvent.keyDown(within(region).getByTestId("button-row-reviewed-a"), { key: "Escape" });
    expect(screen.queryByTestId("amex-row-details-a")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("button-row-details-a"));
  });

  it("Done closes them and gives the focus back; several may be open at once", async () => {
    show("?mode=month");
    await ready();
    fireEvent.click(screen.getByTestId("button-row-details-a"));
    fireEvent.click(screen.getByTestId("button-row-details-c"));
    expect(screen.getByTestId("amex-row-details-a")).toBeTruthy();
    expect(screen.getByTestId("amex-row-details-c")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-row-details-done-a"));
    expect(screen.queryByTestId("amex-row-details-a")).toBeNull();
    expect(screen.getByTestId("amex-row-details-c")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("button-row-details-a"));
  });

  it("stay open across the mode switch", async () => {
    show("?mode=month");
    await ready();
    fireEvent.click(screen.getByTestId("button-row-details-a"));
    fireEvent.click(screen.getByTestId("amex-rowmode-toggle"));
    expect(screen.getByTestId("amex-row-details-a")).toBeTruthy();
  });

  it("a reviewed row with open details stays listed under Hide reviewed until they close", async () => {
    show("?mode=month");
    await ready();
    fireEvent.click(screen.getByTestId("button-row-details-b"));
    fireEvent.click(screen.getByTestId("button-hide-reviewed"));
    expect(screen.getByTestId("row-amex-b")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-row-details-done-b"));
    await waitFor(() => expect(screen.queryByTestId("row-amex-b")).toBeNull());
  });

  it("a bucket chosen in the details sends the same PATCH the row's marks send", async () => {
    show("?mode=month");
    await ready();
    fireEvent.click(screen.getByTestId("button-row-details-a"));
    fireEvent.click(within(screen.getByTestId("amex-row-details-a")).getByRole("button", { name: "Weekly bucket" }));
    await waitFor(() => expect(state.updates.length).toBe(1));
    const fromDetails = state.updates[0]!;
    cleanup();
    state.updates = [];
    window.localStorage.setItem("amex.rowMode", "categorize");
    show("?mode=month");
    await ready();
    fireEvent.click(within(screen.getByTestId("row-amex-a")).getByRole("button", { name: "Weekly bucket" }));
    await waitFor(() => expect(state.updates.length).toBe(1));
    expect(state.updates[0]).toEqual(fromDetails);
    expect(fromDetails.data).toMatchObject({ weeklyAllowance: true, monthlyAllowance: false, unplannedAllowance: false, reviewed: true });
  });

  it("Mark reviewed goes through the bulk path for that one row; Count as spending clears the transfer", async () => {
    show("?mode=month");
    await ready();
    fireEvent.click(screen.getByTestId("button-row-details-a"));
    fireEvent.click(screen.getByTestId("button-row-reviewed-a"));
    await waitFor(() => expect(state.bulk).toEqual([{ ids: ["a"], patch: { reviewed: true } }]));
    fireEvent.click(screen.getByTestId("button-row-details-c"));
    fireEvent.click(screen.getByTestId("button-clear-transfer-c"));
    expect(state.updates).toContainEqual({ id: "c", data: { isTransfer: false } });
  });
});

describe("(P1) the Card column", () => {
  it("All cards names each row's card in its household words; one card's page has no Card column", async () => {
    show("?mode=month");
    await ready();
    expect(screen.getByTestId("text-card-a").textContent).toBe("Platinum ••1005");
    expect(screen.getByTestId("ledger-columns").textContent).toContain("Card");
    cleanup();
    show("?mode=month&card=ext-plat");
    await ready();
    expect(screen.queryByTestId("text-card-a")).toBeNull();
    expect(screen.getByTestId("ledger-columns").textContent).not.toContain("Card");
  });
});
