import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt, DebtBalanceHistoryEntry } from "@workspace/api-client-react";

const SEEDED_DEBTS: Debt[] = [
  {
    id: "killed-with-history",
    name: "Affirm Tonal",
    apr: "0",
    balance: "0",
    minPayment: "0",
    payment: "0",
    status: "active",
    sortOrder: 1,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
  {
    id: "killed-no-history",
    name: "Mystery Loan",
    apr: "0",
    balance: "0",
    minPayment: "0",
    payment: "0",
    status: "active",
    sortOrder: 2,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
  {
    id: "active",
    name: "Chase Visa",
    apr: "0.18",
    balance: "500",
    minPayment: "30",
    payment: "30",
    status: "active",
    sortOrder: 3,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
];

const HISTORY: DebtBalanceHistoryEntry[] = [
  // killed-with-history: $1200 → $600 → $0 (Aug 2026), still $0 in Sep.
  { debtId: "killed-with-history", recordedOn: "2026-06-15", balance: "1200" },
  { debtId: "killed-with-history", recordedOn: "2026-07-15", balance: "600" },
  { debtId: "killed-with-history", recordedOn: "2026-08-10", balance: "0" },
  { debtId: "killed-with-history", recordedOn: "2026-09-10", balance: "0" },
  // killed-no-history: only ever recorded as $0.
  { debtId: "killed-no-history", recordedOn: "2026-05-01", balance: "0" },
  // active: positive balance with one snapshot.
  { debtId: "active", recordedOn: "2026-09-01", balance: "500" },
];

vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null,
  DebtPlaidIndicator: () => null,
  DebtLastSynced: () => null,
  DebtPlaidSource: () => null,
  DebtReauthBanner: () => null,
}));

vi.mock("@workspace/api-client-react", () => {
  return {
    useListDebts: () => ({ data: SEEDED_DEBTS, isLoading: false }),
    useListDebtBalanceHistory: () => ({ data: HISTORY, isLoading: false }),
    useGetAvalancheSettings: () => ({
      data: {
        strategy: "avalanche",
        manualExtra: "0",
        extraSource: "manual",
        budgetMode: "budgeted",
        extraBudgetCategoryId: null,
      },
    }),
    useGetAvalancheExtra: () => ({
      data: { amount: "0", source: "manual", availableMoney: 0 },
    }),
  };
});

import DebtsPage, { killMonthForHistory } from "./debts";

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

describe("killMonthForHistory", () => {
  it("returns the first $0 snapshot date when a transition was recorded", () => {
    const d = killMonthForHistory([
      { debtId: "x", recordedOn: "2026-06-15", balance: "1200" },
      { debtId: "x", recordedOn: "2026-08-10", balance: "0" },
      { debtId: "x", recordedOn: "2026-09-10", balance: "0" },
    ]);
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(7); // August
  });

  it("returns null when the debt was $0 the very first time we recorded it", () => {
    expect(
      killMonthForHistory([
        { debtId: "x", recordedOn: "2026-05-01", balance: "0" },
        { debtId: "x", recordedOn: "2026-06-01", balance: "0" },
      ]),
    ).toBeNull();
  });

  it("returns null on empty history", () => {
    expect(killMonthForHistory([])).toBeNull();
  });

  it("ignores transient $0 dips that bounce back above zero", () => {
    const d = killMonthForHistory([
      { debtId: "x", recordedOn: "2026-05-01", balance: "100" },
      { debtId: "x", recordedOn: "2026-06-01", balance: "0" },
      { debtId: "x", recordedOn: "2026-07-01", balance: "50" },
      { debtId: "x", recordedOn: "2026-08-01", balance: "0" },
      { debtId: "x", recordedOn: "2026-09-01", balance: "0" },
    ]);
    expect(d).not.toBeNull();
    expect(d!.getMonth()).toBe(7); // August
  });
});

describe("Debts page — paid-off card celebration", () => {
  it("shows the celebration with the kill month for a $0 debt that has a recorded transition", () => {
    renderPage();
    const headlines = screen.getAllByTestId("debt-card-paid-off-headline");
    expect(headlines.length).toBe(2);
    expect(headlines[0].textContent).toContain("Paid off!");

    const monthRows = screen.getAllByTestId("debt-card-paid-off-month");
    const withHistory = monthRows.find(
      (el) => el.getAttribute("data-debt-id") === "killed-with-history",
    );
    expect(withHistory).toBeDefined();
    expect(withHistory!.textContent).toBe("Paid off Aug 2026");
  });

  it("falls back to 'Paid off' with no month when no transition was recorded", () => {
    renderPage();
    const monthRows = screen.getAllByTestId("debt-card-paid-off-month");
    const noHistory = monthRows.find(
      (el) => el.getAttribute("data-debt-id") === "killed-no-history",
    );
    expect(noHistory).toBeDefined();
    expect(noHistory!.textContent).toBe("Paid off");
  });

  it("never shows a Target badge or extra-payment row on a paid-off card", () => {
    renderPage();
    // The only "Target" badge in the document should belong to the active
    // debt (Chase Visa) — the paid-off cards must be suppressed.
    const paidOffCards = screen.getAllByTestId("debt-card-paid-off");
    for (const card of paidOffCards) {
      expect(card.textContent).not.toContain("Target");
      expect(card.textContent).not.toContain("Extra this month");
      expect(card.textContent).not.toContain("APR");
      expect(card.textContent).not.toContain("Min Payment");
    }
  });

  it("leaves the standard layout untouched for a debt with a positive balance", () => {
    renderPage();
    // Active card still shows Balance/APR/Min Payment/Payoff.
    const payoffRows = screen.getAllByTestId("debt-card-payoff-date");
    const activeRow = payoffRows.find(
      (el) => el.getAttribute("data-debt-id") === "active",
    );
    expect(activeRow).toBeDefined();
    // And no paid-off treatment was applied to it.
    const paidOffCards = screen.queryAllByTestId("debt-card-paid-off");
    expect(
      paidOffCards.some((el) => el.getAttribute("data-debt-id") === "active"),
    ).toBe(false);
  });
});
