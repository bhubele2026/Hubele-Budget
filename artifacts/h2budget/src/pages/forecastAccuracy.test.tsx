import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Phase 3 — forecast-accuracy regression guards.
//
// These assert that what the page RENDERS is a faithful, hand-derivable
// reflection of the mocked forecast/cash-signal data:
//   (a) the 90-day projection KPI tiles reflect bills + income over the
//       window, and the ending balance == starting + accepted impact;
//   (b) a bill is event-based — its FULL amount lands on (in the week of)
//       its due date, surfaced via the big-bill marker + tooltip;
//   (c) freed cash appears (Cash Freed banner) when a debt is paid off by
//       the avalanche simulation and a linked recurring bill frees up.
//
// Only values that can be derived by hand from the fixtures below are
// asserted.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

vi.mock("canvas-confetti", () => ({ default: () => undefined }));

vi.mock("wouter", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/components/plaid-reauth-banner", () => ({
  PlaidReauthBanner: () => null,
}));

vi.mock("@/components/avalanche-ready-card", () => ({
  AvalancheReadyCard: () => null,
}));

vi.mock("@/components/avalanche-schedule-card", () => ({
  AvalancheScheduleCard: () => null,
}));

vi.mock("@/components/ui/tabs", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Tabs: Passthrough,
    TabsList: Passthrough,
    TabsTrigger: Passthrough,
    TabsContent: Passthrough,
  };
});

vi.mock("@dnd-kit/core", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    DndContext: Passthrough,
    DragOverlay: Passthrough,
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
    useDroppable: () => ({
      setNodeRef: () => {},
      isOver: false,
    }),
  };
});

// Recharts mock that captures the AreaChart `data` so the Tooltip mock can
// render its `content` render-prop for every daily point — without that,
// the tooltip-bill buttons (which only exist inside the tooltip content)
// would never reach the DOM in jsdom.
let lastChartData: Array<{ rawDate?: string; balance?: number }> = [];
vi.mock("recharts", () => {
  const Stub = ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    const testId = (rest as { ["data-testid"]?: string })["data-testid"];
    return <div data-testid={testId}>{children}</div>;
  };
  const AreaChart = ({
    children,
    data,
  }: {
    children?: React.ReactNode;
    data?: Array<{ rawDate?: string; balance?: number }>;
  }) => {
    lastChartData = data ?? [];
    return <div>{children}</div>;
  };
  const TooltipMock = ({
    content,
  }: {
    content?: (args: {
      active: boolean;
      payload: Array<{ payload: unknown }>;
    }) => React.ReactNode;
  }) => {
    if (!content) return null;
    return (
      <div>
        {lastChartData.map((d, i) => (
          <div key={i}>
            {content({ active: true, payload: [{ payload: d }] })}
          </div>
        ))}
      </div>
    );
  };
  const RefDot = ({
    children,
    onClick,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    [key: string]: unknown;
  }) => {
    const testId = (rest as { ["data-testid"]?: string })["data-testid"];
    return (
      <div data-testid={testId} onClick={onClick}>
        {children}
      </div>
    );
  };
  return {
    ResponsiveContainer: Stub,
    LineChart: Stub,
    Line: Stub,
    AreaChart,
    Area: Stub,
    BarChart: Stub,
    Bar: Stub,
    ComposedChart: Stub,
    XAxis: Stub,
    YAxis: Stub,
    CartesianGrid: Stub,
    Tooltip: TooltipMock,
    Legend: Stub,
    PieChart: Stub,
    Pie: Stub,
    Cell: Stub,
    PolarAngleAxis: Stub,
    PolarGrid: Stub,
    PolarRadiusAxis: Stub,
    Radar: Stub,
    RadarChart: Stub,
    ReferenceLine: Stub,
    ReferenceDot: RefDot,
    Label: ({ value }: { value?: React.ReactNode }) => <span>{value}</span>,
  };
});

// ---------------------------------------------------------------------------
// Fixtures. "Today" is frozen at 2026-05-15 (see beforeEach), so a 90-day
// window from 2026-05-01 covers May → July 2026. Hand-derived numbers:
//
//   Income over the window:  PAYCHECK +3000  (one event)            =  3000
//   Bills over the window:   RENT  -1500  +  CARD  -200             = -1700
//   Net accepted impact:     3000 - 1700                            =  1300
//   Starting balance:                                                  5000
//   Ending balance:          5000 + 1300                            =  6300
// ---------------------------------------------------------------------------

