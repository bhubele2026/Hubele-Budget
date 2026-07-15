import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { UserButton } from "@clerk/react";
import {
  Home,
  Receipt,
  CreditCard,
  Inbox,
  TrendingUp,
  CalendarCheck,
  BarChart3,
  PieChart,
  CalendarDays,
  Wallet,
  Landmark,
  Flame,
  Settings as SettingsIcon,
  Menu,
  MoreHorizontal,
  LayoutDashboard,
} from "lucide-react";
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
  getBillsInsightsSummary,
  getGetBillsInsightsSummaryQueryKey,
  listDebts,
  getListDebtsQueryKey,
  listTransactions,
  getListTransactionsQueryKey,
  getBudgetMonth,
  getGetBudgetMonthQueryKey,
  listCategories,
  getListCategoriesQueryKey,
  listWeeklyDebriefs,
  getListWeeklyDebriefsQueryKey,
} from "@workspace/api-client-react";
import { prefetchRoute } from "@/lib/routePrefetch";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { useDebriefAwaitingCount } from "@/hooks/useDebriefAwaitingCount";
import { AdvisorChat } from "@/components/advisor-chat";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";

type NavItem = { name: string; href: string; icon: typeof Receipt };

// One primary row — Home (the 4-tile landing) plus the four areas. Everything
// else is one click away in the More overflow, so nothing is lost.
const PRIMARY_NAV: NavItem[] = [
  { name: "Home", href: "/home", icon: Home },
  { name: "Banking", href: "/banking", icon: Landmark },
  { name: "Bills", href: "/bills", icon: CalendarDays },
  // Forecast primary link lands on the section's Overview tab (Bills precedent).
  { name: "Forecast", href: "/forecast/overview", icon: TrendingUp },
  // Route + testids stay /avalanche; only the display label is "Future Goal".
  { name: "Future Goal", href: "/avalanche", icon: Flame },
];

// Secondary destinations, demoted into the More dropdown. Every route stays
// reachable — just one extra click. (Chase/Amex/Allowance live inside Banking;
// Budget inside Forecast; these entries are the direct shortcuts.)
const MORE_NAV: NavItem[] = [
  { name: "Chase", href: "/transactions", icon: Receipt },
  { name: "Amex", href: "/amex", icon: CreditCard },
  { name: "Allowance", href: "/allowances", icon: Wallet },
  { name: "Budget", href: "/budget", icon: PieChart },
  { name: "Reports", href: "/reports", icon: BarChart3 },
  { name: "Debts", href: "/debts", icon: Landmark },
  // Review + Debrief now live in the Forecast ribbon (FORECAST_SUBNAV), not here.
  { name: "Settings", href: "/settings", icon: SettingsIcon },
];

// Inside the Banking area, the top ribbon becomes Banking's own sub-nav — and
// ONLY that. No "More" here: while you're in Banking you stay in Banking; the
// way out is the brand/logo → the /home landing. First tab is Overview, back to
// the Banking dashboard itself.
const BANKING_SUBNAV: NavItem[] = [
  { name: "Overview", href: "/banking", icon: LayoutDashboard },
  { name: "Chase", href: "/transactions", icon: Receipt },
  { name: "Amex", href: "/amex", icon: CreditCard },
  { name: "Budget", href: "/budget", icon: PieChart },
  { name: "Allowance", href: "/allowances", icon: Wallet },
];
const BANKING_ROUTES = ["/banking", "/transactions", "/amex", "/budget", "/allowances"];

// Inside the Bills area, the top ribbon becomes just two tabs — Overview and
// Bills — and ONLY those (owner's explicit ask). Same pattern as Banking: no
// "More" here; the way out is the brand/logo → /home. Overview (/bills) is the
// default landing; Bills (/bills/all) is the recurring/income line editor.
const BILLS_SUBNAV: NavItem[] = [
  { name: "Overview", href: "/bills", icon: LayoutDashboard },
  { name: "Bills", href: "/bills/all", icon: CalendarDays },
];

// The Avalanche area is a single page — its ribbon is just the one Avalanche
// tab (owner's ask: "one tab, no other"). Same pattern as Banking/Bills: no
// "More", the way out is the brand/logo → /home.
const AVALANCHE_SUBNAV: NavItem[] = [
  { name: "Future Goal", href: "/avalanche", icon: Flame },
];

