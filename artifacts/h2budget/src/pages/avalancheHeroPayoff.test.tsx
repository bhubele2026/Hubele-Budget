import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Debt } from "@workspace/api-client-react";

/**
 * The Future Goal hero is the app's north star: ONE number, the share of the
 * debt that is gone. Two rules are pinned here.
 *
 * 1. **It is the spine's number, not this page's.** `/api/spine` computes
 *    `debt.payoffPct` with `payoffPct()` from @workspace/avalanche-core over
 *    the same rows `/debts` returns, and an API integration test asserts those
 *    two agree. If this page derived its own percentage from the debt list it
 *    holds, the landing tile and this hero could quote different progress for
 *    the same household — which is the exact failure the spine exists to make
 *    impossible. The fixture below makes the two answers deliberately
 *    different: the local rows imply 80% paid, the spine says 39.7%. The hero
 *    must show the spine.
 *
 * 2. **It never shows an amount owed.** Standing rule: the payoff surface leads
 *    with percentage progress only. The balance is real and lives further down
 *    the page, in the table that can disclose what it is counting.
 */

// Radix Slider relies on ResizeObserver, which jsdom does not implement.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// originalBalance 5000 → balance 1000 is 80% paid down by this page's own rows.
// The spine below deliberately disagrees, so "80" appearing in the hero would
// prove the page recomputed instead of reading the shared snapshot.
const SEEDED_DEBTS: Debt[] = [
  {
    id: "amex",
    name: "Amex Delta",
    apr: "0.2849",
    balance: "1000",
    originalBalance: "5000",
    minPayment: "50",
    payment: "50",
    status: "active",
    sortOrder: 1,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
];

const spineData: { current: unknown } = { current: undefined };
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: spineData.current, isLoading: false }),
}));

vi.mock("wouter", () => ({ useSearch: () => "", Link: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null,
  DebtPlaidIndicator: () => null,
  DebtLastSynced: () => null,
  DebtPlaidSource: () => null,
  DebtReauthBanner: () => null,
}));
vi.mock("recharts", () => import("@/test-recharts-stub"));
vi.mock("@workspace/api-client-react", () => {
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const mutation = { mutate: noop, mutateAsync: asyncNoop, isPending: false };
  const mutation2 = () => mutation;
  return {
    useListDebts: () => ({ data: SEEDED_DEBTS, isLoading: false }),
    useCreateDebt: () => mutation,
    useUpdateDebt: () => mutation,
    useDeleteDebt: () => mutation,
    useGetAvalancheSettings: () => ({
      data: {
        strategy: "avalanche",
        manualExtra: "200",
        extraSource: "manual",
        budgetMode: "budgeted",
        extraBudgetCategoryId: null,
      },
    }),
    useUpdateAvalancheSettings: () => mutation,
    useSyncDebtMinimums: () => mutation,
    useGetAvalancheExtra: () => ({
      data: { amount: "200", source: "manual", availableMoney: 1000 },
    }),
    useCreateDebtPayment: () => mutation,
    useListCategories: () => ({ data: [] }),
    useGetSettings: () => ({ data: undefined }),
    useGetForecastAvalancheSchedule: () => ({ data: undefined, isLoading: false }),
    useGetAmexWeeklyPayoff: () => ({ data: undefined, isLoading: false }),
    useUpdateSettings: mutation2,
    useBulkCreateDebtsFromPlaidAccounts: mutation2,
    getGetSettingsQueryKey: () => ["settings"],
    getGetAmexWeeklyPayoffQueryKey: () => ["amex-weekly-payoff"],
    getListDebtsQueryKey: () => ["debts"],
    getGetAvalancheSettingsQueryKey: () => ["av-settings"],
    getGetAvalancheExtraQueryKey: () => ["av-extra"],
    getGetBillsSummaryQueryKey: () => ["bills-summary"],
    getGetForecastQueryKey: () => ["forecast"],
    getGetBudgetMonthQueryKey: () => ["budget-month"],
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
  spineData.current = { reviewCount: 0, debt: { payoffPct: 39.7 } };
});

describe("Future Goal hero — the one big number", () => {
  it("shows the spine's payoffPct, not a percentage recomputed from the debt list", () => {
    renderPage();
    const spine = spineData.current as { debt: { payoffPct: number } };
    const hero = screen.getByTestId("avalanche-payoff-pct");
    expect(hero.textContent).toBe(`${Math.round(spine.debt.payoffPct)}%`);
    // The local rows imply 80% paid. Seeing that here would mean the page
    // derived its own answer and the landing tile would disagree with it.
    expect(hero.textContent).not.toContain("80");
  });

  it("tracks the spine when the snapshot changes", () => {
    spineData.current = { reviewCount: 0, debt: { payoffPct: 12.4 } };
    renderPage();
    expect(screen.getByTestId("avalanche-payoff-pct").textContent).toBe("12%");
  });

  it("renders an em dash, never 0%, when no debt carries a starting balance", () => {
    // payoffPct is null when nothing has an anchor. Null means "nothing to
    // show" — rendering it as 0% would claim the household has paid nothing.
    spineData.current = { reviewCount: 0, debt: { payoffPct: null } };
    renderPage();
    expect(screen.getByTestId("avalanche-payoff-pct").textContent).toBe("—");
  });

  it("never shows an amount owed in the hero", () => {
    renderPage();
    const hero = screen.getByTestId("avalanche-hero");
    const text = hero.textContent ?? "";
    // No currency at all in the hero band — the balance lives in the table.
    expect(text).not.toMatch(/\$/);
    expect(text).not.toContain("1,000");
    expect(text).not.toContain("5,000");
  });

  it("draws the progress bar to the spine's percentage", () => {
    const { container } = renderPage();
    const fill = container.querySelector(".bar-sweep") as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill!.style.width).toBe("39.7%");
  });
});
