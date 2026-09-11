import React from "react";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MutationCache, QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { onWriteSuccess } from "@/lib/mutationInvalidation";
import { formatCurrency } from "@/lib/utils";
import { nodeText, toastTexts } from "./__test-helpers__/toastText";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeLedgerServer,
  type FakeLedgerOptions,
  type FakeLedgerServer,
  type FakeRowInput,
} from "./__test-helpers__/fakeLedgerServer";

/**
 * ⭐ PR14 — the Chase review inbox, on the server's ledger.
 *
 * The ledger, balances, bulk-review and UI-preference hooks are the REAL
 * generated hooks, answered by a fetch-level fake that follows the PR13
 * contract (`fakeLedgerServer.ts`). Everything else on the page is stubbed as
 * in the other Chase page tests.
 *
 * The clock is pinned to Wednesday 2026-09-16 (noon UTC, 07:00 in Chicago), so
 * the default week is Sun 09-13 – Sat 09-19: the register asks for 09-13..09-16
 * and the days after today are asked for apart.
 */

const state = vi.hoisted(() => ({
  empty: [] as any[],
  toast: vi.fn(),
  listTransactions: vi.fn(),
  forecast: undefined as unknown,
  spine: undefined as unknown,
  cashSignal: undefined as unknown,
  trendProps: [] as any[],
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
    useGetSpine: () => ({ data: state.spine, isLoading: false, isFetching: false, refetch: vi.fn() }),
    useGetForecastCashSignal: () => ({ data: state.cashSignal }),
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
vi.mock("@/components/account-page/balance-trend-chart", () => ({
  BalanceTrendChart: (props: any) => {
    state.trendProps.push(props);
    return null;
  },
}));
vi.mock("./transactions/InlineAmountEditor", () => ({
  InlineAmountEditor: ({ tx }: any) => <span data-testid={`amount-${tx.id}`}>{tx.amount}</span>,
}));
vi.mock("@/components/account-page/transaction-row", () => ({
  LEDGER_GRID: "",
  AccountTransactionRow: ({
    tx,
    selected,
    onToggleSelect,
    metaNode,
    chipsNode,
    amountNode,
    actionsNode,
    rowData,
    testId,
  }: any) => (
    <div data-testid={testId} data-selected={selected ? "true" : "false"} {...(rowData ?? {})}>
      <span>{tx.description}</span>
      <button onClick={onToggleSelect}>Select {tx.id}</button>
      {metaNode}
      {chipsNode}
      {amountNode}
      {actionsNode}
    </div>
  ),
}));
import TransactionsPage from "./transactions";

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});

const REGISTER_FROM = "2026-09-13";
const TODAY = "2026-09-16";
const WEEK_DAYS = ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"];

/** `n` posted rows over this week through today, unique ids, distinct times. */
function weekRows(n: number, extra: (i: number) => Partial<FakeRowInput> = () => ({})): FakeRowInput[] {
  return Array.from({ length: n }, (_, i) => {
    const day = WEEK_DAYS[i % WEEK_DAYS.length]!;
    const minute = String(i % 60).padStart(2, "0");
    const hour = String(Math.floor(i / 60) % 24).padStart(2, "0");
    return {
      id: `r${String(i).padStart(3, "0")}`,
      occurredOn: day,
      occurredAt: `${day}T${hour}:${minute}:00.000Z`,
      amount: "-10.00",
      ...extra(i),
    };
  });
}

/** A typed-in balance with no Plaid account: the stats cards render. */
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
const rowsOnScreen = () =>
  screen.queryAllByTestId(/^row-tx-/).map((el) => el.getAttribute("data-testid")!.slice("row-tx-".length));
const showing = () => screen.getByTestId("chase-showing").textContent;
const registerGets = () => server.ledgerGets(REGISTER_FROM);
async function ready(text: string) {
  await waitFor(() => expect(screen.getByTestId("chase-showing").textContent).toBe(text));
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/transactions");
  // The app's own after-write rule (App.tsx), so request counts are the app's.
  qc = new QueryClient({
    mutationCache: new MutationCache({
      onSuccess: (_d, _v, _c, mutation) => onWriteSuccess(qc, mutation),
    }),
    // App.tsx's global stale-while-revalidate: a new filter shows the last one's
    // data while it loads, which is exactly the state LOW-2 must not mislabel.
    defaultOptions: { queries: { retry: false, placeholderData: keepPreviousData } },
  });
  state.toast.mockReset();
  state.listTransactions.mockReset();
  state.forecast = { ...LINKED_FORECAST, bankSnapshot: null };
  state.spine = undefined;
  state.cashSignal = undefined;
  state.trendProps = [];
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

describe("paging", () => {
  it("shows 'Showing 50 of 120 · 120 to review', and Load more appends the next pages with no duplicates", async () => {
    serve({ rows: weekRows(120) });
    show();
    await ready("Showing 50 of 120 · 120 to review");
    expect(rowsOnScreen()).toHaveLength(50);
    expect(screen.getByTestId("chase-to-review").textContent).toContain("120");

    // The register asks through today only, 50 rows at a time.
    const first = registerGets()[0]!.query;
    expect(first.get("from")).toBe(REGISTER_FROM);
    expect(first.get("to")).toBe(TODAY);
    expect(first.get("limit")).toBe("50");
    expect(first.get("cursor")).toBeNull();

    fireEvent.click(screen.getByTestId("chase-load-more"));
    await ready("Showing 100 of 120 · 120 to review");
    let ids = rowsOnScreen();
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(registerGets().map((c) => c.query.get("cursor"))).toEqual([null, "50"]);

    fireEvent.click(screen.getByTestId("chase-load-more"));
    await ready("Showing 120 of 120 · 120 to review");
    ids = rowsOnScreen();
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);
    expect(screen.queryByTestId("chase-load-more")).toBeNull();
  });

  it("asks the days after today apart, lists them labelled, and never totals them", async () => {
    state.forecast = LINKED_FORECAST;
    serve({
      rows: [
        { id: "today", occurredOn: TODAY, amount: "-40.00" },
        { id: "later", occurredOn: "2026-09-18", amount: "-500.00", afterToday: true },
      ],
    });
    show();
    await ready("Showing 1 of 1 · 1 to review");
    await waitFor(() => expect(screen.getByTestId("row-tx-later")).toBeTruthy());
    expect(server.ledgerGets("2026-09-17")[0]!.query.get("to")).toBe("2026-09-19");
    expect(screen.getByTestId("label-after-today-later").textContent).toBe("After today");
    // (PR14 second review NIT) A day after today is listed, never totalled.
    expect(screen.getByTestId("day-net-2026-09-18").textContent).toBe("—");
    const inOut = screen.getByTestId("chase-stats-in-out").textContent ?? "";
    expect(inOut).toContain("$40.00");
    expect(inOut).not.toContain("$500.00");
    expect(inOut).not.toContain("$540.00");
  });

  it("never calls the old 1,000-row list, and shows the freshness line", async () => {
    state.spine = {
      bank: {
        asOfDate: new Date(Date.UTC(2026, 8, 16, 11, 48, 0)).toISOString(),
        source: "plaid",
        lastContactAt: null,
        stale: false,
        staleReason: null,
      },
    };
    serve({ rows: weekRows(3) });
    show();
    await ready("Showing 3 of 3 · 3 to review");
    expect(state.listTransactions).not.toHaveBeenCalled();
    expect(server.calls.some((c) => c.path === "/api/transactions")).toBe(false);
    expect(screen.queryByText(/1,000 most recent/)).toBeNull();
    expect(screen.getByTestId("chase-freshness").textContent).toContain("Last auto-updated");
  });
});

describe("selection and bulk review", () => {
  it("select this page, then all 120 matching, then one bulk review held to that count", async () => {
    serve({ rows: weekRows(120) });
    show();
    await ready("Showing 50 of 120 · 120 to review");

    fireEvent.click(screen.getByTestId("chase-select-page"));
    expect(screen.getByTestId("bulk-bar").textContent).toContain("50 selected");
    await waitFor(() =>
      expect(screen.getByTestId("chase-select-all-matching").textContent).toBe("Select all 120 posted"),
    );

    fireEvent.click(screen.getByTestId("chase-select-all-matching"));
    expect(screen.getByTestId("chase-select-all-banner").textContent).toContain("All 120 posted rows selected.");
    expect(screen.getByTestId("bulk-bar").textContent).toContain("120 selected");
    // Forecast actions need ids; they are not offered for "all matching".
    expect(screen.queryByTestId("bulk-send-forecast")).toBeNull();

    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(expect.objectContaining({ title: "120 marked reviewed" })),
    );
    const post = server.calls.find((c) => c.path === "/api/transactions/bulk-review-matching")!;
    expect(post.body).toEqual({
      filter: { from: REGISTER_FROM, to: TODAY, pending: false },
      reviewed: true,
      expectedCount: 120,
    });
    // One request, no per-id writes.
    expect(server.calls.some((c) => c.path === "/api/transactions/bulk-update")).toBe(false);
    expect(server.rows.every((r) => r.reviewed)).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("bulk-bar")).toBeNull());
    await ready("Showing 50 of 120 · 0 to review");
  });

  it("a 409 writes nothing, refetches, says the count changed, and asks the user to select again", async () => {
    serve({ rows: weekRows(120) });
    show();
    await ready("Showing 50 of 120 · 120 to review");
    fireEvent.click(screen.getByTestId("chase-select-page"));
    await waitFor(() =>
      expect(screen.getByTestId("chase-select-all-matching").textContent).toBe("Select all 120 posted"),
    );
    fireEvent.click(screen.getByTestId("chase-select-all-matching"));

    // A Sync lands a row before the click.
    server.addRow({ id: "late", occurredOn: TODAY, occurredAt: `${TODAY}T23:59:00.000Z` });
    const getsBefore = registerGets().length;
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));

    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(
        expect.objectContaining({
          title: "The count changed. Nothing was marked.",
          description: "121 match now. Select again to review them.",
          variant: "destructive",
        }),
      ),
    );
    expect(server.rows.some((r) => r.reviewed)).toBe(false);
    await waitFor(() => expect(registerGets().length).toBeGreaterThan(getsBefore));
    await ready("Showing 50 of 121 · 121 to review");
    expect(screen.queryByText(/All 120 posted rows selected/)).toBeNull();
    expect(screen.getByTestId("bulk-bar").textContent).not.toContain("120 selected");
  });

  it("a partial failure reports the true count and keeps only the failed rows selected", async () => {
    serve({ rows: weekRows(3), failReviewIds: ["r001"] });
    show();
    await ready("Showing 3 of 3 · 3 to review");
    for (const id of ["r000", "r001", "r002"]) fireEvent.click(screen.getByText(`Select ${id}`));
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));

    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(
        expect.objectContaining({ title: "2 marked reviewed, 1 failed", variant: "destructive" }),
      ),
    );
    expect(screen.getByTestId("bulk-bar").textContent).toContain("1 selected");
    expect(screen.getByTestId("row-tx-r001").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("row-tx-r000").getAttribute("data-selected")).toBe("false");
    expect(server.rows.filter((r) => r.reviewed).map((r) => r.id).sort()).toEqual(["r000", "r002"]);
  });

  it("a request that fails part-way counts every id it never saved, and those stay selected", async () => {
    // 250 rows over five pages; the second 200-id request answers 500.
    serve({ rows: weekRows(250), failBulkUpdateCall: 2 });
    show();
    await ready("Showing 50 of 250 · 250 to review");
    for (const next of [100, 150, 200, 250]) {
      fireEvent.click(screen.getByTestId("chase-load-more"));
      await ready(`Showing ${next} of 250 · 250 to review`);
    }
    fireEvent.click(screen.getByTestId("chase-select-page"));
    expect(screen.getByTestId("bulk-bar").textContent).toContain("250 selected");
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));

    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(
        expect.objectContaining({ title: "200 marked reviewed, 50 failed" }),
      ),
    );
    expect(screen.getByTestId("bulk-bar").textContent).toContain("50 selected");
    expect(server.rows.filter((r) => r.reviewed)).toHaveLength(200);
  });
});

