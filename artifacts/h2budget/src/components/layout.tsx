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
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
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

// One primary row — Home (the landing) plus the four areas. Everything
// else is one click away in the More overflow, so nothing is lost.
const PRIMARY_NAV: NavItem[] = [
  { name: "Home", href: "/home" },
  { name: "Banking", href: "/banking" },
  { name: "Bills", href: "/bills" },
  // Forecast primary link lands on the section's Overview tab (Bills precedent).
  { name: "Forecast", href: "/forecast/overview" },
  // Route + testids stay /avalanche; only the display label is "Future Goal".
  { name: "Future Goal", href: "/avalanche" },
];

// Secondary destinations, demoted into the More dropdown. Every route stays
// reachable — just one extra click. (Chase/Amex/Allowance live inside Banking;
// Budget inside Forecast; these entries are the direct shortcuts.)
const MORE_NAV: NavItem[] = [
  { name: "Chase", href: "/transactions" },
  { name: "Amex", href: "/amex" },
  { name: "Allowance", href: "/allowances" },
  { name: "Budget", href: "/budget" },
  { name: "Reports", href: "/reports" },
  { name: "Debts", href: "/debts" },
  // Review now lives in the Forecast ribbon (FORECAST_SUBNAV), not here.
  { name: "Settings", href: "/settings" },
];

// Inside the Banking area, the top ribbon becomes Banking's own sub-nav — and
// ONLY that. No "More" here: while you're in Banking you stay in Banking; the
// way out is the wordmark → the /home landing. First tab is Overview, back to
// the Banking dashboard itself.
const BANKING_SUBNAV: NavItem[] = [
  { name: "Overview", href: "/banking" },
  { name: "Chase", href: "/transactions" },
  { name: "Amex", href: "/amex" },
  { name: "Budget", href: "/budget" },
  { name: "Allowance", href: "/allowances" },
];
const BANKING_ROUTES = ["/banking", "/transactions", "/amex", "/budget", "/allowances"];

// Inside the Bills area, the top ribbon becomes just two tabs — Overview and
// Bills — and ONLY those (owner's explicit ask). Same pattern as Banking: no
// "More" here; the way out is the wordmark → /home. Overview (/bills) is the
// default landing; Bills (/bills/all) is the recurring/income line editor.
const BILLS_SUBNAV: NavItem[] = [
  { name: "Overview", href: "/bills" },
  { name: "Bills", href: "/bills/all" },
];

// The Avalanche area is a single page — its ribbon is just the one Avalanche
// tab (owner's ask: "one tab, no other"). Same pattern as Banking/Bills: no
// "More", the way out is the wordmark → /home.
const AVALANCHE_SUBNAV: NavItem[] = [{ name: "Future Goal", href: "/avalanche" }];

// The Forecast area ribbon — Overview (the section landing) · Review · Forecast
// (the cash-flow curve). Review is pulled OUT of "More" and lives here as a
// forecast tab. Same pattern as Banking/Bills/Avalanche: no "More", escape via
// the wordmark → /home.
const FORECAST_SUBNAV: NavItem[] = [
  { name: "Overview", href: "/forecast/overview" },
  { name: "Review", href: "/review" },
  { name: "Forecast", href: "/forecast" },
];

