import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
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
 *
 * ⚠️ R0 round 2 — THE PHONE. The ribbon is `hidden md:flex`, so anything that
 * lives only in a ribbon, and any count only a ribbon tab carries, is invisible
 * on a phone. jsdom applies no CSS, so `shownAt` below reads the Tailwind
 * display classes on an element and its ancestors to say what each screen size
 * would actually show — the tests assert what a phone sees, not just what is in
 * the DOM.
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

/**
 * Same as `mount`, but with `record: true` so the underlying wouter
 * `history` array can be read back to prove a click actually navigated —
 * `mount`'s plain `memoryLocation()` throws its history away.
 */
function mountRecording(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const { hook, history } = memoryLocation({ path, record: true });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <AppLayout>
          <div data-testid="page-body" />
        </AppLayout>
      </Router>
    </QueryClientProvider>,
  );
  return { history };
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

/** Which header surfaces show the review count at this width: the pill, the ribbon's Review tab. */
function countsShown(width: "phone" | "desktop"): string[] {
  const out: string[] = [];
  const pill = screen.queryByTestId("topnav-review-badge");
  if (pill && /\d/.test(pill.textContent ?? "") && shownAt(pill, width)) out.push("pill");
  const tab = screen.queryByTestId("topnav-review");
  if (tab && /\d/.test(tab.textContent ?? "") && shownAt(tab, width)) out.push("ribbon");
  return out;
}

/** Open the phone drawer the way a thumb does, and return the dialog. */
function openDrawer(): HTMLElement {
  fireEvent.click(screen.getByTestId("button-mobile-menu"));
  return screen.getByRole("dialog", { name: "Navigation" });
}

