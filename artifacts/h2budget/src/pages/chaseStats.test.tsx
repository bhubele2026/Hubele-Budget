import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi, describe } from "vitest";

/**
 * The Chase page's range stats: "Money in vs out" and "Checking balance".
 *
 * The page itself waits for its rows (it returns early until they arrive), so
 * these cards always sum loaded rows. What they must not do is claim "No
 * checking account linked" about a forecast bundle that has not answered, or
 * show a "0%" change against a start balance of $0, a percentage of nothing.
 * Setup mirrors `chaseBucketChip.test.tsx`.
 */

const state = vi.hoisted(() => ({
  rows: [] as any[],
  empty: [] as any[],
  forecast: undefined as unknown,
  forecastError: false,
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
    useListTransactions: () => ({
      data: state.rows,
      isLoading: false,
      refetch: vi.fn(),
    }),
    useListCategories: () => ({ data: state.empty }),
    useListMappingRules: () => ({ data: state.empty }),
    useListPlaidItems: () => ({ data: state.empty }),
    useGetForecast: () => ({ data: state.forecast, isError: state.forecastError }),
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
vi.mock("@/components/account-page/transaction-row", () => ({
  LEDGER_GRID: "",
  AccountTransactionRow: ({ tx, testId }: any) => (
    <div data-testid={testId}>{tx.description}</div>
  ),
}));
import TransactionsPage from "./transactions";

const pad = (n: number) => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const MONTH_START = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;

/** A typed-in balance with no Plaid account: the page's "manual" account. */
const LINKED_FORECAST = {
  bankSnapshot: {
    balance: "1000",
    at: `${MONTH_START}T06:00:00.000Z`,
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
  amount: "-40",
  source: "manual",
  categoryId: "cat-1",
  forecastFlag: false,
  pending: false,
  reviewed: false,
};

let qc: QueryClient;
function show() {
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage />
    </QueryClientProvider>,
  );
}
const text = (id: string) => screen.getByTestId(id).textContent ?? "";

beforeEach(() => {
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.rows = [];
  state.forecast = undefined;
  state.forecastError = false;
});
afterEach(() => {
  cleanup();
  qc.clear();
});

describe("Chase stats — 'No checking account linked' waits for the forecast bundle", () => {
  it("says it is loading the account while the bundle has not answered", () => {
    show();
    expect(text("chase-stats-no-account")).toContain("Loading checking account…");
    expect(text("chase-stats-no-account")).not.toContain("No checking account linked");
  });

  it("says it couldn't load the account when the bundle failed", () => {
    state.forecastError = true;
    show();
    expect(text("chase-stats-no-account")).toContain("Couldn't load checking account.");
  });

  it("says no account is linked once the bundle answers without one", () => {
    state.forecast = { ...LINKED_FORECAST, bankSnapshot: null };
    show();
    expect(text("chase-stats-no-account")).toContain("No checking account linked.");
  });
});

describe("Chase stats — the change states a percentage only when there is one", () => {
  it("with a $0 start balance: the change reads a dash, not a percentage", () => {
    state.forecast = {
      ...LINKED_FORECAST,
      bankSnapshot: { ...LINKED_FORECAST.bankSnapshot, balance: "0" },
    };
    state.rows = [todayRow];
    show();
    const inOut = text("chase-stats-in-out");
    expect(inOut).toContain("$40.00");
    // The In/Out legend carries its own "100%" share; the Change row must not.
    expect(inOut).toContain("Change—");
  });

  it("with a real start balance: the change pill and every balance", () => {
    state.forecast = LINKED_FORECAST;
    state.rows = [todayRow];
    show();
    const inOut = text("chase-stats-in-out");
    expect(inOut).not.toContain("Change—");
    expect(inOut).toMatch(/Change[^O]*%/);
    expect(text("chase-stats-balance")).toContain("$");
    expect(text("chase-stats-balance")).not.toContain("—");
  });
});
