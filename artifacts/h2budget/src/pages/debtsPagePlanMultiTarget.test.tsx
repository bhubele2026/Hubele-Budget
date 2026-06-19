import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";

// Two small, solvable cards. With $2000/mo extra both should die in
// month 1 — Amex first (avalanche → highest APR), then Chase off the
// spillover. With $0 extra only Amex (highest APR) is the target.
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
    useGetAdvisorNudge: () => ({ data: undefined }),
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

describe("Debts page — multi-target month (extra wipes 2+ debts)", () => {
  it("shows the Target badge and 'Target payoff' row on EVERY current-month target", () => {
    extraAmount = "2000";
    renderPage();
    const badges = screen.getAllByText("Target");
    expect(badges.length).toBe(2);
    const targetPayoffRows = screen.getAllByTestId(
      "debt-card-target-payoff-date",
    );
    const ids = targetPayoffRows
      .map((el) => el.getAttribute("data-debt-id"))
      .sort();
    expect(ids).toEqual(["amex", "chase"]);
  });

  it("with $0 extra, only the strategy's first solvable debt is the target", () => {
    extraAmount = "0";
    renderPage();
    const badges = screen.getAllByText("Target");
    expect(badges.length).toBe(1);
    const targetPayoffRows = screen.getAllByTestId(
      "debt-card-target-payoff-date",
    );
    expect(targetPayoffRows.length).toBe(1);
    expect(targetPayoffRows[0].getAttribute("data-debt-id")).toBe("amex");
    // Chase card should still render but without the target footer row.
    expect(screen.getByText("Chase Visa")).toBeTruthy();
  });
});
