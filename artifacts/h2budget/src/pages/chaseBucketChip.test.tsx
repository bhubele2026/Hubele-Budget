import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerOptions,
  type FakeLedgerServer,
} from "./__test-helpers__/fakeLedgerServer";

/**
 * The Chase page's Review chip. "All reconciled" is a claim, so it may only be
 * made on a real zero. While the review count is unknown (the spine is loading
 * or failed, so `useReviewInboxCount` returns null) the chip claims nothing.
 *
 * (PR14) The page reads the server's ledger: the six ledger / review /
 * preference hooks are the real generated hooks, answered by
 * `fakeLedgerServer.ts`, and the page shows a skeleton until the register's
 * first page arrives. Setup mirrors `chaseReviewInbox.test.tsx`.
 */

const state = vi.hoisted(() => ({
  empty: [] as any[],
  reviewCount: 0 as number | null,
  listTransactions: vi.fn(),
  forecast: { bankSnapshot: null, resolutions: [], plaidCheckingAccounts: [] },
}));
vi.mock("@workspace/api-client-react", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const real = new Set([
    "useGetTransactionsLedgerInfinite",
    "useGetTransactionsBalances",
    "useBulkUpdateTransactions",
    "useBulkReviewMatchingTransactions",
    "useGetUiPreferences",
    "useUpdateUiPreferences",
  ]);
  const hooks = Object.fromEntries(
    Object.keys(actual)
      .filter((k) => /^use[A-Z]/.test(k) && !real.has(k))
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
    // The old 1,000-row pull. The Chase view must never call it.
    useListTransactions: (...args: unknown[]) => {
      state.listTransactions(...args);
      return { data: [], isLoading: false, refetch: vi.fn() };
    },
    useListCategories: () => ({ data: state.empty }),
    useListMappingRules: () => ({ data: state.empty }),
    useListPlaidItems: () => ({ data: state.empty }),
    useGetForecast: () => ({ data: state.forecast }),
    useGetSpine: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() }),
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

// Wednesday 2026-09-16 (07:00 in Chicago): this week is Sun 09-13 – Sat 09-19.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});

let qc: QueryClient;
let server: FakeLedgerServer;
function serve(opts: FakeLedgerOptions): FakeLedgerServer {
  server = createFakeLedgerServer(opts);
  vi.stubGlobal("fetch", server.fetch);
  return server;
}
function show() {
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/transactions");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.reviewCount = 0;
  state.listTransactions.mockReset();
  serve({ rows: [] });
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

it("says All reconciled when the review count is a real zero", async () => {
  state.reviewCount = 0;
  show();
  expect((await screen.findByTestId("text-bucket-empty")).textContent).toContain("All reconciled");
  // The chip never leans on the old 1,000-row list.
  expect(state.listTransactions).not.toHaveBeenCalled();
  expect(server.calls.some((c) => c.path === "/api/transactions")).toBe(false);
});

it("claims nothing while the review count is unknown", async () => {
  // (PR3b1) The hook used to return 0 here, so the page said "All reconciled"
  // while the spine was still loading or had failed.
  state.reviewCount = null;
  show();
  const summary = await screen.findByTestId("chase-bucket-summary");
  expect(screen.queryByTestId("text-bucket-empty")).toBeNull();
  expect(summary.textContent).toBe("");
});

it("offers the match link, with the count, when there is work to review", async () => {
  state.reviewCount = 3;
  show();
  const summary = await screen.findByTestId("chase-bucket-summary");
  expect(screen.queryByTestId("text-bucket-empty")).toBeNull();
  expect(summary.textContent).toContain("Match 3 items in Review");
});