describe("clearing reviewed rows", () => {
  it("review 20, clear them: gone, and the money is unchanged; Show reviewed brings them back", async () => {
    state.forecast = LINKED_FORECAST;
    serve({ rows: weekRows(60, (i) => (i === 7 ? { amount: "250.00" } : {})), balanceStart: "1000.00", balanceEnd: "840.00" });
    show();
    await ready("Showing 50 of 60 · 60 to review");
    const moneyBefore = screen.getByTestId("chase-stats-in-out").textContent;
    const balanceBefore = screen.getByTestId("chase-stats-balance").textContent;

    const picked = rowsOnScreen().slice(0, 20);
    for (const id of picked) fireEvent.click(screen.getByText(`Select ${id}`));
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(expect.objectContaining({ title: "20 marked reviewed" })),
    );
    const update = server.calls.find((c) => c.path === "/api/transactions/bulk-update")!;
    expect(update.body).toEqual({ ids: picked, patch: { reviewed: true } });
    await ready("Showing 50 of 60 · 40 to review");

    fireEvent.click(screen.getByText("Clear reviewed from list"));
    await waitFor(() => expect(picked.every((id) => !screen.queryByTestId(`row-tx-${id}`))).toBe(true));
    await ready("Showing 40 of 40 · 40 to review");
    expect(rowsOnScreen()).toHaveLength(40);
    expect(registerGets().at(-1)!.query.get("reviewed")).toBe("false");
    // Clearing is a view: no total or balance moves.
    expect(screen.getByTestId("chase-stats-in-out").textContent).toBe(moneyBefore);
    expect(screen.getByTestId("chase-stats-balance").textContent).toBe(balanceBefore);

    fireEvent.click(screen.getByText("Show reviewed"));
    await waitFor(() => expect(picked.every((id) => !!screen.queryByTestId(`row-tx-${id}`))).toBe(true));
    await ready("Showing 50 of 60 · 40 to review");
    expect(screen.getByTestId("chase-stats-in-out").textContent).toBe(moneyBefore);
  });

  it("says review is complete when every row in range is reviewed and hidden", async () => {
    serve({ rows: weekRows(2, () => ({ reviewed: true })), prefs: { chaseHideReviewed: true } });
    localStorage.setItem("h2-chase-hide-reviewed", "true");
    show();
    await waitFor(() =>
      expect(screen.getByTestId("chase-empty").textContent).toBe("Review complete. Reviewed transactions are hidden."),
    );
  });

  it("says a range with no rows has none", async () => {
    serve({ rows: [] });
    show();
    await waitFor(() => expect(screen.getByTestId("chase-empty").textContent).toBe("No transactions in this range."));
  });
});

