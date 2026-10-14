import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import React from "react";

/**
 * The app shell — the navy header, the ONE global bar, the section tabs under
 * it, the breadcrumb and the phone drawer.
 *
 * ⭐ W1 (owner-approved): the bar is the same on every route — Dashboard ·
 * Banking · Amex · Spending · Forecast · Debt · More — and never swaps for an
 * area's tabs. The section you are in is lit, its tabs sit in a lighter row
 * beneath, and a `Dashboard › Section › Tab` line says where you are. The
 * route → section → tab table is walked for EVERY route in `routes.test.tsx`;
 * this file locks the pieces: the boundary-aware matching, the Amex card tabs,
 * the review count, the drawer, the breadcrumb and the keyboard.
 *
 * ⚠️ THE PHONE. The ribbon is `hidden md:flex`, so anything that
 * lives only in a ribbon, and any count only a ribbon tab carries, is invisible
 * on a phone. jsdom applies no CSS, so `shownAt` below reads the Tailwind
 * display classes on an element and its ancestors to say what each screen size
 * would actually show — the tests assert what a phone sees, not just what is in
 * the DOM.
 */

let reviewCount = 0;
/** No spine yet (still loading, or the first load failed): the count is unknown. */
let spineMissing = false;
/** (F1) The categorization queue's total; null = the queue has not answered. */
let queueTotal: number | null = null;

// (C12) The account menu is Clerk's UserButton with our own item (the build
// version). The stand-in renders its children, so the item can be asserted.
vi.mock("@clerk/react", () => {
  const UserButton = Object.assign(
    ({ children }: { children?: React.ReactNode }) => <div data-testid="user-button">{children}</div>,
    {
      MenuItems: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
      Action: ({ label, onClick }: { label: string; onClick?: () => void }) => (
        <button type="button" data-testid="account-menu-item" onClick={onClick}>
          {label}
        </button>
      ),
    },
  );
  return { UserButton };
});

vi.mock("@workspace/api-client-react", () => ({
  // The Review badge reads the shared spine now, not its own endpoint, so the
  // nav count and the landing bell can never disagree (see hooks/useSpine.ts).
  useGetSpine: () => ({
    data: spineMissing ? undefined : { reviewCount },
    isLoading: spineMissing,
  }),
  getGetSpineQueryKey: () => ["/api/spine"],
  getGetSettingsQueryKey: () => ["/api/settings"],
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  // (F1) The Review badge adds the categorization queue's total to the spine's count.
  useListCategorizationReview: () => ({
    data: queueTotal == null ? undefined : { items: [], total: queueTotal },
    isLoading: queueTotal == null,
  }),
  getListCategorizationReviewQueryKey: () => ["/api/categorization/review"],
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
// the DOM to assert against. (The phone drawer is a Radix Dialog, which opens
// on a plain click, so it is driven for real below.)
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
import { VERSION_LABEL } from "./account-menu";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function seededClient(seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seed?.(qc);
  return qc;
}

function mount(path: string, seed?: (qc: QueryClient) => void) {
  const qc = seededClient(seed);
  const { hook, searchHook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook} searchHook={searchHook}>
        <AppLayout>
          <div data-testid="page-body" />
        </AppLayout>
      </Router>
    </QueryClientProvider>,
  );
}

/**
 * Same as `mount`, but with `record: true` so the underlying wouter
 * `history` array can be read back to prove a click actually navigated.
 */
function mountRecording(path: string) {
  const qc = seededClient();
  const { hook, searchHook, history } = memoryLocation({ path, record: true });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook} searchHook={searchHook}>
        <AppLayout>
          <div data-testid="page-body" />
        </AppLayout>
      </Router>
    </QueryClientProvider>,
  );
  return { history };
}

const globalNav = () => screen.getByTestId("global-nav");
const sectionNav = () => screen.queryByTestId("section-nav");

/** The global bar's items, "Label href", in order. */
function barItems(): string[] {
  return Array.from(globalNav().querySelectorAll("[data-tabhref]")).map(
    (n) => `${n.textContent?.replace(/(?<=[A-Za-z])\d+$/, "").trim()} ${n.getAttribute("data-tabhref")}`,
  );
}

/** The lit global item's label, or null. */
function litBar(): string | null {
  const el = globalNav().querySelector('[data-tabhref][aria-current="page"]');
  return el?.textContent?.trim() ?? null;
}

/** The href of the lit section tab, or null. */
function litSectionTab(): string | null {
  const el = sectionNav()?.querySelector('[data-tabhref][aria-current="page"]');
  return el?.getAttribute("data-tabhref") ?? null;
}

/** Every section tab label, in order. */
function sectionLabels(): string[] {
  return Array.from(sectionNav()?.querySelectorAll("[data-tabhref]") ?? []).map(
    (n) => n.textContent?.replace(/(?<=[A-Za-z])\d+$/, "").trim() ?? "",
  );
}

