import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

/**
 * ⭐ EVERY OLD ROUTE STILL WORKS, AND LANDS WHERE IT SHOULD.
 *
 * R0 reshuffles the NAV ONLY and must not remove, rename, or re-target a single
 * route. This mounts the REAL `App.tsx` — its real `<Switch>`, every real
 * `<Route>` and `<Redirect>` — inside the REAL `AppLayout`, and checks each old
 * route against a table typed out by hand below:
 *
 *   - where you end up (the route itself, or its redirect target),
 *   - which page renders there (never the NotFound catch-all), and
 *   - which destination's ribbon the shell shows.
 *
 * Nothing in the table is read from `App.tsx` or `layout.tsx`. Only leaves are
 * mocked: Clerk (always signed in), the network client, and each lazy page,
 * which becomes a stub naming itself — so a route pointed at the wrong page, a
 * redirect re-targeted, or a route moved into a different area all fail here.
 * The last block makes App.tsx's own route list answer to the table, so a new
 * route can't ship without a row.
 */

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Show: ({ when, children }: { when: string; children: React.ReactNode }) =>
    when === "signed-in" ? <>{children}</> : null,
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useClerk: () => ({ addListener: () => () => {} }),
  UserButton: () => <div data-testid="user-button" />,
}));
vi.mock("@clerk/react/internal", () => ({
  publishableKeyFromHost: () => "pk_test_routes",
}));
vi.mock("@clerk/themes", () => ({ shadcn: {} }));

vi.mock("@workspace/api-client-react", () => ({
  getSpine: vi.fn(() => new Promise(() => {})),
  getGetSpineQueryKey: () => ["/api/spine"],
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
vi.mock("@/hooks/useReviewInboxCount", () => ({ useReviewInboxCount: () => null }));

// Each lazy page is a stub that names itself (and, for the shared Forecast
// page, the mode it was asked to render in).
vi.mock("./lib/routePrefetch", () => {
  const page = (id: string) => () =>
    Promise.resolve({
      default: ({ mode }: { mode?: string }) => (
        <div data-testid={`page-${id}${mode ? `:${mode}` : ""}`} />
      ),
    });
  return {
    importCommandCenter: page("command-center"),
    importForecast: page("forecast"),
    importForecastOverview: page("forecast-overview"),
    importReports: page("reports"),
    importReportsDebt: page("reports-debt"),
    importReportsCashFlow: page("reports-cashflow"),
    importReportsSpending: page("reports-spending"),
    importReportsBudget: page("reports-budget"),
    importReportsBehavior: page("reports-behavior"),
    importDebts: page("debts"),
    importAvalanche: page("avalanche"),
    importAmex: page("amex"),
    importTransactions: page("transactions"),
    importBills: page("bills"),
    importBillsOverview: page("bills-overview"),
    importBudget: page("budget"),
    importAllowances: page("allowances"),
    importMappingRules: page("mapping-rules"),
    importSettings: page("settings"),
    prefetchRoute: () => {},
  };
});
vi.mock("./pages/landing", () => ({
  default: () => <div data-testid="page-landing" />,
  LandingSkeleton: () => null,
}));
vi.mock("./pages/auth", () => ({
  SignInPage: () => <div data-testid="page-sign-in" />,
  SignUpPage: () => <div data-testid="page-sign-up" />,
}));
vi.mock("./pages/plaid-oauth", () => ({
  default: () => <div data-testid="page-plaid-oauth" />,
}));
vi.mock("./pages/not-found", () => ({
  default: () => <div data-testid="page-not-found" />,
}));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/plaid-reconnect-listener", () => ({
  PlaidReconnectListener: () => null,
}));
vi.mock("@/components/version-update-prompt", () => ({
  VersionUpdatePrompt: () => null,
}));
vi.mock("@/lib/spineRecovery", () => ({ askForSpineAgainIfFailed: () => () => {} }));
vi.mock("@/lib/mutationInvalidation", () => ({ onWriteSuccess: () => {} }));

import App from "./App";

type Area = "Home" | "Forecast" | "Spending" | "Review" | "Debt" | "no area" | "no header";

// The ribbon each area shows, typed out — not imported from layout.tsx.
const RIBBON: Record<Exclude<Area, "no header">, string[]> = {
  Home: ["/banking", "/transactions", "/amex", "/budget", "/allowances"],
  Forecast: ["/forecast/overview", "/forecast", "/bills"],
  Spending: ["/reports/spending", "/budget", "/allowances", "/reports"],
  Review: ["/review", "/transactions", "/amex"],
  Debt: ["/avalanche", "/debts", "/reports/debt"],
  // Outside every area the ribbon is the five destinations themselves.
  "no area": ["/banking", "/forecast/overview", "/reports/spending", "/review", "/avalanche"],
};

