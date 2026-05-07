import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Regression coverage for task #455 — the Ending balance tile on the Amex
// page must always render its label and either a value or an explicit
// empty/loading affordance, across all sources `endingBalance.source`
// can produce: loading, missing, anchor, debt, computed.

type AnchorResp = {
  amexEndingBalance: number | null;
  asOf: string;
  source: "debt" | "anchor" | "computed" | "missing";
};

let anchorState: AnchorResp | null = null;
let anchorResolve: ((v: AnchorResp) => void) | null = null;
let debtsState: Array<{
  id: string;
  name: string;
  balance: string;
  plaidAccountId: string | null;
  lastBalanceUpdate: string | null;
  plaidLastSyncedAt: string | null;
}> = [];

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
    useListTransactions: () => ({ data: [], isLoading: false }),
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: debtsState }),
    useUpdateTransaction: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
    }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    useDeleteMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    useUpdateMappingRule: () => ({ mutate: () => undefined, isPending: false }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    useListPlaidItems: () => ({ data: [] }),
    useSyncPlaidTransactions: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
      isPending: false,
    }),
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    customFetch: async (url: string) => {
      if (url === "/api/amex/anchor") {
        if (anchorState) return anchorState;
        // Loading branch: return a promise the test controls.
        return new Promise<AnchorResp>((resolve) => {
          anchorResolve = resolve;
        });
      }
      return undefined;
    },
  };
});

import AmexPage from "./amex";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  anchorState = null;
  anchorResolve = null;
  debtsState = [];
});

afterEach(() => {
  cleanup();
  // Drain any pending loading promise so vitest doesn't warn.
  if (anchorResolve) {
    anchorResolve({
      amexEndingBalance: null,
      asOf: new Date().toISOString(),
      source: "missing",
    });
    anchorResolve = null;
  }
});

describe("Amex Ending balance tile — never empty", () => {
  it("loading: shows label and a Loading… affordance (no bare skeleton)", async () => {
    // Anchor query never resolves -> source === 'loading'.
    renderPage();
    const tile = await screen.findByTestId("stat-ending-balance");
    expect(tile.textContent).toMatch(/Ending balance/i);
    expect(tile.textContent).toMatch(/Loading/i);
  });

  it("missing: shows label, 'Not set', and the Set Amex balance action", async () => {
    anchorState = {
      amexEndingBalance: null,
      asOf: "2026-04-01T00:00:00.000Z",
      source: "missing",
    };
    renderPage();
    await waitFor(() => {
      const tile = screen.getByTestId("stat-ending-balance");
      expect(tile.textContent).toMatch(/Ending balance/i);
      expect(tile.textContent).toMatch(/Not set/);
    });
    expect(screen.getByTestId("button-set-amex-balance")).toBeTruthy();
  });

  it("anchor: shows label and the saved dollar amount", async () => {
    anchorState = {
      amexEndingBalance: 1234.56,
      asOf: "2026-04-01T00:00:00.000Z",
      source: "anchor",
    };
    renderPage();
    await waitFor(() => {
      const tile = screen.getByTestId("stat-ending-balance");
      expect(tile.textContent).toMatch(/Ending balance/i);
      expect(tile.textContent).toMatch(/1,234\.56/);
    });
  });

  it("debt: shows label and the linked-debt dollar amount", async () => {
    debtsState = [
      {
        id: "d1",
        name: "American Express Card",
        balance: "987.65",
        plaidAccountId: null,
        lastBalanceUpdate: "2026-04-15T00:00:00.000Z",
        plaidLastSyncedAt: null,
      },
    ];
    anchorState = {
      amexEndingBalance: null,
      asOf: "2026-04-01T00:00:00.000Z",
      source: "missing",
    };
    renderPage();
    await waitFor(() => {
      const tile = screen.getByTestId("stat-ending-balance");
      expect(tile.textContent).toMatch(/Ending balance/i);
      expect(tile.textContent).toMatch(/987\.65/);
    });
  });

  it("computed: shows label and the computed dollar amount", async () => {
    anchorState = {
      amexEndingBalance: 500,
      asOf: "2026-04-01T00:00:00.000Z",
      source: "computed",
    };
    renderPage();
    await waitFor(() => {
      const tile = screen.getByTestId("stat-ending-balance");
      expect(tile.textContent).toMatch(/Ending balance/i);
      expect(tile.textContent).toMatch(/\$/);
    });
  });
});
