import { Link } from "wouter";
import { useMemo } from "react";
import { useUser, UserButton } from "@clerk/react";
import {
  Landmark,
  Receipt,
  LineChart,
  Flame,
  ArrowRight,
  Bell,
  Tv,
  Wifi,
  Zap,
  CreditCard,
  ShieldCheck,
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
import { cn, formatCurrency } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { Sparkline } from "@/components/viz/Sparkline";
import { MiniBars, type MiniBar } from "@/components/viz/MiniBars";
import { MoneyText } from "@/components/viz/MoneyText";
import { FillMeter } from "@/components/stat/fill-meter";
import { PillBadge } from "@/components/pill-badge";
import { LandingBackdrop } from "@/components/landing-backdrop";

/**
 * Front door. A flowing wave + constellation header, a faint star-chart
 * watermark, account controls (bell + avatar) top-right, and four big tiles
 * that route into the app's four areas. Each tile carries a small REAL-DATA
 * visualization (server-computed aggregates only — no raw-transaction fetches;
 * every dollar figure is computed in code). The global nav ribbon is hidden
 * here (see layout.tsx) — the tiles ARE the navigation.
 */

// ── helpers ────────────────────────────────────────────────────────────────
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

/** Compact axis tick, e.g. 2900 → "$2.9k", 480 → "$480". */
function kfmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return `$${(n / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

/** "2026-04" → "Apr" */
function monthShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" });
}

// ── tile shell + chart-slot states ───────────────────────────────────────────

type Hue = "blue" | "teal" | "indigo" | "amber";
const HUE_CHIP: Record<Hue, string> = {
  blue: "from-sky-400 to-blue-600",
  teal: "from-teal-400 to-cyan-600",
  indigo: "from-indigo-400 to-violet-600",
  amber: "from-amber-400 to-orange-500",
};

function TileShell({
  icon,
  hue,
  title,
  blurb,
  href,
  testid,
  children,
}: {
  icon: React.ReactNode;
  hue: Hue;
  title: string;
  blurb: string;
  href: string;
  testid: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="group relative flex flex-col rounded-3xl border border-white/60 bg-card/90 p-6 shadow-[0_1px_2px_rgba(16,24,40,0.05),0_12px_32px_-14px_rgba(16,24,40,0.22)] backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_2px_6px_rgba(16,24,40,0.08),0_22px_48px_-16px_rgba(16,24,40,0.30)] dark:border-white/10 sm:p-7"
      data-testid={`landing-tile-${testid}`}
    >
      <Link
        href={href}
        className="absolute inset-0 rounded-3xl focus:outline-none focus:ring-2 focus:ring-primary/40"
        aria-label={title}
      />
      <div className="flex items-start justify-between gap-3">
        {/* Glossy gradient icon chip — dimensional, per-area hue. */}
        <div
          className={cn(
            "relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg ring-1 ring-white/40",
            HUE_CHIP[hue],
          )}
        >
          <span className="pointer-events-none absolute inset-x-1 top-1 h-1/3 rounded-t-xl bg-white/25 blur-[1px]" />
          {icon}
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>
      <div className="mt-4 text-xl font-bold tracking-tight">{title}</div>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
      {children}
    </div>
  );
}

/** Cold-load placeholder for a chart slot — never a flat $0 line. */
function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted/60",
        className,
      )}
    />
  );
}

function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-14 items-center justify-end text-[11px] text-muted-foreground/70">
      {label}
    </div>
  );
}

/** Soft gradient-tinted pill (Banking's Chase/Amex/Allowance). */
function GradientPill({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-gradient-to-b px-3 py-1 text-xs font-semibold shadow-sm ring-1 transition-transform hover:scale-[1.03]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The outline sub-link pill (nav) — matches the mockup's plain pills. */
function NavPill({
  href,
  label,
  testid,
}: {
  href: string;
  label: string;
  testid: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-md border border-card-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
      data-testid={testid}
    >
      {label}
    </Link>
  );
}

// ── tiles ─────────────────────────────────────────────────────────────────────

function BankingTile() {
  const { from, to } = useMemo(() => {
    const now = new Date();
    return {
      to: isoDate(now),
      from: isoDate(new Date(now.getFullYear(), now.getMonth() - 5, 1)),
    };
  }, []);
  const { data, isLoading } = useGetReportsSpendingFacts(
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
  const series = trends.map((t) => t.total);
  const hasChart = series.length >= 2;
  const min = hasChart ? Math.min(...series) : 0;
  const max = hasChart ? Math.max(...series) : 0;
  const labels = trends.map((t) => monthShort(t.month));
  // Headline: this month's spend (month-to-date) + the change vs last month.
  const curMonthTotal = trends.length ? trends[trends.length - 1].total : null;
  const prevMonthTotal =
    trends.length >= 2 ? trends[trends.length - 2].total : null;
  const deltaPct =
    curMonthTotal != null && prevMonthTotal
      ? Math.round(((curMonthTotal - prevMonthTotal) / prevMonthTotal) * 100)
      : null;

  return (
    <TileShell
      testid="banking"
      href="/banking"
      hue="blue"
      icon={<Landmark className="h-5 w-5" />}
      title="Banking"
      blurb="How you're spending — this week & month, what to cancel, what to stop buying."
    >
      <div className="mt-5">
        {curMonthTotal != null && (
          <div className="mb-3 flex items-center gap-2">
            <div className="leading-none">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                This month
              </div>
              <MoneyText
                amount={curMonthTotal}
                className="text-lg font-bold tabular-nums"
              />
            </div>
            {deltaPct != null && deltaPct !== 0 && (
              <PillBadge
                tone={deltaPct > 0 ? "danger" : "good"}
                dot={false}
                className="self-start"
              >
                {deltaPct > 0 ? "▲" : "▼"} {Math.abs(deltaPct)}% vs last mo
              </PillBadge>
            )}
          </div>
        )}
      <div className="flex items-end justify-between gap-3">
        <div className="relative z-10 flex flex-wrap content-end gap-2">
          <Link href="/transactions" data-testid="landing-link-banking-chase">
            <GradientPill className="from-emerald-50 to-emerald-100 text-emerald-700 ring-emerald-200/70 dark:from-emerald-500/15 dark:to-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20">
              Chase
            </GradientPill>
          </Link>
          <Link href="/amex" data-testid="landing-link-banking-amex">
            <GradientPill className="from-sky-50 to-blue-100 text-blue-700 ring-blue-200/70 dark:from-blue-500/15 dark:to-blue-500/10 dark:text-blue-300 dark:ring-blue-400/20">
              Amex
            </GradientPill>
          </Link>
          <Link href="/allowances" data-testid="landing-link-banking-allowance">
            <GradientPill className="from-rose-50 to-red-100 text-red-700 ring-red-200/70 dark:from-red-500/15 dark:to-red-500/10 dark:text-red-300 dark:ring-red-400/20">
              Allowance
            </GradientPill>
          </Link>
        </div>
        <div className="pointer-events-none w-40 shrink-0">
          {isLoading ? (
            <ChartSkeleton className="h-14 w-full" />
          ) : hasChart ? (
            <>
              <div className="flex gap-1.5">
                <div className="flex flex-col justify-between py-0.5 text-[9px] tabular-nums text-muted-foreground/70">
                  <span>{kfmt(max)}</span>
                  <span>{kfmt((max + min) / 2)}</span>
                  <span>{kfmt(min)}</span>
                </div>
                <Sparkline data={series} variant="area" height={56} className="flex-1" />
              </div>
              <div className="mt-1 flex justify-between pl-7 text-[9px] text-muted-foreground/70">
                <span>{labels[0]}</span>
                {labels.length > 2 && <span>{labels[Math.floor(labels.length / 2)]}</span>}
                <span>{labels[labels.length - 1]}</span>
              </div>
            </>
          ) : (
            <ChartEmpty label="No spend yet" />
          )}
        </div>
      </div>
      </div>
    </TileShell>
  );
}

const BILL_GLYPHS = [Tv, Wifi, Zap, CreditCard, ShieldCheck];

function BillsTile() {
  const month = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  }, []);
  const { data, isLoading } = useGetBillsSummary(
    { month },
    {
      query: {
        queryKey: getGetBillsSummaryQueryKey({ month }),
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );
  const bills = useMemo(
    () =>
      (data?.bills ?? [])
        .map((b) => ({ name: b.item.name, amount: Math.abs(Number(b.monthlyAmount) || 0) }))
        .sort((a, b) => b.amount - a.amount),
    [data],
  );
  const top = bills.slice(0, 5);
  const names = bills.slice(0, 3).map((b) => b.name);
  const hasBars = top.length >= 1 && top.some((b) => b.amount > 0);
  const monthlyTotal = Number(data?.monthly?.bills ?? 0);

  return (
    <TileShell
      testid="bills"
      href="/bills"
      hue="teal"
      icon={<Receipt className="h-5 w-5" />}
      title="Bills"
      blurb="Your recurring bills & subscriptions — with an AI review of what to cut and what's missing."
    >
      {monthlyTotal > 0 && (
        <div className="mt-4 leading-none">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            Recurring · this month
          </div>
          <MoneyText amount={monthlyTotal} className="text-lg font-bold tabular-nums" />
        </div>
      )}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="flex flex-wrap content-end gap-2">
          {(names.length > 0 ? names : ["Subscriptions", "Utilities", "Recurring"]).map(
            (n) => (
              <span
                key={n}
                className="max-w-[7.5rem] truncate rounded-full border border-card-border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground"
              >
                {n}
              </span>
            ),
          )}
        </div>
        <div className="pointer-events-none w-40 shrink-0">
          {isLoading ? (
            <ChartSkeleton className="h-14 w-full" />
          ) : hasBars ? (
            <>
              <MiniBars
                data={top.map((b) => b.amount)}
                height={44}
                accent="hsl(var(--chart-1))"
              />
              <div className="mt-1 flex justify-between px-0.5 text-muted-foreground/45">
                {top.map((_, i) => {
                  const G = BILL_GLYPHS[i % BILL_GLYPHS.length];
                  return <G key={i} className="h-3 w-3" />;
                })}
              </div>
            </>
          ) : (
            <ChartEmpty label="No bills yet" />
          )}
        </div>
      </div>
    </TileShell>
  );
}

function ForecastTile() {
  const { data, isLoading } = useGetForecastCashSignal(
    { horizonDays: 90 },
    {
      query: {
        queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
        staleTime: 60_000,
        gcTime: 10 * 60_000,
      },
    },
  );
  const daily = data?.daily ?? [];
  const balances = daily.map((d) => Number(d.balance) || 0);
  const hasLine = balances.length >= 2;
  const projected = data?.endingBalance ?? data?.lowestProjected ?? null;
  const lowest = data?.lowestProjected ?? null;
  const lowestDate = data?.lowestDate
    ? new Date(data.lowestDate + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;

  // Downsample the daily series to ~7 bars; highlight the lowest point in teal.
  const bars: MiniBar[] = useMemo(() => {
    if (balances.length < 2) return [];
    const step = Math.max(1, Math.floor(balances.length / 7));
    const picked = balances.filter((_, i) => i % step === 0).slice(0, 7);
    const lowIdx = picked.indexOf(Math.min(...picked));
    return picked.map((v, i) => ({
      value: v,
      color: i === lowIdx ? "hsl(var(--chart-1))" : "hsl(var(--chart-3))",
    }));
  }, [balances]);

  return (
    <TileShell
      testid="forecast"
      href="/forecast"
      hue="indigo"
      icon={<LineChart className="h-5 w-5" />}
      title="Forecast"
      blurb="See what's coming, then review and lock it in."
    >
      {lowest != null && lowestDate && (
        <div className="mt-4 leading-none">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            Lowest projected · {lowestDate}
          </div>
          <MoneyText amount={lowest} className="text-lg font-bold tabular-nums" />
        </div>
      )}
      <div className="mt-4">
        <div className="pointer-events-none mb-3 flex items-end justify-end gap-2">
          {isLoading ? (
            <ChartSkeleton className="h-10 w-32" />
          ) : hasLine ? (
            <>
              <div className="text-right leading-tight">
                <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">
                  Projected
                </div>
                {projected != null && (
                  <MoneyText amount={projected} className="text-sm font-semibold" />
                )}
              </div>
              <Sparkline data={balances} variant="area" height={40} className="w-28" />
            </>
          ) : (
            <ChartEmpty label="No forecast yet" />
          )}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="relative z-10 flex flex-wrap gap-2">
            <NavPill href="/forecast" label="Forecast" testid="landing-link-forecast-forecast" />
            <NavPill href="/review" label="Review" testid="landing-link-forecast-review" />
            <NavPill href="/budget" label="Budget" testid="landing-link-forecast-budget" />
          </div>
          {hasLine && bars.length > 0 && (
            <div className="pointer-events-none w-32 shrink-0">
              <MiniBars data={bars} height={36} />
            </div>
          )}
        </div>
      </div>
    </TileShell>
  );
}

function AvalancheTile() {
  const { data, isLoading } = useListDebts({
    query: {
      queryKey: getListDebtsQueryKey(),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    },
  });
  const active = (data ?? []).filter((d) => d.status !== "paid_off");
  const { overallPaid, target, totalDebt } = useMemo(() => {
    let sumOrig = 0;
    let sumBal = 0;
    let totalCurrent = 0;
    for (const d of active) {
      const bal = Number(d.balance) || 0;
      const orig = Number(d.originalBalance ?? 0) || 0;
      totalCurrent += bal;
      if (orig > 0) {
        sumOrig += orig;
        sumBal += Math.min(bal, orig);
      }
    }
    const overall = sumOrig > 0 ? Math.max(0, Math.min(1, (sumOrig - sumBal) / sumOrig)) : null;
    // Avalanche target = highest-APR active debt with a carried balance.
    const withApr = active
      .filter((d) => (Number(d.balance) || 0) > 0 && Number(d.originalBalance ?? 0) > 0)
      .sort((a, b) => (Number(b.apr) || 0) - (Number(a.apr) || 0));
    const t = withApr[0];
    const tPaid = t
      ? Math.max(
          0,
          Math.min(
            1,
            ((Number(t.originalBalance) || 0) - (Number(t.balance) || 0)) /
              (Number(t.originalBalance) || 1),
          ),
        )
      : null;
    return {
      overallPaid: overall,
      target: t ? { name: t.name, paid: tPaid! } : null,
      totalDebt: totalCurrent,
    };
  }, [active]);

  const hasData = overallPaid != null;

  return (
    <TileShell
      testid="avalanche"
      href="/avalanche"
      hue="amber"
      icon={<Flame className="h-5 w-5" />}
      title="Avalanche"
      blurb="Attack the debt — manage the payoff plan and free-by date."
    >
      {/* Never show the amount owed here — payoff PROGRESS only. */}
      {overallPaid != null && (
        <div className="mt-4 leading-none">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            Payoff progress
          </div>
          <span className="text-lg font-bold tabular-nums text-[hsl(var(--positive))]">
            {Math.round(overallPaid * 100)}% paid
          </span>
        </div>
      )}
      <div className="mt-4 flex items-end justify-between gap-4">
        <div className="relative z-10">
          <NavPill href="/debts" label="Debts" testid="landing-link-avalanche-debts" />
        </div>
        <div className="pointer-events-none w-44 shrink-0 space-y-2">
          {isLoading ? (
            <ChartSkeleton className="h-12 w-full" />
          ) : hasData ? (
            <>
              <div>
                <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                  Overall paid
                </div>
                <FillMeter
                  value={overallPaid * 100}
                  ceiling={100}
                  status="good"
                  floorLabel="0%"
                  ceilingLabel="100%"
                  format={(n) => `${Math.round(n)}%`}
                />
              </div>
              {target && (
                <div>
                  <div className="mb-1 truncate text-[9px] uppercase tracking-wider text-muted-foreground/70">
                    {target.name}
                  </div>
                  <FillMeter
                    value={target.paid * 100}
                    ceiling={100}
                    status="warning"
                    floorLabel="0%"
                    ceilingLabel="100%"
                    format={(n) => `${Math.round(n)}%`}
                  />
                </div>
              )}
            </>
          ) : (
            <ChartEmpty label="No debts tracked" />
          )}
        </div>
      </div>
    </TileShell>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const { user } = useUser();
  const who = user?.firstName?.trim() || "Hubeles";
  const reviewCount = useReviewInboxCount();

  return (
    <div className="relative isolate min-h-full w-full">
      <LandingBackdrop />

      {/* Content sits above the backdrop; top padding clears the mesh ribbon so
          the greeting reads just below it (no dead band). */}
      <div className="relative z-10 mx-auto w-full max-w-5xl px-4 pb-14 pt-28 sm:px-6 sm:pt-36">
        {/* Greeting + account controls */}
        <div className="mb-7 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Hey, {who}.</h1>
            <p className="mt-1 text-base text-muted-foreground">
              Where do you want to go?
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <UserButton />
            <Link
              href="/review"
              aria-label={
                reviewCount > 0 ? `${reviewCount} items to review` : "Review inbox"
              }
              data-testid="landing-bell"
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-muted-foreground transition-colors hover:text-primary"
            >
              <Bell className="h-4 w-4" />
              {reviewCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
                  {reviewCount}
                </span>
              )}
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <BankingTile />
          <BillsTile />
          <ForecastTile />
          <AvalancheTile />
        </div>
      </div>
    </div>
  );
}