describe("the hide-reviewed setting persists", () => {
  it("a click saves it per user (user_ui_preferences.chaseHideReviewed) and in the first-paint seed", async () => {
    serve({ rows: weekRows(3, (i) => ({ reviewed: i === 0 })) });
    show();
    await ready("Showing 3 of 3 · 2 to review");
    fireEvent.click(screen.getByText("Clear reviewed from list"));
    await ready("Showing 2 of 2 · 2 to review");
    expect(localStorage.getItem("h2-chase-hide-reviewed")).toBe("true");
    await waitFor(() =>
      expect(
        server.calls.find((c) => c.path === "/api/me/ui-preferences" && c.method === "PUT")?.body,
      ).toEqual({ chaseHideReviewed: true }),
    );
    expect(server.prefs.chaseHideReviewed).toBe(true);
  });

  it("another device (no local seed) picks the saved setting up from the server", async () => {
    serve({ rows: weekRows(3, (i) => ({ reviewed: i === 0 })), prefs: { chaseHideReviewed: true } });
    show();
    await waitFor(() => expect(screen.getByText("Show reviewed")).toBeTruthy());
    await ready("Showing 2 of 2 · 2 to review");
    expect(screen.queryByTestId("row-tx-r000")).toBeNull();
    expect(localStorage.getItem("h2-chase-hide-reviewed")).toBe("true");
  });

  it("the local seed decides the very first request, before the server answers", async () => {
    localStorage.setItem("h2-chase-hide-reviewed", "true");
    serve({ rows: weekRows(3, (i) => ({ reviewed: i === 0 })), prefs: { chaseHideReviewed: true } });
    show();
    await ready("Showing 2 of 2 · 2 to review");
    expect(registerGets()[0]!.query.get("reviewed")).toBe("false");
  });
});

