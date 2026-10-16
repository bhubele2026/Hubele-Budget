import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (T4) Budget never shows $0 for a missing load: a failed first load is a dash and a
 * banner; a failed refresh keeps the last figures and says how old they are.
 */
const TEST_MONTH = "2026-05-01";
const TEST_TODAY = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));

let budgetMonth: ReturnType<typeof makeMonth> | undefined;
let mode: "ok" | "load-failed" | "refresh-failed" = "ok";
const noopMutation = { mutate: vi.fn(), isPending: false };

vi.mock("wouter", () => ({
  useSearch: () => `month=${TEST_MONTH}`,
  useLocation: () => ["/budget", vi.fn()],
  Link: (p: { children?: React.ReactNode; href?: string }) => <a href={p.href}>{p.children}</a>,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetBudgetMonth: () => ({
    data: mode === "load-failed" ? undefined : budgetMonth,
    isLoading: false,
    isError: mode !== "ok",
    isLoadingError: mode === "load-failed",
    isRefetchError: mode === "refresh-failed",
    dataUpdatedAt: mode === "refresh-failed" ? Date.now() - 6 * 60_000 : 0,
    refetch: vi.fn(),
  }),
  useListCategories: () => ({ data: [{ id: "cat-1", name: "Groceries" }], isLoading: false }),
  useUpsertBudgetLine: () => noopMutation,
  useCreateCategory: () => noopMutation,
  useDeleteCategory: () => noopMutation,
  useUpdateCategory: () => noopMutation,
  useSeedDefaultBudget: () => noopMutation,
  usePinBudgetMonth: () => noopMutation,
  usePinBudgetLine: () => noopMutation,
  useListTransactions: () => ({ data: [] }),
  useGetSettings: () => ({ data: undefined }),
  useListMappingRules: () => ({ data: [] }),
  useUpdateTransaction: () => ({ mutateAsync: vi.fn(async () => undefined), isPending: false }),
  getBudgetMonth: vi.fn(async () => budgetMonth),
  getGetBudgetMonthQueryKey: (m: string) => ["/api/budget/months", m],
  getListCategoriesQueryKey: () => ["/api/categories"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

import BudgetPage from "./budget";
import { makeBudgetMonth as makeMonth, makeLine } from "./__test-helpers__/budget-month";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BudgetPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
  vi.setSystemTime(TEST_TODAY);
  mode = "ok";
  budgetMonth = makeMonth({
    monthStart: TEST_MONTH,
    lines: [makeLine({ id: "line-1", categoryId: "cat-1", categoryName: "Groceries", planSource: "bills", plannedAmount: "100", actualAmount: "40" })],
  });
});
afterEach(() => vi.useRealTimers());

describe("Budget — a failed load or refresh (T4)", () => {
  it("a failed first load: the banner, a dash for the plan, no $0.00 and no envelope sections", () => {
    mode = "load-failed";
    const { container } = renderPage();
    expect(screen.getByTestId("budget-refresh-banner").textContent).toContain("Couldn't load these numbers");
    expect(screen.getByTestId("hero-planned").textContent).toBe("—");
    expect(container.textContent).not.toContain("$0.00");
    expect(screen.queryByTestId("budget-hero")).toBeNull();
  });

  it("a failed refresh keeps the figures and says how old they are", () => {
    mode = "refresh-failed";
    renderPage();
    expect(screen.getByTestId("budget-refresh-banner").textContent).toMatch(/^Couldn't refresh\. Showing numbers from /);
    expect(screen.getByTestId("budget-hero")).toBeTruthy();
    expect(screen.queryByTestId("budget-hero-missing")).toBeNull();
  });

  it("no failure: no banner", () => {
    renderPage();
    expect(screen.queryByTestId("budget-refresh-banner")).toBeNull();
  });
});
