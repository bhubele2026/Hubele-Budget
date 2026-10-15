import React from "react";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerOptions,
  type FakeLedgerServer,
} from "./__test-helpers__/fakeLedgerServer";

/**
 * (Q4) The Chase page's account is URL state, and another account's rows are
 * never listed under this account's name.
 *
 *   - Picking an account pushes ONE history entry; Back restores the account
 *     before it (its rows and its `?account=`), Forward returns.
 *   - While the picked account's answer is out, the previous account's rows are
 *     not on screen: the list says it is loading.
 * The ledger hooks are the REAL generated hooks over the fetch-level fake. The
 * clock is Wednesday 2026-09-16.
 */

const state = vi.hoisted(() => ({
  empty: [] as any[],
  toast: vi.fn(),
  navigate: vi.fn(),
  forecast: undefined as unknown,
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
        () => ({ data: undefined, isLoading: false, isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() }),
      ]),
  );
  return {
    ...actual,
    ...hooks,
    useListTransactions: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
    useListCategories: () => ({ data: state.empty }),
    useListMappingRules: () => ({ data: state.empty }),
    useListPlaidItems: () => ({ data: state.empty }),
    useGetForecast: () => ({ data: state.forecast }),
    useGetSpine: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() }),
    useGetForecastCashSignal: () => ({ data: undefined }),
  };
});
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <a>{children}</a>,
  useLocation: () => ["/next/accounts/x", state.navigate],
}));
// Radix's Select cannot open in jsdom: a plain stand-in keeps the page's own
// `onValueChange` and options under test.
vi.mock("@/components/ui/select", async () => {
  const R = await import("react");
  const Ctx = R.createContext<{ onValueChange?: (v: string) => void } | null>(null);
  return {
    Select: ({ onValueChange, children }: any) => <Ctx.Provider value={{ onValueChange }}>{children}</Ctx.Provider>,
    SelectTrigger: ({ children, ...p }: any) => <div data-testid={p["data-testid"]}>{children}</div>,
    SelectValue: () => null,
    SelectContent: ({ children, ...p }: any) => <div data-testid={p["data-testid"]}>{children}</div>,
    SelectItem: ({ value, children, ...p }: any) => {
      const c = R.useContext(Ctx);
      return (
        <button type="button" data-testid={p["data-testid"]} onClick={() => c?.onValueChange?.(value)}>
          {children}
        </button>
      );
    },
  };
});
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
vi.mock("@/components/account-page/balance-trend-chart", () => ({
  BalanceTrendChart: (p: any) => <div data-testid="trend-chart" data-hist={p.historicalActual.length} data-today={p.actualFromToday[0]?.balance ?? ""} />,
}));
vi.mock("@/components/merchant-rename-popover", () => ({ MerchantRenamePopover: () => null }));
import TransactionsPage from "./transactions";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

const SAVED = "h2budget:chase-account";
const CHASE = { id: "acct-a", accountId: "ext-a", name: "Total Checking", mask: "1111", institutionName: "Chase", subtype: "checking" };
const CHASE_B = { id: "acct-b", accountId: "ext-b", name: "Business Checking", mask: "2222", institutionName: "Chase", subtype: "checking" };
const CU = { id: "acct-cu", accountId: "ext-cu", name: "Share Checking", mask: "7007", institutionName: "Summit Credit Union", subtype: "checking" };
const SAV = { id: "acct-sav", accountId: "ext-sav", name: "Savings", mask: "8801", institutionName: "Chase", subtype: "savings" };
const FORECAST = {
  bankSnapshot: { balance: "1000", at: "2026-09-16T06:00:00.000Z", source: "plaid", accountId: "acct-a", name: "Total Checking", mask: "1111" },
  accountSnapshots: {},
  resolutions: [],
  plaidCheckingAccounts: [CHASE, CHASE_B, CU, SAV],
  today: "2026-09-16",
};

let qc: QueryClient;
let server: FakeLedgerServer;
function serve(opts: FakeLedgerOptions): FakeLedgerServer {
  server = createFakeLedgerServer(opts);
  vi.stubGlobal("fetch", server.fetch);
  return server;
}
function show(props: React.ComponentProps<typeof TransactionsPage> = {}) {
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage {...props} />
    </QueryClientProvider>,
  );
}
/** Every ledger GET's `account` param (null when none was sent). */
const accountsAsked = () => server.ledgerGets().map((c) => c.query.get("account"));

const DEFAULT_ROWS: FakeLedgerOptions["rows"] = [
  { id: "aug-row", occurredOn: "2026-08-04", description: "AUGUST ROW", amount: "-12.00" },
  { id: "sep-early", occurredOn: "2026-09-02", description: "EARLY SEPTEMBER", amount: "-5.00" },
  { id: "today-row", occurredOn: "2026-09-16", description: "TODAY", amount: "-1.00" },
];


beforeEach(() => {
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, placeholderData: keepPreviousData } } });
  state.toast.mockReset();
  state.navigate.mockReset();
  state.forecast = FORECAST;
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

const A_ROWS: FakeLedgerOptions["rows"] = [{ id: "a-row", occurredOn: "2026-09-16", description: "A ROW", amount: "-1.00" }];
const B_ROWS = { "acct-b": [{ id: "b-row", occurredOn: "2026-09-15", description: "B ROW", amount: "-2.00" }] };

