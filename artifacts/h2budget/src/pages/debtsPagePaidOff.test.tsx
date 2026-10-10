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

// (WP3c) Extra debts and Plaid's stored figures, per test.
const st = vi.hoisted(() => ({ extra: [] as unknown[], liabs: undefined as unknown }));

vi.mock("@workspace/api-client-react", () => {
  return {
    useListDebts: () => ({ data: [...SEEDED_DEBTS, ...(st.extra as Debt[])], isLoading: false }),
    // (WP3c) The archived rule reads Plaid's stored figures (asked only for a linked archived debt).
    useListPlaidLiabilityAccounts: (_p: unknown, o?: { query?: { enabled?: boolean } }) =>
      ({ data: o?.query?.enabled === false ? undefined : st.liabs, isError: false, isLoading: false }),
    getListPlaidLiabilityAccountsQueryKey: () => ["liability-accounts"],
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
  st.extra = [];
  st.liabs = undefined;
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

describe("Debts page — paid-off rows", () => {
  it("marks a $0 debt paid off and names the kill month when the transition was recorded", () => {
    renderPage();
    const headlines = screen.getAllByTestId("debt-card-paid-off-headline");
    expect(headlines.length).toBe(2);
    // C5 word diet: the status is a chip that states the fact. The old
    // "Paid off!" exclamation went with the celebration styling — the app does
    // not cheer at the reader any more.
    expect(headlines[0].textContent).toContain("Paid off");
    expect(headlines[0].textContent).not.toContain("!");

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

describe("(WP3c) an archived row reads the card model's ONE decision", () => {
  const archived = (id: string, balance: string) => ({
    id, name: `Card ${id}`, apr: "0.2", balance, minPayment: "0", payment: "0", status: "archived", sortOrder: 9,
    plaidAccountId: `row-${id}`, balanceSource: "manual", aprSource: "manual", minPaymentSource: "manual",
  });
  const rowOf = (id: string) => screen.getAllByTestId("debt-card-paid-off").find((r) => r.getAttribute("data-debt-id") === id)!;
  it("case A: a $0.00 row Plaid says owes $412.50 is 'Archived', never 'Paid off'", () => {
    st.extra = [archived("a", "0.00")];
    st.liabs = [{ id: "row-a", balance: "412.50" }];
    renderPage();
    expect(rowOf("a").querySelector("[data-testid='debt-card-paid-off-headline']")!.textContent).toBe("Archived");
    expect(rowOf("a").querySelector("[data-testid='debt-card-paid-off-month']")!.textContent).toBe("Not on the payoff plan");
  });
  it("case B: a $12.00 row with no Plaid figure is 'Archived'", () => {
    st.extra = [archived("b", "12.00")];
    st.liabs = [{ id: "row-b", balance: null }];
    renderPage();
    expect(rowOf("b").querySelector("[data-testid='debt-card-paid-off-headline']")!.textContent).toBe("Archived");
  });
  it("a best-known $0.00 is 'Paid off', and only that counts as Cleared", () => {
    st.extra = [archived("z", "0.00"), archived("b", "12.00")];
    st.liabs = [];
    renderPage();
    expect(rowOf("z").querySelector("[data-testid='debt-card-paid-off-headline']")!.textContent).toBe("Paid off");
    // Cleared: the two $0 active debts + "z"; Active: Chase Visa only ("b" is in neither).
    expect(screen.getByText("Cleared").closest("div")!.parentElement!.textContent).toContain("3");
  });
  it("while Plaid's figures load, the chip waits (no 'Paid off' that becomes 'Archived')", () => {
    st.extra = [archived("a", "0.00")];
    st.liabs = undefined;
    renderPage();
    expect(rowOf("a").querySelector("[data-testid='debt-card-paid-off-pending']")).toBeTruthy();
    expect(rowOf("a").querySelector("[data-testid='debt-card-paid-off-headline']")).toBeNull();
  });
});
