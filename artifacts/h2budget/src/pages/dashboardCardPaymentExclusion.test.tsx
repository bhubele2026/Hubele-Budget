import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
    useListDashboardBudgets: () => ({
      data: [{ amount: "0", isDefault: true }],
    }),
    useUpsertDashboardBudget: () => ({ mutate: () => {}, isPending: false }),
    useDeleteDashboardBudget: () => ({ mutate: () => {}, isPending: false }),
    getListDashboardBudgetsQueryKey: () => ["budgets"],
    useGetSettings: () => ({ data: undefined, isLoading: false }),
    useListWeeklySettlements: () => ({ data: [] }),
    useCloseOutWeek: () => ({ mutate: () => {}, isPending: false }),
    useReopenWeek: () => ({ mutate: () => {}, isPending: false }),
    getListWeeklySettlementsQueryKey: () => ["weekly-settlements"],
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: () => {} }),
}));

import { DashboardMonthlyBuckets, detectChipSources } from "./dashboard";

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: "t",
    occurredOn: "2025-05-10",
    description: "x",
    amount: "-10",
    source: "amex",
    isTransfer: false,
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    ...over,
  } as Transaction;
}

function renderBuckets(
  transactions: Transaction[],
  resolvedUnplannedTxnIds?: Set<string>,
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardMonthlyBuckets
        today={new Date("2025-05-15T00:00:00")}
        transactions={transactions}
        resolvedUnplannedTxnIds={resolvedUnplannedTxnIds}
      />
    </QueryClientProvider>,
  );
}

function totalTextFor(heading: string): string {
  const node = screen.getByText(heading);
  const section = node.closest("section") as HTMLElement;
  const total = section.querySelector(".tabular-nums") as HTMLElement;
  return total.textContent ?? "";
}

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("(#632) Dashboard buckets exclude card-payment / transfer rows", () => {
  it("a card-payment row classified as transfer is dropped from the Monthly bucket total + recent list", () => {
    const txns = [
      // Real $30 monthly charge — should remain.
      tx({
        id: "real-monthly",
        amount: "-30.00",
        description: "NETFLIX",
        monthlyAllowance: true,
      }),
      // The screenshot scenario: a +$1,593.52 "ONLINE PAYMENT - THANK YOU"
      // row that the legacy classifier let into Monthly. Now flagged as
      // a transfer; the dashboard filter must drop it even when its
      // stale `monthlyAllowance` flag is still true (pre-backfill state).
      tx({
        id: "card-payment",
        amount: "1593.52",
        description: "ONLINE PAYMENT - THANK YOU",
        monthlyAllowance: true,
        isTransfer: true,
      }),
    ];
    renderBuckets(txns);

    expect(screen.getByTestId("row-monthly-real-monthly")).toBeTruthy();
    expect(screen.queryByTestId("row-monthly-card-payment")).toBeNull();
    // Monthly total counts only the real $30 charge — the +$1,593.52
    // payment is a credit anyway, but the row must not appear under
    // Monthly regardless.
    expect(totalTextFor("Monthly spending")).toBe("$30.00");
  });

  it("a transfer row tagged Unplanned is dropped from the Unplanned bucket too", () => {
    const txns = [
      tx({
        id: "real-unplanned",
        amount: "-12.00",
        description: "Mystery charge",
        unplannedAllowance: true,
      }),
      tx({
        id: "transfer-unplanned",
        amount: "-500.00",
        description: "MOBILE PAYMENT - THANK YOU",
        unplannedAllowance: true,
        isTransfer: true,
      }),
    ];
    renderBuckets(txns);

    expect(screen.getByTestId("row-unplanned-real-unplanned")).toBeTruthy();
    expect(screen.queryByTestId("row-unplanned-transfer-unplanned")).toBeNull();
    expect(totalTextFor("Unplanned spending")).toBe("$12.00");
  });

  it("a transfer-classified inbox-resolved row is also kept out of Unplanned", () => {
    const txns = [
      tx({
        id: "inbox-transfer",
        amount: "-200.00",
        description: "AUTOPAY PAYMENT - THANK YOU",
        isTransfer: true,
      }),
    ];
    renderBuckets(txns, new Set(["inbox-transfer"]));

    expect(screen.queryByTestId("row-unplanned-inbox-transfer")).toBeNull();
    expect(totalTextFor("Unplanned spending")).toBe("$0.00");
  });

  it("detectChipSources skips a source whose only tagged in-month row is a transfer", () => {
    const chase = tx({
      id: "c",
      source: "plaid:chase",
      description: "ONLINE PAYMENT - THANK YOU",
      monthlyAllowance: true,
      isTransfer: true,
    });
    const sources = detectChipSources(
      [chase],
      "2025-05-01",
      "2025-05-31",
    );
    expect(sources).toEqual([]);
  });
});
