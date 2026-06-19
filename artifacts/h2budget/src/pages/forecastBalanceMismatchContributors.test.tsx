import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #528 — pin the contributor decomposition behind the amber
// `badge-balance-mismatch` chip. The reconcile gap was just rebuilt to
// detect (a) matched plan/bank pairs whose signed amounts disagree by
// ≥ $0.01 and (b) a `settings.startingBalance` that disagrees with the
// bank snapshot once resolved flows are accounted for. Without a test
// for the contributor split, a future refactor of `bankReconcile`
// could silently regress to the post-#522 "always 0" state where the
// badge never fires regardless of the actual disagreement.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
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
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});

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
    Label: ({ value }: { value?: React.ReactNode }) => <span>{value}</span>,
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: () => ({ dismiss: () => {} }) }),
}));

// Freeze "today" so the May-2026 fixture stays in the current month
// regardless of when the suite runs (otherwise `isPriorMonth` would
// suppress the badge for purely calendar reasons).
const TODAY_ISO = "2026-05-08";
const FROZEN_NOW = new Date(`${TODAY_ISO}T12:00:00.000Z`);

type CashEvent = {
  itemId: string;
  date: string;
  label: string;
  amount: number;
};

type Txn = {
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  forecastFlag: boolean;
};

type Resolution = {
  id: string;
  recurringItemId: string | null;
  occurrenceDate: string | null;
  status: string;
  matchedTxnId: string | null;
};

type ForecastFixture = {
  fromDate: string;
  toDate: string;
  events: CashEvent[];
  transactions: Txn[];
  resolutions: Resolution[];
  closedMonths: string[];
  monthSnapshots: Record<string, unknown>;
  bankSnapshot: { at: string; balance: string; source: string } | null;
  plaidCheckingAccounts: unknown[];
  settings: { startingBalance: string; cashBuffer: string };
};

let currentForecast: ForecastFixture;

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  return {
    useGetForecast: () => ({ data: currentForecast, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: undefined, isLoading: false }),
    useUpsertForecastResolution: noopMutation,
    useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation,
    useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation,
    useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation,
    useRefreshForecastBank: noopMutation,
    useCreateRecurringItem: noopMutation,
    useListCategories: () => ({ data: [], isLoading: false }),
    useListDebts: () => ({ data: [], isLoading: false }),
    useListRecurringItems: () => ({ data: [], isLoading: false }),
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    getGetForecastQueryKey: () => ["forecast"],
    getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
  };
});

