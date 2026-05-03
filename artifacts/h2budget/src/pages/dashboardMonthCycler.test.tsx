import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

type DashListArgs = { bucket: string; periodKey: string };
const listDashboardCalls: DashListArgs[] = [];

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  return {
    useGetSettings: () => ({ data: undefined }),
    useGetDashboard: () => ({
      data: {
        totalDebt: "0",
        activeDebtCount: 0,
        netCashflow: "0",
        monthlyIncome: "0",
        monthlySpend: "0",
        paidThisMonth: "0",
        paidLifetime: "0",
        recentTransactions: [],
      },
      isLoading: false,
    }),
    useGetBudgetMonth: () => ({ data: undefined, isLoading: false }),
    useListTransactions: () => ({ data: [], isLoading: false }),
    useListDashboardBudgets: (args: DashListArgs) => {
      listDashboardCalls.push(args);
      return { data: [{ id: "stub", ...args, amount: "0" }] };
    },
    useUpsertDashboardBudget: () => ({ mutate: noop, isPending: false }),
    useUpdateTransaction: () => ({ mutate: noop, mutateAsync: async () => undefined }),
    getListDashboardBudgetsQueryKey: (args: DashListArgs) => ["dash", args],
    getListTransactionsQueryKey: () => ["txns"],
  };
});

// Avoid pulling these heavy components (and their own hook trees) into the test.
vi.mock("@/components/dashboard-kill-order", () => ({
  DashboardKillOrder: () => null,
}));
vi.mock("@/components/avalanche-ready-card", () => ({
  AvalancheReadyCard: () => null,
}));

import { DashboardMonthlyBuckets } from "./dashboard";

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function lastKeysByBucket() {
  const out: Record<string, string | undefined> = {};
  for (const c of listDashboardCalls) out[c.bucket] = c.periodKey;
  return out;
}

describe("DashboardMonthlyBuckets — month cycler wiring", () => {
  beforeEach(() => {
    listDashboardCalls.length = 0;
    cleanup();
  });

  it("defaults the cycler to the current month and shows it as the label", () => {
    const today = new Date(2026, 9, 17); // October 17, 2026
    renderWithClient(
      <DashboardMonthlyBuckets today={today} transactions={[]} />,
    );

    expect(screen.getByTestId("text-month-label").textContent).toBe(
      "OCTOBER 2026",
    );
    // Prev arrow is enabled — we are above the floor.
    const prev = screen.getByTestId("button-month-prev") as HTMLButtonElement;
    expect(prev.disabled).toBe(false);

    // All three bucket cards (weekly/monthly/unplanned) requested data
    // for the current month.
    const keys = lastKeysByBucket();
    expect(keys.weekly).toBe("2026-10");
    expect(keys.monthly).toBe("2026-10");
    expect(keys.unplanned).toBe("2026-10");
  });

  it("disables the back arrow at the April 2026 floor and steps all three cards in lockstep", () => {
    const today = new Date(2026, 5, 10); // June 10, 2026 — two months above floor.
    renderWithClient(
      <DashboardMonthlyBuckets today={today} transactions={[]} />,
    );

    expect(screen.getByTestId("text-month-label").textContent).toBe("JUNE 2026");
    const prev = screen.getByTestId("button-month-prev") as HTMLButtonElement;
    expect(prev.disabled).toBe(false);

    // Click "prev" once -> May 2026, still above floor.
    act(() => {
      prev.click();
    });
    expect(screen.getByTestId("text-month-label").textContent).toBe("MAY 2026");
    expect(prev.disabled).toBe(false);
    let keys = lastKeysByBucket();
    expect(keys.weekly).toBe("2026-05");
    expect(keys.monthly).toBe("2026-05");
    expect(keys.unplanned).toBe("2026-05");

    // Click "prev" again -> April 2026 (the floor). Back arrow now disabled.
    act(() => {
      prev.click();
    });
    expect(screen.getByTestId("text-month-label").textContent).toBe("APRIL 2026");
    expect(prev.disabled).toBe(true);
    keys = lastKeysByBucket();
    expect(keys.weekly).toBe("2026-04");
    expect(keys.monthly).toBe("2026-04");
    expect(keys.unplanned).toBe("2026-04");

    // Further clicks on the disabled prev button do nothing — still at floor.
    act(() => {
      prev.click();
    });
    expect(screen.getByTestId("text-month-label").textContent).toBe("APRIL 2026");
    expect(prev.disabled).toBe(true);
  });

  it("forward arrow advances the month and re-enables the back arrow", () => {
    const today = new Date(2026, 3, 5); // April 5, 2026 — start at the floor.
    renderWithClient(
      <DashboardMonthlyBuckets today={today} transactions={[]} />,
    );

    expect(screen.getByTestId("text-month-label").textContent).toBe("APRIL 2026");
    const prev = screen.getByTestId("button-month-prev") as HTMLButtonElement;
    const next = screen.getByTestId("button-month-next") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);

    act(() => {
      next.click();
    });
    expect(screen.getByTestId("text-month-label").textContent).toBe("MAY 2026");
    expect(prev.disabled).toBe(false);
    const keys = lastKeysByBucket();
    expect(keys.weekly).toBe("2026-05");
    expect(keys.monthly).toBe("2026-05");
    expect(keys.unplanned).toBe("2026-05");
  });
});