// Display classes that bring a base-`hidden` element back at desktop width
// (a desktop is past both the `sm` and `md` breakpoints).
const SHOWN_FROM_SM_OR_MD = /^(sm|md):(flex|block|inline|inline-flex|grid)$/;

/**
 * Would a phone (below `sm`) or a desktop (`md` and up) show this element?
 * Base `hidden` hides it on a phone; at desktop it stays hidden unless an
 * `sm:`/`md:` display class brings it back; `md:hidden` hides it at desktop.
 */
function shownAt(el: Element, width: "phone" | "desktop"): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const classes = Array.from(n.classList);
    if (width === "phone" && classes.includes("hidden")) return false;
    if (width === "desktop") {
      if (classes.includes("md:hidden")) return false;
      if (classes.includes("hidden") && !classes.some((c) => SHOWN_FROM_SM_OR_MD.test(c))) {
        return false;
      }
    }
  }
  return true;
}

/** Which header/section surfaces show the review count at this width. */
function countsShown(width: "phone" | "desktop"): string[] {
  const out: string[] = [];
  const pill = screen.queryByTestId("topnav-review-badge");
  if (pill && /\d/.test(pill.textContent ?? "") && shownAt(pill, width)) out.push("pill");
  const tab = screen.queryByTestId("sectionnav-review");
  if (tab && /\d/.test(tab.textContent ?? "") && shownAt(tab, width)) out.push("reconcile");
  return out;
}

/** Open the phone drawer the way a thumb does, and return the dialog. */
async function openDrawer(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId("button-mobile-menu"));
  // The drawer's content is its own (lazy) chunk: wait for it.
  await screen.findByTestId("drawer-version");
  return screen.getByRole("dialog", { name: "Navigation" });
}

/** "Label href" for every link inside an element, in order. */
function linksIn(el: Element): string[] {
  return Array.from(el.querySelectorAll("a[href]")).map(
    (a) => `${a.textContent?.replace(/(?<=[A-Za-z])\d+$/, "").trim()} ${a.getAttribute("href")}`,
  );
}

const BAR = [
  "Dashboard /home",
  "Banking /banking",
  "Amex /amex",
  "Spending /spending/week",
  "Forecast /forecast/overview",
  "Debt /avalanche",
];

// Two Amex cards, as the Amex page leaves them in the cache.
const AMEX_PAYOFF = {
  weekStart: "2026-10-11",
  weekEnd: "2026-10-17",
  combinedWeekCharges: 0,
  combinedStatementBalance: 0,
  cards: [
    { accountId: "ext-blue", name: "Blue Cash Preferred", brand: "blue" },
    { accountId: "ext-plat", name: "Platinum Card", brand: "silver" },
  ],
};
const PLAID_ITEMS = [
  {
    id: "i1",
    accounts: [
      { id: "r-blue", accountId: "ext-blue", mask: "1001" },
      { id: "r-plat", accountId: "ext-plat", mask: "2002" },
    ],
  },
];
function seedAmex(qc: QueryClient, preferences: Record<string, unknown> = {}) {
  qc.setQueryData(["/api/amex/weekly-payoff"], AMEX_PAYOFF);
  qc.setQueryData(["/api/settings"], { preferences });
  qc.setQueryData(["/api/plaid/items"], PLAID_ITEMS);
}

beforeEach(() => {
  reviewCount = 0;
  queueTotal = null;
  prefetchRoute.mockClear();
});
afterEach(cleanup);

describe("app shell chrome", () => {
  it("puts the wordmark in the header, pointing at the dashboard", () => {
    mount("/banking");
    const brand = screen.getByTestId("brand-home");
    expect(brand.getAttribute("href")).toBe("/home");
    // One announcement, not "H", "2", "Budget".
    expect(screen.getByTestId("h2-wordmark").getAttribute("aria-label")).toBe("H2 Budget");
  });

  it("(F8) the header carries the Ask launcher on every page, marked when you are on Ask, and warms it", () => {
    mount("/banking");
    const ask = screen.getByTestId("header-ask");
    expect(ask.getAttribute("href")).toBe("/ask");
    expect(ask.getAttribute("aria-label")).toBe("Ask H2");
    expect(ask.getAttribute("aria-current")).toBeNull();
    fireEvent.mouseEnter(ask);
    expect(prefetchRoute).toHaveBeenCalledWith("/ask");
    cleanup();
    mount("/ask");
    expect(screen.getByTestId("header-ask").getAttribute("aria-current")).toBe("page");
  });

  it("(C11) keeps the header on the dashboard and lights Dashboard, with no section row and no breadcrumb", () => {
    mount("/home");
    expect(screen.getByTestId("app-header")).toBeTruthy();
    expect(litBar()).toBe("Dashboard");
    expect(sectionNav()).toBeNull();
    expect(screen.queryByTestId("breadcrumb")).toBeNull();
    expect(screen.getByTestId("page-body")).toBeTruthy();
  });

  it("renders the page keyed on location so every navigation re-runs .page-in", () => {
    mount("/banking");
    expect(document.querySelector(".page-in")).toBeTruthy();
  });

  it("the bar is desktop-only and the drawer trigger phone-only — what the phone tests below rely on", () => {
    mount("/settings");
    expect(shownAt(screen.getByTestId("topnav-banking"), "phone")).toBe(false);
    expect(shownAt(screen.getByTestId("topnav-banking"), "desktop")).toBe(true);
    expect(shownAt(screen.getByTestId("button-mobile-menu"), "phone")).toBe(true);
    expect(shownAt(screen.getByTestId("button-mobile-menu"), "desktop")).toBe(false);
  });

  it("the section row is visible on a phone too (it scrolls sideways), the bar is not", () => {
    mount("/budget");
    const tab = screen.getByTestId("sectionnav-budget");
    expect(shownAt(tab, "phone")).toBe(true);
    expect(shownAt(tab, "desktop")).toBe(true);
  });
});

