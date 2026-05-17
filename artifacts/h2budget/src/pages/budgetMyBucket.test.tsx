import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// --- Mutable per-test state captured by the api-client mock below. -----------
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
type CategoryFixture = {
  id: string;
  name: string;
  groupName: string;
  sourceKind: string;
  sortOrder: number;
};

const TEST_MONTH = "2026-05-01";

let budgetMonth: BudgetMonthFixture | undefined = undefined;
let categories: CategoryFixture[] = [];

const updateCategoryMock = vi.fn(
  async (_args: {
    id: string;
    data: { name?: string; sortOrder?: number };
  }) => undefined,
);
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
  useUpdateCategory: () => ({
    // The page calls .mutate for renames and .mutateAsync for the two-step
    // reorder swap. Both routes through the same captured spy so tests can
    // assert against a single call log.
    mutate: (
      args: { id: string; data: { name?: string; sortOrder?: number } },
      opts?: { onSuccess?: () => void },
    ) => {
      void updateCategoryMock(args).then(() => opts?.onSuccess?.());
    },
    mutateAsync: (args: {
      id: string;
      data: { name?: string; sortOrder?: number };
    }) => updateCategoryMock(args),
    isPending: false,
  }),
  useSeedDefaultBudget: () => noopMutation,
  usePinBudgetMonth: () => noopMutation,
  usePinBudgetLine: () => noopMutation,
  useListTransactions: () => ({ data: [] }),
  useListMappingRules: () => ({ data: [] }),
  useUpdateTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  getGetBudgetMonthQueryKey: (m: string) => ["/api/budget/months", m],
  getListCategoriesQueryKey: () => ["/api/categories"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

import BudgetPage from "./budget";

function makeMyBudgetMonth(): BudgetMonthFixture {
  // Two manual envelopes living in the "My budget" group, in the order
  // the server returns them (already sorted by sortOrder ascending).
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
        groupName: "My budget",
        plannedTotal: "0",
        actualTotal: "0",
        lines: [
          {
            id: "line-gifts",
            categoryId: "cat-gifts",
            categoryName: "Birthday gifts",
            plannedAmount: "50",
            actualAmount: "0",
            note: null,
            groupName: "My budget",
            sourceKind: "manual",
            sortOrder: 0,
            kind: "expense",
            pinned: false,
            sourceBreakdown: [],
          },
          {
            id: "line-soccer",
            categoryId: "cat-soccer",
            categoryName: "Kids soccer",
            plannedAmount: "80",
            actualAmount: "0",
            note: null,
            groupName: "My budget",
            sourceKind: "manual",
            sortOrder: 1,
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
  updateCategoryMock.mockClear();
  noopMutation.mutate.mockClear();
  budgetMonth = makeMyBudgetMonth();
  categories = [
    {
      id: "cat-gifts",
      name: "Birthday gifts",
      groupName: "My budget",
      sourceKind: "manual",
      sortOrder: 0,
    },
    {
      id: "cat-soccer",
      name: "Kids soccer",
      groupName: "My budget",
      sourceKind: "manual",
      sortOrder: 1,
    },
  ];
});

describe("Budget — My budget bucket rename + reorder (#692)", () => {
  it("only renders rename + move controls inside the My budget card", () => {
    renderPage();

    // Both envelopes in My budget get the new pencil + arrow controls.
    expect(screen.getByTestId("button-rename-cat-gifts")).toBeTruthy();
    expect(screen.getByTestId("button-rename-cat-soccer")).toBeTruthy();
    expect(screen.getByTestId("button-move-up-cat-gifts")).toBeTruthy();
    expect(screen.getByTestId("button-move-down-cat-soccer")).toBeTruthy();
  });

  it("disables move-up on the first envelope and move-down on the last one", () => {
    renderPage();

    // The first row can move down but not up; the last row mirrors it.
    // This is what keeps the user from clicking arrows that would no-op.
    expect(
      (screen.getByTestId("button-move-up-cat-gifts") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("button-move-down-cat-gifts") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("button-move-up-cat-soccer") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("button-move-down-cat-soccer") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("commits a rename via Enter and calls update-category with the trimmed name", async () => {
    const { invalidateSpy } = renderPage();

    fireEvent.click(screen.getByTestId("button-rename-cat-gifts"));
    const input = (await screen.findByTestId(
      "input-rename-cat-gifts",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Birthday presents  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(updateCategoryMock).toHaveBeenCalledWith({
        id: "cat-gifts",
        data: { name: "Birthday presents" },
      });
    });

    // After a successful rename the page refreshes the categories list
    // directly, and uses a predicate to invalidate every cached budget
    // month (current + prefetched neighbors) so the new name surfaces
    // everywhere the envelope is displayed without flashing stale data.
    const calls = invalidateSpy.mock.calls.map(
      (c) => c[0] as { queryKey?: unknown; predicate?: unknown },
    );
    const keys = calls
      .map((c) => c?.queryKey)
      .filter((k): k is unknown[] => Array.isArray(k));
    expect(keys).toContainEqual(["/api/categories"]);
    expect(calls.some((c) => typeof c?.predicate === "function")).toBe(true);
  });

  it("cancels the rename when the user presses Escape without firing the mutation", async () => {
    renderPage();

    fireEvent.click(screen.getByTestId("button-rename-cat-gifts"));
    const input = (await screen.findByTestId(
      "input-rename-cat-gifts",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Should be discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    // Input disappears and the drill-down name button comes back, untouched.
    await waitFor(() => {
      expect(screen.queryByTestId("input-rename-cat-gifts")).toBeNull();
    });
    expect(screen.getByTestId("button-category-name-cat-gifts")).toBeTruthy();
    expect(updateCategoryMock).not.toHaveBeenCalled();
  });

  it("never exposes rename + move controls on the bill-/debt-backed groups", () => {
    // Add an auto_bills group alongside the My budget group so we can
    // assert the rename/reorder controls are only wired up inside the
    // manual envelope card — the server would reject patches against
    // auto-sourced categories, so leaking the UI there would be a bug.
    budgetMonth = {
      ...makeMyBudgetMonth(),
      groups: [
        {
          groupName: "Bills",
          plannedTotal: "0",
          actualTotal: "0",
          lines: [
            {
              id: "line-power",
              categoryId: "cat-power",
              categoryName: "Power",
              plannedAmount: "120",
              actualAmount: "0",
              note: null,
              groupName: "Bills",
              sourceKind: "auto_bills",
              sortOrder: 0,
              kind: "expense",
              pinned: false,
              sourceBreakdown: [],
            },
          ],
        },
        ...makeMyBudgetMonth().groups,
      ],
    };
    categories = [
      ...categories,
      {
        id: "cat-power",
        name: "Power",
        groupName: "Bills",
        sourceKind: "auto_bills",
        sortOrder: 0,
      },
    ];

    renderPage();

    // My budget envelopes still have the controls.
    expect(screen.getByTestId("button-rename-cat-gifts")).toBeTruthy();
    expect(screen.getByTestId("button-move-up-cat-gifts")).toBeTruthy();
    // The auto_bills row gets none of them — the parent never passes
    // onRename/onMove, so the BudgetLineRow renders without those
    // buttons regardless of who the underlying category is.
    expect(screen.queryByTestId("button-rename-cat-power")).toBeNull();
    expect(screen.queryByTestId("button-move-up-cat-power")).toBeNull();
    expect(screen.queryByTestId("button-move-down-cat-power")).toBeNull();
  });

  it("bumps sortOrder when neighbors are tied so an equal-sort move is observable", async () => {
    // Both envelopes seeded at 9999 — the common new-category case. A
    // naive swap would leave both fields unchanged and the row would
    // silently fail to move on the server.
    categories = [
      {
        id: "cat-gifts",
        name: "Birthday gifts",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 9999,
      },
      {
        id: "cat-soccer",
        name: "Kids soccer",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 9999,
      },
    ];

    renderPage();

    // Move-down on the first envelope: it should end up with the higher
    // sortOrder so the rows actually swap after refetch.
    fireEvent.click(screen.getByTestId("button-move-down-cat-gifts"));
    await waitFor(() =>
      expect(updateCategoryMock).toHaveBeenCalledTimes(2),
    );
    expect(updateCategoryMock).toHaveBeenCalledWith({
      id: "cat-gifts",
      data: { sortOrder: 10000 },
    });
    expect(updateCategoryMock).toHaveBeenCalledWith({
      id: "cat-soccer",
      data: { sortOrder: 9999 },
    });

    updateCategoryMock.mockClear();

    // Symmetrically, move-up on the second envelope must leave it with
    // the lower sortOrder. Without the direction-aware fallback this
    // case would also no-op.
    fireEvent.click(screen.getByTestId("button-move-up-cat-soccer"));
    await waitFor(() =>
      expect(updateCategoryMock).toHaveBeenCalledTimes(2),
    );
    expect(updateCategoryMock).toHaveBeenCalledWith({
      id: "cat-soccer",
      data: { sortOrder: 9999 },
    });
    expect(updateCategoryMock).toHaveBeenCalledWith({
      id: "cat-gifts",
      data: { sortOrder: 10000 },
    });
  });

  it("swaps sortOrder with the adjacent envelope when the user clicks move-down", async () => {
    renderPage();

    fireEvent.click(screen.getByTestId("button-move-down-cat-gifts"));

    // Reorder is a two-step swap: each envelope inherits its neighbor's
    // sortOrder. Asserting on both calls protects against accidentally
    // collapsing the swap to a single PATCH that would leave the order
    // unchanged.
    await waitFor(() => {
      expect(updateCategoryMock).toHaveBeenCalledTimes(2);
    });
    expect(updateCategoryMock).toHaveBeenCalledWith({
      id: "cat-gifts",
      data: { sortOrder: 1 },
    });
    expect(updateCategoryMock).toHaveBeenCalledWith({
      id: "cat-soccer",
      data: { sortOrder: 0 },
    });
  });
});