import ForecastPage from "./forecast";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ForecastPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("Forecast — bankReconcile contributor decomposition (#528)", () => {
  it("fires the amber badge with the 'matched amount differs' hint when a matched plan amount disagrees with its bank txn", () => {
    // Plan rent of -$1,500 on 2026-05-05, matched to a bank txn that
    // actually cleared at -$1,450 — a $50 disagreement on the matched
    // pair. Snapshot balance is engineered so the residual starting-
    // balance delta is exactly 0, isolating the matched-amount
    // contributor as the sole driver of the gap.
    //
    //   settingsStart = 5000
    //   forecastAtSnapshot = 5000 + (-1500)            = 3500
    //   matchedAmountDelta = -1500 - (-1450)           =  -50
    //   bankAtSnapshot     = 3550  (chosen so rawGap = -50)
    //   startingBalanceDelta = rawGap - matchedDelta    =    0
    //   gap = Σ |delta|                                 =   50
    currentForecast = {
      fromDate: "2026-05-01",
      toDate: "2026-08-01",
      events: [
        { itemId: "rent", date: "2026-05-05", label: "Rent", amount: -1500 },
      ],
      transactions: [
        {
          id: "txn-rent",
          occurredOn: "2026-05-05",
          description: "RENT PAYMENT",
          amount: "-1450",
          forecastFlag: true,
        },
      ],
      resolutions: [
        {
          id: "res-rent",
          recurringItemId: "rent",
          occurrenceDate: "2026-05-05",
          status: "matched",
          matchedTxnId: "txn-rent",
        },
      ],
      closedMonths: [],
      monthSnapshots: {},
      bankSnapshot: {
        at: `${TODAY_ISO}T12:00:00.000Z`,
        balance: "3550",
        source: "manual",
      },
      plaidCheckingAccounts: [],
      settings: { startingBalance: "5000", cashBuffer: "500" },
    };

    renderPage();

    const badge = screen.getByTestId("badge-balance-mismatch");
    expect(badge).toBeTruthy();
    expect(badge.textContent ?? "").toMatch(/\$50\.00/);

    const hint = screen.getByTestId("badge-balance-mismatch-hint");
    expect(hint.textContent).toBe("matched amount differs");

    expect(screen.queryByTestId("badge-inbox-cleared")).toBeNull();
  });

  it("stays hidden when the books reconcile cleanly (no contributors)", () => {
    // No matched pairs, snapshot balance equals the projected balance
    // as of the snapshot date (which equals settings.startingBalance
    // because every plan event lives strictly after the snapshot).
    currentForecast = {
      fromDate: "2026-05-01",
      toDate: "2026-08-01",
      events: [
        { itemId: "rent", date: "2026-05-20", label: "Rent", amount: -1500 },
        { itemId: "pay", date: "2026-05-25", label: "Paycheck", amount: 700 },
      ],
      transactions: [],
      resolutions: [],
      closedMonths: [],
      monthSnapshots: {},
      bankSnapshot: {
        at: `${TODAY_ISO}T12:00:00.000Z`,
        balance: "5000",
        source: "manual",
      },
      plaidCheckingAccounts: [],
      settings: { startingBalance: "5000", cashBuffer: "500" },
    };

    renderPage();

    expect(screen.queryByTestId("badge-balance-mismatch")).toBeNull();
    expect(screen.queryByTestId("badge-balance-mismatch-hint")).toBeNull();
    // Clean reconciliation surfaces the celebratory "Inbox cleared" state.
    expect(screen.getByTestId("badge-inbox-cleared")).toBeTruthy();
  });

  it("fires the amber badge with the 'starting balance off' hint when only the starting balance disagrees with the bank snapshot", () => {
    // No matched pairs, no resolved bank flows before the snapshot, so
    // matchedAmountDelta = 0 and the entire $250 gap is attributed to a
    // settings.startingBalance that disagrees with what the bank
    // snapshot shows.
    //
    //   settingsStart = 5000
    //   forecastAtSnapshot = 5000 (no plan events ≤ snapshot)
    //   bankAtSnapshot     = 4750
    //   matchedAmountDelta =    0
    //   startingBalanceDelta = rawGap - matchedDelta = 250
    //   gap = 250
    currentForecast = {
      fromDate: "2026-05-01",
      toDate: "2026-08-01",
      events: [
        { itemId: "rent", date: "2026-05-20", label: "Rent", amount: -1500 },
        { itemId: "pay", date: "2026-05-25", label: "Paycheck", amount: 700 },
      ],
      transactions: [],
      resolutions: [],
      closedMonths: [],
      monthSnapshots: {},
      bankSnapshot: {
        at: `${TODAY_ISO}T12:00:00.000Z`,
        balance: "4750",
        source: "manual",
      },
      plaidCheckingAccounts: [],
      settings: { startingBalance: "5000", cashBuffer: "500" },
    };

    renderPage();

    const badge = screen.getByTestId("badge-balance-mismatch");
    expect(badge).toBeTruthy();
    expect(badge.textContent ?? "").toMatch(/\$250\.00/);

    const hint = screen.getByTestId("badge-balance-mismatch-hint");
    expect(hint.textContent).toBe("starting balance off");

    expect(screen.queryByTestId("badge-inbox-cleared")).toBeNull();
  });
});