// The Forecast area ribbon — Overview (the section landing) · Review · Forecast
// (the cash-flow curve) · Debrief. Review + Debrief are pulled OUT of "More" and
// live here as forecast tabs. Same pattern as Banking/Bills/Avalanche: no
// "More", escape via brand → /home.
const FORECAST_SUBNAV: NavItem[] = [
  { name: "Overview", href: "/forecast/overview", icon: LayoutDashboard },
  { name: "Review", href: "/review", icon: Inbox },
  { name: "Forecast", href: "/forecast", icon: TrendingUp },
  { name: "Debrief", href: "/debrief", icon: CalendarCheck },
];

const ALL_NAV = [...PRIMARY_NAV, ...MORE_NAV];

const BRAND = (
  <span className="flex items-center gap-2 select-none">
    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-[hsl(202_88%_13%)] to-[hsl(202_88%_9%)] text-[hsl(197_63%_74%)] font-bold text-[11px] tracking-tight border border-[hsl(202_88%_22%)]">
      H2
    </span>
    <span className="font-semibold text-[13.5px] tracking-tight">Budget</span>
  </span>
);

function MobileNav({
  location,
  onNavigate,
  railBadge,
}: {
  location: string;
  onNavigate: () => void;
  railBadge: (href: string) => number | null;
}) {
  const groups: { label: string; items: NavItem[] }[] = [
    { label: "Command", items: PRIMARY_NAV },
    { label: "More", items: MORE_NAV },
  ];
  return (
    <div className="flex flex-col h-full bg-sidebar">
      <div className="px-5 py-4 border-b border-sidebar-border text-sidebar-foreground">
        {BRAND}
      </div>
      <nav className="flex-1 overflow-y-auto p-3 space-y-4">
        {groups.map((g, i) => (
          <div key={g.label || `g-${i}`}>
            {g.label && (
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {g.label}
              </div>
            )}
            <div className="space-y-0.5">
              {g.items.map((item) => {
                const active = location.startsWith(item.href);
                const badge = railBadge(item.href);
                return (
                  <Link key={item.href} href={item.href}>
                    <span
                      onClick={onNavigate}
                      onMouseEnter={() => prefetchRoute(item.href)}
                      onFocus={() => prefetchRoute(item.href)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-md text-sm cursor-pointer",
                        active
                          ? "bg-primary/10 text-primary font-semibold"
                          : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                      )}
                    >
                      <item.icon className="w-4 h-4" />
                      <span className="flex-1">{item.name}</span>
                      {badge !== null && (
                        <Badge
                          variant="outline"
                          className="bg-warning/10 text-warning border-warning/30 text-[10px] px-1.5 py-0 h-5 tabular-nums"
                        >
                          {badge}
                        </Badge>
                      )}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-sidebar-border p-4 flex items-center justify-between">
        <span className="text-sm font-medium text-sidebar-foreground">
          Account
        </span>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <UserButton />
        </div>
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
  // Forecast area = the cash-flow curve + its two moved-in tabs (Review, Debrief).
  const inForecast =
    location === "/forecast" ||
    location.startsWith("/forecast/") ||
    location === "/review" ||
    location.startsWith("/review/") ||
    location === "/debrief" ||
    location.startsWith("/debrief/");
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
  const debriefCount = useDebriefAwaitingCount();

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
      qc.prefetchQuery({
        queryKey: getGetBillsInsightsSummaryQueryKey(),
        queryFn: () => getBillsInsightsSummary(),
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
    } else if (href === "/reports") {
      // Reports aggregates a bounded txn window client-side; warm the same key
      // the landing report reads (useReportsData(30, 0): 95-day floor → today).
      const today = new Date();
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`;
      const fetchFrom = new Date(today);
      fetchFrom.setDate(fetchFrom.getDate() - 95);
      const params = { from: iso(fetchFrom), to: iso(today), limit: 2000 };
      qc.prefetchQuery({
        queryKey: getListTransactionsQueryKey(params),
        queryFn: () => listTransactions(params),
      });
    } else if (href === "/debrief") {
      const today = new Date();
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`;
      const from = new Date(today);
      from.setDate(from.getDate() - 180);
      const params = { from: iso(from), to: iso(today) };
      qc.prefetchQuery({
        queryKey: getListWeeklyDebriefsQueryKey(params),
        queryFn: () => listWeeklyDebriefs(params),
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
    if (href === "/debrief" && debriefCount > 0) return debriefCount;
    return null;
  };

  // Is any secondary (More) destination the current page, and do any of them
  // carry a pending badge — so the collapsed More trigger can signal both.
  const moreActive = moreNav.some((n) => location.startsWith(n.href));
  const moreBadgeTotal = moreNav.reduce(
    (sum, n) => sum + (railBadge(n.href) ?? 0),
    0,
  );

  const currentTitle =
    ALL_NAV.find((n) => location.startsWith(n.href))?.name ?? "H2 Budget";

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col">
      {/* ── Top bar: brand · plan-&-analyze nav · settings gear. Hidden on the
          landing (/home) — there the four tiles ARE the navigation. ────────── */}
      {location !== "/home" && (
      <header className="shrink-0 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
        <div className="flex items-center h-11">
          {/* Brand — desktop: pinned to the rail width (w-52) with matching
              padding so "H2 Budget" sits directly above the left rail and the
              top-nav starts where the main content does. */}
          <Link href="/home">
            <span className="hidden md:flex items-center h-11 pl-4 pr-5 cursor-pointer">
              {BRAND}
            </span>
          </Link>

          {/* Mobile: hamburger + brand */}
          <div className="md:hidden flex items-center gap-1 pl-1">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-sidebar-foreground hover:bg-sidebar-accent"
                  aria-label="Open navigation menu"
                  data-testid="button-mobile-menu"
                >
                  <Menu className="w-5 h-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="p-0 w-72 flex flex-col">
                <MobileNav
                  location={location}
                  onNavigate={() => setMobileOpen(false)}
                  railBadge={railBadge}
                />
              </SheetContent>
            </Sheet>
            <Link href="/home">
              <span className="cursor-pointer">{BRAND}</span>
            </Link>
          </div>

          <nav className="hidden md:flex items-center gap-0.5">
            {areaNav.map((item) => {
              const active = item.href === activeNavHref;
              return (
                <Link key={item.href} href={item.href}>
                  <span
                    onMouseEnter={() => prefetch(item.href)}
                    onFocus={() => prefetch(item.href)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[13px] cursor-pointer transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-foreground font-semibold ring-1 ring-primary/40"
                        : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    )}
                    data-testid={`topnav-${item.href.slice(1)}`}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.name}
                  </span>
                </Link>
              );
            })}

            {/* More overflow — secondary destinations, one click away. Hidden
                inside the Banking, Bills AND Avalanche areas: there the ribbon
                is that section's tabs only, and you leave via the brand → Home. */}
            {!inBanking && !inBills && !inAvalanche && !inForecast && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "relative flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[13px] cursor-pointer transition-colors outline-none",
                    moreActive
                      ? "bg-sidebar-accent text-sidebar-foreground font-semibold ring-1 ring-primary/40"
                      : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  )}
                  data-testid="topnav-more"
                  aria-label="More destinations"
                >
                  <MoreHorizontal className="w-4 h-4" />
                  More
                  {moreBadgeTotal > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary" />
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
                        className="flex items-center gap-2.5 cursor-pointer"
                        data-testid={`morenav-${item.href.slice(1)}`}
                      >
                        <item.icon className="w-4 h-4 text-muted-foreground" />
                        <span className="flex-1">{item.name}</span>
                        {badge !== null && (
                          <Badge
                            variant="outline"
                            className="bg-warning/10 text-warning border-warning/30 text-[10px] px-1.5 py-0 h-5 tabular-nums"
                          >
                            {badge}
                          </Badge>
                        )}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-0.5 pr-3 md:pr-5">
            {/* Mobile shows the current page title between brand and actions. */}
            <span className="md:hidden mr-1 font-semibold truncate max-w-[40vw]">
              {currentTitle}
            </span>
            <ThemeToggle className="text-sidebar-foreground hover:bg-sidebar-accent" />
            <UserButton />
          </div>
        </div>
      </header>
      )}

      {/* ── Body: single full-width content column (rail collapsed into the
          top bar's primary row + More overflow) ──────────────────────────── */}
      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {location === "/home" ? (
            // Landing renders full-bleed — it centers its own cards.
            children
          ) : (
            <div className="p-3 md:p-5 max-w-[1600px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-500">
              {children}
            </div>
          )}
        </main>
      </div>
      <AdvisorChat />
      <CommandPalette />
    </div>
  );
}
