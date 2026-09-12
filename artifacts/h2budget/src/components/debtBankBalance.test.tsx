import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";

const hooks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("@workspace/api-client-react", () => ({
  useAdoptDebtBankBalance: () => ({ mutate: hooks.mutate, isPending: false }),
  getListDebtsQueryKey: () => ["/api/debts"],
  getListDebtBalanceHistoryQueryKey: () => ["/api/debts/balance-history"],
  getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
  getGetDashboardQueryKey: () => ["/api/dashboard"],
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { DebtBankBalance, balanceDayLabel } from "./debt-bank-balance";

const fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function debt(over: Partial<Debt>): Debt {
  return {
    id: "d1",
    name: "Visa",
    balance: "5000.00",
    apr: "0.2000",
    minPayment: "25.00",
    payment: "25.00",
    status: "active",
    sortOrder: 1,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
    plaidAccountId: "pa1",
    lastBalanceUpdate: "2026-09-01T17:00:00.000Z",
    bankBalance: "4812.40",
    bankBalanceAt: "2026-09-10T15:00:00.000Z",
    bankBalanceStale: false,
    bankRefreshError: null,
    bankRefreshFailedAt: null,
    ...over,
  };
}

function renderIt(d: Debt, onRowClick = vi.fn()) {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <div onClick={onRowClick}>
        <DebtBankBalance debt={d} fmt={fmt} />
      </div>
    </QueryClientProvider>,
  );
  return { onRowClick };
}

afterEach(() => {
  cleanup();
  hooks.mutate.mockReset();
});

describe("DebtBankBalance (PR-E)", () => {
  it("a manual $5,000 against a $4,812.40 bank balance shows both, dated, the difference, and Use bank balance", () => {
    const { onRowClick } = renderIt(debt({}));

    expect(screen.getByTestId("debt-balance-entered-d1").textContent).toMatch(
      /^Entered \$5,000\.00 · Sep 1(, 2026)?$/,
    );
    expect(screen.getByTestId("debt-balance-bank-d1").textContent).toMatch(
      /^Bank \$4,812\.40 · Sep 10(, 2026)?$/,
    );
    expect(screen.getByTestId("debt-balance-difference-d1").textContent).toBe(
      "Difference +$187.60",
    );

    fireEvent.click(screen.getByTestId("button-use-bank-balance-d1"));
    expect(hooks.mutate).toHaveBeenCalledWith({ id: "d1" });
    // The Future Goal row opens a drill-down on click; the button must not.
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("renders nothing for a bank-sourced debt with a current bank balance", () => {
    renderIt(debt({ balanceSource: "plaid", balance: "4812.40" }));
    expect(screen.queryByTestId("debt-bank-balance-d1")).toBeNull();
  });

  it("renders nothing when the entered balance equals the bank's, or there is no bank balance", () => {
    renderIt(debt({ balance: "4812.40" }));
    expect(screen.queryByTestId("debt-bank-balance-d1")).toBeNull();
    cleanup();
    renderIt(debt({ bankBalance: null, bankBalanceAt: null, plaidAccountId: null }));
    expect(screen.queryByTestId("debt-bank-balance-d1")).toBeNull();
  });

  it("treats an unknown balance source as kept, not the bank's", () => {
    renderIt(debt({ balanceSource: "imported" as Debt["balanceSource"] }));
    expect(screen.getByTestId("button-use-bank-balance-d1")).toBeTruthy();
  });

  it("says in a plain sentence when the bank refresh failed — never the stored error text — and offers no swap for a bank-sourced debt", () => {
    renderIt(
      debt({
        balanceSource: "plaid",
        balance: "4812.40",
        bankBalanceStale: true,
        bankRefreshError: 'relation "plaid_accounts" does not exist',
        bankRefreshFailedAt: "2026-09-10T15:00:00.000Z",
      }),
    );
    const block = screen.getByTestId("debt-bank-balance-d1");
    const line = screen.getByTestId("debt-bank-refresh-failed-d1");
    expect(line.textContent).toMatch(/^Couldn't refresh the bank balance · Sep 10(, 2026)?$/);
    expect(line.getAttribute("title")).toBeNull();
    expect(block.outerHTML).not.toContain("relation");
    expect(screen.queryByTestId("button-use-bank-balance-d1")).toBeNull();
    expect(screen.queryByTestId("debt-bank-balance-stale-d1")).toBeNull();
  });

  it("stays quiet about a failed or old refresh when the page-top reconnect banner already covers that bank", () => {
    renderIt(
      debt({
        balanceSource: "plaid",
        balance: "4812.40",
        bankBalanceStale: true,
        bankRefreshError: "ITEM_LOGIN_REQUIRED",
        bankRefreshFailedAt: "2026-09-10T15:00:00.000Z",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        plaidAccount: { id: "pa1", itemId: "item1" },
      }),
    );
    expect(screen.queryByTestId("debt-bank-balance-d1")).toBeNull();
    cleanup();
    // A difference still shows: the banner says nothing about which figure is active.
    renderIt(
      debt({
        bankBalanceStale: true,
        bankRefreshError: "ITEM_LOGIN_REQUIRED",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        plaidAccount: { id: "pa1", itemId: "item1" },
      }),
    );
    expect(screen.getByTestId("button-use-bank-balance-d1")).toBeTruthy();
    expect(screen.queryByTestId("debt-bank-refresh-failed-d1")).toBeNull();
  });

  it("says when the bank balance is old", () => {
    renderIt(debt({ balanceSource: "plaid", balance: "4812.40", bankBalanceStale: true }));
    expect(screen.getByTestId("debt-bank-balance-stale-d1").textContent).toMatch(
      /^Bank balance old · Sep 10(, 2026)?$/,
    );
  });

  it("dates on the household calendar, with the year only when it isn't this year", () => {
    expect(balanceDayLabel(null, "2026-09-11")).toBe("date unknown");
    // 11pm Chicago on Dec 31 is already Jan 1 in UTC.
    expect(balanceDayLabel("2026-01-01T05:00:00.000Z", "2026-09-11")).toBe("Dec 31, 2025");
    expect(balanceDayLabel("2026-09-10", "2026-09-11")).toBe("Sep 10");
  });
});
