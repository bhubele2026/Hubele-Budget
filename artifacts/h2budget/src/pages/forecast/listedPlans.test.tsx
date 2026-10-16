import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ⭐ (T3) The lists the cash signal returns beside the curve are on screen and
// answer with the page's own handlers: every write sends the OCCURRENCE key
// (never the moved-to or due date when they differ) and offers Undo.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;

vi.mock("wouter", () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => <a {...rest}>{children}</a>,
}));
vi.mock("@/components/plaid-reauth-banner", () => ({ PlaidReauthBanner: () => null }));
vi.mock("@/components/avalanche-schedule-card", () => ({ AvalancheScheduleCard: () => null }));
vi.mock("@dnd-kit/core", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    DndContext: Passthrough,
    DragOverlay: Passthrough,
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
    ResponsiveContainer: Stub, AreaChart: Stub, Area: Stub, XAxis: Stub, YAxis: Stub, CartesianGrid: Stub,
    Tooltip: Stub, ReferenceLine: Stub, ReferenceDot: Stub, ReferenceArea: Stub, Label: Stub,
  };
});

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const upsertMutate = vi.fn((_args: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) => {
  opts?.onSuccess?.({ id: "new-resolution-id" });
});
const deleteMutate = vi.fn((_args: unknown, opts?: { onSuccess?: () => void }) => {
  opts?.onSuccess?.();
});

const FORECAST = {
  fromDate: "2026-06-01", toDate: "2026-07-10", today: "2026-06-10",
  events: [], transactions: [
    { id: "t-water", description: "City water", occurredOn: "2026-06-06", amount: "-60.00" },
  ],
  resolutions: [], closedMonths: [], monthSnapshots: {}, bankSnapshot: null, plaidCheckingAccounts: [],
  settings: { startingBalance: "1000", cashBuffer: "500" },
};
const SIGNAL = {
  status: "ready", bankToday: "1000.00", startingBalance: "1000.00", endingBalance: "900.00", endingDate: "2026-07-10",
  fromDate: "2026-06-10", toDate: "2026-07-10", projectedIncome: "0.00", projectedExpenses: "100.00", acceptedImpact: "0.00",
  lowestProjected: "900.00", lowestDate: "2026-06-11", cashBuffer: "500.00", horizonDays: 30,
  account: { rowId: "acct-row-1", externalId: "ext-1", name: "Test Checking", mask: "0000", subtype: "checking", via: "pointer" },
  daily: [{ date: "2026-06-10", balance: "1000.00" }, { date: "2026-06-11", balance: "900.00" }],
  // A carried bill MOVED to 06-08 from its 06-03 occurrence: actions send 06-03.
  events: [
    { date: "2026-06-11", label: "Phone", amount: "-100.00", itemId: "phone", originalDate: "2026-06-08", occurrenceDate: "2026-06-03", occurrenceKey: "phone|2026-06-03", assumption: "overdue_assumed_unpaid" },
  ],
  dayItems: [],
  matches: [
    { planKey: "water|2026-06-05", planItemId: "water", planDate: "2026-06-05", txnId: "t-water", planAmount: "-60.00", txnAmount: "-60.00", difference: "0.00", dayDelta: 1, confidence: "high", ambiguous: false, tier: 1, offCurve: false, remainderAmount: "0.00" },
  ],
  overdueAssumedPaid: [
    { planKey: "water|2026-06-05", itemId: "water", occurrenceDate: "2026-06-05", dueDate: "2026-06-05", label: "Water", daysOverdue: 5, planAmount: "-60.00", txnId: "t-water", txnAmount: "-60.00", confidence: "high", unpaidRemainder: "0.00" },
  ],
  // An old bill MOVED from its 04-28 occurrence to be due 05-02: actions send 04-28.
  overdueOutsideForecast: [
    { planKey: "gym|2026-04-28", itemId: "gym", occurrenceDate: "2026-04-28", dueDate: "2026-05-02", amount: "-40.00", label: "Gym", daysOverdue: 39 },
  ],
  incomeNotArrived: [
    { planKey: "bonus|2026-06-01", itemId: "bonus", occurrenceDate: "2026-06-01", dueDate: "2026-06-01", amount: "300.00", label: "Bonus", daysOverdue: 9 },
  ],
};

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({ mutate: () => {}, mutateAsync: async () => undefined, isPending: false });
  return {
    useGetForecast: () => ({ data: FORECAST, isLoading: false }),
    useGetForecastCashSignal: () => ({ data: SIGNAL, isLoading: false }),
    useUpsertForecastResolution: () => ({ mutate: upsertMutate, mutateAsync: async () => undefined, isPending: false }),
    useDeleteForecastResolution: () => ({ mutate: deleteMutate, mutateAsync: async () => undefined, isPending: false }),
    useCloseForecastMonth: noopMutation, useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation, useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation, useRefreshForecastBank: noopMutation,
    useListCategories: () => ({ data: [], isLoading: false }), useListDebts: () => ({ data: [], isLoading: false }),
    useListRecurringItems: () => ({ data: [], isLoading: false }), useCreateRecurringItem: noopMutation,
    useGetAvalancheSettings: () => ({ data: undefined }), useGetAvalancheExtra: () => ({ data: undefined }),
    getGetForecastQueryKey: () => ["forecast"], getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"], getListRecurringItemsQueryKey: () => ["recurring-items"],
    getGetBillsSummaryQueryKey: () => ["bills-summary"], getGetDashboardQueryKey: () => ["dashboard"],
  };
});
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: undefined, isLoading: false, isFetching: false, state: "cold", error: null, updatedAt: null, refetch: () => {} }),
}));