const RENT_DATE = "2026-05-01";
const PAYCHECK_DATE = "2026-05-15";
const CARD_DATE = "2026-06-01";

const FORECAST_BASE = {
  fromDate: "2026-05-01",
  toDate: "2026-08-01",
  events: [
    { itemId: "rent", date: RENT_DATE, label: "Rent", amount: -1500 },
    { itemId: "paycheck", date: PAYCHECK_DATE, label: "Paycheck", amount: 3000 },
    { itemId: "card-min", date: CARD_DATE, label: "Visa Card", amount: -200 },
  ],
  transactions: [],
  resolutions: [],
  closedMonths: [],
  monthSnapshots: {},
  bankSnapshot: null,
  plaidCheckingAccounts: [],
  settings: { startingBalance: "5000", cashBuffer: "500" },
  lockedWeeks: [],
};

// Server-computed cash signal. The page renders these verbatim into the
// KPI tiles / hero; the daily series + events drive the chart markers.
const CASH_SIGNAL = {
  status: "ok",
  startingBalance: "5000",
  endingBalance: "6300",
  endingDate: "2026-07-30",
  toDate: "2026-07-30",
  acceptedImpact: "1300",
  projectedIncome: "3000",
  projectedExpenses: "1700",
  lowestProjected: "3500",
  lowestDate: RENT_DATE,
  cashBuffer: "500",
  daily: [
    { date: RENT_DATE, balance: "3500" },     // 5000 - 1500
    { date: PAYCHECK_DATE, balance: "6500" }, // 3500 + 3000
    { date: CARD_DATE, balance: "6300" },     // 6500 - 200
  ],
  // The bill events, on their due dates. Both expense magnitudes exceed
  // 50% of the $500 buffer ($250)? RENT -1500 does; CARD -200 does NOT, so
  // only RENT becomes a big-bill marker. Both still appear in the tooltip.
  events: [
    { itemId: "rent", date: RENT_DATE, label: "Rent", amount: -1500 },
    { itemId: "card-min", date: CARD_DATE, label: "Visa Card", amount: -200 },
  ],
};

// ---------------------------------------------------------------------------
// Freed-cash fixture (test c). One debt with a $100 balance, 0% APR and a
// $100 minimum pays off in month 1 of the avalanche simulation (which
// starts on the first of the frozen current month = 2026-05-01). A linked
// recurring bill named "Visa" (amount 100) frees up, so the page should
// interleave a Cash Freed banner for that debt into the planned-items list.
// ---------------------------------------------------------------------------

const DEBT = {
  id: "debt-visa",
  name: "Visa",
  apr: "0",
  balance: "100",
  minPayment: "100",
  status: "active",
};

const RECURRING_VISA = {
  id: "rec-visa",
  name: "Visa",
  amount: "100",
  kind: "bill",
  active: "true",
  debtId: "debt-visa",
};

// A May plan row so the planned-items list has a row in the payoff month —
// the banner is interleaved at that month's boundary.
const FORECAST_WITH_DEBT = {
  ...FORECAST_BASE,
  events: [{ itemId: "rec-visa", date: RENT_DATE, label: "Visa", amount: -100 }],
};

let forecastData: typeof FORECAST_BASE = FORECAST_BASE;
let cashSignal: typeof CASH_SIGNAL = CASH_SIGNAL;
let debtsData: unknown[] = [];
let recurringData: unknown[] = [];

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  const empty = { data: [], isLoading: false };
  return {
    useGetForecast: () => ({ data: forecastData, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: cashSignal, isLoading: false }),
    useUpsertForecastResolution: noopMutation,
    useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation,
    useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation,
    useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation,
    useRefreshForecastBank: noopMutation,
    useListCategories: () => empty,
    useListDebts: () => ({ data: debtsData, isLoading: false }),
    useListRecurringItems: () => ({ data: recurringData, isLoading: false }),
    useCreateRecurringItem: noopMutation,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    getGetForecastQueryKey: () => ["forecast"],
    getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
    getListRecurringItemsQueryKey: () => ["recurring-items"],
    getGetBillsSummaryQueryKey: () => ["bills-summary"],
    getGetDashboardQueryKey: () => ["dashboard"],
  };
});

