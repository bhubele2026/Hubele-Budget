import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #463: end-to-end UI coverage for the per-card "Choose a planned"
// dropdown on the Forecast page. Task #457 already unit-tests the
// `filterDropdownPlans` helper, but a regression in the wiring between
// `sortedPlansByCard` and the actual <Select> would slip past that.
// This test renders the page with a known set of plans across months
// (prior, current, within 21d / next month, further out, already
// matched) plus a single bank inbox card and asserts the dropdown's
// visible options + the empty-state path with "Unplanned".

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

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
    useDroppable: () => ({
      setNodeRef: () => {},
      isOver: false,
    }),
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
    LineChart: Stub,
    Line: Stub,
    AreaChart: Stub,
    Area: Stub,
    BarChart: Stub,
    Bar: Stub,
    ComposedChart: Stub,
    XAxis: Stub,
    YAxis: Stub,
    CartesianGrid: Stub,
    Tooltip: Stub,
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
    ReferenceDot: Stub,
    Label: ({ value }: { value?: React.ReactNode }) => <span>{value}</span>,
  };
});

// Replace the Radix Select with a simple, render-everything shim. The
// real Radix popover is awkward to drive in jsdom (portals,
// pointerDown, etc.). This shim keeps the page's `value` /
// `onValueChange` contract intact and exposes every SelectItem and the
// SelectContent's children (incl. the "No planned items this month"
// fallback) directly in the DOM so tests can assert order + presence.
vi.mock("@/components/ui/select", () => {
  type SelectProps = {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  };
  return {
    Select: ({ value, onValueChange, children }: SelectProps) => (
      <div
        data-testid="mock-select"
        data-value={value ?? ""}
        data-onchange={onValueChange ? "true" : undefined}
      >
        {React.Children.map(children, (child) => {
          if (!React.isValidElement(child)) return child;
          // Inject onValueChange into descendants by cloning SelectItems
          // when found. Simpler: just render children as-is and let
          // tests use fireEvent on items directly.
          return child;
        })}
        {/* Hidden helper so tests can drive onValueChange */}
        <button
          type="button"
          data-testid="mock-select-fire"
          onClick={(e) => {
            const v = (e.currentTarget as HTMLButtonElement).dataset.value;
            if (v != null) onValueChange?.(v);
          }}
          style={{ display: "none" }}
        />
      </div>
    ),
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="mock-select-trigger">{children}</div>
    ),
    SelectContent: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="mock-select-content">{children}</div>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => (
      <span>{placeholder}</span>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children?: React.ReactNode;
    }) => (
      <div data-testid="mock-select-item" data-value={value} role="option">
        {children}
      </div>
    ),
    SelectGroup: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectLabel: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectSeparator: () => <div />,
    SelectScrollUpButton: () => null,
    SelectScrollDownButton: () => null,
  };
});

type ForecastEvent = {
  date: string;
  itemId: string;
  label: string;
  kind: "income" | "expense";
  amount: number;
};
type ForecastTxn = {
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  forecastFlag: boolean;
  categoryId?: string | null;
  source?: string;
  plaidAccountId?: string | null;
};
type ForecastResolution = {
  id: string;
  recurringItemId: string | null;
  occurrenceDate: string | null;
  status: string;
  matchedTxnId: string | null;
};

const FORECAST_BASE = {
  fromDate: "2026-04-01",
  toDate: "2026-08-01",
  events: [] as ForecastEvent[],
  transactions: [] as ForecastTxn[],
  resolutions: [] as ForecastResolution[],
  closedMonths: [] as string[],
  monthSnapshots: {},
  bankSnapshot: null,
  plaidCheckingAccounts: [],
  settings: { startingBalance: "1000", cashBuffer: "500" },
};

