import { Fragment, Suspense, lazy, useEffect, useRef, useState } from "react";
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
import { HomeMark } from "@/components/home-mark";
import { TabRibbon, TabUnderline, type RibbonTab } from "@/components/tab-ribbon";
import { AccountMenu } from "@/components/account-menu";
import { Crumbs } from "@/ui";
import {
  BAR_SECTIONS,
  MORE_ITEMS,
  backLinkFor,
  crumbsFor,
  litTabOf,
  moreItemOf,
  pathOf,
  sectionFor,
  tabsOf,
  type SectionTab,
} from "@/lib/navModel";
// (C12) The tab LIST only — never `settingsTabs.ts`, whose lazy importers
// would ride the landing chunk with it.
import { SETTINGS_PAGES, openSettingsSub } from "@/lib/navSettings";

/**
 * ⭐ THE SHELL (W1, owner-approved). "I click into something and don't know
 * where I am." So the chrome never changes shape:
 *
 *   1. ONE GLOBAL BAR on every route — Dashboard · Banking · Amex · Spending ·
 *      Forecast · Debt · More. The section you are in is lit. Nothing swaps it.
 *   2. SECTION TABS in a lighter row under it (never in place of it).
 *   3. A `Dashboard › Section › Tab` line above the page; on a phone one
 *      `‹ Back` link.
 *
 * The model (which route belongs to which section and tab) is `lib/navModel.ts`,
 * a pure table the tests walk. The desktop bar and the phone drawer are both
 * drawn from it, so they cannot drift.
 *
 * The word "Home" is not a label anywhere; the wordmark and Dashboard both go
 * to /home.
 */