/** "Label href" for every link inside an element, in order. */
function linksIn(el: Element): string[] {
  return Array.from(el.querySelectorAll("a[href]")).map(
    (a) => `${a.textContent?.replace(/\d+$/, "").trim()} ${a.getAttribute("href")}`,
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

  it("the ribbon is desktop-only and the drawer trigger phone-only — what the phone tests below rely on", () => {
    mount("/settings");
    expect(shownAt(screen.getByTestId("topnav-review"), "phone")).toBe(false);
    expect(shownAt(screen.getByTestId("topnav-review"), "desktop")).toBe(true);
    expect(shownAt(screen.getByTestId("button-mobile-menu"), "phone")).toBe(true);
    expect(shownAt(screen.getByTestId("button-mobile-menu"), "desktop")).toBe(false);
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

describe("the phone drawer reaches every page a ribbon reaches", () => {
  // Every route any desktop ribbon links to, typed out by hand — NOT read from
  // layout.tsx — so a page dropped from the drawer's config fails here.
  const RIBBON_ROUTES = [
    "/banking",
    "/transactions",
    "/amex",
    "/budget",
    "/allowances",
    "/forecast/overview",
    "/forecast",
    "/bills",
    "/reports/spending",
    "/reports",
    "/review",
    "/avalanche",
    "/debts",
    "/reports/debt",
  ];

  it("the list above is exactly what the desktop ribbons link to", () => {
    // Walk one route inside each area (plus the no-area primary row) and read
    // the ribbons off the rendered DOM — so the hand-typed list can't go stale
    // either.
    const seen = new Set<string>();
    for (const path of [
      "/banking",
      "/forecast/overview",
      "/reports/spending",
      "/review",
      "/avalanche",
      "/settings",
    ]) {
      mount(path);
      for (const n of Array.from(document.querySelectorAll("[data-tabhref]"))) {
        seen.add(n.getAttribute("data-tabhref")!);
      }
      cleanup();
    }
    expect([...seen].sort()).toEqual([...RIBBON_ROUTES].sort());
  });

  it.each(["/settings", "/bills/all", "/banking", "/transactions"])(
    "opened on %s, the drawer links to every ribbon route",
    (from) => {
      mount(from);
      const drawer = openDrawer();
      const hrefs = Array.from(drawer.querySelectorAll("a[href]")).map((a) =>
        a.getAttribute("href"),
      );
      for (const route of RIBBON_ROUTES) expect(hrefs).toContain(route);
    },
  );

  it("lists the five destinations, each with its ribbon pages beneath it", () => {
    mount("/settings");
    const drawer = openDrawer();
    const tree = Array.from(
      drawer.querySelectorAll('[data-testid^="mobilenav-area-"]'),
    ).map(linksIn);
    // Each page appears once, under the destination that owns it. Home's
    // ribbon shortcuts (Chase, Amex, Budget, Allowance) sit under Review and
    // Spending — the areas whose ribbon shows when you open them.
    expect(tree).toEqual([
      ["Home /banking"],
      ["Forecast /forecast/overview", "Forecast /forecast", "Bills /bills"],
      [
        "Spending /reports/spending",
        "Budget /budget",
        "Allowances /allowances",
        "Reports /reports",
      ],
      ["Review /review", "Chase /transactions", "Amex /amex"],
      ["Debt /avalanche", "Debts /debts", "Debt report /reports/debt"],
    ]);
  });

  it("keeps Mapping rules and Settings under More, and lists no page twice", () => {
    mount("/settings");
    const drawer = openDrawer();
    const nav = drawer.querySelector("nav")!;
    const links = linksIn(nav);
    expect(links.slice(-2)).toEqual(["Mapping rules /mapping-rules", "Settings /settings"]);
    const hrefs = links.map((l) => l.split(" ").pop());
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("puts the review count on the drawer's Review row", () => {
    reviewCount = 4;
    mount("/banking");
    const drawer = openDrawer();
    const review = drawer.querySelector('[data-testid="mobilenav-review"]')!;
    expect(review.textContent).toContain("4");
  });
});

describe("R0 follow-up — the phone drawer closes after you navigate", () => {
  // ⚠️ `DrawerLink`'s `onClick={onNavigate}` (`layout.tsx`) is the ONLY thing
  // that sets `mobileOpen` back to false — wouter's own `<Link>` handles the
  // route change regardless (it attaches its own onClick unconditionally), so
  // removing that wiring leaves navigation working but the drawer stuck open
  // over the new page. Nothing else in this suite opens the drawer, clicks a
  // page link inside it, and checks the drawer afterwards, so that regression
  // passed review once already.
  it("clicking a page link inside the drawer closes it and changes the route", () => {
    const { history } = mountRecording("/banking");
    const drawer = openDrawer();

    fireEvent.click(within(drawer).getByTestId("mobilenav-budget"));

    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(history[history.length - 1]).toBe("/budget");
  });

  it("clicking a destination row itself (not a nested page) also closes the drawer", () => {
    const { history } = mountRecording("/banking");
    const drawer = openDrawer();

    fireEvent.click(within(drawer).getByTestId("mobilenav-forecast/overview"));

    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(history[history.length - 1]).toBe("/forecast/overview");
  });
});

describe("the drawer lights whole path segments only", () => {
  const lit = () =>
    Array.from(openDrawer().querySelectorAll('[aria-current="page"]')).map((a) =>
      a.getAttribute("href"),
    );

  it.each<[string, string[]]>([
    ["/bills", ["/bills"]],
    // A parent lights for its own child route…
    ["/bills/all", ["/bills"]],
    // …never for a path that only shares its first letters.
    ["/billsx", []],
    // The longest match wins: the Overview destination, not also /forecast.
    ["/forecast/overview", ["/forecast/overview"]],
    ["/forecast", ["/forecast"]],
    // Debt's report, not Spending's /reports hub.
    ["/reports/debt", ["/reports/debt"]],
    // No area on desktop, so nothing lights in the drawer either.
    ["/reports/cashflow", []],
    ["/transactions", ["/transactions"]],
    ["/settings", ["/settings"]],
    ["/settingsx", []],
  ])("on %s lights %j", (path, expected) => {
    mount(path);
    expect(lit()).toEqual(expected);
  });

  it("names the page on a phone by whole segments too", () => {
    mount("/bills/all");
    expect(screen.getByTestId("mobile-page-title").textContent).toBe("Bills");
    cleanup();
    mount("/settingsx");
    expect(screen.getByTestId("mobile-page-title").textContent).toBe("H2 Budget");
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

  // ⚠️ ONCE AT EACH WIDTH. On a desktop the ribbon's Review tab carries the
  // count whenever the ribbon has one, and the header pill only fills in where
  // it doesn't. A phone never sees the ribbon, so there the pill always shows.
  it.each<[string, string[], string[]]>([
    // Review's own ribbon.
    ["/review", ["pill"], ["ribbon"]],
    // Chase and Amex live in Review's ribbon now — the phone must still see it.
    ["/transactions", ["pill"], ["ribbon"]],
    ["/amex", ["pill"], ["ribbon"]],
    // The five-destination primary row carries Review too.
    ["/settings", ["pill"], ["ribbon"]],
    // No Review tab in the ribbon (Home, Forecast): the pill at both widths.
    ["/banking", ["pill"], ["pill"]],
    ["/bills/all", ["pill"], ["pill"]],
  ])("on %s the count shows once: phone %j, desktop %j", (path, phone, desktop) => {
    reviewCount = 4;
    mount(path);
    expect(countsShown("phone")).toEqual(phone);
    expect(countsShown("desktop")).toEqual(desktop);
  });

  it("the phone pill is a real way into Review", () => {
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
      expect(screen.getByTestId("topnav-review").textContent).toBe("Review");
      expect(screen.queryByTestId("topnav-review-badge")).toBeNull();
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

  it("warms from the phone drawer too", () => {
    mount("/settings");
    const drawer = openDrawer();
    fireEvent.mouseEnter(drawer.querySelector('[data-testid="mobilenav-budget"]')!);
    expect(prefetchRoute).toHaveBeenCalledWith("/budget");
  });
});
