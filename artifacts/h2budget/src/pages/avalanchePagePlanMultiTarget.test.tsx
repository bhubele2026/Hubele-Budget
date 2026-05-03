import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";

// Radix Slider relies on ResizeObserver, which jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// Two small, solvable cards. With $2000/mo extra both should die in
// month 1 — Amex first (avalanche → highest APR), then Chase off the
// spillover.
const SEEDED_DEBTS: Debt[] = [
  {
    id: "amex",
    name: "Amex Delta",
    apr: "0.2849",
    balance: "1000",
    minPayment: "50",
    payment: "50",
    status: "active",
    sortOrder: 1,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
  {
    id: "chase",
    name: "Chase Visa",
    apr: "0.18",
    balance: "500",
    minPayment: "30",
    payment: "30",
    status: "active",
    sortOrder: 2,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
];

vi.mock("wouter", () => ({ useSearch: () => "" }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null,
  DebtPlaidIndicator: () => null,
  DebtLastSynced: () => null,
  DebtPlaidSource: () => null,
}));
vi.mock("recharts", () => ({
  LineChart: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: () => null,
  Legend: () => null,
}));
vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = { mutate: noop, mutateAsync: asyncNoop, isPending: false };
  return {
    useListDebts: () => ({ data: SEEDED_DEBTS, isLoading: false }),
    useCreateDebt: () => mutation,
    useUpdateDebt: () => mutation,
    useDeleteDebt: () => mutation,
    useGetAvalancheSettings: () => ({
      data: {
        strategy: "avalanche",
        manualExtra: "2000",
        extraSource: "manual",
        budgetMode: "budgeted",
        extraBudgetCategoryId: null,
      },
    }),
    useUpdateAvalancheSettings: () => mutation,
    useSyncDebtMinimums: () => mutation,
    useGetAvalancheExtra: () => ({
      data: { amount: "2000", source: "manual", availableMoney: 5000 },
    }),
    useCreateDebtPayment: () => mutation,
    useListCategories: () => ({ data: [] }),
    useGetSettings: () => ({ data: undefined }),
    getListDebtsQueryKey: () => ["debts"],
    getGetAvalancheSettingsQueryKey: () => ["av-settings"],
    getGetAvalancheExtraQueryKey: () => ["av-extra"],
  };
});

import AvalanchePage from "./avalanche";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AvalanchePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
});

describe("Avalanche page — multi-target month (extra wipes 2+ debts)", () => {
  it("'This month' pane names BOTH targets with the per-debt amount and a 'killed this month' note", () => {
    renderPage();
    const panel = screen.getByTestId("panel-this-month");
    const text = panel.textContent ?? "";
    // Multi-target headline copy mentions the count, not a single name.
    expect(text).toMatch(/extra split across\s*2 debts/i);
    // Per-target list contains both debts.
    const list = within(panel).getByTestId("this-month-targets");
    expect(within(list).getByTestId("this-month-target-amex")).toBeTruthy();
    expect(within(list).getByTestId("this-month-target-chase")).toBeTruthy();
    // Each row says "killed this month" because both die in month 1.
    const amexRow = within(list).getByTestId("this-month-target-amex");
    const chaseRow = within(list).getByTestId("this-month-target-chase");
    expect(amexRow.textContent ?? "").toMatch(/killed this month/i);
    expect(chaseRow.textContent ?? "").toMatch(/killed this month/i);
    // Amex (the primary target, highest APR) is listed first.
    expect(list.firstElementChild?.getAttribute("data-testid")).toBe(
      "this-month-target-amex",
    );
  });

  it("the Debts table shows a 'Target' pill on EVERY debt receiving extra this month", () => {
    renderPage();
    const amexRow = screen.getByTestId("row-debt-amex");
    const chaseRow = screen.getByTestId("row-debt-chase");
    expect(within(amexRow).getByText("Target")).toBeTruthy();
    expect(within(chaseRow).getByText("Target")).toBeTruthy();
  });

  it("renders one Pay button per target in the multi-target case", () => {
    renderPage();
    const buttons = screen.getByTestId("this-month-pay-buttons");
    expect(within(buttons).getByTestId("btn-pay-target-amex")).toBeTruthy();
    expect(within(buttons).getByTestId("btn-pay-target-chase")).toBeTruthy();
    // The single-target button should NOT be present in the multi case.
    expect(screen.queryByTestId("btn-pay-target")).toBeNull();
  });
});
