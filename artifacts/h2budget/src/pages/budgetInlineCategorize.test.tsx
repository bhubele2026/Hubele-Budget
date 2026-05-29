import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// --- Mutable per-test state captured by the api-client mock below. -----------
type Tx = {
  id: string;
  description: string;
  amount: string;
  occurredOn: string;
  categoryId: string | null;
  isTransfer: boolean;
  source: string | null;
};
type Rule = {
  id: string;
  pattern: string;
  matchType: "contains" | "starts_with" | "exact";
  categoryId: string;
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
type CategoryFixture = { id: string; name: string };

// Pin the page's "current month" deterministically by always passing
// `?month=2026-05-01` through wouter's useSearch — that way no assertion
// depends on the system clock when the test eventually runs in CI months
// or years from now.
const TEST_MONTH = "2026-05-01";

let txns: Tx[] = [];
let rules: Rule[] = [];
let budgetMonth: BudgetMonthFixture | undefined = undefined;
let categories: CategoryFixture[] = [{ id: "cat-1", name: "Groceries" }];

const updateTxMock = vi.fn(async (_args: { id: string; data: { categoryId: string } }) => undefined);
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
  useUpdateCategory: () => noopMutation,
  useSeedDefaultBudget: () => noopMutation,
  usePinBudgetMonth: () => noopMutation,
  usePinBudgetLine: () => noopMutation,
  useListTransactions: () => ({ data: txns }),
  useListMappingRules: () => ({ data: rules }),
  useUpdateTransaction: () => ({
    mutateAsync: updateTxMock,
    isPending: false,
  }),
  getGetBudgetMonthQueryKey: (m: string) => ["/api/budget/months", m],
  getListCategoriesQueryKey: () => ["/api/categories"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

import BudgetPage from "./budget";

function makeBudgetMonth() {
  return {
    monthPinned: false,
    summary: {
      income: { budget: "0", actual: "0" },
      expenses: { budget: "0", actual: "0" },
      net: { budget: "0", actual: "0" },
      percentSpent: { budget: "0", actual: "0" },
    },
    groups: [
      {
        groupName: "Variable",
        plannedTotal: "100",
        actualTotal: "0",
        lines: [
          {
            id: "line-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            plannedAmount: "100",
            actualAmount: "0",
            note: null,
            groupName: "Variable",
            sourceKind: "manual",
            sortOrder: 0,
            kind: "expense",
            pinned: false,
            sourceBreakdown: [],
          },
        ],
      },
    ],
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <BudgetPage />
    </QueryClientProvider>,
  );
  return { ...utils, qc, invalidateSpy };
}

beforeEach(() => {
  cleanup();
  updateTxMock.mockClear();
  noopMutation.mutate.mockClear();
  budgetMonth = makeBudgetMonth();
  categories = [{ id: "cat-1", name: "Groceries" }];
  rules = [
    {
      id: "rule-1",
      pattern: "starbucks",
      matchType: "contains",
      categoryId: "cat-1",
    },
  ];
  // Three uncategorized transactions in May 2026 (the page's default month
  // when "today" is May 5, 2026 per the project snapshot).
  txns = [
    {
      id: "tx-rule",
      description: "STARBUCKS COFFEE #42",
      amount: "-7.25",
      occurredOn: "2026-05-02",
      categoryId: null,
      isTransfer: false,
      source: "plaid:chase",
    },
    {
      id: "tx-name",
      description: "Groceries Trader Joes",
      amount: "-44.10",
      occurredOn: "2026-05-03",
      categoryId: null,
      isTransfer: false,
      source: "plaid:chase",
    },
    {
      id: "tx-other",
      description: "Random Mystery Charge",
      amount: "-12.99",
      occurredOn: "2026-05-04",
      categoryId: null,
      isTransfer: false,
      source: "plaid:chase",
    },
  ];
});

describe("Budget inline categorize popover (#90/#280)", () => {
  it("splits uncategorized txns into Suggested (rule + name match) and Other", async () => {
    renderPage();

    const trigger = screen.getByTestId("button-categorize-cat-1");
    // The badge advertises 2 suggested matches (rule hit + name hit).
    expect(trigger.getAttribute("data-suggested-count")).toBe("2");
    expect(trigger.textContent).toMatch(/2 matches/);

    fireEvent.click(trigger);

    const list = await screen.findByTestId("uncategorized-list-cat-1");
    expect(within(list).getByText(/Suggested/)).toBeTruthy();
    expect(within(list).getByText(/Other uncategorized/)).toBeTruthy();

    // Rule-matched and name-matched txns appear as Suggested rows.
    expect(
      within(list).getByTestId("button-assign-tx-rule-to-cat-1"),
    ).toBeTruthy();
    expect(
      within(list).getByTestId("button-assign-tx-name-to-cat-1"),
    ).toBeTruthy();
    // Non-matching txn falls through to "Other uncategorized".
    expect(
      within(list).getByTestId("button-assign-tx-other-to-cat-1"),
    ).toBeTruthy();

    // Verify section ordering: both suggested rows come before the "Other" header.
    const html = list.innerHTML;
    const idxSuggested = html.indexOf("Suggested");
    const idxRule = html.indexOf("tx-rule-to-cat-1");
    const idxName = html.indexOf("tx-name-to-cat-1");
    const idxOtherHeader = html.indexOf("Other uncategorized");
    const idxOtherRow = html.indexOf("tx-other-to-cat-1");
    expect(idxSuggested).toBeLessThan(idxRule);
    expect(idxSuggested).toBeLessThan(idxName);
    expect(idxRule).toBeLessThan(idxOtherHeader);
    expect(idxName).toBeLessThan(idxOtherHeader);
    expect(idxOtherHeader).toBeLessThan(idxOtherRow);
  });

  it("hides the categorize badge entirely when no uncategorized txn matches a rule or the category name (#417)", async () => {
    rules = []; // no rule for cat-1
    txns = [
      {
        id: "tx-only",
        description: "Random Mystery Charge",
        amount: "-12.99",
        occurredOn: "2026-05-04",
        categoryId: null,
        isTransfer: false,
        source: "plaid:chase",
      },
    ];

    renderPage();

    // #417 removed the neutral "+N" fallback so unrelated uncategorized
    // txns no longer add a noisy chip to every Budget row. The badge only
    // renders when there is at least one rule/name-suggested match.
    expect(screen.queryByTestId("button-categorize-cat-1")).toBeNull();
  });

  it("calls update-transaction with the row's categoryId and invalidates txns + budget month on success", async () => {
    const { invalidateSpy } = renderPage();

    fireEvent.click(screen.getByTestId("button-categorize-cat-1"));
    const assignBtn = await screen.findByTestId(
      "button-assign-tx-rule-to-cat-1",
    );
    fireEvent.click(assignBtn);

    await waitFor(() => {
      expect(updateTxMock).toHaveBeenCalledWith({
        id: "tx-rule",
        data: { categoryId: "cat-1" },
      });
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown }).queryKey,
    );
    // On success the page invalidates both the transactions list (so the
    // newly-assigned row leaves the uncategorized pool everywhere it
    // surfaces) and the current month's budget query (so actuals refresh).
    expect(invalidatedKeys).toContainEqual(["/api/transactions"]);
    expect(invalidatedKeys).toContainEqual([
      "/api/budget/months",
      TEST_MONTH,
    ]);
  });

  it("excludes transactions from other months and transfers from the popover", async () => {
    txns = [
      // wrong month — should be ignored
      {
        id: "tx-april",
        description: "STARBUCKS APRIL",
        amount: "-1.00",
        occurredOn: "2026-04-15",
        categoryId: null,
        isTransfer: false,
        source: "plaid:chase",
      },
      // transfer — always excluded from budget actuals
      {
        id: "tx-transfer",
        description: "STARBUCKS TRANSFER",
        amount: "-1.00",
        occurredOn: "2026-05-02",
        categoryId: null,
        isTransfer: true,
        source: "plaid:chase",
      },
      // valid suggested txn this month
      {
        id: "tx-keep",
        description: "STARBUCKS KEEP",
        amount: "-3.00",
        occurredOn: "2026-05-02",
        categoryId: null,
        isTransfer: false,
        source: "plaid:chase",
      },
    ];

    renderPage();
    const trigger = screen.getByTestId("button-categorize-cat-1");
    expect(trigger.getAttribute("data-suggested-count")).toBe("1");

    fireEvent.click(trigger);
    const list = await screen.findByTestId("uncategorized-list-cat-1");
    expect(
      within(list).getByTestId("button-assign-tx-keep-to-cat-1"),
    ).toBeTruthy();
    expect(
      within(list).queryByTestId("button-assign-tx-april-to-cat-1"),
    ).toBeNull();
    expect(
      within(list).queryByTestId("button-assign-tx-transfer-to-cat-1"),
    ).toBeNull();
  });
});