// The drawer's content is its own chunk: it opens on a tap, and the landing's
// entry graph has no room for it. Warmed on idle and on the trigger's
// hover/focus/press so the first tap is instant.
const importMobileNav = () => import("@/components/mobile-nav");
const MobileNav = lazy(importMobileNav);
// Amex's per-card tabs are fed by their own small chunk, for the same reason.
const AmexCardTabsFeed = lazy(() => import("@/components/amex-card-tabs-feed"));

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  // The section this route is in lights its item in the bar; the bar itself
  // never changes. Its tabs show in the row beneath.
  const section = sectionFor(location);
  const [amexCards, setAmexCards] = useState<SectionTab[]>([]);
  const sectionTabs = section ? tabsOf(section, amexCards) : [];
  const litTab = litTabOf(section, sectionTabs, location, search);
  const moreItem = section?.id === "more" ? moreItemOf(location) : null;
  // The phone title is the SECTION you are in (the word the bar lights), never
  // a tab's name ("Review" read as the old area name). More shows its own page.
  const currentTitle = section?.id === "more" ? (moreItem?.name ?? section.name) : (section?.name ?? "H2 Budget");
  const trail = crumbsFor(location, section, litTab);
  const back = backLinkFor(section, litTab);
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
  const prefetch = (rawHref: string) => {
    const href = pathOf(rawHref);
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

  // (#perf) After first paint, warm the bar's chunks on idle so the very first
  // click into each section is instant even without a prior hover.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const warm = () => {
      for (const { href } of BAR_SECTIONS) {
        prefetchRoute(href);
      }
      void importMobileNav();
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

  // ⭐ Scroll: a new page starts at the top, Back/Forward returns to where you
  // were (`lib/scrollRestore.ts`).
  const mainRef = useRef<HTMLElement>(null);
  // (Its own small chunk, loaded right after first paint — the landing's entry
  // graph has no room for it.)
  useEffect(() => {
    let off: (() => void) | undefined;
    let live = true;
    void import("@/lib/scrollRestore").then((m) => {
      if (live) off = m.installScrollRestoration(() => mainRef.current);
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  // A null count is unknown (the spine is loading or failed): no badge, never 0.
  // The count sits on the item that owns the page: Reconcile (the forecast
  // inbox) in Forecast's tabs, Categories (the queue) in More.
  const railBadge = (href: string): number | null => {
    if (href === "/review/categories") return queueTotal != null && queueTotal > 0 ? queueTotal : null;
    if (href === "/review") return forecastReview != null && forecastReview > 0 ? forecastReview : null;
    return null;
  };

  const barTabs: RibbonTab[] = BAR_SECTIONS.map((s) => ({ href: s.href, label: s.name }));
  const barActive = section && section.id !== "more" ? section.href : null;
  const sectionRibbon: RibbonTab[] = sectionTabs.map((t) => ({
    href: t.href,
    label: t.name,
    count: railBadge(t.href),
  }));
  const settingsSub = openSettingsSub(location, search);
  const moreActive = section?.id === "more";

  // ⚠️ THE COUNT SHOWS ONCE. In Forecast the Reconcile tab carries it; on
  // every other page this pill is the way in, on every screen size.
  const hasReviewCount = reviewCount != null && reviewCount > 0;
  const reviewPillShown = hasReviewCount && section?.id !== "forecast";
  // The pill goes where the work is: the forecast inbox when it has charges,
  // else the categorization queue.
  const reviewPillHref = forecastReview != null && forecastReview > 0 ? "/review" : "/review/categories";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* ── The navy rail: wordmark · the one global bar · account. Shown on
          every page, the dashboard included. ──────────────────────────────── */}
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
                    onPointerDown={() => void importMobileNav()}
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
                  <Suspense fallback={null}>
                    <MobileNav
                      location={location}
                      search={search}
                      section={section}
                      litHref={litTab?.href ?? null}
                      amexCards={amexCards}
                      onNavigate={() => setMobileOpen(false)}
                      railBadge={railBadge}
                      onPrefetch={prefetch}
                    />
                  </Suspense>
                </SheetContent>
              </Sheet>
            </div>

            <HomeMark />

            {/* A hairline between the mark and the bar: the mark is a
                control, not the first tab. */}
            <span aria-hidden className="mx-1 hidden h-5 w-px bg-chrome-rule md:block" />

            <div className="hidden min-w-0 flex-1 md:flex" data-testid="global-nav">
              <TabRibbon
                tabs={barTabs}
                activeHref={barActive}
                onPrefetch={prefetch}
                ariaLabel="Sections"
                trailing={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "press relative flex items-center whitespace-nowrap px-3.5 text-label font-semibold",
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
                      {MORE_ITEMS.map((item) => {
                        const badge = railBadge(item.href);
                        // The page you are on reads as current here too; on
                        // a Settings sub-page that is the sub-page.
                        const current =
                          moreItem?.href === item.href && !(item.href === "/settings" && settingsSub != null);
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
              {reviewPillShown && (
                <Link
                  href={reviewPillHref}
                  onMouseEnter={() => prefetch(reviewPillHref)}
                  onFocus={() => prefetch(reviewPillHref)}
                  aria-label={`${reviewCount} items to review`}
                  data-testid="topnav-review-badge"
                  className="press flex items-center gap-1.5 rounded-control px-2 py-1 text-micro font-semibold text-chrome-ink-2 hover:bg-chrome-press hover:text-chrome-ink"
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

      {/* ── The section tabs: a lighter row UNDER the bar, never instead of
          it. Nothing for the dashboard and for More's pages. ──────────────── */}
      {sectionRibbon.length > 0 && (
        <div
          data-testid="section-nav"
          className="shrink-0 border-b border-brand-line bg-card px-1 md:px-3"
        >
          <TabRibbon
            tabs={sectionRibbon}
            activeHref={litTab?.href ?? null}
            onPrefetch={prefetch}
            ariaLabel="Section pages"
            variant="section"
            testIdPrefix="sectionnav"
          />
        </div>
      )}

      {/* ── Where am I: Dashboard › Section › Tab. Outside the scroller, so it
          never covers a page's own sticky head. ───────────────────────────── */}
      {trail.length > 0 && (
        <div data-testid="breadcrumb" className="shrink-0 bg-background px-3 pt-2 md:px-5">
          <div className="hidden md:block" data-testid="breadcrumb-trail">
            <Crumbs trail={trail} strong />
          </div>
          {back && (
            <Link
              href={back.href!}
              data-testid="breadcrumb-back"
              className="press inline-flex items-center gap-1 py-0.5 text-micro font-semibold text-brand-navy md:hidden"
            >
              <span aria-hidden>‹</span> {back.label}
            </Link>
          )}
        </div>
      )}

      <Suspense fallback={null}>
        <AmexCardTabsFeed onTabs={setAmexCards} />
      </Suspense>

      {/* ── Body: single full-width content column. ─────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* ⚠️ THE ONLY VERTICAL SCROLLER inside the shell (index.css, the
            `html` note). `data-shell-scroller` is how code finds it
            (`shellScrollerOf`, `lib/shellScroll.ts`); `.shell-scroller`
            reserves its gutter. */}
        <main
          data-shell-scroller=""
          className="shell-scroller min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          ref={mainRef}
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
