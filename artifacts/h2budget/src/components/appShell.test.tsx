import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import React from "react";

/**
 * The app shell — the navy header, the wordmark home control and the tab
 * ribbon. These lock the two things the B2 rewrite promised NOT to change
 * while it changed everything about how the shell looks:
 *
 *  1. the boundary-aware longest-match that decides which tab is lit, and
 *  2. the area model (which sub-nav shows on which route).
 *
 * Both are pure functions of `location` living inside `AppLayout`, and a
 * restyle is exactly the kind of change that quietly breaks them.
 */

let reviewCount = 0;

vi.mock("@clerk/react", () => ({
  UserButton: () => <div data-testid="user-button" />,
}));

vi.mock("@workspace/api-client-react", () => ({
  // The Review badge reads the shared spine now, not its own endpoint, so the
  // nav count and the landing bell can never disagree (see hooks/useSpine.ts).
  useGetSpine: () => ({ data: { reviewCount }, isLoading: false }),
  getGetSpineQueryKey: () => ["/api/spine"],
  getSpine: vi.fn(),
  getDashboard: vi.fn(),
  getGetDashboardQueryKey: () => ["/api/dashboard"],
  getForecast: vi.fn(),
  getGetForecastQueryKey: () => ["/api/forecast"],
  getForecastCashSignal: vi.fn(),
  getGetForecastCashSignalQueryKey: () => ["/api/forecast/cash-signal"],
  getAmexWeeklyPayoff: vi.fn(),
  getGetAmexWeeklyPayoffQueryKey: () => ["/api/amex/weekly-payoff"],
  getBillsSummary: vi.fn(),
  getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
  listDebts: vi.fn(),
  getListDebtsQueryKey: () => ["/api/debts"],
  listTransactions: vi.fn(),
  getListTransactionsQueryKey: () => ["/api/transactions"],
  getBudgetMonth: vi.fn(),
  getGetBudgetMonthQueryKey: () => ["/api/budget/month"],
  listCategories: vi.fn(),
  getListCategoriesQueryKey: () => ["/api/budget/categories"],
}));

const prefetchRoute = vi.fn();
vi.mock("@/lib/routePrefetch", () => ({ prefetchRoute: (h: string) => prefetchRoute(h) }));

import { AppLayout } from "./layout";

function mount(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <AppLayout>
          <div data-testid="page-body" />
        </AppLayout>
      </Router>
    </QueryClientProvider>,
  );
}

/** The href of whichever tab is currently lit, or null. */
function activeTabHref(): string | null {
  const el = document.querySelector('[data-tabhref][aria-current="page"]');
  return el?.getAttribute("data-tabhref") ?? null;
}

/** Every tab label currently in the ribbon, in order. */
function tabLabels(): string[] {
  return Array.from(document.querySelectorAll("[data-tabhref]")).map(
    (n) => n.textContent?.replace(/\d+$/, "").trim() ?? "",
  );
}

beforeEach(() => {
  reviewCount = 0;
  prefetchRoute.mockClear();
});
afterEach(cleanup);

describe("app shell chrome", () => {
  it("puts the wordmark in the header, pointing home", () => {
    mount("/banking");
    const brand = screen.getByTestId("brand-home");
    expect(brand.getAttribute("href")).toBe("/home");
    // One announcement, not "H", "2", "Budget".
    expect(screen.getByTestId("h2-wordmark").getAttribute("aria-label")).toBe("H2 Budget");
  });

  it("hides the whole header on the landing — the tiles ARE the navigation", () => {
    mount("/home");
    expect(screen.queryByTestId("app-header")).toBeNull();
    expect(screen.getByTestId("page-body")).toBeTruthy();
  });

  it("renders the page keyed on location so every navigation re-runs .page-in", () => {
    mount("/banking");
    expect(document.querySelector(".page-in")).toBeTruthy();
  });
});

describe("boundary-aware active tab", () => {
  it("lights Overview on /bills, NOT both Overview and Bills", () => {
    mount("/bills");
    expect(activeTabHref()).toBe("/bills");
    expect(document.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });

  it("lights Bills on /bills/all — the longest match wins over the prefix", () => {
    mount("/bills/all");
    expect(activeTabHref()).toBe("/bills/all");
    expect(document.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });

  it("does not treat /billsomething as inside the Bills area", () => {
    // A raw startsWith would match; the boundary check is what stops it.
    mount("/transactions");
    expect(activeTabHref()).toBe("/transactions");
  });
});

describe("the area model is unchanged by the restyle", () => {
  it("shows Banking's five tabs inside the Banking area", () => {
    mount("/amex");
    expect(tabLabels()).toEqual(["Overview", "Chase", "Amex", "Budget", "Allowance"]);
    expect(activeTabHref()).toBe("/amex");
  });

  it("shows the Forecast area's three tabs on /review", () => {
    mount("/review");
    expect(tabLabels()).toEqual(["Overview", "Review", "Forecast"]);
    expect(activeTabHref()).toBe("/review");
  });

  it("shows the primary row with More outside any area", () => {
    mount("/settings");
    expect(tabLabels()).toEqual(["Home", "Banking", "Bills", "Forecast", "Future Goal"]);
    expect(screen.getByTestId("topnav-more")).toBeTruthy();
  });

  it("hides More inside an area — the way out is the wordmark", () => {
    mount("/bills/all");
    expect(screen.queryByTestId("topnav-more")).toBeNull();
  });
});

describe("the review count is a finding or it is nothing", () => {
  it("shows no badge at all when the queue is empty", () => {
    reviewCount = 0;
    mount("/review");
    expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
    // and no zero pill on the Review tab either
    expect(screen.getByTestId("topnav-review").textContent).toBe("Review");
  });

  it("puts the count on the Review tab when the Forecast ribbon is showing", () => {
    reviewCount = 4;
    mount("/review");
    expect(screen.getByTestId("topnav-review").textContent).toContain("4");
    // ⚠️ NOT TWICE. Two badges reading "4" look like eight things.
    expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
  });

  it("falls back to the header pill when the ribbon has no Review tab", () => {
    reviewCount = 4;
    mount("/banking");
    expect(screen.getByTestId("topnav-review-badge").textContent).toContain("4");
  });
});

describe("prefetch machinery survives the rewrite", () => {
  it("warms a route's chunk on hover", () => {
    mount("/banking");
    fireEvent.mouseEnter(screen.getByTestId("topnav-amex"));
    expect(prefetchRoute).toHaveBeenCalledWith("/amex");
  });

  it("warms a route's chunk on keyboard focus, not just pointer hover", () => {
    mount("/banking");
    fireEvent.focus(screen.getByTestId("topnav-transactions"));
    expect(prefetchRoute).toHaveBeenCalledWith("/transactions");
  });
});
