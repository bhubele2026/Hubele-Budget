import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Menu, MessageCircleQuestion } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getDashboard,
  getGetDashboardQueryKey,
  getForecast,
  getGetForecastQueryKey,
  getForecastCashSignal,
  getGetForecastCashSignalQueryKey,
  getAmexWeeklyPayoff,
  getGetAmexWeeklyPayoffQueryKey,
  getBillsSummary,
  getGetBillsSummaryQueryKey,
  listDebts,
  getListDebtsQueryKey,
  listTransactions,
  getListTransactionsQueryKey,
  getBudgetMonth,
  getGetBudgetMonthQueryKey,
  listCategories,
  getListCategoriesQueryKey,
} from "@workspace/api-client-react";
import { prefetchRoute } from "@/lib/routePrefetch";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { useCategorizationQueueTotal } from "@/hooks/useCategorizationQueue";
import { badgeCount } from "@/lib/reviewQueue";
import { H2Wordmark } from "@/components/h2-wordmark";
import { TabRibbon, TabUnderline, type RibbonTab } from "@/components/tab-ribbon";
import { AccountMenu, VERSION_LABEL } from "@/components/account-menu";
// (C12) The tab LIST only — never `settingsTabs.ts`, whose lazy importers
// would ride the landing chunk with it.
import { SETTINGS_TABS, tabHref, tabOf, type SettingsTab } from "@/pages/settings/settingsTabList";

/**
 * ⚠️ LABELS ONLY. A `NavItem` used to carry a lucide icon, which repeated the
 * word next to it on a row where every word is one syllable. The area model
 * below is otherwise UNCHANGED — this pass is chrome, not information
 * architecture.
 */
type NavItem = {
  name: string;
  href: string;
  /** Test-id suffix when the href cannot be one (a query string). */
  testId?: string;
};

/**
 * A route an area owns: the path itself AND its own child routes (`/bills`
 * owns `/bills/all`, never `/billsx`). `exact` stops at the path itself.
 */
type OwnedRoute = { path: string; exact?: boolean };

/**
 * ⭐ ONE CONFIG, BOTH SURFACES. A destination is its primary link, the ribbon
 * that shows while you are inside it, and the routes that count as inside it.
 * The desktop ribbon AND the phone drawer are both drawn from `DESTINATIONS`,
 * so a page added to an area's ribbon lands in the drawer in the same edit —
 * the two cannot drift.
 *
 * ⚠️ WHY THIS MATTERS: the ribbon is desktop-only (`hidden md:flex`). When the
 * drawer carried only the primary row and More, every page that lived only in
 * a ribbon (Budget, Bills, Debts, …) had no way in on a phone.
 */
type Destination = NavItem & {
  /** The ribbon across the top while you are inside this area, left to right. */
  tabs: NavItem[];
  /** The routes that ARE this area: visiting one shows this area's ribbon. */
  owns: OwnedRoute[];
};

