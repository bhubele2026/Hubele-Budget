// (#762 — Phase B) Chase page Send-to-Review affordances:
//   * per-row Send / "✓ in review" toggle
//   * bulk "Send N to Review" button in the bulk-bar
//   * 5-second toast Undo wired to the unsend endpoint
//
// This test mocks the api-client-react hooks (mirroring
// transactionsHeaderCollapse.test.tsx) so we exercise the page wiring
// without spinning up the API server.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

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
  useLocation: () => ["/transactions", () => undefined] as const,
}));

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/hooks/use-opportunistic-plaid-sync", () => ({
  useOpportunisticPlaidSync: () => undefined,
}));

vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({
    offerBulkRecategorize: () => undefined,
    previewDialog: null,
  }),
  bulkRuleFromRepointed: () => null,
  bulkRuleFromRuleAction: () => null,
}));

vi.mock("@/lib/useRuleActionUndo", () => ({
  useRuleActionUndo: () => () => undefined,
}));

vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));
vi.mock("@/components/sync-button", () => ({
  SyncButton: () => null,
}));
vi.mock("@/components/post-link-progress", () => ({
  PostLinkProgressBanner: () => null,
}));
vi.mock("@/components/plaid-reauth-banner", () => ({
  PlaidReauthBanner: () => null,
}));
vi.mock("@/components/bank-snapshot-freshness", () => ({
  BankSnapshotFreshness: () => null,
}));
vi.mock("@/components/transaction-row-chips", () => ({
  TransactionRowChips: () => null,
}));
vi.mock("@/components/matched-rule-chip", () => ({
  MatchedRuleChip: () => null,
}));

// Seed two rows — one already sent, one not — so we can assert both
// the badge and the Send affordance render side-by-side.
const TXN_NOT_SENT = {
  id: "txn-not-sent",
  occurredOn: "2026-05-15",
  description: "Coffee shop",
  amount: "-4.25",
  forecastFlag: false,
  weeklyAllowance: false,
  monthlyAllowance: false,
  unplannedAllowance: false,
  reimbursable: false,
  reimbursed: false,
  reviewed: false,
  isTransfer: false,
  isTransferUserOverridden: false,
  isExternalCardPayment: false,
  pending: false,
  source: "chase",
  categoryId: null,
  sentToReviewAt: null,
  matchedRuleId: null,
};
const TXN_SENT = {
  ...TXN_NOT_SENT,
  id: "txn-sent",
  description: "Grocery store",
  amount: "-22.10",
  sentToReviewAt: "2026-05-15T12:00:00.000Z",
};
// (#762 — Phase B, pending-row coverage) Pending rows must surface the
// same Send / "✓ in review" affordance as posted rows. We seed one
// pending unsent row and one pending sent row so the test below can
// assert both states render in the Pending group.
const TXN_PENDING_NOT_SENT = {
  ...TXN_NOT_SENT,
  id: "txn-pending-not-sent",
  description: "Pending coffee",
  pending: true,
};
const TXN_PENDING_SENT = {
  ...TXN_NOT_SENT,
  id: "txn-pending-sent",
  description: "Pending grocery",
  pending: true,
  sentToReviewAt: "2026-05-15T12:00:00.000Z",
};

const sendMutateAsync = vi.fn();
const sendMutate = vi.fn();
const unsendMutateAsync = vi.fn();
const unsendMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => {
  const noop = {
    mutate: () => undefined,
    mutateAsync: async () => undefined,
    isPending: false,
  };
  return {
    useListTransactions: () => ({
      data: [TXN_SENT, TXN_NOT_SENT, TXN_PENDING_SENT, TXN_PENDING_NOT_SENT],
      isLoading: false,
    }),
    useCreateTransaction: () => noop,
    useUpdateTransaction: () => noop,
    useClearTransferOverride: () => noop,
    useDeleteTransaction: () => noop,
    useListCategories: () => ({ data: [] }),
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useGetForecast: () => ({ data: undefined }),
    useGetForecastCashSignal: () => ({ data: undefined }),
    useRefreshForecastBank: () => ({ ...noop, isPending: false }),
    useSeedAprilChase: () => ({
      mutate: (_v: unknown, opts?: { onSuccess?: (r: unknown) => void }) =>
        opts?.onSuccess?.({
          inserted: 0,
          rulesAdded: 0,
          snapshotRepaired: false,
        }),
    }),
    useBulkSetForecastFlag: () => noop,
    useSendTransactionsToReview: () => ({
      mutate: sendMutate,
      mutateAsync: sendMutateAsync,
      isPending: false,
    }),
    useUnsendTransactionsFromReview: () => ({
      mutate: unsendMutate,
      mutateAsync: unsendMutateAsync,
      isPending: false,
    }),
    useListPlaidItems: () => ({ data: [] }),
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
  };
});

