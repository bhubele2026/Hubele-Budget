import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (C1) Render tests for the three report pages that had none: Debt, Budget,
 * Behavior. They pin the capability ids from the parity review (RD, RB, RBH)
 * and the grid placement each panel now has. Charts render nothing under the
 * recharts stub; these tests are about the figures and the structure.
 */

vi.mock("recharts", async () => {
  const Nothing = () => null;
  return {
    ...(await import("@/test-recharts-stub")),
    AreaChart: Nothing,
    Area: Nothing,
    BarChart: Nothing,
    ReferenceLine: Nothing,
  };
});

const state = vi.hoisted(() => ({
  debts: [] as unknown[],
  budget: undefined as unknown,
  behavior: undefined as unknown,
}));

vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useListDebts: () => ({ data: state.debts, isLoading: false }),
  useListDebtBalanceHistory: () => ({ data: [] }),
  useGetAvalancheSettings: () => ({ data: { strategy: "avalanche", manualExtra: "100" } }),
  useGetAvalancheExtra: () => ({ data: { amount: 100 } }),
  useGetReportsBudgetFacts: () => ({ data: state.budget, isLoading: false, isError: false }),
  useGetReportsBehaviorFacts: () => ({ data: state.behavior, isLoading: false, isError: false }),
}));

import DebtPage from "./DebtPage";
import BudgetPage from "./BudgetPage";
import BehaviorPage from "./BehaviorPage";

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const spanOf = (el: HTMLElement | null) => el?.closest("section, div.panel")?.className ?? "";

afterEach(() => cleanup());

