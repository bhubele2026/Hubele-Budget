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
// Soft frosted pastel tiles (not saturated gradients): a pale tint + a muted-ink
// icon. Banking=icy blue, Bills=pale slate, Forecast=pale blue-gray, Avalanche=
// pale warm.
const HUE_TILE: Record<Hue, { tile: string; ink: string }> = {
  blue: { tile: "bg-[hsl(var(--frost-blue))]", ink: "text-[hsl(var(--frost-blue-ink))]" },
  teal: { tile: "bg-[hsl(var(--frost-slate))]", ink: "text-[hsl(var(--frost-slate-ink))]" },
  indigo: { tile: "bg-[hsl(var(--frost-indigo))]", ink: "text-[hsl(var(--frost-indigo-ink))]" },
  amber: { tile: "bg-[hsl(var(--frost-amber))]", ink: "text-[hsl(var(--frost-amber-ink))]" },
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
  const t = HUE_TILE[hue];
  return (
    <div className="group relative h-full" data-testid={`landing-tile-${testid}`}>
      {/* Stacked-card depth — two faint layers peeking below so the card reads as
          a lifted "stack", not a flat panel. Subtle now that the mesh + a real
          shadow support it (this looked like a doubled card only on a bare bg). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 top-6 bottom-[-13px] rounded-[22px] border border-[hsl(215_20%_92%)] bg-card/40 shadow-[0_12px_26px_-14px_rgba(30,41,59,0.16)] dark:border-white/5 dark:bg-white/[0.03]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-3 top-3 bottom-[-6px] rounded-[22px] border border-[hsl(215_20%_92%)] bg-card/70 shadow-[0_12px_26px_-14px_rgba(30,41,59,0.14)] dark:border-white/5 dark:bg-white/[0.04]"
      />
      <div className="relative flex h-full flex-col rounded-[22px] border border-[hsl(215_22%_91%)] bg-card/95 p-7 shadow-[0_2px_6px_rgba(30,41,59,0.05),0_20px_44px_-16px_rgba(30,41,59,0.22)] backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_10px_rgba(30,41,59,0.06),0_28px_56px_-18px_rgba(30,41,59,0.28)] dark:border-white/10 sm:p-8">
        <Link
          href={href}
          className="absolute inset-0 rounded-[22px] focus:outline-none focus:ring-2 focus:ring-primary/40"
          aria-label={title}
        />
        <div className="flex items-start justify-between gap-3">
          {/* Soft frosted pastel icon tile — glassy, muted, per-area tint. */}
          <div
            className={cn(
              "flex h-[52px] w-[52px] items-center justify-center rounded-[14px] ring-1 ring-inset ring-white/50 dark:ring-white/10",
              t.tile,
              t.ink,
            )}
          >
            {icon}
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </div>
        <div className="mt-4 text-xl font-bold tracking-tight">{title}</div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
        {children}
      </div>
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

/** Soft pastel pill — filled low-saturation tint, dark-slate text, no border. */
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
        "inline-flex items-center rounded-full px-3.5 py-1.5 text-xs font-semibold transition-transform hover:scale-[1.03]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Neutral soft-gray pastel nav pill (Forecast/Review/Budget, Debts). */
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
      className="rounded-full bg-[hsl(var(--frost-slate))] px-3.5 py-1.5 text-xs font-semibold text-[hsl(var(--frost-slate-ink))] transition-transform hover:scale-[1.03]"
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
  // Headline: this month's spend so far (month-to-date).
  const curMonthTotal = trends.length ? trends[trends.length - 1].total : null;

  // Graphic = THIS WEEK's daily spend (last 7 days). Honest & current — the old
  // monthly line plotted the partial current month against full past months and
  // looked like a 96% crash.
  const DOW = ["S", "M", "T", "W", "T", "F", "S"];
  const weekDaily = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of data?.dailyBuckets ?? []) map.set(b.date, b.total);
    const now = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(now.getDate() - (6 - i));
      return { value: map.get(isoDate(d)) ?? 0, label: DOW[d.getDay()] };
    });
  }, [data]);
  const hasChart = weekDaily.some((d) => d.value > 0);

  // Honest delta: month-to-date vs the SAME day-of-month last month (both partial,
  // like-for-like), summed from the daily buckets we already load.
  const deltaPct = useMemo(() => {
    const buckets = data?.dailyBuckets ?? [];
    if (!buckets.length) return null;
    const now = new Date();
    const throughDay = now.getDate();
    const sumMTD = (year: number, monthIdx: number) => {
      let s = 0;
      for (const b of buckets) {
        const dt = new Date(b.date + "T00:00:00");
        if (
          dt.getFullYear() === year &&
          dt.getMonth() === monthIdx &&
          dt.getDate() <= throughDay
        )
          s += b.total;
      }
      return s;
    };
    const cur = sumMTD(now.getFullYear(), now.getMonth());
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = sumMTD(prevMonth.getFullYear(), prevMonth.getMonth());
    return last > 0 ? Math.round(((cur - last) / last) * 100) : null;
  }, [data]);

  return (
    <TileShell
      testid="banking"
      href="/banking"
      hue="blue"
      icon={<Landmark className="h-6 w-6" strokeWidth={1.75} />}
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
            <GradientPill className="bg-[hsl(var(--frost-green))] text-[hsl(var(--frost-green-ink))]">
              Chase
            </GradientPill>
          </Link>
          <Link href="/amex" data-testid="landing-link-banking-amex">
            <GradientPill className="bg-[hsl(var(--frost-lav))] text-[hsl(var(--frost-lav-ink))]">
              Amex
            </GradientPill>
          </Link>
          <Link href="/allowances" data-testid="landing-link-banking-allowance">
            <GradientPill className="bg-[hsl(var(--frost-rose))] text-[hsl(var(--frost-rose-ink))]">
              Allowance
            </GradientPill>
          </Link>
        </div>
        <div className="pointer-events-none w-40 shrink-0">
          {isLoading ? (
            <ChartSkeleton className="h-14 w-full" />
          ) : hasChart ? (
            <>
              <div className="mb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                This week · daily
              </div>
              <MiniBars
                data={weekDaily.map((d) => d.value)}
                height={44}
                accent="hsl(190 42% 55%)"
              />
              <div className="mt-1 flex justify-between text-[9px] text-muted-foreground/70">
                {weekDaily.map((d, i) => (
                  <span key={i}>{d.label}</span>
                ))}
              </div>
            </>
          ) : (
            <ChartEmpty label="No spend yet this week" />
          )}
        </div>
      </div>
      </div>
    </TileShell>
  );
}