describe("W1 — one global bar on every route", () => {
  const ROUTES = [
    "/home", "/banking", "/transactions", "/next/accounts", "/next/accounts/acc-1", "/amex",
    "/spending/week", "/spending/month", "/budget", "/allowances", "/wishlist", "/reports",
    "/reports/spending", "/reports/cashflow", "/reports/budget", "/reports/behavior",
    "/forecast/overview", "/forecast", "/next/forecast", "/review", "/bills", "/bills/all",
    "/avalanche", "/debts", "/reports/debt",
    "/review/categories", "/review/suggestions", "/ask", "/mapping-rules", "/settings",
  ];
  it.each(ROUTES)("%s: the same six items in the same order, and More", (path) => {
    mount(path);
    expect(barItems()).toEqual(BAR);
    expect(screen.getByTestId("topnav-more").textContent).toBe("More");
    // Exactly one item is lit at most (More lights itself, the bar none).
    expect(globalNav().querySelectorAll('[data-tabhref][aria-current="page"]').length).toBeLessThanOrEqual(1);
  });

  it("never labels anything Home", async () => {
    for (const path of ROUTES) {
      mount(path);
      const chrome = [screen.getByTestId("app-header"), screen.queryByTestId("section-nav"), screen.queryByTestId("breadcrumb")];
      for (const el of chrome) {
        if (!el) continue;
        expect(el.textContent, path).not.toMatch(/\bHome\b/);
        expect(el.innerHTML, path).not.toMatch(/aria-label="[^"]*\bhome\b/i);
      }
      await openDrawer();
      expect(screen.getByRole("dialog", { name: "Navigation" }).textContent, path).not.toMatch(/\bHome\b/);
      cleanup();
    }
  });

  it("the logo and the Dashboard item both go to /home", () => {
    mount("/banking");
    expect(screen.getByTestId("brand-home").getAttribute("href")).toBe("/home");
    expect(screen.getByTestId("topnav-home").getAttribute("href")).toBe("/home");
  });

  it("More is a menu with Categories, Suggestions, Ask, Mapping rules and Settings", () => {
    mount("/banking");
    const hrefs = Array.from(document.querySelectorAll('[data-testid^="morenav-"]')).map((a) => a.getAttribute("href"));
    expect(hrefs.slice(0, 5)).toEqual(["/review/categories", "/review/suggestions", "/ask", "/mapping-rules", "/settings"]);
  });

  it("a More page lights More, not a bar item, and shows no section tabs", () => {
    mount("/settings");
    expect(litBar()).toBeNull();
    expect(screen.getByTestId("topnav-more").querySelector(".tab-underline")).toBeTruthy();
    expect(sectionNav()).toBeNull();
    cleanup();
    mount("/banking");
    expect(screen.getByTestId("topnav-more").querySelector(".tab-underline")).toBeNull();
  });
});

