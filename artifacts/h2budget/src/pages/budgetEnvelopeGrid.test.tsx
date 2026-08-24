import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * C6 — the envelope grid on kit cards with CSS fill meters.
 *
 * ⚠️ WHY THERE IS NO SPINE PARITY ASSERTION IN THIS FILE. The Phase C recipe
 * says any number a page shows that the spine ALSO carries gets pinned to the
 * spine. The Budget page shows none: `/api/spine` carries bank balance, spend
 * for the month/week, next bill, forecast low point, payoff percent and the
 * review count — and not one budget, plan, category or envelope field. The
 * near-miss is `spine.spentMonth` vs `summary.expenses.actual`, and those are
 * two different aggregates by construction (the spine stops at TODAY and drops
 * debt payments, autopay-worded rows and reimbursements; the budget runs the
 * whole month and counts all of them). B3's own parity guard reflects this —
 * `spineParity.integration.test.ts` deliberately does not mount the budget
 * router. Asserting equality here would encode a falsehood that passes only on
 * a fixture and fails on real data.
 *
 * So the invariant this file guards is the one that IS true and is the same
 * one the spine rule exists to protect: THE PAGE NEVER RE-DERIVES MONEY. Every
 * figure is the server's own string, and a decoy transaction list cannot move
 * any of them.
 */

const TEST_MONTH = "2026-05-01";
const TEST_TODAY = new Date(Date.UTC(2026, 4, 15, 12, 0, 0)); // May 15, 2026

/**
 * The deep orange that means "over"; the navy that means "resting".
 * Asserted as `rgb()` because that is what reading back `style.background`
 * gives you — the browser (and jsdom) normalise the hex on the way in.
 */
const BAD_RGB = "rgb(225, 109, 62)"; // #e16d3e
const NAVY_RGB = "rgb(25, 49, 91)"; // #19315b

