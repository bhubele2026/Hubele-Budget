import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (PR5b) "Probably paid" on the Forecast page. The server's
// `CashSignal.matches` (PR5a) shows as "Suggested" on the inbox card and the
// register row, with Confirm / Not this / Partial; the client's own scorers
// step aside for the plans and rows the server paired.

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
  useLocation: () => ["/forecast", () => {}],
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
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      isDragging: false,
    }),
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

type ToastCall = { title?: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode };
const toastMock = vi.fn<(opts: ToastCall) => void>();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    state: "cold",
    error: null,
    updatedAt: null,
    refetch: () => {},
  }),
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

// Today is 2026-05-14; the bank snapshot is today's $1,000.
//  - t-water: $173 on 05-12 — the server paired it with Water ($150, 05-20).
//  - t-rent:  $400 on 05-13 — the server paired it with Rent ($500, 05-22).
//  - t-other: $50 on 05-13 — no server pair; the client suggests Netflix.
//  - t-dup:   an exact $150 on 05-19 — on its own the client would call Water
//    a high-confidence match for it. The server already paired Water.
const FORECAST = {
  fromDate: "2026-04-01",
  toDate: "2026-08-01",
  today: "2026-05-14",
  events: [
    { itemId: "water", date: "2026-05-20", label: "Water", kind: "expense", amount: -150 },
    { itemId: "rent", date: "2026-05-22", label: "Rent", kind: "expense", amount: -500 },
    { itemId: "netflix", date: "2026-05-15", label: "Netflix", kind: "expense", amount: -50 },
  ],
  transactions: [
    txn("t-water", "2026-05-12", "CITY WATER 0512", "-173.00"),
    txn("t-rent", "2026-05-13", "RENT PORTAL", "-400.00"),
    txn("t-other", "2026-05-13", "Acme Charge", "-50.00"),
    txn("t-dup", "2026-05-19", "DUPLICATE", "-150.00"),
  ],
  resolutions: [],
  closedMonths: [],
  monthSnapshots: {},
  bankSnapshot: {
    balance: "1000.00",
    at: "2026-05-14T12:00:00.000Z",
    source: "manual",
    accountId: null,
    name: null,
    mask: null,
  },
  plaidCheckingAccounts: [],
  settings: { daysAhead: 30, startingBalance: "1000", cashBuffer: "500" },
};

const MATCHES = [
  {
    planKey: "water|2026-05-20",
    planItemId: "water",
    planDate: "2026-05-20",
    txnId: "t-water",
    planAmount: "-150.00",
    txnAmount: "-173.00",
    difference: "23.00",
    dayDelta: -8,
    confidence: "medium",
    ambiguous: false,
    // "water" is in the row, and $23 is within max($25, 10%): tier 2 (the
    // bill's full name), off the curve — but not confirmed.
    tier: 2,
    offCurve: true,
  },
  {
    planKey: "rent|2026-05-22",
    planItemId: "rent",
    planDate: "2026-05-22",
    txnId: "t-rent",
    planAmount: "-500.00",
    txnAmount: "-400.00",
    difference: "-100.00",
    dayDelta: -9,
    confidence: "low",
    ambiguous: false,
    // $100 short is outside max($25, 10%): tier 3, a suggestion only, still counted.
    tier: 3,
    offCurve: false,
  },
];

const cashSignal = (matches: unknown[]) => ({
  bankToday: "1000.00",
  lowestProjected: "950.00",
  lowestDate: "2026-05-15",
  cashBuffer: "500.00",
  status: "ready",
  maxSafeExtra: "0.00",
  snapshotAt: "2026-05-14T12:00:00.000Z",
  startingBalance: "1000.00",
  endingBalance: "950.00",
  endingDate: "2026-06-13",
  projectedIncome: "0.00",
  projectedExpenses: "50.00",
  acceptedImpact: "-40.00",
  daily: [],
  events: [],
  matches,
});

