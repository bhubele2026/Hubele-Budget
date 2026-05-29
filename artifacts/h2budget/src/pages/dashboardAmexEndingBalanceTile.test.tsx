import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (#574) The dashboard Amex ending-balance tile must agree with the
// Amex page's "Ending balance" header for the current month. Both
// surfaces resolve the same anchor (linked Amex debt, else
// `/api/amex/anchor`) and route through the shared
// `computeAmexEndOfMonthBalance` helper, so this test renders both
// pages against the same mocked transactions + anchor and asserts
// the dollar amounts match.

type AnchorResp = {
  amexEndingBalance: number | null;
  asOf: string;
  source: "debt" | "anchor" | "computed" | "plaid" | "missing";
};

const today = new Date();
const thisMonthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
const thisMonthMid = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-15`;

let anchorState: AnchorResp = {
  amexEndingBalance: 1000,
  asOf: `${thisMonthStart}T00:00:00.000Z`,
  source: "anchor",
};

type DebtRow = {
  id: string;
  name: string;
  balance: string;
  plaidAccountId: string | null;
  lastBalanceUpdate: string | null;
  plaidLastSyncedAt: string | null;
};

type PlaidItemRow = {
  id: string;
  institutionName: string | null;
  accounts: Array<{ id: string; mask: string | null }>;
};

let debtsState: DebtRow[] = [];
let plaidItemsState: PlaidItemRow[] = [];

const sharedTxns: Array<{
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  source: string;
  weeklyAllowance: boolean;
  monthlyAllowance: boolean;
  unplannedAllowance: boolean;
  plaidAccountId: string | null;
  reviewed?: boolean;
  member?: string | null;
  categoryId?: string | null;
}> = [
  {
    id: "amex-1",
    occurredOn: thisMonthMid,
    description: "Coffee",
    amount: "25.00",
    source: "amex",
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    plaidAccountId: null,
  },
  {
    id: "amex-2",
    occurredOn: thisMonthMid,
    description: "Payment",
    amount: "-100.00",
    source: "plaid:amex",
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    plaidAccountId: null,
  },
];

// (#574) The dashboard scopes its `allTxns` query to amex sources via
// `t.source === "amex" | "plaid:amex"`, while the Amex page issues a
// server-side `source=amex,plaid:amex` filter. Our mock useListTransactions
// returns the same array for every caller, so we keep the shared list
// to amex-only rows — that way both surfaces see the same set and the
// dashboard tile and Amex header are computing over identical inputs.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useLocation: () => ["/", () => undefined] as const,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/category-picker", () => ({
  CategoryPicker: () => null,
  defaultRememberPattern: (s: string) => s,
}));
vi.mock("@/components/bucket-bubbles", () => ({ BucketBubbles: () => null }));
vi.mock("@/components/dashboard-kill-order", () => ({
  DashboardKillOrder: () => null,
}));
vi.mock("@/components/avalanche-ready-card", () => ({
  AvalancheReadyCard: () => null,
}));
vi.mock("@/components/debt-plaid-link", () => ({
  DebtReauthBanner: () => null,
}));
vi.mock("@/components/plaid-expiring-soon-list", () => ({
  PlaidExpiringSoonList: () => null,
}));
vi.mock("@/components/matched-rule-chip", () => ({
  MatchedRuleChip: () => null,
}));

vi.mock("@workspace/api-client-react", () => {
  const TransactionWeeklyBucket = {
    groceries: "groceries",
    dining: "dining",
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useGetAdvisorNudge: () => ({ data: undefined, isLoading: false }),
    useGetDashboard: () => ({
      data: {
        totalDebt: "0",
        activeDebtCount: 0,
        netCashflow: "0",
        monthlyIncome: "0",
        monthlySpend: "0",
        paidThisMonth: "0",
        paidLifetime: "0",
        recentTransactions: [],
        topCategories: [],
        upcomingBills: [],
      },
      isLoading: false,
    }),
    useGetBudgetMonth: () => ({ data: undefined, isLoading: false }),
    useGetForecast: () => ({ data: undefined }),
    useListTransactions: () => ({ data: sharedTxns, isLoading: false }),
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: debtsState }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useListWeeklySettlements: () => ({ data: [], isLoading: false }),
    useCloseOutWeek: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
      isPending: false,
    }),
    useReopenWeek: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
      isPending: false,
    }),
    getListWeeklySettlementsQueryKey: () => ["/api/weekly-settlements"],
    useListDashboardBudgets: () => ({ data: [{ amount: "0", isDefault: true }] }),
    useUpsertDashboardBudget: () => ({ mutate: () => {}, isPending: false }),
    useDeleteDashboardBudget: () => ({ mutate: () => {}, isPending: false }),
    useUpdateTransaction: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
    }),
    useBulkUpdateTransactions: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
    }),
    useRecategorizeTransactionsByPattern: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    useDeleteMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    useUpdateMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getListDashboardBudgetsQueryKey: () => ["/api/dashboard-budgets"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({ data: plaidItemsState }),
    useSyncPlaidTransactions: () => ({
      mutateAsync: async () => ({ added: 0, modified: 0, removed: 0 }),
      mutate: () => undefined,
      isPending: false,
    }),
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    customFetch: async (url: string) => {
      if (url === "/api/amex/anchor") return anchorState;
      return undefined;
    },
  };
});

import DashboardPage from "./dashboard";
import AmexPage from "./amex";

function renderPage(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  anchorState = {
    amexEndingBalance: 1000,
    asOf: `${thisMonthStart}T00:00:00.000Z`,
    source: "anchor",
  };
  debtsState = [];
  plaidItemsState = [];
  // Reset txns to the no-plaid-account variant used by the
  // server-side-anchor parity test.
  sharedTxns.forEach((t) => {
    t.plaidAccountId = null;
  });
});

afterEach(() => {
  cleanup();
});

function extractDollars(text: string): string | null {
  const m = text.match(/-?\$[\d,]+\.\d{2}/);
  return m ? m[0] : null;
}

async function readDashboardTile(): Promise<string | null> {
  const dash = renderPage(<DashboardPage />);
  const dashTile = await screen.findByTestId("tile-amex-ending-balance");
  let value: string | null = null;
  await waitFor(
    () => {
      value = extractDollars(dashTile.textContent ?? "");
      expect(value).not.toBeNull();
    },
    { timeout: 5000 },
  );
  dash.unmount();
  cleanup();
  return value;
}

async function readAmexHeader(): Promise<string | null> {
  renderPage(<AmexPage />);
  let value: string | null = null;
  await waitFor(
    () => {
      const headerTile = screen.getByTestId("stat-ending-balance");
      value = extractDollars(headerTile.textContent ?? "");
      expect(value).not.toBeNull();
    },
    { timeout: 5000 },
  );
  cleanup();
  return value;
}

describe("Dashboard Amex ending-balance tile (#574)", () => {
  it("matches the Amex page header when the anchor comes from /api/amex/anchor", async () => {
    // No debts and no plaid items — both surfaces fall back to the
    // server-side anchor (1000) and walk current-month txns
    // (+25 - 100 = -75) → $925.00.
    const dashValue = await readDashboardTile();
    const amexValue = await readAmexHeader();
    expect(dashValue).toBe(amexValue);
    expect(dashValue).toBe("$925.00");
  });

  it("matches the Amex page header when the anchor comes from a single linked Amex debt", async () => {
    // Both txns reference the same plaid account id so
    // `amexPlaidAccountIds` is non-empty on both surfaces, which
    // forces the linked-debt branch of `resolveAmexDebt`.
    sharedTxns.forEach((t) => {
      t.plaidAccountId = "plaid-acct-amex-1";
    });
    debtsState = [
      {
        id: "debt-amex-1",
        name: "Amex Gold",
        balance: "1500",
        plaidAccountId: "plaid-acct-amex-1",
        lastBalanceUpdate: `${thisMonthStart}T00:00:00.000Z`,
        plaidLastSyncedAt: null,
      },
    ];
    plaidItemsState = [
      {
        id: "item-1",
        institutionName: "American Express",
        accounts: [{ id: "plaid-acct-amex-1", mask: "1001" }],
      },
    ];
    // Server anchor is also present but the linked debt should win
    // on both surfaces. Set the server anchor to a wildly different
    // value so a regression that quietly falls back to it would be
    // visible in the assertion failure.
    anchorState = {
      amexEndingBalance: 9999,
      asOf: `${thisMonthStart}T00:00:00.000Z`,
      source: "anchor",
    };
    const dashValue = await readDashboardTile();
    const amexValue = await readAmexHeader();
    expect(dashValue).toBe(amexValue);
    // anchor 1500 + (25 - 100) = 1425.00
    expect(dashValue).toBe("$1,425.00");
  });

  it("matches the Amex page header when multiple linked Amex debts are aggregated across cards", async () => {
    // Two physical Amex cards under one Plaid item, each with its
    // own debt row. Both surfaces should sum the linked debts (1500
    // + 800 = 2300) before walking the current-month txns.
    sharedTxns[0].plaidAccountId = "plaid-acct-amex-1";
    sharedTxns[1].plaidAccountId = "plaid-acct-amex-2";
    debtsState = [
      {
        id: "debt-amex-1",
        name: "Amex Gold",
        balance: "1500",
        plaidAccountId: "plaid-acct-amex-1",
        lastBalanceUpdate: `${thisMonthStart}T00:00:00.000Z`,
        plaidLastSyncedAt: null,
      },
      {
        id: "debt-amex-2",
        name: "Amex Platinum",
        balance: "800",
        plaidAccountId: "plaid-acct-amex-2",
        lastBalanceUpdate: `${thisMonthStart}T00:00:00.000Z`,
        plaidLastSyncedAt: null,
      },
    ];
    plaidItemsState = [
      {
        id: "item-1",
        institutionName: "American Express",
        accounts: [
          { id: "plaid-acct-amex-1", mask: "1001" },
          { id: "plaid-acct-amex-2", mask: "1002" },
        ],
      },
    ];
    const dashValue = await readDashboardTile();
    const amexValue = await readAmexHeader();
    expect(dashValue).toBe(amexValue);
    // (1500 + 800) + (25 - 100) = 2225.00
    expect(dashValue).toBe("$2,225.00");
  });

  it("matches the Amex page header when duplicate plaid_accounts rows for the same physical card are deduped", async () => {
    // Mid-relink dedupe race (#449): two debts on the same physical
    // card (institution + mask), each pointing at a different
    // `plaid_accounts` row id. The dedupe step must collapse them
    // down to a single most-recently-updated debt instead of summing
    // — and both surfaces must collapse the same way.
    sharedTxns[0].plaidAccountId = "plaid-acct-amex-old";
    sharedTxns[1].plaidAccountId = "plaid-acct-amex-new";
    debtsState = [
      {
        id: "debt-amex-old",
        name: "Amex Gold",
        balance: "1500",
        plaidAccountId: "plaid-acct-amex-old",
        lastBalanceUpdate: `${today.getFullYear() - 1}-01-01T00:00:00.000Z`,
        plaidLastSyncedAt: null,
      },
      {
        id: "debt-amex-new",
        name: "Amex Gold",
        balance: "1700",
        plaidAccountId: "plaid-acct-amex-new",
        lastBalanceUpdate: `${thisMonthStart}T00:00:00.000Z`,
        plaidLastSyncedAt: null,
      },
    ];
    plaidItemsState = [
      {
        id: "item-1",
        institutionName: "American Express",
        accounts: [
          { id: "plaid-acct-amex-old", mask: "1001" },
          { id: "plaid-acct-amex-new", mask: "1001" },
        ],
      },
    ];
    const dashValue = await readDashboardTile();
    const amexValue = await readAmexHeader();
    expect(dashValue).toBe(amexValue);
    // Dedupe keeps the newer 1700 (not 1500 + 1700 = 3200).
    // 1700 + (25 - 100) = 1625.00
    expect(dashValue).toBe("$1,625.00");
  });
});
