import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #456 — drag any inbox expense onto a planned forecast row to clear
// (match) it, even when there's no auto-suggestion. This test exercises:
//   * the "no suggestion" inbox row carries an explicit drag-hint label,
//     so users discover the gesture,
//   * the planned-items list marks every eligible row with
//     `data-drop-eligible="true"` while a drag is in progress, so users
//     see where they can drop,
//   * dropping on an eligible plan row issues a `matched` resolution
//     against that occurrence (no confidence/score gating),
//   * dropping on an ineligible plan row (already matched) leaves state
//     untouched and surfaces a destructive rejection toast,
//   * the first-time hint above the inbox is dismissable and the
//     dismissal is remembered in localStorage.

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

// Capture the DndContext drag handlers so the test can drive a virtual
// drag without the jsdom pointer plumbing that real @dnd-kit needs.
const dndHandlers: {
  onDragStart?: (e: { active: { id: string; data: { current: unknown } } }) => void;
  onDragEnd?: (e: {
    active: { id: string; data: { current: unknown } };
    over: { id: string; data: { current: unknown } } | null;
  }) => void;
} = {};

vi.mock("@dnd-kit/core", () => {
  type Handlers = {
    onDragStart?: (e: unknown) => void;
    onDragEnd?: (e: unknown) => void;
    onDragCancel?: () => void;
    children?: React.ReactNode;
  };
  const DndContext = ({
    children,
    onDragStart,
    onDragEnd,
  }: Handlers) => {
    dndHandlers.onDragStart = onDragStart as typeof dndHandlers.onDragStart;
    dndHandlers.onDragEnd = onDragEnd as typeof dndHandlers.onDragEnd;
    return <div>{children}</div>;
  };
  const DragOverlay = ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  );
  return {
    DndContext,
    DragOverlay,
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

type ToastCall = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: string;
};
const toastMock = vi.fn<(opts: ToastCall) => { dismiss: () => void }>(() => ({
  dismiss: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

const upsertMutate = vi.fn();
const FORECAST_BASE = {
  fromDate: "2026-05-01",
  toDate: "2026-08-01",
  // Two pending/future plan rows so we can drop on one and ignore the other,
  // plus one already-matched row to exercise the rejection path.
  events: [
    { itemId: "rent", date: "2026-05-01", label: "Rent", amount: -1500 },
    { itemId: "gym", date: "2026-05-15", label: "Gym", amount: -40 },
    { itemId: "utilities", date: "2026-05-05", label: "Utilities", amount: -120 },
  ],
  // One bank txn that has NO good auto-suggestion ($999, far from any plan).
  transactions: [
    {
      id: "txn-mystery",
      occurredOn: "2026-05-10",
      description: "MYSTERY VENDOR",
      amount: "-999.00",
      forecastFlag: true,
      categoryId: null,
      source: "manual",
      plaidAccountId: null,
    },
  ],
  // Mark "utilities" as already matched so its row is rendered as ineligible.
  resolutions: [
    {
      id: "res-utilities",
      recurringItemId: "utilities",
      occurrenceDate: "2026-05-05",
      status: "matched",
      matchedTxnId: "txn-other",
      txnDate: "2026-05-05",
      txnDescription: "ELECTRIC CO",
      txnAmount: "-120.00",
      txnForecastFlag: true,
    },
  ],
  closedMonths: [],
  monthSnapshots: {},
  bankSnapshot: null,
  plaidCheckingAccounts: [],
  settings: { startingBalance: "5000", cashBuffer: "500" },
};

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => undefined,
    isPending: false,
  });
  return {
    useGetForecast: () => ({ data: FORECAST_BASE, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: undefined, isLoading: false }),
    useUpsertForecastResolution: () => ({
      mutate: upsertMutate,
      mutateAsync: async () => undefined,
      isPending: false,
    }),
    useDeleteForecastResolution: noopMutation,
    useCloseForecastMonth: noopMutation,
    useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation,
    useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation,
    useRefreshForecastBank: noopMutation,
    useListCategories: () => ({ data: [], isLoading: false }),
    useListDebts: () => ({ data: [], isLoading: false }),
    useListRecurringItems: () => ({ data: [], isLoading: false }),
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    useCreateRecurringItem: noopMutation,
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

function startDrag(cardId: string, txnId: string) {
  act(() => {
    dndHandlers.onDragStart?.({
      active: { id: cardId, data: { current: { txnId } } },
    });
  });
}
function endDrag(opts: {
  cardId: string;
  txnId: string;
  overId?: string;
  planRow?: unknown;
}) {
  act(() => {
    dndHandlers.onDragEnd?.({
      active: { id: opts.cardId, data: { current: { txnId: opts.txnId } } },
      over:
        opts.overId && opts.planRow
          ? {
              id: opts.overId,
              data: { current: { kind: "plan", planRow: opts.planRow } },
            }
          : null,
    });
  });
}

beforeEach(() => {
  cleanup();
  toastMock.mockClear();
  upsertMutate.mockClear();
  localStorage.clear();
  // The forecast register hides plan rows before `forecastFromDate`
  // (visibleFromISO), which defaults to today unless a stored past date +
  // look-back-open flag are present. The rent fixture lands on 2026-05-01,
  // before the frozen "today" of mid-May, so seed the from-date (mirroring
  // forecastBigBillJump) to keep the May-1 plan rows in the active window.
  sessionStorage.clear();
  sessionStorage.setItem("h2budget:forecastFromDate", "2026-05-01");
  sessionStorage.setItem("h2budget:forecastLookbackOpen", "true");
  // Anchor "today" inside May 2026 so the page's default monthFilter
  // (derived from `useMemo(() => new Date(), [])`) matches the May-2026
  // fixture and the planned rows under test render. Only Date is faked so
  // the synchronous dnd handlers and act() flushes keep working.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Forecast — drag inbox expense onto planned to match (#456)", () => {
  it("shows the discoverability hint on inbox rows with no one-click suggestion", () => {
    renderPage();
    // The mystery vendor row has no high-confidence suggestion, so it
    // surfaces the explicit drag hint.
    expect(
      screen.getByTestId("inbox-drag-hint-txn-mystery").textContent ?? "",
    ).toMatch(/Drag onto a planned item to match/i);
    // And the larger drag handle is present and labelled.
    const handle = screen.getByTestId("inbox-drag-handle-txn-mystery");
    expect(handle.getAttribute("aria-label")).toMatch(/Drag/i);
  });

  it("renders the dismissable first-time callout and persists dismissal", () => {
    renderPage();
    expect(screen.getByTestId("drag-to-match-hint")).toBeTruthy();
    fireEvent.click(screen.getByTestId("drag-to-match-hint-dismiss"));
    expect(screen.queryByTestId("drag-to-match-hint")).toBeNull();
    expect(localStorage.getItem("h2budget:forecastDragHintDismissed")).toBe(
      "1",
    );
    // Re-render: the callout stays dismissed.
    cleanup();
    renderPage();
    expect(screen.queryByTestId("drag-to-match-hint")).toBeNull();
  });

  it("marks every eligible plan row as a drop target while a drag is active", () => {
    renderPage();
    // Before any drag, plan rows have no drop-eligibility hint.
    const rent = screen.getByTestId("plan-row-rent-2026-05-01");
    const gym = screen.getByTestId("plan-row-gym-2026-05-15");
    expect(rent.getAttribute("data-drop-eligible")).toBeNull();
    expect(gym.getAttribute("data-drop-eligible")).toBeNull();

    startDrag("inbox-txn-mystery", "txn-mystery");
    const rentDuringDrag = screen.getByTestId("plan-row-rent-2026-05-01");
    const gymDuringDrag = screen.getByTestId("plan-row-gym-2026-05-15");
    expect(rentDuringDrag.getAttribute("data-drop-eligible")).toBe("true");
    expect(gymDuringDrag.getAttribute("data-drop-eligible")).toBe("true");
    // The already-matched utilities row is filtered out of the visible
    // plan list (`activePlan` keeps only pending/future), so it isn't
    // rendered as a `PlanDropRow` at all and can't be hovered. The
    // `onDragEnd` rejection branch is still exercised separately for
    // defence-in-depth — see the "already-matched" and "rescheduled"
    // tests below.
    expect(
      screen.queryByTestId("plan-row-utilities-2026-05-05"),
    ).toBeNull();
  });

  it("dropping a no-suggestion inbox row onto a plan row issues a matched resolution", () => {
    renderPage();
    const planRow = {
      kind: "plan",
      itemId: "rent",
      date: "2026-05-01",
      label: "Rent",
      amount: -1500,
      status: "pending_plan",
    };
    startDrag("inbox-txn-mystery", "txn-mystery");
    endDrag({
      cardId: "inbox-txn-mystery",
      txnId: "txn-mystery",
      overId: "plan:rent|2026-05-01",
      planRow,
    });
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    const [args] = upsertMutate.mock.calls[0];
    expect(args).toMatchObject({
      data: {
        status: "matched",
        recurringItemId: "rent",
        occurrenceDate: "2026-05-01",
        matchedTxnId: "txn-mystery",
      },
    });
  });

  it("dropping onto a non-eligible plan row (rescheduled) is rejected with no mutation and a destructive toast", () => {
    renderPage();
    // `rescheduled` is neither pending_plan nor future, so the drop must
    // be rejected by the same eligibility predicate the row visual uses.
    const planRow = {
      kind: "plan",
      itemId: "rent",
      date: "2026-05-01",
      label: "Rent",
      amount: -1500,
      status: "rescheduled",
    };
    startDrag("inbox-txn-mystery", "txn-mystery");
    endDrag({
      cardId: "inbox-txn-mystery",
      txnId: "txn-mystery",
      overId: "plan:rent|2026-05-01",
      planRow,
    });
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    const call = toastMock.mock.calls[0][0];
    expect(call.variant).toBe("destructive");
    expect(String(call.title)).toMatch(/Can't match here/i);
  });

  it("dropping onto an already-matched plan row leaves state unchanged and shows a rejection toast", () => {
    renderPage();
    const planRow = {
      kind: "plan",
      itemId: "utilities",
      date: "2026-05-05",
      label: "Utilities",
      amount: -120,
      status: "matched",
    };
    startDrag("inbox-txn-mystery", "txn-mystery");
    endDrag({
      cardId: "inbox-txn-mystery",
      txnId: "txn-mystery",
      overId: "plan:utilities|2026-05-05",
      planRow,
    });
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    const call = toastMock.mock.calls[0][0];
    expect(call.variant).toBe("destructive");
    expect(String(call.title)).toMatch(/Can't match here/i);
    expect(String(call.description)).toMatch(/already matched/i);
  });
});