describe("rows the balance treats specially", () => {
  it("labels a stale pending row and a held-ahead row in words, and shows the server's running balance", async () => {
    serve({
      rows: [
        { id: "stale", occurredOn: "2026-08-20", pending: true, stalePending: true, description: "GAS HOLD" },
        { id: "held", occurredOn: "2026-09-15", heldAhead: true, runningBalance: "900.00" },
        { id: "twin", occurredOn: "2026-09-15", countsInBalance: false, balanceReason: "not_bank", balanceAmount: "0.00" },
        { id: "plain", occurredOn: "2026-09-14", runningBalance: "910.00" },
      ],
    });
    show();
    await ready("Showing 3 of 3 · 3 to review");
    // The stale pending row is dated before the week: the pinned Pending group
    // lists every pending row whatever the range.
    await waitFor(() => expect(screen.getByTestId("row-tx-stale")).toBeTruthy());
    expect(screen.getByTestId("label-stale-pending-stale").textContent).toBe("Pending 14+ days");
    expect(screen.getByTestId("label-held-ahead-held").textContent).toBe("Already in balance");
    expect(screen.getByTestId("label-held-ahead-held").getAttribute("title")).toMatch(/already includes/);
    expect(screen.getByTestId("label-not-counted-twin").textContent).toBe("Not counted");
    expect(screen.queryByTestId("label-stale-pending-plain")).toBeNull();
    expect(screen.queryByTestId("label-held-ahead-plain")).toBeNull();
    expect(screen.getByTestId("text-running-balance-held").textContent).toBe("bal $900.00");
    expect(screen.getByTestId("text-running-balance-plain").textContent).toBe("bal $910.00");
    // A row the server gives no balance shows none, not a computed one.
    expect(screen.queryByTestId("text-running-balance-twin")).toBeNull();
    const pendingQuery = server.calls.find((c) => c.query.get("pending") === "true")!.query;
    expect(pendingQuery.get("from")).toBeNull();
    // (PR14 review LOW-1) No `to`: a pending row dated after today is listed too.
    expect(pendingQuery.get("to")).toBeNull();
  });
});

