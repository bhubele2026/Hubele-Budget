import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Pin the page's "current month" deterministically. Task #417 added a
// pace indicator inside the analysis strip that only renders when the
// selected month equals "today's" month, so we also pin the system clock
// to a date in the same month so the assertion is stable in CI.
const TEST_MONTH = "2026-05-01";
const TEST_TODAY = new Date(Date.UTC(2026, 4, 15, 12, 0, 0)); // May 15, 2026

type Tx = {
  id: string;
  description: string;
  amount: string;
  occurredOn: string;
  categoryId: string | null;
  isTransfer: boolean;
  source: string | null;
};
type BudgetLineFixture = {
  id: string;
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  actualAmount: string;
  note: string | null;
  groupName: string;
  sourceKind: string;
  sortOrder: number;
  kind: string;
  pinned: boolean;
  sourceBreakdown: Array<{ source: string; count: number; amount: string }>;
};
type BudgetMonthFixture = {
  monthPinned: boolean;
  summary: {
    income: { budget: string; actual: string };
    expenses: { budget: string; actual: string };
    net: { budget: string; actual: string };
    percentSpent: { budget: string; actual: string };
  };
  groups: Array<{
    groupName: string;
    plannedTotal: string;
    actualTotal: string;
    lines: BudgetLineFixture[];
  }>;
};

let txns: Tx[] = [];
let budgetMonth: BudgetMonthFixture | undefined = undefined;
let categories = [
  { id: "cat-1", name: "Groceries" },
  { id: "cat-2", name: "Dining" },
];

const noopMutation = { mutate: vi.fn(), isPending: false };

vi.mock("wouter", () => ({
  useSearch: () => `month=${TEST_MONTH}`,
  useLocation: () => ["/budget", vi.fn()],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetBudgetMonth: () => ({ data: budgetMonth, isLoading: false }),
  useListCategories: () => ({ data: categories, isLoading: false }),
  useUpsertBudgetLine: () => noopMutation,
  useCreateCategory: () => noopMutation,
  useDeleteCategory: () => noopMutation,
  useSeedDefaultBudget: () => noopMutation,
  usePinBudgetMonth: () => noopMutation,
  usePinBudgetLine: () => noopMutation,
  useListTransactions: () => ({ data: txns }),
  useListMappingRules: () => ({ data: [] }),
  useUpdateTransaction: () => ({
    mutateAsync: vi.fn(async () => undefined),
    isPending: false,
  }),
  getGetBudgetMonthQueryKey: (m: string) => ["/api/budget/months", m],
  getListCategoriesQueryKey: () => ["/api/categories"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

import BudgetPage from "./budget";

function makeLine(overrides: Partial<BudgetLineFixture>): BudgetLineFixture {
  return {
    id: "line-x",
    categoryId: "cat-x",
    categoryName: "Cat X",
    plannedAmount: "100",
    actualAmount: "0",
    note: null,
    groupName: "Variable",
    sourceKind: "manual",
    sortOrder: 0,
    kind: "expense",
    pinned: false,
    sourceBreakdown: [],
    ...overrides,
  };
}

function makeBudgetMonth(): BudgetMonthFixture {
  return {
    monthPinned: false,
    summary: {
      income: { budget: "0", actual: "0" },
      expenses: { budget: "100", actual: "40" },
      net: { budget: "0", actual: "0" },
      percentSpent: { budget: "0", actual: "0" },
    },
    groups: [
      {
        groupName: "Variable",
        plannedTotal: "200",
        actualTotal: "40",
        lines: [
          makeLine({
            id: "line-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            plannedAmount: "100",
            // actualAmount drives what the strip displays for "spent".
            actualAmount: "40",
          }),
          makeLine({
            id: "line-2",
            categoryId: "cat-2",
            categoryName: "Dining",
            plannedAmount: "100",
            actualAmount: "0",
          }),
        ],
      },
    ],
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
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
  budgetMonth = makeBudgetMonth();
  // Single contributing transaction this month for cat-1 only. cat-2 has
  // no actuals — the strip should be hidden for that row.
  txns = [
    {
      id: "tx-1",
      description: "TRADER JOES",
      amount: "-40.00",
      occurredOn: "2026-05-03",
      categoryId: "cat-1",
      isTransfer: false,
      source: "plaid:chase",
    },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Budget row analysis strip (#419 — covers strip added in #417)", () => {
  it("renders the analysis strip under a category that has at least one actual this month", () => {
    renderPage();

    const strip = screen.getByTestId("analysis-strip-cat-1");
    const text = strip.textContent ?? "";
    // Spent + planned amounts.
    expect(text).toMatch(/\$40\.00/);
    expect(text).toMatch(/spent/);
    expect(text).toMatch(/\$100\.00/);
    expect(text).toMatch(/planned/);
    // Percent of plan (40 / 100 = 40%).
    expect(text).toMatch(/40%/);
    expect(text).toMatch(/of plan/);
    // Expense line under plan → "remaining" wording (not "over").
    expect(text).toMatch(/remaining/);
  });

  it("does NOT render the analysis strip for a category with zero actuals this month", () => {
    renderPage();

    expect(screen.queryByTestId("analysis-strip-cat-2")).toBeNull();
  });

  it("renders a pace indicator on a current-month expense line with one of the supported labels", () => {
    renderPage();

    const pace = screen.getByTestId("analysis-pace-cat-1");
    const label = (pace.textContent ?? "").trim();
    expect(label).toMatch(/^(on pace|\d+% ahead of pace|\d+% under pace)$/);
    // The strip itself must be the parent so layout regressions that
    // accidentally hoist the pace pill out of the strip are caught here too.
    const strip = screen.getByTestId("analysis-strip-cat-1");
    expect(within(strip).getByTestId("analysis-pace-cat-1")).toBe(pace);
  });
});
