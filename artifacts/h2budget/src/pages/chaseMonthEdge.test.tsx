import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerOptions,
  type FakeLedgerServer,
} from "./__test-helpers__/fakeLedgerServer";

/**
 * (PR14 third review) Month mode on the HOUSEHOLD calendar, at a month edge.
 *
 * The clock is pinned to 2026-10-01T02:00Z: October 1 in UTC and in the browser
 * of anyone east of Chicago, but still Wednesday September 30 in Chicago, the
 * household's day. Main's `currentMonthRange(ref)` reads `ref` as an instant, so
 * a browser-local midnight on the 1st is still the previous month in Chicago for
 * a UTC or Eastern browser, and `monthKeyOf(new Date())` is the browser's month.
 * Run the suite under TZ=UTC, America/New_York, America/Chicago and
 * America/Los_Angeles: every assertion must hold in all four.
 */

const state = vi.hoisted(() => ({
  empty: [] as any[],
  toast: vi.fn(),
  forecast: undefined as unknown,
}));

vi.mock("@workspace/api-client-react", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const real = new Set(["useBulkUpdateTransactions"]);
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
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@/hooks/useReviewInboxCount", () => ({ useReviewInboxCount: () => 0 }));
vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({ offerBulkRecategorize: vi.fn(), previewDialog: null }),
}));
vi.mock("@/lib/useRuleActionUndo", () => ({ useRuleActionUndo: () => vi.fn() }));
vi.mock("@/components/plaid-reauth-banner", () => ({ PlaidReauthBanner: () => null }));
vi.mock("@/components/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/plaid-link-button", () => ({ PlaidLinkButton: () => null }));
vi.mock("@/components/post-link-progress", () => ({ PostLinkProgressBanner: () => null }));
vi.mock("@/components/chase-insight-strip", () => ({ ChaseInsightStrip: () => null }));
vi.mock("@/components/account-page/balance-trend-chart", () => ({ BalanceTrendChart: () => null }));
vi.mock("./transactions/InlineAmountEditor", () => ({
  InlineAmountEditor: ({ tx }: any) => <span>{tx.amount}</span>,
}));
vi.mock("@/components/account-page/transaction-row", () => ({
  LEDGER_GRID: "",
  AccountTransactionRow: ({ tx, testId }: any) => <div data-testid={testId}>{tx.description}</div>,
}));
import TransactionsPage from "./transactions";

vi.useFakeTimers({ toFake: ["Date"] });
// October 1 at 02:00 UTC: September 30, 21:00 in Chicago.
vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 2, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});

const ROWS = [
  { id: "sep30", occurredOn: "2026-09-30", description: "LAST DAY OF SEPTEMBER" },
  { id: "sep01", occurredOn: "2026-09-01", description: "FIRST DAY OF SEPTEMBER" },
  { id: "aug31", occurredOn: "2026-08-31", description: "LAST DAY OF AUGUST" },
];

let qc: QueryClient;
let server: FakeLedgerServer;
function serve(opts: FakeLedgerOptions) {
  server = createFakeLedgerServer({ today: "2026-09-30", ...opts });
  vi.stubGlobal("fetch", server.fetch);
}
function show() {
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage />
    </QueryClientProvider>,
  );
}
/**
 * Register requests: the list's own, which run through the household's today.
 * Not the pending list (`pending`), the after-today list (`to` after today, e.g.
 * the week's 10-01..10-03), or the posted count (`limit=1`).
 */
const registerGets = () =>
  server
    .ledgerGets()
    .filter(
      (c) =>
        c.query.get("pending") === null &&
        c.query.get("limit") === "50" &&
        (c.query.get("to") ?? "") <= "2026-09-30",
    );

beforeEach(() => {
  localStorage.clear();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, placeholderData: keepPreviousData } },
  });
  state.forecast = { bankSnapshot: null, accountSnapshots: {}, resolutions: [], plaidCheckingAccounts: [], today: "2026-09-30" };
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

describe("(PR14 third review) Month mode on the household calendar, at a month edge", () => {
  it("a ?month= link (the Budget page's) opens that month: September's rows, range and label, never August's", async () => {
    window.history.replaceState(null, "", "/transactions?month=2026-09-01");
    serve({ rows: ROWS });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-sep30")).toBeTruthy());
    const first = registerGets()[0]!.query;
    expect(first.get("from")).toBe("2026-09-01");
    // Through the household's today, September 30.
    expect(first.get("to")).toBe("2026-09-30");
    expect(registerGets().some((c) => c.query.get("from") === "2026-08-01")).toBe(false);
    expect(screen.getByTestId("row-tx-sep01")).toBeTruthy();
    expect(screen.queryByTestId("row-tx-aug31")).toBeNull();
    expect(screen.getByText("September 2026")).toBeTruthy();
    expect(screen.getByText("Sep '26")).toBeTruthy();
  });

  it("the navigator's own month is the household's month (September), not the browser's (October)", async () => {
    window.history.replaceState(null, "", "/transactions");
    serve({ rows: ROWS });
    show();
    // Wait for the first page: the toggle is not rendered while the page loads.
    await waitFor(() => expect(screen.getByTestId("row-tx-sep30")).toBeTruthy());
    // Week mode: the household's Sun–Sat week around September 30.
    expect(registerGets()[0]!.query.get("from")).toBe("2026-09-27");
    fireEvent.click(screen.getByTestId("range-mo"));
    await waitFor(() =>
      expect(registerGets().some((c) => c.query.get("from") === "2026-09-01")).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("row-tx-sep01")).toBeTruthy());
    expect(screen.getByText("Sep '26")).toBeTruthy();
    expect(screen.getByText("September 2026")).toBeTruthy();
    for (const from of ["2026-08-01", "2026-10-01"]) {
      expect(registerGets().some((c) => c.query.get("from") === from), from).toBe(false);
    }
  });
});