describe("no $0 for missing data", () => {
  it("balances the server does not have read '—', never $0.00", async () => {
    state.forecast = LINKED_FORECAST;
    serve({
      rows: [
        { id: "coffee", occurredOn: TODAY, amount: "-4.50" },
        { id: "refund", occurredOn: "2026-09-14", amount: "25.00" },
      ],
      balanceStart: null,
      balanceEnd: null,
      balanceToday: null,
    });
    show();
    await ready("Showing 2 of 2 · 2 to review");
    const balance = screen.getByTestId("chase-stats-balance").textContent ?? "";
    expect(balance).toContain("—");
    expect(balance).not.toContain("$0.00");
    expect(document.body.textContent).not.toContain("$0.00");
    expect(screen.getByTestId("chase-stats-in-out").textContent).toContain("$25.00");
  });

  it("a ledger that fails to load shows the error and Retry, and no money at all", async () => {
    state.forecast = LINKED_FORECAST;
    serve({ rows: weekRows(3), ledgerStatus: 500 });
    show();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Chase transactions could not load."));
    expect(screen.getByText("Retry transactions")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });
});

describe("(PR14 review) fixes", () => {
  const TWO_ACCOUNTS = {
    ...LINKED_FORECAST,
    bankSnapshot: { ...LINKED_FORECAST.bankSnapshot, accountId: "acct-a", source: "plaid" },
    plaidCheckingAccounts: [
      { id: "acct-a", accountId: "ext-a", name: "Total Checking", mask: "1111", institutionName: "Chase" },
      { id: "acct-a2", accountId: "ext-a2", name: "Total Checking", mask: "1111", institutionName: "Chase" },
      { id: "acct-b", accountId: "ext-b", name: "Business Checking", mask: "2222", institutionName: "Chase" },
    ],
  };

  it("H1: a second, non-twin Chase account lists its rows and totals with 'Balance unavailable', and no balances", async () => {
    localStorage.setItem("h2budget:chase-account", "acct-b");
    state.forecast = TWO_ACCOUNTS;
    serve({
      rows: [{ id: "a1", occurredOn: TODAY, amount: "-5.00", runningBalance: "995.00" }],
      balanceStart: "1000.00",
      balanceEnd: "995.00",
      balanceToday: "995.00",
      otherAccounts: {
        "acct-b": [
          { id: "b1", occurredOn: TODAY, occurredAt: `${TODAY}T10:00:00.000Z`, amount: "-30.00" },
          { id: "b2", occurredOn: "2026-09-14", occurredAt: "2026-09-14T10:00:00.000Z", amount: "100.00" },
          { id: "b2twin", occurredOn: "2026-09-14", occurredAt: "2026-09-14T09:00:00.000Z", amount: "100.00", countsInBalance: false, balanceReason: "not_bank" },
        ],
      },
    });
    show();
    await ready("Showing 3 of 3 · 3 to review");
    expect(registerGets()[0]!.query.get("account")).toBe("acct-b");
    expect(screen.getByTestId("chase-account-picker")).toBeTruthy();
    expect(screen.getByTestId("chase-balance-unavailable").textContent).toBe("Balance unavailable");
    expect(screen.queryByTestId("row-tx-a1")).toBeNull();
    expect(screen.getByTestId("row-tx-b1")).toBeTruthy();
    expect(screen.getByTestId("label-not-counted-b2twin").textContent).toBe("Not counted");
    expect(screen.queryAllByTestId(/^text-running-balance-/)).toHaveLength(0);
    const inOut = screen.getByTestId("chase-stats-in-out").textContent ?? "";
    expect(inOut).toContain("$100.00");
    expect(inOut).toContain("$30.00");
    expect(inOut).not.toContain("$200.00");
    // The twin adds nothing to its day.
    expect(screen.getByTestId("day-net-2026-09-14").textContent).toBe(`+${formatCurrency(100)}`);
    // No balance is asked for, drawn, or invented.
    expect(server.balanceGets()).toHaveLength(0);
    expect(state.trendProps).toHaveLength(0);
    expect(document.body.textContent).not.toContain("$0.00");
  });

  it("H1: a saved account the server refuses resets to the default account, clearing ?account= and the saved choice", async () => {
    localStorage.setItem("h2budget:chase-account", "acct-gone");
    // The forecast bundle has not answered, so only the server can say the account is wrong.
    state.forecast = undefined;
    serve({ rows: weekRows(2), refusedAccounts: ["acct-gone"] });
    show();
    await ready("Showing 2 of 2 · 2 to review");
    const gets = registerGets();
    expect(gets[0]!.query.get("account")).toBe("acct-gone");
    expect(gets.at(-1)!.query.get("account")).toBeNull();
    await waitFor(() => expect(localStorage.getItem("h2budget:chase-account")).toBeNull());
    expect(window.location.search).not.toContain("account=");
    expect(toastTexts(state.toast)).toContainEqual(
      expect.objectContaining({ title: "That account has no ledger. Showing the bank balance account." }),
    );
  });

  it("H1: a failed load keeps the header, picker and controls on screen, says why not 'No rows', and Retry recovers", async () => {
    state.forecast = TWO_ACCOUNTS;
    // Register, pending and after-today lists all fail on the first try.
    serve({ rows: weekRows(2), ledgerFailures: 3 });
    show();
    const error = await screen.findByTestId("chase-ledger-error");
    expect(error.textContent).toContain("Chase transactions could not load.");
    expect(screen.getByTestId("chase-account-picker")).toBeTruthy();
    expect(screen.getByTestId("chase-review-controls")).toBeTruthy();
    const inOut = screen.getByTestId("chase-stats-in-out").textContent ?? "";
    expect(inOut).toContain("Couldn't load");
    expect(inOut).not.toContain("No rows through today");
    expect(screen.queryByTestId("chase-empty")).toBeNull();
    fireEvent.click(within(error).getByText("Retry transactions"));
    await ready("Showing 2 of 2 · 2 to review");
    expect(screen.queryByTestId("chase-ledger-error")).toBeNull();
  });

  it("M1: a day's total counts what the ledger counts: a twin and a duplicate add nothing, and it reconciles with the card", async () => {
    state.forecast = LINKED_FORECAST;
    serve({
      rows: [
        { id: "coffee", occurredOn: "2026-09-15", occurredAt: "2026-09-15T10:00:00.000Z", amount: "-82.92" },
        { id: "twin", occurredOn: "2026-09-15", occurredAt: "2026-09-15T11:00:00.000Z", amount: "-63.21", countsInBalance: false, balanceReason: "not_bank" },
        { id: "dup", occurredOn: "2026-09-15", occurredAt: "2026-09-15T12:00:00.000Z", amount: "-82.92", countsInBalance: false, balanceReason: "duplicate" },
        { id: "pay", occurredOn: "2026-09-14", amount: "500.00" },
      ],
    });
    show();
    await ready("Showing 4 of 4 · 4 to review");
    expect(screen.getByTestId("day-net-2026-09-15").textContent).toBe(formatCurrency(-82.92));
    expect(screen.getByTestId("day-net-2026-09-14").textContent).toBe(`+${formatCurrency(500)}`);
    const inOut = screen.getByTestId("chase-stats-in-out").textContent ?? "";
    expect(inOut).toContain("$82.92");
    expect(inOut).not.toContain("$146.13");
    expect(inOut).not.toContain("$228.05");
  });

  it("LOW-1 and M1: a pending row dated after today is listed, labelled, and left out of the Pending total, as is a pending twin", async () => {
    serve({
      rows: [
        { id: "p1", occurredOn: TODAY, occurredAt: `${TODAY}T10:00:00.000Z`, pending: true, amount: "-12.00" },
        { id: "ptwin", occurredOn: TODAY, occurredAt: `${TODAY}T09:00:00.000Z`, pending: true, amount: "-12.00", countsInBalance: false, balanceReason: "not_bank" },
        { id: "ptomorrow", occurredOn: "2026-09-17", pending: true, amount: "-9.99", afterToday: true, description: "PENDING TOMORROW" },
      ],
    });
    show();
    await waitFor(() => expect(screen.getByTestId("row-tx-ptomorrow")).toBeTruthy());
    expect(screen.getByTestId("label-after-today-ptomorrow").textContent).toBe("After today");
    expect(screen.getAllByTestId("row-tx-ptomorrow")).toHaveLength(1);
    expect(screen.getByTestId("day-net-pending").textContent).toBe(formatCurrency(-12));
  });

  it("M3: one review refetches each loaded list once, and nothing else; saving the hide setting refetches no balances", async () => {
    state.forecast = LINKED_FORECAST;
    serve({ rows: weekRows(150), balanceStart: "1000.00", balanceEnd: "900.00", balanceToday: "900.00" });
    show();
    await ready("Showing 50 of 150 · 150 to review");
    fireEvent.click(screen.getByTestId("chase-load-more"));
    await ready("Showing 100 of 150 · 150 to review");
    fireEvent.click(screen.getByTestId("chase-load-more"));
    await ready("Showing 150 of 150 · 150 to review");
    await waitFor(() => expect(server.balanceGets().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));

    const before = server.calls.length;
    fireEvent.click(within(screen.getByTestId("row-tx-r149")).getByText("Mark reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(expect.objectContaining({ title: "1 marked reviewed" })),
    );
    await ready("Showing 150 of 150 · 149 to review");
    await new Promise((r) => setTimeout(r, 30));
    const after = server.calls.slice(before);
    const ledger = after.filter((c) => c.path === "/api/transactions/ledger");
    // One pass over the register's three loaded pages, in order; one each for the others.
    expect(ledger.filter((c) => c.query.get("from") === REGISTER_FROM).map((c) => c.query.get("cursor"))).toEqual([null, "50", "100"]);
    expect(ledger.filter((c) => c.query.get("pending") === "true")).toHaveLength(1);
    expect(ledger.filter((c) => c.query.get("from") === "2026-09-17")).toHaveLength(1);
    expect(ledger).toHaveLength(5);
    expect(after.filter((c) => c.path === "/api/transactions/balances")).toHaveLength(0);
    expect(after.filter((c) => c.method !== "GET")).toHaveLength(1);

    const balancesBefore = server.balanceGets().length;
    fireEvent.click(screen.getByText("Clear reviewed from list"));
    await ready("Showing 50 of 149 · 149 to review");
    await waitFor(() => expect(server.prefs.chaseHideReviewed).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(server.balanceGets().length).toBe(balancesBefore);
  });

  it("LOW-2: while a new filter loads, the old figures are not shown under it", async () => {
    state.forecast = LINKED_FORECAST;
    let release: () => void = () => {};
    serve({
      rows: weekRows(4),
      balanceStart: "1000.00",
      balanceEnd: "960.00",
      balanceToday: "960.00",
      holdLedger: (q) =>
        q.get("reviewed") === "false" && q.get("from") === REGISTER_FROM
          ? new Promise<void>((r) => {
              release = r;
            })
          : undefined,
    });
    show();
    await ready("Showing 4 of 4 · 4 to review");
    expect(screen.getByTestId("chase-stats-in-out").textContent).toContain("$40.00");
    fireEvent.click(screen.getByText("Clear reviewed from list"));
    await waitFor(() => expect(screen.getByTestId("chase-stats-in-out").textContent).not.toContain("$40.00"));
    expect(screen.getByTestId("chase-stats-in-out").textContent).toContain("—");
    expect(screen.getByTestId("chase-stats-balance").textContent).not.toContain("$1,000.00");
    expect(screen.queryByTestId("chase-showing")).toBeNull();
    expect(screen.getByTestId("chase-to-review").textContent).toContain("—");
    act(() => release());
    await ready("Showing 4 of 4 · 4 to review");
    expect(screen.getByTestId("chase-stats-in-out").textContent).toContain("$40.00");
  });

  it("LOW-4: reviewing one row, and its Undo, keep the other rows the user selected", async () => {
    serve({ rows: weekRows(3) });
    show();
    await ready("Showing 3 of 3 · 3 to review");
    fireEvent.click(screen.getByText("Select r000"));
    fireEvent.click(screen.getByText("Select r001"));
    fireEvent.click(within(screen.getByTestId("row-tx-r002")).getByText("Mark reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(expect.objectContaining({ title: "1 marked reviewed" })),
    );
    expect(screen.getByTestId("bulk-bar").textContent).toContain("2 selected");
    const undo = toastTexts(state.toast).find((t) => t.title === "1 marked reviewed")!.action as any;
    await act(async () => {
      undo.props.onClick();
    });
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(expect.objectContaining({ title: "1 restored for review" })),
    );
    expect(screen.getByTestId("bulk-bar").textContent).toContain("2 selected");
    expect(server.rows.find((r) => r.id === "r002")!.reviewed).toBe(false);
  });

  it("LOW-5: with no balance for today, the chart gets no seed, never the cash signal's starting balance", async () => {
    state.forecast = LINKED_FORECAST;
    state.cashSignal = { bankToday: "777.00", daily: [] };
    serve({ rows: weekRows(1), balanceToday: null });
    show();
    await ready("Showing 1 of 1 · 1 to review");
    const props = state.trendProps.at(-1);
    expect(props.forecastFromToday).toEqual([]);
    expect(props.actualFromToday).toEqual([]);
    expect(JSON.stringify(props)).not.toContain("777");
  });

  it("LOW-5 control: with today's balance, the chart is seeded at it", async () => {
    state.forecast = LINKED_FORECAST;
    state.cashSignal = { bankToday: "777.00", daily: [] };
    serve({ rows: weekRows(1), balanceToday: "960.00" });
    show();
    await ready("Showing 1 of 1 · 1 to review");
    await waitFor(() => expect(state.trendProps.at(-1).actualFromToday[0]?.balance).toBe(960));
  });

  it("NIT: the select-all count and the toast counts are mono", async () => {
    serve({ rows: weekRows(60) });
    show();
    await ready("Showing 50 of 60 · 60 to review");
    fireEvent.click(screen.getByTestId("chase-select-page"));
    await waitFor(() => expect(screen.getByTestId("chase-select-all-count").className).toContain("font-mono"));
    fireEvent.click(screen.getByTestId("chase-select-all-matching"));
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(expect.objectContaining({ title: "60 marked reviewed" })),
    );
    const call = state.toast.mock.calls.map((c) => c[0] as any).find((a) => nodeText(a.title) === "60 marked reviewed");
    expect(renderToStaticMarkup(<>{call.title}</>)).toContain('class="font-mono tabular-nums"');
  });
});

describe("(PR14 second review)", () => {
  it("N1: Select all leaves pending rows out — the count and the filter are the server's posted rows; a pending row is still reviewable on its own", async () => {
    const pending = ["p0", "p1", "p2"].map((id, k) => ({
      id,
      occurredOn: TODAY,
      occurredAt: `${TODAY}T23:5${k}:00.000Z`,
      pending: true,
      amount: "-77.00",
    }));
    serve({ rows: [...weekRows(120), ...pending] });
    show();
    await ready("Showing 50 of 123 · 123 to review");
    fireEvent.click(screen.getByTestId("chase-select-page"));
    await waitFor(() =>
      expect(screen.getByTestId("chase-select-all-matching").textContent).toBe("Select all 120 posted"),
    );
    const countQuery = server.calls.find(
      (c) => c.path === "/api/transactions/ledger" && c.query.get("pending") === "false",
    )!.query;
    expect(countQuery.get("from")).toBe(REGISTER_FROM);
    expect(countQuery.get("to")).toBe(TODAY);
    expect(countQuery.get("limit")).toBe("1");

    fireEvent.click(screen.getByTestId("chase-select-all-matching"));
    expect(screen.getByTestId("bulk-bar").textContent).toContain("120 selected");
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(expect.objectContaining({ title: "120 marked reviewed" })),
    );
    const post = server.calls.find((c) => c.path === "/api/transactions/bulk-review-matching")!;
    expect(post.body).toEqual({
      filter: { from: REGISTER_FROM, to: TODAY, pending: false },
      reviewed: true,
      expectedCount: 120,
    });
    expect(server.rows.filter((r) => r.pending).map((r) => r.reviewed)).toEqual([false, false, false]);
    expect(server.rows.filter((r) => !r.pending).every((r) => r.reviewed)).toBe(true);
    await ready("Showing 50 of 123 · 3 to review");

    // One pending row, on its own row: allowed, as before.
    fireEvent.click(within(screen.getByTestId("row-tx-p0")).getByText("Mark reviewed"));
    await waitFor(() => expect(server.rows.find((r) => r.id === "p0")!.reviewed).toBe(true));
    expect(server.calls.filter((c) => c.path === "/api/transactions/bulk-update").at(-1)!.body).toEqual({
      ids: ["p0"],
      patch: { reviewed: true },
    });
  });

  it("LOW: an Undo whose failed ids are not on a loaded page says only the loaded ones stay selected", async () => {
    // r000 is the oldest row: never on the first page of 50.
    serve({ rows: weekRows(120), failReviewIds: ["r000"] });
    show();
    await ready("Showing 50 of 120 · 120 to review");
    fireEvent.click(screen.getByTestId("chase-select-page"));
    await waitFor(() =>
      expect(screen.getByTestId("chase-select-all-matching").textContent).toBe("Select all 120 posted"),
    );
    fireEvent.click(screen.getByTestId("chase-select-all-matching"));
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(expect.objectContaining({ title: "120 marked reviewed" })),
    );
    const undo = toastTexts(state.toast).find((t) => t.title === "120 marked reviewed")!.action as any;
    await act(async () => {
      undo.props.onClick();
    });
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(
        expect.objectContaining({
          title: "119 restored for review, 1 failed",
          description: "Failed rows on the loaded pages remain selected. Try again.",
          variant: "destructive",
        }),
      ),
    );
  });
});