describe("Debt report", () => {
  beforeEach(() => {
    state.debts = [
      {
        id: "d1",
        name: "Visa",
        balance: "4000",
        originalBalance: "5000",
        apr: "0.22",
        minPayment: "100",
        payment: "100",
        type: "credit_card",
        status: "active",
        sortOrder: 0,
      },
      {
        id: "d2",
        name: "Car loan",
        balance: "9000",
        originalBalance: "10000",
        apr: "0.06",
        minPayment: "300",
        payment: "300",
        type: "auto",
        status: "active",
        sortOrder: 1,
      },
    ];
  });

  it("RD-02 keeps the four KPIs, each in a grid panel", () => {
    mount(<DebtPage />);
    for (const id of [
      "debt-report-total",
      "debt-report-months",
      "debt-report-date",
      "debt-report-interest-saved",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByTestId("debt-report-total").textContent).toContain("$13,000.00");
    expect(spanOf(screen.getByTestId("debt-report-total"))).toContain("span-3");
  });

  it("RD-03/04 keeps the paid-off panel and the per-debt table", () => {
    mount(<DebtPage />);
    expect(screen.getByTestId("debt-report-paid-pct")).toBeTruthy();
    expect(screen.getByTestId("debt-progress-d1").textContent).toContain("Visa");
    expect(screen.getByTestId("debt-progress-d2").textContent).toContain("Car loan");
    expect(spanOf(screen.getByTestId("debt-progress-d1"))).toContain("span-8");
  });

  it("RD-05/06 keeps the chart panels and both lists", () => {
    mount(<DebtPage />);
    for (const title of [
      "Payoff timeline",
      "Snowball waterfall",
      "Interest vs principal",
      "Payoff order",
      "Months remaining",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText(/Projection assumes a total monthly payment/)).toBeTruthy();
  });
});

const line = (id: string, name: string, planned: number, actual: number, cls = "bill") => ({
  categoryId: id,
  name,
  class: cls,
  planned,
  actual,
  pct: planned ? (actual / planned) * 100 : 0,
  status: "good",
});

describe("Budget report", () => {
  beforeEach(() => {
    state.budget = {
      range: {
        monthStart: "2026-10-01",
        monthEnd: "2026-10-31",
        daysInMonth: 31,
        daysElapsed: 8,
        monthHasPassed: false,
        monthLabel: "October 2026",
        monthsBack: 6,
      },
      income: { paidCount: 1, totalCount: 2, lines: [line("i1", "Paycheck", 2000, 2000, "income")] },
      bills: { paidCount: 1, totalCount: 1, lines: [line("b1", "Rent", 1200, 1200)] },
      debts: { paidCount: 0, totalCount: 1, lines: [line("x1", "Visa", 100, 0, "debt")] },
      flex: {
        paidCount: 0,
        totalCount: 1,
        lines: [{ ...line("f1", "Groceries", 400, 150, "flex"), unbudgeted: false }],
        plannedTotal: 400,
        actualTotal: 150,
        pacePlanToDate: 103,
        paceStatus: "over",
        projectedMonthEnd: 580,
        projectedVsPlan: 180,
        burndown: [
          { day: 1, date: "2026-10-01", plannedCumulative: 13, actualCumulative: 20 },
          { day: 2, date: "2026-10-02", plannedCumulative: 26, actualCumulative: 60 },
        ],
      },
      streak: { monthKeys: ["2026-09"], rows: [] },
    };
  });

  it("RB-02 keeps the three KPIs at span-4", () => {
    mount(<BudgetPage />);
    for (const id of ["budget-report-income", "budget-report-fixed", "budget-report-flex"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
      expect(spanOf(screen.getByTestId(id))).toContain("span-4");
    }
    expect(screen.getByTestId("budget-report-fixed").textContent).toContain("1 of 2");
  });

  it("RB-03/04/05 keeps day-to-day, bills, paychecks and the pace chart", () => {
    mount(<BudgetPage />);
    expect(screen.getByTestId("budget-flex-f1")).toBeTruthy();
    expect(screen.getByText("Bills & loans")).toBeTruthy();
    expect(screen.getByText("Paychecks")).toBeTruthy();
    expect(screen.getByText("Pace of the month")).toBeTruthy();
    expect(spanOf(screen.getByText("Day-to-day spending"))).toContain("span-8");
    expect(spanOf(screen.getByText("Pace of the month"))).toContain("span-4");
  });

  it("RB-01 says so when nothing is set for the month", () => {
    state.budget = {
      ...(state.budget as Record<string, unknown>),
      income: { paidCount: 0, totalCount: 0, lines: [] },
      bills: { paidCount: 0, totalCount: 0, lines: [] },
      debts: { paidCount: 0, totalCount: 0, lines: [] },
      flex: { ...((state.budget as { flex: object }).flex), totalCount: 0, lines: [] },
    };
    mount(<BudgetPage />);
    expect(screen.getByText("No budget set for this month")).toBeTruthy();
  });
});

describe("Behavior (Habits) report", () => {
  beforeEach(() => {
    state.behavior = {
      range: { start: "2026-10-01", end: "2026-10-08", daysCovered: 8, trackingStart: "2026-05-01", floorApplied: true },
      daysSinceLast: {
        dining: { days: 3, lastDate: "2026-10-05", lastMerchant: "Cafe", lastAmount: 12 },
        amazon: null,
        coffee: { days: 1, lastDate: "2026-10-07", lastMerchant: "Bean", lastAmount: 4 },
        gasStation: null,
        groceries: null,
        onlineShopping: null,
      },
      streaks: {
        noDining: { currentDays: 3, longestDays: 9, longestEndDate: "2026-08-01" },
        coffeeFree: { currentDays: 1, longestDays: 1, longestEndDate: "2026-10-07" },
      },
      funFacts: {
        biggestSplurge: { amount: 250, date: "2026-10-02", merchant: "Gear Shop", categoryName: "Shopping" },
        mostVisitedMerchant: { name: "Kroger", count: 4, total: 160, sampleCategoryName: "Groceries" },
        quietestDay: { date: "2026-10-04", total: 0, dayOfWeek: "Sunday" },
        mostExpensiveDay: null,
        impulseBuyCount: { count: 2, total: 40, exampleMerchants: ["A"] },
        subscriptionsCount: { count: 3, monthlyTotal: 45, topThree: [] },
        nextPaycheckCountdown: { days: 5, paycheckLabel: "Pay", expectedAmount: 2000, expectedDate: "2026-10-13" },
      },
      hourlySpendingClock: [],
      dayOfWeekSpend: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
        dow,
        label: "d",
        total: dow * 10,
        count: dow,
        avgPerDay: dow * 5,
      })),
      hallOfFame: {
        biggestExpense: { amount: 250, date: "2026-10-02", merchant: "Gear Shop", categoryName: null },
        biggestIncome: null,
      },
    };
  });

  it("RBH-03 keeps the named stat tiles", () => {
    mount(<BehaviorPage />);
    expect(screen.getByTestId("habits-biggest-charge").textContent).toContain("$250.00");
    expect(screen.getByTestId("habits-top-merchant").textContent).toContain("Kroger");
    expect(screen.getByTestId("habits-next-paycheck").textContent).toContain("5 days");
    expect(screen.getByText("Impulse buys")).toBeTruthy();
    expect(screen.getByText("Subscriptions")).toBeTruthy();
    expect(screen.getByText("Quietest day")).toBeTruthy();
  });

  it("RBH-01/02/04/06 keeps the clamp note, days-since, both streaks and largest movements", () => {
    mount(<BehaviorPage />);
    expect(screen.getByText(/Window clamped to the tracking start/)).toBeTruthy();
    expect(screen.getByText("Days since last")).toBeTruthy();
    expect(screen.getByText("No-dining run")).toBeTruthy();
    expect(screen.getByText("Coffee-free run")).toBeTruthy();
    expect(screen.getByText("At record")).toBeTruthy(); // coffee: 1 of 1
    expect(screen.getByText("Record 9")).toBeTruthy();
    expect(screen.getByText("Largest movements")).toBeTruthy();
    expect(spanOf(screen.getByText("Largest movements"))).toContain("span-12");
    expect(spanOf(screen.getByText("Days since last"))).toContain("span-4");
  });

  it("RBH-05 keeps the day-of-week panel", () => {
    mount(<BehaviorPage />);
    expect(spanOf(screen.getByText("Spend by day of week"))).toContain("span-6");
  });
});
