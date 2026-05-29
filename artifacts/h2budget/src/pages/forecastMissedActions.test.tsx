import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (#480) Forecast Missed-bucket affordances:
//   1. Each pending plan row shows an explicit "Mark missed" button that
//      moves the row into the Missed bucket without a blocking
//      `window.confirm()`.
//   2. The Missed bucket exposes "Set new date" (opens the existing
//      Move-to dialog and reschedules the occurrence) and "Skip"
//      (persists a `skipped` resolution that clears the row from the
//      register, the bucket, and the projection).

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
  useLocation: () => ["/forecast", () => {}],
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

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

// Mutation spies. `useUpsertForecastResolution.mutate` invokes
// `onSuccess(createdRow)` synchronously so the toast/Undo wiring is
// exercised end-to-end.
const upsertMutate = vi.fn(
  (
    _args: unknown,
    opts?: {
      onSuccess?: (data: { id: string }) => void;
      onError?: (e: unknown) => void;
    },
  ) => {
    opts?.onSuccess?.({ id: "new-resolution-id" });
  },
);
const deleteMutate = vi.fn(
  (
    _args: unknown,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void },
  ) => {
    opts?.onSuccess?.();
  },
);

const FORECAST_BASE = {
  fromDate: "2026-05-01",
  toDate: "2026-08-01",
  // One pending plan row (Rent) and one already-missed row (Gym) so we
  // can exercise both flows in one fixture.
  events: [
    { itemId: "rent", date: "2026-05-30", label: "Rent", amount: -1500 },
    { itemId: "gym", date: "2026-05-03", label: "Gym", amount: -40 },
    // (#888) A still-upcoming plan row late in the active month. With
    // "today" = 2026-05-29 this sits inside the today..+30 window, so it can
    // be pulled EARLIER (to 2026-05-30) — the case the new window rule adds.
    { itemId: "heloc", date: "2026-05-31", label: "HELOC", amount: -800 },
  ],
  transactions: [],
  resolutions: [
    {
      id: "res-gym-missed",
      recurringItemId: "gym",
      occurrenceDate: "2026-05-03",
      status: "missed",
      matchedTxnId: null,
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
    useDeleteForecastResolution: () => ({
      mutate: deleteMutate,
      mutateAsync: async () => undefined,
      isPending: false,
    }),
    useCloseForecastMonth: noopMutation,
    useReopenForecastMonth: noopMutation,
    useUpdateForecastSettings: noopMutation,
    useUpdateTransaction: noopMutation,
    useSetForecastBankSnapshot: noopMutation,
    useRefreshForecastBank: noopMutation,
    useSyncPlaidTransactions: noopMutation,
    getListPlaidItemsQueryKey: () => ["plaid-items"],
    useListCategories: () => ({ data: [], isLoading: false }),
    useListDebts: () => ({ data: [], isLoading: false }),
    useListRecurringItems: () => ({ data: [], isLoading: false }),
    useCreateRecurringItem: noopMutation,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    getGetForecastQueryKey: () => ["forecast"],
    getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
    getListRecurringItemsQueryKey: () => ["recurring-items"],
    getGetBillsSummaryQueryKey: () => ["bills-summary"],
    getGetDashboardQueryKey: () => ["dashboard"],
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
  toastMock.mockClear();
  upsertMutate.mockClear();
  deleteMutate.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  // Pin the active month to May 2026 so the May fixture's bucket is the
  // one rendered.
  sessionStorage.setItem("h2budget:forecastFromDate", "2026-05-01");
});

describe("Forecast — Missed bucket actions (#480)", () => {
  it("renders the per-row Mark missed button on a pending plan row", () => {
    renderPage();
    const btn = screen.getByTestId("mark-missed-rent-2026-05-30");
    expect(btn.textContent ?? "").toMatch(/Mark missed/i);
  });

  it("clicking Mark missed upserts a missed resolution (no browser confirm) and surfaces an Undo toast", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("mark-missed-rent-2026-05-30"));
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate.mock.calls[0][0]).toMatchObject({
      data: {
        status: "missed",
        recurringItemId: "rent",
        occurrenceDate: "2026-05-30",
      },
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
    const call = toastMock.mock.calls[0][0];
    expect(String(call.title)).toMatch(/Marked missed/i);
    // The toast carries an Undo action wired to the new resolution id.
    expect(call.action).toBeTruthy();
  });

  it("renders Set new date and Skip buttons on the missed bucket row", () => {
    renderPage();
    expect(screen.getByTestId("missed-set-new-date-res-gym-missed")).toBeTruthy();
    expect(screen.getByTestId("missed-skip-res-gym-missed")).toBeTruthy();
    expect(screen.getByTestId("missed-undo-res-gym-missed")).toBeTruthy();
  });

  it("Set new date opens the Move dialog and saving with a future date upserts a rescheduled resolution", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("missed-set-new-date-res-gym-missed"));
    const dateInput = screen.getByTestId("input-move-date") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-06-15" } });
    fireEvent.click(screen.getByTestId("button-save-move"));
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate.mock.calls[0][0]).toMatchObject({
      data: {
        status: "rescheduled",
        recurringItemId: "gym",
        occurrenceDate: "2026-05-03",
        rescheduledTo: "2026-06-15",
      },
    });
  });

  it("(#888) Set new date rejects dates outside the today..+30 window", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("missed-set-new-date-res-gym-missed"));
    const dateInput = screen.getByTestId("input-move-date") as HTMLInputElement;
    // 2026-05-03 is before "today" (2026-05-29) → outside the window.
    fireEvent.change(dateInput, { target: { value: "2026-05-03" } });
    fireEvent.click(screen.getByTestId("button-save-move"));
    expect(upsertMutate).not.toHaveBeenCalled();
    const err = screen.getByTestId("move-error");
    expect(err.textContent ?? "").toMatch(/within the next 30 days/i);
  });

  it("(#888) moves an upcoming occurrence EARLIER within the window and only upserts a one-off resolution (template untouched)", () => {
    renderPage();
    // HELOC is planned for 2026-05-31; pull it back to 2026-05-30 — earlier
    // than the original, but still inside the today..+30 window.
    fireEvent.click(screen.getByTestId("move-plan-heloc-2026-05-31"));
    const dateInput = screen.getByTestId("input-move-date") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-05-30" } });
    fireEvent.click(screen.getByTestId("button-save-move"));
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    // It writes a one-off `rescheduled` resolution keyed to the original
    // occurrence — it never edits the recurring template.
    expect(upsertMutate.mock.calls[0][0]).toMatchObject({
      data: {
        status: "rescheduled",
        recurringItemId: "heloc",
        occurrenceDate: "2026-05-31",
        rescheduledTo: "2026-05-30",
      },
    });
  });

  it("Skip upserts a `skipped` resolution and surfaces an Undo toast wired to delete it", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("missed-skip-res-gym-missed"));
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate.mock.calls[0][0]).toMatchObject({
      data: {
        status: "skipped",
        recurringItemId: "gym",
        occurrenceDate: "2026-05-03",
      },
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
    const call = toastMock.mock.calls[0][0];
    expect(String(call.title)).toMatch(/Skipped/i);
    // Render the toast's action element and click it — Undo must call
    // delete on the freshly-created resolution id.
    expect(call.action).toBeTruthy();
    const { container } = render(<>{call.action}</>);
    const undoBtn = container.querySelector(
      '[data-testid="toast-undo-skip"]',
    ) as HTMLButtonElement | null;
    expect(undoBtn).not.toBeNull();
    act(() => {
      undoBtn!.click();
    });
    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0][0]).toMatchObject({
      id: "new-resolution-id",
    });
  });
});
