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

// The Chase page after `inForecast` (2026-09-10). A checking row that has
// already happened is in the forecast — on the curve and in Review — whatever
// its flag says, so the row controls follow that rule instead of the flag:
//   - posted, awaiting review: "In Review" chip, × records "Not a planned
//     payment" (a resolution), no Send button;
//   - posted and already matched: chip, no × — the match is managed in Review;
//   - future: the flag decides, exactly as before;
//   - bulk Remove flips the flag only on future rows and records "not a
//     planned payment" for posted ones.
// "Today" comes from the forecast bundle, so the rows sit either side of a
// fixed server date inside the viewed month.
//
// (PR14) The list reads the server's ledger. The page opens on September 2026
// in Month mode (`?month=2026-09-01`) with the clock pinned to 2026-09-16: the
// posted row (the 2nd) comes through the register, the future row (the 27th)
// through the after-today request. The ledger, balances, bulk-review and
// UI-preference hooks are the real generated hooks, answered by
// `fakeLedgerServer.ts`; the forecast writes stay spies.

const state = vi.hoisted(() => ({
  empty: [] as any[],
  toast: vi.fn(),
  upsert: vi.fn(),
  upsertAsync: vi.fn(),
  bulkFlag: vi.fn(),
  updateTx: vi.fn(),
  listTransactions: vi.fn(),
  forecast: {} as Record<string, unknown>,
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
    useUpsertForecastResolution: () => ({
      mutate: state.upsert,
      mutateAsync: state.upsertAsync,
      isPending: false,
    }),
    useBulkSetForecastFlag: () => ({
      mutate: vi.fn(),
      mutateAsync: state.bulkFlag,
      isPending: false,
    }),
    useUpdateTransaction: () => ({
      mutate: state.updateTx,
      mutateAsync: vi.fn(),
      isPending: false,
    }),
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
  AccountTransactionRow: ({
    tx,
    onToggleSelect,
    metaNode,
    actionsNode,
    rowData,
    testId,
  }: any) => (
    <div data-testid={testId} {...(rowData ?? {})}>
      {tx.description}
      <button onClick={onToggleSelect}>Select {tx.id}</button>
      {metaNode}
      {actionsNode}
    </div>
  ),
}));
import TransactionsPage from "./transactions";

// Wednesday 2026-09-16 (07:00 in Chicago).
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
afterAll(() => {
  vi.useRealTimers();
});

const POSTED = "2026-09-02";
const FUTURE = "2026-09-27";
const SERVER_TODAY = "2026-09-15";

function row(id: string, occurredOn: string, extra: Partial<FakeRowInput> = {}): FakeRowInput {
  return {
    id,
    occurredOn,
    description: id,
    amount: "-40.00",
    categoryId: "cat-1",
    forecastFlag: false,
    // The ledger labels a row dated after the household's today.
    afterToday: occurredOn > "2026-09-16",
    ...extra,
  };
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

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/transactions?month=2026-09-01");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const spy of [
    state.toast,
    state.upsert,
    state.upsertAsync,
    state.bulkFlag,
    state.updateTx,
    state.listTransactions,
  ]) {
    spy.mockReset();
  }
  serve({ rows: [row("posted", POSTED), row("future", FUTURE)] });
  state.forecast = {
    bankSnapshot: null,
    resolutions: [],
    plaidCheckingAccounts: [],
    today: SERVER_TODAY,
  };
  state.upsertAsync.mockResolvedValue({ id: "res-1" });
  state.bulkFlag.mockImplementation(async ({ data }: any) => ({
    updated: data.ids.length,
    affectedIds: data.ids,
  }));
});
afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
});

it("a posted row with its flag off is In Review: its × records 'Not a planned payment' and there is no Send", async () => {
  show();
  expect(
    (await screen.findByTestId("badge-forecast-state-posted")).getAttribute(
      "data-forecast-state",
    ),
  ).toBe("in-review-bucket");
  expect(screen.queryByTestId("button-send-forecast-posted")).toBeNull();
  expect(screen.getByTestId("row-tx-posted").getAttribute("data-sent")).toBe(
    "true",
  );

  const x = screen.getByTestId("button-remove-forecast-posted");
  expect(x.getAttribute("aria-label")).toBe("Not a planned payment");
  fireEvent.click(x);
  expect(state.upsert).toHaveBeenCalledWith(
    { data: { status: "ignored_unforecasted", matchedTxnId: "posted" } },
    expect.anything(),
  );
  // Never the flag: a posted row stays cash either way.
  expect(state.updateTx).not.toHaveBeenCalled();
  // Never the old 1,000-row list.
  expect(state.listTransactions).not.toHaveBeenCalled();
  expect(server.calls.some((c) => c.path === "/api/transactions")).toBe(false);
});

