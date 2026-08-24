import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * C9 — the Reports hub on the kit.
 *
 * Guards three things the restyle is responsible for: the five drill
 * destinations still exist and still point at the same routes, the balance
 * tiles still read from their own endpoints, and the words are the flat-matte
 * ones — including the "Behavior & Fun" → "Habits" rename, which changes the
 * LABEL only and must leave `/reports/behavior` untouched so `routePrefetch`
 * and `App.tsx` stay in lockstep.
 */

const TEST_TODAY = new Date(2026, 4, 15, 12, 0, 0);

type Tx = {
  id: string;
  description: string;
  amount: string;
  occurredOn: string;
  categoryId: string | null;
};

const TXNS: Tx[] = [
  { id: "t1", description: "Store", amount: "-120.25", occurredOn: "2026-05-11", categoryId: "c1" },
  { id: "t2", description: "Cafe", amount: "-75.50", occurredOn: "2026-05-12", categoryId: "c2" },
  { id: "t3", description: "Pay", amount: "2000.00", occurredOn: "2026-05-01", categoryId: null },
];

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
  useListTransactions: () => ({ data: TXNS, isLoading: false }),
  useListCategories: () => ({
    data: [
      { id: "c1", name: "Groceries", excludeFromBudget: false },
      { id: "c2", name: "Dining", excludeFromBudget: false },
    ],
  }),
  useListDebts: () => ({ data: [{ id: "d1", balance: "5000.00", status: "active" }] }),
  useListDebtBalanceHistory: () => ({ data: [] }),
  useGetForecast: () => ({ data: null }),
  useGetDashboard: () => ({ data: { totalDebt: "5000.00", activeDebtCount: 1 } }),
  useGetForecastCashSignal: () => ({
    data: { status: "healthy", cashBuffer: "1200.00", lowestProjected: "800.00" },
  }),
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
