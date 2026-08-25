import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * C9 — the Reports hub on the kit.
 *
 * Guards four things: the five drill destinations still exist and still point
 * at the same routes, the balance tiles still render, the words are the
 * flat-matte ones — including the "Behavior & Fun" → "Habits" rename, which
 * changes the LABEL only and must leave `/reports/behavior` untouched so
 * `routePrefetch` and `App.tsx` stay in lockstep — and, since the D3 sweep,
 * that the hub quotes the SHARED figures rather than adding up its own.
 */

const TEST_TODAY = new Date(2026, 4, 15, 12, 0, 0);

// One 30-day aggregate, the shape `/reports/spending-facts` returns. The hub
// renders these figures as-is; nothing here is re-derived in the browser.
const SPENDING_FACTS = {
  range: {
    start: "2026-04-15",
    end: "2026-05-15",
    daysCovered: 31,
    trackingStart: "2026-05-01",
    floorApplied: false,
  },
  realSpend: { total: 195.75, transactionCount: 2 },
  realIncome: { total: 2000, transactionCount: 1 },
  uncategorized: { total: 0, transactionCount: 0, sampleMerchants: [] },
  excluded: {
    transfersTotal: 0,
    debtPaymentsTotal: 0,
    reimbursementTotal: 0,
    ignoreTotal: 0,
  },
  byCategory: [
    { categoryId: "c1", name: "Groceries", total: 120.25, txnCount: 1, pctOfRealSpend: 61.4 },
    { categoryId: "c2", name: "Dining", total: 75.5, txnCount: 1, pctOfRealSpend: 38.6 },
  ],
  byMerchant: [],
  dailyBuckets: [],
  dailyNet: [
    { date: "2026-05-11", net: -120.25 },
    { date: "2026-05-12", net: -75.5 },
    { date: "2026-05-13", net: 0 },
  ],
  dayOfWeek: [
    { dow: 0, label: "Sun", avgPerDay: 0, total: 0, topMerchants: [] },
    { dow: 1, label: "Mon", avgPerDay: 0, total: 120.25, topMerchants: [] },
    { dow: 2, label: "Tue", avgPerDay: 0, total: 75.5, topMerchants: [] },
    { dow: 3, label: "Wed", avgPerDay: 0, total: 0, topMerchants: [] },
    { dow: 4, label: "Thu", avgPerDay: 0, total: 0, topMerchants: [] },
    { dow: 5, label: "Fri", avgPerDay: 0, total: 0, topMerchants: [] },
    { dow: 6, label: "Sat", avgPerDay: 0, total: 0, topMerchants: [] },
  ],
  monthlyTrends: [],
  reimbursable: { personalTotal: 0, outstandingReimbursableTotal: 0 },
};

// The spine snapshot. `bank.balance` is deliberately NOT the raw bank
// snapshot — it is that snapshot rolled forward — so a tile reading the
// snapshot instead of this would show a different number.
const SPINE = {
  asOf: "2026-05-15T12:00:00.000Z",
  bank: { balance: "3120.45", asOfDate: "2026-05-14" },
  spentMonth: 195.75,
  spentWeek: 75.5,
  nextBill: null,
  billsDueCount: 0,
  forecast: {
    lowPoint: "800.00",
    lowPointDate: "2026-06-02",
    runwayDays: null,
    cashBuffer: "1200.00",
    status: "tight",
  },
  debt: { payoffPct: 12 },
  reviewCount: 0,
};

// If the hub ever reaches for raw transactions again, this spy catches it.
const listTransactionsSpy = vi.fn((..._args: unknown[]) => ({
  data: [],
  isLoading: false,
}));

