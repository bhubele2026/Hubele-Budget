import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";
import { simulateWithSolvableFallback, type SimDebt } from "@/lib/avalanche";
import { formatCurrency } from "@/lib/utils";

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

const SIM_DEBTS: SimDebt[] = SEEDED_DEBTS.map((d) => ({
  id: d.id,
  name: d.name,
  apr: Number(d.apr),
  balance: Number(d.balance),
  minPayment: Number(d.minPayment),
  status: d.status,
}));

vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null,
  DebtPlaidIndicator: () => null,
  DebtLastSynced: () => null,
  DebtPlaidSource: () => null,
  DebtReauthBanner: () => null,
}));

let extraAmount = "2000";

vi.mock("@workspace/api-client-react", () => {
  return {
    useListDebts: () => ({ data: SEEDED_DEBTS, isLoading: false }),
    useListDebtBalanceHistory: () => ({ data: [], isLoading: false }),
    useGetAvalancheSettings: () => ({
      data: {
        strategy: "avalanche",
        manualExtra: extraAmount,
        extraSource: "manual",
        budgetMode: "budgeted",
        extraBudgetCategoryId: null,
      },
    }),
    useGetAvalancheExtra: () => ({
      data: { amount: extraAmount, source: "manual", availableMoney: 5000 },
    }),
  };
});

import DebtsPage from "./debts";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DebtsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
});

describe("Debts page — per-target Extra this month row", () => {
  it("renders the extra-amount row for every current-month target with the matching dollar amount", () => {
    extraAmount = "2000";
    const { sim } = simulateWithSolvableFallback({
      debts: SIM_DEBTS,
      extraPerMonth: 2000,
      strategy: "avalanche",
    });
    const targets = sim.months[0]?.targets ?? [];
    // Sanity: scenario must have multiple targets, all with extra > 0.
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets.every((t) => t.extraPaid > 0)).toBe(true);
    const expectedById = new Map(
      targets.map((t) => [t.id, t.extraPaid] as const),
    );

    renderPage();

    const rows = screen.getAllByTestId("debt-card-target-extra");
    const renderedIds = rows
      .map((el) => el.getAttribute("data-debt-id"))
      .filter((id): id is string => !!id)
      .sort();
    expect(renderedIds).toEqual([...expectedById.keys()].sort());

    for (const row of rows) {
      const id = row.getAttribute("data-debt-id")!;
      const expected = expectedById.get(id);
      expect(expected).toBeDefined();
      expect(row.textContent).toBe(formatCurrency(expected!));
    }
  });

  it("does NOT render the extra-amount row on non-target cards or in the $0-extra fallback", () => {
    extraAmount = "0";
    renderPage();

    // Single-target fallback, but extraPaid is 0 → row must be absent everywhere.
    expect(screen.queryAllByTestId("debt-card-target-extra")).toHaveLength(0);
    // Both cards still render.
    expect(screen.getByText("Amex Delta")).toBeTruthy();
    expect(screen.getByText("Chase Visa")).toBeTruthy();
  });
});