let forecastData: typeof FORECAST_BASE = { ...FORECAST_BASE };
const upsertMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  const empty = { data: [], isLoading: false };
  return {
    useGetForecast: () => ({ data: forecastData, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: undefined, isLoading: false }),
    useUpsertForecastResolution: () => ({
      mutate: (vars: unknown, opts?: { onSuccess?: () => void }) => {
        upsertMutate(vars);
        opts?.onSuccess?.();
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
    useListCategories: () => empty,
    useListDebts: () => empty,
    useListRecurringItems: () => empty,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
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

const BANK_TXN: ForecastTxn = {
  id: "txn_inbox_1",
  occurredOn: "2026-05-12",
  description: "Acme Charge",
  amount: "-50",
  forecastFlag: true,
  source: "manual",
  plaidAccountId: null,
};

function buildPlanEvent(
  itemId: string,
  date: string,
  amount: number,
): ForecastEvent {
  return { itemId, date, label: itemId, kind: "expense", amount };
}

/** Pull only the per-card plan dropdown items off the page. The page
 *  has many Selects (month filter, etc.); the bank-card "Choose a
 *  planned" Select is the only one whose options use the
 *  `${itemId}|${YYYY-MM-DD}` value shape. */
function getPlanDropdownOptions(): HTMLElement[] {
  const all = screen.queryAllByTestId("mock-select-item");
  return all.filter((el) =>
    /\|\d{4}-\d{2}-\d{2}$/.test(el.getAttribute("data-value") ?? ""),
  );
}

beforeEach(() => {
  cleanup();
  forecastData = { ...FORECAST_BASE };
  upsertMutate.mockClear();
  // Anchor "today" at May 11, 2026 — same as the unit-test fixture so
  // end-of-month (May 31) > today + 21d (Jun 1), meaning a Jun 1 plan
  // is in-window but Jun 2 is not. Use modern fake timers so
  // `useMemo(() => new Date(), [])` inside the page sees this date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 11, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Forecast — per-card 'Choose a planned' dropdown filter (#463)", () => {
  it("trims the dropdown to current-ish, unmatched plans in best-match order", () => {
    forecastData = {
      ...FORECAST_BASE,
      events: [
        // Prior month → excluded by filterDropdownPlans (before start of month).
        buildPlanEvent("rent-apr", "2026-04-30", -50),
        // Current month → included.
        buildPlanEvent("netflix", "2026-05-15", -50),
        // Next month but within today+21d (today=May 11 → Jun 1) → included.
        buildPlanEvent("ps-jun", "2026-06-01", -50),
        // Further out than max(end of month, today+21d) → excluded.
        buildPlanEvent("vacation", "2026-07-15", -50),
        // Already matched to another bank txn → excluded by status filter
        // (and as a defensive backstop, by filterDropdownPlans's matchedTxnId
        // check).
        buildPlanEvent("electric", "2026-05-20", -50),
      ],
      transactions: [
        BANK_TXN,
        // The "other" bank txn that 'electric' is already matched to.
        {
          id: "txn_other",
          occurredOn: "2026-05-20",
          description: "Electric Co",
          amount: "-50",
          forecastFlag: true,
          source: "manual",
          plaidAccountId: null,
        },
      ],
      resolutions: [
        {
          id: "res_electric",
          recurringItemId: "electric",
          occurrenceDate: "2026-05-20",
          status: "matched",
          matchedTxnId: "txn_other",
        },
      ],
    };

    renderPage();

    const options = getPlanDropdownOptions();
    const values = options.map((o) => o.getAttribute("data-value"));

    // Expected: only netflix (May 15) and ps-jun (Jun 1), in that order.
    // Bank card date is May 12 → netflix (3d away) ranks above ps-jun
    // (20d away) when amount delta ties at 0.
    expect(values).toEqual([
      "netflix|2026-05-15",
      "ps-jun|2026-06-01",
    ]);

    // Sanity: each excluded item really is missing.
    expect(values).not.toContain("rent-apr|2026-04-30");
    expect(values).not.toContain("vacation|2026-07-15");
    expect(values).not.toContain("electric|2026-05-20");
  });

  it("shows the 'No planned items this month' fallback and keeps Unplanned working", () => {
    forecastData = {
      ...FORECAST_BASE,
      events: [
        // Both intentionally outside the dropdown window so the filter
        // returns []. Prior month + far-future cover both edges.
        buildPlanEvent("rent-apr", "2026-04-30", -50),
        buildPlanEvent("vacation", "2026-07-15", -50),
      ],
      transactions: [BANK_TXN],
      resolutions: [],
    };

    renderPage();

    const options = getPlanDropdownOptions();
    expect(options).toEqual([]);

    expect(screen.getByText("No planned items this month")).toBeTruthy();

    // The "Unplanned" affordance still works on a card with no plan
    // candidates — clicking it fires the upsert mutation with the
    // ignored_unforecasted status for this bank txn.
    const card = screen.getByText("Acme Charge").closest("div.rounded-md");
    expect(card).not.toBeNull();
    const unplannedBtn = within(card as HTMLElement).getByRole("button", {
      name: "Unplanned",
    });
    fireEvent.click(unplannedBtn);

    expect(upsertMutate).toHaveBeenCalledWith({
      data: {
        status: "ignored_unforecasted",
        matchedTxnId: BANK_TXN.id,
      },
    });
  });
});
