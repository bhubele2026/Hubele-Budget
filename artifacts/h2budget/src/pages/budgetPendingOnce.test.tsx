import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (PR-D, owner decision 6) The Budget page counts a pending purchase once.
 *
 * The server settles every figure (posted, pending, combined, and which
 * pending rows a posted row replaced). The page's job is to SAY how much of a
 * figure is still pending, and to keep the actuals drill tied to the row: a
 * pending row its posted row replaced is in no total, so it is not in the list.
 */

const TEST_MONTH = "2026-07-01";

/** An independent formatter, so the assertions pin the rendered string. */
const usd = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );

type Tx = {
  id: string;
  description: string;
  amount: string;
  occurredOn: string;
  categoryId: string | null;
  isTransfer: boolean;
  pending: boolean;
  source: string | null;
};

let txns: Tx[] = [];
let budgetMonth: Record<string, unknown> | undefined;
const categories = [
  { id: "cat-din", name: "Dining" },
  { id: "cat-gro", name: "Groceries" },
];
const noopMutation = { mutate: vi.fn(), isPending: false };

vi.mock("wouter", () => ({
  useSearch: () => `month=${TEST_MONTH}`,
  useLocation: () => ["/budget", vi.fn()],
  Link: ({
    children,
    href,
    ...rest
  }: {
    children?: React.ReactNode;
    href?: string;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
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
  useUpdateCategory: () => noopMutation,
  useSeedDefaultBudget: () => noopMutation,
  usePinBudgetMonth: () => noopMutation,
  usePinBudgetLine: () => noopMutation,
  useListTransactions: () => ({ data: txns }),
  useGetSettings: () => ({ data: undefined }),
  useListMappingRules: () => ({ data: [] }),
  useUpdateTransaction: () => ({
    mutateAsync: vi.fn(async () => undefined),
    isPending: false,
  }),
  getBudgetMonth: vi.fn(async () => budgetMonth),
  getGetBudgetMonthQueryKey: (m: string) => ["/api/budget/months", m],
  getListCategoriesQueryKey: () => ["/api/categories"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

import BudgetPage from "./budget";
import {
  makeBudgetMonth,
  makeLine,
  makeAllowance,
} from "./__test-helpers__/budget-month";

function fixture() {
  return makeBudgetMonth({
    monthStart: TEST_MONTH,
    lines: [
      // The owner's example after it posted: $40 pending replaced by $48.
      makeLine({
        id: "l-din",
        categoryId: "cat-din",
        categoryName: "Dining",
        planSource: "unbacked",
        plannedAmount: "200.00",
        actualAmount: "48.00",
        postedAmount: "48.00",
        pendingAmount: "0.00",
        combinedAmount: "48.00",
        sourceBreakdown: [{ source: "Bank", count: 1, amount: "48.00" }],
      }),
      // A charge still pending, with nothing to replace it yet.
      makeLine({
        id: "l-gro",
        categoryId: "cat-gro",
        categoryName: "Groceries",
        planSource: "unbacked",
        plannedAmount: "400.00",
        actualAmount: "112.40",
        postedAmount: "72.40",
        pendingAmount: "40.00",
        combinedAmount: "112.40",
        sourceBreakdown: [{ source: "Bank", count: 2, amount: "112.40" }],
      }),
    ],
    replacedPendingIds: ["tx-din-pending"],
    allowance: makeAllowance([
      {
        bucket: "weekly",
        planned: "443.00",
        actual: "88.00",
        posted: "48.00",
        pending: "40.00",
        combined: "88.00",
        count: 2,
        subBuckets: [
          { bucket: "groceries", actual: "40.00", count: 1 },
          { bucket: "dining", actual: "48.00", count: 1 },
          { bucket: "alcohol", actual: "0.00", count: 0 },
          { bucket: "entertainment", actual: "0.00", count: 0 },
          { bucket: "misc", actual: "0.00", count: 0 },
        ],
      },
      {
        bucket: "monthly",
        planned: "250.00",
        actual: "30.00",
        posted: "30.00",
        pending: "0.00",
        combined: "30.00",
        count: 1,
        subBuckets: [],
      },
      {
        bucket: "unplanned",
        planned: "0.00",
        actual: "0.00",
        posted: "0.00",
        pending: "0.00",
        combined: "0.00",
        count: 0,
        subBuckets: [],
      },
    ]),
  });
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
  // Date only: the popover's own timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 6, 20, 17, 0, 0)));
  budgetMonth = fixture();
  txns = [
    { id: "tx-din-pending", description: "OLIVE GARDEN 1234", amount: "-40.00", occurredOn: "2026-07-14", categoryId: "cat-din", isTransfer: false, pending: true, source: "plaid:chase" },
    { id: "tx-din-posted", description: "OLIVE GARDEN 1234", amount: "-48.00", occurredOn: "2026-07-15", categoryId: "cat-din", isTransfer: false, pending: false, source: "plaid:chase" },
    { id: "tx-gro-posted", description: "HY-VEE 1502", amount: "-72.40", occurredOn: "2026-07-16", categoryId: "cat-gro", isTransfer: false, pending: false, source: "plaid:chase" },
    { id: "tx-gro-pending", description: "HY-VEE 1502", amount: "-40.00", occurredOn: "2026-07-18", categoryId: "cat-gro", isTransfer: false, pending: true, source: "plaid:chase" },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("(PR-D) Budget rows say how much of the spend is still pending", () => {
  it("shows the server's combined figure, and 'incl. $40.00 pending' only where something is pending", () => {
    renderPage();
    expect(screen.getByTestId("button-actuals-cat-gro").textContent).toBe(usd("112.40"));
    expect(screen.getByTestId("actual-pending-cat-gro").textContent).toBe(
      `incl. ${usd("40.00")} pending`,
    );
    // The $48 that replaced a $40 pending charge: $48, and nothing pending.
    expect(screen.getByTestId("button-actuals-cat-din").textContent).toBe(usd("48.00"));
    expect(screen.queryByTestId("actual-pending-cat-din")).toBeNull();
  });

  it("⭐ the drill leaves out the pending row a posted row replaced, so it ties to the row ($48, not $88)", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-actuals-cat-din"));
    const list = await screen.findByTestId("actuals-list-cat-din");
    expect(within(list).queryByTestId("actuals-row-tx-din-pending")).toBeNull();
    expect(within(list).getByTestId("actuals-row-tx-din-posted")).toBeTruthy();
    // The running total on the newest row is the row's figure.
    expect(screen.getByTestId("actuals-running-tx-din-posted").textContent).toBe(usd("-48.00"));
    expect(screen.queryByTestId("actuals-split-cat-din")).toBeNull();
  });

  it("the drill splits posted and pending, and marks the row that is still pending", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("button-actuals-cat-gro"));
    await screen.findByTestId("actuals-list-cat-gro");
    const splitRow = screen.getByTestId("actuals-split-cat-gro");
    expect(splitRow.textContent).toContain(`Posted ${usd("72.40")}`);
    expect(splitRow.textContent).toContain(`Pending ${usd("40.00")}`);
    expect(screen.getByTestId("actuals-row-tx-gro-pending").textContent).toContain("pending");
    expect(screen.getByTestId("actuals-row-tx-gro-posted").textContent).not.toContain("pending");
  });
});

describe("(PR-D) the allowance card says how much is still pending", () => {
  it("in the card head and on the bucket that holds it", () => {
    renderPage();
    expect(screen.getByTestId("allowance-pending-total").textContent).toBe(
      `incl. ${usd("40.00")} pending`,
    );
    expect(screen.getByTestId("allowance-pending-weekly").textContent).toBe(
      `incl. ${usd("40.00")} pending`,
    );
    expect(screen.queryByTestId("allowance-pending-monthly")).toBeNull();
  });

  it("says nothing about pending when nothing is", () => {
    budgetMonth = makeBudgetMonth({
      monthStart: TEST_MONTH,
      lines: [makeLine({ categoryId: "cat-gro", categoryName: "Groceries", actualAmount: "10.00" })],
      allowance: makeAllowance([
        { bucket: "weekly", planned: "443.00", actual: "10.00", count: 1, subBuckets: [] },
      ]),
    });
    renderPage();
    expect(screen.queryByTestId("allowance-pending-total")).toBeNull();
    expect(screen.queryByTestId("allowance-pending-weekly")).toBeNull();
    expect(screen.queryByTestId("actual-pending-cat-gro")).toBeNull();
  });
});
