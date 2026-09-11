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
  AccountTransactionRow: ({ tx, selected, onToggleSelect, actionsNode, testId }: any) => (
    <div data-testid={testId} data-selected={selected ? "true" : "false"}>
      {tx.description}
      <button onClick={onToggleSelect}>Select {tx.id}</button>
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

it("clears reviewed rows from view, restores them, and remembers the preference", async () => {
  serve({ rows: rows() });
  show();
  await screen.findByTestId("row-tx-done");
  expect(screen.getByTestId("row-tx-todo")).toBeTruthy();

  fireEvent.click(screen.getByText("Clear reviewed from list"));
  await waitFor(() => expect(screen.queryByTestId("row-tx-done")).toBeNull());
  await screen.findByTestId("row-tx-todo");
  // The list re-asks the server for unreviewed rows only.
  expect(server.ledgerGets(REGISTER_FROM).at(-1)!.query.get("reviewed")).toBe("false");
  // Clearing is a view: no review is written, and no row changes.
  expect(reviewWrites()).toHaveLength(0);
  expect(server.rows.map((r) => [r.id, r.reviewed])).toEqual([
    ["done", true],
    ["todo", false],
  ]);
  // Remembered: the first-paint seed and the per-user preference.
  expect(localStorage.getItem("h2-chase-hide-reviewed")).toBe("true");
  await waitFor(() =>
    expect(
      server.calls.find((c) => c.path === "/api/me/ui-preferences" && c.method === "PUT")?.body,
    ).toEqual({ chaseHideReviewed: true }),
  );

  fireEvent.click(await screen.findByText("Show reviewed"));
  await screen.findByTestId("row-tx-done");
  expect(screen.getByTestId("row-tx-todo")).toBeTruthy();
  expect(reviewWrites()).toHaveLength(0);
  // Never the old 1,000-row list.
  expect(state.listTransactions).not.toHaveBeenCalled();
  expect(server.calls.some((c) => c.path === "/api/transactions")).toBe(false);
});

it("marks a row reviewed using only the review field", async () => {
  serve({ rows: rows() });
  show();
  fireEvent.click(await screen.findByText("Mark reviewed"));
  await waitFor(() => expect(reviewWrites()).toHaveLength(1));
  const write = reviewWrites()[0]!;
  expect(write.path).toBe("/api/transactions/bulk-update");
  expect(write.body).toEqual({ ids: ["todo"], patch: { reviewed: true } });
  await waitFor(() => expect(state.toast).toHaveBeenCalled());
  // That one request is the only write the click made.
  expect(server.calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  expect(server.rows.map((r) => [r.id, r.reviewed])).toEqual([
    ["done", true],
    ["todo", true],
  ]);
});

it("retains failed rows and reports partial review saves", async () => {
  serve({ rows: rows({ reviewed: false }), failReviewIds: ["todo"] });
  show();
  fireEvent.click(await screen.findByText("Select done"));
  fireEvent.click(screen.getByText("Select todo"));
  fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
  await waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "1 marked reviewed, 1 failed" }),
    ),
  );
  expect(screen.getByText("1 selected")).toBeTruthy();
  // The failed row is the one left selected.
  expect(screen.getByTestId("row-tx-todo").getAttribute("data-selected")).toBe("true");
  expect(screen.getByTestId("row-tx-done").getAttribute("data-selected")).toBe("false");
  // One request for both ids, writing only `reviewed`.
  expect(reviewWrites()).toHaveLength(1);
  const body = reviewWrites()[0]!.body;
  expect(Object.keys(body).sort()).toEqual(["ids", "patch"]);
  expect([...body.ids].sort()).toEqual(["done", "todo"]);
  expect(body.patch).toEqual({ reviewed: true });
  expect(server.rows.map((r) => [r.id, r.reviewed])).toEqual([
    ["done", true],
    ["todo", false],
  ]);
});
