import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (C10) The Amex page on the panel grid — composition, and the card scope on
 * a cold load (D3). Every figure, write and bulk path is pinned by the other
 * `amex*` tests, which this restyle left unchanged.
 *
 * - Head: h1 "American Express" (e2e finds it by role), with the selected
 *   card's chip under it, or "All cards".
 * - The card band renders GRID CELLS: an "All cards" panel and one panel per
 *   card with the Amex identity edge, its ••mask and its tier dot, sized so
 *   the row stays full (with a host's `lead` panel too).
 * - The ledger is ONE sticky-safe panel whose pinned pane holds the
 *   hide-reviewed control; day groups are flush sections; the bulk bar
 *   sticks under the pane via `--page-sticky-top`.
 * - Rows: the card label keeps its exact text, with the account's accent dot
 *   beside it on both row layouts.
 * - D3: a card chosen by the route (`/next/accounts/:id`) or by `?accountId=`
 *   survives a cold load — the options are empty until the rows and the
 *   linked items answer, and the page no longer resets to "All cards" then.
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
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));
vi.mock("@/components/matched-rule-chip", () => ({ MatchedRuleChip: () => null }));
vi.mock("@/components/add-card-to-avalanche", () => ({ AddToAvalanche: () => <span>add</span> }));

const state = vi.hoisted(() => ({
  monthTxns: undefined as Array<Record<string, unknown>> | undefined,
  items: undefined as unknown[] | undefined,
  payoff: undefined as unknown,
  /** (WP7c) Every list read's params, in order. */
  listParams: [] as Array<Record<string, unknown>>,
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
  combinedWeekCharges: 30,
  combinedStatementBalance: 3000,
  cards: [
    { accountId: "ext-plat", plaidAccountId: "row-plat", debtId: null, name: "Platinum", brand: "platinum", cadence: "weekly", periodLabel: "", displayName: null, weekCharges: 20, chargeCount: 1, statementBalance: 2000, pctOfStatementThisWeek: 0.1, topMerchant: null },
    { accountId: "ext-gold", plaidAccountId: "row-gold", debtId: null, name: "Gold", brand: "gold", cadence: "weekly", periodLabel: "", displayName: null, weekCharges: 10, chargeCount: 1, statementBalance: 1000, pctOfStatementThisWeek: 0.2, topMerchant: null },
  ],
};

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

let qc: QueryClient;
function tree(props: React.ComponentProps<typeof AmexPage> = {}) {
  return (
    <QueryClientProvider client={qc}>
      <AmexPage {...props} />
    </QueryClientProvider>
  );
}

const ROWS = () => [
  makeTxn({ id: "p1", description: "PLATROW", plaidAccountId: "ext-plat" }),
  makeTxn({ id: "g1", description: "GOLDROW", plaidAccountId: "ext-gold" }),
];

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  window.localStorage.clear();
  window.history.replaceState(null, "", "/amex");
  state.monthTxns = ROWS();
  state.items = ITEMS;
  state.payoff = PAYOFF;
  state.listParams = [];
});
afterEach(() => cleanup());

/** A card's panel (two cards of one tier share `amex-tile-<tier>`). */
const tile = (accountId: string) =>
  document.querySelector(`[data-account-id="${accountId}"]`) as HTMLElement;

async function ready() {
  await waitFor(() => expect(screen.getByTestId("row-amex-p1")).toBeTruthy());
}

