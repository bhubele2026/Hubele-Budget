import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  BalanceTrendChart: () => null,
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
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.toast.mockReset();
  state.listTransactions.mockReset();
  state.forecast = { ...LINKED_FORECAST, bankSnapshot: null };
  state.spine = undefined;
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
    expect(screen.getByTestId("chase-select-all-matching").textContent).toBe("Select all 120 matching");

    fireEvent.click(screen.getByTestId("chase-select-all-matching"));
    expect(screen.getByTestId("chase-select-all-banner").textContent).toContain("All 120 matching selected.");
    expect(screen.getByTestId("bulk-bar").textContent).toContain("120 selected");
    // Forecast actions need ids; they are not offered for "all matching".
    expect(screen.queryByTestId("bulk-send-forecast")).toBeNull();

    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));
    await waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "120 marked reviewed" })),
    );
    const post = server.calls.find((c) => c.path === "/api/transactions/bulk-review-matching")!;
    expect(post.body).toEqual({
      filter: { from: REGISTER_FROM, to: TODAY },
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
    fireEvent.click(screen.getByTestId("chase-select-all-matching"));

    // A Sync lands a row before the click.
    server.addRow({ id: "late", occurredOn: TODAY, occurredAt: `${TODAY}T23:59:00.000Z` });
    const getsBefore = registerGets().length;
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));

    await waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
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
    expect(screen.queryByText(/All 120 matching selected/)).toBeNull();
    expect(screen.getByTestId("bulk-bar").textContent).not.toContain("120 selected");
  });

  it("a partial failure reports the true count and keeps only the failed rows selected", async () => {
    serve({ rows: weekRows(3), failReviewIds: ["r001"] });
    show();
    await ready("Showing 3 of 3 · 3 to review");
    for (const id of ["r000", "r001", "r002"]) fireEvent.click(screen.getByText(`Select ${id}`));
    fireEvent.click(screen.getByTestId("bulk-mark-reviewed"));

    await waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
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
      expect(state.toast).toHaveBeenCalledWith(
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
      expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "20 marked reviewed" })),
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
    expect(pendingQuery.get("to")).toBe(TODAY);
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
