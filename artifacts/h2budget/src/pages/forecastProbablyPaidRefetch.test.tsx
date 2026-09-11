import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (PR5b second review N2) The refetch window after an answer. `invalidate()`
// refetches the forecast bundle and the cash signal together; the lighter
// signal usually lands first. Here the signal's refetch resolves at once with
// the server's post-answer view (no pairs) while the bundle's refetch never
// lands — the old bundle plus the new signal. The answer must already be in
// the cached bundle, or the page re-offers what the user just answered.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (() =>
    ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

vi.mock("wouter", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useLocation: () => ["/review", () => {}],
}));
vi.mock("@/components/plaid-reauth-banner", () => ({ PlaidReauthBanner: () => null }));
vi.mock("@/components/avalanche-schedule-card", () => ({ AvalancheScheduleCard: () => null }));
vi.mock("@/components/forecast-date-balance", () => ({ ForecastDateBalance: () => null }));
vi.mock("@dnd-kit/core", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    DndContext: Passthrough,
    DragOverlay: () => null,
    PointerSensor: function () {},
    TouchSensor: function () {},
    useSensor: () => ({}),
    useSensors: () => [],
    useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, isDragging: false }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});
vi.mock("recharts", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Stub,
    AreaChart: Stub,
    Area: Stub,
    XAxis: Stub,
    YAxis: Stub,
    CartesianGrid: Stub,
    Tooltip: Stub,
    ReferenceLine: Stub,
    ReferenceDot: Stub,
    Label: Stub,
  };
});
vi.mock("@/components/ui/select", () => {
  const Div = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Select: Div,
    SelectTrigger: Div,
    SelectContent: Div,
    SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
      <div data-value={value}>{children}</div>
    ),
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: undefined, isLoading: false, isFetching: false, state: "cold", error: null, updatedAt: null, refetch: () => {} }),
}));

const txn = (id: string, occurredOn: string, description: string, amount: string) => ({
  id,
  occurredOn,
  description,
  amount,
  forecastFlag: true,
  categoryId: null,
  source: "manual",
  plaidAccountId: null,
});

// Today 2026-05-14.
//  - Water $150 due 05-20; t-dup, "CITY WATER", an exact $150 on 05-19: the
//    server's off-curve pair — and, without the server, a high-confidence
//    CLIENT match (exact, 1 day).
//  - Rent $500 due 05-22; t-rent, "RENT PORTAL", $400 on 05-13: an underpaid
//    pair, kept on the curve.
const BUNDLE = {
  fromDate: "2026-04-01",
  toDate: "2026-08-01",
  today: "2026-05-14",
  events: [
    { itemId: "water", date: "2026-05-20", label: "Water", kind: "expense", amount: -150 },
    { itemId: "rent", date: "2026-05-22", label: "Rent", kind: "expense", amount: -500 },
  ],
  transactions: [
    txn("t-rent", "2026-05-13", "RENT PORTAL", "-400.00"),
    txn("t-dup", "2026-05-19", "CITY WATER", "-150.00"),
  ],
  resolutions: [] as unknown[],
  closedMonths: [],
  monthSnapshots: {},
  bankSnapshot: { balance: "1000.00", at: "2026-05-14T12:00:00.000Z", source: "manual", accountId: null, name: null, mask: null },
  plaidCheckingAccounts: [],
  settings: { daysAhead: 30, startingBalance: "1000", cashBuffer: "500" },
};

const pair = (over: Record<string, unknown>) => ({
  planAmount: "-150.00",
  txnAmount: "-150.00",
  difference: "0.00",
  dayDelta: -1,
  confidence: "high",
  ambiguous: false,
  offCurve: true,
  ...over,
});
const BEFORE = [
  pair({ planKey: "water|2026-05-20", planItemId: "water", planDate: "2026-05-20", txnId: "t-dup" }),
  pair({
    planKey: "rent|2026-05-22",
    planItemId: "rent",
    planDate: "2026-05-22",
    txnId: "t-rent",
    planAmount: "-500.00",
    txnAmount: "-400.00",
    difference: "-100.00",
    dayDelta: -9,
    confidence: "low",
    offCurve: false,
  }),
];
const signal = (matches: unknown[]) => ({
  bankToday: "1000.00",
  lowestProjected: "1000.00",
  lowestDate: "2026-05-14",
  cashBuffer: "500.00",
  status: "ready",
  maxSafeExtra: "0.00",
  startingBalance: "1000.00",
  endingBalance: "1000.00",
  acceptedImpact: "0.00",
  daily: [],
  events: [],
  matches,
});

