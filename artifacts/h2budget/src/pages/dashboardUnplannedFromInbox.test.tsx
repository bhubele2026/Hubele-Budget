import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Transaction } from "@workspace/api-client-react";

vi.mock("@workspace/api-client-react", async () => {
  return {
    useListDashboardBudgets: () => ({ data: [{ amount: "0", isDefault: true }] }),
    useUpsertDashboardBudget: () => ({ mutate: () => {}, isPending: false }),
    useDeleteDashboardBudget: () => ({ mutate: () => {}, isPending: false }),
    getListDashboardBudgetsQueryKey: () => ["budgets"],
    useGetSettings: () => ({ data: undefined, isLoading: false }),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: () => {} }),
}));

import { DashboardMonthlyBuckets } from "./dashboard";

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: "t",
    occurredOn: "2025-05-10",
    description: "Mystery charge",
    amount: "-25",
    source: "amex",
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

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
});

function unplannedTotalText(): string {
  // The Unplanned section heading lets us scope the query to that card.
  const heading = screen.getByText("Unplanned spending");
  const section = heading.closest("section") as HTMLElement;
  // The big total is the first tabular-nums element inside the card.
  const total = section.querySelector(".tabular-nums") as HTMLElement;
  return total.textContent ?? "";
}

describe("Dashboard Unplanned bucket — inbox 'Mark unplanned' rolls in (#482)", () => {
  it("includes resolved-unplanned bank txns in the tile total and recent list (alongside manual-tagged rows)", () => {
    const txns = [
      tx({ id: "inbox-1", amount: "-42.50" }),
      tx({ id: "inbox-2", amount: "-7.50", description: "Snack run" }),
      tx({ id: "manual-1", amount: "-10.00", unplannedAllowance: true }),
    ];
    renderBuckets(txns, new Set(["inbox-1", "inbox-2"]));

    expect(screen.getByTestId("row-unplanned-inbox-1")).toBeTruthy();
    expect(screen.getByTestId("row-unplanned-inbox-2")).toBeTruthy();
    expect(screen.getByTestId("row-unplanned-manual-1")).toBeTruthy();
    // Tile total sums all three (42.50 + 7.50 + 10.00 = 60.00).
    expect(unplannedTotalText()).toBe("$60.00");
  });

  it("surfaces a source chip for an inbox-resolved txn whose source has no other tagged rows, so the user can toggle it on", () => {
    const txns = [
      tx({ id: "inbox-chase", amount: "-22.00", source: "plaid:chase" }),
    ];
    renderBuckets(txns, new Set(["inbox-chase"]));

    // The Chase chip exists even though no Chase txn carries any
    // weeklyAllowance/monthlyAllowance/unplannedAllowance flag — the
    // inbox-resolved txn is enough to surface it.
    const chaseChip = screen.getByTestId("chip-source-chase");
    expect(chaseChip).toBeTruthy();
    expect(chaseChip.getAttribute("aria-pressed")).toBe("false");

    // Default Amex-only selection means the row is filtered out of the total.
    expect(unplannedTotalText()).toBe("$0.00");
    expect(screen.queryByTestId("row-unplanned-inbox-chase")).toBeNull();

    // Toggling Chase on rolls the inbox-resolved txn into the bucket.
    act(() => {
      chaseChip.click();
    });
    expect(screen.getByTestId("row-unplanned-inbox-chase")).toBeTruthy();
    expect(unplannedTotalText()).toBe("$22.00");
  });

  it("drops the txn back out of the bucket once the resolution is cleared", () => {
    const txns = [tx({ id: "inbox-1", amount: "-42.5" })];

    const { rerender } = renderBuckets(txns, new Set(["inbox-1"]));
    expect(screen.getByTestId("row-unplanned-inbox-1")).toBeTruthy();

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    rerender(
      <QueryClientProvider client={qc}>
        <DashboardMonthlyBuckets
          today={new Date("2025-05-15T00:00:00")}
          transactions={txns}
          resolvedUnplannedTxnIds={new Set()}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("row-unplanned-inbox-1")).toBeNull();
  });

  it("buckets a resolved-unplanned txn into the month it actually occurred, not the current month", () => {
    const txns = [
      tx({ id: "inbox-april", amount: "-15", occurredOn: "2025-04-20" }),
      tx({ id: "inbox-may", amount: "-30", occurredOn: "2025-05-05" }),
    ];
    renderBuckets(txns, new Set(["inbox-april", "inbox-may"]));

    // Default view is May 2025 (today=May 15) — only the May txn shows.
    expect(screen.queryByTestId("row-unplanned-inbox-april")).toBeNull();
    expect(screen.getByTestId("row-unplanned-inbox-may")).toBeTruthy();
  });

  it("does not include a resolved-unplanned txn whose source is not in the active chip selection", () => {
    const txns = [
      tx({ id: "inbox-chase", amount: "-20", source: "plaid:chase" }),
    ];
    renderBuckets(txns, new Set(["inbox-chase"]));

    // Default chip selection is Amex only — the Chase row is filtered out.
    expect(screen.queryByTestId("row-unplanned-inbox-chase")).toBeNull();
  });
});