describe("W1 — section tabs under the bar", () => {
  it.each<[string, string, string[], string]>([
    ["/banking", "Banking", ["Review", "Chase register", "Accounts"], "/banking"],
    ["/transactions", "Banking", ["Review", "Chase register", "Accounts"], "/transactions"],
    ["/next/accounts", "Banking", ["Review", "Chase register", "Accounts"], "/next/accounts"],
    // One account's page is still the Accounts tab.
    ["/next/accounts/acc-1", "Banking", ["Review", "Chase register", "Accounts"], "/next/accounts"],
    ["/amex", "Amex", ["All cards"], "/amex"],
    ["/spending/week", "Spending", ["This week", "This month", "Budget", "Allowances", "Wish list", "Reports"], "/spending/week"],
    ["/spending/month", "Spending", ["This week", "This month", "Budget", "Allowances", "Wish list", "Reports"], "/spending/month"],
    ["/budget", "Spending", ["This week", "This month", "Budget", "Allowances", "Wish list", "Reports"], "/budget"],
    // Reports owns its four pages.
    ["/reports", "Spending", ["This week", "This month", "Budget", "Allowances", "Wish list", "Reports"], "/reports"],
    ["/reports/spending", "Spending", ["This week", "This month", "Budget", "Allowances", "Wish list", "Reports"], "/reports"],
    ["/reports/cashflow", "Spending", ["This week", "This month", "Budget", "Allowances", "Wish list", "Reports"], "/reports"],
    ["/reports/budget", "Spending", ["This week", "This month", "Budget", "Allowances", "Wish list", "Reports"], "/reports"],
    ["/reports/behavior", "Spending", ["This week", "This month", "Budget", "Allowances", "Wish list", "Reports"], "/reports"],
    ["/forecast/overview", "Forecast", ["Overview", "Forecast", "Reconcile", "Bills"], "/forecast/overview"],
    // /forecast/overview never also lights /forecast, and /next/forecast is Forecast's.
    ["/forecast", "Forecast", ["Overview", "Forecast", "Reconcile", "Bills"], "/forecast"],
    ["/next/forecast", "Forecast", ["Overview", "Forecast", "Reconcile", "Bills"], "/forecast"],
    ["/review", "Forecast", ["Overview", "Forecast", "Reconcile", "Bills"], "/review"],
    ["/bills", "Forecast", ["Overview", "Forecast", "Reconcile", "Bills"], "/bills"],
    // One tab covers /bills and /bills/all.
    ["/bills/all", "Forecast", ["Overview", "Forecast", "Reconcile", "Bills"], "/bills"],
    ["/avalanche", "Debt", ["Payoff plan", "Debts", "Debt report"], "/avalanche"],
    ["/debts", "Debt", ["Payoff plan", "Debts", "Debt report"], "/debts"],
    // Debt's report, not Spending's /reports hub.
    ["/reports/debt", "Debt", ["Payoff plan", "Debts", "Debt report"], "/reports/debt"],
  ])("%s lights %s and tab %s", (path, bar, labels, tab) => {
    mount(path);
    expect(litBar()).toBe(bar);
    expect(sectionLabels()).toEqual(labels);
    expect(litSectionTab()).toBe(tab);
    expect(globalNav().querySelectorAll('[aria-current="page"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="section-nav"] [aria-current="page"]').length).toBe(1);
  });

  it("whole path segments only: /billsx and /settingsx belong to no section", () => {
    for (const path of ["/billsx", "/settingsx"]) {
      mount(path);
      expect(litBar(), path).toBeNull();
      expect(sectionNav(), path).toBeNull();
      expect(screen.getByTestId("mobile-page-title").textContent).toBe("H2 Budget");
      cleanup();
    }
  });

  it("/reports/debtx is not Debt's report: it falls to the Reports hub's section", () => {
    mount("/reports/debtx");
    expect(litBar()).toBe("Spending");
    expect(litSectionTab()).toBe("/reports");
  });

  it("the section row never replaces the bar: Chase and Amex keep the same six items", () => {
    mount("/transactions");
    expect(barItems()).toEqual(BAR);
    cleanup();
    mount("/amex");
    expect(barItems()).toEqual(BAR);
  });
});

describe("W1 — Amex has a tab per card", () => {
  it("shows only 'All cards' until the cards are loaded", () => {
    mount("/amex");
    expect(sectionLabels()).toEqual(["All cards"]);
  });

  it("names each card the way the card band does, with ••last4", async () => {
    mount("/amex", (qc) => seedAmex(qc));
    await screen.findByTestId("sectionnav-amex?card=ext-plat");
    // tier word (Blue Cash / Platinum) when the household has not named it.
    expect(sectionLabels()).toEqual(["All cards", "Blue Cash ••1001", "Platinum ••2002"]);
    expect(screen.getByTestId("sectionnav-amex?card=ext-blue").getAttribute("href")).toBe("/amex?card=ext-blue");
  });

  it("a name the household gave a card wins", async () => {
    mount("/amex", (qc) => seedAmex(qc, { amexCardNames: { "ext-blue": "Everyday" } }));
    await screen.findByTestId("sectionnav-amex?card=ext-plat");
    expect(sectionLabels()).toEqual(["All cards", "Everyday ••1001", "Platinum ••2002"]);
  });

  it("?card= selects that card's tab; the older ?accountId= does too; else All cards", async () => {
    mount("/amex?card=ext-plat", (qc) => seedAmex(qc));
    await screen.findByTestId("sectionnav-amex?card=ext-plat");
    expect(litSectionTab()).toBe("/amex?card=ext-plat");
    cleanup();
    mount("/amex?accountId=ext-blue", (qc) => seedAmex(qc));
    await screen.findByTestId("sectionnav-amex?card=ext-plat");
    expect(litSectionTab()).toBe("/amex?card=ext-blue");
    cleanup();
    mount("/amex?card=ext-gone", (qc) => seedAmex(qc));
    await screen.findByTestId("sectionnav-amex?card=ext-plat");
    expect(litSectionTab()).toBe("/amex");
    cleanup();
    mount("/amex", (qc) => seedAmex(qc));
    await screen.findByTestId("sectionnav-amex?card=ext-plat");
    expect(litSectionTab()).toBe("/amex");
  });

  it("the card tabs are in the drawer under Amex, and the breadcrumb names the card", async () => {
    mount("/amex?card=ext-blue", (qc) => seedAmex(qc));
    await screen.findByTestId("sectionnav-amex?card=ext-plat");
    const tree = linksIn((await openDrawer()).querySelector('[data-testid="mobilenav-area-amex"]')!);
    expect(tree).toEqual(["Amex /amex", "Blue Cash ••1001 /amex?card=ext-blue", "Platinum ••2002 /amex?card=ext-plat"]);
    expect(screen.getByTestId("breadcrumb-trail").textContent).toContain("Blue Cash ••1001");
  });
});