import TransactionsPage from "./transactions";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastSpy.mockReset();
  sendMutate.mockReset();
  sendMutateAsync.mockReset();
  unsendMutate.mockReset();
  unsendMutateAsync.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Chase Send-to-Review (#762 Phase B)", () => {
  it("renders the '✓ in review' badge for sent rows and the Send button for unsent rows", async () => {
    renderPage();
    expect(await screen.findByTestId("badge-in-review-txn-sent")).toBeTruthy();
    expect(screen.getByTestId("button-send-review-txn-not-sent")).toBeTruthy();
    // Belt-and-braces: the unsent row must not render the badge.
    expect(screen.queryByTestId("badge-in-review-txn-not-sent")).toBeNull();
  });

  it("renders the Send affordance and badge on pending rows too", async () => {
    renderPage();
    // Pending unsent row → Send button visible inside the Pending group.
    const pendingGroup = await screen.findByTestId("group-pending");
    expect(
      within(pendingGroup).getByTestId(
        "button-send-review-txn-pending-not-sent",
      ),
    ).toBeTruthy();
    // Pending already-sent row → "✓ in review" badge inside the same group.
    expect(
      within(pendingGroup).getByTestId("badge-in-review-txn-pending-sent"),
    ).toBeTruthy();
    // Pending unsent row must not also render the badge.
    expect(
      within(pendingGroup).queryByTestId(
        "badge-in-review-txn-pending-not-sent",
      ),
    ).toBeNull();
  });

  it("clicking the per-row Send button calls sendTransactionsToReview and surfaces an Undo toast", async () => {
    sendMutateAsync.mockResolvedValue({ updated: 1 });
    renderPage();

    const btn = await screen.findByTestId("button-send-review-txn-not-sent");
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(sendMutateAsync).toHaveBeenCalledTimes(1);
    expect(sendMutateAsync).toHaveBeenCalledWith({
      data: { transactionIds: ["txn-not-sent"] },
    });

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const toastArg = toastSpy.mock.calls[0]![0] as {
      title: string;
      action?: React.ReactElement;
    };
    expect(toastArg.title).toBe("Sent to Review");
    expect(toastArg.action).toBeTruthy();
  });

  it("clicking the '✓ in review' badge unsends the row", async () => {
    unsendMutateAsync.mockResolvedValue({ updated: 1 });
    renderPage();

    const badge = await screen.findByTestId("badge-in-review-txn-sent");
    await act(async () => {
      fireEvent.click(badge);
    });

    expect(unsendMutateAsync).toHaveBeenCalledTimes(1);
    expect(unsendMutateAsync).toHaveBeenCalledWith({
      data: { transactionIds: ["txn-sent"] },
    });
    await waitFor(() =>
      expect(toastSpy.mock.calls[0]![0].title).toBe("Removed from Review"),
    );
  });

  it("bulk Send-to-Review only sends rows that aren't already in review", async () => {
    sendMutateAsync.mockResolvedValue({ updated: 1 });
    renderPage();

    // Select both rows.
    await act(async () => {
      fireEvent.click(screen.getByTestId("select-txn-sent"));
      fireEvent.click(screen.getByTestId("select-txn-not-sent"));
    });

    const bulkBtn = await screen.findByTestId("bulk-send-review");
    // Label reports just the count that will actually be sent (1 of 2).
    expect(bulkBtn.textContent).toMatch(/Send 1 to Review/);

    await act(async () => {
      fireEvent.click(bulkBtn);
    });

    expect(sendMutateAsync).toHaveBeenCalledWith({
      data: { transactionIds: ["txn-not-sent"] },
    });
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const t = toastSpy.mock.calls[0]![0] as {
      title: string;
      action?: React.ReactElement;
    };
    expect(t.title).toMatch(/Sent 1 to Review/);
    // Undo affordance is wired (5-second Toaster TTL is owned by the
    // shared toaster, not this component, so we only assert presence).
    expect(t.action).toBeTruthy();
  });

  it("Undo on the toast issues the inverse mutation against the same ids", async () => {
    sendMutateAsync.mockResolvedValue({ updated: 1 });
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-send-review-txn-not-sent"));
    });

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const action = (
      toastSpy.mock.calls[0]![0] as { action: React.ReactElement }
    ).action;
    // Render the ToastAction in isolation so we can click it without
    // spinning up the full <Toaster /> portal.
    const { container } = render(<div>{action}</div>);
    const undoBtn = within(container).getByTestId(
      "action-undo-send-review-txn-not-sent",
    );
    await act(async () => {
      fireEvent.click(undoBtn);
    });
    expect(unsendMutate).toHaveBeenCalledTimes(1);
    expect(unsendMutate.mock.calls[0]![0]).toEqual({
      data: { transactionIds: ["txn-not-sent"] },
    });
  });
});
