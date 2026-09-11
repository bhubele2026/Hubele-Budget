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

// What each query answers in a test. "default" means the fixtures above; tests
// that need a query loading or failed set it here, and beforeEach resets it.
const hub = vi.hoisted(() => ({
  facts: "default" as unknown,
  factsFailed: false,
  spine: "default" as unknown,
  spineFailed: false,
  forecast: null as unknown,
  liabilities: [] as unknown,
  forecastFailed: false,
  liabilitiesFailed: false,
}));

vi.mock("@workspace/api-client-react", () => ({
  // Wrapped rather than passed directly: the factory is hoisted above this
  // file's consts, so it may only REFERENCE the spy from inside a call.
  useListTransactions: (...args: unknown[]) => listTransactionsSpy(...args),
  useGetReportsSpendingFacts: () => ({
    data: hub.facts === "default" ? SPENDING_FACTS : hub.facts,
    isLoading: false,
    isLoadingError: hub.factsFailed,
  }),
  useListDebts: () => ({ data: [{ id: "d1", balance: "5000.00", status: "active" }] }),
  useListDebtBalanceHistory: () => ({ data: [] }),
  useGetForecast: () => ({ data: hub.forecast, isError: hub.forecastFailed }),
  useGetDashboard: () => ({ data: { totalDebt: "5000.00", activeDebtCount: 1 } }),
  useGetSpine: () => ({
    data: hub.spine === "default" ? SPINE : hub.spine,
    isLoading: false,
    isLoadingError: hub.spineFailed,
  }),
  getGetSpineQueryKey: () => ["/api/spine"],
  useListPlaidLiabilityAccounts: () => ({ data: hub.liabilities, isError: hub.liabilitiesFailed }),
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
  hub.facts = "default";
  hub.factsFailed = false;
  hub.spine = "default";
  hub.spineFailed = false;
  hub.forecast = null;
  hub.liabilities = [];
  hub.forecastFailed = false;
  hub.liabilitiesFailed = false;
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

  it("(PR7) says what real spend leaves out: + the uncategorized total", () => {
    hub.facts = {
      ...SPENDING_FACTS,
      uncategorized: { total: 24.5, transactionCount: 1, sampleMerchants: [] },
    };
    renderPage();
    const tile = screen.getByTestId("report-tile-spending").textContent ?? "";
    expect(tile).toContain("$195.75");
    expect(tile).toContain("+ $24.50 uncategorized");
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

describe("Reports hub — no claims before the figures arrive", () => {
  const tileText = (id: string) => screen.getByTestId(id).textContent ?? "";

  it("while the spending facts load: dashes and 'Loading…', never $0.00, 'No spend' or 'No income recorded'", () => {
    hub.facts = undefined;
    renderPage();
    const spending = tileText("report-tile-spending");
    expect(spending).toContain("—");
    expect(spending).toContain("Loading…");
    expect(spending).not.toContain("$0.00");
    expect(spending).not.toContain("No spend in range");
    const budget = tileText("report-tile-budget");
    expect(budget).toContain("Loading…");
    expect(budget).not.toContain("No income recorded");
    expect(budget).not.toContain("0%");
    expect(budget).not.toContain("$0.00");
    const cashflow = tileText("report-tile-cashflow");
    expect(cashflow).toContain("Loading…");
    expect(cashflow).not.toContain("No activity in range");
  });

  it("after the spending facts fail: says it couldn't load", () => {
    hub.facts = undefined;
    hub.factsFailed = true;
    renderPage();
    expect(tileText("report-tile-spending")).toContain("Couldn't load");
    expect(tileText("report-tile-budget")).toContain("Couldn't load");
    expect(tileText("report-tile-cashflow")).toContain("Couldn't load");
    expect(tileText("report-tile-behavior")).toContain("Couldn't load");
  });

  it("with facts but no income: the ring shows a dash, not 0%", () => {
    hub.facts = { ...SPENDING_FACTS, realIncome: { total: 0, transactionCount: 0 } };
    renderPage();
    const budget = tileText("report-tile-budget");
    expect(budget).toContain("No income recorded");
    expect(budget).not.toContain("0%");
  });

  it("without the spine, the cash buffer says loading, not 'No Snapshot' or a setup hint", () => {
    hub.spine = undefined;
    renderPage();
    const tile = tileText("reports-tile-cash-buffer");
    expect(tile).toContain("—");
    expect(tile).toContain("Loading…");
    expect(tile).not.toContain("No Snapshot");
    expect(tile).not.toContain("Set a checking balance");
  });

  it("after the spine fails, the cash buffer says it couldn't load", () => {
    hub.spine = undefined;
    hub.spineFailed = true;
    renderPage();
    expect(tileText("reports-tile-cash-buffer")).toContain("Couldn't load");
  });

  it("before the account and card queries answer, no 'No checking snapshot yet' and no 'Link an Amex card'", () => {
    hub.forecast = undefined;
    hub.liabilities = undefined;
    renderPage();
    expect(tileText("reports-tile-bank")).not.toContain("No checking snapshot yet");
    expect(tileText("reports-tile-amex")).not.toContain("Link an Amex card");
  });

  it("once they answer with nothing, says so", () => {
    renderPage();
    expect(tileText("reports-tile-bank")).toContain("No checking snapshot yet");
    expect(tileText("reports-tile-amex")).toContain("Link an Amex card");
  });
});

describe("Reports hub — the account and card hints after a failure", () => {
  it("says couldn't load when the forecast bundle or the card accounts failed, never blank for good", () => {
    hub.forecast = undefined;
    hub.forecastFailed = true;
    hub.liabilities = undefined;
    hub.liabilitiesFailed = true;
    renderPage();
    expect(screen.getByTestId("reports-tile-bank").textContent).toContain("Couldn't load");
    expect(screen.getByTestId("reports-tile-amex").textContent).toContain("Couldn't load");
  });
});
