import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { UserButton } from "@clerk/react";
import { Menu } from "lucide-react";
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
import { H2Wordmark } from "@/components/h2-wordmark";
import { TabRibbon, type RibbonTab } from "@/components/tab-ribbon";

/**
 * ⚠️ LABELS ONLY. A `NavItem` used to carry a lucide icon, which repeated the
 * word next to it on a row where every word is one syllable. The area model
 * below is otherwise UNCHANGED — this pass is chrome, not information
 * architecture.
 */
type NavItem = { name: string; href: string };

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
      { name: "Budget", href: "/budget" },
      { name: "Allowance", href: "/allowances" },
    ],
    // ⚠️ Only /banking itself is the Home AREA. Chase, Amex, Budget and
    // Allowance are one click away from Home's ribbon, but visiting those
    // routes directly shows the ribbon of the area that owns them (Review,
    // Spending).
    owns: [{ path: "/banking" }],
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
      { name: "Reports", href: "/reports" },
    ],
    // The Reports hub is an EXACT match only — its own subpages
    // (/reports/debt, /reports/spending, /reports/cashflow, …) are each owned
    // individually (by Debt, by Spending, or left unmapped).
    owns: [
      { path: "/reports/spending" },
      { path: "/budget" },
      { path: "/allowances" },
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
      className="press flex flex-none items-center rounded-control px-2 py-1.5 hover:bg-white/10"
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
      data-testid={`mobilenav-${item.href.slice(1)}`}
      className={cn(
        "press relative flex items-center gap-3 rounded-control",
        nested ? "py-1.5 pl-7 pr-3 text-label" : "px-3 py-2 text-body",
        active
          ? "bg-white/10 font-semibold text-white"
          : inArea
            ? "font-semibold text-white hover:bg-white/5"
            : "text-white/60 hover:bg-white/5 hover:text-white",
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
  onNavigate,
  railBadge,
  onPrefetch,
}: {
  location: string;
  onNavigate: () => void;
  railBadge: (href: string) => number | null;
  onPrefetch: (href: string) => void;
}) {
  const area = destinationFor(location);
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
  const groupLabel =
    "px-2 pb-1.5 text-micro font-semibold uppercase tracking-wide text-white/40";
  return (
    <div className="flex h-full flex-col bg-brand-navy text-white">
      <div className="flex h-14 items-center border-b border-white/10 px-3">
        <HomeMark onNavigate={onNavigate} />
      </div>
      <nav aria-label="Sections" className="flex-1 space-y-5 overflow-y-auto p-3">
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
                  active={activeHref === m.href}
                  badge={railBadge(m.href)}
                  {...row}
                />
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="flex items-center justify-between border-t border-white/10 p-4">
        <span className="text-label font-medium text-white/70">Account</span>
        <UserButton />
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
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
  const reviewCount = useReviewInboxCount();

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
    if (href === "/home" || href === "/banking") {
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
    if (href === "/review" && reviewCount != null && reviewCount > 0) return reviewCount;
    return null;
  };

  const ribbonTabs: RibbonTab[] = areaNav.map((item) => ({
    href: item.href,
    label: item.name,
    count: railBadge(item.href),
  }));

  // Is any secondary (More) destination the current page, and do any of them
  // carry a pending badge — so the collapsed More trigger can signal both.
  const moreActive = moreNav.some((n) => isAtOrUnder(location, n.href));
  const moreBadgeTotal = moreNav.reduce(
    (sum, n) => sum + (railBadge(n.href) ?? 0),
    0,
  );

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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* ── The navy rail: wordmark home control · area ribbon · account.
          Hidden on the landing (/home) — there the tiles ARE the navigation
          and the hero carries its own mark. ────────────────────────────── */}
      {location !== "/home" && (
        <header
          data-testid="app-header"
          className="sticky top-0 z-30 shrink-0 bg-brand-navy text-white shadow-[inset_0_-1px_0_rgb(255_255_255/0.12)]"
        >
          <div className="flex h-12 items-center gap-1 pl-1 pr-2 md:pl-3 md:pr-4">
            {/* Mobile: the drawer trigger sits before the mark. */}
            <div className="md:hidden">
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-white hover:bg-white/10 hover:text-white"
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
            <span aria-hidden className="mx-1 hidden h-5 w-px bg-white/15 md:block" />

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
                              ? "text-white"
                              : "text-white/60 hover:text-white/90",
                          )}
                          data-testid="topnav-more"
                          aria-label="More destinations"
                        >
                          More
                          {moreBadgeTotal > 0 && (
                            <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-brand-orange" />
                          )}
                          {moreActive && (
                            <span
                              aria-hidden
                              className="tab-underline pointer-events-none absolute inset-x-2.5 bottom-0 h-[3px] rounded-t-full bg-brand-orange shadow-[0_0_10px_rgba(246,141,46,0.55)]"
                            />
                          )}
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {moreNav.map((item) => {
                          const badge = railBadge(item.href);
                          return (
                            <DropdownMenuItem key={item.href} asChild>
                              <Link
                                href={item.href}
                                onMouseEnter={() => prefetch(item.href)}
                                onFocus={() => prefetch(item.href)}
                                className="flex cursor-pointer items-center gap-2.5"
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
                  href="/review"
                  onMouseEnter={() => prefetch("/review")}
                  onFocus={() => prefetch("/review")}
                  aria-label={`${reviewCount} items to review`}
                  data-testid="topnav-review-badge"
                  className={cn(
                    "press flex items-center gap-1.5 rounded-control px-2 py-1 text-micro font-semibold text-white/70 hover:bg-white/10 hover:text-white",
                    reviewPillPhoneOnly && "md:hidden",
                  )}
                >
                  <span className="hidden sm:inline">Review</span>
                  <span className="rounded-full bg-brand-orange/20 px-1.5 py-0.5 font-mono leading-none tabular-nums text-brand-orange">
                    {reviewCount}
                  </span>
                </Link>
              )}
              <UserButton />
            </div>
          </div>
        </header>
      )}

      {/* ── Body: single full-width content column. ─────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {/* ⚠️ KEYED ON LOCATION so EVERY client-side navigation re-runs the
              entrance — without the key this animates once on layout mount and
              never again. `.page-in` puts the timing on the kit's dials
              (`--dur-page` × `--ease-out`), so the whole app's page swap moves
              when the dial moves, and the reduced-motion block zeroes it. */}
          {location === "/home" ? (
            // Landing renders full-bleed — it centers its own cards.
            <div key={location} className="page-in">
              {children}
            </div>
          ) : (
            <div key={location} className="page-in mx-auto max-w-[1600px] p-3 md:p-5">
              {children}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
