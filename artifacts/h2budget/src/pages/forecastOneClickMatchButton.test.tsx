import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #473: end-to-end UI coverage for the per-card "Match" button on
// the Forecast page. The pure picker `pickOneClickBankMatches` already
// has unit coverage in `forecastOneClickMatch.test.ts`, but the wiring
// in `InboxCardView` (button render + Enter-key shortcut + click →
// upsert mutation) is only exercised here. A regression in how the
// page consumes the picker would otherwise slip past tests.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

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

// Same Radix Select shim used by the sibling dropdown test. We don't
// need to drive the dropdown here; we just need its render to not
// crash in jsdom.
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
        {children}
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
    useCreateRecurringItem: noopMutation,
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
      <ForecastPage mode="review" />
    </QueryClientProvider>,
  );
}

function buildPlanEvent(
  itemId: string,
  date: string,
  amount: number,
): ForecastEvent {
  return { itemId, date, label: itemId, kind: "expense", amount };
}

function buildBankTxn(
  id: string,
  date: string,
  description: string,
  amount: string,
): ForecastTxn {
  return {
    id,
    occurredOn: date,
    description,
    amount,
    forecastFlag: true,
    source: "manual",
    plaidAccountId: null,
  };
}

beforeEach(() => {
  cleanup();
  forecastData = { ...FORECAST_BASE };
  upsertMutate.mockClear();
  // Anchor "today" at May 11, 2026 so the May 2026 month is the active
  // month filter. Mirrors the sibling dropdown test's clock setup.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 11, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Forecast — per-card 'Match' one-click button (#473)", () => {
  it("renders the Match button for the sole high-confidence card and confirms via click", () => {
    // Two pending bank cards in May 2026:
    //  - txn_inbox_1: $-50 on 5/12, with one exact-amount plan within 5d
    //    → high-confidence, sole, uncontested → qualifies for one-click.
    //  - txn_inbox_2: $-23 on 5/12, only candidate is a $-30 plan within
    //    14d → relDelta 0.30 → low-confidence → does NOT qualify.
    forecastData = {
      ...FORECAST_BASE,
      events: [
        // Exact-amount, 3 days away from txn_inbox_1 → high confidence.
        buildPlanEvent("netflix", "2026-05-15", -50),
        // For txn_inbox_2: amount off by $7, no label overlap → low.
        buildPlanEvent("phone-bill", "2026-05-13", -30),
      ],
      transactions: [
        buildBankTxn("txn_inbox_1", "2026-05-12", "Acme Charge", "-50"),
        buildBankTxn("txn_inbox_2", "2026-05-12", "Random Pizza", "-23"),
      ],
      resolutions: [],
    };

    renderPage();

    // Positive path: the qualifying card renders the Match button.
    const matchBtn = screen.getByTestId("one-click-match-txn_inbox_1");
    expect(matchBtn).toBeTruthy();
    expect(matchBtn.textContent).toContain("Match");
    expect(matchBtn.getAttribute("aria-keyshortcuts")).toBe("Enter");

    // Negative path: the low-confidence card does NOT render a Match
    // button — the dropdown remains the only path.
    expect(screen.queryByTestId("one-click-match-txn_inbox_2")).toBeNull();

    // Clicking the Match button fires the upsert mutation with the
    // matched status and the right plan + txn ids.
    fireEvent.click(matchBtn);
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate).toHaveBeenCalledWith({
      data: {
        status: "matched",
        recurringItemId: "netflix",
        occurrenceDate: "2026-05-15",
        matchedTxnId: "txn_inbox_1",
      },
    });
  });

  it("confirms via the Enter-key shortcut on the focused card", () => {
    forecastData = {
      ...FORECAST_BASE,
      events: [buildPlanEvent("netflix", "2026-05-15", -50)],
      transactions: [
        buildBankTxn("txn_inbox_1", "2026-05-12", "Acme Charge", "-50"),
      ],
      resolutions: [],
    };

    renderPage();

    // The qualifying card is focusable and exposes the Enter shortcut.
    const cardRoot = screen.getByTestId("inbox-card-txn_inbox_1");
    expect(cardRoot.getAttribute("tabindex")).toBe("0");
    expect(cardRoot.getAttribute("aria-keyshortcuts")).toBe("Enter");

    // Pressing Enter on the card root fires the same upsert payload as
    // clicking the Match button — the keyboard shortcut and the button
    // share `oneClickSuggestion`.
    fireEvent.keyDown(cardRoot, { key: "Enter" });
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate).toHaveBeenCalledWith({
      data: {
        status: "matched",
        recurringItemId: "netflix",
        occurrenceDate: "2026-05-15",
        matchedTxnId: "txn_inbox_1",
      },
    });
  });

  it("does NOT render the Match button when two cards contest the same high-confidence plan", () => {
    // Both bank cards have an exact-amount, in-window match against the
    // same plan (`netflix` on 5/15). The picker dedupes by plan key so
    // neither card qualifies — both must disambiguate via the dropdown.
    forecastData = {
      ...FORECAST_BASE,
      events: [buildPlanEvent("netflix", "2026-05-15", -50)],
      transactions: [
        buildBankTxn("txn_inbox_1", "2026-05-12", "Acme Charge", "-50"),
        buildBankTxn("txn_inbox_2", "2026-05-13", "Other Charge", "-50"),
      ],
      resolutions: [],
    };

    renderPage();

    // The pinned inbox pages through one row at a time. Confirm there
    // really are two contested rows in the inbox so the Match-button
    // assertions below reflect the picker's contest gate, not just an
    // empty inbox. Page through both and assert neither shows Match.
    expect(screen.getByTestId("bank-inbox-pager-indicator").textContent).toBe(
      "1 of 2",
    );

    // First card (txn_inbox_1) is the visible one; no Match button.
    expect(screen.queryByTestId("one-click-match-txn_inbox_1")).toBeNull();
    expect(
      screen.getByTestId("inbox-card-draggable-txn_inbox_1").getAttribute(
        "aria-keyshortcuts",
      ),
    ).toBeNull();

    // Advance the pager to the second card and confirm the same.
    fireEvent.click(screen.getByTestId("bank-inbox-pager-next"));
    expect(screen.getByTestId("bank-inbox-pager-indicator").textContent).toBe(
      "2 of 2",
    );
    expect(screen.queryByTestId("one-click-match-txn_inbox_2")).toBeNull();
    expect(
      screen.getByTestId("inbox-card-draggable-txn_inbox_2").getAttribute(
        "aria-keyshortcuts",
      ),
    ).toBeNull();

    // And nothing was matched in the process.
    expect(upsertMutate).not.toHaveBeenCalled();
  });
});
