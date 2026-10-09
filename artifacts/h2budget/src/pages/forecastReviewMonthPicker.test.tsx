import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (C13, parity D8, owner OK) `/review` has a month picker.
 *
 * Before the cut-over the review inbox always listed the current month
 * (`monthFilter` was only settable from the overall page's month block), so a
 * pending bank row from an earlier month never reached Review. The register
 * now carries the same picker (`select-month-filter`) at its head in review
 * mode; picking a month lists that month's pending rows. It changes which rows
 * are listed only — no figure is computed from it.
 */

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

vi.mock("wouter", () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => <a {...rest}>{children}</a>,
}));

vi.mock("@/components/plaid-reauth-banner", () => ({
  PlaidReauthBanner: () => null,
}));

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
    Tooltip: Stub, ReferenceLine: Stub, ReferenceDot: Stub, ReferenceArea: Stub,
    Label: ({ value }: { value?: React.ReactNode }) => <span>{value}</span>,
  };
});

// Each Radix Select becomes a native <select> wrapping its trigger (which
// keeps its test id) and its options, so the month picker can be driven in
// jsdom with a change event.
vi.mock("@/components/ui/select", () => {
  function Select({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children?: React.ReactNode }) {
    return (
      <select value={value ?? ""} onChange={(e) => onValueChange?.(e.target.value)}>
        {children}
      </select>
    );
  }
  const SelectTrigger = ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => <div {...rest}>{children}</div>;
  const SelectValue = () => null;
  const SelectContent = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const SelectItem = ({ value, children }: { value: string; children?: React.ReactNode }) => (
    <option value={value}>{React.Children.toArray(children).join("")}</option>
  );
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

const txn = (id: string, occurredOn: string, description: string, amount: string) => ({
  id,
  occurredOn,
  description,
  amount,
  forecastFlag: true,
  source: "manual",
  plaidAccountId: null,
});

const FORECAST = {
  fromDate: "2026-04-01",
  toDate: "2026-08-01",
  events: [{ itemId: "rent", date: "2026-05-20", label: "Rent", kind: "expense", amount: -1500 }],
  transactions: [
    txn("txn_apr", "2026-04-20", "April Hardware", "-61.93"),
    txn("txn_may", "2026-05-12", "May Pizza", "-23"),
  ],
  resolutions: [],
  closedMonths: [],
  monthSnapshots: {},
  bankSnapshot: null,
  plaidCheckingAccounts: [],
  settings: { startingBalance: "1000", cashBuffer: "500" },
};

vi.mock("@workspace/api-client-react", () => {
  const noopMutation = () => ({ mutate: () => {}, mutateAsync: async () => undefined, isPending: false });
  const empty = { data: [], isLoading: false };
  return {
    useGetForecast: () => ({ data: FORECAST, isLoading: false }),
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
    useListCategories: () => empty,
    useListDebts: () => empty,
    useListRecurringItems: () => empty,
    useGetAvalancheSettings: () => ({ data: undefined }),
    useGetAvalancheExtra: () => ({ data: undefined }),
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    getGetForecastQueryKey: () => ["forecast"],
    getGetForecastCashSignalQueryKey: () => ["forecast-cash-signal"],
    getListTransactionsQueryKey: () => ["transactions"],
  };
});

vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: undefined, isLoading: false, isFetching: false, state: "cold", error: null, updatedAt: null, refetch: () => {} }),
}));

import ForecastPage from "./forecast";

function renderPage(mode: "review" | "overall") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForecastPage mode={mode} />
    </QueryClientProvider>,
  );
}

const monthSelect = () => screen.getByTestId("select-month-filter").closest("select") as HTMLSelectElement;
const fromChaseHeading = () =>
  screen.getByRole("heading", { level: 2, name: /^From Chase · / }).textContent;

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  // Today is 2026-05-11: May is the register's default month.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 4, 11, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/review month picker (C13, D8)", () => {
  it("sits at the head of the register, before the From-Chase card, on the current month", () => {
    renderPage("review");
    const row = screen.getByTestId("review-month-row");
    const card = screen.getByTestId("card-from-bank");
    expect(row.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.contains(screen.getByTestId("select-month-filter"))).toBe(true);
    expect(monthSelect().value).toBe("2026-05");
    // The earlier month is offered (current + 6 prior + every register month).
    expect(Array.from(monthSelect().options).map((o) => o.value)).toContain("2026-04");
    expect(fromChaseHeading()).toBe("From Chase · 2026-05");
    expect(screen.getByTestId("select-bank-txn_may")).toBeTruthy();
    expect(screen.queryByTestId("select-bank-txn_apr")).toBeNull();
  });

  it("picking an earlier month lists that month's pending bank rows in the inbox", async () => {
    renderPage("review");
    fireEvent.change(monthSelect(), { target: { value: "2026-04" } });
    await waitFor(() => expect(screen.getByTestId("select-bank-txn_apr")).toBeTruthy());
    expect(screen.queryByTestId("select-bank-txn_may")).toBeNull();
    expect(fromChaseHeading()).toBe("From Chase · 2026-04");
  });

  it("the overall page keeps exactly one month picker (in the month block), not a second one", () => {
    renderPage("overall");
    expect(screen.getAllByTestId("select-month-filter")).toHaveLength(1);
    expect(screen.queryByTestId("review-month-row")).toBeNull();
  });
});