const state = vi.hoisted(() => ({ signal: null as unknown }));
const upsertMutate = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const rq = await import("@tanstack/react-query");
  const noop = () => ({ mutate: () => {}, mutateAsync: async () => undefined, isPending: false });
  const empty = { data: [], isLoading: false };
  return {
    // The bundle: served from the query cache; its refetch never lands.
    useGetForecast: (params: unknown) =>
      rq.useQuery({
        queryKey: ["/api/forecast", params],
        queryFn: () => new Promise(() => {}),
        initialData: BUNDLE,
        staleTime: Infinity,
      }),
    // The cash signal: its refetch resolves at once with the current server view.
    useGetForecastCashSignal: (params: unknown) =>
      rq.useQuery({
        queryKey: ["/api/forecast/cash-signal", params],
        queryFn: async () => state.signal,
        initialData: state.signal,
        staleTime: Infinity,
      }),
    useUpsertForecastResolution: () => ({
      mutate: (vars: unknown, opts?: { onSuccess?: (row: { id: string }) => void }) => {
        upsertMutate(vars);
        // After the write the server pairs nothing: both plans were answered.
        state.signal = signal([]);
        opts?.onSuccess?.({ id: "res-new" });
      },
      mutateAsync: async () => undefined,
      isPending: false,
    }),
    useDeleteForecastResolution: noop,
    useCloseForecastMonth: noop,
    useReopenForecastMonth: noop,
    useUpdateForecastSettings: noop,
    useUpdateTransaction: noop,
    useSetForecastBankSnapshot: noop,
    useRefreshForecastBank: noop,
    useCreateRecurringItem: noop,
    useListCategories: () => empty,
    useListDebts: () => empty,
    useListRecurringItems: () => empty,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getListRecurringItemsQueryKey: () => ["/api/recurring-items"],
    getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
    getGetDashboardQueryKey: () => ["/api/dashboard"],
  };
});

import ForecastPage from "./forecast";

let qc: QueryClient;
function renderPage() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForecastPage mode="review" />
    </QueryClientProvider>,
  );
}

/** Wait until the signal's refetch has landed while the bundle's is still in flight. */
async function inTheRefetchWindow() {
  await waitFor(() => {
    const sig = qc.getQueryCache().findAll({ predicate: (q) => q.queryKey[0] === "/api/forecast/cash-signal" })[0];
    expect((sig?.state.data as { matches: unknown[] } | undefined)?.matches).toEqual([]);
  });
  const bundle = qc.getQueryCache().findAll({ predicate: (q) => q.queryKey[0] === "/api/forecast" })[0];
  expect(bundle?.state.fetchStatus).toBe("fetching");
}

const goToCard = (txnId: string) => {
  for (let i = 0; i < 3; i++) {
    if (screen.queryByTestId(`select-bank-${txnId}`)) return;
    fireEvent.click(screen.getByTestId("bank-inbox-pager-next"));
  }
  throw new Error(`card ${txnId} not reachable`);
};

beforeEach(() => {
  cleanup();
  state.signal = signal(BEFORE);
  upsertMutate.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 14, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Forecast — an answer survives the refetch window (PR5b second review N2)", () => {
  it("Not this: with the new signal and the old bundle, the rejected pair is never a client suggestion", async () => {
    renderPage();
    goToCard("t-dup");
    fireEvent.click(screen.getByTestId("probably-paid-reject-t-dup"));
    expect(upsertMutate).toHaveBeenCalledWith({
      data: { status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t-dup" },
    });
    await inTheRefetchWindow();
    expect(screen.queryByTestId("probably-paid-t-dup")).toBeNull();
    // Still in Review — "Not this" decides nothing — but nothing re-offers Water.
    expect(screen.getByTestId("select-bank-t-dup")).toBeTruthy();
    expect(screen.queryByTestId("one-click-match-t-dup")).toBeNull();
    expect(screen.queryByTestId("inbox-card-t-dup")).toBeNull();
    expect(screen.queryByTestId("suggest-match-t-dup-water-2026-05-20")).toBeNull();
    expect(screen.queryByTestId("bulk-match-confident")).toBeNull();
  });

  it("Partial: the just-partialled plan offers no match action and its row has left Review", async () => {
    renderPage();
    goToCard("t-rent");
    fireEvent.click(screen.getByTestId("probably-paid-partial-t-rent"));
    await inTheRefetchWindow();
    expect(screen.queryByTestId("select-bank-t-rent")).toBeNull();
    expect(screen.queryByTestId("suggest-match-t-rent-rent-2026-05-22")).toBeNull();
    const row = screen.getByTestId("plan-row-rent-2026-05-22");
    expect(row.textContent).toContain("Partly paid");
    expect(row.textContent).toContain("$100.00");
    expect(screen.queryByTestId("mark-missed-rent-2026-05-22")).toBeNull();
  });

  it("Confirm: the matched row leaves Review at once and is not re-offered", async () => {
    renderPage();
    goToCard("t-dup");
    fireEvent.click(screen.getByTestId("probably-paid-confirm-t-dup"));
    await inTheRefetchWindow();
    expect(screen.queryByTestId("select-bank-t-dup")).toBeNull();
    expect(screen.queryByTestId("one-click-match-t-dup")).toBeNull();
    expect(screen.queryByTestId("plan-row-water-2026-05-20")).toBeNull();
  });
});
