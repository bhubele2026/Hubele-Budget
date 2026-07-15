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
import { ThemeToggle } from "@/components/theme-toggle";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { MoneyText } from "@/components/viz/MoneyText";
import { H2Logo } from "@/components/h2-logo";

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
      className="flex h-full flex-col"
      data-testid={`landing-tile-${testid}`}
    >
      <Link
        href={href}
        onMouseEnter={() => prefetchRoute(href)}
        onFocus={() => prefetchRoute(href)}
        aria-label={title}
        className="group flex flex-1 flex-col rounded-xl border border-card-border bg-card p-5 shadow-sm transition-[box-shadow,border-color,transform] duration-200 hover:border-primary/50 hover:shadow-md motion-safe:hover:-translate-y-0.5 motion-reduce:transform-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground">
            {icon}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </div>
        <div className="mt-4 text-base font-semibold text-foreground">
          {title}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {blurb}
        </p>
        {metric != null && (
          <div className="mt-4">
            {metricLabel && (
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
                {metricLabel}
              </div>
            )}
            <div className="mt-0.5 text-lg font-bold tabular-nums text-foreground">
              {metric}
            </div>
          </div>
        )}
      </Link>
      {links && links.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              data-testid={l.testid}
              onMouseEnter={() => prefetchRoute(l.href)}
              onFocus={() => prefetchRoute(l.href)}
              className="transition-colors hover:text-primary hover:underline"
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}
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
      blurb="How you're spending — this week & month, what to cancel, what to stop buying."
      metricLabel={curMonthTotal != null ? "Spent this month" : undefined}
      metric={
        curMonthTotal != null ? <MoneyText amount={curMonthTotal} /> : undefined
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
  const month = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  }, []);
  const { data } = useGetBillsSummary(
    { month },
    {
      query: {
        queryKey: getGetBillsSummaryQueryKey({ month }),
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );
  const monthlyTotal = Number(data?.monthly?.bills ?? 0);

  return (
    <Tile
      testid="bills"
      href="/bills"
      icon={<Receipt className="h-5 w-5" strokeWidth={1.75} />}
      title="Bills"
      blurb="Your recurring bills & subscriptions — with an AI review of what to cut and what's missing."
      metricLabel={monthlyTotal > 0 ? "Recurring this month" : undefined}
      metric={monthlyTotal > 0 ? <MoneyText amount={monthlyTotal} /> : undefined}
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
      metric={lowest != null && lowestDate ? <MoneyText amount={lowest} /> : undefined}
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
      blurb="Attack the debt — manage the payoff plan and free-by date."
      metricLabel={overallPaid != null ? "Payoff progress" : undefined}
      metric={
        overallPaid != null ? (
          <span className="text-[hsl(var(--positive))]">
            {Math.round(overallPaid * 100)}% paid
          </span>
        ) : undefined
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
          <H2Logo className="h-7 w-auto" />
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
            <ThemeToggle />
            <UserButton />
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6">
        <div className="mb-8">
          <h1
            className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
            style={{ fontFamily: "var(--app-font-sans)" }}
          >
            Hey, {who}.
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Where do you want to go?
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:auto-rows-fr">
          <BankingTile />
          <BillsTile />
          <ForecastTile />
          <AvalancheTile />
        </div>
      </div>

      {/* Faint brand watermark, bottom-right. Non-interactive; sits below the
          advisor FAB (z-40) so it never blocks it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed bottom-4 right-4 z-0 select-none opacity-[0.05]"
      >
        <H2Logo className="h-24 w-auto sm:h-28" />
      </div>
    </div>
  );
}
