import React from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerOptions,
  type FakeLedgerServer,
  type FakeRowInput,
} from "./__test-helpers__/fakeLedgerServer";
import { toastTexts } from "./__test-helpers__/toastText";

/**
 * The Chase list's reviewed state. (PR14) On the server's ledger: "Clear
 * reviewed from list" re-asks with `reviewed=false` and saves the preference;
 * "Mark reviewed" POSTs /api/transactions/bulk-update with only `reviewed`.
 * The ledger, balances, bulk-review and UI-preference hooks are the real
 * generated hooks, answered by `fakeLedgerServer.ts`. Setup mirrors
 * `chaseReviewInbox.test.tsx`.
 */

const state = vi.hoisted(() => ({
  empty: [] as any[],
  toast: vi.fn(),
  listTransactions: vi.fn(),
  updateAsync: vi.fn(async () => ({ ruleAction: null, repointedRules: [] })),
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
    useUpdateTransaction: () => ({ mutate: vi.fn(), mutateAsync: state.updateAsync, isPending: false }),
    useListCategories: () => ({ data: state.empty }),
    useListMappingRules: () => ({ data: state.empty }),
    useListPlaidItems: () => ({ data: state.empty }),
    useGetForecast: () => ({ data: state.forecast }),
    useGetSpine: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() }),
  };
});
vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: any) => <a href={href} data-testid={rest["data-testid"]}>{children}</a>,
  useLocation: () => ["/transactions", vi.fn()],
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: state.toast }),
}));
vi.mock("@/hooks/useReviewInboxCount", () => ({
  useReviewInboxCount: () => 2,
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
  AccountTransactionRow: ({ tx, selected, onToggleSelect, actionsNode, testId, onCategoryChange }: any) => (
    <div data-testid={testId} data-selected={selected ? "true" : "false"}>
      {tx.description}
      <button onClick={onToggleSelect}>Select {tx.id}</button>
      <button onClick={() => onCategoryChange("cat-1", "STARBUCKS")}>Pick {tx.id}</button>
      {actionsNode}
    </div>
  ),
}));
import TransactionsPage from "./transactions";

// Wednesday 2026-09-16 (07:00 in Chicago): this week is Sun 09-13 – Sat 09-19.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});

const TODAY = "2026-09-16";
const REGISTER_FROM = "2026-09-13";

/** "done" is already reviewed, "todo" is not; both posted today. */
function rows(overrides: Partial<FakeRowInput> = {}): FakeRowInput[] {
  return [
    { id: "done", reviewed: true },
    { id: "todo", reviewed: false },
  ].map((r) => ({
    occurredOn: TODAY,
    description: r.id,
    amount: "-10.00",
    ...r,
    ...overrides,
  }));
}

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
const reviewWrites = () =>
  server.calls.filter(
    (c) =>
      c.method === "POST" &&
      (c.path === "/api/transactions/bulk-update" ||
        c.path === "/api/transactions/bulk-review-matching"),
  );

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/transactions");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.toast.mockReset();
  state.listTransactions.mockReset();
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});


it("sends the picker's Remember pattern on the row category PATCH (D5)", async () => {
  serve({ rows: rows() });
  show();
  fireEvent.click(await screen.findByText("Pick todo"));
  await waitFor(() => expect(state.updateAsync).toHaveBeenCalled());
  expect(state.updateAsync).toHaveBeenCalledWith({
    id: "todo",
    data: { categoryId: "cat-1", rememberPattern: "STARBUCKS" },
  });
});

it("links the Review bucket chip to /review, not a dead hash (D6)", async () => {
  serve({ rows: rows() });
  show();
  const link = await screen.findByTestId("link-bucket-pending-count");
  expect(link.getAttribute("href")).toBe("/review");
});