const BILL_GLYPHS = [Tv, Wifi, Zap, CreditCard, ShieldCheck];
// Per-bar palette so the Bills mini-chart reads multi-color like the mockup —
// drawn from the frost tile inks (teal / blue / indigo / amber / rose).
const BILL_BAR_COLORS = [
  "hsl(190 42% 55%)",
  "hsl(215 45% 62%)",
  "hsl(244 40% 66%)",
  "hsl(28 60% 60%)",
  "hsl(350 50% 66%)",
];

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
      icon={<Receipt className="h-6 w-6" strokeWidth={1.75} />}
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
                className="max-w-[7.5rem] truncate rounded-full bg-[hsl(var(--frost-slate))] px-3.5 py-1.5 text-xs font-semibold text-[hsl(var(--frost-slate-ink))]"
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
                data={top.map((b, i) => ({
                  value: b.amount,
                  color: BILL_BAR_COLORS[i % BILL_BAR_COLORS.length],
                }))}
                height={44}
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
      color: i === lowIdx ? "hsl(190 42% 58%)" : "hsl(215 18% 82%)",
    }));
  }, [balances]);

  return (
    <TileShell
      testid="forecast"
      href="/forecast"
      hue="indigo"
      icon={<LineChart className="h-6 w-6" strokeWidth={1.75} />}
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
              <Sparkline
                data={balances}
                variant="area"
                height={40}
                color="hsl(215 45% 62%)"
                strokeWidth={2.5}
                className="w-28"
              />
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
      icon={<Flame className="h-6 w-6" strokeWidth={1.75} />}
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
      <div className="relative z-10 mx-auto w-full max-w-4xl px-4 pb-14 pt-36 sm:px-6 sm:pt-44">
        {/* Greeting + account controls */}
        <div className="mb-7 flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-3xl font-bold tracking-[-0.02em] text-[hsl(215_28%_24%)] sm:text-4xl"
              style={{ fontFamily: "var(--app-font-sans)" }}
            >
              Hey, {who}.
            </h1>
            <p className="mt-1 text-base text-[hsl(215_16%_47%)]">
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

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:auto-rows-fr">
          <BankingTile />
          <BillsTile />
          <ForecastTile />
          <AvalancheTile />
        </div>
      </div>
    </div>
  );
}
