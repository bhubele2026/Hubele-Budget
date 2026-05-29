import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

// Seeded debt list mirroring the real Family Budget situation: a couple of
// solvable cards plus one underwater (34.99% APR vs $33 min on a balance
// large enough that minimums never catch up).
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
  {
    id: "mattress",
    name: "Mattress Firm",
    apr: "0.3499",
    balance: "5000",
    minPayment: "33",
    payment: "33",
    status: "active",
    sortOrder: 3,
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
  DebtReauthBanner: () => null,
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
        manualExtra: "0",
        extraSource: "manual",
        budgetMode: "budgeted",
        extraBudgetCategoryId: null,
      },
    }),
    useUpdateAvalancheSettings: () => mutation,
    useSyncDebtMinimums: () => mutation,
    useGetAvalancheExtra: () => ({
      data: { amount: "0", source: "manual", availableMoney: 1000 },
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

describe("Avalanche page — seeded plan with mixed solvable + underwater debts", () => {
  it("shows finite stat-strip numbers (not ∞) and an 'excludes N underwater' caption", () => {
    renderPage();

    // The "Months to free" cell must NOT show ∞ — the page should fall back
    // to the solvable subset when the full sim runs out of time.
    const stat = screen.getByText("Months to free");
    const cellText = stat.parentElement?.textContent ?? "";
    expect(cellText).not.toContain("∞");
    expect(cellText).toMatch(/excludes 1 underwater debt/i);
  });

  it("'This month' panel shows the full plan total (every min + extra) and the strategy target as the target", () => {
    renderPage();
    const panel = screen.getByTestId("panel-this-month");
    const text = panel.textContent ?? "";
    // 50 + 30 + 33 + 0 extra = $113.00 plan total (sums every active min,
    // including the underwater debt's $33 — the user still owes that).
    expect(text).toContain("$113.00");
    // Avalanche target on the solvable subset = highest APR of {0.2849,
    // 0.18} = Amex. This is where extra *would* go, even though Chase
    // (smaller balance) would actually die first under minimums alone.
    expect(text).toContain("Amex Delta");
    expect(text).toMatch(/minimums on every debt/i);
    expect(text).toMatch(/projected kill/i);
  });

  it("'Your next 3 moves' uses the simulator's payoff cascade, not raw APR sort (underwater debt is not card 1)", () => {
    renderPage();
    const heading = screen.getByText("Your next 3 moves");
    const section = heading.closest("div")!.parentElement!;
    const cards = section.querySelectorAll(".grid > div");
    expect(cards.length).toBeGreaterThan(0);
    const firstCardText = cards[0]?.textContent ?? "";
    // The naive APR sort puts Mattress Firm @ 34.99% first, but it's
    // underwater and never actually dies under this plan.
    expect(firstCardText).not.toContain("Mattress");
  });

  it("strategy comparison reports the solvable-portion finishing copy when minimums-only never finishes (excludes underwater)", () => {
    renderPage();
    // minOnlyForever ⇒ comparison sentence acknowledges the underwater
    // debt explicitly instead of fabricating a savings number.
    const finishes = screen.getByText(/finishes the solvable portion/i);
    expect(finishes).toBeTruthy();
    expect(finishes.textContent ?? "").toMatch(/excludes 1 underwater debt/i);
  });

  it("'Pay [target]' button points at the strategy target (avalanche → highest solvable APR), not the first debt to die", () => {
    renderPage();
    const button = screen.getByTestId("btn-pay-target");
    // First-to-die under minimums-only is Chase (smaller balance), but the
    // avalanche extra-payment target is Amex (higher APR) — and that's the
    // debt the user should be aiming the extra at, regardless of who dies
    // first under the current plan.
    expect(button.textContent ?? "").toContain("Amex Delta");
    expect(button.textContent ?? "").not.toContain("Mattress");
    fireEvent.click(button);
    const amountInput = document.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement | null;
    expect(amountInput).not.toBeNull();
    // Amex min $50 + $0 extra = $50.00.
    expect(amountInput!.value).toBe("50.00");
  });
});
