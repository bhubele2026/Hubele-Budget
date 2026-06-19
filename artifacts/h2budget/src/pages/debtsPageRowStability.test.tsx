import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";

/**
 * Unit coverage for task #639's debts-side reserved-slot pattern.
 *
 * The Debts page renders one Card per debt in a CSS grid. Two of
 * those Card rows are conditional on `isTarget` (the avalanche
 * planner's current-month target): the "Target payoff" row and, when
 * the planner spills extra onto that debt, the "Extra this month"
 * row. Before #639 these were `isTarget && (...)` short-circuits, so
 * non-target cards rendered fewer rows and a flip of `isTarget` (e.g.
 * when the user changes manualExtra) would change the card's height
 * and stretch the surrounding CSS-grid row.
 *
 * The fix mirrors #626's Amex pattern: always render the row, with
 * `invisible` (and `aria-hidden`) when the condition isn't met. The
 * placeholder keeps the same DOM structure and dollar-string line
 * height as the rendered case so the card occupies the same vertical
 * space either way.
 *
 * jsdom doesn't lay out, so this test asserts the *structural*
 * invariant the layout depends on: every debt card emits the same
 * count of "target" footprint slots regardless of whether it's a
 * target. The slot is a single DOM element per row that's either the
 * visible content (testid `debt-card-target-payoff-date` /
 * `debt-card-target-extra`) or its reserved placeholder (testid
 * `debt-card-target-payoff-slot` / `debt-card-target-extra-slot`).
 * If a future change re-introduces a short-circuited `isTarget && …`
 * without a placeholder, that card will be missing one of the two
 * slots and this test will fail.
 */

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

let extraAmount = "0";

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

// Count payoff-row and extra-row "target footprint" slots emitted
// for each debt id (real testid OR placeholder testid). Each debt
// must expose exactly one of each kind regardless of isTarget — that
// is the structural invariant the reserved-slot fix relies on.
function slotCountsByDebt(
  container: HTMLElement,
): Array<{ id: string; payoff: number; extra: number }> {
  const debtIds = Array.from(
    new Set(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-debt-id]"),
      ).map((el) => el.getAttribute("data-debt-id") ?? ""),
    ),
  ).filter((id) => id === "amex" || id === "chase");
  return debtIds.map((id) => {
    const all = Array.from(
      container.querySelectorAll<HTMLElement>(`[data-debt-id="${id}"]`),
    );
    const payoff = all.filter((el) => {
      const t = el.getAttribute("data-testid") ?? "";
      return (
        t === "debt-card-target-payoff-date" ||
        // Placeholder testid is on the row wrapper, not the inner
        // span; check both the element and its parent for the slot
        // testid as a robust catch.
        el.parentElement?.getAttribute("data-testid") ===
          "debt-card-target-payoff-slot"
      );
    }).length;
    const extra = all.filter((el) => {
      const t = el.getAttribute("data-testid") ?? "";
      return (
        t === "debt-card-target-extra" ||
        el.parentElement?.getAttribute("data-testid") ===
          "debt-card-target-extra-slot"
      );
    }).length;
    return { id, payoff, extra };
  });
}

describe("Debts page — reserved-slot row stability (#639)", () => {
  it("every debt card emits one Target-payoff slot regardless of isTarget", () => {
    extraAmount = "0";
    const { container } = renderPage();

    const counts = slotCountsByDebt(container);
    expect(counts.length).toBe(2);
    for (const c of counts) {
      expect(c.payoff, `debt "${c.id}" payoff slot count`).toBe(1);
    }
  });

  it("every debt card emits one Extra-this-month slot regardless of isTarget or extra > 0", () => {
    extraAmount = "0";
    const { container } = renderPage();

    const countsZero = slotCountsByDebt(container);
    expect(countsZero.length).toBe(2);
    for (const c of countsZero) {
      expect(c.extra, `[$0 extra] debt "${c.id}" extra slot count`).toBe(1);
    }

    cleanup();
    extraAmount = "2000";
    const { container: container2 } = renderPage();
    const countsHigh = slotCountsByDebt(container2);
    expect(countsHigh.length).toBe(2);
    for (const c of countsHigh) {
      expect(
        c.extra,
        `[$2000 extra] debt "${c.id}" extra slot count`,
      ).toBe(1);
    }
  });

  it("the placeholder slots are aria-hidden so screen readers skip them", () => {
    extraAmount = "0";
    renderPage();
    const payoffSlots = screen.queryAllByTestId("debt-card-target-payoff-slot");
    const extraSlots = screen.queryAllByTestId("debt-card-target-extra-slot");
    // With $0 extra and two debts, only one card is the strategy's
    // first solvable target — so at most one of the payoff
    // placeholders is present (the non-target). The extra-row
    // placeholder is present on BOTH cards because $0 extra means
    // neither card has targetExtra > 0.
    expect(payoffSlots.length).toBeGreaterThanOrEqual(1);
    expect(extraSlots.length).toBe(2);
    for (const slot of [...payoffSlots, ...extraSlots]) {
      expect(slot.getAttribute("aria-hidden")).toBe("true");
      expect(slot.className).toMatch(/\binvisible\b/);
    }
  });
});