let cashSignalData: unknown = cashSignal(MATCHES);
let forecastData: unknown = FORECAST;
const upsertMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({ mutate: () => {}, mutateAsync: async () => undefined, isPending: false });
  const empty = { data: [], isLoading: false };
  return {
    useGetForecast: () => ({ data: forecastData, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: cashSignalData, isLoading: false }),
    useUpsertForecastResolution: () => ({
      mutate: (vars: unknown, opts?: { onSuccess?: (row: { id: string }) => void }) => {
        upsertMutate(vars);
        opts?.onSuccess?.({ id: "new-id" });
      },
      mutateAsync: async (vars: unknown) => {
        upsertMutate(vars);
        return undefined;
      },
      isPending: false,
    }),
    useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation,
    useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation,
    useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation,
    useRefreshForecastBank: noopMutation,
    useCreateRecurringItem: noopMutation,
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

function renderPage(mode: "review" | "overall" = "review") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <ForecastPage mode={mode} />
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

const goToCard = (txnId: string) => {
  for (let i = 0; i < 4; i++) {
    if (screen.queryByTestId(`select-bank-${txnId}`)) return;
    fireEvent.click(screen.getByTestId("bank-inbox-pager-next"));
  }
  throw new Error(`card ${txnId} not reachable`);
};

beforeEach(() => {
  cleanup();
  cashSignalData = cashSignal(MATCHES);
  forecastData = FORECAST;
  upsertMutate.mockClear();
  toastMock.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 14, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Forecast — probably paid (PR5b)", () => {
  it("a paired row shows Suggested with the bank row's difference and day delta, and no client suggestion", () => {
    renderPage();
    expect(screen.getByTestId("bank-inbox-pager-indicator").textContent).toBe("1 of 4");
    const strip = screen.getByTestId("probably-paid-t-water");
    expect(strip.textContent).toContain("Suggested");
    expect(strip.textContent).toContain("Water");
    expect(screen.getByTestId("probably-paid-difference-t-water").textContent).toBe("$23.00 over");
    expect(screen.getByTestId("probably-paid-days-t-water").textContent).toBe("8d early");
    // Money and counts are mono numerals; the words carry the meaning.
    for (const figure of ["$23.00", "8d", "$150.00"]) {
      const el = within(strip).getByText((_, node) => node?.tagName === "SPAN" && node.textContent === figure || node?.textContent === `-${figure}` && node?.tagName === "SPAN");
      expect(el.className).toContain("font-mono");
      expect(el.className).toContain("tabular-nums");
    }
    // The server's pair is this row's only suggestion.
    expect(screen.queryByTestId("bank-suggestions-t-water")).toBeNull();
    expect(screen.queryByTestId("one-click-match-t-water")).toBeNull();
    expect(screen.queryByTestId("inbox-drag-hint-t-water")).toBeNull();
    // Paid MORE than planned: no Partial.
    expect(screen.queryByTestId("probably-paid-partial-t-water")).toBeNull();
  });

  it("the register row says Suggested instead of Upcoming, with the paying row and its answers", () => {
    renderPage();
    const row = screen.getByTestId("plan-row-water-2026-05-20");
    expect(row.textContent).toContain("Suggested");
    expect(row.textContent).not.toContain("Upcoming");
    expect(row.textContent).not.toContain("Pending plan");
    const paying = screen.getByTestId("plan-probably-paid-water-2026-05-20");
    expect(paying.textContent).toContain("CITY WATER 0512");
    expect(paying.textContent).toContain("$173.00");
    expect(paying.textContent).toContain("8d early");
    expect(screen.getByTestId("plan-confirm-water-2026-05-20")).toBeTruthy();
    expect(screen.getByTestId("plan-not-this-water-2026-05-20")).toBeTruthy();
    expect(screen.queryByTestId("mark-missed-water-2026-05-20")).toBeNull();
    expect(screen.queryByTestId("move-plan-water-2026-05-20")).toBeNull();
    // A plan with no pair is untouched.
    expect(screen.getByTestId("plan-row-netflix-2026-05-15").textContent).toContain("Upcoming");
    expect(screen.getByTestId("mark-missed-netflix-2026-05-15")).toBeTruthy();
    // A stray click on the Suggested row writes nothing.
    fireEvent.click(row);
    expect(upsertMutate).not.toHaveBeenCalled();
  });

  it("Confirm posts `matched` for the plan key and the row", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("probably-paid-confirm-t-water"));
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate).toHaveBeenCalledWith({
      data: { status: "matched", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t-water" },
    });
    expect(String(toastMock.mock.calls[0][0].title)).toBe("Matched to Water");
  });

  it("Not this posts `not_match` for the pair, with an Undo", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("probably-paid-reject-t-water"));
    expect(upsertMutate).toHaveBeenCalledWith({
      data: { status: "not_match", recurringItemId: "water", occurrenceDate: "2026-05-20", matchedTxnId: "t-water" },
    });
    expect(toastMock.mock.calls[0][0].action).toBeTruthy();
  });

  it("Partial is offered when the row paid less, and posts `partial` from the card and the register", () => {
    renderPage();
    goToCard("t-rent");
    fireEvent.click(screen.getByTestId("probably-paid-partial-t-rent"));
    fireEvent.click(screen.getByTestId("plan-partial-rent-2026-05-22"));
    const body = {
      data: { status: "partial", recurringItemId: "rent", occurrenceDate: "2026-05-22", matchedTxnId: "t-rent" },
    };
    expect(upsertMutate.mock.calls).toEqual([[body], [body]]);
    expect(String(toastMock.mock.calls[0][0].description)).toContain("$100.00");
    expect(screen.queryByTestId("plan-partial-water-2026-05-20")).toBeNull();
  });

  it("an answer refreshes the cash signal", () => {
    const { invalidateSpy } = renderPage();
    fireEvent.click(screen.getByTestId("plan-confirm-water-2026-05-20"));
    const cashSignalQuery = { queryKey: ["/api/forecast/cash-signal", { horizonDays: 30, fromDate: "2026-05-14" }] };
    const refreshes = invalidateSpy.mock.calls.some(([filters]) => {
      const f = filters as { predicate?: (q: unknown) => boolean; queryKey?: unknown[] } | undefined;
      return f?.predicate ? f.predicate(cashSignalQuery) : f?.queryKey?.[0] === "/api/forecast/cash-signal";
    });
    expect(refreshes).toBe(true);
  });

  it("never shows two suggestions for one plan: Water is not offered to t-dup, while t-other keeps the client pick", () => {
    renderPage();
    // Only Netflix ← t-other is a confident client match; Water ← t-dup is not.
    expect(screen.getByTestId("bulk-match-confident").textContent).toContain("(1)");
    goToCard("t-dup");
    expect(screen.queryByTestId("suggest-match-t-dup-water-2026-05-20")).toBeNull();
    expect(screen.queryByTestId("one-click-match-t-dup")).toBeNull();
    expect(screen.queryByTestId("probably-paid-t-dup")).toBeNull();
    fireEvent.click(screen.getByTestId("bank-inbox-pager-prev"));
    expect(screen.getByTestId("select-bank-t-other")).toBeTruthy();
    expect(screen.getByTestId("one-click-match-t-other")).toBeTruthy();
    expect(screen.queryByTestId("probably-paid-t-other")).toBeNull();
  });

  it("\"Forecast\" end leaves only off-curve plans out, as the curve does", () => {
    renderPage();
    // $1,000 today − Netflix $50 − Rent $500 (kept on the curve). Water is off.
    expect(screen.getByTestId("planned-projected-end").textContent).toContain("$450.00");
  });

  it("says in words whether the forecast still counts a suggested plan", () => {
    renderPage();
    expect(screen.getByTestId("probably-paid-curve-t-water").textContent).toBe("Out of forecast");
    expect(screen.getByTestId("plan-probably-paid-curve-water-2026-05-20").textContent).toBe("Out of forecast");
    expect(screen.getByTestId("plan-probably-paid-curve-rent-2026-05-22").textContent).toBe("Still in forecast");
    expect(screen.getByTestId("plan-row-rent-2026-05-22").textContent).toContain("Suggested");
    goToCard("t-rent");
    expect(screen.getByTestId("probably-paid-curve-t-rent").textContent).toBe("Still in forecast");
  });

  it("(review H1) a pair answered 'Not this' is never a client suggestion: no one-click, no Enter, not in Match all confident", () => {
    // t-dup (an exact $150 a day before Water) was the rejected row, and the
    // server offers nothing for Water after the answer.
    forecastData = {
      ...FORECAST,
      resolutions: [
        {
          id: "r-not",
          recurringItemId: "water",
          occurrenceDate: "2026-05-20",
          status: "not_match",
          matchedTxnId: "t-dup",
        },
      ],
    };
    cashSignalData = cashSignal([MATCHES[1]]);
    renderPage();
    // Only Netflix ← t-other is confident; Water ← t-dup was rejected.
    expect(screen.getByTestId("bulk-match-confident").textContent).toContain("(1)");
    goToCard("t-dup");
    expect(screen.queryByTestId("one-click-match-t-dup")).toBeNull();
    expect(screen.queryByTestId("inbox-card-t-dup")).toBeNull();
    expect(screen.queryByTestId("suggest-match-t-dup-water-2026-05-20")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("inbox-card-draggable-t-dup"), { key: "Enter" });
    expect(upsertMutate).not.toHaveBeenCalled();
  });

  it("(review LOW) 'Mark all unplanned' and the selected-rows action leave out rows the server paired", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("select-bank-t-water"));
    fireEvent.click(screen.getByTestId("bulk-mark-unplanned-selected"));
    await new Promise((r) => setTimeout(r, 0));
    expect(upsertMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("bulk-mark-unplanned"));
    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(2));
    const ids = upsertMutate.mock.calls
      .map(([v]) => (v as { data: { matchedTxnId: string } }).data.matchedTxnId)
      .sort();
    expect(ids).toEqual(["t-dup", "t-other"]);
  });

  it("(review LOW) a suggestion still counted on the curve keeps Move and Mark missed; an off-curve one does not", () => {
    renderPage();
    expect(screen.getByTestId("plan-confirm-rent-2026-05-22")).toBeTruthy();
    expect(screen.getByTestId("move-plan-rent-2026-05-22")).toBeTruthy();
    expect(screen.getByTestId("mark-missed-rent-2026-05-22")).toBeTruthy();
    expect(screen.queryByTestId("move-plan-water-2026-05-20")).toBeNull();
    expect(screen.queryByTestId("mark-missed-water-2026-05-20")).toBeNull();
  });

  it("(round 3, LOW) an overdue pair the server counts paid in part shows the remainder, not 'Still in forecast', and hides Move", () => {
    // Insurance, due 05-10 (before today), $180 planned, paid $165 — the server
    // counts it paid (`offCurve` stays false for an underpayment, decision 13)
    // and sends `remainderAmount` for the $15.00 still assumed unpaid. Moving
    // the occurrence would re-add the FULL $180, not the $15.00 the server is
    // actually still counting, so Move must not be offered for this pair.
    forecastData = {
      ...FORECAST,
      events: [...FORECAST.events, { itemId: "insurance", date: "2026-05-10", label: "Insurance", kind: "expense", amount: -180 }],
      transactions: [...FORECAST.transactions, txn("t-ins", "2026-05-10", "STATE FARM RO 27 SFPP", "-165.00")],
    };
    cashSignalData = cashSignal([
      ...MATCHES,
      {
        planKey: "insurance|2026-05-10",
        planItemId: "insurance",
        planDate: "2026-05-10",
        txnId: "t-ins",
        planAmount: "-180.00",
        txnAmount: "-165.00",
        difference: "-15.00",
        dayDelta: 0,
        confidence: "high",
        ambiguous: false,
        tier: 2,
        offCurve: false,
        remainderAmount: "-15.00",
      },
    ]);
    renderPage();
    const curve = screen.getByTestId("plan-probably-paid-curve-insurance-2026-05-10");
    expect(curve.textContent).not.toContain("Still in forecast");
    expect(curve.textContent).toContain("$15.00");
    expect(curve.textContent).toContain("still assumed unpaid");
    expect(screen.queryByTestId("move-plan-insurance-2026-05-10")).toBeNull();
    // Mark missed is untouched by this fix — only Move re-adds the full amount.
    expect(screen.getByTestId("mark-missed-insurance-2026-05-10")).toBeTruthy();
  });

  it("(round 4, HIGH) the register row's face amount is the remainder, not the full plan, with a 'paid X of Y' caption", () => {
    forecastData = {
      ...FORECAST,
      events: [...FORECAST.events, { itemId: "insurance", date: "2026-05-10", label: "Insurance", kind: "expense", amount: -180 }],
      transactions: [...FORECAST.transactions, txn("t-ins", "2026-05-10", "STATE FARM RO 27 SFPP", "-165.00")],
    };
    cashSignalData = cashSignal([
      ...MATCHES,
      {
        planKey: "insurance|2026-05-10",
        planItemId: "insurance",
        planDate: "2026-05-10",
        txnId: "t-ins",
        planAmount: "-180.00",
        txnAmount: "-165.00",
        difference: "-15.00",
        dayDelta: 0,
        confidence: "high",
        ambiguous: false,
        tier: 2,
        offCurve: false,
        remainderAmount: "-15.00",
      },
    ]);
    renderPage();
    // The face amount is the $15.00 still assumed unpaid, never the full $180 —
    // the review's own repro showed −$180 beside "Paid; $15.00 still assumed
    // unpaid", which reads as if the whole bill were still due. The caption
    // (mirroring `partial`'s own "Paid X of Y") is where $180 legitimately
    // still appears, as the ORIGINAL plan, not the outstanding face amount.
    expect(screen.getByTestId("plan-row-insurance-2026-05-10").textContent).toContain("$15.00");
    const caption = screen.getByTestId("plan-remainder-paid-insurance-2026-05-10");
    expect(caption.textContent).toContain("$165.00");
    expect(caption.textContent).toContain("$180.00");
  });

  it("(round 3, LOW) the bank-side strip shows the same remainder note", () => {
    forecastData = {
      ...FORECAST,
      events: [...FORECAST.events, { itemId: "insurance", date: "2026-05-10", label: "Insurance", kind: "expense", amount: -180 }],
      transactions: [...FORECAST.transactions, txn("t-ins", "2026-05-10", "STATE FARM RO 27 SFPP", "-165.00")],
    };
    cashSignalData = cashSignal([
      ...MATCHES,
      {
        planKey: "insurance|2026-05-10",
        planItemId: "insurance",
        planDate: "2026-05-10",
        txnId: "t-ins",
        planAmount: "-180.00",
        txnAmount: "-165.00",
        difference: "-15.00",
        dayDelta: 0,
        confidence: "high",
        ambiguous: false,
        tier: 2,
        offCurve: false,
        remainderAmount: "-15.00",
      },
    ]);
    renderPage();
    goToCard("t-ins");
    const strip = screen.getByTestId("probably-paid-curve-t-ins");
    expect(strip.textContent).not.toContain("Still in forecast");
    expect(strip.textContent).toContain("$15.00");
  });

  it("(decision 13) a tier-2 pair nobody confirmed is still Suggested with Confirm / Not this; a tier-3 pair is a suggestion that keeps Move and Mark missed", () => {
    renderPage();
    // Tier 2 (Water): the server already leaves it out of the forecast, but nothing is written until an answer.
    expect(screen.getByTestId("plan-row-water-2026-05-20").textContent).toContain("Suggested");
    expect(screen.getByTestId("plan-probably-paid-curve-water-2026-05-20").textContent).toBe("Out of forecast");
    expect(screen.getByTestId("plan-confirm-water-2026-05-20")).toBeTruthy();
    expect(screen.getByTestId("plan-not-this-water-2026-05-20")).toBeTruthy();
    // Tier 3 (Rent): still in the forecast, with the same answers plus Move and Mark missed.
    expect(screen.getByTestId("plan-row-rent-2026-05-22").textContent).toContain("Suggested");
    expect(screen.getByTestId("plan-probably-paid-curve-rent-2026-05-22").textContent).toBe("Still in forecast");
    expect(screen.getByTestId("plan-confirm-rent-2026-05-22")).toBeTruthy();
    expect(screen.getByTestId("plan-not-this-rent-2026-05-22")).toBeTruthy();
    expect(screen.getByTestId("move-plan-rent-2026-05-22")).toBeTruthy();
    expect(screen.getByTestId("mark-missed-rent-2026-05-22")).toBeTruthy();
    expect(upsertMutate).not.toHaveBeenCalled();
  });

  it("Matched impact is the server's figure, unchanged by suggestions", () => {
    renderPage("overall");
    const withMatches = screen.getByText(/^Matched impact/).textContent;
    expect(withMatches).toContain("40.00");
    // The overall register answers too.
    expect(screen.getByTestId("plan-confirm-water-2026-05-20")).toBeTruthy();
    cleanup();
    cashSignalData = cashSignal([]);
    renderPage("overall");
    expect(screen.getByText(/^Matched impact/).textContent).toBe(withMatches);
    expect(screen.queryByTestId("plan-confirm-water-2026-05-20")).toBeNull();
  });
});