describe("(PR14 third review)", () => {
  it("LOW: the bulk bar leaves selected pending rows unreviewed and says so; a pending row alone sends nothing; its own button still reviews it", async () => {
    const pendingRow = {
      id: "p0",
      occurredOn: TODAY,
      occurredAt: `${TODAY}T23:59:00.000Z`,
      pending: true,
      amount: "-77.00",
    };
    serve({ rows: [...weekRows(3), pendingRow] });
    show();
    await ready("Showing 4 of 4 · 4 to review");

    // "Select this page" takes the pending row too.
    fireEvent.click(screen.getByTestId("chase-select-page"));
    expect(screen.getByTestId("bulk-bar").textContent).toContain("4 selected");
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(
        expect.objectContaining({ title: "3 marked reviewed · 1 pending left unreviewed" }),
      ),
    );
    const writes = server.calls.filter((c) => c.path === "/api/transactions/bulk-update");
    expect(writes).toHaveLength(1);
    expect([...writes[0]!.body.ids].sort()).toEqual(["r000", "r001", "r002"]);
    expect(server.rows.find((r) => r.id === "p0")!.reviewed).toBe(false);
    // The pending row is still selected; the reviewed rows left the selection.
    expect(screen.getByTestId("bulk-bar").textContent).toContain("1 selected");

    // Only the pending row selected: nothing is sent.
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
    await waitFor(() =>
      expect(toastTexts(state.toast)).toContainEqual(
        expect.objectContaining({ title: "1 pending left unreviewed" }),
      ),
    );
    expect(server.calls.filter((c) => c.path === "/api/transactions/bulk-update")).toHaveLength(1);

    // Its own row's button still reviews it.
    fireEvent.click(within(screen.getByTestId("row-tx-p0")).getByText("Mark reviewed"));
    await waitFor(() => expect(server.rows.find((r) => r.id === "p0")!.reviewed).toBe(true));
  });

  it("NIT: the posted count is asked for only while the select-all banner is shown", async () => {
    serve({ rows: weekRows(3) });
    show();
    await ready("Showing 3 of 3 · 3 to review");
    fireEvent.click(screen.getByTestId("chase-select-page"));
    expect(screen.getByTestId("bulk-bar").textContent).toContain("3 selected");
    // Every row is loaded, so there is no banner and no count request.
    expect(screen.queryByTestId("chase-select-all-banner")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    const countRequests = () =>
      server.calls.filter((c) => c.path === "/api/transactions/ledger" && c.query.get("pending") === "false");
    expect(countRequests()).toHaveLength(0);
  });
});
