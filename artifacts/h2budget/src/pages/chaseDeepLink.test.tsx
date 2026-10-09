import React from "react";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerOptions,
  type FakeLedgerServer,
} from "./__test-helpers__/fakeLedgerServer";

/**
 * (WP7c) The Chase ledger opened on ONE row, and embedded for one account.
 *
 * Deep links: `?tx=<id>&month=YYYY-MM-01` (what `lib/accountRoute.ts` writes)
 * opens Month mode on that month and says "Showing <Month> for the row you
 * opened"; `?tx=` with no `?account=` reads the bank balance's account, never
 * the saved pick, and leaves the saved pick in place.
 *
 * Embedded (`/next/accounts/:id`): the route's account, at any bank, is never
 * swapped for the bank balance's account (no self-heal, no reset on refusal);
 * a refusal is said where the rows would be (`chase-no-ledger`); the saved
 * pick and `?account=` are not written; the picker lists every linked
 * checking/savings account and a pick opens that account's page.
 *
 * The ledger hooks are the REAL generated hooks over the fetch-level fake
 * (`fakeLedgerServer.ts`). The clock is Wednesday 2026-09-16 (07:00 in
 * Chicago): this week is Sun 09-13 – Sat 09-19.
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
vi.mock("@/components/account-page/balance-trend-chart", () => ({ BalanceTrendChart: () => null }));
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
  window.history.replaceState(null, "", "/transactions");
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

describe("(WP7c) a link to one row opens Month mode on its month", () => {
  it("?tx=&month= opens that month, says so, and lists the row (Week mode would not)", async () => {
    window.history.replaceState(null, "", "/transactions?tx=aug-row&month=2026-08-01");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00" });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-aug-row")).toBeTruthy());
    const register = server.ledgerGets("2026-08-01");
    expect(register.length).toBeGreaterThan(0);
    expect(register[0]!.query.get("to")).toBe("2026-08-31");
    // Never the week: nothing asked from Sunday 09-13.
    expect(server.ledgerGets("2026-09-13")).toHaveLength(0);
    expect(screen.getByTestId("chase-row-link-status").textContent).toBe("Showing August 2026 for the row you opened");
    expect(screen.getByTestId("chase-row-link-status").getAttribute("role")).toBe("status");
  });

  it("?tx= with no month opens Month mode on this month, so a row from earlier in the month is listed", async () => {
    window.history.replaceState(null, "", "/transactions?tx=sep-early");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00" });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-sep-early")).toBeTruthy());
    expect(server.ledgerGets("2026-09-01")[0]!.query.get("to")).toBe("2026-09-16");
    expect(screen.getByTestId("chase-row-link-status").textContent).toBe("Showing September 2026 for the row you opened");
  });

  it("the status line leaves once the person moves to another month; with no row link there is none", async () => {
    window.history.replaceState(null, "", "/transactions?tx=aug-row&month=2026-08-01");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00" });
    const view = show();
    await waitFor(() => expect(screen.getByTestId("row-tx-aug-row")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    await waitFor(() => expect(screen.queryByTestId("chase-row-link-status")).toBeNull());
    view.unmount();

    window.history.replaceState(null, "", "/transactions");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00" });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-today-row")).toBeTruthy());
    expect(screen.queryByTestId("chase-row-link-status")).toBeNull();
    // The week, as before.
    expect(server.ledgerGets("2026-09-13").length).toBeGreaterThan(0);
  });

  it("?tx= with no ?account= reads the bank balance's account, not the saved pick, and leaves the saved pick in place", async () => {
    localStorage.setItem(SAVED, "acct-b");
    window.history.replaceState(null, "", "/transactions?tx=sep-early&month=2026-09-01");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", otherAccounts: { "acct-b": [{ id: "b1", occurredOn: "2026-09-03", amount: "-2.00" }] } });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-sep-early")).toBeTruthy());
    expect(accountsAsked().every((a) => a === null)).toBe(true);
    expect(screen.queryByTestId("row-tx-b1")).toBeNull();
    expect(localStorage.getItem(SAVED)).toBe("acct-b");
    expect(window.location.search).not.toContain("account=");
  });

  it("?tx= with ?account= opens that account", async () => {
    window.history.replaceState(null, "", "/transactions?tx=b1&month=2026-09-01&account=acct-b");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", otherAccounts: { "acct-b": [{ id: "b1", occurredOn: "2026-09-03", amount: "-2.00" }] } });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-b1")).toBeTruthy());
    expect(accountsAsked().every((a) => a === "acct-b")).toBe(true);
  });

  it("without a row link the saved pick still opens (unchanged)", async () => {
    localStorage.setItem(SAVED, "acct-b");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", otherAccounts: { "acct-b": [{ id: "b1", occurredOn: "2026-09-14", amount: "-2.00" }] } });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-b1")).toBeTruthy());
    expect(accountsAsked()[0]).toBe("acct-b");
  });
});

describe("(WP7c) embedded for one account (/next/accounts/:id)", () => {
  it("a credit union's checking account: its own rows, never swapped for the bank balance's account once the forecast names the accounts", async () => {
    serve({
      rows: DEFAULT_ROWS,
      balanceToday: "1000.00",
      otherAccounts: {
        "acct-cu": [{ id: "cu1", occurredOn: "2026-09-14", description: "CULVERS", amount: "-18.40", source: "plaid:summit-cu", plaidAccountId: "ext-cu" }],
      },
    });
    show({ embedded: true, accountKey: "acct-cu" });
    await waitFor(() => expect(screen.getByTestId("row-tx-cu1")).toBeTruthy());
    // Let the forecast bundle's account list settle: still the credit union's account.
    await waitFor(() => expect(screen.getByTestId("chase-balance-unavailable")).toBeTruthy());
    expect(accountsAsked().length).toBeGreaterThan(0);
    expect(accountsAsked().every((a) => a === "acct-cu")).toBe(true);
    expect(screen.queryByTestId("row-tx-today-row")).toBeNull();
    // The row's card column knows the account's digits: the account list is the
    // full one when embedded, not the Chase-only one.
    expect(screen.getByTestId("text-card-cu1").textContent).toContain("••7007");
    // Nothing written to the Chase page's own saved pick or the URL.
    expect(localStorage.getItem(SAVED)).toBeNull();
    expect(window.location.search).not.toContain("account=");
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("a savings account: its rows, and the balance panel says savings", async () => {
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", otherAccounts: { "acct-sav": [{ id: "s1", occurredOn: "2026-09-15", amount: "25.00" }] } });
    show({ embedded: true, accountKey: "acct-sav" });
    await waitFor(() => expect(screen.getByTestId("row-tx-s1")).toBeTruthy());
    expect(screen.getByTestId("chase-stats-balance").textContent).toContain("Savings balance");
    expect(accountsAsked().every((a) => a === "acct-sav")).toBe(true);
  });

  it("a refusal is said in place: no fallback to another account, no toast, nothing saved", async () => {
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", refusedAccounts: ["acct-gone"] });
    show({ embedded: true, accountKey: "acct-gone" });
    const notice = await screen.findByTestId("chase-no-ledger");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("H2 has no ledger for this account.");
    // Give any reset a chance to run: it must not.
    await new Promise((r) => setTimeout(r, 50));
    expect(accountsAsked().every((a) => a === "acct-gone")).toBe(true);
    expect(screen.queryByTestId("row-tx-today-row")).toBeNull();
    expect(screen.queryByTestId("chase-ledger-error")).toBeNull();
    expect(state.toast).not.toHaveBeenCalled();
    expect(localStorage.getItem(SAVED)).toBeNull();
  });

  it("standalone, a refused saved pick still falls back to the bank balance's account (unchanged)", async () => {
    localStorage.setItem(SAVED, "acct-gone");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", refusedAccounts: ["acct-gone"] });
    show();
    await waitFor(() => expect(localStorage.getItem(SAVED)).toBeNull());
    expect(accountsAsked().at(-1)).toBeNull();
    expect(screen.queryByTestId("chase-no-ledger")).toBeNull();
  });

  it("the picker lists every linked checking and savings account, and a pick opens that account's page", async () => {
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", otherAccounts: { "acct-cu": [{ id: "cu1", occurredOn: "2026-09-14", amount: "-1.00" }] } });
    show({ embedded: true, accountKey: "acct-cu" });
    await waitFor(() => expect(screen.getByTestId("row-tx-cu1")).toBeTruthy());
    for (const a of [CHASE, CHASE_B, CU, SAV]) expect(screen.getByTestId(`option-chase-account-${a.id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("option-chase-account-acct-sav"));
    expect(state.navigate).toHaveBeenCalledWith("/next/accounts/ext-sav");
    // The ledger did not switch in place.
    expect(accountsAsked().every((a) => a === "acct-cu")).toBe(true);
    // Picking the account already open does nothing.
    state.navigate.mockClear();
    fireEvent.click(screen.getByTestId("option-chase-account-acct-cu"));
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("standalone, the picker stays Chase-only and switches in place (unchanged)", async () => {
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", otherAccounts: { "acct-b": [{ id: "b1", occurredOn: "2026-09-14", amount: "-2.00" }] } });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-today-row")).toBeTruthy());
    // Chase accounts only: the credit union's is not offered here.
    expect(screen.queryByTestId("option-chase-account-acct-cu")).toBeNull();
    expect(screen.getByTestId("option-chase-account-acct-sav")).toBeTruthy();
    fireEvent.click(screen.getByTestId("option-chase-account-acct-b"));
    await waitFor(() => expect(screen.getByTestId("row-tx-b1")).toBeTruthy());
    expect(state.navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem(SAVED)).toBe("acct-b");
  });

  it("embedded with a row link: Month mode on the row's month for that account", async () => {
    window.history.replaceState(null, "", "/next/accounts/ext-cu?tx=cu-aug&month=2026-08-01");
    serve({ rows: DEFAULT_ROWS, balanceToday: "1000.00", otherAccounts: { "acct-cu": [{ id: "cu-aug", occurredOn: "2026-08-20", amount: "-3.00" }] } });
    show({ embedded: true, accountKey: "acct-cu" });
    await waitFor(() => expect(screen.getByTestId("row-tx-cu-aug")).toBeTruthy());
    expect(server.ledgerGets("2026-08-01")[0]!.query.get("account")).toBe("acct-cu");
    expect(screen.getByTestId("chase-row-link-status").textContent).toBe("Showing August 2026 for the row you opened");
  });
});