// ⭐ R0 — FIVE DESTINATIONS (owner-approved redesign). The primary row is no
// longer "Home (the landing) plus the four areas" — the landing (/home) is
// reached only via the wordmark now. These five ARE the app: Home (still the
// Banking page, redesigned later in R3), Forecast, Spending, Review, Debt.
// Settings is secondary — demoted to the end of More, same as every unmapped
// page. Order here is the primary row's order and the drawer's order.
const DESTINATIONS: Destination[] = [
  {
    // "Home" is a LABEL change only — the route is still /banking (Home gets
    // its own redesign in R3; R0 is nav-only).
    name: "Home",
    href: "/banking",
    // The existing Banking tabs, UNCHANGED by this redesign. No "More" inside
    // an area: while you're in Home you stay in Home; the way out is the
    // wordmark → the /home landing.
    tabs: [
      { name: "Overview", href: "/banking" },
      { name: "Chase", href: "/transactions" },
      { name: "Amex", href: "/amex" },
      // (C12) The all-accounts preview sits BESIDE Chase and Amex — it
      // replaces neither until the owner says so.
      { name: "Accounts", href: "/next/accounts" },
      { name: "Budget", href: "/budget" },
      { name: "Allowance", href: "/allowances" },
    ],
    // ⚠️ Only /banking (and the Accounts preview) are the Home AREA. Chase,
    // Amex, Budget and Allowance are one click away from Home's ribbon, but
    // visiting those routes directly shows the ribbon of the area that owns
    // them (Review, Spending).
    owns: [{ path: "/banking" }, { path: "/next/accounts" }],
  },
  {
    // The primary link lands on the section's Overview tab (Bills precedent).
    name: "Forecast",
    href: "/forecast/overview",
    // Overview, the cash-flow curve itself, and Bills — bills and income live
    // inside Forecast now (owner's ask). One "Bills" tab covers both /bills
    // (Overview) and /bills/all (the full list): the longest-match below
    // lights it for both, so there is no separate entry for /bills/all.
    tabs: [
      { name: "Overview", href: "/forecast/overview" },
      { name: "Forecast", href: "/forecast" },
      { name: "Bills", href: "/bills" },
    ],
    owns: [{ path: "/forecast" }, { path: "/bills" }],
  },
  {
    // Spending borrows the Reports → Spending page until R2 builds its own.
    name: "Spending",
    href: "/reports/spending",
    tabs: [
      { name: "Spending", href: "/reports/spending" },
      { name: "Budget", href: "/budget" },
      { name: "Allowances", href: "/allowances" },
      { name: "Wish list", href: "/wishlist" },
      { name: "Reports", href: "/reports" },
    ],
    // The Reports hub is an EXACT match only — its own subpages
    // (/reports/debt, /reports/spending, /reports/cashflow, …) are each owned
    // individually (by Debt, by Spending, or left unmapped).
    owns: [
      { path: "/reports/spending" },
      { path: "/budget" },
      { path: "/allowances" },
      { path: "/wishlist" },
      { path: "/reports", exact: true },
    ],
  },
  {
    // The review queue plus the two account ledgers where review work
    // actually happens.
    name: "Review",
    href: "/review",
    tabs: [
      { name: "Review", href: "/review" },
      { name: "Categories", href: "/review/categories" },
      // (C12) What Ask suggested and has not changed (F8).
      { name: "Suggestions", href: "/review/suggestions" },
      { name: "Chase", href: "/transactions" },
      { name: "Amex", href: "/amex" },
    ],
    owns: [{ path: "/review" }, { path: "/transactions" }, { path: "/amex" }],
  },
  {
    // Route + testids stay /avalanche; the label is "Debt". The payoff plan,
    // the debts list, and the debt report.
    name: "Debt",
    href: "/avalanche",
    tabs: [
      { name: "Debt", href: "/avalanche" },
      { name: "Debts", href: "/debts" },
      { name: "Debt report", href: "/reports/debt" },
    ],
    owns: [{ path: "/avalanche" }, { path: "/debts" }, { path: "/reports/debt" }],
  },
];

const PRIMARY_NAV: NavItem[] = DESTINATIONS.map(({ name, href }) => ({ name, href }));

// Secondary destinations, demoted into the More dropdown — the only pages
// left with no area to call home.
const MORE_NAV: NavItem[] = [
  { name: "Mapping rules", href: "/mapping-rules" },
  { name: "Settings", href: "/settings" },
];

const ALL_NAV = [...PRIMARY_NAV, ...MORE_NAV];

/**
 * (C12) Settings' sub-pages, listed beneath Settings in the drawer and in More.
 * They are the page's own tabs (`settingsTabs.ts`, the one list), minus Banks:
 * Banks is plain `/settings`, which the Settings row itself already opens.
 */
const SETTINGS_PAGES: (NavItem & { tab: SettingsTab })[] = SETTINGS_TABS.filter((t) => t.key !== "banks").map(
  (t) => ({ name: t.label, href: tabHref(t.key), testId: `settings-${t.key}`, tab: t.key }),
);



/**
 * Whole path segments only: `/bills` covers `/bills` and its own child routes
 * (`/bills/all`), never a path that merely starts with the same letters
 * (`/billsx`).
 */
function isAtOrUnder(location: string, path: string): boolean {
  return location === path || location.startsWith(path + "/");
}

/**
 * Boundary-aware, longest-match active href — so /bills and /bills/all never
 * light two rows, and /forecast/overview never also lights /forecast (a raw
 * startsWith would do both).
 */