vi.mock("wouter", () => ({
  Link: ({
    children,
    href,
    ...rest
  }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@workspace/api-client-react", () => ({
  // Wrapped rather than passed directly: the factory is hoisted above this
  // file's consts, so it may only REFERENCE the spy from inside a call.
  useListTransactions: (...args: unknown[]) => listTransactionsSpy(...args),
  useGetReportsSpendingFacts: () => ({ data: SPENDING_FACTS, isLoading: false }),
  useListDebts: () => ({ data: [{ id: "d1", balance: "5000.00", status: "active" }] }),
  useListDebtBalanceHistory: () => ({ data: [] }),
  useGetForecast: () => ({ data: null }),
  useGetDashboard: () => ({ data: { totalDebt: "5000.00", activeDebtCount: 1 } }),
  useGetSpine: () => ({ data: SPINE, isLoading: false }),
  getGetSpineQueryKey: () => ["/api/spine"],
  useListPlaidLiabilityAccounts: () => ({ data: [] }),
}));

import ReportsPage from "./reports";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TEST_TODAY);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Reports hub — the five drill destinations", () => {
  it("routes each tile to its own report, unchanged", () => {
    renderPage();
    const href = (id: string) =>
      screen.getByTestId(id).getAttribute("href");
    expect(href("report-tile-debt")).toBe("/reports/debt");
    expect(href("report-tile-cashflow")).toBe("/reports/cashflow");
    expect(href("report-tile-spending")).toBe("/reports/spending");
    expect(href("report-tile-budget")).toBe("/reports/budget");
    expect(href("report-tile-behavior")).toBe("/reports/behavior");
  });

  it("renders the household's balance tiles", () => {
    renderPage();
    for (const id of [
      "reports-tile-total-debt",
      "reports-tile-bank",
      "reports-tile-amex",
      "reports-tile-cash-buffer",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });
});

describe("Reports hub — the rename", () => {
  it("labels the behaviour report 'Habits'", () => {
    renderPage();
    expect(screen.getByTestId("report-tile-behavior").textContent).toContain(
      "Habits",
    );
  });

  it("says neither 'Behavior' nor 'Fun' anywhere on the page", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";
    expect(text).not.toContain("Behavior & Fun");
    expect(text).not.toContain("Behavior");
    expect(text).not.toContain("Fun");
  });

  it("keeps the ROUTE at /reports/behavior so prefetch stays in lockstep", () => {
    renderPage();
    expect(screen.getByTestId("report-tile-behavior").getAttribute("href")).toBe(
      "/reports/behavior",
    );
  });
});

describe("Reports hub — one basis, no local money maths", () => {
  it("never asks for raw transactions", () => {
    renderPage();
    expect(listTransactionsSpy).not.toHaveBeenCalled();
  });

  it("shows the spine's bank today rather than a snapshot of its own", () => {
    renderPage();
    expect(screen.getByTestId("reports-tile-bank").textContent).toContain(
      "$3,120.45",
    );
  });

  it("takes the cash-buffer verdict and the low point from one snapshot", () => {
    renderPage();
    const tile = screen.getByTestId("reports-tile-cash-buffer").textContent ?? "";
    expect(tile).toContain("Tight");
    expect(tile).toContain("$800.00"); // spine.forecast.lowPoint
    expect(tile).toContain("$1,200.00"); // spine.forecast.cashBuffer
  });

  it("quotes the server's real spend, not every outflow it can see", () => {
    renderPage();
    // realSpend.total, the same basis the Spending page one click away uses.
    expect(screen.getByTestId("report-tile-spending").textContent).toContain(
      "$195.75",
    );
  });

  it("measures the budget ring against real income", () => {
    renderPage();
    // 195.75 / 2000 = 9.8% -> 10%
    expect(screen.getByTestId("report-tile-budget").textContent).toContain("10%");
  });
});

describe("Reports hub — word diet", () => {
  it("drops the story copy and every exclamation mark", () => {
    const { container } = renderPage();
    const text = container.textContent ?? "";
    expect(text).not.toContain("!");
    for (const phrase of [
      "told as a story",
      "Pick a thread",
      "The avalanche",
      "Where it all went",
      "The patterns",
    ]) {
      expect(text).not.toContain(phrase);
    }
  });

  it("keeps the hub free of any charting library", () => {
    // The hub's visuals are plain SVG/CSS (`components/viz`), so opening
    // /reports never pays for recharts.
    const { container } = renderPage();
    expect(container.querySelector(".recharts-wrapper")).toBeNull();
  });
});