describe("Amex page — the panel grid (C10)", () => {
  it("head: an h1 with 'All cards' until a card is picked, then that card's chip", async () => {
    render(tree());
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: /american express/i })).toBeTruthy();
    expect(screen.getByTestId("amex-head-all-cards").textContent).toBe("All cards");
    fireEvent.click(within(tile("ext-gold")).getByRole("button", { pressed: false }));
    await waitFor(() => expect(screen.getByTestId("account-head-identity").textContent).toContain("Gold"));
    expect(screen.getByTestId("account-head-identity").textContent).toContain("••2002");
    expect(screen.getByTestId("account-head-identity").querySelector('[data-accent="amex"]')).toBeTruthy();
    // The drill still filters the ledger to that card (AX-04).
    expect(screen.queryByTestId("row-amex-p1")).toBeNull();
    expect(screen.getByTestId("row-amex-g1")).toBeTruthy();
  });

  it("card band: grid cells — an 'All cards' panel and an Amex-accent panel per card with its mask", async () => {
    render(tree());
    await ready();
    const all = screen.getByTestId("amex-tile-all");
    const plat = tile("ext-plat");
    // Cells of the page grid, not a grid of their own; three cells → span-4
    // (a fourth card would make them span-3; two cells span-6).
    expect(all.parentElement!.className).toContain("grid-12");
    expect(plat.parentElement).toBe(all.parentElement);
    for (const el of [all, plat]) expect(el.className).toContain("span-4");
    expect(plat.className).toContain("panel-accent-amex");
    expect(all.className).not.toContain("panel-accent");
    expect(plat.textContent).toContain("••1005");
    expect(plat.textContent).toContain("$2,000.00");
    expect(plat.textContent).toContain("cleared");
    // Add to Avalanche rides on every card panel (AX-27), not on "All cards".
    expect(within(plat).getByText("add")).toBeTruthy();
    expect(within(tile("ext-gold")).getByText("add")).toBeTruthy();
    expect(within(all).queryByText("add")).toBeNull();
    expect(all.getAttribute("aria-pressed")).toBe("true");
  });

  it("ledger: one sticky-safe panel; its pane holds hide-reviewed; flush day groups; bulk bar under the pane", async () => {
    render(tree());
    await ready();
    const ledger = screen.getByTestId("amex-ledger");
    for (const c of ["span-12", "panel-sticky-safe", "panel-flush", "panel-accent-amex"]) {
      expect(ledger.className).toContain(c);
    }
    const pane = within(ledger).getByTestId("ledger-pane");
    expect(pane.className).toMatch(/^sticky top-0 /);
    expect(within(pane).getByTestId("button-hide-reviewed")).toBeTruthy();
    expect(screen.getByTestId("amex-page").style.getPropertyValue("--page-sticky-top")).toMatch(/px$/);
    expect(ledger.querySelectorAll('[data-variant="flush"]').length).toBeGreaterThan(0);
    // Both row layouts are mounted (AX-31), inside the ledger panel.
    expect(within(ledger).getByTestId("row-amex-p1")).toBeTruthy();
    expect(within(ledger).getByTestId("row-amex-mobile-p1")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("row-amex-p1")).getByRole("checkbox", { name: "Select" }));
    const bar = await screen.findByTestId("amex-bulk-bar");
    expect(bar.style.top).toBe("var(--page-sticky-top, 0px)");
    expect(ledger.contains(bar)).toBe(true);
    expect(within(bar).getByTestId("button-bulk-mark-reviewed")).toBeTruthy();
  });

  it("rows: the card label keeps its text on both layouts, with the Amex accent dot beside it", async () => {
    render(tree());
    await ready();
    for (const id of ["text-card-p1", "text-card-mobile-p1"]) {
      const label = screen.getByTestId(id);
      expect(label.textContent).toBe("Platinum ••1005");
      expect(label.parentElement!.querySelector('[aria-hidden="true"]')!.className).toContain("bg-acct-amex");
    }
  });
});

describe("Amex page embedded (/next/accounts/:id) — the same layout", () => {
  it("drops the title, keeps the actions, and puts the host's lead first in the card row", async () => {
    render(tree({ embedded: true, accountId: "ext-plat", lead: <section data-testid="lead" className="panel span-4" /> }));
    await ready();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByTestId("amex-embedded-actions")).toBeTruthy();
    const lead = screen.getByTestId("lead");
    const all = screen.getByTestId("amex-tile-all");
    expect(lead.parentElement).toBe(all.parentElement);
    expect(lead.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Beside the span-4 lead every card cell is span-4: rows of three.
    expect(all.className).toContain("span-4");
    expect(tile("ext-gold").className).toContain("span-4");
    expect(screen.getByTestId("amex-ledger").className).toContain("panel-sticky-safe");
  });
});

describe("(WP7c) the embedded card asks for its own rows", () => {
  it("embedded: every list read carries the card's plaidAccountId and no source", async () => {
    render(tree({ embedded: true, accountId: "ext-plat" }));
    await ready();
    expect(state.listParams.length).toBeGreaterThan(0);
    for (const p of state.listParams) {
      expect(p.plaidAccountId).toBe("ext-plat");
      expect("source" in p).toBe(false);
    }
  });
  it("standalone: the Amex source list, and no plaidAccountId", async () => {
    render(tree());
    await ready();
    for (const p of state.listParams) {
      expect(p.source).toBe("amex,plaid:amex,plaid:apple-card,apple-card");
      expect("plaidAccountId" in p).toBe(false);
    }
  });
});

describe("D3 — the card scope survives a cold load", () => {
  it("embedded: the route's card holds while the rows and items load, then only its rows show", async () => {
    state.monthTxns = undefined;
    state.items = undefined;
    const view = render(tree({ embedded: true, accountId: "ext-plat" }));
    // Cold: the skeleton, and the options are empty.
    expect(screen.queryByTestId("row-amex-p1")).toBeNull();
    state.monthTxns = ROWS();
    state.items = ITEMS;
    view.rerender(tree({ embedded: true, accountId: "ext-plat" }));
    await ready();
    expect(screen.queryByTestId("row-amex-g1")).toBeNull();
    expect(screen.queryByTestId("row-amex-mobile-g1")).toBeNull();
  });

  it("standalone ?accountId=: the deep-linked card holds through the cold load", async () => {
    window.history.replaceState(null, "", "/amex?accountId=ext-plat");
    state.monthTxns = undefined;
    state.items = undefined;
    const view = render(tree());
    state.monthTxns = ROWS();
    view.rerender(tree());
    // Rows answered, items not yet: still no reset.
    state.items = ITEMS;
    view.rerender(tree());
    await ready();
    expect(screen.queryByTestId("row-amex-g1")).toBeNull();
    expect(tile("ext-plat").className).toContain("ring-2");
  });

  it("standalone: a card that is not on this page still falls back to All cards once the options are known", async () => {
    window.history.replaceState(null, "", "/amex?accountId=ext-gone");
    render(tree());
    await ready();
    await waitFor(() => expect(screen.getByTestId("row-amex-g1")).toBeTruthy());
    expect(screen.getByTestId("amex-tile-all").getAttribute("aria-pressed")).toBe("true");
  });
});