function longestMatch(location: string, hrefs: readonly string[]): string | null {
  return (
    hrefs
      .filter((h) => isAtOrUnder(location, h))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/**
 * The destination whose area `location` is inside, or null (Settings, Mapping
 * rules, the unmapped reports, the landing).
 */
function destinationFor(location: string): Destination | null {
  return (
    DESTINATIONS.find((d) =>
      d.owns.some((r) => (r.exact ? location === r.path : isAtOrUnder(location, r.path))),
    ) ?? null
  );
}

/** The Settings sub-page open at this URL, or null (not Settings, or Banks). */
function openSettingsSub(location: string, search: string): SettingsTab | null {
  if (location !== "/settings") return null;
  const tab = tabOf(search);
  return tab === "banks" ? null : tab;
}

/**
 * The pages the phone drawer lists beneath a destination: its ribbon tabs,
 * minus the tab that IS the destination (the destination's own row already
 * goes there) and minus shortcuts into another area. Home's ribbon carries
 * Chase, Amex, Budget and Allowance; they are listed once, under Review and
 * Spending, the areas that own them — so the same page never lights twice. A
 * tab whose route no area owns stays with the ribbon that carries it, so
 * nothing on a ribbon can fall out of the drawer.
 */
function drawerPages(d: Destination): NavItem[] {
  return d.tabs.filter((t) => {
    if (t.href === d.href) return false;
    const owner = destinationFor(t.href);
    return owner === null || owner === d;
  });
}

/**
 * ⭐ THE WORDMARK IS THE WAY HOME — the dashboard/Housing shell rule. There is
 * no back button and no "Home" breadcrumb inside an area, because a shell that
 * has both a brand and a home control has two answers to one question. Click
 * the mark, you are on the landing.
 */
function HomeMark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/home"
      aria-label="H2 Budget — go to home"
      data-testid="brand-home"
      onClick={onNavigate}
      className="press flex flex-none items-center rounded-control px-2 py-1.5 hover:bg-chrome-press"
    >
      <H2Wordmark tone="white" size={24} data-testid="h2-wordmark" />
    </Link>
  );
}

function DrawerLink({
  item,
  nested = false,
  active,
  inArea = false,
  badge,
  onNavigate,
  onPrefetch,
}: {
  item: NavItem;
  /** A page beneath a destination, not a destination row. */
  nested?: boolean;
  active: boolean;
  /** The destination you are inside while one of its pages is the lit row. */
  inArea?: boolean;
  badge: number | null;
  onNavigate: () => void;
  onPrefetch: (href: string) => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      onMouseEnter={() => onPrefetch(item.href)}
      onFocus={() => onPrefetch(item.href)}
      aria-current={active ? "page" : undefined}
      data-testid={`mobilenav-${item.testId ?? item.href.slice(1)}`}
      className={cn(
        "press relative flex items-center gap-3 rounded-control",
        nested ? "py-1.5 pl-7 pr-3 text-label" : "px-3 py-2 text-body",
        active
          ? "bg-chrome-press font-semibold text-chrome-ink"
          : inArea
            ? "font-semibold text-chrome-ink hover:bg-chrome-hover"
            : "text-chrome-ink-3 hover:bg-chrome-hover hover:text-chrome-ink",
      )}
    >
      {/* The vertical analogue of the ribbon's underline — same accent, same
          meaning: this is where you are. */}
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-brand-orange"
        />
      )}
      <span className="flex-1">{item.name}</span>
      {badge !== null && (
        <span className="rounded-full bg-brand-orange/20 px-1.5 py-0.5 font-mono text-micro leading-none tabular-nums text-brand-orange">
          {badge}
        </span>
      )}
    </Link>
  );
}