/**
 * An INDEPENDENT money formatter, deliberately not the app's `formatCurrency`,
 * so these assertions pin the rendered string instead of agreeing with
 * whatever the app happens to do.
 */
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
  source: string | null;
};
type Line = {
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

/** Distinctive figures, so "the page printed the server's number" is provable
 *  rather than a coincidence of round values. */
const SUMMARY = {
  income: { budget: "7200.00", actual: "6431.12" },
  expenses: { budget: "5400.00", actual: "4187.55" },
  net: { budget: "1800.00", actual: "2243.57" },
  percentSpent: { budget: "75.0", actual: "65.1" },
};

let txns: Tx[] = [];
let budgetMonth: Record<string, unknown> | undefined;
let settings: Record<string, unknown> | undefined;
const categories = [
  { id: "cat-over", name: "Groceries" },
  { id: "cat-under", name: "Utilities" },
  { id: "cat-noplan", name: "Gifts" },
  { id: "cat-income", name: "Salary" },
];

const noopMutation = { mutate: vi.fn(), isPending: false };

vi.mock("wouter", () => ({
  useSearch: () => `month=${TEST_MONTH}`,
  useLocation: () => ["/budget", vi.fn()],
  // The allowances card links out to /allowances. The three older budget
  // specs get away without this only because their fixtures never render that
  // card; pinning it here keeps the mock honest about what the page imports.
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
  useGetSettings: () => ({ data: settings }),
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

function makeLine(overrides: Partial<Line>): Line {
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

function makeBudgetMonth() {
  return {
    monthPinned: false,
    summary: SUMMARY,
    groups: [
      {
        groupName: "Variable",
        plannedTotal: "500.00",
        actualTotal: "620.00",
        lines: [
          makeLine({
            id: "l1",
            categoryId: "cat-over",
            categoryName: "Groceries",
            plannedAmount: "400.00",
            actualAmount: "520.00", // 130% — over plan
          }),
          makeLine({
            id: "l2",
            categoryId: "cat-under",
            categoryName: "Utilities",
            plannedAmount: "100.00",
            actualAmount: "40.00", // 40% — under plan
          }),
          makeLine({
            id: "l3",
            categoryId: "cat-noplan",
            categoryName: "Gifts",
            plannedAmount: "0",
            actualAmount: "0", // the empty / zero state
          }),
        ],
      },
      {
        groupName: "Income",
        plannedTotal: "1000.00",
        actualTotal: "800.00",
        lines: [
          makeLine({
            id: "l4",
            categoryId: "cat-income",
            categoryName: "Salary",
            groupName: "Income",
            kind: "income",
            plannedAmount: "1000.00",
            actualAmount: "800.00", // income that fell short
          }),
        ],
      },
      { groupName: "Empty", plannedTotal: "0", actualTotal: "0", lines: [] },
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

/** The row element carrying a category's cells. */
function row(categoryId: string): HTMLElement {
  return screen.getByTestId(`row-budget-${categoryId}`);
}

/** The meter's FILL span inside a row — `aria-hidden`, so RTL's queries
 *  rightly refuse to see it and we go through the DOM. */
function meterFill(categoryId: string): HTMLElement {
  const el = row(categoryId).querySelector(".bar-sweep");
  if (!el) throw new Error(`no fill meter in row ${categoryId}`);
  return el as HTMLElement;
}

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
  vi.setSystemTime(TEST_TODAY);
  budgetMonth = makeBudgetMonth();
  settings = undefined;
  txns = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Budget envelope grid — the numbers", () => {
  it("prints the server summary verbatim in the headline stats", () => {
    renderPage();
    const cases: Array<[string, string]> = [
      ["tile-projected", SUMMARY.net.budget],
      ["tile-net", SUMMARY.net.actual],
      ["tile-income", SUMMARY.income.actual],
      ["tile-expenses", SUMMARY.expenses.actual],
    ];
    for (const [testid, value] of cases) {
      expect(screen.getByTestId(testid).textContent).toContain(usd(value));
    }
    // The percentage is the server's own string, not re-divided on the client.
    expect(screen.getByTestId("tile-percent-spent").textContent).toContain(
      `${SUMMARY.percentSpent.actual}%`,
    );
  });

  it("⚠️ does NOT re-derive any figure from the transaction list", () => {
    txns = [
      {
        id: "decoy",
        description: "DECOY",
        amount: "-9999.00",
        occurredOn: "2026-05-04",
        categoryId: "cat-over",
        isTransfer: false,
        source: "plaid:chase",
      },
    ];
    renderPage();
    for (const testid of [
      "tile-projected",
      "tile-net",
      "tile-income",
      "tile-expenses",
    ]) {
      expect(screen.getByTestId(testid).textContent).not.toContain("9,999");
    }
    expect(screen.getByTestId("tile-expenses").textContent).toContain(
      usd(SUMMARY.expenses.actual),
    );
    // The row's own actual is the server's line figure, not a client re-sum.
    expect(screen.getByTestId("button-actuals-cat-over").textContent).toBe(
      usd("520.00"),
    );
  });

  it("keeps the plan, actual and difference figures on every row", () => {
    renderPage();
    expect(
      (screen.getByTestId("input-planned-cat-over") as HTMLInputElement).value,
    ).toBe("400.00");
    expect(screen.getByTestId("button-actuals-cat-over").textContent).toBe(
      usd("520.00"),
    );
    // planned − actual = −120 for an expense that overspent.
    expect(row("cat-over").textContent).toContain(usd("-120.00"));
    // …and +60 for the one that came in under.
    expect(row("cat-under").textContent).toContain(`+${usd("60.00")}`);
  });
});

describe("Budget envelope grid — state is said in words", () => {
  it("labels an over-budget row 'over' and an under-budget row 'left'", () => {
    renderPage();
    const over = within(row("cat-over")).getByTestId("pct-direction-cat-over");
    expect(over.textContent).toBe("over");
    expect(over.getAttribute("aria-label")).toBe("over plan");

    const under = within(row("cat-under")).getByTestId(
      "pct-direction-cat-under",
    );
    expect(under.textContent).toBe("left");
    expect(under.getAttribute("aria-label")).toBe("under plan");
  });

  it("says 'short' when INCOME misses its plan, never 'over'", () => {
    renderPage();
    const chip = within(row("cat-income")).getByTestId(
      "pct-direction-cat-income",
    );
    expect(chip.textContent).toBe("short");
    expect(chip.getAttribute("aria-label")).toBe("short of plan");
  });

  it("carries the state on a .chip, so colour is never the only signal", () => {
    renderPage();
    // Over spends the alarm colour; under is the resting grey. Both carry a
    // word, which is the actual contract — the class only reinforces it.
    expect(
      within(row("cat-over"))
        .getByTestId("pct-direction-cat-over")
        .className.split(/\s+/),
    ).toEqual(expect.arrayContaining(["chip", "bad"]));
    expect(
      within(row("cat-under"))
        .getByTestId("pct-direction-cat-under")
        .className.split(/\s+/),
    ).toEqual(expect.arrayContaining(["chip", "gray"]));
  });

  it("states each group's position in words on its head", () => {
    renderPage();
    // Variable: planned 500 − actual 620 = 120 over.
    expect(screen.getByTestId("button-toggle-Variable").textContent).toContain(
      `${usd("120.00")} over`,
    );
    // Income: actual 800 − planned 1000 = 200 short.
    expect(screen.getByTestId("button-toggle-Income").textContent).toContain(
      `${usd("200.00")} short`,
    );
  });
});

describe("Budget envelope grid — the CSS fill meters", () => {
  it("draws an over-plan envelope full and in the deep orange", () => {
    renderPage();
    const fill = meterFill("cat-over");
    expect(fill.style.width).toBe("100%");
    expect(fill.style.background).toBe(BAD_RGB);
  });

  it("marks where the plan ran out once actual passes it", () => {
    renderPage();
    // 520 spent against 400 planned ⇒ the plan sits at 400/520 ≈ 76.9%.
    const marker = row("cat-over").querySelector(
      "[style*='left']",
    ) as HTMLElement | null;
    expect(marker).not.toBeNull();
    expect(marker!.style.left.startsWith("76.9")).toBe(true);
  });

  it("draws an under-plan envelope part-full and in navy, with no marker", () => {
    renderPage();
    const fill = meterFill("cat-under");
    expect(fill.style.width).toBe("40%"); // 40 of 100
    expect(fill.style.background).toBe(NAVY_RGB);
    expect(row("cat-under").querySelector("[style*='left']")).toBeNull();
  });

  it("uses the kit's own motion classes, not a bespoke transition", () => {
    renderPage();
    const cls = meterFill("cat-over").className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["bar-sweep", "grow-x"]));
  });
});

describe("Budget envelope grid — empty and zero states", () => {
  it("shows an em dash and no state chip for an envelope with no plan", () => {
    renderPage();
    expect(row("cat-noplan").textContent).toContain("—");
    expect(
      within(row("cat-noplan")).queryByTestId("pct-direction-cat-noplan"),
    ).toBeNull();
    // A zero ceiling must not draw a fill, and must not divide by zero.
    expect(meterFill("cat-noplan").style.width).toBe("0%");
  });

  it("shows a quiet note for a group with no lines", () => {
    renderPage();
    expect(screen.getByTestId("group-Empty").textContent).toContain(
      "No lines yet.",
    );
  });

  it("shows a quiet note for an empty My budget card", () => {
    renderPage();
    expect(screen.getByTestId("empty-my-budget").textContent).toContain(
      "No envelopes yet.",
    );
  });

  it("still renders the grid when the month summary has not arrived", () => {
    budgetMonth = { monthPinned: false, summary: undefined, groups: [] };
    renderPage();
    expect(screen.queryByTestId("budget-summary")).toBeNull();
    // Never a blank route: the My budget card is always standing.
    expect(screen.getByTestId("group-My budget")).toBeTruthy();
  });
});

describe("Budget envelope grid — allowances", () => {
  beforeEach(() => {
    settings = {
      weeklyAllowanceAmount: "100",
      monthlyAllowanceAmount: "250",
      unplannedAllowanceAmount: "0",
    };
  });

  it("states each bucket's headroom in words", () => {
    renderPage();
    const card = screen.getByTestId("budget-allowances-group");
    expect(card.textContent).toContain(`${usd("250.00")} left`);
    // A bucket with no cap says so rather than showing a meaningless 0%.
    expect(card.textContent).toContain("no cap set");
  });

  it("links out to the Allowances page", () => {
    renderPage();
    expect(
      screen
        .getByTestId("budget-allowances-manage")
        .getAttribute("href"),
    ).toBe("/allowances");
  });
});

describe("Budget envelope grid — word diet", () => {
  it("has no exclamation marks anywhere on the page", () => {
    const { container } = renderPage();
    expect(container.textContent ?? "").not.toContain("!");
  });

  it("drops the legend of source badges that no longer render", () => {
    renderPage();
    for (const dead of [
      "Auto-pulled from Income/Bills",
      "Auto-pulled from Debts",
      "this week is the one to win",
      "All clear",
    ]) {
      expect(screen.queryByText(new RegExp(dead, "i"))).toBeNull();
    }
  });

  it("keeps one accessible heading named exactly 'Budget'", () => {
    renderPage();
    // Eleven e2e specs find the page this way; it must not drift.
    expect(screen.getByRole("heading", { name: /^budget$/i })).toBeTruthy();
  });
});
