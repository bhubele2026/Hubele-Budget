import { Link } from "wouter";
import { useMemo } from "react";
import { useUser, UserButton } from "@clerk/react";
import {
  Landmark,
  Receipt,
  LineChart,
  Flame,
  ChevronRight,
  Bell,
} from "lucide-react";
import {
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
  useGetBillsSummary,
  getGetBillsSummaryQueryKey,
  useGetForecastCashSignal,
  getGetForecastCashSignalQueryKey,
  useListDebts,
  getListDebtsQueryKey,
} from "@workspace/api-client-react";
import { prefetchRoute } from "@/lib/routePrefetch";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { MoneyText } from "@/components/viz/MoneyText";
import { H2Wordmark } from "@/components/h2-wordmark";

/**
 * Front door (/home). Deliberately plain and professional: a top border bar
 * with the brand logo + account controls, a short greeting, and four flat
 * cards that route into the app's four areas. Each card carries ONE real,
 * server-computed headline number (no raw-transaction fetches; every dollar
 * figure is computed in code). A faint brand watermark sits bottom-right.
 * The global nav ribbon is hidden here (see layout.tsx) — the cards + the
 * per-card quick links ARE the navigation.
 */

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

// ── shared flat card ────────────────────────────────────────────────────────

type QuickLink = { href: string; label: string; testid?: string };

/**
 * Every tile shares ONE rigid skeleton so the grid is strictly aligned:
 * the card box holds a clickable main area (icon row, title, blurb, then the
 * metric pinned to the bottom with mt-auto so all metrics share a baseline)
 * and a quick-links footer INSIDE the card (border-t), so every card in a row
 * has an identical bottom edge. Monochrome ink only — the single interactive
 * accent is the existing primary hover; color never decorates this page.
 */
function Tile({
  icon,
  title,
  blurb,
  href,
  testid,
  metricLabel,
  metric,
  links,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  href: string;
  testid: string;
  metricLabel?: string;
  metric?: React.ReactNode;
  links?: QuickLink[];
}) {
  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-xl border border-card-border bg-card shadow-sm transition-[box-shadow,border-color] duration-200 hover:border-primary/50 hover:shadow-md"
      data-testid={`landing-tile-${testid}`}
    >
      <Link
        href={href}
        onMouseEnter={() => prefetchRoute(href)}
        onFocus={() => prefetchRoute(href)}
        aria-label={title}
        className="group flex flex-1 flex-col p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {icon}
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </div>
        <div className="mt-4 text-base font-semibold text-foreground">
          {title}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {blurb}
        </p>
        <div className="mt-auto pt-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
            {metricLabel ?? " "}
          </div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
            {metric ?? " "}
          </div>
        </div>
      </Link>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-2.5 sm:px-6">
        {(links ?? []).map((l) => (
          <Link
            key={l.href}
            href={l.href}
            data-testid={l.testid}
            onMouseEnter={() => prefetchRoute(l.href)}
            onFocus={() => prefetchRoute(l.href)}
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground hover:underline"
          >
            {l.label}
          </Link>
        ))}
        {(links ?? []).length === 0 && <span className="text-xs">&nbsp;</span>}
      </div>
    </div>
  );
}

// ── tiles ───────────────────────────────────────────────────────────────────

