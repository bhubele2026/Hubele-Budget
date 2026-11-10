import { describe, it, expect, vi, beforeEach } from "vitest";
const cad = vi.hoisted(() => ({ cadence: "weekly" as "weekly" | "monthly", schedule: 0 }));
vi.mock("@/components/plan/DebtRangePanel", () => ({ DebtRangePanel: () => null }));
// The card-config panel below the plan is not what this file tests.
vi.mock("@/components/avalanche-card-config", () => ({ AvalancheCardConfig: () => null }));
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

// Invented debts: two cards and a store loan.
const SEEDED_DEBTS: Debt[] = [
  { id: "card-a", name: "Card A", apr: "0.2500", balance: "2000", minPayment: "100", dueDay: 10 },
  { id: "card-b", name: "Card B", apr: "0.2000", balance: "1500", minPayment: "60", dueDay: 5 },
  { id: "store", name: "Store loan", apr: "0.1500", balance: "2400", minPayment: "120", dueDay: 8 },
].map((d, i) => ({
  ...d,
  payment: d.minPayment,
  status: "active",
  sortOrder: i + 1,
  balanceSource: "manual",
  aprSource: "manual",
  minPaymentSource: "manual",
})) as unknown as Debt[];

vi.mock("wouter", () => ({
  useSearch: () => "",
  // The shared kit (`@/ui`) imports Link for its breadcrumb trail. This page
  // never renders one, but the named import still has to resolve or vi.mock
  // throws on the missing export.
  Link: () => null,
}));
// The hero's "% paid" is read from the shared spine snapshot, never recomputed
// on the page. These tests assert the plan and the table, not the headline, so
// the snapshot is simply absent — the hero renders its em-dash placeholder.
// avalancheHeroPayoff.test.tsx is where the number itself is pinned.
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/debt-plaid-link", () => ({
  DebtPlaidActions: () => null,
  DebtPlaidIndicator: () => null,
  DebtLastSynced: () => null,
  DebtPlaidSource: () => null,
  DebtReauthBanner: () => null,
}));
// One shared stub, so a page picking up another recharts primitive does not
// break four test files at once. See src/test-recharts-stub.tsx.
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
        manualExtra: "0",
        extraSource: "manual",
        budgetMode: "budgeted",
        extraBudgetCategoryId: null,
        extraCadence: cad.cadence,
        extraWeekday: 5,
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
    useGetForecastAvalancheSchedule: () => {
      cad.schedule += 1;
      return { data: undefined, isLoading: false };
    },
    useGetMe: () => ({ data: { isOwner: true } }),
    useUpdateSettings: mutation2,
    useBulkCreateDebtsFromPlaidAccounts: mutation2,
    getGetSettingsQueryKey: () => ["settings"],
    getListDebtsQueryKey: () => ["debts"],
    getGetAvalancheSettingsQueryKey: () => ["av-settings"],
    getGetAvalancheExtraQueryKey: () => ["av-extra"],
    getGetBillsSummaryQueryKey: () => ["bills-summary"],
    getGetForecastQueryKey: () => ["forecast"],
    getGetBudgetMonthQueryKey: () => ["budget-month"],
  };
});

// The weekly plan comes from the lazy features module.
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useGetAvalancheWeekly: (opts?: { query?: { enabled?: boolean } }) => ({
    data:
      opts?.query?.enabled === false
        ? undefined
        : {
            cadence: "weekly",
            weekday: 5,
            monthlyTarget: 0,
            targetWeekly: 0,
            cashBuffer: 500,
            weeks: [
              {
                date: "2030-01-04",
                planned: 0,
                room: 350,
                due: 350,
                paid: 350,
                basis: "curve",
                answered: false,
                nextTarget: { debtId: "card-a", name: "Card A" },
                targets: [{ debtId: "card-a", name: "Card A", amount: 350, paidOff: false }],
                paidOff: [],
              },
            ],
            payoffs: [],
            debtFreeDate: "2031-10-29",
            curveThrough: "2030-12-06",
            ranOutOfTime: false,
          },
    isLoading: false,
  }),
}));

import AvalanchePage from "./avalanche";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AvalanchePage />
    </QueryClientProvider>,
  );
}

// ⭐ (AVAL-W) With the weekly cadence the Debt page shows the weekly panel in
// place of the paycheck-window schedule, and the monthly amount reads as the
// target. With monthly, the page is as it was.
describe("Avalanche page — weekly cadence", () => {
  beforeEach(() => {
    cleanup();
    cad.schedule = 0;
  });

  it("weekly: this Friday's payment leads the panel, the schedule card is gone, the monthly figure is the target", () => {
    cad.cadence = "weekly";
    renderPage();
    expect(screen.getByTestId("panel-avalanche-weekly")).toBeTruthy();
    const head = screen.getByTestId("avalanche-this-week");
    expect(head.textContent).toContain("$350.00");
    expect(head.textContent).toContain("→ Card A");
    expect(screen.queryByTestId("card-avalanche-schedule")).toBeNull();
    expect(cad.schedule).toBe(0);
    expect(screen.getByText("Target per month")).toBeTruthy();
    expect(screen.queryByText("Extra per month")).toBeNull();
  });

  it("monthly: the panel offers Weekly, and the rest of the page is unchanged", () => {
    cad.cadence = "monthly";
    renderPage();
    expect(screen.getByTestId("avalanche-monthly-line")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Weekly/ })).toBeTruthy();
    expect(cad.schedule).toBeGreaterThan(0);
    expect(screen.getByText("Extra per month")).toBeTruthy();
    expect(screen.queryByText("Target per month")).toBeNull();
  });
});