import ForecastPage from "./forecast";

function renderPage(props?: { mode?: "review" | "overall" }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ForecastPage {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  // Keep the May-1 plan/bill rows inside the visible register by opening
  // the look-back panel with a stored from-date (mirrors the existing
  // forecast tests). Also pins the active month to May 2026.
  sessionStorage.setItem("h2budget:forecastFromDate", "2026-05-01");
  sessionStorage.setItem("h2budget:forecastLookbackOpen", "true");
  // Default fixtures; (c) overrides debts/recurring per-test.
  forecastData = FORECAST_BASE;
  cashSignal = CASH_SIGNAL;
  debtsData = [];
  recurringData = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Forecast accuracy — 90-day projection reflects bills + income (a)", () => {
  it("KPI tiles echo projected income and expenses over the window", () => {
    renderPage();

    const income = screen.getByTestId("kpi-projected-income");
    // +$3,000 paycheck is the only income event in the window.
    expect(within(income).getByText("$3,000.00")).toBeTruthy();

    const expenses = screen.getByTestId("kpi-projected-expenses");
    // Rent $1,500 + Visa $200 = $1,700 of bills.
    expect(within(expenses).getByText("$1,700.00")).toBeTruthy();
  });

  it("ending balance equals starting balance + accepted (net) impact", () => {
    renderPage();

    // Hero shows the running forecast balance: 5000 + (3000 - 1700) = 6300.
    const hero = screen.getByTestId("hero-forecast-balance");
    expect(hero.textContent).toContain("$6,300.00");

    // The Ending Balance KPI agrees.
    const ending = screen.getByTestId("kpi-ending-balance");
    expect(within(ending).getByText("$6,300.00")).toBeTruthy();
  });
});

describe("Forecast accuracy — a bill is event-based, full amount in its due week (b)", () => {
  it("rent's full $1,500 lands on its due date as a big-bill marker", () => {
    renderPage();

    // The big-bill marker exists exactly on the rent due date.
    expect(screen.getByTestId(`big-bill-marker-${RENT_DATE}`)).toBeTruthy();

    // The chart tooltip for that same day surfaces the rent bill with its
    // FULL amount (event-based: the whole bill lands on its due day, not
    // smeared across the month).
    const rentBill = screen.getByTestId(`tooltip-bill-${RENT_DATE}-rent`);
    expect(rentBill.textContent).toContain("Rent");
    expect(rentBill.textContent).toContain("$1,500.00");
  });

  it("a smaller bill still posts its full amount on its own due date", () => {
    renderPage();

    // The $200 Visa min is under the big-bill threshold so it gets NO
    // marker, but it still appears (full amount) in its due-day tooltip —
    // confirming each bill is an independent dated event.
    expect(screen.queryByTestId(`big-bill-marker-${CARD_DATE}`)).toBeNull();

    const cardBill = screen.getByTestId(`tooltip-bill-${CARD_DATE}-card-min`);
    expect(cardBill.textContent).toContain("Visa Card");
    expect(cardBill.textContent).toContain("$200.00");
  });
});

describe("Forecast accuracy — freed cash appears when a debt is paid off (c)", () => {
  it("renders a Cash Freed banner for the freed minimum after payoff", () => {
    forecastData = FORECAST_WITH_DEBT;
    debtsData = [DEBT];
    recurringData = [RECURRING_VISA];

    // The banner is interleaved into the planned-items list, which only
    // renders in review mode.
    renderPage({ mode: "review" });

    const banner = screen.getByTestId("cash-freed-debt-visa");
    expect(banner).toBeTruthy();
    // $100 minimum frees up once the Visa debt is gone.
    expect(banner.textContent).toContain("Visa is gone");
    expect(banner.textContent).toContain("$100.00");
  });

  it("shows no Cash Freed banner when there are no debts", () => {
    forecastData = FORECAST_WITH_DEBT;
    debtsData = [];
    recurringData = [RECURRING_VISA];

    renderPage({ mode: "review" });

    expect(screen.queryByTestId("cash-freed-debt-visa")).toBeNull();
  });
});
