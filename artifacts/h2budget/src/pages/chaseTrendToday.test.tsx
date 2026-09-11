import React from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerServer,
} from "./__test-helpers__/fakeLedgerServer";

/**
 * The Chase page's balance trend chart and its cash-signal projection start on the
 * HOUSEHOLD day, never the browser's.
 *
 * Two instants, both still Wednesday September 30 in Chicago, the household's day:
 * - 2026-10-01T02:00Z: October 1 in UTC (21:00 in Chicago, 22:00 in New York);
 * - 2026-10-01T04:30Z: October 1 in New York too (00:30 there, 23:30 in Chicago).
 * The chart's "today" point, its forecast seed, its axis and the projection's
 * `fromDate` were a browser-local date, so they sat on October 1 for a browser east
 * of Chicago late in the Chicago evening. Run under TZ=UTC, America/Chicago,
 * America/New_York and America/Los_Angeles: every assertion must hold in all four
 * (CI runs all four).
 */

const state = vi.hoisted(() => ({
  empty: [] as any[],
  forecast: undefined as unknown,
  cashSignalParams: [] as unknown[],
  chartProps: [] as any[],
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
    useGetForecastCashSignal: (params: unknown) => {
      state.cashSignalParams.push(params);
      return {
        data: {
          daily: [
            { date: "2026-10-03", balance: "900.00" },
            { date: "2026-10-10", balance: "850.00" },
          ],
        },
      };
    },
  };
});
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <a>{children}</a>,
  useLocation: () => ["/transactions", vi.fn()],
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
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
vi.mock("@/components/account-page/balance-trend-chart", () => ({
  BalanceTrendChart: (props: any) => {
    state.chartProps.push(props);
    return <div data-testid="balance-trend-chart" />;
  },
}));
vi.mock("./transactions/InlineAmountEditor", () => ({
  InlineAmountEditor: ({ tx }: any) => <span>{tx.amount}</span>,
}));
vi.mock("@/components/account-page/transaction-row", () => ({
  LEDGER_GRID: "",
  AccountTransactionRow: ({ tx, testId }: any) => <div data-testid={testId}>{tx.description}</div>,
}));
import TransactionsPage from "./transactions";

vi.useFakeTimers({ toFake: ["Date"] });
afterAll(() => {
  vi.useRealTimers();
});

const HOUSEHOLD_TODAY = "2026-09-30";

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
  today: HOUSEHOLD_TODAY,
};

let qc: QueryClient;
let server: FakeLedgerServer;

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/transactions");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.forecast = LINKED_FORECAST;
  state.cashSignalParams = [];
  state.chartProps = [];
  server = createFakeLedgerServer({
    today: HOUSEHOLD_TODAY,
    rows: [{ id: "sep30", occurredOn: HOUSEHOLD_TODAY, description: "LAST DAY OF SEPTEMBER" }],
    balanceStart: "1040.00",
    balanceEnd: "1000.00",
    balanceToday: "1000.00",
    balanceByDate: { "2026-09-26": "1040.00" },
  });
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

describe.each([
  ["2026-10-01T02:00:00Z", "October 1 in UTC, 21:00 in Chicago"],
  ["2026-10-01T04:30:00Z", "October 1 in New York, 23:30 in Chicago"],
])("Chase balance trend: 'today' is the household day at %s (%s)", (instant) => {
  beforeEach(() => {
    vi.setSystemTime(new Date(instant));
  });

  it("the cash-signal projection starts on September 30, not the browser's October 1", () => {
    render(
      <QueryClientProvider client={qc}>
        <TransactionsPage />
      </QueryClientProvider>,
    );
    expect(state.cashSignalParams.length).toBeGreaterThan(0);
    for (const p of state.cashSignalParams) {
      expect(p).toEqual({ horizonDays: 365, fromDate: HOUSEHOLD_TODAY });
    }
  });

  it("the chart's today point, forecast seed and axis start on September 30", async () => {
    render(
      <QueryClientProvider client={qc}>
        <TransactionsPage />
      </QueryClientProvider>,
    );
    // The chart renders once the register's today balance is in.
    await waitFor(() =>
      expect(state.chartProps.some((p) => p.actualFromToday.length > 0)).toBe(true),
    );
    const props = state.chartProps.filter((p) => p.actualFromToday.length > 0).at(-1);
    expect(props.todayISO).toBe(HOUSEHOLD_TODAY);
    expect(props.axisDates[0]).toBe(HOUSEHOLD_TODAY);
    expect(props.actualFromToday).toEqual([{ date: HOUSEHOLD_TODAY, balance: 1000 }]);
    expect(props.forecastFromToday).toEqual([
      { date: HOUSEHOLD_TODAY, balance: 1000 },
      { date: "2026-10-03", balance: 900 },
      { date: "2026-10-10", balance: 850 },
    ]);
    // The week-ending Saturday before today is history, drawn from the ledger.
    expect(props.historicalActual.at(-1)).toEqual({ date: "2026-09-26", balance: 1040 });
    for (const p of state.chartProps) {
      expect(p.todayISO).toBe(HOUSEHOLD_TODAY);
      expect(p.axisDates).not.toContain("2026-10-01");
    }
  });
});
