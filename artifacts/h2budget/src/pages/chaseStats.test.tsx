import React from "react";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, afterAll, it, expect, vi, describe } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerOptions,
  type FakeLedgerServer,
} from "./__test-helpers__/fakeLedgerServer";

/**
 * The Chase page's range stats: "Money in vs out" and "Checking balance".
 *
 * (PR14) The cards read the server's ledger: money in/out from the register's
 * `totals`, the start and end balance from `balanceStart` / `balanceEnd`. The
 * page shows a skeleton until the register's first page arrives. What the cards
 * must not do is claim "No checking account linked" about a forecast bundle
 * that has not answered, show a "0%" change against a start balance of $0 (a
 * percentage of nothing), or dress a balance the server does not have as $0.00.
 *
 * The ledger, balances, bulk-review and UI-preference hooks are the real
 * generated hooks, answered by `fakeLedgerServer.ts`. Setup mirrors
 * `chaseReviewInbox.test.tsx`.
 */

const state = vi.hoisted(() => ({
  empty: [] as any[],
  listTransactions: vi.fn(),
  forecast: undefined as unknown,
  forecastError: false,
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
    useGetForecast: () => ({ data: state.forecast, isError: state.forecastError }),
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
vi.mock("@/components/account-page/balance-trend-chart", () => ({
  BalanceTrendChart: () => null,
}));
vi.mock("@/components/account-page/transaction-row", () => ({
  LEDGER_GRID: "",
  AccountTransactionRow: ({ tx, testId }: any) => (
    <div data-testid={testId}>{tx.description}</div>
  ),
}));
import TransactionsPage from "./transactions";

// Wednesday 2026-09-16 (07:00 in Chicago): this week is Sun 09-13 – Sat 09-19,
// and the register asks 09-13..09-16.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});

const TODAY = "2026-09-16";

/** A typed-in balance with no Plaid account: the page's "manual" account. */
const LINKED_FORECAST = {
  bankSnapshot: {
    balance: "1000",
    at: "2026-09-01T06:00:00.000Z",
    source: "manual",
    accountId: null,
    name: "Checking",
    mask: null,
  },
  accountSnapshots: {},
  resolutions: [],
  plaidCheckingAccounts: [],
  today: TODAY,
};

const todayRow = {
  id: "t1",
  occurredOn: TODAY,
  description: "Groceries",
  amount: "-40.00",
  categoryId: "cat-1",
};

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
const text = (id: string) => screen.getByTestId(id).textContent ?? "";
/** The "Change" label's own row: its pill or dash, never the In/Out legend. */
const changeRow = () =>
  within(screen.getByTestId("chase-stats-in-out")).getByText("Change")
    .parentElement as HTMLElement;
/** The stats cards render once the register's first page is in. */
async function statsReady() {
  await waitFor(() => expect(screen.getByTestId("chase-stats-in-out")).toBeTruthy());
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/transactions");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.listTransactions.mockReset();
  state.forecast = undefined;
  state.forecastError = false;
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

describe("Chase stats — 'No checking account linked' waits for the forecast bundle", () => {
  it("says it is loading the account while the bundle has not answered", async () => {
    serve({ rows: [] });
    show();
    const card = await screen.findByTestId("chase-stats-no-account");
    expect(card.textContent).toContain("Loading checking account…");
    expect(card.textContent).not.toContain("No checking account linked");
  });

  it("says it couldn't load the account when the bundle failed", async () => {
    state.forecastError = true;
    serve({ rows: [] });
    show();
    const card = await screen.findByTestId("chase-stats-no-account");
    expect(card.textContent).toContain("Couldn't load checking account.");
  });

  it("says no account is linked once the bundle answers without one", async () => {
    state.forecast = { ...LINKED_FORECAST, bankSnapshot: null };
    serve({ rows: [] });
    show();
    const card = await screen.findByTestId("chase-stats-no-account");
    expect(card.textContent).toContain("No checking account linked.");
  });
});

describe("Chase stats — the change states a percentage only when there is one", () => {
  it("with a $0 start balance: the change reads a dash, not a percentage", async () => {
    state.forecast = LINKED_FORECAST;
    serve({ rows: [todayRow], balanceStart: "0.00", balanceEnd: "-40.00" });
    show();
    await statsReady();
    expect(text("chase-stats-in-out")).toContain("$40.00");
    expect(changeRow().textContent).toBe("Change—");
    // The stats never lean on the old 1,000-row list.
    expect(state.listTransactions).not.toHaveBeenCalled();
    expect(server.calls.some((c) => c.path === "/api/transactions")).toBe(false);
  });

  it("with no start balance from the server: a dash for the change, and '—' (never $0.00) for the balance", async () => {
    // Replaces the old floating-point case (0.30 − 0.10 − 0.20 ≈ −2.8e-17):
    // the server sends cents strings, so a hair-off-zero start can no longer
    // arise. A start the server does not have is the case left to guard.
    state.forecast = LINKED_FORECAST;
    serve({ rows: [todayRow], balanceStart: null, balanceEnd: null });
    show();
    await statsReady();
    expect(changeRow().textContent).toBe("Change—");
    expect(text("chase-stats-in-out")).toContain("$40.00");
    const balance = text("chase-stats-balance");
    expect(balance).toContain("—");
    expect(balance).not.toContain("$0.00");
    expect(balance).not.toMatch(/\$\d/);
  });

  it("with a real start balance: the change pill and every balance", async () => {
    state.forecast = LINKED_FORECAST;
    serve({ rows: [todayRow], balanceStart: "1000.00", balanceEnd: "960.00" });
    show();
    await statsReady();
    expect(changeRow().textContent).toMatch(/^Change.*\d%$/);
    expect(changeRow().textContent).not.toContain("—");
    expect(text("chase-stats-in-out")).toContain("$40.00");
    expect(text("chase-stats-balance")).toContain("$");
    expect(text("chase-stats-balance")).not.toContain("—");
    // The server's balances, as sent.
    expect(text("chase-stats-balance")).toContain("$1,000.00");
    expect(text("chase-stats-balance")).toContain("$960.00");
  });
});