import ForecastPage from "../forecast";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForecastPage mode="overall" />
    </QueryClientProvider>,
  );
}

/** The last toast's Undo action, rendered so its test id and click can be read. */
function lastUndo(): HTMLElement {
  const call = toastMock.mock.calls.at(-1)![0] as { action?: React.ReactElement };
  expect(call.action).toBeTruthy();
  const { container } = render(<>{call.action}</>);
  return container.firstElementChild as HTMLElement;
}

beforeEach(() => {
  cleanup();
  toastMock.mockClear();
  upsertMutate.mockClear();
  deleteMutate.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/forecast");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-06-10T15:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const sent = () => (upsertMutate.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;

describe("T3 — Unpaid items, Paid by a bank row, Older than 14 days, Income not arrived", () => {
  it("lists every group with its count, each in its own card or group", () => {
    renderPage();
    const unpaid = screen.getByTestId("card-dragging-plans-summary");
    expect(unpaid.id).toBe("forecast-unpaid");
    expect(within(unpaid).getByTestId("dragging-plans-list").children).toHaveLength(1);
    expect(within(unpaid).getByTestId("assumed-paid-list").children).toHaveLength(1);
    expect(within(unpaid).getByTestId("older-unpaid-list").children).toHaveLength(1);
    expect(screen.getByTestId("older-unpaid-group").id).toBe("forecast-older-unpaid");
    const income = screen.getByTestId("card-income-not-arrived");
    expect(income.id).toBe("forecast-income-not-arrived");
    expect(within(income).getByText("1 · off the curve")).toBeTruthy();
    expect(within(income).getByTestId("income-plan-bonus-2026-06-01").textContent).toContain("$300.00");
  });

  it("a carried bill's Mark missed and Skip send its occurrence date, with Undo", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("dragging-plan-mark-missed-phone-2026-06-08"));
    expect(sent()).toMatchObject({ status: "missed", recurringItemId: "phone", occurrenceDate: "2026-06-03" });
    expect(lastUndo().getAttribute("data-testid")).toBe("toast-undo-mark-missed");
    fireEvent.click(screen.getByTestId("dragging-plan-skip-phone-2026-06-08"));
    expect(sent()).toMatchObject({ status: "skipped", recurringItemId: "phone", occurrenceDate: "2026-06-03" });
    expect(lastUndo().getAttribute("data-testid")).toBe("toast-undo-skip-dragging");
  });

  it("an older-than-14-days bill answers with its occurrence date, not its due date, with Undo", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("older-plan-mark-missed-gym-2026-05-02"));
    expect(sent()).toMatchObject({ status: "missed", recurringItemId: "gym", occurrenceDate: "2026-04-28" });
    const undo = lastUndo();
    expect(undo.getAttribute("data-testid")).toBe("toast-undo-mark-missed");
    fireEvent.click(undo);
    expect(deleteMutate).toHaveBeenCalledWith({ id: "new-resolution-id" }, expect.anything());
    fireEvent.click(screen.getByTestId("older-plan-skip-gym-2026-05-02"));
    expect(sent()).toMatchObject({ status: "skipped", recurringItemId: "gym", occurrenceDate: "2026-04-28" });
    expect(lastUndo().getAttribute("data-testid")).toBe("toast-undo-skip-dragging");
  });

  it("income that didn't arrive: 'Didn't arrive' is the missed answer for it, with Undo", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("income-plan-mark-missed-bonus-2026-06-01"));
    expect(sent()).toMatchObject({ status: "missed", recurringItemId: "bonus", occurrenceDate: "2026-06-01" });
    expect(lastUndo().getAttribute("data-testid")).toBe("toast-undo-mark-missed");
  });

  it("'Not this' on a bill paid by a bank row rejects that pair (the plan goes back on the curve), with Undo", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("assumed-paid-not-this-water-2026-06-05"));
    expect(sent()).toMatchObject({ status: "not_match", recurringItemId: "water", occurrenceDate: "2026-06-05", matchedTxnId: "t-water" });
    const call = toastMock.mock.calls.at(-1)![0] as { title: string };
    expect(call.title).toBe("Not this row");
    expect(lastUndo().getAttribute("data-testid")).toBe("toast-undo-not_match");
  });
});
