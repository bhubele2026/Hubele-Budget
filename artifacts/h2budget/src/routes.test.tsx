import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup, within } from "@testing-library/react";
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
 *   - which global item is lit, which section tab is lit, and the breadcrumb.
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
  // (C12) The account menu adds one item through UserButton's compound parts.
  UserButton: Object.assign(() => <div data-testid="user-button" />, {
    MenuItems: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Action: () => null,
  }),
}));
vi.mock("@clerk/react/internal", () => ({
  publishableKeyFromHost: () => "pk_test_routes",
}));
vi.mock("@clerk/themes", () => ({ shadcn: {} }));

vi.mock("@workspace/api-client-react", () => ({
  useListCategorizationReview: () => ({ data: undefined, isLoading: true }),
  getListCategorizationReviewQueryKey: () => ["/api/categorization/review"],
  getSpine: vi.fn(() => new Promise(() => {})),
  getGetSpineQueryKey: () => ["/api/spine"],
  getGetSettingsQueryKey: () => ["/api/settings"],
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
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
    importReviewCategories: page("review-categories"),
    importTransactions: page("transactions"),
    importBills: page("bills"),
    importBillsOverview: page("bills-overview"),
    importBudget: page("budget"),
    importAllowances: page("allowances"),
    importSpendingPeriod: page("spending-period"),
    importWishlist: page("wishlist"),
    importMappingRules: page("mapping-rules"),
    importSettings: page("settings"),
    importAsk: page("ask"),
    importSuggestions: page("review-suggestions"),
    importNextForecast: page("next-forecast"),
    importNextAccounts: page("next-accounts"),
    prefetchRoute: () => {},
    whenRouteChunkLoaded: () => null,
  };
});
// (C11) The landing IS the dashboard page, statically imported by App.tsx.
vi.mock("./pages/next/Dashboard", () => ({
  default: () => <div data-testid="page-next-dashboard" />,
}));
vi.mock("./pages/next/dashboard/DashboardSkeleton", () => ({
  DashboardSkeleton: () => null,
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
vi.mock("@/lib/spineRecovery", () => ({
  askForSpineAgainIfFailed: () => () => {},
  askForUnauthorizedAgain: () => () => {},
  noteClerkSettled: () => {},
  clerkHasSettled: () => true,
  isUnauthorized: () => false,
}));
vi.mock("@/lib/mutationInvalidation", () => ({ onWriteSuccess: () => {} }));

import App from "./App";

// (W1) The global bar is the SAME on every route, typed out here — not read
// from layout.tsx. Exactly one item is lit (the route's section) and the
// section row under it lights the route's own tab.
const GLOBAL_BAR = [
  ["Dashboard", "/home"],
  ["Banking", "/banking"],
  ["Amex", "/amex"],
  ["Spending", "/spending/week"],
  ["Forecast", "/forecast/overview"],
  ["Debt", "/avalanche"],
];

// The section tabs each section shows, by the label of its global item.
const SECTION_TABS: Record<string, string[]> = {
  Dashboard: [],
  Banking: ["/banking", "/transactions", "/next/accounts"],
  Amex: ["/amex"],
  Spending: ["/spending/week", "/spending/month", "/budget", "/allowances", "/wishlist", "/reports"],
  Forecast: ["/forecast/overview", "/forecast", "/review", "/bills"],
  Debt: ["/avalanche", "/debts", "/reports/debt"],
  More: [],
};

type Row = {
  /** The route as it existed before. */
  from: string;
  /** Where you end up: the route itself, or its redirect target. */
  lands: string;
  /** The page that renders there. */
  page: string;
  /** The lit global item ("none": no section, "no header": auth). */
  lit: string;
  /** The lit section tab's href, or null. */
  tab: string | null;
  /** The breadcrumb line ("" = none). */
  crumb: string;
};

const OLD_ROUTES: Row[] = [
  { from: "/", lands: "/home", page: "next-dashboard", lit: "Dashboard", tab: null, crumb: "" },
  { from: "/home", lands: "/home", page: "next-dashboard", lit: "Dashboard", tab: null, crumb: "" },
  { from: "/sign-in", lands: "/sign-in", page: "sign-in", lit: "no header", tab: null, crumb: "" },
  { from: "/sign-up", lands: "/sign-up", page: "sign-up", lit: "no header", tab: null, crumb: "" },
  { from: "/banking", lands: "/banking", page: "command-center", lit: "Banking", tab: "/banking", crumb: "Dashboard › Banking › Review" },
  { from: "/dashboard", lands: "/home", page: "next-dashboard", lit: "Dashboard", tab: null, crumb: "" },
  { from: "/forecast/overview", lands: "/forecast/overview", page: "forecast-overview", lit: "Forecast", tab: "/forecast/overview", crumb: "Dashboard › Forecast › Overview" },
  { from: "/forecast", lands: "/forecast", page: "forecast:overall", lit: "Forecast", tab: "/forecast", crumb: "Dashboard › Forecast › Forecast" },
  { from: "/bills", lands: "/bills", page: "bills-overview", lit: "Forecast", tab: "/bills", crumb: "Dashboard › Forecast › Bills" },
  { from: "/bills/all", lands: "/bills/all", page: "bills", lit: "Forecast", tab: "/bills", crumb: "Dashboard › Forecast › Bills" },
  { from: "/recurring", lands: "/bills/all", page: "bills", lit: "Forecast", tab: "/bills", crumb: "Dashboard › Forecast › Bills" },
  { from: "/spending/week", lands: "/spending/week", page: "spending-period", lit: "Spending", tab: "/spending/week", crumb: "Dashboard › Spending › This week" },
  { from: "/spending/month", lands: "/spending/month", page: "spending-period", lit: "Spending", tab: "/spending/month", crumb: "Dashboard › Spending › This month" },
  { from: "/spending", lands: "/spending/week", page: "spending-period", lit: "Spending", tab: "/spending/week", crumb: "Dashboard › Spending › This week" },
  { from: "/reports/spending", lands: "/reports/spending", page: "reports-spending", lit: "Spending", tab: "/reports", crumb: "Dashboard › Spending › Reports" },
  { from: "/budget", lands: "/budget", page: "budget", lit: "Spending", tab: "/budget", crumb: "Dashboard › Spending › Budget" },
  { from: "/allowances", lands: "/allowances", page: "allowances", lit: "Spending", tab: "/allowances", crumb: "Dashboard › Spending › Allowances" },
  { from: "/wishlist", lands: "/wishlist", page: "wishlist", lit: "Spending", tab: "/wishlist", crumb: "Dashboard › Spending › Wish list" },
  { from: "/reports", lands: "/reports", page: "reports", lit: "Spending", tab: "/reports", crumb: "Dashboard › Spending › Reports" },
  { from: "/review", lands: "/review", page: "forecast:review", lit: "Forecast", tab: "/review", crumb: "Dashboard › Forecast › Reconcile" },
  { from: "/review/categories", lands: "/review/categories", page: "review-categories", lit: "More", tab: null, crumb: "Dashboard › More › Categories" },
  { from: "/transactions", lands: "/transactions", page: "transactions", lit: "Banking", tab: "/transactions", crumb: "Dashboard › Banking › Chase register" },
  { from: "/amex", lands: "/amex", page: "amex", lit: "Amex", tab: "/amex", crumb: "Dashboard › Amex › All cards" },
  { from: "/avalanche", lands: "/avalanche", page: "avalanche", lit: "Debt", tab: "/avalanche", crumb: "Dashboard › Debt › Payoff plan" },
  { from: "/debts", lands: "/debts", page: "debts", lit: "Debt", tab: "/debts", crumb: "Dashboard › Debt › Debts" },
  { from: "/reports/debt", lands: "/reports/debt", page: "reports-debt", lit: "Debt", tab: "/reports/debt", crumb: "Dashboard › Debt › Debt report" },
  { from: "/reports/cashflow", lands: "/reports/cashflow", page: "reports-cashflow", lit: "Spending", tab: "/reports", crumb: "Dashboard › Spending › Reports" },
  { from: "/reports/budget", lands: "/reports/budget", page: "reports-budget", lit: "Spending", tab: "/reports", crumb: "Dashboard › Spending › Reports" },
  { from: "/reports/behavior", lands: "/reports/behavior", page: "reports-behavior", lit: "Spending", tab: "/reports", crumb: "Dashboard › Spending › Reports" },
  { from: "/mapping-rules", lands: "/mapping-rules", page: "mapping-rules", lit: "More", tab: null, crumb: "Dashboard › More › Mapping rules" },
  { from: "/settings", lands: "/settings", page: "settings", lit: "More", tab: null, crumb: "Dashboard › More › Settings" },
  // (F8) Ask is in More; Suggestions too.
  { from: "/ask", lands: "/ask", page: "ask", lit: "More", tab: null, crumb: "Dashboard › More › Ask" },
  { from: "/review/suggestions", lands: "/review/suggestions", page: "review-suggestions", lit: "More", tab: null, crumb: "Dashboard › More › Suggestions" },
  // The /next preview pages: reachable by URL. /next/dashboard became the
  // landing (it redirects to /home); /next/forecast is Forecast's own tab
  // owner; /next/accounts is Banking's "Accounts" tab.
  { from: "/next/dashboard", lands: "/home", page: "next-dashboard", lit: "Dashboard", tab: null, crumb: "" },
  { from: "/next/forecast", lands: "/next/forecast", page: "next-forecast", lit: "Forecast", tab: "/forecast", crumb: "Dashboard › Forecast › Forecast" },
  { from: "/next/accounts", lands: "/next/accounts", page: "next-accounts", lit: "Banking", tab: "/next/accounts", crumb: "Dashboard › Banking › Accounts" },
  { from: "/next/accounts/:plaidAccountId", lands: "/next/accounts/:plaidAccountId", page: "next-accounts", lit: "Banking", tab: "/next/accounts", crumb: "Dashboard › Banking › Accounts" },
  { from: "/plaid-oauth", lands: "/plaid-oauth", page: "plaid-oauth", lit: "none", tab: null, crumb: "" },
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
    "$from → $lands renders $page (lit: $lit, tab: $tab)",
    async ({ from, lands, page, lit, tab, crumb }) => {
      open(from);
      expect(await screen.findByTestId(`page-${page}`)).toBeTruthy();
      expect(window.location.pathname).toBe(lands);
      expect(screen.queryByTestId("page-not-found")).toBeNull();
      if (lit === "no header") {
        expect(screen.queryByTestId("app-header")).toBeNull();
        return;
      }
      // The ONE global bar: the same six items in the same order, then More.
      const bar = within(screen.getByTestId("global-nav"));
      const items = Array.from(document.querySelectorAll('[data-testid="global-nav"] [data-tabhref]'));
      expect(items.map((n) => [n.textContent, n.getAttribute("data-tabhref")])).toEqual(GLOBAL_BAR);
      expect(bar.getByTestId("topnav-more")).toBeTruthy();
      // Exactly one global item is lit, and it is this route's section.
      const litItems = Array.from(
        document.querySelectorAll('[data-testid="global-nav"] [aria-current="page"]'),
      ).map((n) => n.textContent);
      expect(litItems).toEqual(lit === "none" || lit === "More" ? [] : [lit]);
      if (lit === "More") {
        expect(screen.getByTestId("topnav-more").querySelector(".tab-underline")).toBeTruthy();
      }
      // The section row under it: that section's tabs, the route's own one lit.
      const row = Array.from(document.querySelectorAll('[data-testid="section-nav"] [data-tabhref]'));
      expect(row.map((n) => n.getAttribute("data-tabhref"))).toEqual(SECTION_TABS[lit] ?? []);
      const litTab = document.querySelector('[data-testid="section-nav"] [aria-current="page"]');
      expect(litTab?.getAttribute("data-tabhref") ?? null).toBe(tab);
      // Where am I.
      const trail = screen.queryByTestId("breadcrumb-trail");
      expect(trail?.textContent?.replace(/\s*›\s*/g, " › ").trim() ?? "").toBe(crumb);
      // The word "Home" is not a label anywhere in the chrome.
      expect(within(screen.getByTestId("app-header")).queryByText(/^home$/i)).toBeNull();
    },
  );

  it("the logo and Dashboard both go to /home", async () => {
    open("/banking");
    await screen.findByTestId("page-command-center");
    expect(screen.getByTestId("brand-home").getAttribute("href")).toBe("/home");
    expect(screen.getByTestId("topnav-home").getAttribute("href")).toBe("/home");
  });

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
