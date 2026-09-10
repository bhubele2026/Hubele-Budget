import React from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  rows: [] as any[],
  empty: [] as any[],
  mutate: vi.fn(),
  toast: vi.fn(),
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
    useBulkUpdateTransactions: () => ({
      mutateAsync: state.mutate,
      isPending: false,
    }),
  };
});
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <a>{children}</a>,
  useLocation: () => ["/transactions", vi.fn()],
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: state.toast }),
}));
vi.mock("@/hooks/useReviewInboxCount", () => ({
  useReviewInboxCount: () => 0,
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
  AccountTransactionRow: ({ tx, onToggleSelect, actionsNode, testId }: any) => (
    <div data-testid={testId}>
      {tx.description}
      <button onClick={onToggleSelect}>Select {tx.id}</button>
      {actionsNode}
    </div>
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
  state.toast.mockReset();
  state.mutate.mockReset();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  state.rows = [
    { id: "done", reviewed: true },
    { id: "todo", reviewed: false },
  ].map((row) => ({
    occurredOn: date,
    description: row.id,
    amount: "-10",
    source: "manual",
    forecastFlag: false,
    pending: false,
    ...row,
  }));
  state.mutate.mockImplementation(async ({ data }: any) => ({
    results: data.ids.map((id: string) => ({ id, ok: true })),
    updated: data.ids.length,
    affectedMonths: [],
  }));
});
afterEach(() => {
  cleanup();
  qc.clear();
});
it("clears reviewed rows from view, restores them, and remembers the preference", () => {
  show();
  fireEvent.click(screen.getByText("Clear reviewed from list"));
  expect(screen.queryByTestId("row-tx-done")).toBeNull();
  expect(screen.getByTestId("row-tx-todo")).toBeTruthy();
  expect(state.mutate).not.toHaveBeenCalled();
  expect(localStorage.getItem("h2-chase-hide-reviewed")).toBe("true");
  fireEvent.click(screen.getByText("Show reviewed"));
  expect(screen.getByTestId("row-tx-done")).toBeTruthy();
});
it("marks a row reviewed using only the review field", async () => {
  show();
  fireEvent.click(screen.getByText("Mark reviewed"));
  await waitFor(() =>
    expect(state.mutate).toHaveBeenCalledWith({
      data: { ids: ["todo"], patch: { reviewed: true } },
    }),
  );
  await waitFor(() => expect(state.toast).toHaveBeenCalled());
});
it("retains failed rows and reports partial review saves", async () => {
  state.rows = state.rows.map((t) => ({ ...t, reviewed: false }));
  state.mutate.mockResolvedValue({
    results: [
      { id: "done", ok: true },
      { id: "todo", ok: false, error: "retry" },
    ],
    updated: 1,
    affectedMonths: [],
  });
  show();
  fireEvent.click(screen.getByText("Select done"));
  fireEvent.click(screen.getByText("Select todo"));
  fireEvent.click(screen.getAllByText("Mark reviewed")[0]);
  await waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "1 marked reviewed, 1 failed" }),
    ),
  );
  expect(screen.getByText("1 selected")).toBeTruthy();
});
