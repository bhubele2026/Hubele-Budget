import React from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi } from "vitest";

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
// fixed server date inside the current month.

const state = vi.hoisted(() => ({
  rows: [] as any[],
  empty: [] as any[],
  toast: vi.fn(),
  upsert: vi.fn(),
  upsertAsync: vi.fn(),
  bulkFlag: vi.fn(),
  updateTx: vi.fn(),
  forecast: {} as Record<string, unknown>,
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
    useListTransactions: () => ({ data: state.rows, isLoading: false }),
    useListCategories: () => ({ data: state.empty }),
    useListMappingRules: () => ({ data: state.empty }),
    useListPlaidItems: () => ({ data: state.empty }),
    useGetForecast: () => ({ data: state.forecast }),
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

const now = new Date();
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const POSTED = `${ym}-02`;
const FUTURE = `${ym}-27`;
const SERVER_TODAY = `${ym}-15`;

function row(
  id: string,
  occurredOn: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    occurredOn,
    description: id,
    amount: "-40",
    source: "manual",
    categoryId: "cat-1",
    forecastFlag: false,
    pending: false,
    reviewed: false,
    ...extra,
  };
}

let qc: QueryClient;
function show() {
  return render(
    <QueryClientProvider client={qc}>
      <TransactionsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const spy of [
    state.toast,
    state.upsert,
    state.upsertAsync,
    state.bulkFlag,
    state.updateTx,
  ]) {
    spy.mockReset();
  }
  state.rows = [row("posted", POSTED), row("future", FUTURE)];
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
});

it("a posted row with its flag off is In Review: its × records 'Not a planned payment' and there is no Send", () => {
  show();
  expect(
    screen
      .getByTestId("badge-forecast-state-posted")
      .getAttribute("data-forecast-state"),
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
});

it("a future row with its flag off is not in the forecast yet: Send, no chip", () => {
  show();
  expect(screen.queryByTestId("badge-forecast-state-future")).toBeNull();
  expect(screen.getByTestId("button-send-forecast-future")).toBeTruthy();
  expect(screen.getByTestId("row-tx-future").getAttribute("data-sent")).toBe(
    "false",
  );
});

it("a posted row that is already matched keeps its match: chip, no ×", () => {
  state.forecast = {
    ...state.forecast,
    resolutions: [{ matchedTxnId: "posted", status: "matched" }],
  };
  show();
  expect(
    screen
      .getByTestId("badge-forecast-state-posted")
      .getAttribute("data-forecast-state"),
  ).toBe("matched");
  expect(screen.queryByTestId("button-remove-forecast-posted")).toBeNull();
});

it("a future row sent to the forecast keeps its 'Remove from forecast' ×", () => {
  state.rows = [row("future", FUTURE, { forecastFlag: true })];
  show();
  expect(
    screen
      .getByTestId("button-remove-forecast-future")
      .getAttribute("aria-label"),
  ).toBe("Remove from forecast");
});

it("bulk Remove flips the flag only on future rows and records 'not a planned payment' for posted ones", async () => {
  state.rows = [
    row("posted", POSTED),
    row("future", FUTURE, { forecastFlag: true }),
  ];
  show();
  fireEvent.click(screen.getByText("Select posted"));
  fireEvent.click(screen.getByText("Select future"));
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