function BankingTile() {
  const { from, to } = useMemo(() => {
    const now = new Date();
    return {
      to: isoDate(now),
      from: isoDate(new Date(now.getFullYear(), now.getMonth() - 5, 1)),
    };
  }, []);
  const { data } = useGetReportsSpendingFacts(
    { from, to },
    {
      query: {
        queryKey: getGetReportsSpendingFactsQueryKey({ from, to }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );
  const trends = data?.monthlyTrends ?? [];
  const curMonthTotal = trends.length ? trends[trends.length - 1].total : null;

  return (
    <Tile
      testid="banking"
      href="/banking"
      icon={<Landmark className="h-5 w-5" strokeWidth={1.75} />}
      title="Banking"
      blurb="How you're spending — this week & month, where it's going, what's creeping up."
      metricLabel={curMonthTotal != null ? "Spent this month" : undefined}
      metric={
        curMonthTotal != null ? <MoneyText countUp amount={curMonthTotal} /> : undefined
      }
      links={[
        { href: "/transactions", label: "Chase", testid: "landing-link-banking-chase" },
        { href: "/amex", label: "Amex", testid: "landing-link-banking-amex" },
        { href: "/allowances", label: "Allowance", testid: "landing-link-banking-allowance" },
      ]}
    />
  );
}

function BillsTile() {
  // No `month` param: the server defaults to the current month, and the
  // param-less key is the one the Bills page + nav hover-prefetch share —
  // an explicit current-month param forked a duplicate cache entry.
  const { data } = useGetBillsSummary(undefined, {
    query: {
      queryKey: getGetBillsSummaryQueryKey(),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    },
  });
  const monthlyTotal = Number(data?.monthly?.bills ?? 0);

  return (
    <Tile
      testid="bills"
      href="/bills"
      icon={<Receipt className="h-5 w-5" strokeWidth={1.75} />}
      title="Bills"
      blurb="Your recurring bills & subscriptions — what's due, what changed, and the monthly total."
      metricLabel={monthlyTotal > 0 ? "Recurring this month" : undefined}
      metric={monthlyTotal > 0 ? <MoneyText countUp amount={monthlyTotal} /> : undefined}
      links={[
        { href: "/bills/all", label: "All bills", testid: "landing-link-bills-all" },
      ]}
    />
  );
}

function ForecastTile() {
  const { data } = useGetForecastCashSignal(
    { horizonDays: 90 },
    {
      query: {
        queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
        staleTime: 60_000,
        gcTime: 10 * 60_000,
      },
    },
  );
  const lowest = data?.lowestProjected ?? null;
  const lowestDate = data?.lowestDate
    ? new Date(data.lowestDate + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <Tile
      testid="forecast"
      href="/forecast/overview"
      icon={<LineChart className="h-5 w-5" strokeWidth={1.75} />}
      title="Forecast"
      blurb="See what's coming, then review and lock it in."
      metricLabel={
        lowest != null && lowestDate ? `Lowest projected · ${lowestDate}` : undefined
      }
      metric={lowest != null && lowestDate ? <MoneyText countUp amount={lowest} /> : undefined}
      links={[
        { href: "/forecast", label: "Forecast", testid: "landing-link-forecast-forecast" },
        { href: "/review", label: "Review", testid: "landing-link-forecast-review" },
        { href: "/budget", label: "Budget", testid: "landing-link-forecast-budget" },
      ]}
    />
  );
}

function AvalancheTile() {
  const { data } = useListDebts({
    query: {
      queryKey: getListDebtsQueryKey(),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    },
  });
  const active = (data ?? []).filter((d) => d.status !== "paid_off");
  // Payoff PROGRESS only — never surface the amount owed on the landing.
  const overallPaid = useMemo(() => {
    let sumOrig = 0;
    let sumBal = 0;
    for (const d of active) {
      const bal = Number(d.balance) || 0;
      const orig = Number(d.originalBalance ?? 0) || 0;
      if (orig > 0) {
        sumOrig += orig;
        sumBal += Math.min(bal, orig);
      }
    }
    return sumOrig > 0 ? Math.max(0, Math.min(1, (sumOrig - sumBal) / sumOrig)) : null;
  }, [active]);

  return (
    <Tile
      testid="avalanche"
      href="/avalanche"
      icon={<Flame className="h-5 w-5" strokeWidth={1.75} />}
      title="Future Goal"
      blurb="Work the payoff plan — progress, next targets, and your debt-free date."
      metricLabel={overallPaid != null ? "Payoff progress" : undefined}
      metric={
        overallPaid != null ? <>{Math.round(overallPaid * 100)}% paid</> : undefined
      }
      links={[
        { href: "/debts", label: "Debts", testid: "landing-link-avalanche-debts" },
      ]}
    />
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const { user } = useUser();
  const who = user?.firstName?.trim() || "Hubeles";
  const reviewCount = useReviewInboxCount();

  return (
    <div className="relative min-h-full w-full bg-background">
      {/* Top border bar: brand logo + account controls. */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <H2Wordmark tone="navy" size={24} />
          <div className="flex items-center gap-1.5">
            <Link
              href="/review"
              aria-label={
                reviewCount > 0 ? `${reviewCount} items to review` : "Review inbox"
              }
              data-testid="landing-bell"
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Bell className="h-4 w-4" />
              {reviewCount > 0 && (
                <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
                  {reviewCount}
                </span>
              )}
            </Link>
            <UserButton />
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="relative mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6">
        <div className="relative mb-8">
          <h1
            className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
            style={{ fontFamily: "var(--app-font-sans)" }}
          >
            Hey, {who}.
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Where do you want to go?
          </p>
        </div>

        <div className="stagger-children grid grid-cols-1 gap-4 sm:grid-cols-2 sm:auto-rows-fr">
          <BankingTile />
          <BillsTile />
          <ForecastTile />
          <AvalancheTile />
        </div>
      </div>

      {/* Faint brand watermark, bottom-right. Non-interactive. */}
      <div
        aria-hidden="true"
        /* ⚠️ NOT `grayscale` any more. The old watermark was a raster that had
           to be desaturated to sit under the page; the lockup is type, so
           opacity alone does it — and greying it out would have printed a mark
           whose one accent colour had been removed. */
        className="pointer-events-none fixed bottom-4 right-4 z-0 select-none opacity-[0.06]"
      >
        <H2Wordmark tone="navy" size={96} />
      </div>
    </div>
  );
}