describe("Forecast — a partly-paid plan past due (PR5b review M1)", () => {
  // $500 rent due 05-13, a $250 row on 05-12, and a partial. The curve carries
  // the $250 remainder onto 05-15 (the Past due card and the tooltip read that
  // event). Mark missed / Skip / Match there used to replace the partial, and
  // Undo then left the plan with no resolution at all.
  const RENT_PARTIAL = {
    ...FORECAST,
    events: [
      { itemId: "rent2", date: "2026-05-13", label: "Rent", kind: "expense", amount: -500 },
      { itemId: "gym", date: "2026-05-12", label: "Gym", kind: "expense", amount: -40 },
    ],
    transactions: [txn("t-rent2", "2026-05-12", "RENT PORTAL", "-250.00")],
    resolutions: [
      {
        id: "r-partial",
        recurringItemId: "rent2",
        occurrenceDate: "2026-05-13",
        status: "partial",
        matchedTxnId: "t-rent2",
        txnAmount: "-250.00",
      },
    ],
  };
  const DRAGGED = {
    ...cashSignal([]),
    events: [
      { date: "2026-05-15", itemId: "rent2", label: "Rent", amount: "-250.00", originalDate: "2026-05-13" },
      { date: "2026-05-15", itemId: "gym", label: "Gym", amount: "-40.00", originalDate: "2026-05-12" },
    ],
  };

  it("(second review NIT) Mark missed still works on an occurrence that shares its date with a moved partial", () => {
    // Rent3's 05-13 occurrence was moved onto 05-20 and partly paid; its 05-20
    // occurrence is still pending. Both lines sit on 05-20.
    forecastData = {
      ...FORECAST,
      events: [
        { itemId: "rent3", date: "2026-05-13", label: "Rent", kind: "expense", amount: -500 },
        { itemId: "rent3", date: "2026-05-20", label: "Rent", kind: "expense", amount: -500 },
      ],
      transactions: [txn("t-rent3", "2026-05-12", "RENT PORTAL", "-250.00")],
      resolutions: [
        {
          id: "r-move",
          recurringItemId: "rent3",
          occurrenceDate: "2026-05-13",
          status: "rescheduled",
          matchedTxnId: null,
          rescheduledTo: "2026-05-20",
        },
        {
          id: "r-part",
          recurringItemId: "rent3",
          occurrenceDate: "2026-05-13",
          status: "partial",
          matchedTxnId: "t-rent3",
          txnAmount: "-250.00",
        },
      ],
    };
    cashSignalData = cashSignal([]);
    renderPage("review");
    const buttons = screen.getAllByTestId("mark-missed-rent3-2026-05-20");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(upsertMutate).toHaveBeenCalledWith({
      data: { status: "missed", recurringItemId: "rent3", occurrenceDate: "2026-05-20" },
    });
  });

  it("stays on Review's register as Partly paid with its remainder", () => {
    forecastData = RENT_PARTIAL;
    cashSignalData = DRAGGED;
    renderPage("review");
    const row = screen.getByTestId("plan-row-rent2-2026-05-13");
    expect(row.textContent).toContain("Partly paid");
    expect(row.textContent).toContain("$250.00");
    expect(screen.queryByTestId("mark-missed-rent2-2026-05-13")).toBeNull();
  });

  it("the Past due card offers no Mark missed, Skip or Match for it — so nothing can replace the partial or need an Undo", () => {
    forecastData = RENT_PARTIAL;
    cashSignalData = DRAGGED;
    renderPage("overall");
    expect(screen.getByTestId("dragging-plan-partial-rent2-2026-05-13").textContent).toBe("Partly paid");
    expect(screen.queryByTestId("dragging-plan-mark-missed-rent2-2026-05-13")).toBeNull();
    expect(screen.queryByTestId("dragging-plan-skip-rent2-2026-05-13")).toBeNull();
    expect(screen.queryByTestId("dragging-plan-match-trigger-rent2-2026-05-13")).toBeNull();
    // An ordinary past-due plan keeps its actions.
    expect(screen.getByTestId("dragging-plan-mark-missed-gym-2026-05-12")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dragging-plan-skip-gym-2026-05-12"));
    expect(upsertMutate).toHaveBeenCalledWith({
      data: { status: "skipped", recurringItemId: "gym", occurrenceDate: "2026-05-12" },
    });
  });
});