describe("W1 — where am I", () => {
  const trail = () =>
    Array.from(screen.getByTestId("breadcrumb-trail").querySelector("nav")!.children).map((item) => {
      const a = item.querySelector("a");
      return a ? `[${a.textContent}](${a.getAttribute("href")})` : item.querySelector("span:not([aria-hidden])")!.textContent;
    });

  it("Dashboard › Section › Tab, Dashboard and the section are links, the page is not", () => {
    mount("/transactions");
    expect(trail()).toEqual(["[Dashboard](/home)", "[Banking](/banking)", "Chase register"]);
  });

  it("More's pages read Dashboard › More › Page", () => {
    mount("/mapping-rules");
    expect(trail()).toEqual(["[Dashboard](/home)", "More", "Mapping rules"]);
  });

  it("the trail is desktop-only; a phone gets one back link: ‹ Dashboard on a landing, ‹ Section deeper", () => {
    mount("/banking");
    expect(shownAt(screen.getByTestId("breadcrumb-trail"), "phone")).toBe(false);
    const back = screen.getByTestId("breadcrumb-back");
    expect(shownAt(back, "phone")).toBe(true);
    expect(shownAt(back, "desktop")).toBe(false);
    expect(back.textContent).toBe("‹ Dashboard");
    expect(back.getAttribute("href")).toBe("/home");
    cleanup();
    mount("/transactions");
    expect(screen.getByTestId("breadcrumb-back").textContent).toBe("‹ Banking");
    expect(screen.getByTestId("breadcrumb-back").getAttribute("href")).toBe("/banking");
    cleanup();
    mount("/settings");
    expect(screen.getByTestId("breadcrumb-back").textContent).toBe("‹ Dashboard");
  });

  it("sits outside the scroller, so it never covers a page's own sticky head", () => {
    mount("/budget");
    const scroller = document.querySelector("[data-shell-scroller]")!;
    expect(scroller.contains(screen.getByTestId("breadcrumb"))).toBe(false);
  });
});

describe("boundary-aware active tab", () => {
  it("does not treat /transactions as inside the Forecast section", () => {
    mount("/transactions");
    expect(litBar()).toBe("Banking");
    expect(litSectionTab()).toBe("/transactions");
  });
});

