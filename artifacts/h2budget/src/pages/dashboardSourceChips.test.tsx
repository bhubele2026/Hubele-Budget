import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Transaction } from "@workspace/api-client-react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

vi.mock("@workspace/api-client-react", async () => {
  return {
    useListDashboardBudgets: () => ({ data: [{ amount: "0", isDefault: true }] }),
    useUpsertDashboardBudget: () => ({ mutate: () => {}, isPending: false }),
    useDeleteDashboardBudget: () => ({ mutate: () => {}, isPending: false }),
    getListDashboardBudgetsQueryKey: () => ["budgets"],
    useGetSettings: () => ({ data: undefined, isLoading: false }),
    // The WK/MO section (WeeklyMonthlySection) mounted by
    // DashboardMonthlyBuckets reads weekly settlements + the close/reopen
    // mutations; the mock must expose them or render throws.
    useListWeeklySettlements: () => ({ data: [], isLoading: false }),
    useCloseOutWeek: () => ({
      mutate: () => {},
      mutateAsync: async () => undefined,
      isPending: false,
    }),
    useReopenWeek: () => ({
      mutate: () => {},
      mutateAsync: async () => undefined,
      isPending: false,
    }),
    getListWeeklySettlementsQueryKey: () => ["/api/weekly-settlements"],
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: () => {} }),
}));

import { DashboardMonthlyBuckets } from "./dashboard";

const SELECTED_KEY = "h2budget:dashboardSelectedSources";
const LEGACY_KEY = "h2budget:dashboardIncludeAllSources";

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: "t",
    // today in renderBuckets is 2025-05-15 (Thursday); sundayOf → 2025-05-11,
    // so the visible week is May 11–17. The weekly row list is scoped to that
    // window, so fixtures must fall inside it (and inside the May month) for
    // `row-weekly-*` to render. 2025-05-15 satisfies both.
    occurredOn: "2025-05-15",
    description: "x",
    amount: "-10",
    source: "amex",
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    ...over,
  } as Transaction;
}

function renderBuckets(transactions: Transaction[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardMonthlyBuckets
        today={new Date("2025-05-15T00:00:00")}
        transactions={transactions}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Dashboard source filter chips (#278)", () => {
  it("renders one chip per detected in-month source, with Amex active by default", () => {
    renderBuckets([
      tx({ id: "a", source: "amex", weeklyAllowance: true, amount: "-10" }),
      tx({ id: "c", source: "plaid:chase", weeklyAllowance: true, amount: "-20" }),
      tx({ id: "m", source: "manual", weeklyAllowance: true, amount: "-30" }),
    ]);

    const amex = screen.getByTestId("chip-source-amex");
    const chase = screen.getByTestId("chip-source-chase");
    const manual = screen.getByTestId("chip-source-manual");
    expect(amex.getAttribute("aria-pressed")).toBe("true");
    expect(chase.getAttribute("aria-pressed")).toBe("false");
    expect(manual.getAttribute("aria-pressed")).toBe("false");

    // Only the Amex row is in the WK list.
    expect(screen.getByTestId("row-weekly-a")).toBeTruthy();
    expect(screen.queryByTestId("row-weekly-c")).toBeNull();
    expect(screen.queryByTestId("row-weekly-m")).toBeNull();
  });

  it("toggling a chip on adds that source to the totals; toggling off removes it (true empty set)", () => {
    renderBuckets([
      tx({ id: "a", source: "amex", weeklyAllowance: true, amount: "-10" }),
      tx({ id: "c", source: "plaid:chase", weeklyAllowance: true, amount: "-20" }),
    ]);

    // Add Chase.
    act(() => {
      screen.getByTestId("chip-source-chase").click();
    });
    expect(screen.getByTestId("chip-source-chase").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("row-weekly-a")).toBeTruthy();
    expect(screen.getByTestId("row-weekly-c")).toBeTruthy();

    // Remove Amex — it should actually disappear (no "all selected" sentinel).
    act(() => {
      screen.getByTestId("chip-source-amex").click();
    });
    expect(screen.getByTestId("chip-source-amex").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("row-weekly-a")).toBeNull();
    expect(screen.getByTestId("row-weekly-c")).toBeTruthy();

    // Remove Chase too — empty selection means zero rows in any bucket.
    act(() => {
      screen.getByTestId("chip-source-chase").click();
    });
    expect(screen.queryByTestId("row-weekly-a")).toBeNull();
    expect(screen.queryByTestId("row-weekly-c")).toBeNull();
  });

  it("with a single detected source the chip can still be toggled off", () => {
    renderBuckets([
      tx({ id: "a", source: "amex", weeklyAllowance: true, amount: "-10" }),
    ]);
    expect(screen.getByTestId("row-weekly-a")).toBeTruthy();
    act(() => {
      screen.getByTestId("chip-source-amex").click();
    });
    expect(screen.getByTestId("chip-source-amex").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("row-weekly-a")).toBeNull();
  });

  it("persists chip selection in localStorage so it survives a remount", () => {
    const txns = [
      tx({ id: "a", source: "amex", weeklyAllowance: true, amount: "-10" }),
      tx({ id: "c", source: "plaid:chase", weeklyAllowance: true, amount: "-20" }),
    ];
    const { unmount } = renderBuckets(txns);
    act(() => {
      screen.getByTestId("chip-source-amex").click(); // off
      screen.getByTestId("chip-source-chase").click(); // on
    });
    const stored = window.localStorage.getItem(SELECTED_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).sort()).toEqual(["chase"]);

    unmount();
    cleanup();
    renderBuckets(txns);
    expect(screen.getByTestId("chip-source-amex").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("chip-source-chase").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("row-weekly-a")).toBeNull();
    expect(screen.getByTestId("row-weekly-c")).toBeTruthy();
  });

  it("migrates the legacy 'include all sources' toggle into all detected chips selected", () => {
    window.localStorage.setItem(LEGACY_KEY, "1");
    renderBuckets([
      tx({ id: "a", source: "amex", weeklyAllowance: true, amount: "-10" }),
      tx({ id: "c", source: "plaid:chase", weeklyAllowance: true, amount: "-20" }),
    ]);
    expect(screen.getByTestId("chip-source-amex").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("chip-source-chase").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("row-weekly-a")).toBeTruthy();
    expect(screen.getByTestId("row-weekly-c")).toBeTruthy();
  });
});
