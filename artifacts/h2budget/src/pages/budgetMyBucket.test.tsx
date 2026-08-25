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
type CategoryFixture = {
  id: string;
  name: string;
  groupName: string;
  sourceKind: string;
  sortOrder: number;
};

const TEST_MONTH = "2026-05-01";

let budgetMonth: ReturnType<typeof makeMonth> | undefined = undefined;
let categories: CategoryFixture[] = [];
type TxnFixture = {
  id: string;
  amount: string;
  categoryId: string | null;
  isTransfer: boolean;
  occurredOn: string;
  description: string;
};
let listTxns: TxnFixture[] = [];

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
  // The page renders a <Link> in the allowances card. This fixture does not
  // reach it, which is precisely why it belongs in the mock: a future page
  // edit should fail on an assertion, not on "Link is not a function".
  Link: (p: { children?: React.ReactNode; href?: string }) => (
    <a href={p.href}>{p.children}</a>
  ),
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
  useListTransactions: () => ({ data: listTxns }),
  useGetSettings: () => ({ data: undefined }),
  useListMappingRules: () => ({ data: [] }),
  useUpdateTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  getBudgetMonth: vi.fn(async () => budgetMonth),
  getGetBudgetMonthQueryKey: (m: string) => ["/api/budget/months", m],
  getListCategoriesQueryKey: () => ["/api/categories"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

import BudgetPage from "./budget";
import {
  makeBudgetMonth as makeMonth,
  makeLine,
} from "./__test-helpers__/budget-month";

function makeMyBudgetMonth() {
  // Two hand-made envelopes with no bill and no debt behind them — the only
  // kind the page still lets you create, and the only kind it lets you rename.
  return makeMonth({
    monthStart: TEST_MONTH,
    lines: [
      makeLine({
        id: "line-gifts",
        categoryId: "cat-gifts",
        categoryName: "Birthday gifts",
        groupName: "My budget",
        planSource: "unbacked",
        plannedAmount: "50",
        sortOrder: 0,
      }),
      makeLine({
        id: "line-soccer",
        categoryId: "cat-soccer",
        categoryName: "Kids soccer",
        groupName: "My budget",
        planSource: "unbacked",
        plannedAmount: "80",
        sortOrder: 1,
      }),
    ],
  });
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
  listTxns = [];
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

describe("Budget — the hand-planned envelope card", () => {
  /**
   * ⚠️ THE REORDER SPECS THAT USED TO LIVE HERE ARE GONE ON PURPOSE.
   *
   * Drag-to-reorder and the up/down arrows were removed with the rebuild:
   * order now comes from the source and then from size, which is the only
   * ranking a reader of a budget wants and one that does not move between two
   * renders of the same month. The test below pins their absence so they
   * cannot creep back in unnoticed.
   */
  it("no longer offers any hand-ordering control", () => {
    renderPage();
    for (const id of [
      "button-move-up-cat-gifts",
      "button-move-down-cat-gifts",
      "button-move-up-cat-soccer",
      "button-move-down-cat-soccer",
      "drag-handle-cat-gifts",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    // The rename control, which is not ordering, survives.
    expect(screen.getByTestId("button-rename-cat-gifts")).toBeTruthy();
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

  it("⚠️ never exposes the rename control on a bill-backed row", () => {
    // The server rejects a name patch against anything but sourceKind
    // "manual", so leaking the pencil onto a bill row would be an affordance
    // that only ever errors. The page passes `onRename` from the
    // hand-planned section alone.
    budgetMonth = makeMonth({
      monthStart: TEST_MONTH,
      lines: [
        makeLine({
          id: "line-power",
          categoryId: "cat-power",
          categoryName: "Power",
          groupName: "Bills",
          sourceKind: "auto_bills",
          planSource: "bills",
          plannedAmount: "120",
        }),
        makeLine({
          id: "line-gifts",
          categoryId: "cat-gifts",
          categoryName: "Birthday gifts",
          groupName: "My budget",
          planSource: "unbacked",
          plannedAmount: "50",
        }),
      ],
    });
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

    expect(screen.getByTestId("button-rename-cat-gifts")).toBeTruthy();
    expect(screen.queryByTestId("button-rename-cat-power")).toBeNull();
  });

  it("puts the two kinds of envelope in different sections", () => {
    budgetMonth = makeMonth({
      monthStart: TEST_MONTH,
      lines: [
        makeLine({
          categoryId: "cat-power",
          categoryName: "Power",
          planSource: "bills",
          plannedAmount: "120",
        }),
        makeLine({
          categoryId: "cat-gifts",
          categoryName: "Birthday gifts",
          planSource: "unbacked",
          plannedAmount: "50",
        }),
      ],
    });
    renderPage();
    expect(
      within(screen.getByTestId("section-bills")).getByTestId(
        "row-budget-cat-power",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("section-unbacked")).getByTestId(
        "row-budget-cat-gifts",
      ),
    ).toBeTruthy();
  });

  it("(#705) renders the rename input when the pencil is clicked — guards onRename prop wiring", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-rename-cat-gifts"));
    expect(
      await screen.findByTestId("input-rename-cat-gifts"),
    ).toBeTruthy();
  });

  // (#698) Confirm dialog branches for "My budget" envelope deletion.
  // Empty envelopes skip the prompt entirely so the common case stays one
  // click — there's no destructive side effect to warn about. Non-empty
  // envelopes show a warning with the count and total amount about to be
  // uncategorized so the user knows their existing spending will drop off
  // the monthly roll-up.
  describe("(#698) delete confirm warns when the envelope still has spending", () => {
    it("skips the confirm prompt and deletes straight away when the envelope has no transactions this month", () => {
      const confirmSpy = vi
        .spyOn(window, "confirm")
        .mockImplementation(() => false);
      renderPage();
      fireEvent.click(screen.getByTestId("button-delete-cat-gifts"));
      // Empty envelope → no prompt, the delete mutation fires directly.
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(noopMutation.mutate).toHaveBeenCalledWith(
        { id: "cat-gifts" },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      confirmSpy.mockRestore();
    });

    it("shows the count + total amount in the prompt when the envelope has categorized transactions this month", () => {
      // Seed two transactions in the current test month assigned to
      // cat-gifts. The page indexes these via txnsByCategoryThisMonth
      // and the My budget onDelete wrapper passes them to the delete
      // handler so the prompt can warn the user before they orphan
      // real spending.
      listTxns = [
        {
          id: "tx-1",
          amount: "30.00",
          categoryId: "cat-gifts",
          isTransfer: false,
          occurredOn: `${TEST_MONTH.slice(0, 8)}05`,
          description: "Gift store",
        },
        {
          id: "tx-2",
          amount: "20.00",
          categoryId: "cat-gifts",
          isTransfer: false,
          occurredOn: `${TEST_MONTH.slice(0, 8)}10`,
          description: "Gift store 2",
        },
      ];

      const confirmSpy = vi
        .spyOn(window, "confirm")
        .mockImplementation(() => false);
      renderPage();
      fireEvent.click(screen.getByTestId("button-delete-cat-gifts"));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      const msg = String(confirmSpy.mock.calls[0]![0] ?? "");
      // Count + total surface in the prompt so the user can decide.
      expect(msg).toContain("2 transactions");
      expect(msg).toContain("$50.00");
      expect(msg.toLowerCase()).toContain("uncategorized");
      confirmSpy.mockRestore();
    });
  });

});
