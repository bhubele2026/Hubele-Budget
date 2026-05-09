import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Regression coverage for task #438 — each Amex transaction row carries
// a per-row label that resolves the txn's `plaidAccountId` against the
// linked Plaid items and renders "<name> ••<mask>", or "—" when the
// transaction is manual (no `plaidAccountId`) or the linked Plaid
// account isn't in the items list (e.g. unlinked / removed). The label
// is exposed via the `text-card-<id>` (desktop) and
// `text-card-mobile-<id>` (mobile list) hooks.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

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
vi.mock("@/components/matched-rule-chip", () => ({ MatchedRuleChip: () => null }));

const state = vi.hoisted(() => ({
  monthTxns: [] as Array<Record<string, unknown>>,
  plaidItems: [] as Array<Record<string, unknown>>,
}));

const today = new Date();
const todayIso = today.toISOString().slice(0, 10);

function makeTxn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tx-1",
    occurredOn: todayIso,
    postedOn: todayIso,
    description: "STARBUCKS",
    amount: "-12.34",
    source: "amex",
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
    plaidAccountId: null,
    reviewed: false,
    member: null,
    ...overrides,
  };
}

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
    useListTransactions: (params: { limit?: number } = {}) => {
      if ((params.limit ?? 0) >= 5000) {
        return { data: undefined, isLoading: true };
      }
      return { data: state.monthTxns, isLoading: false };
    },
    useListCategories: () => ({ data: [] }),
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
    }),
    useBulkUpdateTransactions: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
      isPending: false,
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
    useListPlaidItems: () => ({ data: state.plaidItems }),
    useSyncPlaidTransactions: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
      isPending: false,
    }),
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    customFetch: async () => undefined,
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
  state.monthTxns = [];
  state.plaidItems = [];
});
afterEach(() => cleanup());

describe("Amex page — per-row source-card label", () => {
  it("renders '<name> ••<mask>' for a txn whose plaidAccountId resolves to a linked account", async () => {
    state.plaidItems = [
      {
        id: "item-1",
        institutionName: "American Express",
        accounts: [
          {
            accountId: "plaid-acct-gold",
            name: "Amex Gold",
            officialName: "American Express Gold Card",
            mask: "1002",
          },
        ],
      },
    ];
    state.monthTxns = [
      makeTxn({ id: "tx-linked", description: "LINKED ROW", plaidAccountId: "plaid-acct-gold" }),
    ];
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText(/LINKED ROW/).length).toBeGreaterThan(0);
    });

    const desktopCell = screen.getByTestId("text-card-tx-linked");
    expect(desktopCell.textContent ?? "").toBe("Amex Gold ••1002");

    const mobileCell = screen.getByTestId("text-card-mobile-tx-linked");
    expect(mobileCell.textContent ?? "").toBe("Amex Gold ••1002");
  });

  it("renders '—' for a manual txn with no plaidAccountId", async () => {
    // A linked Plaid account exists, but this row isn't tied to it.
    state.plaidItems = [
      {
        id: "item-1",
        institutionName: "American Express",
        accounts: [
          {
            accountId: "plaid-acct-gold",
            name: "Amex Gold",
            mask: "1002",
          },
        ],
      },
    ];
    // Pin one txn to the Plaid account so the page's Amex scope is
    // populated (otherwise no Plaid items become "in scope" and the
    // label map ends up empty for everyone) — and add the manual row
    // we actually want to assert on.
    state.monthTxns = [
      makeTxn({
        id: "tx-anchor",
        description: "ANCHOR ROW",
        plaidAccountId: "plaid-acct-gold",
      }),
      makeTxn({
        id: "tx-manual",
        description: "MANUAL ROW",
        plaidAccountId: null,
      }),
    ];
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText(/MANUAL ROW/).length).toBeGreaterThan(0);
    });

    const desktopCell = screen.getByTestId("text-card-tx-manual");
    expect(desktopCell.textContent ?? "").toBe("—");

    const mobileCell = screen.getByTestId("text-card-mobile-tx-manual");
    expect(mobileCell.textContent ?? "").toBe("—");
  });

  it("renders '—' (no error) when the txn's plaidAccountId isn't in the linked accounts list", async () => {
    // The known/linked account drives the page into scope; the
    // "orphan" row's plaidAccountId is not represented in any item.
    state.plaidItems = [
      {
        id: "item-1",
        institutionName: "American Express",
        accounts: [
          {
            accountId: "plaid-acct-gold",
            name: "Amex Gold",
            mask: "1002",
          },
        ],
      },
    ];
    state.monthTxns = [
      makeTxn({
        id: "tx-anchor",
        description: "ANCHOR ROW",
        plaidAccountId: "plaid-acct-gold",
      }),
      makeTxn({
        id: "tx-orphan",
        description: "ORPHAN ROW",
        plaidAccountId: "plaid-acct-unlinked",
      }),
    ];
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText(/ORPHAN ROW/).length).toBeGreaterThan(0);
    });

    const desktopCell = screen.getByTestId("text-card-tx-orphan");
    expect(desktopCell.textContent ?? "").toBe("—");

    const mobileCell = screen.getByTestId("text-card-mobile-tx-orphan");
    expect(mobileCell.textContent ?? "").toBe("—");
  });
});
