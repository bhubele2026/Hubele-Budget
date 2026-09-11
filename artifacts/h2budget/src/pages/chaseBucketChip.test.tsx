import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi } from "vitest";

/**
 * The Chase page's Review chip. "All reconciled" is a claim, so it may only be
 * made on a real zero. While the review count is unknown (the spine is loading
 * or failed, so `useReviewInboxCount` returns null) the chip claims nothing.
 * Setup mirrors `chaseReviewed.test.tsx`.
 */

const state = vi.hoisted(() => ({
  rows: [] as any[],
  empty: [] as any[],
  reviewCount: 0 as number | null,
  forecast: { bankSnapshot: null, resolutions: [], plaidCheckingAccounts: [] },
}));
vi.mock("@workspace/api-client-react", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const hooks = Object.fromEntries(
    Object.keys(actual)
      .filter((k) => /^use[A-Z]/.test(k))
      .map((k) => [
        k,
        () => ({
          data: undefined,
          isLoading: false,
          isPending: false,
          mutate: vi.fn(),
          mutateAsync: vi.fn(),
        }),
      ]),
  );
  return {
    ...actual,
    ...hooks,
    useListTransactions: () => ({ data: state.rows, isLoading: false }),
    useListCategories: () => ({ data: state.empty }),
    useListMappingRules: () => ({ data: state.empty }),
    useListPlaidItems: () => ({ data: state.empty }),
    useGetForecast: () => ({ data: state.forecast }),
  };
});
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <a>{children}</a>,
  useLocation: () => ["/transactions", vi.fn()],
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/hooks/useReviewInboxCount", () => ({
  useReviewInboxCount: () => state.reviewCount,
}));
vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({
    offerBulkRecategorize: vi.fn(),
    previewDialog: null,
  }),
}));
vi.mock("@/lib/useRuleActionUndo", () => ({
  useRuleActionUndo: () => vi.fn(),
}));
vi.mock("@/components/plaid-reauth-banner", () => ({
  PlaidReauthBanner: () => null,
}));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));
vi.mock("@/components/post-link-progress", () => ({
  PostLinkProgressBanner: () => null,
}));
vi.mock("@/components/chase-insight-strip", () => ({
  ChaseInsightStrip: () => null,
}));
vi.mock("@/components/account-page/transaction-row", () => ({
  LEDGER_GRID: "",
  AccountTransactionRow: ({ tx, testId }: any) => (
    <div data-testid={testId}>{tx.description}</div>
  ),
}));
import TransactionsPage from "./transactions";

let qc: QueryClient;
function show() {
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.reviewCount = 0;
  state.rows = [];
});
afterEach(() => {
  cleanup();
  qc.clear();
});

it("says All reconciled when the review count is a real zero", () => {
  state.reviewCount = 0;
  show();
  expect(screen.getByTestId("text-bucket-empty").textContent).toContain("All reconciled");
});

it("claims nothing while the review count is unknown", () => {
  // (PR3b1) The hook used to return 0 here, so the page said "All reconciled"
  // while the spine was still loading or had failed.
  state.reviewCount = null;
  show();
  expect(screen.queryByTestId("text-bucket-empty")).toBeNull();
  expect(screen.getByTestId("chase-bucket-summary").textContent).toBe("");
});

it("offers the match link, with the count, when there is work to review", () => {
  state.reviewCount = 3;
  show();
  expect(screen.queryByTestId("text-bucket-empty")).toBeNull();
  expect(screen.getByTestId("chase-bucket-summary").textContent).toContain(
    "Match 3 items in Review",
  );
});
