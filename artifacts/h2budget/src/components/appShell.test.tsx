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
 *
 * ⭐ R0 (owner-approved redesign) replaced the old "Home + four areas"
 * primary row with FIVE DESTINATIONS — Home (/banking), Forecast, Spending,
 * Review, Debt — each still opening onto its own area ribbon. Settings moved
 * to the end of More. The wordmark still points at the /home door; the area
 * model itself (boundary-aware longest-match, per-area ribbons, More hidden
 * inside an area) is UNCHANGED by the reshuffle.
 */

let reviewCount = 0;
/** No spine yet (still loading, or the first load failed): the count is unknown. */
let spineMissing = false;

vi.mock("@clerk/react", () => ({
  UserButton: () => <div data-testid="user-button" />,
}));

vi.mock("@workspace/api-client-react", () => ({
  // The Review badge reads the shared spine now, not its own endpoint, so the
  // nav count and the landing bell can never disagree (see hooks/useSpine.ts).
  useGetSpine: () => ({
    data: spineMissing ? undefined : { reviewCount },
    isLoading: spineMissing,
  }),
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

// The More overflow is a Radix DropdownMenu, which only mounts its content
// once the trigger is opened — jsdom's pointer-capture model makes that
// awkward to drive from a test. Swap in a render-everything shim (same
// pattern as debtPlaidReconnect.test.tsx) so the in-menu items are always in
// the DOM to assert against.
vi.mock("@/components/ui/dropdown-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  );
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Passthrough,
  };
});

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
  it("lights the Bills tab on /bills (Forecast area — bills live here now)", () => {
    mount("/bills");
    expect(activeTabHref()).toBe("/bills");
    expect(document.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });

  it("lights the same Bills tab on /bills/all — one tab covers both routes", () => {
    // Bills no longer has its own two-tab area (Overview/Bills); Forecast's
    // ribbon carries ONE "Bills" tab (href /bills) and the boundary-aware
    // longest-match still resolves /bills/all to it, since there is no
    // sibling entry to confuse it with.
    mount("/bills/all");
    expect(activeTabHref()).toBe("/bills");
    expect(document.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });

  it("does not treat /transactions as inside the Forecast area", () => {
    // A raw startsWith on "/" would match everything; the boundary check is
    // what keeps /transactions (Review's Chase tab) from lighting up Forecast.
    mount("/transactions");
    expect(activeTabHref()).toBe("/transactions");
  });
});

describe("the five destinations", () => {
  it("shows the five destination items with their hrefs outside any area", () => {
    mount("/settings");
    const hrefs = Array.from(document.querySelectorAll("[data-tabhref]")).map(
      (n) => n.getAttribute("data-tabhref"),
    );
    expect(hrefs).toEqual([
      "/banking",
      "/forecast/overview",
      "/reports/spending",
      "/review",
      "/avalanche",
    ]);
    expect(tabLabels()).toEqual(["Home", "Forecast", "Spending", "Review", "Debt"]);
  });
});

describe("the area model", () => {
  it("shows Home's ribbon — the existing Banking tabs, unchanged — on /banking", () => {
    mount("/banking");
    expect(tabLabels()).toEqual(["Overview", "Chase", "Amex", "Budget", "Allowance"]);
    expect(activeTabHref()).toBe("/banking");
  });

  it("shows Forecast's ribbon on /forecast/overview", () => {
    mount("/forecast/overview");
    expect(tabLabels()).toEqual(["Overview", "Forecast", "Bills"]);
    expect(activeTabHref()).toBe("/forecast/overview");
  });

  it("shows Forecast·Bills on /bills/all", () => {
    mount("/bills/all");
    expect(tabLabels()).toEqual(["Overview", "Forecast", "Bills"]);
    expect(activeTabHref()).toBe("/bills");
  });

  it("shows Spending's ribbon on /reports/spending", () => {
    mount("/reports/spending");
    expect(tabLabels()).toEqual(["Spending", "Budget", "Allowances", "Reports"]);
    expect(activeTabHref()).toBe("/reports/spending");
  });

  it("shows Review·Chase on /transactions", () => {
    mount("/transactions");
    expect(tabLabels()).toEqual(["Review", "Chase", "Amex"]);
    expect(activeTabHref()).toBe("/transactions");
  });

  it("shows Review's ribbon on /review", () => {
    mount("/review");
    expect(tabLabels()).toEqual(["Review", "Chase", "Amex"]);
    expect(activeTabHref()).toBe("/review");
  });

  it("shows Debt·Debts on /debts", () => {
    mount("/debts");
    expect(tabLabels()).toEqual(["Debt", "Debts", "Debt report"]);
    expect(activeTabHref()).toBe("/debts");
  });

  it("shows Debt's ribbon on /avalanche", () => {
    mount("/avalanche");
    expect(tabLabels()).toEqual(["Debt", "Debts", "Debt report"]);
    expect(activeTabHref()).toBe("/avalanche");
  });

  it("shows Debt's ribbon on /reports/debt, not Spending's — /reports/ is a shared prefix", () => {
    // Spending's Reports tab (href /reports) and Debt's Debt report tab (href
    // /reports/debt) both start with "/reports" — this is the same kind of
    // sibling-prefix hazard the Bills tab already guards against, just one
    // level of nesting deeper.
    mount("/reports/debt");
    expect(tabLabels()).toEqual(["Debt", "Debts", "Debt report"]);
    expect(activeTabHref()).toBe("/reports/debt");
  });

  it("shows the primary row with More outside any area", () => {
    mount("/settings");
    expect(tabLabels()).toEqual(["Home", "Forecast", "Spending", "Review", "Debt"]);
    expect(screen.getByTestId("topnav-more")).toBeTruthy();
  });

  it("hides More inside an area — the way out is the wordmark", () => {
    mount("/bills/all");
    expect(screen.queryByTestId("topnav-more")).toBeNull();
  });

  it("puts the unmapped pages (Mapping rules, Settings) under More", () => {
    mount("/settings");
    expect(screen.getByTestId("morenav-mapping-rules").textContent).toBe(
      "Mapping rules",
    );
    expect(screen.getByTestId("morenav-settings").textContent).toBe("Settings");
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

  it("puts the count on the Review tab when the Review ribbon is showing", () => {
    reviewCount = 4;
    mount("/review");
    expect(screen.getByTestId("topnav-review").textContent).toContain("4");
    // ⚠️ NOT TWICE. Two badges reading "4" look like eight things.
    expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
  });

  it("puts the count on the Review tab when the five-destination primary row is showing", () => {
    reviewCount = 4;
    mount("/settings");
    expect(screen.getByTestId("topnav-review").textContent).toContain("4");
    expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
  });

  it("falls back to the header pill when the ribbon has no Review tab (Home area)", () => {
    reviewCount = 4;
    mount("/banking");
    expect(screen.getByTestId("topnav-review-badge").textContent).toContain("4");
  });

  it("shows no badge anywhere while the count is unknown, not a zero pill", () => {
    spineMissing = true;
    try {
      mount("/banking");
      expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
      cleanup();
      mount("/review");
      expect(screen.getByTestId("topnav-review").textContent).toBe("Review");
    } finally {
      spineMissing = false;
    }
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