const ALL_NAV = [...PRIMARY_NAV, ...MORE_NAV];

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
  // Groups say what they are: the four areas, then everything else.
  const groups: { label: string; items: NavItem[] }[] = [
    { label: "Areas", items: PRIMARY_NAV },
    { label: "More", items: MORE_NAV },
  ];
  return (
    <div className="flex h-full flex-col bg-brand-navy text-white">
      <div className="flex h-14 items-center border-b border-white/10 px-3">
        <HomeMark onNavigate={onNavigate} />
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-2 pb-1.5 text-micro font-semibold uppercase tracking-wide text-white/40">
              {g.label}
            </div>
            <div className="space-y-0.5">
              {g.items.map((item) => {
                const active = location.startsWith(item.href);
                const badge = railBadge(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    onMouseEnter={() => onPrefetch(item.href)}
                    onFocus={() => onPrefetch(item.href)}
                    data-testid={`mobilenav-${item.href.slice(1)}`}
                    className={cn(
                      "press relative flex items-center gap-3 rounded-control px-3 py-2 text-body",
                      active
                        ? "bg-white/10 font-semibold text-white"
                        : "text-white/60 hover:bg-white/5 hover:text-white",
                    )}
                  >
                    {/* The vertical analogue of the ribbon's underline — same
                        accent, same meaning: this is where you are. */}
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
              })}
            </div>
          </div>
        ))}
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
  // Inside the Banking area, show Banking's sub-nav in the top ribbon.
  const inBanking = BANKING_ROUTES.some(
    (r) => location === r || location.startsWith(r + "/"),
  );
  // Bills area = /bills (Overview) or /bills/... (the Bills list). Its ribbon is
  // just the two tabs.
  const inBills = location === "/bills" || location.startsWith("/bills/");
  const inAvalanche =
    location === "/avalanche" || location.startsWith("/avalanche/");
  // Forecast area = the cash-flow curve + its moved-in Review tab.
  const inForecast =
    location === "/forecast" ||
    location.startsWith("/forecast/") ||
    location === "/review" ||
    location.startsWith("/review/");
  const areaNav = inBanking
    ? BANKING_SUBNAV
    : inBills
      ? BILLS_SUBNAV
      : inAvalanche
        ? AVALANCHE_SUBNAV
        : inForecast
          ? FORECAST_SUBNAV
          : PRIMARY_NAV;
  // Boundary-aware, longest-match active href — so /bills (Overview) and
  // /bills/all (Bills) never both light up (raw startsWith would).
  const activeNavHref =
    areaNav
      .map((a) => a.href)
      .filter((h) => location === h || location.startsWith(h + "/"))
      .sort((a, b) => b.length - a.length)[0] ?? null;
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
    } else if (href === "/forecast/overview" || href === "/forecast") {
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

  // (#perf) After first paint, warm the primary destinations' chunks on idle so
  // the very first click into each area is instant even without a prior hover.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const warm = () => {
      for (const href of ["/banking", "/bills", "/forecast/overview", "/avalanche"]) {
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

  const railBadge = (href: string): number | null => {
    if (href === "/review" && reviewCount > 0) return reviewCount;
    return null;
  };

  const ribbonTabs: RibbonTab[] = areaNav.map((item) => ({
    href: item.href,
    label: item.name,
    count: railBadge(item.href),
  }));

  // Is any secondary (More) destination the current page, and do any of them
  // carry a pending badge — so the collapsed More trigger can signal both.
  const moreActive = moreNav.some((n) => location.startsWith(n.href));
  const moreBadgeTotal = moreNav.reduce(
    (sum, n) => sum + (railBadge(n.href) ?? 0),
    0,
  );

  const currentTitle =
    ALL_NAV.find((n) => location.startsWith(n.href))?.name ?? "H2 Budget";

  // More is hidden inside an area: there the ribbon is that section's tabs
  // only, and you leave via the wordmark → Home.
  const showMore = !inBanking && !inBills && !inAvalanche && !inForecast;

  // ⚠️ THE COUNT SHOWS ONCE. When the live ribbon already carries the Review
  // tab (the Forecast area), a second copy on the right would be the same
  // finding claimed twice — and two badges reading "3" look like six things.
  const showReviewPill = reviewCount > 0 && !ribbonHrefs.has("/review");

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
                <SheetContent side="left" className="flex w-72 flex-col border-0 p-0">
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
              <span className="mr-1 max-w-[34vw] truncate text-label font-semibold md:hidden">
                {currentTitle}
              </span>
              {showReviewPill && (
                <Link
                  href="/review"
                  onMouseEnter={() => prefetch("/review")}
                  onFocus={() => prefetch("/review")}
                  aria-label={`${reviewCount} items to review`}
                  data-testid="topnav-review-badge"
                  className="press flex items-center gap-1.5 rounded-control px-2 py-1 text-micro font-semibold text-white/70 hover:bg-white/10 hover:text-white"
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