function MobileNav({
  location,
  search,
  onNavigate,
  railBadge,
  onPrefetch,
}: {
  location: string;
  /** The query string: on `/settings` it says which Settings sub-page is open. */
  search: string;
  onNavigate: () => void;
  railBadge: (href: string) => number | null;
  onPrefetch: (href: string) => void;
}) {
  const area = destinationFor(location);
  // On a Settings sub-page that sub-page is the lit row, and Settings reads as
  // the place you are inside (like a destination over its pages).
  const settingsSub = openSettingsSub(location, search);
  // ⚠️ THE DRAWER LIGHTS WHAT THE RIBBON LIGHTS. Only rows inside the area you
  // are in can be lit (More's rows, when you are in no area), and of those only
  // the longest whole-segment match. So /bills/all lights Bills, /billsx lights
  // nothing, and /reports/cashflow (no area on desktop either) does not light
  // Spending's Reports hub.
  const activeHref = longestMatch(
    location,
    area
      ? [area.href, ...drawerPages(area).map((p) => p.href)]
      : MORE_NAV.map((m) => m.href),
  );
  const row = { onNavigate, onPrefetch };
  // (C12) Open with the lit row in view: the drawer is taller than a phone
  // now (Settings' sub-pages sit at the bottom), and a lit row you have to
  // scroll to find says nothing.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, []);
  const groupLabel =
    "px-2 pb-1.5 text-micro font-semibold uppercase tracking-wide text-chrome-ink-4";
  return (
    <div className="flex h-full flex-col bg-brand-navy text-chrome-ink">
      <div className="flex h-14 items-center border-b border-chrome-rule px-3">
        <HomeMark onNavigate={onNavigate} />
      </div>
      <nav ref={navRef} aria-label="Sections" className="flex-1 space-y-5 overflow-y-auto p-3">
        {/* The five destinations, each with its ribbon pages beneath it —
            every page a desktop ribbon reaches is reachable here too. */}
        <div>
          <div className={groupLabel}>Areas</div>
          <ul className="space-y-1">
            {DESTINATIONS.map((d) => {
              const pages = drawerPages(d);
              return (
                <li key={d.href} data-testid={`mobilenav-area-${d.name.toLowerCase()}`}>
                  <DrawerLink
                    item={d}
                    active={activeHref === d.href}
                    inArea={area === d}
                    badge={railBadge(d.href)}
                    {...row}
                  />
                  {pages.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {pages.map((p) => (
                        <li key={p.href}>
                          <DrawerLink
                            item={p}
                            nested
                            active={activeHref === p.href}
                            badge={railBadge(p.href)}
                            {...row}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <div className={groupLabel}>More</div>
          <ul className="space-y-0.5">
            {MORE_NAV.map((m) => (
              <li key={m.href}>
                <DrawerLink
                  item={m}
                  active={activeHref === m.href && settingsSub == null}
                  inArea={m.href === "/settings" && settingsSub != null}
                  badge={railBadge(m.href)}
                  {...row}
                />
                {/* (C12) Settings' sub-pages beneath it, as a destination's
                    pages sit beneath it above. */}
                {m.href === "/settings" && (
                  <ul className="mt-0.5 space-y-0.5" data-testid="mobilenav-settings-pages">
                    {SETTINGS_PAGES.map((p) => (
                      <li key={p.href}>
                        <DrawerLink
                          item={p}
                          nested
                          active={settingsSub === p.tab}
                          badge={null}
                          onNavigate={onNavigate}
                          // A sub-page warms the Settings chunk; its own lazy
                          // tab chunk warms from the page's tab bar (warming it
                          // here would put the tab importers on the landing).
                          onPrefetch={() => onPrefetch("/settings")}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="flex items-center justify-between gap-3 border-t border-chrome-rule p-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-label font-medium text-chrome-ink-2">Account</span>
          {/* (C12) LND-09: the build, also the last item of the account menu. */}
          <span data-testid="drawer-version" className="truncate font-mono text-micro tabular-nums text-chrome-ink-4">
            {VERSION_LABEL}
          </span>
        </div>
        <AccountMenu />
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  // Which of the five areas this route is inside — its ribbon shows across the
  // top. Outside every area (Settings, Mapping rules, the unmapped reports) the
  // ribbon is the five destinations themselves.
  const area = destinationFor(location);
  const areaNav = area ? area.tabs : PRIMARY_NAV;
  const activeNavHref = longestMatch(
    location,
    areaNav.map((a) => a.href),
  );
  // The active tab's own label makes the best mobile page title — it covers
  // every mapped route, area sub-pages included, not just the five primary
  // destinations and More.
  const activeTabLabel = areaNav.find((a) => a.href === activeNavHref)?.name;
  // More lists everything NOT already in the current ribbon — no duplicates,
  // and it carries the other areas so you can jump between them from here too.
  const ribbonHrefs = new Set(areaNav.map((a) => a.href));
  const moreNav = ALL_NAV.filter((item) => !ribbonHrefs.has(item.href));
  const [mobileOpen, setMobileOpen] = useState(false);
  // (F1) Two different queues feed the Review badge: the forecast bank-match
  // inbox (the spine's count) and the categorization queue. `null` = unknown.
  const forecastReview = useReviewInboxCount();
  const queueTotal = useCategorizationQueueTotal();
  const reviewCount = forecastReview == null ? null : badgeCount(queueTotal, forecastReview);

  // (#perf-4) Warm a route's primary, stable-key queries on nav hover/focus so
  // the page renders from cache on click. Only routes whose query keys are
  // deterministic (no per-page range/limit params) are prefetched; staleTime
  // defaults still gate any actual network call.
  const qc = useQueryClient();
  const prefetch = (href: string) => {
    // Also warm the route's JS chunk (lib/routePrefetch) — the query cache is
    // useless if the page's code hasn't streamed in yet.
    prefetchRoute(href);
    // Then warm that route's ONE primary query so the page renders from cache
    // on click (stale-while-revalidate; staleTime defaults still gate the
    // actual network call). Params mirror exactly what each page requests so
    // the warmed key is the key the page reads.
    if (href === "/banking") {
      qc.prefetchQuery({ queryKey: getGetDashboardQueryKey(), queryFn: () => getDashboard() });
      qc.prefetchQuery({
        queryKey: getGetForecastQueryKey({ days: 90 }),
        queryFn: () => getForecast({ days: 90 }),
      });
    } else if (href === "/amex") {
      qc.prefetchQuery({
        queryKey: getGetAmexWeeklyPayoffQueryKey(),
        queryFn: () => getAmexWeeklyPayoff(),
      });
    } else if (href === "/bills") {
      qc.prefetchQuery({
        queryKey: getGetBillsSummaryQueryKey(),
        queryFn: () => getBillsSummary(),
      });
    } else if (
      href === "/forecast/overview" ||
      href === "/forecast" ||
      // Review renders the same ForecastPage in a different mode, reading
      // the identical bundle — so it warms the same way.
      href === "/review"
    ) {
      qc.prefetchQuery({
        queryKey: getGetForecastQueryKey({ days: 90 }),
        queryFn: () => getForecast({ days: 90 }),
      });
      qc.prefetchQuery({
        queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
        queryFn: () => getForecastCashSignal({ horizonDays: 90 }),
      });
    } else if (href === "/avalanche" || href === "/debts") {
      qc.prefetchQuery({
        queryKey: getListDebtsQueryKey(),
        queryFn: () => listDebts(),
      });
    } else if (href === "/transactions") {
      // Same generous window + cap the Chase ledger requests (2y back → 1y ahead).
      const now = new Date();
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`;
      const params = {
        from: iso(new Date(now.getFullYear() - 2, now.getMonth(), 1)),
        to: iso(new Date(now.getFullYear() + 1, now.getMonth() + 1, 0)),
        limit: 1000,
      };
      qc.prefetchQuery({
        queryKey: getListTransactionsQueryKey(params),
        queryFn: () => listTransactions(params),
      });
    } else if (href === "/budget") {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      qc.prefetchQuery({
        queryKey: getGetBudgetMonthQueryKey(month),
        queryFn: () => getBudgetMonth(month),
      });
      qc.prefetchQuery({
        queryKey: getListCategoriesQueryKey(),
        queryFn: () => listCategories(),
      });
    }
  };

  // (#perf) After first paint, warm the five destinations' chunks on idle so
  // the very first click into each area is instant even without a prior hover.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const warm = () => {
      for (const { href } of DESTINATIONS) {
        prefetchRoute(href);
      }
    };
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback;
    if (typeof ric === "function") {
      ric(warm);
      return;
    }
    const t = setTimeout(warm, 1500);
    return () => clearTimeout(t);
  }, []);

  // A null count is unknown (the spine is loading or failed): no badge, never 0.
  const railBadge = (href: string): number | null => {
    // Inside the Review area the two queues have their own tabs; everywhere
    // else the Review destination carries the total.
    if (href === "/review/categories") return queueTotal != null && queueTotal > 0 ? queueTotal : null;
    if (href === "/review") {
      const own = area?.name === "Review" ? forecastReview : reviewCount;
      return own != null && own > 0 ? own : null;
    }
    return null;
  };

  const ribbonTabs: RibbonTab[] = areaNav.map((item) => ({
    href: item.href,
    label: item.name,
    count: railBadge(item.href),
  }));

  // Is any secondary (More) destination the current page — so the collapsed
  // More trigger carries the underline. (C12: the orange "pending" dot is
  // gone. Nothing in More ever had a count, so it could never light.)
  const moreActive = moreNav.some((n) => isAtOrUnder(location, n.href));
  const settingsSub = openSettingsSub(location, search);

  const currentTitle =
    activeTabLabel ??
    ALL_NAV.find((n) => isAtOrUnder(location, n.href))?.name ??
    "H2 Budget";

  // More is hidden inside an area: there the ribbon is that section's tabs
  // only, and you leave via the wordmark → Home.
  const showMore = area === null;

  // ⚠️ THE COUNT SHOWS ONCE — AT EACH SCREEN SIZE. When the ribbon carries the
  // Review tab (the Review area, or the five-destination primary row), that
  // tab's badge IS the count on a desktop, and a second copy on the right would
  // be the same finding claimed twice — two badges reading "3" look like six
  // things. But the ribbon is desktop-only (`hidden md:flex`): on a phone this
  // pill is the only count in the header, so it stays there (`md:hidden`)
  // rather than disappearing with the ribbon it was deferring to.
  const hasReviewCount = reviewCount != null && reviewCount > 0;
  const reviewPillPhoneOnly = ribbonHrefs.has("/review");
  // The pill goes where the work is: the forecast inbox when it has charges,
  // else the categorization queue.
  const reviewPillHref = forecastReview != null && forecastReview > 0 ? "/review" : "/review/categories";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* (The switch, 2026-10-09) The "Modernization preview" top line (SH-01)
          is gone: this app is served at `/` and IS the current app. */}
      {/* ── The navy rail: wordmark home control · area ribbon · account.
          (C11) Shown on every page, the landing included: /home is the
          dashboard now, not a door with its own hero. ───────────────────── */}
      <header
          data-testid="app-header"
          className="sticky top-0 z-30 shrink-0 bg-brand-navy text-chrome-ink inset-shadow-chrome-edge"
        >
          <div className="flex h-12 items-center gap-1 pl-1 pr-2 md:pl-3 md:pr-4">
            {/* Mobile: the drawer trigger sits before the mark. */}
            <div className="md:hidden">
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-chrome-ink hover:bg-chrome-press hover:text-chrome-ink"
                    aria-label="Open navigation menu"
                    data-testid="button-mobile-menu"
                  >
                    <Menu className="h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="left"
                  className="flex w-72 flex-col border-0 p-0"
                  aria-describedby={undefined}
                >
                  {/* The dialog's accessible name; the drawer's own chrome is
                      the wordmark, so the title is for screen readers only. */}
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                  <MobileNav
                    location={location}
                    search={search}
                    onNavigate={() => setMobileOpen(false)}
                    railBadge={railBadge}
                    onPrefetch={prefetch}
                  />
                </SheetContent>
              </Sheet>
            </div>

            <HomeMark />

            {/* A hairline between the mark and the ribbon: the mark is a
                control, not the first tab. */}
            <span aria-hidden className="mx-1 hidden h-5 w-px bg-chrome-rule md:block" />

            <div className="hidden min-w-0 flex-1 md:flex">
              <TabRibbon
                tabs={ribbonTabs}
                activeHref={activeNavHref}
                onPrefetch={prefetch}
                ariaLabel="Sections"
                trailing={
                  showMore ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "press relative flex items-center whitespace-nowrap px-3.5 text-label font-semibold outline-none",
                            moreActive
                              ? "text-chrome-ink"
                              : "text-chrome-ink-3 hover:text-chrome-ink-hover",
                          )}
                          data-testid="topnav-more"
                          aria-label="More destinations"
                        >
                          More
                          {moreActive && <TabUnderline />}
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {moreNav.map((item) => {
                          const badge = railBadge(item.href);
                          // The page you are on reads as current here too; on
                          // a Settings sub-page that is the sub-page.
                          const current =
                            isAtOrUnder(location, item.href) && !(item.href === "/settings" && settingsSub != null);
                          return (
                            <Fragment key={item.href}>
                              <DropdownMenuItem asChild>
                                <Link
                                  href={item.href}
                                  onMouseEnter={() => prefetch(item.href)}
                                  onFocus={() => prefetch(item.href)}
                                  aria-current={current ? "page" : undefined}
                                  className="flex cursor-pointer items-center gap-2.5 aria-[current=page]:font-semibold aria-[current=page]:text-brand-navy"
                                  data-testid={`morenav-${item.href.slice(1)}`}
                                >
                                  <span className="flex-1">{item.name}</span>
                                  {badge !== null && (
                                    <span className="rounded-full bg-brand-orange/15 px-1.5 py-0.5 font-mono text-micro leading-none tabular-nums text-brand-orange">
                                      {badge}
                                    </span>
                                  )}
                                </Link>
                              </DropdownMenuItem>
                              {/* (C12) Settings' sub-pages, indented beneath it. */}
                              {item.href === "/settings" &&
                                SETTINGS_PAGES.map((p) => (
                                  <DropdownMenuItem key={p.href} asChild>
                                    <Link
                                      href={p.href}
                                      onMouseEnter={() => prefetch("/settings")}
                                      onFocus={() => prefetch("/settings")}
                                      aria-current={settingsSub === p.tab ? "page" : undefined}
                                      className="cursor-pointer pl-6 text-label text-muted-foreground aria-[current=page]:font-semibold aria-[current=page]:text-brand-navy"
                                      data-testid={`morenav-${p.testId}`}
                                    >
                                      {p.name}
                                    </Link>
                                  </DropdownMenuItem>
                                ))}
                            </Fragment>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : undefined
                }
              />
            </div>

            <div className="ml-auto flex flex-none items-center gap-1.5">
              {/* Mobile shows the current page name between the mark and the
                  account button. */}
              <span
                data-testid="mobile-page-title"
                className="mr-1 max-w-[34vw] truncate text-label font-semibold md:hidden"
              >
                {currentTitle}
              </span>
              {hasReviewCount && (
                <Link
                  href={reviewPillHref}
                  onMouseEnter={() => prefetch(reviewPillHref)}
                  onFocus={() => prefetch(reviewPillHref)}
                  aria-label={`${reviewCount} items to review`}
                  data-testid="topnav-review-badge"
                  className={cn(
                    "press flex items-center gap-1.5 rounded-control px-2 py-1 text-micro font-semibold text-chrome-ink-2 hover:bg-chrome-press hover:text-chrome-ink",
                    reviewPillPhoneOnly && "md:hidden",
                  )}
                >
                  <span className="hidden sm:inline">Review</span>
                  <span className="rounded-full bg-brand-orange/20 px-1.5 py-0.5 font-mono leading-none tabular-nums text-brand-orange">
                    {reviewCount}
                  </span>
                </Link>
              )}
              {/* (F8) The Ask launcher: a plain link, on every page with the
                  header. The page itself says when AI is off (the header
                  reads no AI state, so it stays off the features client). */}
              <Link
                href="/ask"
                data-testid="header-ask"
                aria-label="Ask H2"
                aria-current={location === "/ask" ? "page" : undefined}
                onMouseEnter={() => prefetch("/ask")}
                onFocus={() => prefetch("/ask")}
                className="press flex items-center gap-1.5 rounded-control px-2 py-1 text-micro font-semibold text-chrome-ink-2 hover:bg-chrome-press hover:text-chrome-ink aria-[current=page]:bg-chrome-press aria-[current=page]:text-chrome-ink"
              >
                <MessageCircleQuestion className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">Ask</span>
              </Link>
              <AccountMenu />
            </div>
          </div>
      </header>

      {/* ── Body: single full-width content column. ─────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* ⚠️ THE ONLY VERTICAL SCROLLER inside the shell (index.css, the
            `html` note). `data-shell-scroller` is how code finds it
            (`shellScrollerOf`, `lib/shellScroll.ts`); `.shell-scroller`
            reserves its gutter. */}
        <main
          data-shell-scroller=""
          className="shell-scroller min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          {/* ⚠️ KEYED ON LOCATION so EVERY client-side navigation re-runs the
              entrance — without the key this animates once on layout mount and
              never again. `.page-in` puts the timing on the kit's dials
              (`--dur-page` × `--ease-out`), so the whole app's page swap moves
              when the dial moves, and the reduced-motion block zeroes it. */}
          {/* `.shell-pad` is p-3 md:p-5, read from --shell-pad-x/-y so the
              pages' sticky heads bleed by the same numbers. */}
          <div key={location} className="page-in shell-pad mx-auto max-w-[1600px]">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
