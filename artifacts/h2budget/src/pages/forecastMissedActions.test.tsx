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
    { itemId: "rent", date: "2026-05-10", label: "Rent", amount: -1500 },
    { itemId: "gym", date: "2026-05-03", label: "Gym", amount: -40 },
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
    useListCategories: () => ({ data: [], isLoading: false }),
    useListDebts: () => ({ data: [], isLoading: false }),
    useListRecurringItems: () => ({ data: [], isLoading: false }),
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
    const btn = screen.getByTestId("mark-missed-rent-2026-05-10");
    expect(btn.textContent ?? "").toMatch(/Mark missed/i);
  });

  it("clicking Mark missed upserts a missed resolution (no browser confirm) and surfaces an Undo toast", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("mark-missed-rent-2026-05-10"));
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate.mock.calls[0][0]).toMatchObject({
      data: {
        status: "missed",
        recurringItemId: "rent",
        occurrenceDate: "2026-05-10",
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

  it("Set new date rejects past/today dates with the inline error", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("missed-set-new-date-res-gym-missed"));
    const dateInput = screen.getByTestId("input-move-date") as HTMLInputElement;
    // The original occurrence is 2026-05-03; pick a same-or-earlier date.
    fireEvent.change(dateInput, { target: { value: "2026-05-03" } });
    fireEvent.click(screen.getByTestId("button-save-move"));
    expect(upsertMutate).not.toHaveBeenCalled();
    const err = screen.getByTestId("move-error");
    expect(err.textContent ?? "").toMatch(/after today|after the original/i);
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