type Row = {
  /** The route as it existed before R0. */
  from: string;
  /** Where you end up: the route itself, or its redirect target. */
  lands: string;
  /** The page that renders there. */
  page: string;
  /** The destination whose ribbon shows ("no header" = the landing / auth). */
  area: Area;
};

const OLD_ROUTES: Row[] = [
  { from: "/", lands: "/home", page: "landing", area: "no header" },
  { from: "/home", lands: "/home", page: "landing", area: "no header" },
  { from: "/sign-in", lands: "/sign-in", page: "sign-in", area: "no header" },
  { from: "/sign-up", lands: "/sign-up", page: "sign-up", area: "no header" },
  { from: "/banking", lands: "/banking", page: "command-center", area: "Home" },
  { from: "/dashboard", lands: "/banking", page: "command-center", area: "Home" },
  { from: "/forecast/overview", lands: "/forecast/overview", page: "forecast-overview", area: "Forecast" },
  { from: "/forecast", lands: "/forecast", page: "forecast:overall", area: "Forecast" },
  { from: "/bills", lands: "/bills", page: "bills-overview", area: "Forecast" },
  { from: "/bills/all", lands: "/bills/all", page: "bills", area: "Forecast" },
  { from: "/recurring", lands: "/bills/all", page: "bills", area: "Forecast" },
  { from: "/reports/spending", lands: "/reports/spending", page: "reports-spending", area: "Spending" },
  { from: "/budget", lands: "/budget", page: "budget", area: "Spending" },
  { from: "/allowances", lands: "/allowances", page: "allowances", area: "Spending" },
  { from: "/reports", lands: "/reports", page: "reports", area: "Spending" },
  { from: "/review", lands: "/review", page: "forecast:review", area: "Review" },
  { from: "/transactions", lands: "/transactions", page: "transactions", area: "Review" },
  { from: "/amex", lands: "/amex", page: "amex", area: "Review" },
  { from: "/avalanche", lands: "/avalanche", page: "avalanche", area: "Debt" },
  { from: "/debts", lands: "/debts", page: "debts", area: "Debt" },
  { from: "/reports/debt", lands: "/reports/debt", page: "reports-debt", area: "Debt" },
  { from: "/reports/cashflow", lands: "/reports/cashflow", page: "reports-cashflow", area: "no area" },
  { from: "/reports/budget", lands: "/reports/budget", page: "reports-budget", area: "no area" },
  { from: "/reports/behavior", lands: "/reports/behavior", page: "reports-behavior", area: "no area" },
  { from: "/mapping-rules", lands: "/mapping-rules", page: "mapping-rules", area: "no area" },
  { from: "/settings", lands: "/settings", page: "settings", area: "no area" },
  { from: "/plaid-oauth", lands: "/plaid-oauth", page: "plaid-oauth", area: "no area" },
];

function open(path: string) {
  window.history.replaceState(null, "", path);
  return render(<App />);
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("every old route still works, and lands where it should", () => {
  it.each(OLD_ROUTES)(
    "$from → $lands renders $page ($area)",
    async ({ from, lands, page, area }) => {
      open(from);
      expect(await screen.findByTestId(`page-${page}`)).toBeTruthy();
      expect(window.location.pathname).toBe(lands);
      expect(screen.queryByTestId("page-not-found")).toBeNull();
      if (area === "no header") {
        expect(screen.queryByTestId("app-header")).toBeNull();
      } else {
        const ribbon = Array.from(document.querySelectorAll("[data-tabhref]")).map((n) =>
          n.getAttribute("data-tabhref"),
        );
        expect(ribbon).toEqual(RIBBON[area]);
      }
    },
  );

  it("control: a path that was never a route falls through to NotFound", async () => {
    open("/no-such-page");
    expect(await screen.findByTestId("page-not-found")).toBeTruthy();
    expect(window.location.pathname).toBe("/no-such-page");
  });
});

describe("App.tsx answers to the table", () => {
  it("has a row for every path App.tsx declares", () => {
    const source = readFileSync(join(import.meta.dirname, "App.tsx"), "utf8");
    const declared = Array.from(source.matchAll(/path="([^"]+)"/g), (m) =>
      // "/sign-in/*?" is the Clerk catch-all; its row visits "/sign-in".
      m[1]!.replace(/\/\*\?$/, ""),
    );
    const covered = new Set(OLD_ROUTES.map((r) => r.from));
    expect(declared.length).toBeGreaterThan(20);
    expect(declared.filter((p) => !covered.has(p))).toEqual([]);
  });
});