describe("(Q4) Chase: the account is history, not a silent replace", () => {
  it("picking an account pushes one entry; Back restores the one before, Forward returns", async () => {
    window.history.replaceState(null, "", "/transactions?account=acct-a");
    serve({ rows: A_ROWS, balanceToday: "1000.00", otherAccounts: B_ROWS });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-a-row")).toBeTruthy());
    const before = window.history.length;

    fireEvent.click(screen.getByTestId("option-chase-account-acct-b"));
    await waitFor(() => expect(screen.getByTestId("row-tx-b-row")).toBeTruthy());
    expect(window.location.search).toContain("account=acct-b");
    expect(window.history.length).toBe(before + 1);

    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(screen.getByTestId("row-tx-a-row")).toBeTruthy());
    expect(window.location.search).toContain("account=acct-a");
    expect(screen.queryByTestId("row-tx-b-row")).toBeNull();

    await act(async () => {
      window.history.forward();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(screen.getByTestId("row-tx-b-row")).toBeTruthy());
    expect(window.location.search).toContain("account=acct-b");
  });

  it("history.state is kept (scroll restore and others live there)", async () => {
    window.history.replaceState({ keep: "me" }, "", "/transactions?account=acct-a");
    serve({ rows: A_ROWS, balanceToday: "1000.00", otherAccounts: B_ROWS });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-a-row")).toBeTruthy());
    expect(window.history.state).toEqual({ keep: "me" });
  });

  it("while account B loads, account A's rows are not listed under B", async () => {
    window.history.replaceState(null, "", "/transactions?account=acct-a");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    serve({
      rows: A_ROWS,
      balanceToday: "1000.00",
      otherAccounts: B_ROWS,
      holdLedger: (q) => (q.get("account") === "acct-b" ? gate : undefined),
    });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-a-row")).toBeTruthy());

    fireEvent.click(screen.getByTestId("option-chase-account-acct-b"));
    await waitFor(() => expect(screen.getByTestId("chase-switching")).toBeTruthy());
    expect(screen.queryByTestId("row-tx-a-row")).toBeNull();
    expect(screen.queryByTestId("chase-empty")).toBeNull();

    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId("row-tx-b-row")).toBeTruthy());
    expect(screen.queryByTestId("chase-switching")).toBeNull();
  });

  it("(Final W1) the first pick, with no ?account= in the first entry: Back returns to the default account", async () => {
    window.history.replaceState(null, "", "/transactions");
    serve({ rows: A_ROWS, balanceToday: "1000.00", otherAccounts: B_ROWS });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-a-row")).toBeTruthy());

    fireEvent.click(screen.getByTestId("option-chase-account-acct-b"));
    await waitFor(() => expect(screen.getByTestId("row-tx-b-row")).toBeTruthy());
    expect(window.location.search).toContain("account=acct-b");
    // The pick is saved; Back must still mean "no pick" (the default), not the saved one.
    expect(localStorage.getItem(SAVED)).toBe("acct-b");

    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(screen.getByTestId("row-tx-a-row")).toBeTruthy());
    expect(screen.queryByTestId("row-tx-b-row")).toBeNull();
  });

  it("(Final confirm N1) a range change on the same account keeps the balance chart while the register loads", async () => {
    window.history.replaceState(null, "", "/transactions?account=acct-a");
    let holding = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    serve({
      rows: A_ROWS,
      balanceToday: "1000.00",
      accountScopeIds: (a) => (a === "acct-b" ? ["ext-b"] : ["ext-a"]),
      holdLedger: () => (holding ? gate : undefined),
    });
    show();
    await waitFor(() => expect(screen.getByTestId("trend-chart")).toBeTruthy());
    holding = true;
    fireEvent.click(screen.getByTestId("range-mo"));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("trend-chart").getAttribute("data-today")).toBe("1000");
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId("trend-chart")).toBeTruthy());
  });

  it("(Final W2) the balance chart never draws the previous account's balances while the new account loads", async () => {
    window.history.replaceState(null, "", "/transactions?account=acct-a");
    state.forecast = {
      ...FORECAST,
      accountSnapshots: { "acct-b": { balance: "500", at: "2026-09-16T06:00:00.000Z", source: "plaid", accountId: "acct-b", name: "Business Checking", mask: "2222" } },
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    serve({
      rows: A_ROWS,
      balanceToday: "1000.00",
      otherAccounts: B_ROWS,
      holdLedger: (q) => (q.get("account") === "acct-b" ? gate : undefined),
      holdBalances: (q) => (q.get("account") === "acct-b" ? gate : undefined),
    });
    show();
    await waitFor(() => expect(screen.getByTestId("trend-chart")).toBeTruthy());
    expect(screen.getByTestId("trend-chart").getAttribute("data-today")).toBe("1000");

    fireEvent.click(screen.getByTestId("option-chase-account-acct-b"));
    await waitFor(() => expect(screen.getByTestId("chase-switching")).toBeTruthy());
    expect(screen.queryByTestId("trend-chart")).toBeNull();

    await act(async () => release());
    await waitFor(() => expect(screen.queryByTestId("chase-switching")).toBeNull());
  });
});