it("a future row with its flag off is not in the forecast yet: Send, no chip", async () => {
  show();
  const futureRow = await screen.findByTestId("row-tx-future");
  expect(screen.queryByTestId("badge-forecast-state-future")).toBeNull();
  expect(screen.getByTestId("button-send-forecast-future")).toBeTruthy();
  expect(futureRow.getAttribute("data-sent")).toBe("false");
  // Month mode on the linked month: the register runs through today, and the
  // future row came through the after-today request.
  const registerQuery = server.ledgerGets("2026-09-01")[0]!.query;
  expect(registerQuery.get("to")).toBe("2026-09-16");
  expect(server.ledgerGets("2026-09-17")[0]!.query.get("to")).toBe("2026-09-30");
});

it("a posted row that is already matched keeps its match: chip, no ×", async () => {
  state.forecast = {
    ...state.forecast,
    resolutions: [{ matchedTxnId: "posted", status: "matched" }],
  };
  show();
  expect(
    (await screen.findByTestId("badge-forecast-state-posted")).getAttribute(
      "data-forecast-state",
    ),
  ).toBe("matched");
  expect(screen.queryByTestId("button-remove-forecast-posted")).toBeNull();
});

it("a future row sent to the forecast keeps its 'Remove from forecast' ×", async () => {
  serve({ rows: [row("future", FUTURE, { forecastFlag: true })] });
  show();
  expect(
    (await screen.findByTestId("button-remove-forecast-future")).getAttribute(
      "aria-label",
    ),
  ).toBe("Remove from forecast");
});

// (PR5b review H2) The bundle now carries "Not this" and partial answers.
// (PR14 merge) On the fake ledger server, like the tests above; every assertion kept.
it("a posted row with a partial reads 'Partly paid' and offers no ×: every write here would replace the partial", async () => {
  state.forecast = {
    ...state.forecast,
    resolutions: [{ matchedTxnId: "posted", status: "partial" }],
  };
  show();
  const chip = await screen.findByTestId("badge-forecast-state-posted");
  expect(chip.getAttribute("data-forecast-state")).toBe("partial");
  expect(chip.textContent).toContain("Partly paid");
  expect(screen.queryByTestId("button-remove-forecast-posted")).toBeNull();
});

it("a future row with a partial offers no × either", async () => {
  serve({ rows: [row("future", FUTURE, { forecastFlag: true })] });
  state.forecast = {
    ...state.forecast,
    resolutions: [{ matchedTxnId: "future", status: "partial" }],
  };
  show();
  expect(
    (await screen.findByTestId("badge-forecast-state-future")).getAttribute("data-forecast-state"),
  ).toBe("partial");
  expect(screen.queryByTestId("button-remove-forecast-future")).toBeNull();
});

it("a 'Not this' answer beside a match never hides the match, in either order: chip Matched, no ×", async () => {
  const matched = { matchedTxnId: "posted", status: "matched" };
  const rejected = { matchedTxnId: "posted", status: "not_match" };
  for (const resolutions of [[matched, rejected], [rejected, matched]]) {
    state.forecast = { ...state.forecast, resolutions };
    show();
    expect(
      (await screen.findByTestId("badge-forecast-state-posted")).getAttribute("data-forecast-state"),
    ).toBe("matched");
    expect(screen.queryByTestId("button-remove-forecast-posted")).toBeNull();
    cleanup();
  }
});

it("bulk Remove records 'not a planned payment' for a posted row whose only answer is 'Not this', and never for a partial", async () => {
  serve({ rows: [row("posted", POSTED), row("paid", POSTED)] });
  state.forecast = {
    ...state.forecast,
    resolutions: [
      { matchedTxnId: "posted", status: "not_match" },
      { matchedTxnId: "paid", status: "partial" },
    ],
  };
  show();
  expect(
    (await screen.findByTestId("badge-forecast-state-posted")).getAttribute("data-forecast-state"),
  ).toBe("in-review-bucket");
  fireEvent.click(screen.getByText("Select posted"));
  fireEvent.click(screen.getByText("Select paid"));
  fireEvent.click(screen.getByTestId("bulk-remove-forecast"));
  await waitFor(() => expect(state.upsertAsync).toHaveBeenCalledTimes(1));
  expect(state.upsertAsync).toHaveBeenCalledWith({
    data: { status: "ignored_unforecasted", matchedTxnId: "posted" },
  });
});

it("bulk Remove flips the flag only on future rows and records 'not a planned payment' for posted ones", async () => {
  serve({
    rows: [row("posted", POSTED), row("future", FUTURE, { forecastFlag: true })],
  });
  show();
  fireEvent.click(await screen.findByText("Select posted"));
  fireEvent.click(await screen.findByText("Select future"));
  fireEvent.click(screen.getByTestId("bulk-remove-forecast"));

  await waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Removed 1 from Forecast · 1 not a planned payment",
      }),
    ),
  );
  expect(state.bulkFlag).toHaveBeenCalledWith({
    data: { ids: ["future"], forecastFlag: false },
  });
  expect(state.upsertAsync).toHaveBeenCalledWith({
    data: { status: "ignored_unforecasted", matchedTxnId: "posted" },
  });
});
