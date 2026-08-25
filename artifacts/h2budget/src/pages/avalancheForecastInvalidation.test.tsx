import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { Debt } from "@workspace/api-client-react";

/**
 * ⭐ "I set the avalanche extra to $5k and the ending balance didn't move."
 *
 * It had moved — on the server. The slider commits, the projection genuinely
 * changes, and the screen keeps showing a number it fetched up to five minutes
 * earlier, because the save invalidated the `/api/forecast` BUNDLE and the
 * ending balance comes from a different query: `/api/forecast/cash-signal`.
 * Different first key segment, so a prefix invalidation never reached it, and
 * that key is deliberately cached for 5 minutes with no refetch-on-focus
 * (`App.tsx`) on the stated assumption that "every write path invalidates".
 *
 * This one didn't. Hard-reloading fixed it, which is how Brad found it.
 *
 * This test pins the contract that matters to a person using the app: changing
 * what you pay towards debt refreshes the projection that tells you what it
 * does to your balance.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const SEEDED_DEBTS: Debt[] = [
  {
    id: "upstart",
    name: "Upstart Loan",
    apr: "0.199",
    balance: "8420",
    minPayment: "250",
    payment: "250",
    status: "active",
    sortOrder: 1,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
  } as Debt,
];

// Captured from the page's own mutation options so the test can fire the exact
// success handler the page registered.
let settingsOnSuccess: (() => void) | undefined;

vi.mock("wouter", () => ({
  useSearch: () => "",
  Link: () => null,
}));
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
      },
    }),
    useUpdateAvalancheSettings: (opts?: {
      mutation?: { onSuccess?: () => void };
    }) => {
      settingsOnSuccess = opts?.mutation?.onSuccess;
      return mutation;
    },
    useSyncDebtMinimums: () => mutation,
    useGetAvalancheExtra: () => ({
      data: { amount: "0", source: "manual", availableMoney: 1000 },
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
    // The REAL shapes, because the whole bug is that one is not a prefix of
    // the other.
    getGetForecastQueryKey: () => ["/api/forecast"],
    getGetBudgetMonthQueryKey: () => ["budget-month"],
  };
});

import AvalanchePage from "./avalanche";

/** Would this invalidation call have matched a query with `key`? */
function matches(
  call: { queryKey?: readonly unknown[]; predicate?: (q: unknown) => boolean },
  key: readonly unknown[],
): boolean {
  if (call.predicate) return call.predicate({ queryKey: key });
  if (!call.queryKey) return false;
  return call.queryKey.every((seg, i) => seg === key[i]);
}

beforeEach(() => {
  cleanup();
  settingsOnSuccess = undefined;
});

describe("Avalanche settings save — what it refreshes", () => {
  it("⭐ refreshes the cash-signal projection, not just the forecast bundle", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const spy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <AvalanchePage />
      </QueryClientProvider>,
    );

    expect(settingsOnSuccess).toBeTypeOf("function");
    settingsOnSuccess!();

    const calls = spy.mock.calls.map((c) => c[0] as Parameters<typeof matches>[0]);
    // The ending balance, the low point and the runway all come from here.
    // Before the fix nothing in this list matched it, so the number on screen
    // stayed put for five minutes after the slider moved.
    expect(
      calls.some((c) =>
        matches(c, ["/api/forecast/cash-signal", { horizonDays: 90 }]),
      ),
    ).toBe(true);
    // And the bundle keeps being refreshed — the register and the curve read
    // from that one.
    expect(calls.some((c) => matches(c, ["/api/forecast", { days: 90 }]))).toBe(
      true,
    );
  });
});