describe("the phone drawer reaches every page the section rows reach", () => {
  // Every route any section row links to, typed out by hand — NOT read from
  // the model — so a page dropped from the drawer fails here.
  const SECTION_ROUTES = [
    "/banking", "/transactions", "/next/accounts", "/amex",
    "/spending/week", "/spending/month", "/budget", "/allowances", "/wishlist", "/reports",
    "/forecast/overview", "/forecast", "/review", "/bills",
    "/avalanche", "/debts", "/reports/debt",
  ];

  it("the list above is exactly what the desktop section rows link to", async () => {
    const seen = new Set<string>();
    for (const path of ["/banking", "/amex", "/spending/week", "/forecast/overview", "/avalanche"]) {
      mount(path);
      for (const n of Array.from(document.querySelectorAll('[data-testid="section-nav"] [data-tabhref]'))) {
        seen.add(n.getAttribute("data-tabhref")!);
      }
      cleanup();
    }
    expect([...seen].sort()).toEqual([...SECTION_ROUTES].sort());
  });

  it.each(["/settings", "/bills/all", "/banking", "/transactions"])(
    "opened on %s, the drawer links to every section route, Dashboard and every More page",
    async (from) => {
      mount(from);
      const hrefs = Array.from((await openDrawer()).querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
      for (const route of ["/home", ...SECTION_ROUTES, "/review/categories", "/review/suggestions", "/ask", "/mapping-rules", "/settings"]) {
        expect(hrefs).toContain(route);
      }
    },
  );

  it("lists the six sections in the bar's order, each with its tabs beneath it", async () => {
    mount("/settings");
    const tree = Array.from((await openDrawer()).querySelectorAll('[data-testid^="mobilenav-area-"]')).map(linksIn);
    expect(tree).toEqual([
      ["Dashboard /home"],
      ["Banking /banking", "Chase register /transactions", "Accounts /next/accounts"],
      ["Amex /amex"],
      [
        "Spending /spending/week",
        "This month /spending/month",
        "Budget /budget",
        "Allowances /allowances",
        "Wish list /wishlist",
        "Reports /reports",
      ],
      ["Forecast /forecast/overview", "Forecast /forecast", "Reconcile /review", "Bills /bills"],
      ["Debt /avalanche", "Debts /debts", "Debt report /reports/debt"],
    ]);
  });

  it("keeps More's pages with Settings' sub-pages beneath, and lists no page twice", async () => {
    mount("/settings");
    const nav = (await openDrawer()).querySelector("nav")!;
    const links = linksIn(nav);
    expect(links.slice(-12)).toEqual([
      "Categories /review/categories",
      "Suggestions /review/suggestions",
      "Ask /ask",
      "Mapping rules /mapping-rules",
      "Settings /settings",
      "Household /settings?tab=household",
      "Data /settings?tab=data",
      "Automation /settings?tab=automation",
      "Morning text /settings?tab=morning-text",
      "AI cost /settings?tab=ai",
      "Memory /settings?tab=memory",
      "Privacy /settings?tab=privacy",
    ]);
    const hrefs = links.map((l) => l.split(" ").pop());
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("puts the forecast inbox count on the drawer's Reconcile row and the queue on Categories", async () => {
    reviewCount = 4;
    queueTotal = 3;
    mount("/banking");
    const drawer = await openDrawer();
    expect(drawer.querySelector('[data-testid="mobilenav-review"]')!.textContent).toContain("4");
    expect(drawer.querySelector('[data-testid="mobilenav-review/categories"]')!.textContent).toContain("3");
  });

  it("lights the page you are on: the section row on its landing tab, a nested row otherwise", async () => {
    const lit = async () =>
      Array.from((await openDrawer()).querySelectorAll('[aria-current="page"]')).map((a) => a.getAttribute("href"));
    mount("/banking");
    expect(await lit()).toEqual(["/banking"]);
    cleanup();
    mount("/bills/all");
    expect(await lit()).toEqual(["/bills"]);
    cleanup();
    mount("/reports/debt");
    expect(await lit()).toEqual(["/reports/debt"]);
    cleanup();
    mount("/home");
    expect(await lit()).toEqual(["/home"]);
    cleanup();
    mount("/billsx");
    expect(await lit()).toEqual([]);
  });
});

describe("R0 follow-up — the phone drawer closes after you navigate", () => {
  // ⚠️ `DrawerLink`'s `onClick={onNavigate}` (`layout.tsx`) is the ONLY thing
  // that sets `mobileOpen` back to false — wouter's own `<Link>` handles the
  // route change regardless, so removing that wiring leaves navigation working
  // but the drawer stuck open over the new page.
  it("clicking a page link inside the drawer closes it and changes the route", async () => {
    const { history } = mountRecording("/banking");
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByTestId("mobilenav-budget"));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(history[history.length - 1]).toBe("/budget");
  });

  it("clicking a section row itself (not a nested page) also closes the drawer", async () => {
    const { history } = mountRecording("/banking");
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByTestId("mobilenav-forecast/overview"));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(history[history.length - 1]).toBe("/forecast/overview");
  });

  it("Escape closes the drawer", async () => {
    mount("/banking");
    const drawer = await openDrawer();
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });
});

describe("the mobile page title", () => {
  it("names the page on a phone by whole segments", () => {
    mount("/bills/all");
    expect(screen.getByTestId("mobile-page-title").textContent).toBe("Bills");
    cleanup();
    mount("/transactions");
    expect(screen.getByTestId("mobile-page-title").textContent).toBe("Chase register");
    cleanup();
    mount("/settings");
    expect(screen.getByTestId("mobile-page-title").textContent).toBe("Settings");
    cleanup();
    mount("/home");
    expect(screen.getByTestId("mobile-page-title").textContent).toBe("Dashboard");
  });
});

describe("the review count is a finding or it is nothing", () => {
  it("shows no badge at all when the queue is empty", () => {
    reviewCount = 0;
    mount("/review");
    expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
    // and no zero pill on the Reconcile tab either
    expect(screen.getByTestId("sectionnav-review").textContent).toBe("Reconcile");
  });

  // ⚠️ ONCE. In Forecast the Reconcile tab carries the count; everywhere else
  // the header pill does, at every width.
  it.each<[string, string[], string[]]>([
    ["/review", ["reconcile"], ["reconcile"]],
    ["/forecast/overview", ["reconcile"], ["reconcile"]],
    ["/transactions", ["pill"], ["pill"]],
    ["/amex", ["pill"], ["pill"]],
    ["/settings", ["pill"], ["pill"]],
    ["/banking", ["pill"], ["pill"]],
    ["/home", ["pill"], ["pill"]],
  ])("on %s the count shows once: phone %j, desktop %j", (path, phone, desktop) => {
    reviewCount = 4;
    mount(path);
    expect(countsShown("phone")).toEqual(phone);
    expect(countsShown("desktop")).toEqual(desktop);
  });

  it("the pill is a real way into the inbox", () => {
    reviewCount = 4;
    mount("/transactions");
    const pill = screen.getByTestId("topnav-review-badge");
    expect(pill.getAttribute("href")).toBe("/review");
    expect(pill.getAttribute("aria-label")).toBe("4 items to review");
  });

  it("shows no badge anywhere while the count is unknown, not a zero pill", () => {
    spineMissing = true;
    try {
      mount("/banking");
      expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
      cleanup();
      mount("/review");
      expect(screen.getByTestId("sectionnav-review").textContent).toBe("Reconcile");
      expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
    } finally {
      spineMissing = false;
    }
  });
});

describe("(F1) the Review badge adds the categorization queue", () => {
  it("the pill carries forecast review + queue total", () => {
    reviewCount = 4;
    queueTotal = 3;
    mount("/banking");
    expect(screen.getByTestId("topnav-review-badge").getAttribute("aria-label")).toBe("7 items to review");
  });

  it("each count sits on the item that owns its page: Reconcile = forecast, Categories (in More) = queue", () => {
    reviewCount = 4;
    queueTotal = 3;
    mount("/review");
    expect(screen.getByTestId("sectionnav-review").textContent).toBe("Reconcile4");
    expect(screen.getByTestId("morenav-review/categories").textContent).toBe("Categories3");
  });

  it("the pill goes to the forecast inbox when it has charges, else to the categories queue", () => {
    reviewCount = 4;
    queueTotal = 3;
    mount("/banking");
    expect(screen.getByTestId("topnav-review-badge").getAttribute("href")).toBe("/review");
    cleanup();
    reviewCount = 0;
    mount("/banking");
    expect(screen.getByTestId("topnav-review-badge").getAttribute("href")).toBe("/review/categories");
    expect(screen.getByTestId("topnav-review-badge").getAttribute("aria-label")).toBe("3 items to review");
  });

  it("a queue that has not answered adds nothing and is not a zero", () => {
    reviewCount = 4;
    queueTotal = null;
    mount("/banking");
    expect(screen.getByTestId("topnav-review-badge").getAttribute("aria-label")).toBe("4 items to review");
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
    fireEvent.focus(screen.getByTestId("sectionnav-transactions"));
    expect(prefetchRoute).toHaveBeenCalledWith("/transactions");
  });

  it("a card tab warms the Amex chunk (the query string is not part of the route)", async () => {
    mount("/amex", (qc) => seedAmex(qc));
    fireEvent.mouseEnter(await screen.findByTestId("sectionnav-amex?card=ext-blue"));
    expect(prefetchRoute).toHaveBeenCalledWith("/amex");
  });

  it("warms from the phone drawer too", async () => {
    mount("/settings");
    const drawer = await openDrawer();
    fireEvent.mouseEnter(drawer.querySelector('[data-testid="mobilenav-budget"]')!);
    expect(prefetchRoute).toHaveBeenCalledWith("/budget");
  });
});

describe("(C12) Settings' sub-pages, the account menu and the chrome tokens", () => {
  it("More lists Settings' sub-pages beneath Settings, and hovering one warms Settings", () => {
    mount("/mapping-rules");
    expect(screen.getByTestId("morenav-settings-household").getAttribute("href")).toBe("/settings?tab=household");
    expect(screen.getByTestId("morenav-settings-memory").textContent).toBe("Memory");
    expect(screen.queryByTestId("morenav-settings-banks")).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("morenav-settings-ai"));
    expect(prefetchRoute).toHaveBeenCalledWith("/settings");
  });

  it("More marks the page you are on: the Settings sub-page when one is open", async () => {
    mount("/settings?tab=memory");
    expect(screen.getByTestId("morenav-settings-memory").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("morenav-settings").getAttribute("aria-current")).toBeNull();
    cleanup();
    mount("/mapping-rules");
    expect(screen.getByTestId("morenav-mapping-rules").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("morenav-settings-memory").getAttribute("aria-current")).toBeNull();
  });

  it("the drawer lights the open Settings sub-page, with Settings as the place you are in", async () => {
    mount("/settings?tab=memory");
    const lit = Array.from((await openDrawer()).querySelectorAll('[aria-current="page"]')).map((a) => a.getAttribute("href"));
    expect(lit).toEqual(["/settings?tab=memory"]);
    cleanup();
    // Banks is plain /settings: the Settings row itself.
    mount("/settings?tab=banks");
    const lit2 = Array.from((await openDrawer()).querySelectorAll('[aria-current="page"]')).map((a) => a.getAttribute("href"));
    expect(lit2).toEqual(["/settings"]);
  });

  it("More has no dot: nothing in it carries a count", () => {
    mount("/settings");
    const more = screen.getByTestId("topnav-more");
    // The text and, on /settings, the underline — nothing else.
    expect(more.textContent).toBe("More");
    expect(more.querySelectorAll("span").length).toBe(1);
    expect(more.querySelector(".tab-underline")).toBeTruthy();
  });

  it("the account menu carries the build version, in the header and in the drawer", async () => {
    mount("/banking");
    const items = screen.getAllByTestId("account-menu-item").map((b) => b.textContent);
    expect(items).toEqual([VERSION_LABEL]);
    expect(VERSION_LABEL).toMatch(/^Version \S+$/);
    const drawer = await openDrawer();
    expect(within(drawer).getByTestId("drawer-version").textContent).toBe(VERSION_LABEL);
    expect(within(drawer).getAllByTestId("account-menu-item").map((b) => b.textContent)).toEqual([VERSION_LABEL]);
  });

  it("tapping the version copies the build id", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      mount("/banking");
      fireEvent.click(screen.getAllByTestId("account-menu-item")[0]!);
      expect(writeText).toHaveBeenCalledWith(VERSION_LABEL.replace(/^Version /, ""));
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
  });

  it("(SH-01) the top line is gone at the switch: no preview line, no link to a 'current app', on any page", () => {
    for (const path of ["/home", "/banking", "/settings", "/next/forecast"]) {
      mount(path);
      expect(screen.queryByTestId("classic-retiring-banner")).toBeNull();
      expect(screen.queryByText(/modernization preview/i)).toBeNull();
      expect(screen.queryByText(/current app/i)).toBeNull();
      // The header is the first thing in the shell now.
      expect(screen.getByTestId("app-header").previousElementSibling).toBeNull();
      cleanup();
    }
  });

  it("the chrome is drawn on tokens: no white/NN, rgba() or hex literal in the header, ribbon or drawer", () => {
    for (const file of ["layout.tsx", "tab-ribbon.tsx", "account-menu.tsx", "mobile-nav.tsx", "home-mark.tsx"]) {
      const code = readFileSync(join(import.meta.dirname, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code.match(/\bwhite\/\d+/g), `${file}: white/NN`).toBeNull();
      expect(code.match(/rgba?\(/g), `${file}: rgb()/rgba()`).toBeNull();
      expect(code.match(/#[0-9a-fA-F]{3,8}\b/g), `${file}: hex`).toBeNull();
    }
  });
});

describe("W1 — keyboard", () => {
  it("(SH-04) ←/→ on the global bar move to the next item, wrapping at the ends", () => {
    const { history } = mountRecording("/banking");
    fireEvent.keyDown(screen.getByRole("navigation", { name: "Sections" }), { key: "ArrowRight" });
    expect(history[history.length - 1]).toBe("/amex");
    cleanup();
    const second = mountRecording("/home");
    fireEvent.keyDown(screen.getByRole("navigation", { name: "Sections" }), { key: "ArrowLeft" });
    expect(second.history[second.history.length - 1]).toBe("/avalanche");
  });

  it("←/→ on the section row move along its tabs, wrapping at the ends", () => {
    const { history } = mountRecording("/transactions");
    fireEvent.keyDown(screen.getByRole("navigation", { name: "Section pages" }), { key: "ArrowRight" });
    expect(history[history.length - 1]).toBe("/next/accounts");
    cleanup();
    const second = mountRecording("/banking");
    fireEvent.keyDown(screen.getByRole("navigation", { name: "Section pages" }), { key: "ArrowLeft" });
    expect(second.history[second.history.length - 1]).toBe("/next/accounts");
  });

  it("Tab reaches More: it is a real focusable button right after the last bar item", () => {
    mount("/banking");
    const more = screen.getByTestId("topnav-more");
    expect(more.tagName).toBe("BUTTON");
    expect(more.getAttribute("tabindex")).not.toBe("-1");
    const items = Array.from(globalNav().querySelectorAll("[data-tabhref]"));
    const lastBar = items[items.length - 1]!;
    expect(lastBar.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    more.focus();
    expect(document.activeElement).toBe(more);
  });
});
